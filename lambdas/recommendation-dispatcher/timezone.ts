/**
 * Best-effort timezone per user, so the digest lands at 9 AM their time.
 *
 * Profiles have no timezone column, only free-text `state` and `country` from onboarding.
 * `country` is unreliable (it defaults to the US, even for users who typed an Indian state),
 * so `state` wins. US states spanning two zones get their most populous one. Anything
 * unrecognised falls back to America/Chicago, the old single send time.
 */

export const DEFAULT_TIME_ZONE = 'America/Chicago';
/** Local hour (0-23) the digest goes out. The dispatcher runs hourly on the hour. */
export const SEND_HOUR = 9;

const EASTERN = 'America/New_York';
const CENTRAL = 'America/Chicago';
const MOUNTAIN = 'America/Denver';
const PACIFIC = 'America/Los_Angeles';
const INDIA = 'Asia/Kolkata';

/** US states and territories, by code and name (lowercased). */
const US_STATES: [string, string, string][] = [
  ['al', 'alabama', CENTRAL], ['ak', 'alaska', 'America/Anchorage'], ['az', 'arizona', 'America/Phoenix'],
  ['ar', 'arkansas', CENTRAL], ['ca', 'california', PACIFIC], ['co', 'colorado', MOUNTAIN],
  ['ct', 'connecticut', EASTERN], ['de', 'delaware', EASTERN], ['dc', 'district of columbia', EASTERN],
  ['fl', 'florida', EASTERN], ['ga', 'georgia', EASTERN], ['hi', 'hawaii', 'Pacific/Honolulu'],
  ['id', 'idaho', 'America/Boise'], ['il', 'illinois', CENTRAL], ['in', 'indiana', 'America/Indiana/Indianapolis'],
  ['ia', 'iowa', CENTRAL], ['ks', 'kansas', CENTRAL], ['ky', 'kentucky', EASTERN],
  ['la', 'louisiana', CENTRAL], ['me', 'maine', EASTERN], ['md', 'maryland', EASTERN],
  ['ma', 'massachusetts', EASTERN], ['mi', 'michigan', 'America/Detroit'], ['mn', 'minnesota', CENTRAL],
  ['ms', 'mississippi', CENTRAL], ['mo', 'missouri', CENTRAL], ['mt', 'montana', MOUNTAIN],
  ['ne', 'nebraska', CENTRAL], ['nv', 'nevada', PACIFIC], ['nh', 'new hampshire', EASTERN],
  ['nj', 'new jersey', EASTERN], ['nm', 'new mexico', MOUNTAIN], ['ny', 'new york', EASTERN],
  ['nc', 'north carolina', EASTERN], ['nd', 'north dakota', CENTRAL], ['oh', 'ohio', EASTERN],
  ['ok', 'oklahoma', CENTRAL], ['or', 'oregon', PACIFIC], ['pa', 'pennsylvania', EASTERN],
  ['ri', 'rhode island', EASTERN], ['sc', 'south carolina', EASTERN], ['sd', 'south dakota', CENTRAL],
  ['tn', 'tennessee', CENTRAL], ['tx', 'texas', CENTRAL], ['ut', 'utah', MOUNTAIN],
  ['vt', 'vermont', EASTERN], ['va', 'virginia', EASTERN], ['wa', 'washington', PACIFIC],
  ['wv', 'west virginia', EASTERN], ['wi', 'wisconsin', CENTRAL], ['wy', 'wyoming', MOUNTAIN],
  ['pr', 'puerto rico', 'America/Puerto_Rico'],
];

const INDIAN_STATES = [
  'india', 'maharashtra', 'gujarat', 'karnataka', 'tamil nadu', 'telangana', 'andhra pradesh', 'kerala',
  'delhi', 'new delhi', 'uttar pradesh', 'west bengal', 'rajasthan', 'madhya pradesh', 'punjab', 'haryana',
  'bihar', 'odisha', 'goa', 'assam', 'jharkhand', 'chhattisgarh', 'uttarakhand', 'himachal pradesh',
];

/** Canadian provinces, plus a few non-US places users have typed into `state`. */
const OTHER_STATES: Record<string, string> = {
  bc: 'America/Vancouver', 'british columbia': 'America/Vancouver', ab: 'America/Edmonton', alberta: 'America/Edmonton',
  on: 'America/Toronto', ontario: 'America/Toronto', qc: 'America/Toronto', quebec: 'America/Toronto',
  uk: 'Europe/London', england: 'Europe/London', london: 'Europe/London',
};

const COUNTRIES: Record<string, string> = {
  india: INDIA, in: INDIA,
  'united kingdom': 'Europe/London', uk: 'Europe/London', gb: 'Europe/London',
  canada: 'America/Toronto', australia: 'Australia/Sydney', 'new zealand': 'Pacific/Auckland',
  philippines: 'Asia/Manila', ph: 'Asia/Manila', kenya: 'Africa/Nairobi', nigeria: 'Africa/Lagos',
  estonia: 'Europe/Tallinn', germany: 'Europe/Berlin', france: 'Europe/Paris', ireland: 'Europe/Dublin',
  pakistan: 'Asia/Karachi', bangladesh: 'Asia/Dhaka', singapore: 'Asia/Singapore', 'united arab emirates': 'Asia/Dubai',
};

const BY_STATE = new Map<string, string>([
  ...US_STATES.flatMap(([code, name, tz]) => [[code, tz], [name, tz]] as [string, string][]),
  ...INDIAN_STATES.map((s) => [s, INDIA] as [string, string]),
  ...Object.entries(OTHER_STATES),
]);

const US_ZONES = new Set(US_STATES.map(([, , tz]) => tz));

/** US zones, including users with no known location (they default to Central). */
export function isUsTimeZone(timeZone: string): boolean {
  return US_ZONES.has(timeZone);
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase().replace(/\.$/, '');

export function userTimeZone(state: string | null | undefined, country: string | null | undefined): string {
  return BY_STATE.get(norm(state)) ?? COUNTRIES[norm(country)] ?? DEFAULT_TIME_ZONE;
}

/** The hour (0-23) on the wall clock in `timeZone` at `now`. */
export function localHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).find((p) => p.type === 'hour')?.value;
  return Number(hour);
}
