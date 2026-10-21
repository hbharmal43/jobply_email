/**
 * Typesense-backed job matching for the daily digest.
 *
 * Ported from jobply_website/lib/recommendations/typesense-feed.ts so the email shows the
 * same "For You" ranking as the dashboard: one title search per target role
 * (job_preferences.interested_roles), filtered by experience, with VISA_SHARE of the list
 * from sponsor-only searches for users who need a visa. All searches go out in one
 * multi_search request.
 *
 * Differences from the website:
 *   - only the first page, ranked "for_you"; no sort switch or paging
 *   - jobs must be posted since the previous digest (maxAgeDays: 2-3 days on the Mon/Wed/Fri
 *     schedule; the dashboard uses 30), so an email doesn't repeat the last one's matches
 *   - results map to DigestSourceJob (the fields digest.ts renders), not the dashboard card
 *
 * Pure functions only; ./typesense.ts does the HTTP call.
 */
import { ROLE_CATEGORIES } from './role-categories';

export const MAX_ROLES = 4;
export const VISA_SHARE = 0.2;
/** Fallback window when the caller doesn't pass maxAgeDays. */
export const EMAIL_MAX_AGE_DAYS = 3;
/** Typesense alias the website searches; the nightly reindex swaps the collection behind it. */
export const JOBS_ALIAS = 'jobs';

export interface FeedProfile {
  roles: string[];
  yearsOfExperience: number | null;
  needsVisa: boolean;
}

export interface FeedStream {
  role: string;
  visaOnly: boolean;
  perPage: number;
}

export interface FeedPlan {
  streams: FeedStream[];
  searches: Record<string, unknown>[];
}

/** One matched job, in the shape digest.ts renders. */
export interface DigestSourceJob {
  id: string;
  job_title: string | null;
  company_name: string | null;
  location: string | null;
  job_url: string | null;
  ai_work_arrangement: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
}

export interface RawResult {
  found?: number;
  hits?: { document: Record<string, any> }[];
  error?: string;
  code?: number;
}

/** The seniority a user with `years` of experience fits best. */
export function preferredLevel(years: number | null): 'entry' | 'mid' | 'senior' | null {
  if (years === null) return null;
  if (years <= 2) return 'entry';
  if (years >= 6) return 'senior';
  return 'mid';
}

/**
 * Near-equal title matches are grouped into buckets; inside a bucket, jobs at the user's
 * level come first, then the newest. Same as the dashboard's "For You".
 */
export function sortBy(years: number | null): string {
  const level = preferredLevel(years);
  return ['_text_match(buckets: 10):desc', level ? `_eval(experience_level:=${level}):desc` : null, 'date_posted:desc']
    .filter(Boolean).join(',');
}

const FEED_QUERY_PARAMS = {
  query_by: 'title,skills',
  query_by_weights: '4,1',
  prefix: 'true,false',
  num_typos: '1,0',
  // Never drop words: "Backend Engineer" falling back to "Engineer" would match every engineering job.
  drop_tokens_threshold: 0,
  // "Senior Backend Engineer" should score like "Backend Engineer"; seniority is decided by sortBy.
  prioritize_exact_match: false,
  // multi_search shares elapsed request time across the role/visa searches.
  search_cutoff_ms: 1000,
  include_fields: 'id,title,company,location_display,work_arrangement,salary_min_annual,salary_max_annual,job_url',
} as const;

const CATEGORY_NAMES = new Set(Object.keys(ROLE_CATEGORIES));

/** The first role of each subcategory, e.g. "Product" → Product Manager, Product Designer. */
function expandCategory(category: string): string[] {
  return Object.values(ROLE_CATEGORIES[category] ?? {}).map((roles) => roles[0]).filter(Boolean);
}

/**
 * interested_roles is stored as a comma string (sometimes TEXT[]) holding both specific roles and
 * top-level category names. Specific roles win; categories only stand in when no role was picked.
 */
export function normalizeRoles(raw: unknown, fallbackTitle?: string | null): string[] {
  const entries = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  const specific = entries.filter((e) => !CATEGORY_NAMES.has(e));
  const candidates = specific.length ? specific : entries.flatMap(expandCategory);
  if (!candidates.length && fallbackTitle?.trim()) candidates.push(fallbackTitle.trim());

  const seen = new Set<string>();
  const roles: string[] = [];
  for (const role of candidates) {
    const key = role.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roles.push(role);
    if (roles.length === MAX_ROLES) break;
  }
  return roles;
}

