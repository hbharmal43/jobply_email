/**
 * Dispatcher Lambda — Part B (SES)
 *
 * Runs once a minute on an EventBridge Scheduler rate(1 minute) rule. Two jobs:
 *
 *  1. Scan `profiles` (joined to `applications` for two of them) for the
 *     four time/milestone-based journeys and enqueue any newly due jobs
 *     (idempotent via schedule_email_job's dedupe_key conflict):
 *       - onboarding_abandoned    24h after onboarding started, still incomplete
 *       - extension_nudge         3 days after onboarding completed, extension not installed
 *       - application_milestone   3 days after onboarding completed — praises
 *                                 progress or nudges a first application depending
 *                                 on application count at that moment
 *       - extension_feedback      once application count reaches the feedback threshold
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
const PRODUCTION_MODE = process.env.PRODUCTION_MODE === 'true';
const CLAIM_BATCH_SIZE = Number(process.env.CLAIM_BATCH_SIZE ?? 50);
const SCAN_BATCH_SIZE = Number(process.env.SCAN_BATCH_SIZE ?? 100);

const SCANNED_JOURNEYS = [
  'onboarding_abandoned',
  'extension_nudge',
  'application_milestone',
  'extension_feedback',
  'job_recommendations',
] as const;

type ScannedJourney = (typeof SCANNED_JOURNEYS)[number];

const ENABLED_JOURNEYS = new Set(
  (process.env.ENABLED_JOURNEYS || SCANNED_JOURNEYS.join(','))
    .split(',')
    .map((journey) => journey.trim())
    .filter(Boolean),
);

function scanIfEnabled(journey: ScannedJourney, scan: () => Promise<number>): Promise<number> {
  return ENABLED_JOURNEYS.has(journey) ? scan() : Promise.resolve(0);
}

const ONBOARDING_ABANDONED_DELAY_HOURS = 24;
const EXTENSION_NUDGE_DELAY_DAYS = 3;
const APPLICATION_MILESTONE_DELAY_DAYS = 3;
const EXTENSION_FEEDBACK_THRESHOLD = 5;

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

interface ApplicationMilestoneCandidate {
  user_id: string;
  email: string;
  first_name: string | null;
  application_count: number;
}

async function scanApplicationMilestone(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - APPLICATION_MILESTONE_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase.rpc('get_application_milestone_candidates', {
    p_cutoff: cutoff,
    p_limit: SCAN_BATCH_SIZE,
  });

  if (error) {
    console.error('get_application_milestone_candidates failed', error);
    return 0;
  }

  let enqueued = 0;
  for (const candidate of (data ?? []) as ApplicationMilestoneCandidate[]) {
    const templateKey = candidate.application_count > 0 ? 'application_praise' : 'no_applications_nudge';
    const { data: jobId, error: rpcError } = await supabase.rpc('schedule_email_job', {
      p_user_id: candidate.user_id,
      p_recipient_email: candidate.email,
      p_journey_key: 'application_milestone',
      p_template_key: templateKey,
      p_dedupe_key: `application_milestone:${candidate.user_id}`,
      p_category: 'lifecycle',
      p_payload: { firstName: candidate.first_name, applicationCount: candidate.application_count },
      p_environment: ENVIRONMENT,
    });
    if (rpcError) {
      console.error('schedule_email_job (application_milestone) failed', { userId: candidate.user_id, error: rpcError });
      continue;
    }
    if (jobId) enqueued++;
  }
  return enqueued;
}

interface ExtensionFeedbackCandidate {
  user_id: string;
  email: string;
  first_name: string | null;
}

async function scanExtensionFeedback(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc('get_extension_feedback_candidates', {
    p_threshold: EXTENSION_FEEDBACK_THRESHOLD,
    p_limit: SCAN_BATCH_SIZE,
  });

  if (error) {
    console.error('get_extension_feedback_candidates failed', error);
    return 0;
  }

  let enqueued = 0;
  for (const candidate of (data ?? []) as ExtensionFeedbackCandidate[]) {
    const { data: jobId, error: rpcError } = await supabase.rpc('schedule_email_job', {
      p_user_id: candidate.user_id,
      p_recipient_email: candidate.email,
      p_journey_key: 'extension_feedback',
      p_template_key: 'extension_feedback',
      p_dedupe_key: `extension_feedback:${candidate.user_id}`,
      p_category: 'lifecycle',
      p_payload: { firstName: candidate.first_name },
      p_environment: ENVIRONMENT,
    });
    if (rpcError) {
      console.error('schedule_email_job (extension_feedback) failed', { userId: candidate.user_id, error: rpcError });
      continue;
    }
    if (jobId) enqueued++;
  }
  return enqueued;
}

interface JobRecommendationCandidate {
  user_id: string;
  email: string;
  first_name: string | null;
  full_name: string | null;
  title: string | null;
}

const JOB_RECOMMENDATIONS_LIMIT = 10;
const TEST_USER_IDS_ENV = process.env.JOBPLY_TEST_USER_IDS;

async function scanJobRecommendations(supabase: SupabaseClient): Promise<number> {
  let candidates: JobRecommendationCandidate[] = [];

  const testUserIds = TEST_USER_IDS_ENV
    ? TEST_USER_IDS_ENV.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
    : [];

  if (testUserIds.length > 0) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, first_name, full_name, title')
      .in('id', testUserIds)
      .not('email', 'is', null);

    if (error) {
      console.error('JOBPLY_TEST_USER_IDS query failed', error);
      return 0;
    }
    candidates = (data ?? []).map((p: any) => ({
      user_id: p.id,
      email: p.email,
      first_name: p.first_name,
      full_name: p.full_name,
      title: p.title,
    }));
  } else {
    const { data, error } = await supabase.rpc('get_job_recommendation_candidates', {
      p_limit: SCAN_BATCH_SIZE,
    });

    if (error) {
      console.error('get_job_recommendation_candidates failed', error);
      return 0;
    }
    candidates = (data ?? []) as JobRecommendationCandidate[];
  }

  const todayStr = new Date().toISOString().split('T')[0];
  let enqueued = 0;

  for (const candidate of candidates) {
    const { data: jobs, error: recError } = await supabase.rpc('recommend_jobs_for_user_v3', {
      p_user_id: candidate.user_id,
      p_limit: JOB_RECOMMENDATIONS_LIMIT,
      p_sort_by: 'best',
    });

    if (recError) {
      console.error('recommend_jobs_for_user_v3 failed', { userId: candidate.user_id, error: recError });
      continue;
    }

    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
      continue;
    }

    const { data: jobId, error: rpcError } = await supabase.rpc('schedule_email_job', {
      p_user_id: candidate.user_id,
      p_recipient_email: candidate.email,
      p_journey_key: 'job_recommendations',
      p_template_key: 'job_recommendations',
      p_dedupe_key: `job_recommendations:${candidate.user_id}:${todayStr}`,
      p_category: 'recommendations',
      p_payload: {
        firstName: candidate.first_name || candidate.full_name,
        userTitle: candidate.title,
        jobs: jobs,
      },
      p_environment: ENVIRONMENT,
    });

    if (rpcError) {
      console.error('schedule_email_job (job_recommendations) failed', { userId: candidate.user_id, error: rpcError });
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
  if (!PRODUCTION_MODE) {
    console.log('dispatcher paused; no profiles scanned and no jobs claimed');
    return;
  }

  const supabase = await getSupabase();

  const [
    onboardingEnqueued,
    extensionEnqueued,
    applicationMilestoneEnqueued,
    extensionFeedbackEnqueued,
    jobRecommendationsEnqueued,
  ] = await Promise.all([
    scanIfEnabled('onboarding_abandoned', () => scanOnboardingAbandoned(supabase)),
    scanIfEnabled('extension_nudge', () => scanExtensionNudge(supabase)),
    scanIfEnabled('application_milestone', () => scanApplicationMilestone(supabase)),
    scanIfEnabled('extension_feedback', () => scanExtensionFeedback(supabase)),
    scanIfEnabled('job_recommendations', () => scanJobRecommendations(supabase)),
  ]);

  const { claimed, queued } = await claimAndEnqueue(supabase);

  console.log('dispatcher run complete', {
    environment: ENVIRONMENT,
    productionMode: PRODUCTION_MODE,
    enabledJourneys: [...ENABLED_JOURNEYS],
    onboardingEnqueued,
    extensionEnqueued,
    applicationMilestoneEnqueued,
    extensionFeedbackEnqueued,
    jobRecommendationsEnqueued,
    claimed,
    queued,
  });
}
