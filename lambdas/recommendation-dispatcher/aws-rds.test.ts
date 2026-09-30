import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { getApplicationCounts } from './aws-rds';

test('getApplicationCounts falls back to an empty map when the query fails', async () => {
  const pool = { query: async () => { throw new Error('relation "applications" does not exist'); } } as unknown as Pool;
  const counts = await getApplicationCounts(pool, ['u1']);
  assert.equal(counts.size, 0);
});

test('getApplicationCounts maps rows by user id', async () => {
  const pool = { query: async () => ({ rows: [{ user_id: 'u1', total: 9, last7d: 4, interviews: 1 }] }) } as unknown as Pool;
  const counts = await getApplicationCounts(pool, ['u1']);
  assert.deepEqual(counts.get('u1'), { total: 9, last7d: 4, interviews: 1 });
});
