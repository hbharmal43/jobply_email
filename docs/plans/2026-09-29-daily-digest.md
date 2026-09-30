# Daily Job Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every morning, send each eligible user a branded Customer.io email with their 5 freshest strong job matches, a motivation strip based on their application counts, and a subject-line A/B test.

**Architecture:** The existing recommendation dispatcher Lambda keeps doing the matching on RDS. Pure functions in a new `digest.ts` turn matches plus counts into an event payload. The handler records the per-day dedupe row in Supabase, then posts a `daily_job_matches` event to the Customer.io Track API. A stopped Customer.io campaign triggered by that event renders `emails/daily-digest/template.html`, split 50/50 on subject.

**Tech Stack:** TypeScript on Node 22 (Lambda runtime; Node 24 locally), AWS CDK, `pg` (RDS), `@supabase/supabase-js`, Customer.io Track API v1 and the `customerio` MCP tools, Liquid, and `node:test` via `tsx`.

**Spec:** `docs/specs/2026-09-29-daily-digest-design.md`. The approved visual reference is `emails/daily-digest/preview.html`.

> **Revision (2026-09-29, after reading `recommend_jobs_aws` on RDS):** The function already ranks by *similarity × freshness decay (7-day half-life)* on a 0–100 scale and returns only active jobs. So the **7-day email dedupe, the `MIN_MATCH_PCT` cutoff, the score-distribution check and the Supabase RPC migration are dropped.** New: exclude jobs the user already applied to (`is_applied`, returned by the function), and fetch 15 instead of 10. The rule "skip the user when fewer than 3 jobs remain" is kept. **Where a task below conflicts with this note, this note wins:** `buildDigest` takes no `recentlySentJobIds`/`minMatchPct`, Task 1 is tooling only, and Task 3 has no migration or `fetchRecentDigestJobIds`.

## Global Constraints

- Every link in the email has `target="_blank" rel="noopener"`.
- Brand voice uses "ply": "Ply this job →", "plies this week", "You miss 100% of the jobs you don't ply." Never mention pricing, plans, or limits. Never promise outcomes.
- Subject A: `{top title} at {top company} + {job_count - 1} more matches for you`. Subject B: `{job_count} fresh jobs to ply today`. Split 50/50.
- The email shows 5 jobs at most. Skip the user when fewer than 3 jobs remain after removing jobs they already applied to.
- Job links go to `https://jobply.ai/dashboard/jobs/{id}?utm_source=customerio&utm_medium=email&utm_campaign=daily_digest&utm_content=job_{rank}`.
- The footer reads `Jobply LLC · 1020 W Abram St, Arlington, TX 76013` and includes Privacy, Terms, and `{% unsubscribe_url %}`.
- Customer.io identifies profiles by the Supabase user UUID (profile attribute `id`). Workspace 231518, US region, Track API base `https://track.customer.io`.
- **Only read calls to Customer.io are allowed without the user's explicit OK.** Tasks 5 through 7 create things in Customer.io. The user approved building the campaign in a **stopped** state and testing on their own profile. Going live (Task 7) needs a fresh "go live" from the user.
- Commit directly on `master`. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never print secret values. Scripts may read the secret, but must only log key names and results.

## Review Focus

1. **No first name.** The user's own test profile has `first_name = null`. Every headline needs a clean no-name form, with no dangling comma and no ", ," fragments. Pinned in Task 4 Step 1 and Task 6 Step 2.
2. **Missing optional job fields.** Null salary, work arrangement, location or company must never render as "null" or leave an empty pill. Pinned in Task 2 (`buildDigest` output) and Task 4 (template guards).
3. **`match_score` scale unknown.** It could be 0–1 or 0–100, or a numeric string from `pg`. It must become an integer from 0 to 100, or `null`, in which case the job is excluded. Pinned in Task 2's `toMatchPct` tests.
4. **Reruns on the same day.** A second run must not send a second email. `schedule_email_job` returns `null` on a dedupe conflict, and the handler only sends when a new row was created. Pinned in Task 3 Step 1.
5. **Customer.io outage.** If the Track API returns non-2xx, the handler logs the error and moves to the next user without crashing the batch. The user misses that day's email, which is acceptable because the dedupe row is already written. Pinned in Task 3 Step 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `lambdas/recommendation-dispatcher/digest.ts` (new) | Pure: match % normalization, salary formatting, URLs, date label, headline rotation, and `buildDigest()` (dedupe, threshold, top 5). |
| `lambdas/recommendation-dispatcher/digest.test.ts` (new) | `node:test` unit tests for `digest.ts`. |
| `lambdas/recommendation-dispatcher/customerio.ts` (new) | `sendCustomerIoEvent()` using the Track API with Basic auth. |
| `lambdas/recommendation-dispatcher/customerio.test.ts` (new) | Tests with a fake `fetch`. |
| `lambdas/recommendation-dispatcher/aws-rds.ts` (modify) | Add `getApplicationCounts()`. |
| `lambdas/recommendation-dispatcher/handler.ts` (modify) | Wire recent-job lookup, counts, `buildDigest`, dedupe row, and event send. Add a `dryRun` option. |
| `database/migrations/20260929000000_recent_digest_job_ids.sql` (new) | RPC `get_recent_digest_job_ids`. |
| `scripts/run-dispatcher.ts` (new) | Local runner: `--user <uuid>` and `--dry-run`. |
| `emails/daily-digest/template.html` (new) | Production HTML plus Liquid for Customer.io. |
| `package.json` (modify) | Add `tsx`, plus `test` and `dispatch:local` scripts. |
| `CLAUDE.md`, `docs/operations.md` (modify) | Registry, runbook, Customer.io IDs. |

