# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Jobply's email subsystem. **Customer.io (workspace 231518, reachable through the `customerio` MCP tools) sends every email**: campaigns, templates, unsubscribes, click tracking and A/B tests. This repo is an AWS CDK app (TypeScript) with a single Lambda, the daily **recommendation dispatcher**, which matches users to jobs on AWS RDS. `docs/operations.md` is the runbook.

The SES/SQS send pipeline, the SES feedback Lambda and the per-minute lifecycle dispatcher were removed on 2026-09-29. Git history has them, including the old TypeScript templates in `lambdas/sender/templates/`. Lifecycle emails are being rebuilt one at a time as Customer.io campaigns. Specs live in `docs/specs/`.

**Product context:** Jobply is completely free (no Free/Pro tiers). The goal is monthly active users and a better product. Never mention pricing, plans, trials or limits in an email.

## Repo layout

```
emails/<email>/          template.html (production source with Liquid, what's in Customer.io) + preview.html (local preview)
lambdas/recommendation-dispatcher/   the only Lambda: daily RDS job matching
infra/                   CDK app (app.ts) and stack (email-stack.ts)
database/migrations/     Supabase SQL for email_internal (record only; applied manually)
docs/                    operations.md runbook, specs/
```

## Customer.io email workflow (user rule, not optional)

1. Work on **one email at a time**.
2. Build a local HTML preview in `emails/<email>/preview.html` first (the production source with Liquid goes in `emails/<email>/template.html`) (sample data, toggles for any personalization branches, subject-line variants shown on top). Open it for the user.
3. The user reviews the design **and** the logic (trigger, timing, personalization, A/B test). Iterate on the preview.
4. **Never publish, link, or change anything in Customer.io without the user's explicit approval of that specific email.** Read-only API calls are fine.
5. After it's published, record it in the email registry below.

Two email styles:
- **Branded** (product emails): yellow `#ffde59` accents, logo, Outfit headings / Geist body / JetBrains Mono numbers, footer with `Jobply LLC · 1020 W Abram St, Arlington, TX 76013`, Privacy, Terms, Unsubscribe. Brand source: `jobply_website/DESIGN.md` (on disk at `Desktop/eazy_apply_website/website/DESIGN.md`).
- **Links:** every link gets `target="_blank" rel="noopener"` so it opens in a new tab.
- **Brand voice:** "ply" is the verb and noun for applying ("Did you ply today?", "4 plies this week", "Ply this job →"). The tone is Gen Z and motivating; never promise outcomes. Keep one plain-English line nearby so new readers get it.
- **Founder** (validation / feedback emails): plain text from "Hasnain from Jobply" with replies to his inbox. No design, no logo, a few short lines, and easy-to-answer questions.

**How users get into Customer.io:** a Pipelines reverse-ETL sync ("Jobply User Sync", id 8232, source 172138) queries Supabase `public.profiles` **every hour** for rows with `updated_at` newer than the last run, and sends each as an `identify`. Synced fields: `email`, `first_name`, `last_name`, `full_name`, `subscription_tier`, `subscription_status`, `onboarding_completed`, `profile_completion_percentage`, `job_search_status`, `created_at`, `updated_at`. A new profile row triggers the Welcome campaign, so it can arrive up to ~1 hour after signup. New attributes (such as the RDS application count) either go into this query or are sent separately.

**Sending domain:** every email sends as `Jobply <hello@mail.jobply.ai>` (Customer.io identity **3**), with replies to `hasnain@jobply.ai` (identity **1**). `mail.jobply.ai` is Customer.io sending domain 2, with link tracking on the same host (auto-TLS domain 3). It's isolated from the root `jobply.ai`, which runs the team's Zoho inboxes. DNS lives in Cloudflare; the records are in `docs/dns/mail.jobply.ai.zone`. The `mail` CNAME must stay unproxied (grey cloud). New emails use `from_id: 3, reply_to_id: 1`. DMARC is `p=none` for now: move it to `quarantine` after a few clean weeks.

### Email registry

