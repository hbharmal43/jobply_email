-- Make bounded dispatcher scans advance across the full eligible population.
-- One-time journeys exclude users that already have a deduplicated email job.
-- Daily recommendations additionally record evaluated users with no matches,
-- so they do not occupy the first page for the rest of the UTC day.

alter table email_internal.email_jobs
  drop constraint if exists email_jobs_journey_key_check;

alter table email_internal.email_jobs
  add constraint email_jobs_journey_key_check
  check (journey_key in (
    'welcome', 'onboarding_abandoned', 'extension_nudge',
    'application_milestone', 'extension_feedback', 'account_deleted',
    'job_recommendations'
  ));

create table if not exists email_internal.email_candidate_scans (
  environment text not null
    check (environment in ('development', 'staging', 'production')),
  journey_key text not null,
  user_id uuid not null,
  scan_key text not null,
  scanned_at timestamptz not null default now(),
  primary key (environment, journey_key, user_id, scan_key)
);

revoke all on table email_internal.email_candidate_scans
  from public, anon, authenticated;

create or replace function public.mark_email_candidate_scanned(
  p_environment text,
  p_journey_key text,
  p_user_id uuid,
  p_scan_key text
) returns void
language sql
security definer
set search_path = email_internal, pg_temp
as $$
  insert into email_internal.email_candidate_scans (
    environment, journey_key, user_id, scan_key
  ) values (
    p_environment, p_journey_key, p_user_id, p_scan_key
  )
  on conflict (environment, journey_key, user_id, scan_key) do nothing;
$$;

create or replace function public.get_onboarding_abandoned_candidates(
  p_cutoff timestamptz,
  p_environment text default 'production',
  p_limit integer default 100
) returns table (
  user_id uuid,
  email text,
  first_name text
)
language sql
security definer
set search_path = public, email_internal, pg_temp
as $$
  select p.id, p.email, p.first_name
  from public.profiles p
  where p.onboarding_started_at is not null
    and p.onboarding_completed = false
    and p.onboarding_started_at < p_cutoff
    and p.email is not null
    and p.email <> ''
    and not exists (
      select 1
      from email_internal.email_jobs ej
      where ej.environment = p_environment
        and ej.journey_key = 'onboarding_abandoned'
        and ej.user_id = p.id
    )
  order by p.onboarding_started_at asc, p.id asc
  limit greatest(p_limit, 0);
$$;

create or replace function public.get_extension_nudge_candidates(
  p_cutoff timestamptz,
  p_environment text default 'production',
  p_limit integer default 100
) returns table (
  user_id uuid,
  email text,
  first_name text
)
language sql
security definer
set search_path = public, email_internal, pg_temp
as $$
  select p.id, p.email, p.first_name
  from public.profiles p
  where p.onboarding_completed = true
    and p.extension_installed_at is null
    and p.onboarding_completed_at is not null
    and p.onboarding_completed_at < p_cutoff
    and p.email is not null
    and p.email <> ''
    and not exists (
      select 1
      from email_internal.email_jobs ej
      where ej.environment = p_environment
        and ej.journey_key = 'extension_nudge'
        and ej.user_id = p.id
    )
  order by p.onboarding_completed_at asc, p.id asc
  limit greatest(p_limit, 0);
$$;

create or replace function public.get_application_milestone_candidates(
  p_cutoff timestamptz,
  p_environment text default 'production',
  p_limit integer default 100
) returns table (
  user_id uuid,
  email text,
  first_name text,
  application_count bigint
)
language sql
security definer
set search_path = public, email_internal, pg_temp
as $$
  with candidates as (
    select p.id, p.email, p.first_name, p.onboarding_completed_at
    from public.profiles p
    where p.onboarding_completed = true
      and p.onboarding_completed_at is not null
      and p.onboarding_completed_at < p_cutoff
      and p.email is not null
      and p.email <> ''
      and not exists (
        select 1
        from email_internal.email_jobs ej
        where ej.environment = p_environment
          and ej.journey_key = 'application_milestone'
          and ej.user_id = p.id
      )
    order by p.onboarding_completed_at asc, p.id asc
    limit greatest(p_limit, 0)
  )
  select c.id, c.email, c.first_name, count(a.user_id)
  from candidates c
  left join public.applications a on a.user_id = c.id
  group by c.id, c.email, c.first_name, c.onboarding_completed_at
  order by c.onboarding_completed_at asc, c.id asc;
$$;

create or replace function public.get_extension_feedback_candidates(
  p_threshold integer default 5,
  p_environment text default 'production',
  p_limit integer default 100
) returns table (
  user_id uuid,
  email text,
  first_name text
)
language sql
security definer
set search_path = public, email_internal, pg_temp
as $$
  select p.id, p.email, p.first_name
  from public.profiles p
  join public.applications a on a.user_id = p.id
  where p.extension_installed_at is not null
    and p.email is not null
    and p.email <> ''
    and not exists (
      select 1
      from email_internal.email_jobs ej
      where ej.environment = p_environment
        and ej.journey_key = 'extension_feedback'
        and ej.user_id = p.id
    )
  group by p.id, p.email, p.first_name, p.extension_installed_at
  having count(*) >= p_threshold
  order by p.extension_installed_at asc, p.id asc
  limit greatest(p_limit, 0);