---

### Task 1: Test tooling and a baseline of the RDS match-score distribution

**Files:**
- Modify: `package.json`
- Create: `scripts/rds-score-stats.ts` (throwaway, deleted in Step 5)

**Interfaces:**
- Produces: `npm test` runs `node --import tsx --test lambdas/**/*.test.ts`. It also produces the chosen `MIN_MATCH_PCT` value, recorded in the spec.

- [ ] **Step 1: Install tsx and add scripts**

Run: `npm install --save-dev tsx@^4`

Edit `package.json` `"scripts"`:
```json
"build": "tsc --noEmit",
"test": "node --import tsx --test \"lambdas/**/*.test.ts\"",
"dispatch:local": "tsx scripts/run-dispatcher.ts",
"deploy": "cdk deploy",
"diff": "cdk diff",
"synth": "cdk synth"
```
Add `"scripts/**/*.ts"` to `tsconfig.json` `"include"`.

- [ ] **Step 2: Write the score-distribution script**

`scripts/rds-score-stats.ts`:
```ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createClient } from '@supabase/supabase-js';
import { getRdsPool, recommendJobsFromAws } from '../lambdas/recommendation-dispatcher/aws-rds';

async function main() {
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: 'jobply-email/development/supabase' }));
  const secret = JSON.parse(res.SecretString ?? '{}');
  const supabase = createClient(secret.url, secret.serviceKey, { auth: { persistSession: false } });
  const { data: emb } = await supabase.from('user_embeddings').select('user_id, embedding').limit(20);
  const pool = getRdsPool(secret.awsRdsUrl);
  const scores: number[] = [];
  for (const row of emb ?? []) {
    const e = typeof row.embedding === 'string' ? row.embedding : JSON.stringify(row.embedding);
    const jobs = await recommendJobsFromAws(pool, { userId: row.user_id, embedding: e, limit: 10, yearsOfExperience: null });
    for (const j of jobs) if (j.match_score != null) scores.push(Number(j.match_score));
  }
  scores.sort((a, b) => a - b);
  const q = (p: number) => scores[Math.floor(p * (scores.length - 1))];
  console.log({ n: scores.length, min: scores[0], p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), max: scores[scores.length - 1] });
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run it**

Run: `npx tsx scripts/rds-score-stats.ts`
Expected: one object with `n > 0` and the quantiles. If `max <= 1`, scores are on a 0–1 scale.

- [ ] **Step 4: Choose `MIN_MATCH_PCT`**

Rule: `MIN_MATCH_PCT` is the p25 of the observed scores in percent, rounded down to the nearest 5 and clamped to [50, 80]. Write the value and the stats into the spec's "Open items" as resolved. Report the numbers to the user in the task summary.

- [ ] **Step 5: Delete the throwaway script and commit**

```bash
rm scripts/rds-score-stats.ts
git add package.json package-lock.json tsconfig.json docs/specs/2026-09-29-daily-digest-design.md
git commit -m "Add tsx test tooling; record digest MIN_MATCH_PCT from RDS scores

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `digest.ts`, the pure payload builder

**Files:**
- Create: `lambdas/recommendation-dispatcher/digest.ts`
- Test: `lambdas/recommendation-dispatcher/digest.test.ts`

**Interfaces:**
- Consumes: `RecommendedJobRow` from `./aws-rds` (`id, job_title, company_name, location, job_url, ai_work_arrangement, salary_min, salary_max, salary_currency, match_score`).
- Produces:
  - `EMAIL_JOB_COUNT = 5`, `MIN_JOBS_TO_SEND = 3`, `HEADLINE_COUNT = 14`
  - `interface ApplicationCounts { total: number; last7d: number; interviews: number }`
  - `interface DigestJob { id: string; rank: number; title: string; company: string | null; location: string | null; work_arrangement: string | null; salary: string | null; match_pct: number; url: string }`
  - `interface DigestPayload { date_label: string; jobs: DigestJob[]; job_count: number; more_count: number; applied_total: number; applied_7d: number; interviews: number; headline_index: number }`
  - `toMatchPct(score: number | string | null): number | null`
  - `formatSalary(min, max, currency): string | null`
  - `jobUrl(id: string, rank: number): string`
  - `dateLabel(now: Date): string` (America/Chicago, e.g. `"Tuesday, Sep 29"`)
  - `headlineIndex(userId: string, now: Date): number`
  - `buildDigest(input: { userId: string; jobs: RecommendedJobRow[]; recentlySentJobIds: Set<string>; counts: ApplicationCounts; now: Date; minMatchPct: number }): DigestPayload | null`

- [ ] **Step 1: Write the failing tests**

