/**
 * Recommendation dispatcher Lambda
 *
 * Runs hourly (EventBridge Scheduler). Each run handles the users for whom it
 * is now SEND_HOUR (9 AM) local time, see ./timezone.ts; for each of them it
 * picks their top job matches, records a deduplicated `job_recommendations`
 * row (one per user per UTC day), then sends a `daily_job_matches` event to
 * the Customer.io Track API. A Customer.io campaign renders the email.
 *
 * Matching is the same Typesense search the dashboard's "For You" feed uses
 * (./feed.ts): one title search per target role from job_preferences, filtered
 * by years of experience, with sponsor-only searches for users who need a visa.
 * Profiles and preferences come from Supabase; applications from AWS RDS.
 *
 * The event payload is built by ./digest.ts. Jobs the user already applied to
 * are dropped; users with fewer than 3 remaining jobs get no email that day.
 *
 * Env vars:
 *   SUPABASE_SECRET_ID   ARN/name of the Secrets Manager secret holding
 *                        { "url", "serviceKey", "awsRdsUrl", "cioSiteId", "cioApiKey",
 *                          "typesenseSearchKey", "typesenseUrl"? }
 *   ENVIRONMENT           'production' | 'staging' | 'development' (default production)
 *   PRODUCTION_MODE       'true' to scan; anything else exits immediately
 *   SCAN_BATCH_SIZE       max candidates scanned per run (default 500)
 *   DIGEST_US_ONLY        'true' to email only users in US timezones (rollout gate)
 *   JOBPLY_TEST_USER_IDS  optional comma-separated user ids to scan instead of
 *                         the real candidate list
 *
 * Deps: @aws-sdk/client-secrets-manager, @supabase/supabase-js, pg, fetch (Customer.io, Typesense)
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getApplicationCounts, getAppliedRows, getRdsPool } from './aws-rds';
import { buildAppliedMatcher, MAX_EXCLUDED_IDS } from './applied-jobs';
import { assembleFeed, buildFeedPlan, normalizeRoles, type DigestSourceJob, type FeedProfile } from './feed';
import { multiSearch, type TypesenseConfig } from './typesense';
import { buildDigest } from './digest';
import { isUsTimeZone, localHour, SEND_HOUR, userTimeZone } from './timezone';
import { deliverDigest } from './deliver';
import { sendCustomerIoEvent } from './customerio';

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'production';
const PRODUCTION_MODE = process.env.PRODUCTION_MODE === 'true';
const SCAN_BATCH_SIZE = Number(process.env.SCAN_BATCH_SIZE ?? 500);
const DIGEST_US_ONLY = process.env.DIGEST_US_ONLY === 'true';

interface DispatcherSecret {
  url: string;
  serviceKey: string;
  /** Postgres URL for the RDS instance holding applications. */
  awsRdsUrl?: string;
  /** Search-only Typesense key (the website's TYPESENSE_SEARCH_API_KEY). */
  typesenseSearchKey?: string;
  /** Defaults to https://search.jobply.ai */
  typesenseUrl?: string;
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

