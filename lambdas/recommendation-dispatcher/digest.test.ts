import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSalary, jobUrl, dateLabel, headlineIndex, buildDigest, HEADLINE_COUNT, shortSalary, subjectIndex,
} from './digest';
import type { DigestSourceJob } from './feed';

const row = (id: string, extra: Partial<DigestSourceJob> = {}): DigestSourceJob => ({
  id, job_title: `Title ${id}`, company_name: `Co ${id}`, location: 'Austin, TX', job_url: null,
  ai_work_arrangement: 'Remote', salary_min: null, salary_max: null, salary_currency: null, ...extra,
});
const counts = { total: 12, last7d: 4, interviews: 0 };
const now = new Date('2026-09-29T14:00:00Z');

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

test('dateLabel defaults to America/Chicago and follows the user\'s zone', () => {
  assert.equal(dateLabel(new Date('2026-09-30T03:00:00Z')), 'Tuesday, Sep 29');
  assert.equal(dateLabel(new Date('2026-09-30T03:00:00Z'), 'Asia/Kolkata'), 'Wednesday, Sep 30');
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

test('buildDigest keeps feed order, caps at 5, counts the rest', () => {
  const jobs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => row(id));
  const p = buildDigest({ userId: 'u1', jobs, counts, now })!;
  assert.deepEqual(p.jobs.map((j) => j.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(p.jobs.map((j) => j.rank), [1, 2, 3, 4, 5]);
  assert.equal(p.job_count, 5);
  assert.equal(p.more_count, 2);
  assert.ok(p.jobs[1].url.endsWith('utm_content=job_2'));
  assert.equal(p.applied_7d, 4);
  assert.equal(p.date_label, 'Tuesday, Sep 29');
});

test('buildDigest returns null when fewer than 3 jobs remain', () => {
  assert.equal(buildDigest({ userId: 'u1', jobs: [row('a'), row('b')], counts, now }), null);
});

test('buildDigest never emits "null" strings', () => {
  const jobs = [row('a', { company_name: null, location: '  ', ai_work_arrangement: null }), row('b'), row('c')];
  const p = buildDigest({ userId: 'u1', jobs, counts, now })!;
  assert.equal(p.jobs[0].company, null);
  assert.equal(p.jobs[0].location, null);
  assert.equal(p.jobs[0].salary, null);
  assert.ok(!JSON.stringify(p).includes('"null"'));
});

test('work arrangement is normalized to a short label', () => {
  const pick = (v: string | null) =>
    buildDigest({ userId: 'u1', jobs: [row('a', { ai_work_arrangement: v }), row('b'), row('c')], counts, now })!.jobs[0].work_arrangement;
  assert.equal(pick('Remote Solely'), 'Remote');
  assert.equal(pick('Hybrid'), 'Hybrid');
  assert.equal(pick('On-site'), 'On-site');
  assert.equal(pick('onsite'), 'On-site');
  assert.equal(pick('In office'), 'On-site');
  assert.equal(pick('Flexible hours'), 'Flexible hours');
  assert.equal(pick(null), null);
});

test('shortSalary rounds annual amounts to K and ignores hourly-looking values', () => {
  assert.equal(shortSalary(285000, 'USD'), '$285K');
  assert.equal(shortSalary('95500', null), '$96K');
  assert.equal(shortSalary(120000, 'EUR'), '€120K');
  assert.equal(shortSalary(45, 'USD'), null);
  assert.equal(shortSalary(null, 'USD'), null);
});

test('buildDigest exposes the top salary among emailed jobs and its title', () => {
  const jobs = [
    row('a', { job_title: 'Analyst', salary_min: 90000, salary_max: 120000, salary_currency: 'USD' }),
    row('b', { job_title: 'Principal Engineer, AI', salary_min: 210000, salary_max: 285000, salary_currency: 'USD' }),
    row('c'),
  ];
  const p = buildDigest({ userId: 'u1', jobs, counts, now })!;
  assert.equal(p.top_salary, '$285K');
  assert.equal(p.top_salary_title, 'Principal Engineer, AI');
});

test('buildDigest has null top salary when no emailed job lists one', () => {
  const p = buildDigest({ userId: 'u1', jobs: [row('a'), row('b'), row('c')], counts, now })!;
  assert.equal(p.top_salary, null);
  assert.equal(p.top_salary_title, null);
});

test('subjectIndex changes every day for both the 3- and 7-line pools', () => {
  let prev = -1;
  for (let d = 0; d < 30; d++) {
    const i = subjectIndex('u1', new Date(now.getTime() + d * 86_400_000));
    assert.ok(i >= 0 && i < 84);
    if (prev >= 0) {
      assert.notEqual(i % 3, prev % 3);
      assert.notEqual(i % 7, prev % 7);
    }
    prev = i;
  }
});

test('buildDigest sends ready-made subject indexes for each pool (no Liquid modulo)', () => {
  for (let d = 0; d < 10; d++) {
    const day = new Date(now.getTime() + d * 86_400_000);
    const p = buildDigest({ userId: 'u1', jobs: [row('a'), row('b'), row('c')], counts, now: day })!;
    assert.equal(p.subject_a, p.subject_index % 3);
    assert.equal(p.subject_b, p.subject_index % 7);
  }
});
