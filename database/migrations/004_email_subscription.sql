-- =============================================================================
-- 004_email_subscription.sql  —  Subscribe / unsubscribe RPCs
-- Adds the two RPCs backing the "Manage subscription" link in every lifecycle
-- email footer. Reuses email_internal.email_preferences as-is (already
-- checked by authorize_email_send in 002_email_jobs.sql) — no changes to the
-- send-authorization path itself.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- set_email_subscription — upserts lifecycle_enabled for a user. Called by
-- jobply_website's /api/email/unsubscribe route after verifying the
-- signed unsubscribe-link token.
-- ---------------------------------------------------------------------------
create or replace function public.set_email_subscription(
  p_user_id uuid,
  p_enabled boolean
) returns email_internal.email_preferences
language plpgsql
security definer
set search_path = email_internal, pg_temp
as $$
declare
  v_row email_internal.email_preferences;
begin
  insert into email_internal.email_preferences (user_id, lifecycle_enabled, unsubscribed_at)
  values (p_user_id, p_enabled, case when p_enabled then null else now() end)
  on conflict (user_id) do update
    set lifecycle_enabled = excluded.lifecycle_enabled,
        unsubscribed_at   = excluded.unsubscribed_at,
        updated_at        = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_email_subscription — read-only status lookup for the unsubscribe page.
-- No row yet means "subscribed" (matches authorize_email_send's default:
-- absence of a preferences row does not block sending), so synthesize one.
-- ---------------------------------------------------------------------------
create or replace function public.get_email_subscription(
  p_user_id uuid
) returns email_internal.email_preferences
language plpgsql
security definer
set search_path = email_internal, pg_temp
as $$
declare
  v_row email_internal.email_preferences;
begin
  select * into v_row from email_internal.email_preferences where user_id = p_user_id;

  if v_row.user_id is null then
    v_row.user_id := p_user_id;
    v_row.lifecycle_enabled := true;
    v_row.unsubscribed_at := null;
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissions — same model as the rest of this pipeline: revoke from
-- public/anon/authenticated, grant only to service_role. The website route
-- authenticates the caller itself (signed token verification) before ever
-- invoking these with its service-role key.
-- ---------------------------------------------------------------------------
revoke all on function public.set_email_subscription(uuid, boolean) from public, anon, authenticated;
revoke all on function public.get_email_subscription(uuid) from public, anon, authenticated;

grant execute on function public.set_email_subscription(uuid, boolean) to service_role;
grant execute on function public.get_email_subscription(uuid) to service_role;
