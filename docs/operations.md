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
3. For each candidate it matches jobs on RDS (`recommend_jobs_aws`) and records
   a deduplicated `job_recommendations` row in `email_internal.email_jobs`
   (dedupe key `job_recommendations:<user>:<UTC date>`).

## Data sources

Job listings live on AWS RDS, not Supabase. The recommendation scan therefore
spans two databases:

- **Supabase** — candidate profiles, `user_embeddings`, `profiles.years_of_experience`,
  and all of `email_internal`. Reached over PostgREST with the service role key.
- **AWS RDS** — `recommend_jobs_aws` and `scraped_jobs`. Reached over the
  Postgres wire protocol with `pg`.

`recommend_jobs_aws` does not look the user's vector up itself — unlike the
Supabase `recommend_jobs_for_user_v3` it replaced — so the dispatcher reads each
embedding from Supabase and passes it in. Embeddings and years-of-experience are
batched in chunks of 50 before the per-user loop.

The RDS connection URL is the `awsRdsUrl` field on the
`jobply-email/<env>/supabase` secret. RDS is reachable over the public internet,
so the Lambda needs no VPC attachment.

If the RDS query fails for a user, that user is skipped and retried on the next
run — there is deliberately no fallback to the Supabase matcher, whose job
tables are now stale.

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
