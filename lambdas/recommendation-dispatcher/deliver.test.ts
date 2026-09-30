import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverDigest } from './deliver';

test('sends when today\'s dedupe row is new', async () => {
  let sent = 0;
  const r = await deliverDigest({ schedule: async () => 'job-1', send: async () => { sent++; } });
  assert.equal(r, 'sent');
  assert.equal(sent, 1);
});

test('same-day rerun: dedupe conflict (null id) never sends a second email', async () => {
  let sent = 0;
  const r = await deliverDigest({ schedule: async () => null, send: async () => { sent++; } });
  assert.equal(r, 'duplicate');
  assert.equal(sent, 0);
});

test('Customer.io outage is reported, not thrown, so the batch continues', async () => {
  const r = await deliverDigest({ schedule: async () => 'job-1', send: async () => { throw new Error('Customer.io track 503'); } });
  assert.equal(r, 'send_failed');
});

test('a failed dedupe write never sends', async () => {
  let sent = 0;
  const r = await deliverDigest({ schedule: async () => { throw new Error('rpc down'); }, send: async () => { sent++; } });
  assert.equal(r, 'schedule_failed');
  assert.equal(sent, 0);
});
