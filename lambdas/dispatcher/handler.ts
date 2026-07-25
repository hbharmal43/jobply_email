/**
 * Dispatcher Lambda — Part B (SES)
 *
 * Runs once a minute on an EventBridge Scheduler rate(1 minute) rule. Two jobs:
 *
 *  1. Scan `profiles` for the two time-based journeys and enqueue any newly
 *     due jobs (idempotent via schedule_email_job's dedupe_key conflict).
 *     'welcome' jobs are NOT created here — they're enqueued synchronously by
 *     jobply_website's /api/auth/post-login route.
 *  2. Claim due email_jobs (lease-based, safe under overlapping runs) and
 *     publish one lightweight SQS message per job for the sender Lambda.
 *
 * Env vars:
 *   SUPABASE_SECRET_ID   ARN/name of the Secrets Manager secret holding
 *                        { "url": "...", "serviceKey": "..." }
 *   QUEUE_URL             SQS queue URL the sender Lambda consumes
 *   ENVIRONMENT           'production' | 'staging' | 'development' (default production)
 *   CLAIM_BATCH_SIZE      max jobs claimed per run (default 50)
 *   SCAN_BATCH_SIZE       max profiles scanned per journey per run (default 100)
 *
 * Deps: @aws-sdk/client-secrets-manager, @aws-sdk/client-sqs, @supabase/supabase-js
 */

import { randomUUID } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'production';
const CLAIM_BATCH_SIZE = Number(process.env.CLAIM_BATCH_SIZE ?? 50);
const SCAN_BATCH_SIZE = Number(process.env.SCAN_BATCH_SIZE ?? 100);

const ONBOARDING_ABANDONED_DELAY_HOURS = 24;
const EXTENSION_NUDGE_DELAY_DAYS = 3;

let cachedClient: SupabaseClient | null = null;
async function getSupabase(): Promise<SupabaseClient> {
  if (cachedClient) return cachedClient;
  const secretId = process.env.SUPABASE_SECRET_ID;
  if (!secretId) throw new Error('SUPABASE_SECRET_ID not set');

  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const { url, serviceKey } = JSON.parse(res.SecretString ?? '{}');
  if (!url || !serviceKey) throw new Error('Supabase secret missing url/serviceKey');

  cachedClient = createClient(url, serviceKey, { auth: { persistSession: false } });
  return cachedClient;
}

const sqs = new SQSClient({});

interface CandidateProfile {
  id: string;
  email: string;
  first_name: string | null;
}

async function scanOnboardingAbandoned(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - ONBOARDING_ABANDONED_DELAY_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, first_name')
    .not('onboarding_started_at', 'is', null)
    .eq('onboarding_completed', false)
    .lt('onboarding_started_at', cutoff)
    .not('email', 'is', null)
    .limit(SCAN_BATCH_SIZE);

  if (error) {
    console.error('scanOnboardingAbandoned query failed', error);
    return 0;
  }

  let enqueued = 0;
  for (const profile of (data ?? []) as CandidateProfile[]) {
    const { data: jobId, error: rpcError } = await supabase.rpc('schedule_email_job', {
      p_user_id: profile.id,
      p_recipient_email: profile.email,
      p_journey_key: 'onboarding_abandoned',
      p_template_key: 'onboarding_abandoned',
      p_dedupe_key: `onboarding_abandoned:${profile.id}`,
      p_category: 'lifecycle',
      p_payload: { firstName: profile.first_name },
      p_environment: ENVIRONMENT,
    });
    if (rpcError) {
      console.error('schedule_email_job (onboarding_abandoned) failed', { userId: profile.id, error: rpcError });
      continue;
    }
    if (jobId) enqueued++;
  }
  return enqueued;
}

async function scanExtensionNudge(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - EXTENSION_NUDGE_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, first_name')
    .eq('onboarding_completed', true)
    .is('extension_installed_at', null)
    .not('onboarding_completed_at', 'is', null)
    .lt('onboarding_completed_at', cutoff)
    .not('email', 'is', null)
    .limit(SCAN_BATCH_SIZE);

  if (error) {
    console.error('scanExtensionNudge query failed', error);
    return 0;
  }

  let enqueued = 0;
  for (const profile of (data ?? []) as CandidateProfile[]) {
    const { data: jobId, error: rpcError } = await supabase.rpc('schedule_email_job', {
      p_user_id: profile.id,
      p_recipient_email: profile.email,
      p_journey_key: 'extension_nudge',
      p_template_key: 'extension_nudge',
      p_dedupe_key: `extension_nudge:${profile.id}`,
      p_category: 'lifecycle',
      p_payload: { firstName: profile.first_name },
      p_environment: ENVIRONMENT,
    });
    if (rpcError) {
      console.error('schedule_email_job (extension_nudge) failed', { userId: profile.id, error: rpcError });
      continue;
    }
    if (jobId) enqueued++;
  }
  return enqueued;
}

async function claimAndEnqueue(supabase: SupabaseClient): Promise<{ claimed: number; queued: number }> {
  const queueUrl = process.env.QUEUE_URL;
  if (!queueUrl) throw new Error('QUEUE_URL not set');

  const workerId = `dispatcher-${randomUUID()}`;
  const { data: jobs, error } = await supabase.rpc('claim_due_email_jobs', {
    p_worker_id: workerId,
    p_limit: CLAIM_BATCH_SIZE,
    p_environment: ENVIRONMENT,
  });

  if (error) {
    console.error('claim_due_email_jobs failed', error);
    return { claimed: 0, queued: 0 };
  }

  const claimedJobs = (jobs ?? []) as { id: string }[];
  let queued = 0;

  // Bounded sequential publish — at v1 volume this is a handful of messages
  // per minute, not worth the complexity of a concurrency pool.
  for (const job of claimedJobs) {
    try {
      const send = await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ email_job_id: job.id, environment: ENVIRONMENT }),
      }));
      const { error: markError } = await supabase.rpc('mark_email_job_queued', {
        p_job_id: job.id,
        p_sqs_message_id: send.MessageId ?? null,
      });
      if (markError) {
        console.error('mark_email_job_queued failed', { jobId: job.id, error: markError });
        continue;
      }
      queued++;
    } catch (sqsError) {
      // Job stays 'dispatching' — its lease will expire and a future run
      // will reclaim it (see claim_due_email_jobs' expired-lease clause).
      console.error('SQS send failed, leaving job for lease expiry', { jobId: job.id, error: sqsError });
    }
  }

  return { claimed: claimedJobs.length, queued };
}

export async function handler(): Promise<void> {
  const supabase = await getSupabase();

  const [onboardingEnqueued, extensionEnqueued] = await Promise.all([
    scanOnboardingAbandoned(supabase),
    scanExtensionNudge(supabase),
  ]);

  const { claimed, queued } = await claimAndEnqueue(supabase);

  console.log('dispatcher run complete', {
    environment: ENVIRONMENT,
    onboardingEnqueued,
    extensionEnqueued,
    claimed,
    queued,
  });
}
