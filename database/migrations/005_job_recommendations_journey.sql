-- =============================================================================
-- 005_job_recommendations_journey.sql  —  Part B (SES) Job Recommendations Digest
-- Adds journey_key value 'job_recommendations' + candidate-lookup RPC for
-- personalized daily/periodic job recommendation digest emails powered by
-- Supabase semantic matching (recommend_jobs_for_user_v3).
-- =============================================================================

alter table email_internal.email_jobs
  drop constraint email_jobs_journey_key_check;

alter table email_internal.email_jobs
  add constraint email_jobs_journey_key_check
  check (journey_key in (
    'welcome', 'onboarding_abandoned', 'extension_nudge',
    'application_milestone', 'extension_feedback',
    'job_recommendations'
  ));

-- ---------------------------------------------------------------------------
-- get_job_recommendation_candidates — active profiles with valid email addresses
-- ---------------------------------------------------------------------------
create or replace function public.get_job_recommendation_candidates(
  p_limit integer default 100
) returns table (
  user_id    uuid,
  email      text,
  first_name text,
  full_name  text,
  title      text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.email, p.first_name, p.full_name, p.title
  from public.profiles p
  where p.email is not null
    and p.email <> ''
  order by p.created_at desc
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- authorize_email_send update — ensures category = 'recommendations' checks
-- email_preferences.recommendations_enabled
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

  if v_job.category = 'recommendations'
     and v_prefs.user_id is not null
     and (v_prefs.recommendations_enabled = false or v_prefs.lifecycle_enabled = false) then
    update email_internal.email_jobs
    set status = 'cancelled', cancellation_reason = 'recommendations_disabled', cancelled_at = now(), updated_at = now()
    where id = v_job.id
    returning * into v_job;
    return query select false, 'cancelled_preference', v_job;
    return;
  elsif v_job.category <> 'transactional'
     and v_prefs.user_id is not null
     and v_prefs.lifecycle_enabled = false then
    update email_internal.email_jobs
    set status = 'cancelled', cancellation_reason = 'lifecycle_disabled', cancelled_at = now(), updated_at = now()
    where id = v_job.id
    returning * into v_job;
    return query select false, 'cancelled_preference', v_job;
    return;
  end if;

  -- Journey-specific conditions
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
-- Permissions
-- ---------------------------------------------------------------------------
revoke all on function public.get_job_recommendation_candidates(integer) from public, anon, authenticated;
grant execute on function public.get_job_recommendation_candidates(integer) to service_role;