`lambdas/recommendation-dispatcher/digest.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMatchPct, formatSalary, jobUrl, dateLabel, headlineIndex, buildDigest, HEADLINE_COUNT,
} from './digest';
import type { RecommendedJobRow } from './aws-rds';

const row = (id: string, score: number | string | null, extra: Partial<RecommendedJobRow> = {}): RecommendedJobRow => ({
  id, job_title: `Title ${id}`, company_name: `Co ${id}`, location: 'Austin, TX', job_url: null,
  ai_work_arrangement: 'Remote', salary_min: null, salary_max: null, salary_currency: null, match_score: score, ...extra,
});
const counts = { total: 12, last7d: 4, interviews: 0 };
const now = new Date('2026-09-29T14:00:00Z');

test('toMatchPct handles 0-1, 0-100, strings, and junk', () => {
  assert.equal(toMatchPct(0.923), 92);
  assert.equal(toMatchPct(87.6), 88);
  assert.equal(toMatchPct('0.81'), 81);
  assert.equal(toMatchPct(1), 100);
  assert.equal(toMatchPct(140), 100);
  assert.equal(toMatchPct(-3), 0);
  assert.equal(toMatchPct(null), null);
  assert.equal(toMatchPct('abc'), null);
});

test('formatSalary', () => {
  assert.equal(formatSalary(120000, 150000, 'USD'), '$120,000 - $150,000');
  assert.equal(formatSalary('95000', null, null), 'From $95,000');
  assert.equal(formatSalary(null, 80000, 'EUR'), 'Up to €80,000');
  assert.equal(formatSalary(null, null, 'USD'), null);
});

test('jobUrl carries UTM and rank', () => {
  assert.equal(
    jobUrl('abc-1', 3),
    'https://jobply.ai/dashboard/jobs/abc-1?utm_source=customerio&utm_medium=email&utm_campaign=daily_digest&utm_content=job_3',
  );
});

test('dateLabel uses America/Chicago', () => {
  assert.equal(dateLabel(new Date('2026-09-30T03:00:00Z')), 'Tuesday, Sep 29');
});

test('headlineIndex is in range and never repeats on consecutive days', () => {
  for (const user of ['u1', 'f001d538-7f4a-4c4b-abf5-0534324a4f5c']) {
    let prev = -1;
    for (let d = 0; d < 30; d++) {
      const i = headlineIndex(user, new Date(now.getTime() + d * 86_400_000));
      assert.ok(i >= 0 && i < HEADLINE_COUNT);
      assert.notEqual(i, prev);
      prev = i;
    }
  }
});

test('buildDigest drops recent jobs and weak matches, keeps order, caps at 5', () => {
  const jobs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => row(id, 0.95 - i * 0.02));
  jobs.push(row('weak', 0.2));
  const p = buildDigest({ userId: 'u1', jobs, recentlySentJobIds: new Set(['b']), counts, now, minMatchPct: 60 })!;
  assert.deepEqual(p.jobs.map((j) => j.id), ['a', 'c', 'd', 'e', 'f']);
  assert.deepEqual(p.jobs.map((j) => j.rank), [1, 2, 3, 4, 5]);
  assert.equal(p.job_count, 5);
  assert.equal(p.more_count, 2); // g, h remain; 'weak' excluded
  assert.equal(p.jobs[1].url.endsWith('utm_content=job_2'), true);
  assert.equal(p.applied_7d, 4);
});

test('buildDigest returns null below MIN_JOBS_TO_SEND', () => {
  const jobs = [row('a', 0.9), row('b', 0.9), row('c', 0.3)];
  assert.equal(buildDigest({ userId: 'u1', jobs, recentlySentJobIds: new Set(), counts, now, minMatchPct: 60 }), null);
});

test('buildDigest excludes null scores and never emits "null" strings', () => {
  const jobs = [row('a', 0.9, { company_name: null, location: null, ai_work_arrangement: null }), row('b', 0.8), row('c', 0.7), row('d', null)];
  const p = buildDigest({ userId: 'u1', jobs, recentlySentJobIds: new Set(), counts, now, minMatchPct: 60 })!;
  assert.deepEqual(p.jobs.map((j) => j.id), ['a', 'b', 'c']);
  assert.equal(p.jobs[0].company, null);
  assert.equal(p.jobs[0].location, null);
  assert.equal(p.jobs[0].salary, null);
  assert.ok(!JSON.stringify(p).includes('"null"'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module './digest'`.

- [ ] **Step 3: Implement `digest.ts`**

```ts
import type { RecommendedJobRow } from './aws-rds';

export const EMAIL_JOB_COUNT = 5;
export const MIN_JOBS_TO_SEND = 3;
export const HEADLINE_COUNT = 14;

export interface ApplicationCounts { total: number; last7d: number; interviews: number }

export interface DigestJob {
  id: string; rank: number; title: string; company: string | null; location: string | null;
  work_arrangement: string | null; salary: string | null; match_pct: number; url: string;
}

export interface DigestPayload {
  date_label: string; jobs: DigestJob[]; job_count: number; more_count: number;
  applied_total: number; applied_7d: number; interviews: number; headline_index: number;
}

/** RDS scores may be 0–1 or 0–100 and may arrive as numeric strings from pg. */
export function toMatchPct(score: number | string | null): number | null {
  if (score === null || score === undefined || score === '') return null;
  const n = typeof score === 'string' ? Number(score) : score;
  if (!Number.isFinite(n)) return null;
  const pct = n <= 1 ? n * 100 : n;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

const CURRENCY: Record<string, string> = { USD: '$', $: '$', EUR: '€', '€': '€', GBP: '£', '£': '£' };

export function formatSalary(
  min: number | string | null, max: number | string | null, currency: string | null,
): string | null {
  const fmt = (v: number | string | null) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString('en-US') : null;
  };
  const lo = fmt(min); const hi = fmt(max);
  const c = CURRENCY[(currency ?? '$').trim().toUpperCase()] ?? `${(currency ?? '').trim()} `;
  if (lo && hi) return `${c}${lo} - ${c}${hi}`;
  if (lo) return `From ${c}${lo}`;
  if (hi) return `Up to ${c}${hi}`;
  return null;
}

export function jobUrl(id: string, rank: number): string {
  return `https://jobply.ai/dashboard/jobs/${encodeURIComponent(id)}?utm_source=customerio&utm_medium=email&utm_campaign=daily_digest&utm_content=job_${rank}`;
}

