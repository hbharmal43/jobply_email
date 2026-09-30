/**
 * AWS RDS (Postgres) access for the job-recommendations journey.
 *
 * Job listings moved out of Supabase onto RDS, so `recommend_jobs_aws` — the
 * replacement for Supabase's `recommend_jobs_for_user_v3` — lives on a
 * different database than `profiles` and `user_embeddings`. This module owns
 * that second connection; everything else in the dispatcher still talks to
 * Supabase.
 *
 * Ported from jobply_website/lib/aws-rds.ts, with three deliberate changes:
 *   - credentials come from the Secrets Manager secret this stack already
 *     reads, never from plaintext env vars
 *   - the projection is trimmed to the columns the email template renders,
 *     because every selected column is snapshotted into email_jobs.payload
 *     (description_text in particular would bloat that JSONB enormously)
 *   - results are explicitly ordered, see recommendJobsFromAws
 */

import { Pool } from 'pg';

/** Matches the website's AWS_RDS_JOBS_TABLE override. */
const JOBS_TABLE = process.env.AWS_RDS_JOBS_TABLE ?? 'scraped_jobs';

interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Parses a Postgres URL into connection parameters. The regex fallback is
 * carried over from the website: `new URL()` mangles passwords containing
 * unescaped special characters (notably colons), which these credentials have.
 */
export function parseConnectionUrl(rawUrl: string): DbConfig {
  // Normalize the SQLAlchemy protocol the Python scrapers use.
  const cleanUrl = rawUrl.replace(/^postgresql\+psycopg:\/\//, 'postgresql://');

  try {
    const parsed = new URL(cleanUrl);
    if (parsed.hostname && parsed.username) {
      return {
        host: parsed.hostname,
        port: Number(parsed.port) || 5432,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, ''),
      };
    }
  } catch {
    // fall through to the regex below
  }

  const match = cleanUrl.match(
    /^(?:postgresql\+psycopg|postgresql|postgres):\/\/([^:]+):(.+)@([^:/]+)(?::(\d+))?\/([^?]+)/,
  );
  if (!match) throw new Error('awsRdsUrl is not a parseable Postgres connection URL');

  return {
    user: match[1],
    password: match[2],
    host: match[3],
    port: Number(match[4]) || 5432,
    database: match[5],
  };
}

let cachedPool: Pool | null = null;

/**
 * Singleton pool, reused across warm invocations. RDS is reachable over the
 * public internet (the website connects to it from Vercel), so the Lambda
 * needs no VPC attachment. `rejectUnauthorized` defaults to false to match the
 * website: RDS presents an Amazon-issued certificate that is not in Node's
 * default trust store.
 */
export function getRdsPool(connectionUrl: string): Pool {
  if (cachedPool) return cachedPool;

  const config = parseConnectionUrl(connectionUrl);

  cachedPool = new Pool({
    ...config,
    // One dispatcher run is a sequential loop, so a small pool is plenty and
    // keeps us well clear of the instance's connection limit.
    max: Number(process.env.AWS_RDS_MAX_CONNECTIONS ?? 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl:
      process.env.AWS_RDS_SSL === 'false'
        ? false
        : { rejectUnauthorized: process.env.AWS_RDS_SSL_REJECT_UNAUTHORIZED === 'true' },
  });

  // Without this, a dropped backend connection surfaces as an unhandled
  // 'error' event and kills the whole Lambda invocation.
  cachedPool.on('error', (err) => {
    console.error('AWS RDS pool error', err);
  });

  return cachedPool;
}

/**
 * One row per recommended job. Field names intentionally match what
 * templates/job-recommendations.ts already reads, so the template needs no
 * changes — see its `job.job_title || job.title` style accessors.
 */
export interface RecommendedJobRow {
  id: string;
  job_title: string | null;
  company_name: string | null;
  location: string | null;
  job_url: string | null;
  ai_work_arrangement: string | null;
  salary_min: number | string | null;
  salary_max: number | string | null;
  salary_currency: string | null;
  match_score: number | string | null;
}

export interface RecommendJobsParams {
  userId: string;
  /** pgvector literal, e.g. "[0.12,0.34,...]". */
  embedding: string;
  limit: number;
  yearsOfExperience: number | null;
}

/**
 * `recommend_jobs_aws` returns only (job_id, match_score, match_explanation),
 * so the job columns come from a join — same shape the website uses.
 *
 * Two differences from the website's copy of this query:
 *   - an explicit ORDER BY. A join does not preserve a set-returning
 *     function's output order, so without it the "top 10" arrive unranked —
 *     which matters here because the email numbers them 01..10.
 *   - is_active is re-checked, so a digest can't link to a delisted posting
 *     between the nightly scan and the user opening the mail.
 */
export async function recommendJobsFromAws(
  pool: Pool,
  params: RecommendJobsParams,
): Promise<RecommendedJobRow[]> {
  const sql = `
    SELECT
      j.id,
      j.job_title,
      j.company_name,
      j.location,
      j.job_url,
      j.ai_work_arrangement,
      j.salary_min,
      j.salary_max,
      j.salary_currency,
      r.match_score
    FROM recommend_jobs_aws($1, $2::uuid, $3, $4, $5) r
    JOIN ${JOBS_TABLE} j ON r.job_id = j.id
    WHERE j.is_active = true
    ORDER BY r.match_score DESC NULLS LAST
    LIMIT $3;
  `;

  const result = await pool.query<RecommendedJobRow>(sql, [
    params.embedding,
    params.userId,
    params.limit,
    'best',
    params.yearsOfExperience,
  ]);

  return result.rows;
}
