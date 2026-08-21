import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

export interface JobplyEmailStackProps extends cdk.StackProps {
  /** development | staging | production — used for resource naming and secret lookup. */
  environmentName: string;
  /**
   * Logical environment written to email_jobs.environment and used by the
   * dispatcher's scans/claims. Defaults to environmentName, but can diverge
   * from it — this stack's resources are named "development" for historical
   * reasons, but profiles/applications have no environment column, so it has
   * always operated on real production data. Pinned explicitly in bin/app.ts
   * rather than left to drift (see 2026-07-28 incident: an out-of-band
   * console edit had already set this at runtime, and because the template
   * never declared a different value, `cdk deploy` never caught the drift).
   */
  emailEnvironment?: string;
  /**
   * Secrets Manager secret holding
   * { "url": "...", "serviceKey": "...", "emailUnsubscribeSecret": "..." }.
   * emailUnsubscribeSecret signs/verifies the unsubscribe-link tokens the
   * sender Lambda embeds in every lifecycle email footer — must match the
   * EMAIL_UNSUBSCRIBE_SECRET env var configured on jobply_website.
   */
  supabaseSecretName: string;
  /** Verified SES sending identity used as the From address. */
  fromEmail?: string;
  /** SES Configuration Set created in the console (see AWS setup notes). */
  configurationSetName?: string;
  /** Base URL for the unsubscribe-link page (jobply_website's /email/unsubscribe route). */
  unsubscribeBaseUrl?: string;
  testRecipients?: string[];
  enabledJourneys?: string[];
  claimBatchSize?: number;
  scanBatchSize?: number;
  recommendationScanBatchSize?: number;
  recommendationScheduleTimezone?: string;
  dispatcherScheduleEnabled?: boolean;
}

/**
 * Part A (SES) — feedback ingestion.
 *
 * Amazon SES  ──(Configuration Set event destination)──▶  EventBridge
 *                                                              │
 *                                                              ▼
 *                                                     Feedback Lambda
 *                                                              │
 *                                                              ▼
 *                                                     Supabase (RPC)
 *
 * NOTE: the SES Configuration Set + its EventBridge event destination are
 * created in the SES console (they only need to exist once per environment).
 * This stack owns the Lambda and the EventBridge rule that consumes those events.
 *
 * Part B (SES) — outbound send pipeline.
 *
 *   EventBridge rule (rate: 1 min)
 *           │
 *           ▼
 *   Dispatcher Lambda ──claim_due_email_jobs()──▶ Supabase (email_jobs)
 *           │
 *           ▼ (per due job)
 *       SQS queue ──▶ mark_email_job_queued()
 *           │
 *           ▼
 *      Sender Lambda ──authorize_email_send()──▶ Supabase (recheck eligibility)
 *           │
 *           ▼
 *       Amazon SES (same Configuration Set as above, so bounces/complaints on
 *                    these sends flow back through the existing Part A pipeline)
 */
export class JobplyEmailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: JobplyEmailStackProps) {
    super(scope, id, props);

    const fromEmail = props.fromEmail ?? 'Jobply <hello@jobply.ai>';
    const configurationSetName = props.configurationSetName ?? 'jobply-default';
    const emailEnvironment = props.emailEnvironment ?? props.environmentName;
    const unsubscribeBaseUrl = props.unsubscribeBaseUrl ?? 'https://jobply.ai/email/unsubscribe';
    const enabledJourneys = props.enabledJourneys ?? [];
    const lifecycleJourneys = enabledJourneys.filter(
      (journey) => journey !== 'job_recommendations',
    );
    const recommendationsEnabled = enabledJourneys.includes('job_recommendations');