export function dateLabel(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'short', day: 'numeric',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')}, ${get('month')} ${get('day')}`;
}

/** Day number advances by 1 each day, so consecutive days always differ (mod 14 > 1). */
export function headlineIndex(userId: string, now: Date): number {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const day = Math.floor(now.getTime() / 86_400_000);
  return (day + h) % HEADLINE_COUNT;
}

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export function buildDigest(input: {
  userId: string; jobs: RecommendedJobRow[]; recentlySentJobIds: Set<string>;
  counts: ApplicationCounts; now: Date; minMatchPct: number;
}): DigestPayload | null {
  const fresh = input.jobs
    .filter((j) => !input.recentlySentJobIds.has(String(j.id)))
    .map((j) => ({ j, pct: toMatchPct(j.match_score) }))
    .filter((x): x is { j: RecommendedJobRow; pct: number } => x.pct !== null && x.pct >= input.minMatchPct);

  if (fresh.length < MIN_JOBS_TO_SEND) return null;

  const top = fresh.slice(0, EMAIL_JOB_COUNT);
  const jobs: DigestJob[] = top.map(({ j, pct }, i) => ({
    id: String(j.id),
    rank: i + 1,
    title: clean(j.job_title) ?? 'Open role',
    company: clean(j.company_name),
    location: clean(j.location),
    work_arrangement: clean(j.ai_work_arrangement),
    salary: formatSalary(j.salary_min, j.salary_max, j.salary_currency),
    match_pct: pct,
    url: jobUrl(String(j.id), i + 1),
  }));

  return {
    date_label: dateLabel(input.now),
    jobs,
    job_count: jobs.length,
    more_count: fresh.length - jobs.length,
    applied_total: input.counts.total,
    applied_7d: input.counts.last7d,
    interviews: input.counts.interviews,
    headline_index: headlineIndex(input.userId, input.now),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all `digest.test.ts` tests PASS. Then run `npm run build`, expecting no errors.

- [ ] **Step 5: Commit**

```bash
git add lambdas/recommendation-dispatcher/digest.ts lambdas/recommendation-dispatcher/digest.test.ts
git commit -m "Add pure daily-digest payload builder with tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Customer.io client, RDS counts, recent-jobs RPC, and handler wiring

**Files:**
- Create: `lambdas/recommendation-dispatcher/customerio.ts`, `lambdas/recommendation-dispatcher/customerio.test.ts`
- Create: `database/migrations/20260929000000_recent_digest_job_ids.sql`
- Create: `scripts/run-dispatcher.ts`
- Modify: `lambdas/recommendation-dispatcher/aws-rds.ts` (append `getApplicationCounts`)
- Modify: `lambdas/recommendation-dispatcher/handler.ts` (`DispatcherSecret`, `JOB_RECOMMENDATIONS_LIMIT`, `scanJobRecommendations`, `handler`)

**Interfaces:**
- Consumes: `buildDigest`, `ApplicationCounts`, `DigestPayload` from Task 2.
- Produces:
  - `sendCustomerIoEvent(creds: { siteId: string; apiKey: string }, customerId: string, name: string, data: object, fetchImpl?: typeof fetch): Promise<void>`, which throws `Error` on non-2xx.
  - `getApplicationCounts(pool: Pool, userIds: string[]): Promise<Map<string, ApplicationCounts>>`
  - An RPC `public.get_recent_digest_job_ids(p_user_ids uuid[], p_since timestamptz, p_environment text) returns table(user_id uuid, job_id text)`
  - `handler(event?: { dryRun?: boolean; userIds?: string[] }, context?)`. In dry-run mode it logs payloads and writes nothing.
  - `npm run dispatch:local -- --user <uuid> [--dry-run]`

- [ ] **Step 1: Write the failing client tests**

`lambdas/recommendation-dispatcher/customerio.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendCustomerIoEvent } from './customerio';

test('posts the event with Basic auth to the customer path', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fake = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(null, { status: 200 }); }) as typeof fetch;
  await sendCustomerIoEvent({ siteId: 'site', apiKey: 'key' }, 'user-1', 'daily_job_matches', { job_count: 5 }, fake);
  assert.equal(seen!.url, 'https://track.customer.io/api/v1/customers/user-1/events');
  assert.equal(seen!.init.method, 'POST');
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('site:key').toString('base64')}`);
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { name: 'daily_job_matches', data: { job_count: 5 } });
});

test('throws on non-2xx so the caller can log and continue', async () => {
  const fake = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  await assert.rejects(sendCustomerIoEvent({ siteId: 's', apiKey: 'k' }, 'u', 'e', {}, fake), /500/);
});
```

