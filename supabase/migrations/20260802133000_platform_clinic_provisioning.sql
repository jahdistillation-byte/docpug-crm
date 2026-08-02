create or replace function public.provision_clinic(
  p_name text,
  p_subtitle text,
  p_phone text,
  p_address text,
  p_website text,
  p_theme text,
  p_owner_username text,
  p_owner_display_name text,
  p_password_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  new_org_id uuid;
  new_owner_id uuid;
  clean_name text := nullif(trim(p_name), '');
  clean_username text := lower(nullif(trim(p_owner_username), ''));
  clean_owner_name text := nullif(trim(p_owner_display_name), '');
  clean_theme text := lower(coalesce(nullif(trim(p_theme), ''), 'purple'));
begin
  if clean_name is null or char_length(clean_name) > 160 then
    raise exception using
      errcode = '22023',
      message = 'CLINIC_NAME_INVALID';
  end if;

  if clean_username is null
     or char_length(clean_username) < 3
     or char_length(clean_username) > 80
     or clean_username !~ '^[a-z0-9][a-z0-9._-]*$' then
    raise exception using
      errcode = '22023',
      message = 'OWNER_USERNAME_INVALID';
  end if;

  if clean_owner_name is null or char_length(clean_owner_name) > 160 then
    raise exception using
      errcode = '22023',
      message = 'OWNER_NAME_INVALID';
  end if;

  if clean_theme not in ('purple', 'black', 'white', 'blue', 'green') then
    raise exception using
      errcode = '22023',
      message = 'CLINIC_THEME_INVALID';
  end if;

  if p_password_hash is null or char_length(p_password_hash) < 40 then
    raise exception using
      errcode = '22023',
      message = 'PASSWORD_HASH_INVALID';
  end if;

  if exists (
    select 1
    from public.clinic_users
    where lower(username) = clean_username
  ) then
    raise exception using
      errcode = '23505',
      message = 'OWNER_USERNAME_EXISTS';
  end if;

  insert into public.orgs (
    name,
    subtitle,
    phone,
    address,
    website,
    theme
  )
  values (
    clean_name,
    nullif(trim(p_subtitle), ''),
    nullif(trim(p_phone), ''),
    nullif(trim(p_address), ''),
    nullif(trim(p_website), ''),
    clean_theme
  )
  returning id into new_org_id;

  insert into public.clinic_users (
    org_id,
    username,
    password_plain,
    password_hash,
    role,
    display_name,
    is_active,
    must_change_password
  )
  values (
    new_org_id,
    clean_username,
    null,
    p_password_hash,
    'owner',
    clean_owner_name,
    true,
    true
  )
  returning id into new_owner_id;

  insert into public.financial_accounts (
    org_id,
    name,
    account_type,
    system_key,
    currency,
    is_default,
    is_active,
    created_by
  )
  values
    (new_org_id, 'Готівкова каса', 'cash', 'cash', 'UAH', true, true, new_owner_id),
    (new_org_id, 'Банківський рахунок', 'bank', 'bank', 'UAH', true, true, new_owner_id),
    (new_org_id, 'Термінал', 'terminal', 'terminal', 'UAH', true, true, new_owner_id),
    (new_org_id, 'Сейф', 'safe', 'safe', 'UAH', true, true, new_owner_id),
    (new_org_id, 'Інший рахунок', 'other', 'other', 'UAH', true, true, new_owner_id);

  insert into public.clinic_report_settings (
    org_id,
    daily_enabled,
    daily_time,
    timezone,
    updated_by
  )
  values (
    new_org_id,
    false,
    '21:00:00',
    'Europe/Kyiv',
    new_owner_id
  );

  return jsonb_build_object(
    'org_id', new_org_id,
    'owner_user_id', new_owner_id,
    'clinic_name', clean_name,
    'owner_username', clean_username,
    'theme', clean_theme,
    'financial_accounts_created', 5,
    'report_settings_created', true
  );
end;
$function$;

revoke execute on function public.provision_clinic(
  text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.provision_clinic(
  text, text, text, text, text, text, text, text, text
) to service_role;

comment on function public.provision_clinic(
  text, text, text, text, text, text, text, text, text
) is 'Server-only atomic provisioning of a clinic, its first owner, finance accounts, and report settings.';
