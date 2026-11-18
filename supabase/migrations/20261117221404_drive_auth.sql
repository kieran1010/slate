-- =============================================================================
-- drive_auth: storage for the google-drive-auth Edge Function (Hypnos suite).
-- -----------------------------------------------------------------------------
-- One row per (device, app) that has connected Google Drive for background
-- sync. `sealed_grant` is that device's long-lived Google permission (refresh
-- token), encrypted with AES-GCM under a key derived from a secret that only
-- the device holds - so this table on its own cannot unlock anything. No names,
-- email addresses or health data are stored.
--
-- The schema is not exposed through the Data API. The Edge Function reaches it
-- only through the public.drive_auth_* functions below, which only the
-- service role (the project's server-side key) may execute.
-- =============================================================================

create schema if not exists drive_auth;
revoke all on schema drive_auth from public, anon, authenticated;

create table if not exists drive_auth.devices (
    id            uuid primary key,
    app           text not null,
    sealed_grant  text not null,
    created_at    timestamptz not null default now(),
    last_used_at  timestamptz not null default now(),
    last_token_at timestamptz,
    constraint devices_app_format check (app ~ '^[a-z0-9-]{1,32}$'),
    constraint devices_sealed_size check (length(sealed_grant) between 32 and 4096)
);

alter table drive_auth.devices enable row level security;
-- No policies: nothing but the definer functions below may touch it.
revoke all on drive_auth.devices from public, anon, authenticated;

-- Store a newly connected device.
create or replace function public.drive_auth_register(p_id uuid, p_app text, p_sealed text)
returns void
language sql
security definer
set search_path = ''
as $$
    insert into drive_auth.devices (id, app, sealed_grant) values (p_id, p_app, p_sealed);
$$;

-- Fetch a device's sealed permission for a sign-in, at most once per
-- p_min_interval_seconds (raises RATE_LIMITED otherwise), and record the use.
-- Raises UNKNOWN_DEVICE if there is no such device for this app.
create or replace function public.drive_auth_claim(p_id uuid, p_app text, p_min_interval_seconds integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_sealed text;
    v_last   timestamptz;
begin
    select sealed_grant, last_token_at into v_sealed, v_last
      from drive_auth.devices
     where id = p_id and app = p_app
       for update;
    if not found then
        raise exception 'UNKNOWN_DEVICE';
    end if;
    if v_last is not null and v_last > now() - make_interval(secs => p_min_interval_seconds) then
        raise exception 'RATE_LIMITED';
    end if;
    update drive_auth.devices set last_token_at = now(), last_used_at = now() where id = p_id;
    return v_sealed;
end;
$$;

-- Fetch a device's sealed permission without rate limiting or recording a
-- sign-in (used to disconnect, which must always be possible).
create or replace function public.drive_auth_peek(p_id uuid, p_app text)
returns text
language sql
security definer
set search_path = ''
as $$
    select sealed_grant from drive_auth.devices where id = p_id and app = p_app;
$$;

-- Forget a device (disconnected, or Google no longer honours its permission).
create or replace function public.drive_auth_forget(p_id uuid, p_app text)
returns void
language sql
security definer
set search_path = ''
as $$
    delete from drive_auth.devices where id = p_id and app = p_app;
$$;

-- Remove devices unused for over 7 months: Google drops a permission that
-- hasn't been used for six months, so these can no longer work anyway.
create or replace function public.drive_auth_prune()
returns integer
language sql
security definer
set search_path = ''
as $$
    with gone as (
        delete from drive_auth.devices where last_used_at < now() - interval '7 months' returning 1
    )
    select count(*)::integer from gone;
$$;

do $$
declare f text;
begin
    foreach f in array array[
        'public.drive_auth_register(uuid, text, text)',
        'public.drive_auth_claim(uuid, text, integer)',
        'public.drive_auth_peek(uuid, text)',
        'public.drive_auth_forget(uuid, text)',
        'public.drive_auth_prune()'
    ] loop
        execute format('revoke execute on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to service_role', f);
    end loop;
end $$;
