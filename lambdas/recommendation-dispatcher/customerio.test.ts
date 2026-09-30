import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendCustomerIoEvent } from './customerio';

test('posts the event with Basic auth to the customer path', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

  await sendCustomerIoEvent({ siteId: 'site', apiKey: 'key' }, 'user-1', 'daily_job_matches', { job_count: 5 }, fake);

  assert.equal(seen!.url, 'https://track.customer.io/api/v1/customers/user-1/events');
  assert.equal(seen!.init.method, 'POST');
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from('site:key').toString('base64')}`);
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { name: 'daily_job_matches', data: { job_count: 5 } });
});

test('throws on non-2xx so the caller can log and continue', async () => {
  const fake = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(sendCustomerIoEvent({ siteId: 's', apiKey: 'k' }, 'u', 'e', {}, fake), /500/);
});
