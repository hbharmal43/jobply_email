/**
 * Minimal Typesense multi_search client (plain fetch, no SDK).
 *
 * The production server (search.jobply.ai) is public behind Caddy, which exposes only
 * /health, /multi_search and the documents search path. The key is the same search-only key
 * the website uses, scoped to the `jobs` alias.
 */
import type { RawResult } from './feed';

export class SearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchUnavailableError';
  }
}

export interface TypesenseConfig {
  /** Base URL, e.g. https://search.jobply.ai */
  url: string;
  searchKey: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function multiSearch(
  config: TypesenseConfig,
  searches: Record<string, unknown>[],
  fetchImpl: FetchLike = fetch,
): Promise<RawResult[]> {
  let body: { results?: RawResult[] };
  try {
    const res = await fetchImpl(`${config.url.replace(/\/$/, '')}/multi_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TYPESENSE-API-KEY': config.searchKey },
      body: JSON.stringify({ searches }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    body = (await res.json()) as { results?: RawResult[] };
  } catch (err: any) {
    throw new SearchUnavailableError(err?.message ?? 'Typesense request failed');
  }
  const results = body.results ?? [];
  const failed = results.find((r) => r.error);
  if (failed) throw new SearchUnavailableError(`Typesense search error ${failed.code}: ${failed.error}`);
  return results;
}
