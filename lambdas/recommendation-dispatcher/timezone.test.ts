import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUsTimeZone, localHour, userTimeZone } from './timezone';

test('userTimeZone reads state codes and names, state before country', () => {
  assert.equal(userTimeZone('CA', 'United States of America'), 'America/Los_Angeles');
  assert.equal(userTimeZone(' Texas ', null), 'America/Chicago');
  assert.equal(userTimeZone('NY', null), 'America/New_York');
  assert.equal(userTimeZone('Maharashtra', 'United States of America'), 'Asia/Kolkata');
  assert.equal(userTimeZone('BC', null), 'America/Vancouver');
});

test('userTimeZone falls back to country, then Central', () => {
  assert.equal(userTimeZone(null, 'India'), 'Asia/Kolkata');
  assert.equal(userTimeZone('', 'ph'), 'Asia/Manila');
  assert.equal(userTimeZone(null, 'United States of America'), 'America/Chicago');
  assert.equal(userTimeZone('Somewhere', 'X'), 'America/Chicago');
});

test('isUsTimeZone covers US states and the Central default only', () => {
  assert.ok(isUsTimeZone(userTimeZone(null, null)));
  assert.ok(isUsTimeZone(userTimeZone('HI', null)));
  assert.ok(!isUsTimeZone(userTimeZone('Gujarat', null)));
  assert.ok(!isUsTimeZone(userTimeZone('BC', null)));
});

test('localHour follows DST and half-hour offsets', () => {
  const t = new Date('2026-10-20T14:00:00Z');
  assert.equal(localHour(t, 'America/Chicago'), 9);
  assert.equal(localHour(t, 'America/New_York'), 10);
  assert.equal(localHour(new Date('2026-12-01T15:00:00Z'), 'America/Chicago'), 9);
  assert.equal(localHour(new Date('2026-10-20T04:00:00Z'), 'Asia/Kolkata'), 9);
  assert.equal(localHour(new Date('2026-10-20T00:00:00Z'), 'Europe/London'), 1);
});