async function getTypesenseConfig(): Promise<TypesenseConfig> {
  const { typesenseSearchKey, typesenseUrl } = await loadSecret();
  if (!typesenseSearchKey) throw new Error('Supabase secret missing typesenseSearchKey');
  return { url: typesenseUrl ?? 'https://search.jobply.ai', searchKey: typesenseSearchKey };
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

/** More than the 5 we email, so URL-matched applied jobs can be dropped and more_count means something. */
const JOB_RECOMMENDATIONS_LIMIT = 15;
const TEST_USER_IDS_ENV = process.env.JOBPLY_TEST_USER_IDS;

/** Keeps the user_id IN-list from overflowing PostgREST's request URL. */
const CANDIDATE_LOOKUP_CHUNK_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Everything feed.ts needs per user: target roles (job_preferences.interested_roles, falling
 * back to profiles.title), years of experience and visa need. Users with no roles are absent.
 */
async function fetchFeedProfiles(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, FeedProfile>> {
  const profiles = new Map<string, FeedProfile>();

  for (const ids of chunk(userIds, CANDIDATE_LOOKUP_CHUNK_SIZE)) {
    const [profileRes, prefsRes] = await Promise.all([
      supabase.from('profiles').select('id, title, years_of_experience, visa_sponsorship_required').in('id', ids),
      supabase.from('job_preferences').select('user_id, interested_roles').in('user_id', ids),
    ]);
    if (profileRes.error || prefsRes.error) {
      console.error('feed profile lookup failed', { profiles: profileRes.error, preferences: prefsRes.error });
      continue;
    }

    const roles = new Map<string, unknown>(
      ((prefsRes.data ?? []) as { user_id: string; interested_roles: unknown }[])
        .map((r) => [r.user_id, r.interested_roles]),
    );
    for (const p of (profileRes.data ?? []) as {
      id: string;
      title: string | null;
      years_of_experience: number | null;
      visa_sponsorship_required: string | null;
    }[]) {
      const userRoles = normalizeRoles(roles.get(p.id), p.title);
      if (!userRoles.length) continue;
      const years = p.years_of_experience;
      profiles.set(p.id, {
        roles: userRoles,
        yearsOfExperience: typeof years === 'number' && years >= 0 ? years : null,
        needsVisa: (p.visa_sponsorship_required ?? '').toLowerCase() === 'yes',
      });
    }
  }

  return profiles;
}

/** Each user's timezone, from profiles.state / country. Missing users get the default. */
async function fetchTimeZones(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, string>> {
  const zones = new Map<string, string>();

  for (const ids of chunk(userIds, CANDIDATE_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase.from('profiles').select('id, state, country').in('id', ids);
    if (error) {
      console.error('timezone lookup failed', error);
      continue;
    }
    for (const p of (data ?? []) as { id: string; state: string | null; country: string | null }[]) {
      zones.set(p.id, userTimeZone(p.state, p.country));
    }
  }

  return zones;
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

  // Only users for whom it's SEND_HOUR now; the rest are left for their own hour.
  // Explicit test ids skip the clock so a manual run always produces a digest.
  const timeZones = await fetchTimeZones(supabase, candidates.map((candidate) => candidate.user_id));
  const zoneOf = (userId: string) => timeZones.get(userId) ?? userTimeZone(null, null);
  if (explicitIds.length === 0) {
    candidates = candidates.filter((candidate) => {
      const zone = zoneOf(candidate.user_id);
      return localHour(now, zone) === SEND_HOUR && (!DIGEST_US_ONLY || isUsTimeZone(zone));
    });
    if (candidates.length === 0) return 0;
  }

  const { cioSiteId, cioApiKey } = await loadSecret();
  if (!opts.dryRun && (!cioSiteId || !cioApiKey)) throw new Error('Secret missing cioSiteId/cioApiKey');

  // Profiles and preferences come from Supabase, applications from RDS. Lookups
  // are batched up front so the per-user loop makes one Typesense call.
  const typesense = await getTypesenseConfig();
  const pool = await getJobsPool();
  const userIds = candidates.map((candidate) => candidate.user_id);
  const [feedProfiles, appliedRows, applicationCounts] = await Promise.all([
    fetchFeedProfiles(supabase, userIds),
    getAppliedRows(pool, userIds),
    getApplicationCounts(pool, userIds),
  ]);
  const nowSec = Math.floor(now.getTime() / 1000);

  let sent = 0;

  for (const candidate of candidates) {
    const profile = feedProfiles.get(candidate.user_id);
    if (!profile) {
      // No target roles and no profile title; nothing to search for.
      console.warn('no target roles, skipping recommendations', { userId: candidate.user_id });
      if (!opts.dryRun) await markRecommendationCandidateScanned(supabase, candidate.user_id, todayStr);
      continue;
    }

    const applied = buildAppliedMatcher(appliedRows.get(candidate.user_id) ?? []);
    const plan = buildFeedPlan(profile, {
      limit: JOB_RECOMMENDATIONS_LIMIT,
      excludeIds: applied.ids.slice(0, MAX_EXCLUDED_IDS),
      nowSec,
    });

    let jobs: DigestSourceJob[];
    try {
      // URL-based applications and ids past the exclusion cap can't be expressed in filter_by.
      jobs = assembleFeed(plan, await multiSearch(typesense, plan.searches))
        .filter((job) => !applied.isApplied(job));
    } catch (searchError) {
      // No fallback to the old embedding matcher. Left unmarked so the user is
      // retried rather than skipped for the day.
      console.error('typesense search failed', { userId: candidate.user_id, error: String(searchError) });
      continue;
    }

    const digest = buildDigest({
      userId: candidate.user_id,
      jobs,
      counts: applicationCounts.get(candidate.user_id) ?? { total: 0, last7d: 0, interviews: 0 },
      now,
      timeZone: zoneOf(candidate.user_id),
    });

    if (opts.dryRun) {
      console.log('dry run digest', JSON.stringify({ userId: candidate.user_id, roles: profile.roles, matched: jobs.length, digest }));
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
