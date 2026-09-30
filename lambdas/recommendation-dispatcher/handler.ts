/**
 * Recommendation dispatcher Lambda
 *
 * Runs daily (EventBridge Scheduler, America/Chicago). For each eligible user
 * it picks their top job matches, records a deduplicated `job_recommendations`
 * row (one per user per UTC day), then sends a `daily_job_matches` event to
 * the Customer.io Track API. A Customer.io campaign renders the email.
 *
 * Job listings live on AWS RDS rather than Supabase, so the scan spans two
 * databases: candidate profiles and user embeddings come from Supabase, and
 * the matching itself runs on RDS via `recommend_jobs_aws`. See ./aws-rds.ts.
 *
 * The event payload is built by ./digest.ts. Jobs the user already applied to
 * are dropped; users with fewer than 3 remaining jobs get no email that day.
 *
 * Env vars:
 *   SUPABASE_SECRET_ID   ARN/name of the Secrets Manager secret holding
 *                        { "url", "serviceKey", "awsRdsUrl", "cioSiteId", "cioApiKey" }
 *   ENVIRONMENT           'production' | 'staging' | 'development' (default production)
 *   PRODUCTION_MODE       'true' to scan; anything else exits immediately
 *   SCAN_BATCH_SIZE       max candidates scanned per run (default 500)
 *   JOBPLY_TEST_USER_IDS  optional comma-separated user ids to scan instead of
 *                         the real candidate list
 *   AWS_RDS_JOBS_TABLE    jobs table on RDS (default scraped_jobs)
 *
 * Deps: @aws-sdk/client-secrets-manager, @supabase/supabase-js, pg, fetch (Customer.io)
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getApplicationCounts, getRdsPool, recommendJobsFromAws, type RecommendedJobRow } from './aws-rds';
import { buildDigest } from './digest';
import { deliverDigest } from './deliver';
import { sendCustomerIoEvent } from './customerio';

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'production';
const PRODUCTION_MODE = process.env.PRODUCTION_MODE === 'true';
const SCAN_BATCH_SIZE = Number(process.env.SCAN_BATCH_SIZE ?? 500);

interface DispatcherSecret {
  url: string;
  serviceKey: string;
  /** Postgres URL for the RDS instance holding job listings. */
  awsRdsUrl?: string;
  /** Customer.io Track API credentials. */
  cioSiteId?: string;
  cioApiKey?: string;
}

let cachedSecret: DispatcherSecret | null = null;
async function loadSecret(): Promise<DispatcherSecret> {
  if (cachedSecret) return cachedSecret;
  const secretId = process.env.SUPABASE_SECRET_ID;
  if (!secretId) throw new Error('SUPABASE_SECRET_ID not set');

  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const secret = JSON.parse(res.SecretString ?? '{}') as DispatcherSecret;
  if (!secret.url || !secret.serviceKey) throw new Error('Supabase secret missing url/serviceKey');

  cachedSecret = secret;
  return cachedSecret;
}

let cachedClient: SupabaseClient | null = null;
async function getSupabase(): Promise<SupabaseClient> {
  if (cachedClient) return cachedClient;
  const { url, serviceKey } = await loadSecret();

  cachedClient = createClient(url, serviceKey, { auth: { persistSession: false } });
  return cachedClient;
}

async function getJobsPool() {
  const { awsRdsUrl } = await loadSecret();
  if (!awsRdsUrl) throw new Error('Supabase secret missing awsRdsUrl');
  return getRdsPool(awsRdsUrl);
}

interface JobRecommendationCandidate {
  user_id: string;
  email: string;
  first_name: string | null;
  full_name: string | null;
  title: string | null;
}

/** More than the 5 we email, so jobs the user already applied to can be dropped. */
const JOB_RECOMMENDATIONS_LIMIT = 15;
const TEST_USER_IDS_ENV = process.env.JOBPLY_TEST_USER_IDS;

/**
 * A 1536-dimension embedding serializes to roughly 20 KB, so a full
 * 500-candidate scan would be ~10 MB in one response. Chunking also keeps the
 * user_id IN-list from overflowing PostgREST's request URL.
 */
