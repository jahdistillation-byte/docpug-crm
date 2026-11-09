begin;

alter table public.payment_provider_connections
  drop constraint if exists payment_provider_connections_provider_check;
alter table public.payment_provider_connections
  add constraint payment_provider_connections_provider_check
  check (provider in ('monobank', 'checkbox'));

create or replace function public.save_checkbox_test_connection(
  p_org_id uuid, p_user_id uuid, p_credentials text, p_register_id text, p_register_name text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_secret uuid;
begin
  if not exists (
    select 1 from public.clinic_users
    where id = p_user_id and org_id = p_org_id and is_active
      and lower(role) in ('owner', 'admin')
  ) then
    raise exception 'access denied';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org_id::text || ':checkbox', 0));
  select vault_secret_id into v_secret from public.payment_provider_connections
  where org_id = p_org_id and provider = 'checkbox' for update;
  if v_secret is null then
    v_secret := vault.create_secret(p_credentials, null, 'PUG CRM Checkbox test register', null);
    insert into public.payment_provider_connections
      (org_id, provider, vault_secret_id, merchant_id, merchant_name, created_by, updated_by, last_checked_at)
    values (p_org_id, 'checkbox', v_secret, p_register_id, p_register_name, p_user_id, p_user_id, now());
  else
    perform vault.update_secret(v_secret, p_credentials, null, null, null);
    update public.payment_provider_connections
    set status = 'connected', merchant_id = p_register_id, merchant_name = p_register_name,
        updated_by = p_user_id, updated_at = now(), last_checked_at = now(), last_error = null
    where org_id = p_org_id and provider = 'checkbox';
  end if;
end;
$$;

revoke all on function public.save_checkbox_test_connection(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.save_checkbox_test_connection(uuid, uuid, text, text, text)
  to service_role;

create table if not exists public.checkbox_test_receipts (
  transaction_id uuid primary key references public.finance_transactions(id) on delete restrict,
  org_id uuid not null references public.orgs(id),
  visit_id uuid not null references public.visits(id),
  register_id uuid not null,
  receipt_id uuid not null unique,
  kind text not null check (kind in ('sell', 'return')),
  status text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'ERROR')),
  fiscal_code text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists checkbox_test_receipts_visit
  on public.checkbox_test_receipts (org_id, visit_id);
alter table public.checkbox_test_receipts enable row level security;
revoke all on table public.checkbox_test_receipts from public, anon, authenticated;
grant select, insert, update on table public.checkbox_test_receipts to service_role;

commit;