/**
 * Hide clearly mismatched seniority. `!=` keeps jobs with no experience_level, which an
 * "only these levels" filter would silently drop.
 */
export function experienceFilter(years: number | null): string | null {
  if (years === null) return null;
  if (years <= 2) return 'experience_level:!=senior';
  if (years >= 6) return 'experience_level:!=entry';
  return null;
}

/** Split `total` across `n` buckets as evenly as possible, earlier buckets taking the remainder. */
export function splitEvenly(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => base + (i < total % n ? 1 : 0));
}

/** Typesense filter value; backticks can't be escaped, so they are dropped. */
function escapeValue(v: string): string {
  return '`' + v.replace(/`/g, '') + '`';
}

export function buildFeedPlan(
  profile: FeedProfile,
  opts: { limit: number; excludeIds: string[]; nowSec: number; maxAgeDays?: number },
): FeedPlan {
  const visaTotal = profile.needsVisa ? Math.round(opts.limit * VISA_SHARE) : 0;
  const roleQuota = splitEvenly(opts.limit - visaTotal, profile.roles.length);
  const visaQuota = splitEvenly(visaTotal, profile.roles.length);

  const streams: FeedStream[] = [
    ...profile.roles.map((role, i) => ({ role, visaOnly: false, perPage: roleQuota[i] })),
    ...profile.roles.map((role, i) => ({ role, visaOnly: true, perPage: visaQuota[i] })),
  ].filter((s) => s.perPage > 0);

  const baseFilters = [
    `date_posted:>=${opts.nowSec - (opts.maxAgeDays ?? EMAIL_MAX_AGE_DAYS) * 86400}`,
    'is_ghost_job:!=true',
    experienceFilter(profile.yearsOfExperience),
    opts.excludeIds.length ? `id:!=[${opts.excludeIds.map(escapeValue).join(',')}]` : null,
  ].filter((f): f is string => Boolean(f));

  const searches = streams.map((s) => ({
    collection: JOBS_ALIAS,
    ...FEED_QUERY_PARAMS,
    q: s.role,
    filter_by: [...baseFilters, ...(s.visaOnly ? ['sponsors_visa:=true'] : [])].join(' && '),
    sort_by: sortBy(profile.yearsOfExperience),
    per_page: s.perPage,
    page: 1,
  }));
  return { streams, searches };
}

/** Round-robin across streams. */
function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (list[i] !== undefined) out.push(list[i]);
  }
  return out;
}

/** Place `extra` at evenly spaced slots inside `main` (one after every `every - 1` main items). */
export function weave<T>(main: T[], extra: T[], every: number): T[] {
  if (!extra.length) return main;
  const out: T[] = [];
  let e = 0;
  for (const item of main) {
    out.push(item);
    if (out.length % every === every - 1 && e < extra.length) out.push(extra[e++]);
  }
  return out.concat(extra.slice(e));
}

const WORK_ARRANGEMENT: Record<string, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };

/** Typesense stores annual USD salaries; the index has no other currency. */
export function toDigestSourceJob(doc: Record<string, any>): DigestSourceJob {
  const min = typeof doc.salary_min_annual === 'number' ? doc.salary_min_annual : null;
  const max = typeof doc.salary_max_annual === 'number' ? doc.salary_max_annual : null;
  return {
    id: String(doc.id),
    job_title: doc.title ?? null,
    company_name: doc.company ?? null,
    location: doc.location_display ?? null,
    job_url: doc.job_url ?? null,
    ai_work_arrangement: WORK_ARRANGEMENT[doc.work_arrangement] ?? null,
    salary_min: min,
    salary_max: max,
    salary_currency: min !== null || max !== null ? 'USD' : null,
  };
}

/** Role streams interleaved round-robin, visa jobs woven in every 5th slot, deduped by id. */
export function assembleFeed(plan: FeedPlan, results: RawResult[]): DigestSourceJob[] {
  const docs = plan.streams.map((_, i) => (results[i]?.hits ?? []).map((h) => h.document));
  const main = roundRobin(docs.filter((_, i) => !plan.streams[i].visaOnly));
  const visa = roundRobin(docs.filter((_, i) => plan.streams[i].visaOnly));
  const ordered = weave(main, visa, Math.max(2, Math.round(1 / VISA_SHARE)));

  const seen = new Set<string>();
  const jobs: DigestSourceJob[] = [];
  for (const doc of ordered) {
    const id = String(doc.id);
    if (seen.has(id)) continue;
    seen.add(id);
    jobs.push(toDigestSourceJob(doc));
  }
  return jobs;
}
