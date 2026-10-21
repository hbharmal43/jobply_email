import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';

export interface JobplyEmailStackProps extends cdk.StackProps {
  /** development | staging | production — used for resource naming and secret lookup. */
  environmentName: string;
  /**
   * Logical environment written to email_jobs.environment and used by the
   * dispatcher's scans. Defaults to environmentName, but can diverge from it —
   * this stack's resources are named "development" for historical reasons,
   * but profiles have no environment column, so it has always operated on
   * real production data. Pinned explicitly in infra/app.ts rather than left to
   * drift (see 2026-07-28 incident).
   */
  emailEnvironment?: string;
  /**
   * Secrets Manager secret holding { "url", "serviceKey", "awsRdsUrl" }:
   * the Supabase URL + service key, and the Postgres URL of the RDS instance
   * holding job listings.
   */
  supabaseSecretName: string;
  recommendationScanBatchSize?: number;
  recommendationScheduleTimezone?: string;
  dispatcherScheduleEnabled?: boolean;
}

/**
 * Daily job-recommendation dispatcher.
 *
 *   EventBridge Scheduler (9:00 AM America/Chicago)
 *           │
 *           ▼
 *   Recommendation dispatcher Lambda ──▶ Supabase (candidates, profiles, job_preferences, email_jobs)
 *                                    ──▶ AWS RDS (applications)
 *                                    ──▶ Typesense search.jobply.ai (job matching)
 *
 * Email delivery is handled by Customer.io; the SES/SQS send pipeline and
 * SES feedback ingestion were removed on 2026-09-29.
 */
export class JobplyEmailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: JobplyEmailStackProps) {
    super(scope, id, props);

    const emailEnvironment = props.emailEnvironment ?? props.environmentName;

    // Secret is created once, outside CDK, so the value never lives in source
    // control or CloudFormation.
    const supabaseSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'SupabaseSecret',
      props.supabaseSecretName,
    );

    const recommendationDispatcherFn = new NodejsFunction(this, 'RecommendationDispatcherFunction', {
      functionName: `jobply-email-${props.environmentName}-recommendation-dispatcher`,
      description: 'Sends the daily job digest to users for whom it is 9 AM local (runs hourly)',
      entry: 'lambdas/recommendation-dispatcher/handler.ts',
      handler: 'handler',
      // Node 22+ required: @supabase/supabase-js needs native WebSocket
      // (unavailable in the Node 20 Lambda runtime).
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.minutes(10),
      reservedConcurrentExecutions: 1,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        SUPABASE_SECRET_ID: props.supabaseSecretName,
        ENVIRONMENT: emailEnvironment,
        PRODUCTION_MODE: String(props.dispatcherScheduleEnabled ?? false),
        JOBPLY_TEST_USER_IDS: '',
        SCAN_BATCH_SIZE: String(props.recommendationScanBatchSize ?? 500),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        // pg-native is an optional peer of pg that is never installed;
        // leaving it external stops esbuild failing to resolve it.
        externalModules: ['@aws-sdk/*', 'pg-native'],
      },
    });

    supabaseSecret.grantRead(recommendationDispatcherFn);

    const recommendationSchedulerRole = new iam.Role(this, 'RecommendationSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    recommendationDispatcherFn.grantInvoke(recommendationSchedulerRole);

    // Hourly on the hour: each run emails the users for whom it's 9 AM local
    // (lambdas/recommendation-dispatcher/timezone.ts), so everyone gets theirs
    // at 9 their time. Half-hour zones (India) land at 9:30.
    new scheduler.CfnSchedule(this, 'DailyRecommendationSchedule', {
      name: `jobply-email-${props.environmentName}-daily-recommendations`,
      description: 'Hourly: daily job digest for users at 9 AM local time',
      scheduleExpression: 'cron(0 * * * ? *)',
      scheduleExpressionTimezone: props.recommendationScheduleTimezone ?? 'America/Chicago',
      state: props.dispatcherScheduleEnabled ? 'ENABLED' : 'DISABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: recommendationDispatcherFn.functionArn,
        roleArn: recommendationSchedulerRole.roleArn,
        retryPolicy: {
          // A retry after the hour would find nobody at 9 AM local; keep it inside the hour.
          maximumEventAgeInSeconds: 900,
          maximumRetryAttempts: 2,
        },
      },
    });

    new cdk.CfnOutput(this, 'RecommendationDispatcherFunctionName', {
      value: recommendationDispatcherFn.functionName,
      description: 'Name of the daily recommendation dispatcher Lambda',
    });
  }
}
