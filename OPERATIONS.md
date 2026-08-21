# Email pipeline operations

The stack is deployed in paused mode by default. In paused mode, the recurring
dispatcher is disabled, the dispatcher handler exits before scanning or
claiming jobs, and the sender is pinned to the Gmail allowlist in `cdk.json`.

## Pipeline

1. The dispatcher scans enabled journeys and calls `schedule_email_job`.
2. It claims up to `claimBatchSize` due rows from Supabase each minute.
3. Claimed jobs are published to SQS and marked queued.
4. The sender Lambda rechecks preferences and suppressions, renders the email,
   sends with SES, and records the SES message ID.
5. SES events flow through EventBridge to the feedback Lambda and Supabase.

SQS contains the active delivery buffer, not every future email. Future and
deduplicated jobs live in Supabase `email_internal.email_jobs`; each dispatcher
run moves the next due batch into SQS.

## Journey coverage

The dispatcher creates these journeys when they become eligible:

- `onboarding_abandoned`
- `extension_nudge`
- `application_milestone` (`application_praise` or `no_applications_nudge`)
- `extension_feedback`
- `job_recommendations`

`welcome` and `account_deleted` are event-driven. The website must call
`schedule_email_job` when login/onboarding completes or account deletion occurs;
the dispatcher will claim and queue those jobs once they exist.

## Activate production

Review the number of currently due/candidate users before activation. Then run:

```powershell
npx cdk diff -c env=development -c enableDispatch=true --no-change-set
npx cdk deploy -c env=development -c enableDispatch=true --require-approval never
```

`enableDispatch=true` is authoritative: it enables the EventBridge schedule,
sets `PRODUCTION_MODE=true`, and explicitly clears `TEST_RECIPIENTS` and the
historical `JOBPLY_TEST_USER_IDS` drift in the deployed Lambdas. The configured
dispatcher journeys then run once per minute.

## Pause production

```powershell
npx cdk deploy -c env=development -c enableDispatch=false --require-approval never
```

This disables new scheduled runs, makes manual dispatcher invocations no-ops,
and restores the sender allowlist. It does not delete Supabase jobs or SQS
messages that already exist. If an
incident requires a hard stop, also disable the sender's SQS event-source mapping
after inspecting the queue and in-flight message counts.
