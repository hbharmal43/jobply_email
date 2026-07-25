-- =============================================================================
-- 002_email_jobs.sql  —  Part B (SES) outbound send pipeline
-- Tables: email_jobs, user_email_state
-- RPCs:   schedule_email_job, claim_due_email_jobs, mark_email_job_queued,
--         authorize_email_send, mark_email_job_sent, mark_email_job_failed,
--         cancel_email_jobs
--
-- Extends Part A (001_email_feedback.sql). Reuses its email_suppressions and
-- email_preferences tables as-is; adds the email_job_id FK on email_events
-- that Part A left as a TODO.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- email_jobs — durable scheduling + processing state for one message to one
-- recipient. Claimed via lease (lease_owner/lease_expires_at) so overlapping
-- dispatcher runs never double-send; scheduled_for + dedupe_key give safe
-- idempotent re-scheduling from any caller.
-- ---------------------------------------------------------------------------
create table if not exists email_internal.email_jobs (
  id                 uuid primary key default gen_random_uuid(),
  environment        text not null default 'production'
                       check (environment in ('development', 'staging', 'production')),
  user_id            uuid not null,
  recipient_email    text not null,
  journey_key        text not null check (journey_key in (
                       'welcome', 'onboarding_abandoned', 'extension_nudge'
                     )),
  template_key       text not null,
  template_version   integer not null default 1 check (template_version > 0),
  category           text not null default 'lifecycle'
                       check (category in ('transactional', 'lifecycle', 'recommendations', 'marketing')),
  payload            jsonb not null default '{}'::jsonb,
  scheduled_for      timestamptz not null default now(),
  status             text not null default 'pending' check (status in (
                       'pending', 'dispatching', 'queued', 'sending', 'sent',
                       'cancelled', 'suppressed', 'retryable_failure',
                       'permanent_failure', 'delivery_unknown'
                     )),
  dedupe_key         text not null,
  attempt_count      integer not null default 0,
  max_attempts       integer not null default 5,
  lease_owner        text,
  lease_expires_at   timestamptz,
  sqs_message_id     text,
  ses_message_id     text,
  last_error_code    text,
  last_error_message text,
  cancellation_reason text,
  dispatched_at      timestamptz,
  sending_started_at timestamptz,
  sent_at            timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (environment, dedupe_key)
);

create index if not exists email_jobs_due_idx
  on email_internal.email_jobs (scheduled_for)
  where status in ('pending', 'retryable_failure');

create index if not exists email_jobs_user_idx
  on email_internal.email_jobs (user_id, created_at desc);

create index if not exists email_jobs_lease_idx
  on email_internal.email_jobs (lease_expires_at)
  where status = 'dispatching';

create index if not exists email_jobs_ses_message_idx
  on email_internal.email_jobs (ses_message_id)
  where ses_message_id is not null;

-- email_events.email_job_id was left as a plain uuid in Part A pending this
-- table's existence — add the real FK now.
alter table email_internal.email_events
  add constraint email_events_email_job_id_fkey
  foreign key (email_job_id) references email_internal.email_jobs(id)
  on delete set null;

