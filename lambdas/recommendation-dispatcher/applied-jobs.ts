/**
 * "Has this user already applied to this job?" Ported from jobply_website/lib/applied-jobs.ts.
 *
 * Applications made through the extension often store the posting URL (company_url) or a
 * platform key (linkedin_job_id like "greenhouse_123") instead of our job id, so ids alone miss
 * them. Ids go into the Typesense filter; URL matches are checked after the search.
 */

/**
 * Extracts the numeric Greenhouse job ID from a URL.
 * Handles both `?gh_jid=5180025007` and `/jobs/5180025007` forms.
 * The scraped job's job_url and the user's applied company_url use different
 * domains/query strings but share the same number — so we match on the number.
 */
function extractGreenhouseJobId(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/(?:gh_jid=|\/jobs\/)(\d+)/);
  return match ? match[1] : null;
}

/**
 * Extracts the Ashby job UUID from a URL.
 * Ashby URLs look like: jobs.ashbyhq.com/<company>/<uuid>[/application]
 * e.g. .../hirehangar/99ffdde3-52a1-43d1-8916-5962d17f677f
 */
function extractAshbyJobId(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Extracts a stable BambooHR job key from a URL: `<subdomain>_<id>`.
 * BambooHR URLs look like: <company>.bamboohr.com/careers/247
 * The numeric id is only unique PER COMPANY, so we combine subdomain + id.
 * e.g. doveschoolstulsa.bamboohr.com/careers/247 → `doveschoolstulsa_247`
 */
function extractBamboohrJobId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.includes('bamboohr.com')) return null;
    const subdomain = u.hostname.split('.')[0];
    const idMatch = u.pathname.match(/\/careers\/(\d+)/);
    if (!subdomain || !idMatch) return null;
    return `${subdomain.toLowerCase()}_${idMatch[1]}`;
  } catch {
    return null;
  }
}

/**
 * Extracts a stable BreezyHR job key from a URL: `<subdomain>_<positionid>`.
 * BreezyHR URLs look like: <company>.breezy.hr/p/<id>-<slug>[/apply[/submitted]]
 * The position id is the hex part before the first "-" in the /p/ segment.
 * e.g. thirdchannel-inc.breezy.hr/p/2efce0f4f503-brand-rep/apply
 *      → `thirdchannel-inc_2efce0f4f503`
 */
function extractBreezyhrJobId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.includes('breezy.hr')) return null;
    const subdomain = u.hostname.split('.')[0];
    const idMatch = u.pathname.match(/\/p\/([^/-]+)/);
    if (!subdomain || !idMatch) return null;
    return `${subdomain.toLowerCase()}_${idMatch[1]}`;
  } catch {
    return null;
  }
}

/**
 * Extracts a stable SmartRecruiters job key from the PUBLIC posting URL:
 * `<company>_<numeric-posting-id>`.
 * Scraped URLs look like: jobs.smartrecruiters.com/Dominos/744000133721703-assistant-manager
 * (Note: the apply flow uses a different publication UUID — the extension
 * bridges the two by capturing this numeric id on the posting page.)
 * e.g. jobs.smartrecruiters.com/Dominos/744000133721703-... → `dominos_744000133721703`
 */
function extractSmartRecruitersJobId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.includes('smartrecruiters.com')) return null;
    const match = u.pathname.match(/^\/([^/]+)\/(\d+)-/);
    if (!match) return null;
    return `${decodeURIComponent(match[1]).toLowerCase()}_${match[2]}`;
  } catch {
    return null;
  }
}

export interface AppliedRow {
  job_id: string | null;
  company_url: string | null;
  linkedin_job_id: string | null;
}

/**
 * Cap on applied job ids sent to Typesense as an `id:!=[...]` filter (keeps filter_by bounded).
 * Rows come back most recent first, so the cap keeps the user's latest applications.
 */
export const MAX_EXCLUDED_IDS = 250;

type Platform = 'greenhouse' | 'ashby' | 'bamboohr' | 'breezyhr' | 'smartrecruiters';
const EXTRACTORS: Record<Platform, (url: string | null | undefined) => string | null> = {
  greenhouse: extractGreenhouseJobId,
  ashby: extractAshbyJobId,
  bamboohr: extractBamboohrJobId,
  breezyhr: extractBreezyhrJobId,
  smartrecruiters: extractSmartRecruitersJobId,
};

export function buildAppliedMatcher(rows: AppliedRow[]) {
  const ids = new Set<string>();
  const byPlatform: Record<Platform, Set<string>> = {
    greenhouse: new Set(), ashby: new Set(), bamboohr: new Set(), breezyhr: new Set(), smartrecruiters: new Set(),
  };
  for (const a of rows) {
    if (a.job_id) ids.add(a.job_id);
    for (const platform of Object.keys(EXTRACTORS) as Platform[]) {
      const fromUrl = EXTRACTORS[platform](a.company_url);
      if (fromUrl) byPlatform[platform].add(fromUrl);
      const key = a.linkedin_job_id;
      if (typeof key === 'string' && key.startsWith(`${platform}_`)) {
        const raw = key.slice(platform.length + 1);
        byPlatform[platform].add(platform === 'greenhouse' ? raw : raw.toLowerCase());
      }
    }
  }
  return {
    ids: Array.from(ids),
    isApplied(job: { id: string; job_url?: string | null }): boolean {
      if (ids.has(job.id)) return true;
      for (const platform of Object.keys(EXTRACTORS) as Platform[]) {
        if (!byPlatform[platform].size) continue;
        const key = EXTRACTORS[platform](job.job_url);
        if (key && byPlatform[platform].has(key)) return true;
      }
      return false;
    },
  };
}
