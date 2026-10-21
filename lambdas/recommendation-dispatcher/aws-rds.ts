/**
 * AWS RDS (Postgres) access for the job-recommendations journey.
 *
 * Applications live on RDS (the source of truth), not Supabase. The dispatcher
 * reads them here for the motivation counts and to keep jobs the user already
 * applied to out of the digest. Matching itself runs on Typesense (./feed.ts).
 *
 * Connection handling is ported from jobply_website/lib/aws-rds.ts, except
 * credentials come from the Secrets Manager secret this stack already reads.
 */

import { Pool } from 'pg';
import type { AppliedRow } from './applied-jobs';
import type { ApplicationCounts } from './digest';

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

/** Application counts per user from RDS `applications` (the source of truth). */
export async function getApplicationCounts(
  pool: Pool,
  userIds: string[],
): Promise<Map<string, ApplicationCounts>> {
  const counts = new Map<string, ApplicationCounts>();
  if (userIds.length === 0) return counts;

  // Counts only feed the motivation strip, so a failure here must not stop
  // the day's digests: fall back to "no counts" and keep going.
  let result;
  try {
    result = await pool.query<{ user_id: string; total: number; last7d: number; interviews: number }>(
      `SELECT user_id::text AS user_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS last7d,
              COUNT(*) FILTER (WHERE status = 'interview')::int AS interviews
         FROM applications
        WHERE user_id::text = ANY($1::text[])
        GROUP BY user_id`,
      [userIds],
    );
  } catch (error) {
    console.error('application counts query failed; sending digests without counts', { error: String(error) });
    return counts;
  }
  for (const r of result.rows) {
    counts.set(r.user_id, { total: r.total, last7d: r.last7d, interviews: r.interviews });
  }
  return counts;
}

/**
 * Each user's applications, most recent first (the order MAX_EXCLUDED_IDS relies on).
 * Throws on failure: without them the digest could recommend jobs already applied to.
 */
export async function getAppliedRows(
  pool: Pool,
  userIds: string[],
): Promise<Map<string, AppliedRow[]>> {
  const rows = new Map<string, AppliedRow[]>();
  if (userIds.length === 0) return rows;

  const result = await pool.query<AppliedRow & { user_id: string }>(
    `SELECT user_id::text AS user_id, job_id::text AS job_id, company_url, linkedin_job_id
       FROM applications
      WHERE user_id::text = ANY($1::text[])
      ORDER BY applied_date DESC NULLS LAST, created_at DESC`,
    [userIds],
  );
  for (const { user_id, ...row } of result.rows) {
    const list = rows.get(user_id);
    if (list) list.push(row);
    else rows.set(user_id, [row]);
  }
  return rows;
}