    // Secret is created once, outside CDK (see README) so the value never
    // lives in source control or CloudFormation.
    const supabaseSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'SupabaseSecret',
      props.supabaseSecretName,
    );

    // === Part A: feedback ingestion ==========================================

    const feedbackFn = new NodejsFunction(this, 'FeedbackFunction', {
      functionName: `jobply-email-${props.environmentName}-feedback`,
      description: 'Normalizes SES delivery/bounce/complaint events into Supabase',
      entry: 'lambdas/feedback/handler.ts',
      handler: 'handler',
      // Node 22+ required: @supabase/supabase-js needs native WebSocket
      // (unavailable in the Node 20 Lambda runtime).
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SUPABASE_SECRET_ID: props.supabaseSecretName,
        ENVIRONMENT: emailEnvironment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    supabaseSecret.grantRead(feedbackFn);

    new ses.CfnConfigurationSetEventDestination(this, 'SesEventBridgeDestination', {
      configurationSetName,
      eventDestination: {
        name: `jobply-email-${props.environmentName}-eventbridge`,
        enabled: true,
        matchingEventTypes: [
          'SEND', 'REJECT', 'BOUNCE', 'COMPLAINT', 'DELIVERY',
          'OPEN', 'CLICK', 'RENDERING_FAILURE', 'DELIVERY_DELAY',
        ],
        eventBridgeDestination: {
          eventBusArn: cdk.Stack.of(this).formatArn({
            service: 'events',
            resource: 'event-bus',
            resourceName: 'default',
          }),
        },
      },
    });

    new events.Rule(this, 'SesEventRule', {
      ruleName: `jobply-email-${props.environmentName}-ses-events`,
      description: 'Routes Amazon SES events (delivery, bounce, complaint, ...) to the feedback Lambda',
      eventPattern: {
        source: ['aws.ses'],
      },
      targets: [new targets.LambdaFunction(feedbackFn)],
    });

    // === Part B: outbound send pipeline ======================================

    // --- SQS: dispatcher -> sender, with a DLQ for poison messages -----------
    const sendDlq = new sqs.Queue(this, 'EmailSendDLQ', {
      queueName: `jobply-email-${props.environmentName}-send-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const sendQueue = new sqs.Queue(this, 'EmailSendQueue', {
      queueName: `jobply-email-${props.environmentName}-send`,
      visibilityTimeout: cdk.Duration.seconds(30 * 6), // 6x the sender Lambda's timeout
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: sendDlq,
        maxReceiveCount: 5,
      },
    });

    // --- Dispatcher Lambda: scans + claims + enqueues -------------------------
    const dispatcherFn = new NodejsFunction(this, 'DispatcherFunction', {
      functionName: `jobply-email-${props.environmentName}-dispatcher`,
      description: 'Scans for due lifecycle-email jobs and publishes them to SQS for the sender Lambda',
      entry: 'lambdas/dispatcher/handler.ts',
      handler: 'handler',
      // Node 22+ required: @supabase/supabase-js needs native WebSocket
      // (unavailable in the Node 20 Lambda runtime).
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SUPABASE_SECRET_ID: props.supabaseSecretName,
        ENVIRONMENT: emailEnvironment,
        QUEUE_URL: sendQueue.queueUrl,
        PRODUCTION_MODE: String(props.dispatcherScheduleEnabled ?? false),
        JOBPLY_TEST_USER_IDS: '',
        ENABLED_JOURNEYS: lifecycleJourneys.join(','),
        CLAIM_BATCH_SIZE: String(props.claimBatchSize ?? 25),
        SCAN_BATCH_SIZE: String(props.scanBatchSize ?? 100),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    supabaseSecret.grantRead(dispatcherFn);
    sendQueue.grantSendMessages(dispatcherFn);

    new events.Rule(this, 'DispatcherScheduleRule', {
      ruleName: `jobply-email-${props.environmentName}-dispatch-schedule`,
      description: 'Scans lifecycle journeys and drains due email jobs once a minute',
      enabled: props.dispatcherScheduleEnabled ?? false,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(dispatcherFn)],
    });

    // Recommendations run separately so their heavier semantic matching does
    // not delay time-sensitive lifecycle scans. EventBridge Scheduler evaluates
    // the cron expression in America/Chicago, including daylight-saving time.
    const recommendationDispatcherFn = new NodejsFunction(this, 'RecommendationDispatcherFunction', {
      functionName: `jobply-email-${props.environmentName}-recommendation-dispatcher`,
      description: 'Builds the daily personalized job-recommendation digest',
      entry: 'lambdas/dispatcher/handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SUPABASE_SECRET_ID: props.supabaseSecretName,
        ENVIRONMENT: emailEnvironment,
        QUEUE_URL: sendQueue.queueUrl,
        PRODUCTION_MODE: String(props.dispatcherScheduleEnabled ?? false),
        JOBPLY_TEST_USER_IDS: '',
        ENABLED_JOURNEYS: 'job_recommendations',
        CLAIM_BATCH_SIZE: String(props.claimBatchSize ?? 25),
        SCAN_BATCH_SIZE: String(props.recommendationScanBatchSize ?? 500),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    supabaseSecret.grantRead(recommendationDispatcherFn);
    sendQueue.grantSendMessages(recommendationDispatcherFn);

    const recommendationSchedulerRole = new iam.Role(this, 'RecommendationSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    recommendationDispatcherFn.grantInvoke(recommendationSchedulerRole);

    new scheduler.CfnSchedule(this, 'DailyRecommendationSchedule', {
      name: `jobply-email-${props.environmentName}-daily-recommendations`,
      description: 'Runs personalized job recommendations daily at 9:00 AM Central',
      scheduleExpression: 'cron(0 9 * * ? *)',
      scheduleExpressionTimezone: props.recommendationScheduleTimezone ?? 'America/Chicago',
      state: (props.dispatcherScheduleEnabled ?? false) && recommendationsEnabled
        ? 'ENABLED'
        : 'DISABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: recommendationDispatcherFn.functionArn,
        roleArn: recommendationSchedulerRole.roleArn,
        input: JSON.stringify({ journeys: ['job_recommendations'] }),
        retryPolicy: {
          maximumEventAgeInSeconds: 3600,
          maximumRetryAttempts: 2,
        },
      },
    });

    // --- Sender Lambda: authorize, render, send via SES -----------------------
    const senderFn = new NodejsFunction(this, 'SenderFunction', {
      functionName: `jobply-email-${props.environmentName}-sender`,
      description: 'Renders and sends queued lifecycle emails through Amazon SES',
      entry: 'lambdas/sender/handler.ts',
      handler: 'handler',
      // Node 22+ required: @supabase/supabase-js needs native WebSocket
      // (unavailable in the Node 20 Lambda runtime).
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SUPABASE_SECRET_ID: props.supabaseSecretName,
        ENVIRONMENT: emailEnvironment,
        FROM_EMAIL: fromEmail,
        CONFIGURATION_SET_NAME: configurationSetName,
        UNSUBSCRIBE_BASE_URL: unsubscribeBaseUrl,
        PRODUCTION_MODE: String(props.dispatcherScheduleEnabled ?? false),
        TEST_RECIPIENTS: (props.testRecipients ?? []).join(','),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    supabaseSecret.grantRead(senderFn);

    senderFn.addEventSource(new SqsEventSource(sendQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    // Least privilege: only allow sending through the jobply.ai identity.
    senderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [
        `arn:aws:ses:${this.region}:${this.account}:identity/jobply.ai`,
        `arn:aws:ses:${this.region}:${this.account}:configuration-set/${configurationSetName}`,
      ],
    }));

    // --- Alarms -----------------------------------------------------------
    new cloudwatch.Alarm(this, 'SendDlqNotEmptyAlarm', {
      alarmName: `jobply-email-${props.environmentName}-send-dlq-not-empty`,
      alarmDescription: 'Messages landed in the email-send DLQ — sender Lambda is failing repeatedly on some jobs',
      metric: sendDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    });

    new cloudwatch.Alarm(this, 'SenderErrorsAlarm', {
      alarmName: `jobply-email-${props.environmentName}-sender-errors`,
      alarmDescription: 'Sender Lambda is erroring',
      metric: senderFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
    });

    // --- Outputs ---------------------------------------------------------
    new cdk.CfnOutput(this, 'FeedbackFunctionName', {
      value: feedbackFn.functionName,
      description: 'Name of the SES feedback Lambda',
    });

    new cdk.CfnOutput(this, 'DispatcherFunctionName', {
      value: dispatcherFn.functionName,
      description: 'Name of the email-jobs dispatcher Lambda',
    });

    new cdk.CfnOutput(this, 'RecommendationDispatcherFunctionName', {
      value: recommendationDispatcherFn.functionName,
      description: 'Name of the daily recommendation dispatcher Lambda',
    });

    new cdk.CfnOutput(this, 'SenderFunctionName', {
      value: senderFn.functionName,
      description: 'Name of the email sender Lambda',
    });

    new cdk.CfnOutput(this, 'SendQueueUrl', {
      value: sendQueue.queueUrl,
      description: 'SQS queue URL between the dispatcher and sender Lambdas',
    });
  }
}