-- ---------------------------------------------------------------------------
-- user_email_state — cheap projection of the milestones the v1 journeys care
-- about, so the scan in claim_due_email_jobs doesn't have to join across
-- profiles/auth.users on every dispatcher run. Kept minimal for v1.
-- ---------------------------------------------------------------------------
create table if not exists email_internal.user_email_state (
  user_id                     uuid primary key,
  email_verified_at           timestamptz,
  onboarding_completed_at     timestamptz,
  extension_installed_at      timestamptz,
  updated_at                  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- schedule_email_job — idempotent job creation. Any trusted caller (Jobply
-- backend API routes, the dispatcher's own scan step) uses this. Returns the
-- new job id, or null if dedupe_key already exists (caller treats that as
-- "already scheduled", not an error).
-- ---------------------------------------------------------------------------
create or replace function public.schedule_email_job(
  p_user_id          uuid,
  p_recipient_email  text,
  p_journey_key      text,
  p_template_key     text,
  p_dedupe_key       text,
  p_category         text default 'lifecycle',
  p_payload          jsonb default '{}'::jsonb,
  p_scheduled_for    timestamptz default now(),
  p_environment      text default 'production'
) returns uuid
language plpgsql
security definer
set search_path = email_internal, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into email_internal.email_jobs (
    user_id, recipient_email, journey_key, template_key, category,
    payload, scheduled_for, dedupe_key, environment
  ) values (
    p_user_id, lower(trim(p_recipient_email)), p_journey_key, p_template_key, p_category,
    coalesce(p_payload, '{}'::jsonb), p_scheduled_for, p_dedupe_key, p_environment
  )
  on conflict (environment, dedupe_key) do nothing
  returning id into v_id;

  return v_id;  -- null means "already scheduled"
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_due_email_jobs — atomically leases up to p_limit due jobs so
-- concurrent/overlapping dispatcher runs can never claim the same row.
-- Expired leases (dispatcher died mid-run) are naturally reclaimable because
-- they're excluded only while lease_expires_at is still in the future.
-- ---------------------------------------------------------------------------
create or replace function public.claim_due_email_jobs(
  p_worker_id   text,
  p_limit       integer default 50,
  p_environment text default 'production'
) returns setof email_internal.email_jobs
language plpgsql
security definer
set search_path = email_internal, pg_temp
as $$
begin
  return query
  with candidates as (
    select ej.id
    from email_internal.email_jobs ej
    where ej.environment = p_environment
      and (
        (ej.status in ('pending', 'retryable_failure') and ej.scheduled_for <= now())
        or (ej.status = 'dispatching' and ej.lease_expires_at < now())
      )
      and ej.attempt_count < ej.max_attempts
    order by ej.scheduled_for asc
    for update skip locked
    limit p_limit
  )
  update email_internal.email_jobs ej
  set status = 'dispatching',
      lease_owner = p_worker_id,
      lease_expires_at = now() + interval '5 minutes',
      attempt_count = ej.attempt_count + 1,
      updated_at = now()
  from candidates c
  where ej.id = c.id
  returning ej.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_email_job_queued — dispatcher calls this after SQS confirms receipt.
-- ---------------------------------------------------------------------------
create or replace function public.mark_email_job_queued(
  p_job_id         uuid,
  p_sqs_message_id text
) returns void
language sql
security definer
set search_path = email_internal, pg_temp
as $$
  update email_internal.email_jobs
  set status = 'queued',
      sqs_message_id = p_sqs_message_id,
      dispatched_at = now(),
      updated_at = now()
  where id = p_job_id
    and status = 'dispatching';
$$;

-- ---------------------------------------------------------------------------
-- authorize_email_send — sender Lambda calls this immediately before
-- rendering/sending. Atomically rechecks eligibility and, if authorized,
-- transitions the job to 'sending' so a retry of the same SQS message can't
-- double-send once SES has accepted it.
-- Returns one row: (authorized boolean, reason text, job email_internal.email_jobs).
-- ---------------------------------------------------------------------------
create or replace function public.authorize_email_send(
  p_job_id uuid
) returns table (authorized boolean, reason text, job email_internal.email_jobs)
language plpgsql
security definer
set search_path = email_internal, pg_temp
as $$
declare
  v_job         email_internal.email_jobs;
  v_suppressed  boolean;
  v_prefs       email_internal.email_preferences;
begin
  select * into v_job from email_internal.email_jobs where id = p_job_id for update;

  if v_job.id is null then
    return query select false, 'not_found', v_job;
    return;
  end if;

  if v_job.status not in ('queued', 'retryable_failure') then
    return query select false, 'already_processed', v_job;
    return;
  end if;

  select exists (
    select 1 from email_internal.email_suppressions
    where normalized_email = lower(trim(v_job.recipient_email))
  ) into v_suppressed;

  if v_suppressed then
    update email_internal.email_jobs
    set status = 'suppressed', updated_at = now()
    where id = v_job.id
    returning * into v_job;
    return query select false, 'suppressed', v_job;
    return;
  end if;

  select * into v_prefs from email_internal.email_preferences where user_id = v_job.user_id;

  if v_job.category <> 'transactional'
     and v_prefs.user_id is not null
     and v_prefs.lifecycle_enabled = false then
    update email_internal.email_jobs
    set status = 'cancelled', cancellation_reason = 'lifecycle_disabled', cancelled_at = now(), updated_at = now()
    where id = v_job.id
    returning * into v_job;
    return query select false, 'cancelled_preference', v_job;
    return;
  end if;

  -- Journey-specific condition: still true at send time, not just at
  -- schedule time (e.g. don't send onboarding_abandoned if they finished
  -- onboarding in the last 24 hours).
  if v_job.journey_key = 'onboarding_abandoned' then
    if exists (
      select 1 from email_internal.user_email_state ues
      where ues.user_id = v_job.user_id and ues.onboarding_completed_at is not null
    ) then
      update email_internal.email_jobs
      set status = 'cancelled', cancellation_reason = 'condition_no_longer_true', cancelled_at = now(), updated_at = now()
      where id = v_job.id
      returning * into v_job;
      return query select false, 'cancelled_condition_changed', v_job;
      return;
    end if;
  elsif v_job.journey_key = 'extension_nudge' then
    if exists (
      select 1 from email_internal.user_email_state ues
      where ues.user_id = v_job.user_id and ues.extension_installed_at is not null
    ) then
      update email_internal.email_jobs
      set status = 'cancelled', cancellation_reason = 'condition_no_longer_true', cancelled_at = now(), updated_at = now()
      where id = v_job.id
      returning * into v_job;
      return query select false, 'cancelled_condition_changed', v_job;
      return;
    end if;
  end if;

  update email_internal.email_jobs
  set status = 'sending', sending_started_at = now(), updated_at = now()
  where id = v_job.id
  returning * into v_job;

  return query select true, 'authorized', v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_email_job_sent / mark_email_job_failed — sender Lambda calls exactly
-- one of these after the SES call resolves (or leaves the job in 'sending' /
-- flips it to 'delivery_unknown' on an ambiguous network outcome, handled by
-- the Lambda directly via a plain UPDATE since that's a degenerate case, not
-- a normal state transition worth its own RPC).
-- ---------------------------------------------------------------------------
create or replace function public.mark_email_job_sent(
  p_job_id        uuid,
  p_ses_message_id text
) returns void
language sql
security definer
set search_path = email_internal, pg_temp
as $$
  update email_internal.email_jobs
  set status = 'sent',
      ses_message_id = p_ses_message_id,
      sent_at = now(),
      updated_at = now()
  where id = p_job_id
    and status = 'sending';
$$;

create or replace function public.mark_email_job_failed(
  p_job_id     uuid,
  p_error_code text,
  p_error      text,
  p_permanent  boolean default false
) returns void
language sql
security definer
set search_path = email_internal, pg_temp
as $$
  update email_internal.email_jobs
  set status = case when p_permanent then 'permanent_failure' else 'retryable_failure' end,
      last_error_code = p_error_code,
      last_error_message = left(p_error, 2000),
      -- retry soon with a small fixed backoff; v1 doesn't need exponential
      -- backoff at this volume, just avoid hammering SES immediately
      scheduled_for = case when p_permanent then scheduled_for else now() + interval '5 minutes' end,
      updated_at = now()
  where id = p_job_id
    and status in ('sending', 'dispatching');
$$;

-- ---------------------------------------------------------------------------
-- cancel_email_jobs — cancel pending/queued jobs for a user + journey (e.g.
-- called when onboarding completes, or extension install is detected).
-- ---------------------------------------------------------------------------
create or replace function public.cancel_email_jobs(
  p_user_id     uuid,
  p_journey_key text,
  p_reason      text default 'condition_no_longer_true'
) returns integer
language plpgsql
security definer
set search_path = email_internal, pg_temp
as $$
declare
  v_count integer;
begin
  update email_internal.email_jobs
  set status = 'cancelled', cancellation_reason = p_reason, cancelled_at = now(), updated_at = now()
  where user_id = p_user_id
    and journey_key = p_journey_key
    and status in ('pending', 'queued', 'retryable_failure');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissions — same model as Part A: revoke from public/anon/authenticated,
-- grant only to service_role.
-- ---------------------------------------------------------------------------
revoke all on function public.schedule_email_job(uuid, text, text, text, text, text, jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.claim_due_email_jobs(text, integer, text) from public, anon, authenticated;
revoke all on function public.mark_email_job_queued(uuid, text) from public, anon, authenticated;
revoke all on function public.authorize_email_send(uuid) from public, anon, authenticated;
revoke all on function public.mark_email_job_sent(uuid, text) from public, anon, authenticated;
revoke all on function public.mark_email_job_failed(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.cancel_email_jobs(uuid, text, text) from public, anon, authenticated;

grant execute on function public.schedule_email_job(uuid, text, text, text, text, text, jsonb, timestamptz, text) to service_role;
grant execute on function public.claim_due_email_jobs(text, integer, text) to service_role;
grant execute on function public.mark_email_job_queued(uuid, text) to service_role;
grant execute on function public.authorize_email_send(uuid) to service_role;
grant execute on function public.mark_email_job_sent(uuid, text) to service_role;
grant execute on function public.mark_email_job_failed(uuid, text, text, boolean) to service_role;
grant execute on function public.cancel_email_jobs(uuid, text, text) to service_role;
