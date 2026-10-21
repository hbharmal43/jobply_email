import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysSinceLastSend, isSendTime, isUsTimeZone, localHour, localWeekday, userTimeZone } from './timezone';

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

test('isSendTime is 9 AM local on Monday, Wednesday and Friday only', () => {
  // 2026-10-19 is a Monday; 14:00 UTC is 9 AM Central (CDT).
  const at = (day: number) => new Date(Date.UTC(2026, 9, day, 14));
  assert.equal(localWeekday(at(19), 'America/Chicago'), 1);
  assert.deepEqual([19, 20, 21, 22, 23, 24, 25].map((d) => isSendTime(at(d), 'America/Chicago')),
    [true, false, true, false, true, false, false]);
  assert.equal(isSendTime(at(19), 'America/New_York'), false);
});

test('daysSinceLastSend reaches back to the previous send day', () => {
  assert.equal(daysSinceLastSend(1), 3);
  assert.equal(daysSinceLastSend(3), 2);
  assert.equal(daysSinceLastSend(5), 2);
});

test('localHour follows DST and half-hour offsets', () => {
  const t = new Date('2026-10-20T14:00:00Z');
  assert.equal(localHour(t, 'America/Chicago'), 9);
  assert.equal(localHour(t, 'America/New_York'), 10);
  assert.equal(localHour(new Date('2026-12-01T15:00:00Z'), 'America/Chicago'), 9);
  assert.equal(localHour(new Date('2026-10-20T04:00:00Z'), 'Asia/Kolkata'), 9);
  assert.equal(localHour(new Date('2026-10-20T00:00:00Z'), 'Europe/London'), 1);
});