Run: `npm test`. Expected: FAIL, `Cannot find module './customerio'`.

- [ ] **Step 2: Implement `customerio.ts`**

```ts
export interface CustomerIoCreds { siteId: string; apiKey: string }

/** Customer.io Track API v1 (US region). customerId is the Supabase user UUID. */
export async function sendCustomerIoEvent(
  creds: CustomerIoCreds, customerId: string, name: string, data: object,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`https://track.customer.io/api/v1/customers/${encodeURIComponent(customerId)}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.siteId}:${creds.apiKey}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) throw new Error(`Customer.io track ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
```

Run: `npm test`. Expected: PASS.

- [ ] **Step 3: Add `getApplicationCounts` to `aws-rds.ts`**

Append:
```ts
import type { ApplicationCounts } from './digest';

/** Application counts per user from RDS `applications` (source of truth). */
export async function getApplicationCounts(pool: Pool, userIds: string[]): Promise<Map<string, ApplicationCounts>> {
  const counts = new Map<string, ApplicationCounts>();
  if (userIds.length === 0) return counts;
  const result = await pool.query<{ user_id: string; total: number; last7d: number; interviews: number }>(
    `SELECT user_id::text AS user_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS last7d,
            COUNT(*) FILTER (WHERE status = 'interview')::int AS interviews
       FROM applications
      WHERE user_id::text = ANY($1::text[])
      GROUP BY user_id`,
    [userIds],
  );
  for (const r of result.rows) counts.set(r.user_id, { total: r.total, last7d: r.last7d, interviews: r.interviews });
  return counts;
}
```
Move the new `import type` to the top of the file with the other imports.

- [ ] **Step 4: Write the RPC migration**

`database/migrations/20260929000000_recent_digest_job_ids.sql`:
```sql
-- Job IDs included in a user's digest over a recent window, so the daily
-- digest never repeats a job within 7 days. Reads the payload snapshot that
-- the recommendation dispatcher writes via schedule_email_job.
create or replace function public.get_recent_digest_job_ids(
  p_user_ids    uuid[],
  p_since       timestamptz,
  p_environment text default 'production'
) returns table (user_id uuid, job_id text)
language sql
stable
security definer
set search_path = email_internal, public
as $$
  select j.user_id, job ->> 'id' as job_id
    from email_internal.email_jobs j
   cross join lateral jsonb_array_elements(coalesce(j.payload -> 'jobs', '[]'::jsonb)) as job
   where j.journey_key = 'job_recommendations'
     and j.environment = p_environment
     and j.created_at >= p_since
     and j.user_id = any(p_user_ids)
     and job ->> 'id' is not null;
$$;

