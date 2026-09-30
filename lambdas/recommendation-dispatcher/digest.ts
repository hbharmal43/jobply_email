/**
 * Pure builder for the `daily_job_matches` Customer.io event payload.
 *
 * recommend_jobs_aws already ranks by similarity × freshness decay (7-day
 * half-life) on a 0–100 scale, so there is no extra dedupe or score cutoff
 * here — only jobs the user already applied to are dropped.
 */
import type { RecommendedJobRow } from './aws-rds';

export const EMAIL_JOB_COUNT = 5;
export const MIN_JOBS_TO_SEND = 3;
export const HEADLINE_COUNT = 14;

export interface ApplicationCounts { total: number; last7d: number; interviews: number }

export interface DigestJob {
  id: string;
  rank: number;
  title: string;
  company: string | null;
  location: string | null;
  work_arrangement: string | null;
  salary: string | null;
  match_pct: number;
  url: string;
}

export interface DigestPayload {
  date_label: string;
  jobs: DigestJob[];
  job_count: number;
  more_count: number;
  applied_total: number;
  applied_7d: number;
  interviews: number;
  headline_index: number;
  /** Highest annual salary among the emailed jobs, e.g. "$285K"; null if none list one. */
  top_salary: string | null;
  /** Title of the job carrying top_salary. */
  top_salary_title: string | null;
  /** Rotates daily; the template picks subject lines with `| modulo: 3` and `| modulo: 7`. */
  subject_index: number;
}

/**
 * recommend_jobs_aws scores are 0–100 (similarity × freshness decay) and may
 * arrive as numeric strings from pg. A heavily decayed score below 1 is still
 * on the 0–100 scale, so it is never rescaled as a fraction.
 */
export function toMatchPct(score: number | string | null): number | null {
  if (score === null || score === undefined || score === '') return null;
  const n = typeof score === 'string' ? Number(score) : score;
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

const CURRENCY: Record<string, string> = { USD: '$', $: '$', EUR: '€', '€': '€', GBP: '£', '£': '£' };

export function formatSalary(
  min: number | string | null,
  max: number | string | null,
  currency: string | null,
): string | null {
  const fmt = (v: number | string | null) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString('en-US') : null;
  };
  const lo = fmt(min);
  const hi = fmt(max);
  const code = (currency ?? '$').trim().toUpperCase();
  const symbol = CURRENCY[code] ?? `${code} `;
  if (lo && hi) return `${symbol}${lo} - ${symbol}${hi}`;
  if (lo) return `From ${symbol}${lo}`;
  if (hi) return `Up to ${symbol}${hi}`;
  return null;
}

/** Annual amounts only: values under 10,000 look hourly and would read oddly ("up to $45"). */
export function shortSalary(amount: number | string | null, currency: string | null): string | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 10_000) return null;
  const code = (currency ?? '$').trim().toUpperCase();
  const symbol = CURRENCY[code] ?? `${code} `;
  return `${symbol}${Math.round(n / 1000)}K`;
}

export function jobUrl(id: string, rank: number): string {
  return `https://jobply.ai/dashboard/jobs/${encodeURIComponent(id)}?utm_source=customerio&utm_medium=email&utm_campaign=daily_digest&utm_content=job_${rank}`;
}

export function dateLabel(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'short', day: 'numeric',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')}, ${get('month')} ${get('day')}`;
}

/** The day number advances by one each day, so consecutive days always differ. */
export function headlineIndex(userId: string, now: Date): number {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const day = Math.floor(now.getTime() / 86_400_000);
  return (day + hash) % HEADLINE_COUNT;
}

/** 84 = lcm(3, 7, 4): both subject pools change every day. Offset from headlineIndex. */
export function subjectIndex(userId: string, now: Date): number {
  let hash = 7;
  for (const ch of userId) hash = (hash * 131 + ch.charCodeAt(0)) >>> 0;
  const day = Math.floor(now.getTime() / 86_400_000);
  return (day + hash) % 84;
}

const clean = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

/** RDS values like "Remote Solely" become short pill labels. */
function workArrangementLabel(value: string | null | undefined): string | null {
  const v = clean(value);
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower.includes('hybrid')) return 'Hybrid';
  if (lower.includes('remote')) return 'Remote';
  if (/on-?site|in[- ]office|in[- ]person/.test(lower)) return 'On-site';
  return v;
}

export function buildDigest(input: {
  userId: string;
  jobs: RecommendedJobRow[];
  counts: ApplicationCounts;
  now: Date;
}): DigestPayload | null {
  const eligible = input.jobs
    .filter((job) => !job.is_applied)
    .map((job) => ({ job, pct: toMatchPct(job.match_score) }))
    .filter((x): x is { job: RecommendedJobRow; pct: number } => x.pct !== null);

  if (eligible.length < MIN_JOBS_TO_SEND) return null;

  const top = eligible.slice(0, EMAIL_JOB_COUNT);

  let topAmount = 0;
  let topSalary: string | null = null;
  let topSalaryTitle: string | null = null;
  for (const { job } of top) {
    const amount = Number(job.salary_max ?? job.salary_min ?? 0);
    const label = shortSalary(job.salary_max ?? job.salary_min, job.salary_currency);
    if (label && amount > topAmount) {
      topAmount = amount;
      topSalary = label;
      topSalaryTitle = clean(job.job_title);
    }
  }

  const jobs: DigestJob[] = top.map(({ job, pct }, i) => ({
    id: String(job.id),
    rank: i + 1,
    title: clean(job.job_title) ?? 'Open role',
    company: clean(job.company_name),
    location: clean(job.location),
    work_arrangement: workArrangementLabel(job.ai_work_arrangement),
    salary: formatSalary(job.salary_min, job.salary_max, job.salary_currency),
    match_pct: pct,
    url: jobUrl(String(job.id), i + 1),
  }));

  return {
    date_label: dateLabel(input.now),
    jobs,
    job_count: jobs.length,
    more_count: eligible.length - jobs.length,
    applied_total: input.counts.total,
    applied_7d: input.counts.last7d,
    interviews: input.counts.interviews,
    headline_index: headlineIndex(input.userId, input.now),
    top_salary: topSalary,
    top_salary_title: topSalaryTitle,
    subject_index: subjectIndex(input.userId, input.now),
  };
}
