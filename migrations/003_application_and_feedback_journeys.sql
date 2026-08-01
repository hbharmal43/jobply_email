-- =============================================================================
-- 003_application_and_feedback_journeys.sql  —  Part B (SES) journey expansion
-- Adds journey_key values + candidate-lookup RPCs for two new one-time
-- lifecycle emails:
--   application_milestone  — 3 days after onboarding completes, praises
--                             progress (template application_praise) or nudges
--                             a first application (template no_applications_nudge)
--   extension_feedback     — once a user has applied to >= threshold jobs via
--                             the extension, asks for feedback
--
-- Both candidate RPCs read public.profiles / public.applications directly
-- (not email_internal) because the dispatcher's supabase-js client can't
-- express a join+aggregate in one call — same reason claim_due_email_jobs
-- is a raw RPC rather than a query-builder call.
-- =============================================================================

alter table email_internal.email_jobs
  drop constraint email_jobs_journey_key_check;

alter table email_internal.email_jobs
  add constraint email_jobs_journey_key_check
  check (journey_key in (
    'welcome', 'onboarding_abandoned', 'extension_nudge',
    'application_milestone', 'extension_feedback'
  ));

-- ---------------------------------------------------------------------------
-- get_application_milestone_candidates — profiles that finished onboarding
-- before p_cutoff, with their total application count as of now.
-- ---------------------------------------------------------------------------
create or replace function public.get_application_milestone_candidates(
  p_cutoff timestamptz,
  p_limit  integer default 100
) returns table (
  user_id           uuid,
  email             text,
  first_name        text,
  application_count bigint
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.email, p.first_name, coalesce(a.application_count, 0)
  from public.profiles p
  left join (
    select user_id, count(*) as application_count
    from public.applications
    group by user_id
  ) a on a.user_id = p.id
  where p.onboarding_completed = true
    and p.onboarding_completed_at is not null
    and p.onboarding_completed_at < p_cutoff
    and p.email is not null
    and p.email <> ''
  order by p.onboarding_completed_at asc
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- get_extension_feedback_candidates — profiles with an installed extension
-- and at least p_threshold applications on record.
-- ---------------------------------------------------------------------------
create or replace function public.get_extension_feedback_candidates(
  p_threshold integer default 5,
  p_limit     integer default 100
) returns table (
  user_id    uuid,
  email      text,
  first_name text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.email, p.first_name
  from public.profiles p
  join (
    select user_id, count(*) as application_count
    from public.applications
    group by user_id
  ) a on a.user_id = p.id
  where p.extension_installed_at is not null
    and a.application_count >= p_threshold
    and p.email is not null
    and p.email <> ''
  order by p.extension_installed_at asc
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- Permissions — same model as the rest of this pipeline: revoke from
-- public/anon/authenticated, grant only to service_role.
-- ---------------------------------------------------------------------------
revoke all on function public.get_application_milestone_candidates(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.get_extension_feedback_candidates(integer, integer) from public, anon, authenticated;

grant execute on function public.get_application_milestone_candidates(timestamptz, integer) to service_role;
grant execute on function public.get_extension_feedback_candidates(integer, integer) to service_role;
