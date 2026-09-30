-- =============================================================================
-- 001_email_feedback.sql  —  Part A (SES) feedback ingestion
-- Tables: email_events, email_suppressions, email_preferences
-- RPC:    email_api.record_email_feedback  (idempotent, monotonic, auto-suppress)
--
-- This migration is self-contained: it does NOT depend on Part B's email_jobs
-- table. email_job_id is stored as a plain uuid for now; the FK + job-status
-- reconciliation are added when Part B lands.
-- =============================================================================

create schema if not exists email_internal;
-- The RPC lives in the already-exposed `public` schema so no Data API setting
-- change is needed. Security comes from the GRANTs below (service_role only),
-- not from the schema — tables stay hidden in email_internal.

-- ---------------------------------------------------------------------------
-- email_events — append-only, normalized provider + application events
-- ---------------------------------------------------------------------------
create table if not exists email_internal.email_events (
  id                 bigint generated always as identity primary key,
  email_job_id       uuid,          -- FK to email_internal.email_jobs added with Part B
  user_id            uuid,
  ses_message_id     text,
  event_type         text not null check (event_type in (
                       'job_created','job_cancelled','send_requested','send_accepted',
                       'delivered','delivery_delayed','opened','clicked','bounced',
                       'complained','rejected','rendering_failed','subscription_changed'
                     )),
  event_at           timestamptz not null,
  provider_event_key text not null,
  metadata           jsonb not null default '{}'::jsonb,
  raw_payload        jsonb,
  created_at         timestamptz not null default now(),
  unique (provider_event_key)       -- idempotency: one row per provider event
);

create index if not exists email_events_job_idx
  on email_internal.email_events (email_job_id, event_at desc);
create index if not exists email_events_user_idx
  on email_internal.email_events (user_id, event_at desc);
create index if not exists email_events_type_time_idx
  on email_internal.email_events (event_type, event_at desc);

-- ---------------------------------------------------------------------------
-- email_suppressions — product-level do-not-send list
-- ---------------------------------------------------------------------------
create table if not exists email_internal.email_suppressions (
  normalized_email text primary key,
  reason           text not null check (reason in (
                     'hard_bounce','complaint','manual','invalid_address','global_unsubscribe')),
  source           text not null,
  ses_message_id   text,
  suppressed_at    timestamptz not null default now(),
  review_after     timestamptz,
  notes            text
);

-- ---------------------------------------------------------------------------
-- email_preferences — per-user optional-email choices
-- ---------------------------------------------------------------------------
create table if not exists email_internal.email_preferences (
  user_id                 uuid primary key,
  lifecycle_enabled       boolean not null default true,
  recommendations_enabled boolean not null default true,
  weekly_digest_enabled   boolean not null default false,
  marketing_enabled       boolean not null default false,
  locale                  text not null default 'en-US',
  timezone                text not null default 'UTC',
  quiet_hours_start       time,
  quiet_hours_end         time,
  preference_version      integer not null default 1,
  unsubscribed_at         timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- record_email_feedback — called by the Feedback Lambda for each SES event.
--   * Idempotent: duplicate provider events are ignored (unique key).
--   * Side effects only fire on first sighting of an event.
--   * Permanent bounce  -> hard_bounce suppression.
--   * Complaint         -> complaint suppression (overrides).
-- Returns 'recorded' | 'duplicate_ignored'.
-- ---------------------------------------------------------------------------
create or replace function public.record_email_feedback(
  p_provider_event_key text,
  p_event_type         text,
  p_event_at           timestamptz,
  p_ses_message_id     text  default null,
  p_email_job_id       uuid  default null,
  p_user_id            uuid  default null,
  p_recipient_email    text  default null,
  p_metadata           jsonb default '{}'::jsonb,
  p_raw_payload        jsonb default null
) returns text
language plpgsql
security definer
set search_path = email_internal, pg_temp
as $$
declare
  v_rows       integer := 0;
  v_norm_email text := nullif(lower(trim(p_recipient_email)), '');
begin
  insert into email_internal.email_events (
    email_job_id, user_id, ses_message_id, event_type, event_at,
    provider_event_key, metadata, raw_payload
  ) values (
    p_email_job_id, p_user_id, p_ses_message_id, p_event_type, p_event_at,
    p_provider_event_key, coalesce(p_metadata, '{}'::jsonb), p_raw_payload
  )
  on conflict (provider_event_key) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'duplicate_ignored';           -- already processed
  end if;

  -- First time we've seen this event -> apply side effects.
  if v_norm_email is not null then
    if p_event_type = 'complained' then
      insert into email_internal.email_suppressions
        (normalized_email, reason, source, ses_message_id)
      values (v_norm_email, 'complaint', 'ses_feedback', p_ses_message_id)
      on conflict (normalized_email) do update
        set reason = 'complaint', source = 'ses_feedback',
            ses_message_id = excluded.ses_message_id, suppressed_at = now();

    elsif p_event_type = 'bounced'
          and coalesce(p_metadata->>'bounce_type', '') = 'Permanent' then
      insert into email_internal.email_suppressions
        (normalized_email, reason, source, ses_message_id)
      values (v_norm_email, 'hard_bounce', 'ses_feedback', p_ses_message_id)
      on conflict (normalized_email) do nothing;  -- never downgrade a complaint
    end if;
  end if;

  -- TODO (Part B): once email_internal.email_jobs exists, monotonically update
  -- the job's status/timestamps here and cancel pending optional jobs for a
  -- suppressed recipient.

  return 'recorded';
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissions — only the service_role key can run this function. The `public`
-- schema is exposed, but anon/authenticated users are explicitly denied, so the
-- function is unreachable from browsers/extensions. Tables live in the
-- unexposed email_internal schema. Call it with:
--   supabase.rpc('record_email_feedback', {...})   // uses the service_role key
-- ---------------------------------------------------------------------------
revoke all on function public.record_email_feedback(
  text, text, timestamptz, text, uuid, uuid, text, jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.record_email_feedback(
  text, text, timestamptz, text, uuid, uuid, text, jsonb, jsonb
) to service_role;