| Email | Style | Trigger | Customer.io | Status |
|---|---|---|---|---|
| Welcome | Branded | Profile created (signup); CTA depends on `onboarding_completed` | Campaign 1. Action 2 is a 50/50 subject split: variant A = action 9 / node `a0f789bc-aacd-4cd2-aa48-a502191b530d`, variant B = action 10 / node `cd949f54-0d25-4cba-b608-8da58910b985`. Body edits must be made on **both** nodes and republished. Old design archived as node `5e362698-…` (unlinked). Source: `emails/welcome/template.html` | **Live since 2026-09-29.** A: "You're in, {name}. Let's land your next job" / B: "Welcome to Jobply 👋 Apply to your next job in one click". From hello@, reply-to hasnain@. Judge on clicks (Apple Mail inflates opens); metrics at `GET /actions/2/split_metrics`, pick a winner with `POST /actions/2/winner` |
| Daily job digest | Branded | Daily `daily_job_matches` event from the recommendation dispatcher (per-user send time later) | Campaign 5 (draft). Split action 12 [50/50]: A = action 13 / node `02609e5f-8c29-4fd1-91a8-a039fa131a9f`, B = action 14 / node `6e5c4c14-a778-4aa4-9224-ea9e1d94964a`. Body edits go on **both** nodes. Source `emails/daily-digest/template.html`; spec `docs/specs/2026-09-29-daily-digest-design.md` | Built and tested, not live. Subjects rotate daily: A "Money" (`subject_a`, 3 lines: salary / role / company), B "Nudge" (`subject_b`, 7 lowercase lines, the user's favourite). Use `case/when` on dispatcher-sent indexes; Customer.io's `modulo` compares unreliably. Blocked on: website `/dashboard/jobs/[id]` crash fix, then "go live" |
| Onboarded but didn't apply | Founder | ~3 days after onboarding, 0 applications (count from RDS); ask what stopped them | — | Not started |
| Why are you leaving? | Founder | Account deleted | — | Not started |
| Is Jobply still useful? | Founder | Was active, then quiet ~2 weeks | — | Not started |

## Commands

```powershell
npm run build                     # tsc --noEmit — the only static check; there are no tests or linter
npx cdk synth  -c env=development
npx cdk diff   -c env=development --no-change-set
npx cdk deploy -c env=development -c enableDispatch=false --require-approval never   # paused
```

`enableDispatch=true` enables the daily schedule against real users (see `docs/operations.md`). Never deploy that without explicit user approval.

## Architecture

```
Scheduler (9 AM America/Chicago) ─▶ recommendation dispatcher Lambda (lambdas/recommendation-dispatcher/handler.ts)
   Supabase: get_job_recommendation_candidates, user_embeddings, profiles.years_of_experience
   RDS:      recommend_jobs_aws ⨝ scraped_jobs (lambdas/recommendation-dispatcher/aws-rds.ts)
   Supabase: schedule_email_job → email_internal.email_jobs (dedupe key job_recommendations:<user>:<UTC date>)
```

- **Two databases.** Profiles and embeddings are in Supabase; job listings are on RDS. The dispatcher reads embeddings from Supabase and passes them to `recommend_jobs_aws`. There is deliberately no fallback to the stale Supabase matcher.
- **Delivery is being moved to Customer.io** (decision 2026-09-29): the dispatcher will send each user a `daily_job_matches` Track API event carrying their jobs, and a Customer.io campaign renders the email. Until then the schedule stays disabled.
- **Secrets:** Secrets Manager `jobply-email/<env>/supabase` holds `{ url, serviceKey, awsRdsUrl }` (plus a legacy `emailUnsubscribeSecret`), created outside CDK.
- **Application counts** live on Amazon RDS (source of truth), not Supabase `public.applications`.

## Gotchas

- **The `development` stack runs against real production users.** Profiles have no environment column, so `infra/app.ts` pins `ENVIRONMENT=production` for it (2026-07-28 drift incident). Don't "fix" this to `development`.
- **Paused is the default** (`cdk.json` → `enableDispatch: false`): the schedule is disabled and the handler exits immediately (`PRODUCTION_MODE=false`).
- **Remove AWS resources through CDK** (delete from `infra/email-stack.ts`, then `cdk deploy`), not the AWS CLI. The CLI is only for leftovers outside the stack; deleting stack resources directly breaks future deploys.
- The SES domain identity `jobply.ai` is intentionally kept; Supabase auth emails may send through it.
- **SQL migrations** live in `database/migrations/` (numbered files are the original schema, timestamped files are later changes). All target Supabase and are still the record of `email_internal` objects the dispatcher uses. Nothing in this repo applies them automatically.
- `@supabase/supabase-js` needs Node 22+ (native WebSocket), so the Lambda uses `NODEJS_22_X`. `pg-native` stays external in bundling.
- In Customer.io, do not start the "Re-engagement" campaign, and don't change segments in a way that would email all ~381 existing profiles at once. "Upgrade to Pro" is obsolete now that Jobply is free.
