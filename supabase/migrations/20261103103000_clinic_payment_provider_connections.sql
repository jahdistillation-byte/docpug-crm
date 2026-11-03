create table if not exists public.payment_provider_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null check (provider = 'monobank'),
  status text not null default 'connected'
    check (status in ('connected', 'disabled', 'error')),
  vault_secret_id uuid not null,
  credentials_hint text not null default '',
  merchant_id text,
  merchant_name text,
  merchant_edrpou text,
  last_checked_at timestamptz,
  last_error text,
  created_by uuid references public.clinic_users(id) on delete set null,
  updated_by uuid references public.clinic_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider)
);

comment on table public.payment_provider_connections is
  'Server-only clinic payment provider connections. Provider credentials are stored in Supabase Vault.';

create index if not exists payment_provider_connections_created_by_idx
  on public.payment_provider_connections(created_by);

create index if not exists payment_provider_connections_updated_by_idx
  on public.payment_provider_connections(updated_by);

alter table public.payment_provider_connections enable row level security;

revoke all on table public.payment_provider_connections
  from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_provider_connections
  to service_role;

create or replace function public.save_payment_provider_connection(
  p_org_id uuid,
  p_user_id uuid,
  p_token text,
  p_credentials_hint text,
  p_merchant jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.payment_provider_connections%rowtype;
  v_secret_id uuid;
begin
  if p_org_id is null or p_user_id is null then
    raise exception 'organization and user are required';
  end if;

  if length(trim(coalesce(p_token, ''))) < 20
     or length(p_token) > 1000 then
    raise exception 'invalid provider token';
  end if;

  if not exists (
    select 1
    from public.clinic_users cu
    where cu.id = p_user_id
      and cu.org_id = p_org_id
      and cu.is_active = true
      and lower(coalesce(cu.role, '')) in ('owner', 'admin')
  ) then
    raise exception 'access denied';
  end if;

  select *
  into v_connection
  from public.payment_provider_connections
  where org_id = p_org_id
    and provider = 'monobank'
  for update;

  if found then
    perform vault.update_secret(
      v_connection.vault_secret_id,
      trim(p_token),
      null,
      'PUG CRM Monobank acquiring token for clinic ' || p_org_id::text,
      null
    );

    update public.payment_provider_connections
    set status = 'connected',
        credentials_hint = coalesce(p_credentials_hint, ''),
        merchant_id = nullif(trim(p_merchant ->> 'merchantId'), ''),
        merchant_name = nullif(trim(p_merchant ->> 'merchantName'), ''),
        merchant_edrpou = nullif(trim(p_merchant ->> 'edrpou'), ''),
        last_checked_at = now(),
        last_error = null,
        updated_by = p_user_id,
        updated_at = now()
    where id = v_connection.id
    returning * into v_connection;
  else
    v_secret_id := vault.create_secret(
      trim(p_token),
      null,
      'PUG CRM Monobank acquiring token for clinic ' || p_org_id::text,
      null
    );

    insert into public.payment_provider_connections (
      org_id,
      provider,
      status,
      vault_secret_id,
      credentials_hint,
      merchant_id,
      merchant_name,
      merchant_edrpou,
      last_checked_at,
      created_by,
      updated_by
    ) values (
      p_org_id,
      'monobank',
      'connected',
      v_secret_id,
      coalesce(p_credentials_hint, ''),
      nullif(trim(p_merchant ->> 'merchantId'), ''),
      nullif(trim(p_merchant ->> 'merchantName'), ''),
      nullif(trim(p_merchant ->> 'edrpou'), ''),
      now(),
      p_user_id,
      p_user_id
    )
    returning * into v_connection;
  end if;

  return jsonb_build_object(
    'id', v_connection.id,
    'provider', v_connection.provider,
    'status', v_connection.status
  );
end;
$$;

create or replace function public.get_payment_provider_secret(
  p_org_id uuid,
  p_provider text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
  from public.payment_provider_connections c
  join vault.decrypted_secrets ds
    on ds.id = c.vault_secret_id
  where c.org_id = p_org_id
    and c.provider = p_provider
    and c.status = 'connected'
  limit 1
$$;

create or replace function public.delete_payment_provider_connection(
  p_org_id uuid,
  p_user_id uuid,
  p_provider text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if not exists (
    select 1
    from public.clinic_users cu
    where cu.id = p_user_id
      and cu.org_id = p_org_id
      and cu.is_active = true
      and lower(coalesce(cu.role, '')) in ('owner', 'admin')
  ) then
    raise exception 'access denied';
  end if;

  delete from public.payment_provider_connections
  where org_id = p_org_id
    and provider = p_provider
  returning vault_secret_id into v_secret_id;

  if v_secret_id is null then
    return false;
  end if;

  delete from vault.secrets where id = v_secret_id;
  return true;
end;
$$;

revoke all on function public.save_payment_provider_connection(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.get_payment_provider_secret(uuid, text)
  from public, anon, authenticated;
revoke all on function public.delete_payment_provider_connection(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.save_payment_provider_connection(uuid, uuid, text, text, jsonb)
  to service_role;
grant execute on function public.get_payment_provider_secret(uuid, text)
  to service_role;
grant execute on function public.delete_payment_provider_connection(uuid, uuid, text)
  to service_role;

alter table public.payment_intents
  add column if not exists provider_connection_id uuid
  references public.payment_provider_connections(id) on delete set null;

create index if not exists payment_intents_provider_connection_id_idx
  on public.payment_intents(provider_connection_id);
