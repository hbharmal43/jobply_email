#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { JobplyEmailStack } from '../lib/email-stack';

const app = new cdk.App();

// Pick the environment with:  npx cdk deploy -c env=development
const environmentName = (app.node.tryGetContext('env') as string) ?? 'development';

// The "development"-named stack's resources predate any real dev/staging
// data separation — profiles/applications have no environment column, so it
// has always scanned and sent against real production users. Pin its
// ENVIRONMENT variable to 'production' explicitly rather than letting it
// default to 'development', so `cdk deploy` can't silently drift it back to
// a value that misrepresents what it actually does (see 2026-07-28 incident).
// Override with `-c emailEnv=` if a genuinely isolated stack is ever stood up.
const emailEnvironment =
  (app.node.tryGetContext('emailEnv') as string) ??
  (environmentName === 'development' ? 'production' : environmentName);

new JobplyEmailStack(app, `JobplyEmail-${environmentName}`, {
  environmentName,
  emailEnvironment,
  supabaseSecretName: `jobply-email/${environmentName}/supabase`,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  tags: {
    Application: 'Jobply',
    Subsystem: 'LifecycleEmail',
    Environment: environmentName,
    Owner: 'Engineering',
    ManagedBy: 'CDK',
  },
});
