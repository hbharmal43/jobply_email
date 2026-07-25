#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { JobplyEmailStack } from '../lib/email-stack';

const app = new cdk.App();

// Pick the environment with:  npx cdk deploy -c env=development
const environmentName = (app.node.tryGetContext('env') as string) ?? 'development';

new JobplyEmailStack(app, `JobplyEmail-${environmentName}`, {
  environmentName,
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
