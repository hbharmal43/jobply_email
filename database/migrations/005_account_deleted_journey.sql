-- =============================================================================
-- 005_account_deleted_journey.sql — Part B (SES) journey expansion
-- Adds the account_deleted journey_key: a one-off transactional confirmation
-- scheduled synchronously by jobply_website's /api/account/delete route
-- (same pattern as 'welcome' from /api/auth/post-login), not scanned for by
-- the dispatcher. category is 'transactional' so authorize_email_send skips
-- the lifecycle_enabled preference check — by send time the profile row
-- (and its email_preferences row) is already gone.
-- =============================================================================

alter table email_internal.email_jobs
  drop constraint email_jobs_journey_key_check;

alter table email_internal.email_jobs
  add constraint email_jobs_journey_key_check
  check (journey_key in (
    'welcome', 'onboarding_abandoned', 'extension_nudge',
    'application_milestone', 'extension_feedback', 'account_deleted'
  ));
