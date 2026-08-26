# Email pipeline operations

The stack is deployed in paused mode by default. In paused mode, both recurring
dispatchers are disabled, the dispatcher handler exits before scanning or
claiming jobs, and the sender is pinned to the Gmail allowlist in `cdk.json`.

## Pipeline

1. The lifecycle dispatcher scans four lightweight journeys once a minute.
   The recommendation dispatcher scans separately at 9:00 AM Central.
2. It claims up to `claimBatchSize` due rows from Supabase each minute.
3. Claimed jobs are published to SQS and marked queued.
4. The sender Lambda rechecks preferences and suppressions, renders the email,
   sends with SES, and records the SES message ID.
5. SES events flow through EventBridge to the feedback Lambda and Supabase.

SQS contains the active delivery buffer, not every future email. Future and
deduplicated jobs live in Supabase `email_internal.email_jobs`; each dispatcher
run moves the next due batch into SQS.

Candidate scans are bounded by `scanBatchSize`, but they do not restart from
the same first page. Candidate RPCs exclude users whose deduplicated job already
exists, so later runs advance through the remaining population. Recommendation
candidates with no matches are recorded in `email_internal.email_candidate_scans`
for the UTC day so they cannot block later candidates.

## Journey coverage

The dispatchers create these journeys when they become eligible:

- `onboarding_abandoned`
- `extension_nudge`
- `application_milestone` (`application_praise` or `no_applications_nudge`)
- `extension_feedback`
- `job_recommendations`

Job recommendations use EventBridge Scheduler with the
`America/Chicago` timezone, so the 9:00 AM schedule follows daylight-saving
time. Its larger `recommendationScanBatchSize` is independent from the
lifecycle scanner's `scanBatchSize`.

`welcome` and `account_deleted` are event-driven. The website must call
`schedule_email_job` when login/onboarding completes or account deletion occurs;
the dispatcher will claim and queue those jobs once they exist.

## Activate production

Review the number of currently due/candidate users before activation. Then run:

```powershell
npx cdk diff -c env=development -c enableDispatch=true --no-change-set
npx cdk deploy -c env=development -c enableDispatch=true --require-approval never
```

`enableDispatch=true` is authoritative: it enables both schedules,
sets `PRODUCTION_MODE=true`, and explicitly clears `TEST_RECIPIENTS` and the
historical `JOBPLY_TEST_USER_IDS` drift in the deployed Lambdas. Lifecycle
journeys then scan once per minute; recommendations scan daily at 9:00 AM
Central.

## Pause production

```powershell
npx cdk deploy -c env=development -c enableDispatch=false --require-approval never
```

This disables new scheduled runs, makes manual dispatcher invocations no-ops,
and restores the sender allowlist. It does not delete Supabase jobs or SQS
messages that already exist. If an
incident requires a hard stop, also disable the sender's SQS event-source mapping
after inspecting the queue and in-flight message counts.
