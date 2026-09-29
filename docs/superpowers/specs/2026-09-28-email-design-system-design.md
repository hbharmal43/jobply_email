# Jobply Email Design System — Design

**Date:** 2026-09-28
**Status:** Draft, awaiting review
**Sub-project:** 1 of 5 in the SES → Customer.io migration (see "Roadmap" below)

## Goal

Every email Jobply sends looks like it came from the same product as jobply.ai,
and any new email (a feature announcement, a one-off) can be assembled from
shared pieces without the look drifting.

Success means:

- One set of brand styles and one set of shared components in Customer.io
  Design Studio, used by every email.
- The four existing emails rebuilt from those components.
- Changing a shared component (e.g. the footer) updates every email that uses it
  on its next publish.

## Context (review of workspace 231518, 2026-09-28)

- Brand source of truth: `jobply_website/DESIGN.md` — yellow `#ffde59` is the
  brand, used on CTAs, underlines, borders; black `#0A0A0A` text on white;
  Outfit (display), Geist Sans (body), JetBrains Mono (numbers/stats);
  16px base radius; emoji accents allowed.
- Design Studio global styles are still Customer.io defaults (Helvetica, black
  buttons, blue underlined links, 4px radius). No custom components exist.
- The four live emails (Welcome, Onboarding Nudge, Upgrade to Pro,
  Re-engagement) hard-code colors per email, are black/white in light mode,
  use a slightly different yellow (`#fed049`) only in dark mode, and 8px radius.
- Footers say "Jobply, Inc." (entity is Jobply LLC) and have no postal address
  (required by CAN-SPAM).
- No link has UTM parameters.

## Approach

Build natively in Customer.io Design Studio via the API (no manual editor work).
Design Studio markup compiles to email-safe HTML; building there (rather than
raw HTML files) is what gives shared, reusable components.

A snapshot of the tokens and component sources is kept in this repo under
`email-design-system/` for version history. Customer.io is the live source;
the repo snapshot is updated whenever a component changes.

## 1. Brand tokens (Design Studio global styles)

| Token | Value | Notes |
|---|---|---|
| `brand-yellow` | `#ffde59` | CTAs, accent bars, highlights, stat emphasis |
| `brand-yellow-tint` | `#FFF9E6` | Soft highlight panels (matches site sidebar) |
| `ink` | `#0A0A0A` | Primary text, text on yellow |
| `ink-muted` | `#757575` | Secondary text, metadata |
| `surface` | `#FFFFFF` | Email card background |
| `canvas` | `#FAFAF7` | Area behind the card (warm off-white) |
| `border` | `#E5E5E5` | Dividers, card borders |
| `success` | `#22C55E` / bg `#DCFCE7` | "Applied", positive stats |
| Dark mode | canvas `#0F0E0C`, surface `#1A1A1A`, text `#FAFAFA`, muted `#A3A3A3`, yellow unchanged | |

Typography (each with an email-safe fallback — Gmail ignores web fonts):

- Headings: `Outfit, Arial, Helvetica, sans-serif`, weight 800
- Body: `Geist, -apple-system, Segoe UI, Arial, sans-serif`, 16px / 1.6
- Numbers & stats: `JetBrains Mono, Menlo, Consolas, monospace`, weight 700

Other: radius 16px (cards), 12px (buttons); links `ink` with yellow underline;
default button = yellow background, `ink` text.

## 2. Shared components

All are Design Studio custom components (`<script>` + `<template>`, one `#root`),
grouped under an insert-menu section named **Jobply**.

| Tag | Purpose | Editable props / slots |
|---|---|---|
| `jobply-header` | Logo band + thin yellow accent bar | none (fixed) |
| `jobply-footer` | "Jobply LLC · 1020 W Abram St, Arlington, TX 76013", Privacy · Terms · Unsubscribe (`{% unsubscribe_url %}`) | none (fixed — compliance) |
| `jobply-button` | Primary CTA | `href`, text slot, `variant` (yellow / dark) |
| `jobply-eyebrow-heading` | Small uppercase label + big Outfit headline, optional yellow underline on a key word | label text, heading text slot |
| `jobply-stat` | Big mono number + label, e.g. "**5** applications this week" | `value` (accepts Liquid), `label`, `tone` (yellow / green) |
| `jobply-job-card` | Company initial, title, company · location, match % pill, "View job" link | `title`, `company`, `location`, `match`, `href` (all accept Liquid, so it works inside a `{% for %}` loop over recommended jobs) |
| `jobply-callout` | Yellow-tint panel for a motivation line or tip | any-content slot |
| `jobply-feature` | Feature announcement block: emoji/icon, title, body, optional image | `icon`, `title`, body slot, `image` |
| `jobply-steps` | Numbered steps (yellow number circles) | list items |

`jobply-header` and `jobply-footer` are fixed on purpose: no one can edit the
legal footer per email.

Link tracking: every email enables Design Studio's URL-parameter transformer
with `utm_source=customerio&utm_medium=email&utm_campaign=<email-slug>`.
Customer.io's own click tracking stays on.

## 3. Rebuild the four existing emails

Rebuild each linked Design Studio email in place (same UUID, so the campaign
links stay intact), using only the shared components. Copy is kept close to the
current copy, with these fixes:

- "Jobply, Inc." → "Jobply LLC" (via the shared footer).
- Welcome: remove the "thousands of job seekers" claim unless confirmed true.
- Light mode becomes yellow-forward per `DESIGN.md`.

Rollout safety:

- **Welcome** is live. Its rebuilt version is published only after the user
  approves a test send.
- **Upgrade to Pro, Onboarding Nudge, Re-engagement**: only the email content
  changes. Their triggers are **not** changed in this sub-project (see Out of
  scope), and the two stopped campaigns stay stopped.

## 4. Verification

For every component and email:

1. Component definitions parse with no `error`/`warnings`
   (`GET /ds/component_definitions`).
2. Each email renders non-empty (`GET /design_studio/emails/{id}/render`).
3. Customer.io email review / accessibility check passes with no blocking
   findings.
4. Test send of each email to `hasnain@jobply.ai`; the user checks Gmail
   (web + mobile) and Apple Mail, light and dark mode.
5. Nothing is published to a live campaign until step 4 is approved.

## Out of scope (later sub-projects)

- Fixing campaign triggers: Upgrade to Pro's segment watches `plan_name`
  instead of `subscription_tier`; Re-engagement relies on page-view events that
  are never sent (would email all 381 people on start); Onboarding Nudge has no
  delay. Fixed in sub-project 2 when live data sync exists, because changing
  the segments now would email the whole existing list at once.
- New emails (daily recommendations, motivation, milestone, feature launches).
  They'll be built from these components in sub-projects 4–5.
- Tracking-domain DNS (`CNAME email.jobply.ai → e-trk.customeriomail.com`):
  user action, independent of this work.

## Roadmap (all sub-projects)

1. **Email design system** (this spec)
2. Move to Customer.io: live profile/event sync, welcome via DB trigger,
   remove sender/feedback Lambdas + SQS + SES config, fix campaign triggers
3. Application count from RDS synced to Customer.io
4. Daily recommendations at each user's chosen time + per-job click tracking
5. Campaigns: win-back, motivation, milestones, feature-announcement workflow