revoke all on function public.get_recent_digest_job_ids(uuid[], timestamptz, text) from public, anon, authenticated;
grant execute on function public.get_recent_digest_job_ids(uuid[], timestamptz, text) to service_role;
```

**The user applies this SQL** in the Supabase SQL editor. Hand them the file path and wait for "applied". Verify with a dry-run call in Step 7.

- [ ] **Step 5: Wire the handler**

In `handler.ts`:
1. Change `const JOB_RECOMMENDATIONS_LIMIT = 10;` to `25`. After dedupe we still need 5 strong jobs, so the dispatcher asks RDS for more.
2. Add `const MIN_MATCH_PCT = Number(process.env.MIN_MATCH_PCT ?? <value from Task 1>);` next to `SCAN_BATCH_SIZE`.
3. Extend `DispatcherSecret` with `cioSiteId?: string; cioApiKey?: string;`.
4. Add these imports: `import { buildDigest } from './digest';`, `import { sendCustomerIoEvent } from './customerio';`, and `getApplicationCounts` from `./aws-rds`.
5. Add this helper above `scanJobRecommendations`:
```ts
async function fetchRecentDigestJobIds(supabase: SupabaseClient, userIds: string[], since: Date): Promise<Map<string, Set<string>>> {
  const recent = new Map<string, Set<string>>();
  for (const ids of chunk(userIds, CANDIDATE_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase.rpc('get_recent_digest_job_ids', {
      p_user_ids: ids, p_since: since.toISOString(), p_environment: ENVIRONMENT,
    });
    if (error) throw new Error(`get_recent_digest_job_ids failed: ${error.message}`);
    for (const r of (data ?? []) as { user_id: string; job_id: string }[]) {
      if (!recent.has(r.user_id)) recent.set(r.user_id, new Set());
      recent.get(r.user_id)!.add(r.job_id);
    }
  }
  return recent;
}
```
6. Change the signature to `scanJobRecommendations(supabase: SupabaseClient, opts: { dryRun: boolean; userIds?: string[] }): Promise<number>`. Use `opts.userIds` in place of `TEST_USER_IDS_ENV` when provided (keep the env fallback). After the existing `Promise.all([fetchUserVectors…, fetchYearsOfExperience…])`, also load:
```ts
const now = new Date();
const [recentJobIds, applicationCounts] = await Promise.all([
  fetchRecentDigestJobIds(supabase, userIds, new Date(now.getTime() - 7 * 86_400_000)),
  getApplicationCounts(pool, userIds),
]);
const { cioSiteId, cioApiKey } = await loadSecret();
if (!opts.dryRun && (!cioSiteId || !cioApiKey)) throw new Error('Secret missing cioSiteId/cioApiKey');
```
(Move `const pool = await getJobsPool();` above this block.)
7. Replace everything from `if (jobs.length === 0) {` to the end of the loop body with:
```ts
    const digest = buildDigest({
      userId: candidate.user_id,
      jobs,
      recentlySentJobIds: recentJobIds.get(candidate.user_id) ?? new Set(),
      counts: applicationCounts.get(candidate.user_id) ?? { total: 0, last7d: 0, interviews: 0 },
      now,
      minMatchPct: MIN_MATCH_PCT,
    });

    if (opts.dryRun) {
      console.log('dry run digest', { userId: candidate.user_id, digest });
      continue;
    }

    if (!digest) {
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
      p_payload: digest,
      p_environment: ENVIRONMENT,
    });
    if (rpcError) {
      console.error('schedule_email_job (job_recommendations) failed', { userId: candidate.user_id, error: rpcError });
      continue;
    }
    await markRecommendationCandidateScanned(supabase, candidate.user_id, todayStr);
    // null jobId = dedupe conflict: this user already has today's digest.
    if (!jobId) continue;

    try {
      await sendCustomerIoEvent({ siteId: cioSiteId!, apiKey: cioApiKey! }, candidate.user_id, 'daily_job_matches', digest);
      enqueued++;
    } catch (sendError) {
      // The dedupe row is written, so the user misses today rather than getting a duplicate.
      console.error('Customer.io event failed', { userId: candidate.user_id, error: String(sendError) });
    }
```
8. Change `handler` to accept `event?: { dryRun?: boolean; userIds?: string[] }`. Pass it through with `scanJobRecommendations(supabase, { dryRun: !!event?.dryRun, userIds: event?.userIds })`. Let `event?.dryRun` bypass the `PRODUCTION_MODE` pause, because a dry run writes nothing.
9. Update the header doc comment: add `cioSiteId`/`cioApiKey` to the secret, add the `MIN_MATCH_PCT` env var, and state that delivery is a `daily_job_matches` Track event.

- [ ] **Step 6: Local runner**

`scripts/run-dispatcher.ts`:
```ts
// Usage: npm run dispatch:local -- --user <uuid> [--user <uuid>] [--dry-run]
// Real (non-dry) runs send real Customer.io events. Only use your own user ID.
process.env.SUPABASE_SECRET_ID ??= 'jobply-email/development/supabase';
process.env.ENVIRONMENT ??= 'production';
process.env.PRODUCTION_MODE = 'true';
const args = process.argv.slice(2);
const userIds = args.flatMap((a, i) => (a === '--user' ? [args[i + 1]] : []));
const dryRun = args.includes('--dry-run');
if (userIds.length === 0) { console.error('pass at least one --user <uuid>'); process.exit(2); }
const { handler } = await import('../lambdas/recommendation-dispatcher/handler');
await handler({ dryRun, userIds }, {});
process.exit(0);
```

- [ ] **Step 7: Verify**

Run: `npm test`, expecting all PASS. Run `npm run build`, expecting no errors.
After the user confirms the migration is applied, run:
`npm run dispatch:local -- --user f001d538-7f4a-4c4b-abf5-0534324a4f5c --dry-run`
Expected: a `dry run digest` log that shows either `digest: null` with a clear reason (fewer than 3 strong matches, or no embedding) or a payload with `jobs.length` between 3 and 5. There should be no RPC errors and no Customer.io call. Save the payload JSON to the scratchpad for Task 6.

- [ ] **Step 8: Commit**

```bash
git add lambdas/recommendation-dispatcher scripts/run-dispatcher.ts database/migrations/20260929000000_recent_digest_job_ids.sql
git commit -m "Send daily_job_matches to Customer.io with 7-day dedupe and RDS application counts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `emails/daily-digest/template.html` (Liquid)

**Files:**
- Create: `emails/daily-digest/template.html`

**Interfaces:**
- Consumes: the `event.*` fields from `DigestPayload`, plus `customer.first_name`.
- Produces: the HTML body used in Task 5. The subject lines live on the Customer.io actions, not in this file.

- [ ] **Step 1: Write the headline table (Liquid `case` on `event.headline_index`)**

Each index has a with-name form (the name wrapped in the highlighter span `NAME`) and a no-name form:

| # | With name | No name |
|---|---|---|
| 0 | NAME, did you ply today? 👀 | Did you ply today? 👀 |
| 1 | Job market's rough. You're tougher, NAME 💪 | Job market's rough. You're tougher 💪 |
| 2 | We know it's brutal out there, NAME. 10 more plies this week. You've got this. | We know it's brutal out there. 10 more plies this week. You've got this. |
| 3 | NAME, 1 ply before lunch? 🍜 | 1 ply before lunch? 🍜 |
| 4 | 5 plies today, NAME. Future you says thanks 🙏 | 5 plies today. Future you says thanks 🙏 |
| 5 | Rejections are just redirects, NAME. Ply again 🔁 | Rejections are just redirects. Ply again 🔁 |
| 6 | Your offer letter won't ply itself, NAME 😤 | Your offer letter won't ply itself 😤 |
| 7 | NAME, your next job is in here. Ply it 🎯 | Your next job is in here. Ply it 🎯 |
| 8 | Main character energy only, NAME. Ply it ✨ | Main character energy only. Ply it ✨ |
| 9 | NAME, the market's tough. Consistency is tougher 📈 | The market's tough. Consistency is tougher 📈 |
| 10 | Not every ply lands. Every ply counts, NAME. | Not every ply lands. Every ply counts. |
| 11 | NAME, new week. Offer letter loading ⏳ | New week. Offer letter loading ⏳ |
| 12 | Weekend drop: 5 fresh roles to ply, NAME 🔥 | Weekend drop: 5 fresh roles to ply 🔥 |
| 13 | Just a few more plies, NAME. That's how it happens 🍀 | Just a few more plies. That's how it happens 🍀 |

Liquid preamble at the top of `<body>`:
```liquid
{% assign fname = customer.first_name | strip %}
{% capture NAME %}<span style="background:linear-gradient(180deg,transparent 60%,#ffde59 60%);padding:0 3px;">{{ fname | escape }}</span>{% endcapture %}
{% assign has_name = false %}{% if fname != blank %}{% assign has_name = true %}{% endif %}
```
Each `when` branch: `{% when 0 %}{% if has_name %}{{ NAME }}, did you ply today? 👀{% else %}Did you ply today? 👀{% endif %}`.

- [ ] **Step 2: Build the rest of the body from `preview.html`**

Copy the email table from `emails/daily-digest/preview.html` (from `<table role="presentation" width="100%"` to its closing tag), then apply:
- Wrap it in the same `<head>` as `emails/welcome/template.html`: color-scheme light, fonts link, and the mobile `@media` with `.px`/`.h1`.
- Date: `{{ event.date_label }}`, uppercased in the header strip with `| upcase`.
- Subline: `{{ event.job_count }} fresh roles that fit you. <b style="color:#0A0A0A;">You miss 100% of the jobs you don't ply.</b>`
- Motivation strip: one `{% if event.interviews > 0 %}…{% elsif event.applied_7d > 0 %}…{% elsif event.applied_total == 0 %}…{% else %}…{% endif %}`, containing the four tables from the preview, with the numbers replaced by `{{ event.interviews }}` and `{{ event.applied_7d }}`. Remove the `m`/`m-*` classes.
- GIF `src`: the Customer.io asset URL from Task 5 Step 1. Until then use `https://jobply.ai/favicon.ico` as a stand-in and mark it with an HTML comment `<!-- GIF_URL -->` so Task 5 replaces it.
- Job cards: replace the JS-built cards with:
```liquid
{% for job in event.jobs %}
<!-- card markup from preview; substitutions: -->
<!-- initial: {{ job.company | default: job.title | slice: 0 | upcase }} -->
<!-- company line only if job.company != blank -->
<!-- match pill: {{ job.match_pct }}% match -->
<!-- title + button href: {{ job.url }} with target="_blank" rel="noopener" -->
<!-- location line only if job.location != blank -->
<!-- work_arrangement pill only if job.work_arrangement != blank; salary pill only if job.salary != blank -->
{% endfor %}
```
(Write the full card HTML inline. The comments above only list the substitutions; they are not the markup.)
- "See more" button: wrap in `{% if event.more_count > 0 %}` and set the label to `See {{ event.more_count }} more matches in Jobply &rarr;`.
- Check-in links: `https://jobply.ai/dashboard/jobs/recommended?utm_source=customerio&utm_medium=email&utm_campaign=daily_digest&utm_content=mood_rough`, `…mood_meh`, and `…mood_fire`, all with `target="_blank" rel="noopener"`.
- Footer unsubscribe link: `{% unsubscribe_url %}`.
- Escape all event strings: `{{ job.title | escape }}`, `{{ job.company | escape }}`, `{{ job.location | escape }}`.

- [ ] **Step 3: Static checks**

Run:
```bash
grep -c 'target="_blank"' emails/daily-digest/template.html
grep -nE "Sarah|Stripe|JOB_ID|<script" emails/daily-digest/template.html
```
Expected: the first count is at least 9 (logo, 5 cards × 1 or more, see-more, 3 moods, privacy, terms, unsubscribe). The second grep returns **no matches**.

- [ ] **Step 4: Commit**

```bash
git add emails/daily-digest/template.html
git commit -m "Add Customer.io Liquid template for the daily digest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Customer.io campaign, built stopped

**Files:**
- Modify: `emails/daily-digest/template.html` (the GIF URL)

**Interfaces:**
- Consumes: `template.html` from Task 4, `emails/daily-digest/assets/progress.gif`.
- Produces: the campaign ID, the split action ID, variant A/B action IDs and Design Studio node IDs. All go into `CLAUDE.md` in Task 7.

Before any call, read these skills: `cio_skills_read fly-api/automations.md`, `fly-api/automation_triggers.md`, `fly-api/ab_tests.md`, `design-studio/journeys.md`, and `fly-api/assets.md`. **Dry-run every write first.**

- [ ] **Step 1: Upload the GIF asset** by following `fly-api/assets.md`. Replace the `<!-- GIF_URL -->` stand-in `src` with the returned public URL. Check it with `curl -s -o /dev/null -w "%{http_code}" <url>` (expect `200`).

- [ ] **Step 2: Create the campaign.** Name it "Daily Job Digest", with an event trigger on `daily_job_matches`. Add one email action. Leave the campaign **not started**. Set `from_identity_id: 2` (hello@) and `reply_to_identity_id: 1` (hasnain@).

- [ ] **Step 3: Create the Design Studio email.** POST `/design_studio/emails` with name "Daily Job Digest", HTML from `template.html`, the envelope from Step 2, preheader `Your picks for {{ event.date_label }}.`, and subject A:
`{{ event.jobs[0].title }} at {{ event.jobs[0].company }} + {{ event.job_count | minus: 1 }} more matches for you`.
Link it to the email action, then publish.

- [ ] **Step 4: Split into A/B.** POST `/actions/<email action id>/test` with `type: randomized`. Find the variant-B Design Studio node through `ds/nodes/<id>/journeys`. Set its subject to `{{ event.job_count }} fresh jobs to ply today`, rename it "Daily Job Digest - variant B", and publish it. Set the allocations to `[50, 50]` and `split_state: "running"`. The campaign itself stays stopped.

- [ ] **Step 5: Verify.** GET the campaign and confirm: the state is not running, the trigger is `daily_job_matches`, the allocations are `[50,50]`, and the two subjects match the Global Constraints.

- [ ] **Step 6: Commit the GIF URL change**

```bash
git add emails/daily-digest/template.html
git commit -m "Point daily digest GIF at Customer.io asset

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end test on the user's own profile only

**Interfaces:**
- Consumes: the dry-run payload from Task 3 Step 7 and the variant node IDs from Task 5.

- [ ] **Step 1: Test-send both variants with the real payload.** `POST /verify/email_template` with `node_id` = variant A, `event_data` = the saved dry-run digest, and `prepend_test: true`. Leave out `to` (it defaults to the user's own address). Repeat with variant B. Expected: `accepted: true`, `lax_render: false`, and subjects that match A and B.

If the dry run returned `digest: null` for the user's profile, use this fixture instead. It exercises null fields:
```json
{"date_label":"Tuesday, Sep 29","job_count":3,"more_count":0,"applied_total":0,"applied_7d":0,"interviews":0,"headline_index":2,
 "jobs":[{"id":"t1","rank":1,"title":"Data Analyst","company":"Acme","location":"Austin, TX","work_arrangement":"Remote","salary":"$90,000 - $110,000","match_pct":91,"url":"https://jobply.ai/dashboard/jobs/t1?utm_source=customerio&utm_medium=email&utm_campaign=daily_digest&utm_content=job_1"},
         {"id":"t2","rank":2,"title":"BI Analyst","company":null,"location":null,"work_arrangement":null,"salary":null,"match_pct":84,"url":"https://jobply.ai/dashboard/jobs/t2?utm_source=customerio&utm_medium=email&utm_campaign=daily_digest&utm_content=job_2"},
         {"id":"t3","rank":3,"title":"Analytics Engineer","company":"Globex","location":"Remote, US","work_arrangement":"Hybrid","salary":"From $120,000","match_pct":80,"url":"https://jobply.ai/dashboard/jobs/t3?utm_source=customerio&utm_medium=email&utm_campaign=daily_digest&utm_content=job_3"}]}
```

- [ ] **Step 2: No-name check.** The user's profile has no `first_name`. Confirm the rendered subject and headline contain no `, ,`, no leading comma, and no empty highlighter span. Send one extra test with `variables: {"customer": {"first_name": "Hasnain"}}` to confirm the name form too.

- [ ] **Step 3: Hand over.** Tell the user the three test emails are in their inbox, list what to check (Gmail web and phone, GIF plays, "Ply this job" opens the right job in a new tab, mood links, unsubscribe), and **stop**. Wait for their verdict.

---

### Task 7: Go live (only after the user says "go live")

- [ ] **Step 1: Start the campaign** by following `fly-api/automations.md` (activate or start). GET it and confirm `state: running`.

- [ ] **Step 2: First real send, to the user only.** Run `npm run dispatch:local -- --user f001d538-7f4a-4c4b-abf5-0534324a4f5c` (not a dry run). Expected log: one Customer.io event sent. Then confirm that the Customer.io activity log (`/logs?customer_id=f001d538-…&type=event`) shows `daily_job_matches`, followed by a sent email.

- [ ] **Step 3: Deploy with the schedule on.** Run `npx cdk diff -c env=development -c enableDispatch=true --no-change-set` and show the diff to the user. After they confirm, run `npx cdk deploy -c env=development -c enableDispatch=true --require-approval never`. Add `MIN_MATCH_PCT` to the Lambda environment in `infra/email-stack.ts` beforehand, and put the value in `cdk.json` context as `minMatchPct`.

- [ ] **Step 4: Docs and commit.** Update the `CLAUDE.md` registry row for the digest: campaign, split and variant IDs, subjects, live date, and the metrics endpoint. Update `docs/operations.md` with the `dispatch:local` usage, the `MIN_MATCH_PCT` meaning, and how to pause (`enableDispatch=false`, then stop the campaign).
```bash
git add CLAUDE.md docs/operations.md infra/email-stack.ts infra/app.ts cdk.json
git commit -m "Go live with daily job digest via Customer.io

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
