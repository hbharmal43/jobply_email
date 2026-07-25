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
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

export interface JobplyEmailStackProps extends cdk.StackProps {
  /** development | staging | production */
  environmentName: string;
  /** Secrets Manager secret holding { "url": "...", "serviceKey": "..." } */
  supabaseSecretName: string;
  /** Verified SES sending identity used as the From address. */
  fromEmail?: string;
  /** SES Configuration Set created in the console (see AWS setup notes). */
  configurationSetName?: string;
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
        ENVIRONMENT: props.environmentName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    supabaseSecret.grantRead(feedbackFn);

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
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 1,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SUPABASE_SECRET_ID: props.supabaseSecretName,
        ENVIRONMENT: props.environmentName,
        QUEUE_URL: sendQueue.queueUrl,
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
      description: 'Invokes the dispatcher Lambda once a minute',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(dispatcherFn)],
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
        ENVIRONMENT: props.environmentName,
        FROM_EMAIL: fromEmail,
        CONFIGURATION_SET_NAME: configurationSetName,
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
