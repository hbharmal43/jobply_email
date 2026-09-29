/**
 * Recommendation dispatcher Lambda
 *
 * Runs daily (EventBridge Scheduler, America/Chicago). For each eligible user
 * it picks their top job matches and records them as a deduplicated
 * `job_recommendations` email job (one per user per UTC day).
 *
 * Job listings live on AWS RDS rather than Supabase, so the scan spans two
 * databases: candidate profiles and user embeddings come from Supabase, and
 * the matching itself runs on RDS via `recommend_jobs_aws`. See ./aws-rds.ts.
 *
 * Delivery is moving to Customer.io (the SES/SQS sender was removed on
 * 2026-09-29); the scheduled job row is the per-day dedupe record.
 *
 * Env vars:
 *   SUPABASE_SECRET_ID   ARN/name of the Secrets Manager secret holding
 *                        { "url": "...", "serviceKey": "...", "awsRdsUrl": "..." }
 *   ENVIRONMENT           'production' | 'staging' | 'development' (default production)
 *   PRODUCTION_MODE       'true' to scan; anything else exits immediately
 *   SCAN_BATCH_SIZE       max candidates scanned per run (default 500)
 *   JOBPLY_TEST_USER_IDS  optional comma-separated user ids to scan instead of
 *                         the real candidate list
 *   AWS_RDS_JOBS_TABLE    jobs table on RDS (default scraped_jobs)
 *
 * Deps: @aws-sdk/client-secrets-manager, @supabase/supabase-js, pg
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getRdsPool, recommendJobsFromAws, type RecommendedJobRow } from './aws-rds';

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'production';
const PRODUCTION_MODE = process.env.PRODUCTION_MODE === 'true';
const SCAN_BATCH_SIZE = Number(process.env.SCAN_BATCH_SIZE ?? 500);

interface DispatcherSecret {
  url: string;
  serviceKey: string;
  /** Postgres URL for the RDS instance holding job listings. */
  awsRdsUrl?: string;
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

const JOB_RECOMMENDATIONS_LIMIT = 10;
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

async function scanJobRecommendations(supabase: SupabaseClient): Promise<number> {
  let candidates: JobRecommendationCandidate[] = [];
  const todayStr = new Date().toISOString().split('T')[0];

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

  // Matching now spans two databases: the user's vector and profile come from
  // Supabase, the jobs themselves from RDS. Both Supabase lookups are batched
  // up front so the per-user loop makes exactly one network call.
  const userIds = candidates.map((candidate) => candidate.user_id);
  const [vectors, yearsOfExperience] = await Promise.all([
    fetchUserVectors(supabase, userIds),
    fetchYearsOfExperience(supabase, userIds),
  ]);

  const pool = await getJobsPool();

  let enqueued = 0;

  for (const candidate of candidates) {
    const embedding = vectors.get(candidate.user_id);
    if (!embedding) {
      // Onboarding never produced a vector; nothing to match against.
      console.warn('no user embedding, skipping recommendations', { userId: candidate.user_id });
      await markRecommendationCandidateScanned(supabase, candidate.user_id, todayStr);
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

    if (jobs.length === 0) {
      await markRecommendationCandidateScanned(supabase, candidate.user_id, todayStr);
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
    await markRecommendationCandidateScanned(supabase, candidate.user_id, todayStr);
    if (jobId) enqueued++;
  }
  return enqueued;
}

interface LambdaContext {
  callbackWaitsForEmptyEventLoop?: boolean;
}

export async function handler(_event?: unknown, context?: LambdaContext): Promise<void> {
  // The RDS pool deliberately keeps sockets open across warm invocations, so
  // the event loop never fully drains. Without this the runtime would hold the
  // invocation open until the timeout instead of returning.
  if (context) context.callbackWaitsForEmptyEventLoop = false;

  if (!PRODUCTION_MODE) {
    console.log('dispatcher paused; no profiles scanned');
    return;
  }

  const supabase = await getSupabase();
  const jobRecommendationsEnqueued = await scanJobRecommendations(supabase);

  console.log('dispatcher run complete', {
    environment: ENVIRONMENT,
    jobRecommendationsEnqueued,
  });
}
