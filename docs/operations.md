# Recommendation dispatcher operations

This stack runs one thing: the daily job-recommendation dispatcher. All email
sending, unsubscribes, and delivery metrics are handled by Customer.io. The
SES/SQS send pipeline, the SES feedback Lambda, and the per-minute lifecycle
dispatcher were removed on 2026-09-29.

The stack is deployed paused by default: the daily schedule is disabled and the
handler exits immediately (`PRODUCTION_MODE=false`).

## Pipeline

1. EventBridge Scheduler invokes the recommendation dispatcher daily at
   9:00 AM `America/Chicago` (follows daylight-saving time).
2. It pulls up to `recommendationScanBatchSize` candidates from Supabase
   (`get_job_recommendation_candidates`).
3. For each candidate it matches jobs on Typesense (the dashboard's "For You"
   search) and records
   a deduplicated `job_recommendations` row in `email_internal.email_jobs`
   (dedupe key `job_recommendations:<user>:<UTC date>`).

## Data sources

Matching moved from embeddings to Typesense on 2026-10-20, following the
website's dashboard feed (`jobply_website/lib/recommendations/typesense-feed.ts`,
ported as `lambdas/recommendation-dispatcher/feed.ts`). The scan reads three
sources:

- **Supabase**: candidate profiles (`title`, `years_of_experience`,
  `visa_sponsorship_required`), `job_preferences.interested_roles`, and all of
  `email_internal`. Reached over PostgREST with the service role key; batched
  in chunks of 50 before the per-user loop.
- **AWS RDS**: `applications` (motivation counts and already-applied jobs).
  Reached over the Postgres wire protocol with `pg`.
- **Typesense** (`search.jobply.ai`, `jobs` alias): one `multi_search` per user
  with a title search per target role (max 4), experience filter, 20% visa
  sponsor share for users who need it, and only jobs posted in the last
  `EMAIL_MAX_AGE_DAYS` (3) so the email doesn't repeat itself day to day. The
  index holds only active jobs from the last 15 days, so links stay live.

Users with no target roles and no profile title are skipped for the day.

Secret fields on `jobply-email/<env>/supabase`: `awsRdsUrl` (RDS, public, no VPC
needed), `typesenseSearchKey` (the website's search-only key) and an optional
`typesenseUrl` (default `https://search.jobply.ai`).

If the Typesense search fails for a user, that user is skipped and retried on
the next run. There is deliberately no fallback to the old embedding matcher.
If the RDS applications query fails, the whole run stops, because the digest
could otherwise recommend jobs the user already applied to.

Candidate scans are bounded by `recommendationScanBatchSize`, but they do not
restart from the same first page. Candidates with no matches are recorded in
`email_internal.email_candidate_scans` for the UTC day so they cannot block
later candidates.

## Activate

Review the number of candidate users before activation. Then run:

```powershell
npx cdk diff -c env=development -c enableDispatch=true --no-change-set
npx cdk deploy -c env=development -c enableDispatch=true --require-approval never
```

`enableDispatch=true` enables the daily schedule and sets `PRODUCTION_MODE=true`.

## Pause

```powershell
npx cdk deploy -c env=development -c enableDispatch=false --require-approval never
```

This disables the schedule and makes manual invocations no-ops. It does not
delete rows already in `email_internal.email_jobs`.