const CANDIDATE_LOOKUP_CHUNK_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * user_embeddings never moved to RDS — only the job listings did — so the
 * vector has to be read from Supabase and shipped to recommend_jobs_aws on
 * every call. Returned as the pgvector literal the function expects.
 */
async function fetchUserVectors(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, string>> {
  const vectors = new Map<string, string>();

  for (const ids of chunk(userIds, CANDIDATE_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('user_embeddings')
      .select('user_id, embedding')
      .in('user_id', ids);

    if (error) {
      console.error('user_embeddings lookup failed', error);
      continue;
    }

    for (const row of (data ?? []) as { user_id: string; embedding: unknown }[]) {
      if (!row.embedding) continue;
      vectors.set(
        row.user_id,
        typeof row.embedding === 'string' ? row.embedding : JSON.stringify(row.embedding),
      );
    }
  }

  return vectors;
}

/** recommend_jobs_aws takes years of experience as a parameter rather than
 *  looking it up, because profiles still live in Supabase. */
async function fetchYearsOfExperience(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, number | null>> {
  const years = new Map<string, number | null>();

  for (const ids of chunk(userIds, CANDIDATE_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, years_of_experience')
      .in('id', ids);

    if (error) {
      console.error('years_of_experience lookup failed', error);
      continue;
    }

    for (const row of (data ?? []) as { id: string; years_of_experience: number | null }[]) {
      years.set(row.id, row.years_of_experience ?? null);
    }
  }

  return years;
}

/** Records a user as evaluated today so a bounded scan advances past them
 *  tomorrow instead of re-reading the same first page. */
async function markRecommendationCandidateScanned(
  supabase: SupabaseClient,
  userId: string,
  scanKey: string,
): Promise<void> {
  const { error } = await supabase.rpc('mark_email_candidate_scanned', {
    p_environment: ENVIRONMENT,
    p_journey_key: 'job_recommendations',
    p_user_id: userId,
    p_scan_key: scanKey,
  });
  if (error) console.error('mark_email_candidate_scanned failed', { userId, error });
}

interface ScanOptions {
  /** Build and log payloads only: no Supabase writes, no Customer.io events. */
  dryRun: boolean;
  /** Scan exactly these users instead of the candidate RPC. */
  userIds?: string[];
}

async function loadCandidatesByIds(supabase: SupabaseClient, ids: string[]): Promise<JobRecommendationCandidate[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, first_name, full_name, title')
    .in('id', ids)
    .not('email', 'is', null);
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return (data ?? []).map((p: any) => ({
    user_id: p.id,
    email: p.email,
    first_name: p.first_name,
    full_name: p.full_name,
    title: p.title,
  }));
}

async function scanJobRecommendations(supabase: SupabaseClient, opts: ScanOptions): Promise<number> {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const envTestIds = TEST_USER_IDS_ENV
    ? TEST_USER_IDS_ENV.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
    : [];
  const explicitIds = opts.userIds && opts.userIds.length > 0 ? opts.userIds : envTestIds;

  let candidates: JobRecommendationCandidate[];
  if (explicitIds.length > 0) {
    candidates = await loadCandidatesByIds(supabase, explicitIds);
  } else {
    const { data, error } = await supabase.rpc('get_job_recommendation_candidates', {
      p_environment: ENVIRONMENT,
      p_scan_key: todayStr,
      p_limit: SCAN_BATCH_SIZE,
    });
    if (error) {
      console.error('get_job_recommendation_candidates failed', error);
      return 0;
    }
    candidates = (data ?? []) as JobRecommendationCandidate[];
  }

  if (candidates.length === 0) return 0;

  const { cioSiteId, cioApiKey } = await loadSecret();
  if (!opts.dryRun && (!cioSiteId || !cioApiKey)) throw new Error('Secret missing cioSiteId/cioApiKey');

  // Matching spans two databases: the user's vector and profile come from
  // Supabase, the jobs and applications from RDS. Lookups are batched up front
  // so the per-user loop makes one RDS call.
  const pool = await getJobsPool();
  const userIds = candidates.map((candidate) => candidate.user_id);
  const [vectors, yearsOfExperience, applicationCounts] = await Promise.all([
    fetchUserVectors(supabase, userIds),
    fetchYearsOfExperience(supabase, userIds),
    getApplicationCounts(pool, userIds),
  ]);

  let sent = 0;

  for (const candidate of candidates) {
    const embedding = vectors.get(candidate.user_id);
    if (!embedding) {
      // Onboarding never produced a vector; nothing to match against.
      console.warn('no user embedding, skipping recommendations', { userId: candidate.user_id });
      if (!opts.dryRun) await markRecommendationCandidateScanned(supabase, candidate.user_id, todayStr);
      continue;
    }

    let jobs: RecommendedJobRow[];
    try {
      jobs = await recommendJobsFromAws(pool, {
        userId: candidate.user_id,
        embedding,
        limit: JOB_RECOMMENDATIONS_LIMIT,
        yearsOfExperience: yearsOfExperience.get(candidate.user_id) ?? null,
      });
    } catch (recError) {
      // Deliberately no Supabase fallback: its job tables are stale now that
      // listings live on RDS, so a fallback digest would link to dead postings.
      // Left unmarked so the user is retried rather than skipped for the day.
      console.error('recommend_jobs_aws failed', { userId: candidate.user_id, error: recError });
      continue;
    }

    const digest = buildDigest({
      userId: candidate.user_id,
      jobs,
      counts: applicationCounts.get(candidate.user_id) ?? { total: 0, last7d: 0, interviews: 0 },
      now,
    });

    if (opts.dryRun) {
      console.log('dry run digest', JSON.stringify({ userId: candidate.user_id, rdsJobs: jobs.length, digest }));
      continue;
    }

    if (!digest) {
      await markRecommendationCandidateScanned(supabase, candidate.user_id, todayStr);
      continue;
    }

    const result = await deliverDigest({
      schedule: async () => {
        const { data: jobId, error } = await supabase.rpc('schedule_email_job', {
          p_user_id: candidate.user_id,
          p_recipient_email: candidate.email,
          p_journey_key: 'job_recommendations',
          p_template_key: 'job_recommendations',
          p_dedupe_key: `job_recommendations:${candidate.user_id}:${todayStr}`,
          p_category: 'recommendations',
          p_payload: digest,
          p_environment: ENVIRONMENT,
        });
        if (error) throw new Error(error.message);
        return (jobId as string | null) ?? null;
      },
      send: () => sendCustomerIoEvent(
        { siteId: cioSiteId!, apiKey: cioApiKey! },
        candidate.user_id,
        'daily_job_matches',
        digest,
      ),
    });

    if (result !== 'schedule_failed') {
      await markRecommendationCandidateScanned(supabase, candidate.user_id, todayStr);
    }
    if (result === 'sent') sent++;
    else console.log('digest not sent', { userId: candidate.user_id, result });
  }
  return sent;
}

interface LambdaContext {
  callbackWaitsForEmptyEventLoop?: boolean;
}

export interface DispatcherEvent {
  dryRun?: boolean;
  userIds?: string[];
}

export async function handler(event?: DispatcherEvent, context?: LambdaContext): Promise<void> {
  // The RDS pool deliberately keeps sockets open across warm invocations, so
  // the event loop never fully drains. Without this the runtime would hold the
  // invocation open until the timeout instead of returning.
  if (context) context.callbackWaitsForEmptyEventLoop = false;

  const dryRun = event?.dryRun === true;
  // A dry run writes nothing, so it is allowed while the stack is paused.
  if (!PRODUCTION_MODE && !dryRun) {
    console.log('dispatcher paused; no profiles scanned');
    return;
  }

  const supabase = await getSupabase();
  const digestsSent = await scanJobRecommendations(supabase, { dryRun, userIds: event?.userIds });

  console.log('dispatcher run complete', { environment: ENVIRONMENT, dryRun, digestsSent });
}
