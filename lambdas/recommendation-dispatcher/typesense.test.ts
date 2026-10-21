import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multiSearch, SearchUnavailableError } from './typesense';

const config = { url: 'https://search.example/', searchKey: 'k' };
const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test('multiSearch posts the searches with the API key and returns results', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const results = await multiSearch(config, [{ q: 'x' }], async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ results: [{ found: 1, hits: [] }] }), { status: 200 });
  });
  assert.equal(seen!.url, 'https://search.example/multi_search');
  assert.equal((seen!.init.headers as Record<string, string>)['X-TYPESENSE-API-KEY'], 'k');
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { searches: [{ q: 'x' }] });
  assert.equal(results[0].found, 1);
});

test('multiSearch turns HTTP and per-search errors into SearchUnavailableError', async () => {
  await assert.rejects(multiSearch(config, [], reply(401, { message: 'Forbidden' })), SearchUnavailableError);
  await assert.rejects(
    multiSearch(config, [], reply(200, { results: [{ error: 'bad filter', code: 400 }] })),
    /search error 400: bad filter/,
  );
});
