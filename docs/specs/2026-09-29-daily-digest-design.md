# Daily Job Digest — Design

**Date:** 2026-09-29
**Status:** Design final (2026-09-29); preview `emails/daily-digest/preview.html` is the approved reference
**Goal:** bring users back to Jobply every day (monthly active users). Every click lands inside the app.

## Flow

```
Scheduler 9:00 AM America/Chicago
  → recommendation dispatcher Lambda
      1. candidates (Supabase) → top 15 matches per user (Typesense "For You" search, jobs posted in the last 3 days; replaced embeddings on 2026-10-20)
      2. drop jobs the user already applied to (RDS applications, by id and posting URL); historical note: under embeddings, freshness was
         already built into its score (similarity × 7-day half-life decay), so there's no extra dedupe or cutoff
      3. skip the user if fewer than 3 jobs remain
      4. application counts from RDS `applications`: total, last 7 days, status = interview
      5. record the dedupe row (schedule_email_job, key job_recommendations:<user>:<UTC date>)
      6. Customer.io Track API event `daily_job_matches` (payload below)
  → Customer.io campaign triggered by the event → subject A/B split → email
```

Per-user send times are out of scope for v1.

## Event payload (`daily_job_matches`)

The dispatcher pre-formats everything so the template's Liquid stays simple.

```json
{
  "date_label": "Tuesday, Sep 29",
  "jobs": [
    {
      "id": "…", "rank": 1, "title": "Senior Data Analyst", "company": "Stripe",
      "location": "New York, NY", "work_arrangement": "Hybrid",
      "salary": "$120,000 - $150,000", "match_pct": 92,
      "url": "https://jobply.ai/dashboard/jobs/<id>?utm_source=customerio&utm_medium=email&utm_campaign=daily_digest&utm_content=job_1"
    }
  ],
  "job_count": 5,
  "more_count": 5,
  "applied_total": 12,
  "applied_7d": 4,
  "interviews": 0,
  "headline_index": 3
}
```

`salary` and `work_arrangement` may be null. `match_pct` is an integer from 0 to 100, normalized by the dispatcher.

## Email

Branded (same system as Welcome), using the "ply" brand voice. The sections, top to bottom:

- **Header:** logo and date.
- **Headline:** rotates daily through a 14-line pool (see the preview). The first name gets the yellow highlighter, and its position varies. With no first name, the name part is dropped. The dispatcher picks `headline_index` so nobody sees the same line two days running. The line under the headline reads "{job_count} fresh roles that fit you. **You miss 100% of the jobs you don't ply.**"
- **Motivation strip,** chosen by the counts:
  - `interviews > 0` (green): "{interviews} 🎉 of your plies are at the interview stage."
  - else `applied_7d > 0`: "{applied_7d} plies this week. Keep the streak going. One more today?"
  - else `applied_total = 0`: "🚀 Your first ply is one click away."
  - else: "☕ Quiet week? One ply today keeps your search moving."
- **Branded GIF:** a bar filling from Apply → Interview → Offer, then confetti (`emails/daily-digest/assets/progress.gif`, hosted in Customer.io assets).
- **Up to 5 job cards:** company initial, company, title, location, work-arrangement badge, salary pill (if any), match % pill, and a "Ply this job →" button. The title and the button both link to the job's `url`.
- **"See {more_count} more matches in Jobply →"** to `/dashboard/jobs/recommended` with UTM tags. It's hidden when `more_count = 0`.
- **One-tap check-in:** "How's the job hunt feeling today?" with 😩 Rough / 😐 Meh / 🔥 On fire. Each option links to `/dashboard/jobs/recommended?utm_content=mood_<value>`, so Customer.io records it as a tracked click.
- **Footer:** the same compliant footer as Welcome.
- Every link has `target="_blank" rel="noopener"`.

## Subject A/B (50/50)

- **A:** "{jobs[0].title} at {jobs[0].company} + {job_count - 1} more matches for you"
- **B:** "{job_count} fresh jobs to ply today"

Judge the winner on clicks as well as opens.

## Tracking

Customer.io link tracking records each click with its full URL, so `utm_content=job_<rank>` and the job ID in the path identify exactly which job was clicked. The site sees the same UTM tags when the user lands.

## Open items (before going live)

- The Customer.io Track API Site ID and API key, stored in the AWS secret as `cioSiteId` and `cioApiKey`.
- Website: logged-out clicks should return to the clicked job after sign-in (`?next=`), owned by the user.