$$;

create or replace function public.get_job_recommendation_candidates(
  p_environment text default 'production',
  p_scan_key text default timezone('UTC', now())::date::text,
  p_limit integer default 100
) returns table (
  user_id uuid,
  email text,
  first_name text,
  full_name text,
  title text
)
language sql
security definer
set search_path = public, email_internal, pg_temp
as $$
  select p.id, p.email, p.first_name, p.full_name, p.title
  from public.profiles p
  where p.email is not null
    and p.email <> ''
    and not exists (
      select 1
      from email_internal.email_jobs ej
      where ej.environment = p_environment
        and ej.dedupe_key =
          'job_recommendations:' || p.id::text || ':' || p_scan_key
    )
    and not exists (
      select 1
      from email_internal.email_candidate_scans ecs
      where ecs.environment = p_environment
        and ecs.journey_key = 'job_recommendations'
        and ecs.user_id = p.id
        and ecs.scan_key = p_scan_key
    )
  order by p.created_at desc, p.id asc
  limit greatest(p_limit, 0);
$$;

create or replace function public.authorize_email_send(
  p_job_id uuid
) returns table (authorized boolean, reason text, job email_internal.email_jobs)
language plpgsql
security definer
set search_path = email_internal, pg_temp
as $$
declare
  v_job email_internal.email_jobs;
  v_suppressed boolean;
  v_prefs email_internal.email_preferences;
begin
  select * into v_job
  from email_internal.email_jobs
  where id = p_job_id
  for update;

  if v_job.id is null then
    return query select false, 'not_found', v_job;
    return;
  end if;

  if v_job.status not in ('queued', 'retryable_failure') then
    return query select false, 'already_processed', v_job;
    return;
  end if;

  select exists (
    select 1
    from email_internal.email_suppressions
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

  select * into v_prefs
  from email_internal.email_preferences
  where user_id = v_job.user_id;

  if v_job.category = 'recommendations'
     and v_prefs.user_id is not null
     and (
       v_prefs.recommendations_enabled = false
       or v_prefs.lifecycle_enabled = false
     ) then
    update email_internal.email_jobs
    set status = 'cancelled',
        cancellation_reason = 'recommendations_disabled',
        cancelled_at = now(),
        updated_at = now()
    where id = v_job.id
    returning * into v_job;
    return query select false, 'cancelled_preference', v_job;
    return;
  elsif v_job.category <> 'transactional'
     and v_prefs.user_id is not null
     and v_prefs.lifecycle_enabled = false then
    update email_internal.email_jobs
    set status = 'cancelled',
        cancellation_reason = 'lifecycle_disabled',
        cancelled_at = now(),
        updated_at = now()
    where id = v_job.id
    returning * into v_job;
    return query select false, 'cancelled_preference', v_job;
    return;
  end if;

  if v_job.journey_key = 'onboarding_abandoned'
     and exists (
       select 1
       from email_internal.user_email_state ues
       where ues.user_id = v_job.user_id
         and ues.onboarding_completed_at is not null
     ) then
    update email_internal.email_jobs
    set status = 'cancelled',
        cancellation_reason = 'condition_no_longer_true',
        cancelled_at = now(),
        updated_at = now()
    where id = v_job.id
    returning * into v_job;
    return query select false, 'cancelled_condition_changed', v_job;
    return;
  elsif v_job.journey_key = 'extension_nudge'
     and exists (
       select 1
       from email_internal.user_email_state ues
       where ues.user_id = v_job.user_id
         and ues.extension_installed_at is not null
     ) then
    update email_internal.email_jobs
    set status = 'cancelled',
        cancellation_reason = 'condition_no_longer_true',
        cancelled_at = now(),
        updated_at = now()
    where id = v_job.id
    returning * into v_job;
    return query select false, 'cancelled_condition_changed', v_job;
    return;
  end if;

  update email_internal.email_jobs
  set status = 'sending',
      sending_started_at = now(),
      updated_at = now()
  where id = v_job.id
  returning * into v_job;

  return query select true, 'authorized', v_job;
end;
$$;

revoke all on function public.mark_email_candidate_scanned(text, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.get_onboarding_abandoned_candidates(timestamptz, text, integer)
  from public, anon, authenticated;
revoke all on function public.get_extension_nudge_candidates(timestamptz, text, integer)
  from public, anon, authenticated;
revoke all on function public.get_application_milestone_candidates(timestamptz, text, integer)
  from public, anon, authenticated;
revoke all on function public.get_extension_feedback_candidates(integer, text, integer)
  from public, anon, authenticated;
revoke all on function public.get_job_recommendation_candidates(text, text, integer)
  from public, anon, authenticated;

grant execute on function public.mark_email_candidate_scanned(text, text, uuid, text)
  to service_role;
grant execute on function public.get_onboarding_abandoned_candidates(timestamptz, text, integer)
  to service_role;
grant execute on function public.get_extension_nudge_candidates(timestamptz, text, integer)
  to service_role;
grant execute on function public.get_application_milestone_candidates(timestamptz, text, integer)
  to service_role;
grant execute on function public.get_extension_feedback_candidates(integer, text, integer)
  to service_role;
grant execute on function public.get_job_recommendation_candidates(text, text, integer)
  to service_role;
