import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleFeed, buildFeedPlan, EMAIL_MAX_AGE_DAYS, experienceFilter, MAX_ROLES, normalizeRoles, sortBy, splitEvenly,
  toDigestSourceJob, weave, type FeedProfile,
} from './feed';
import { buildAppliedMatcher } from './applied-jobs';

const NOW = 1_800_000_000;
const opts = { limit: 15, excludeIds: [], nowSec: NOW };
const profile = (p: Partial<FeedProfile> = {}): FeedProfile =>
  ({ roles: ['Backend Engineer'], yearsOfExperience: 3, needsVisa: false, ...p });

test('normalizeRoles parses comma strings, prefers specific roles and caps the count', () => {
  assert.deepEqual(
    normalizeRoles('Backend Engineer, Software / Internet / AI, backend engineer, Data Engineer'),
    ['Backend Engineer', 'Data Engineer'],
  );
  assert.equal(normalizeRoles(['A', 'B', 'C', 'D', 'E']).length, MAX_ROLES);
});

test('normalizeRoles expands a lone category and falls back to the profile title', () => {
  assert.deepEqual(normalizeRoles('Product'), ['Product Manager', 'Product Designer']);
  assert.deepEqual(normalizeRoles(null, ' Nurse '), ['Nurse']);
  assert.deepEqual(normalizeRoles('', ''), []);
});

test('experienceFilter excludes only clearly mismatched seniority', () => {
  assert.equal(experienceFilter(null), null);
  assert.equal(experienceFilter(2), 'experience_level:!=senior');
  assert.equal(experienceFilter(4), null);
  assert.equal(experienceFilter(6), 'experience_level:!=entry');
});

test('sortBy is "For You": relevance buckets, then the user\'s level, then newest', () => {
  assert.equal(sortBy(8), '_text_match(buckets: 10):desc,_eval(experience_level:=senior):desc,date_posted:desc');
  assert.equal(sortBy(null), '_text_match(buckets: 10):desc,date_posted:desc');
});

test('splitEvenly spreads the remainder over the first buckets', () => {
  assert.deepEqual(splitEvenly(16, 3), [6, 5, 5]);
  assert.deepEqual(splitEvenly(5, 0), []);
});

test('buildFeedPlan: one title search per role, recent jobs only, applied ids excluded', () => {
  const plan = buildFeedPlan(profile({ roles: ['Backend Engineer', 'Data Engineer'] }), { ...opts, excludeIds: ['a`b', 'c'] });
  assert.deepEqual(plan.streams.map((s) => [s.role, s.visaOnly, s.perPage]), [
    ['Backend Engineer', false, 8], ['Data Engineer', false, 7],
  ]);
  const s = plan.searches[0] as Record<string, any>;
  assert.equal(s.collection, 'jobs');
  assert.equal(s.q, 'Backend Engineer');
  assert.equal(s.drop_tokens_threshold, 0);
  assert.equal(s.page, 1);
  assert.equal(s.filter_by, `date_posted:>=${NOW - EMAIL_MAX_AGE_DAYS * 86400} && is_ghost_job:!=true && id:!=[\`ab\`,\`c\`]`);
});

test('buildFeedPlan with visa: 20% of the list comes from sponsor-only searches', () => {
  const plan = buildFeedPlan(profile({ roles: ['A', 'B'], needsVisa: true, yearsOfExperience: 1 }), { ...opts, limit: 20 });
  assert.deepEqual(plan.streams.map((s) => [s.role, s.visaOnly, s.perPage]), [
    ['A', false, 8], ['B', false, 8], ['A', true, 2], ['B', true, 2],
  ]);
  assert.match((plan.searches[2] as any).filter_by, /experience_level:!=senior && sponsors_visa:=true$/);
  assert.ok(!(plan.searches[0] as any).filter_by.includes('sponsors_visa'));
});

test('weave places one extra item after every four main items', () => {
  assert.deepEqual(weave([1, 2, 3, 4, 5, 6, 7, 8], ['a', 'b', 'c'] as any[], 5), [1, 2, 3, 4, 'a', 5, 6, 7, 8, 'b', 'c']);
});

const hit = (id: string, extra: Record<string, unknown> = {}) => ({ document: { id, title: id, company: 'Co', ...extra } });

test('assembleFeed interleaves roles, weaves in visa jobs and dedupes', () => {
  const plan = buildFeedPlan(profile({ roles: ['A', 'B'], needsVisa: true }), { ...opts, limit: 10 });
  const jobs = assembleFeed(plan, [
    { hits: [hit('a1'), hit('a2'), hit('a3'), hit('a4')] },
    { hits: [hit('b1'), hit('a1')] },
    { hits: [hit('v1')] },
    { hits: [] },
  ]);
  assert.deepEqual(jobs.map((j) => j.id), ['a1', 'b1', 'a2', 'v1', 'a3', 'a4']);
});

test('toDigestSourceJob maps Typesense fields to what the digest renders', () => {
  assert.deepEqual(
    toDigestSourceJob({
      id: 'j1', title: 'Backend Engineer', company: 'Acme', location_display: 'Austin, TX', job_url: 'https://x',
      work_arrangement: 'onsite', salary_min_annual: 120000, salary_max_annual: 150000,
    }),
    {
      id: 'j1', job_title: 'Backend Engineer', company_name: 'Acme', location: 'Austin, TX', job_url: 'https://x',
      ai_work_arrangement: 'On-site', salary_min: 120000, salary_max: 150000, salary_currency: 'USD',
    },
  );
  const bare = toDigestSourceJob({ id: 'j2', title: 'X' });
  assert.equal(bare.salary_currency, null);
  assert.equal(bare.ai_work_arrangement, null);
});

test('applied matcher catches extension applications by posting URL', () => {
  const applied = buildAppliedMatcher([
    { job_id: 'j1', company_url: null, linkedin_job_id: null },
    { job_id: null, company_url: 'https://boards.greenhouse.io/acme/jobs/5180025007', linkedin_job_id: null },
  ]);
  assert.deepEqual(applied.ids, ['j1']);
  assert.ok(applied.isApplied({ id: 'j1' }));
  assert.ok(applied.isApplied({ id: 'zz', job_url: 'https://job-boards.greenhouse.io/acme?gh_jid=5180025007' }));
  assert.ok(!applied.isApplied({ id: 'zz', job_url: 'https://job-boards.greenhouse.io/acme?gh_jid=1' }));
});
