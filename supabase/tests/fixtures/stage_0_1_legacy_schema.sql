-- TEST FIXTURE ONLY. Never apply this file to a hosted Supabase project.
--
-- Production predates migration tracking, so this minimal shape recreates only
-- the audited ACL/RPC surface needed to execute the Stage 0.1 migration locally.
-- It is not a production schema snapshot and is not suitable for application
-- or data-migration tests.

-- Stage 1.1 needs the real keys and legacy finance columns to exercise its
-- backfill. The remaining Stage 0.1 tables stay intentionally skeletal.
create table if not exists public.orgs (
  id uuid primary key,
  name text
);

create table if not exists public.clinic_users (
  id uuid primary key,
  org_id uuid not null references public.orgs(id),
  role text not null,
  is_active boolean not null default true
);

create table if not exists public.finance_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  visit_id uuid,
  cash_shift_id uuid,
  created_by uuid,
  transaction_type text not null check (
    transaction_type in ('payment', 'refund', 'expense', 'deposit', 'withdrawal')
  ),
  payment_method text check (
    payment_method in ('cash', 'card', 'transfer', 'terminal', 'other')
  ),
  status text not null check (status in ('pending', 'completed', 'cancelled', 'failed')),
  source text not null check (source in ('visit', 'manual', 'terminal', 'stock', 'salary', 'other')),
  category text,
  amount numeric not null check (amount > 0),
  currency text not null default 'UAH',
  description text,
  counterparty text,
  document_url text,
  external_provider text,
  external_reference text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (org_id, external_provider, external_reference)
);

create table if not exists public.stock_purchases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id)
);

insert into public.orgs (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'Fixture clinic A'),
  ('00000000-0000-0000-0000-000000000002', 'Fixture clinic B')
on conflict (id) do nothing;

insert into public.clinic_users (id, org_id, role, is_active) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner', true),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'admin', true),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'vet', true),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000002', 'owner', true)
on conflict (id) do nothing;

insert into public.finance_transactions (
  id, org_id, created_by, transaction_type, payment_method, status, source,
  category, amount, currency, description, counterparty,
  external_provider, external_reference, occurred_at, created_at, updated_at
) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'expense', 'cash', 'completed', 'manual', 'Оренда', 100.01, 'UAH', 'Legacy rent', 'Landlord', 'pugcrm', 'legacy-1', '2026-06-10 10:00:00+00', '2026-06-10 10:00:00+00', '2026-06-10 10:00:00+00'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'expense', 'transfer', 'completed', 'manual', 'Зарплата', 200.02, 'UAH', 'Legacy salary', 'Employee', 'pugcrm', 'legacy-2', '2026-06-11 10:00:00+00', '2026-06-11 10:00:00+00', '2026-06-11 10:00:00+00'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'expense', 'terminal', 'completed', 'manual', 'Закупівля препаратів', 300.03, 'UAH', 'Legacy purchase', 'Supplier', 'pugcrm', 'legacy-3', '2026-06-12 10:00:00+00', '2026-06-12 10:00:00+00', '2026-06-12 10:00:00+00'),
  ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'expense', 'other', 'completed', 'manual', 'Маркетинг', 400.04, 'UAH', 'Legacy marketing', 'Agency', 'pugcrm', 'legacy-4', '2026-06-13 10:00:00+00', '2026-06-13 10:00:00+00', '2026-06-13 10:00:00+00'),
  ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'payment', 'cash', 'completed', 'visit', 'Оплата візиту', 500.05, 'UAH', 'Legacy visit payment', null, 'pugcrm', 'legacy-5', '2026-06-14 10:00:00+00', '2026-06-14 10:00:00+00', '2026-06-14 10:00:00+00')
on conflict (id) do nothing;

do $fixture$
declare
  business_table text;
begin
  foreach business_table in array array[
    'calendar_events',
    'cash_shifts',
    'clinic_users',
    'finance_transactions',
    'hospital_tasks',
    'hospitalizations',
    'organizations',
    'orgs',
    'owners',
    'patient_medcard_entries',
    'patients',
    'profiles',
    'services',
    'specializations',
    'staff',
    'staff_finance_adjustments',
    'staff_month_goals',
    'staff_rating_snapshots',
    'staff_schedule',
    'stock',
    'stock_movements',
    'stock_purchase_items',
    'stock_purchase_transactions',
    'stock_purchases',
    'suppliers',
    'users',
    'visit_services',
    'visit_stock',
    'visits'
  ]
  loop
    execute format(
      'create table if not exists public.%I (id bigserial primary key)',
      business_table
    );

    execute format(
      'alter table public.%I disable row level security',
      business_table
    );

    execute format(
      'grant all privileges on table public.%I to public, anon, authenticated',
      business_table
    );
  end loop;
end
$fixture$;

do $fixture$
declare
  sequence_name text;
begin
  for sequence_name in
    select format('%I.%I', namespace.nspname, sequence.relname)
    from pg_class as sequence
    join pg_namespace as namespace
      on namespace.oid = sequence.relnamespace
    where namespace.nspname = 'public'
      and sequence.relkind = 'S'
  loop
    execute format(
      'grant all privileges on sequence %s to public, anon, authenticated',
      sequence_name
    );
  end loop;
end
$fixture$;

drop policy if exists "Allow select for all" on public.staff_schedule;
create policy "Allow select for all"
  on public.staff_schedule
  for select
  to public
  using (true);

create or replace function public.create_stock_purchase(
  p_org_id uuid,
  p_supplier_id uuid,
  p_user_id uuid,
  p_order_date date,
  p_expected_date date,
  p_invoice_number text,
  p_discount_amount numeric,
  p_currency text,
  p_document_url text,
  p_note text,
  p_items jsonb
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $function$
  select '{}'::jsonb
$function$;

create or replace function public.delete_visit_with_stock_restore(
  p_org_id uuid,
  p_visit_id uuid,
  p_user_id uuid
)
returns jsonb
language sql
set search_path = public
as $function$
  select '{}'::jsonb
$function$;

create or replace function public.get_finance_expenses_overview(
  p_org_id uuid,
  p_date_from date,
  p_date_to date
)
returns jsonb
language sql
set search_path = public
as $function$
  select '{}'::jsonb
$function$;

create or replace function public.get_finance_overview(
  p_org_id uuid,
  p_date_from date,
  p_date_to date
)
returns jsonb
language sql
security definer
set search_path = public
as $function$
  select '{}'::jsonb
$function$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $function$
begin
  return new;
end
$function$;

create or replace function public.receive_stock_purchase(
  p_org_id uuid,
  p_purchase_id uuid,
  p_user_id uuid,
  p_items jsonb
)
returns jsonb
language sql
security definer
set search_path = public
as $function$
  select '{}'::jsonb
$function$;

create or replace function public.register_visit_payment(
  p_org_id uuid,
  p_visit_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_method text,
  p_idempotency_key text
)
returns jsonb
language sql
set search_path = public
as $function$
  select '{}'::jsonb
$function$;

create or replace function public.touch_procurement_updated_at()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  new.id = new.id;
  return new;
end
$function$;

grant execute on function public.create_stock_purchase(
  uuid, uuid, uuid, date, date, text, numeric, text, text, text, jsonb
) to public, anon, authenticated;
grant execute on function public.delete_visit_with_stock_restore(
  uuid, uuid, uuid
) to public, anon, authenticated;
grant execute on function public.get_finance_expenses_overview(
  uuid, date, date
) to public, anon, authenticated;
grant execute on function public.get_finance_overview(
  uuid, date, date
) to public, anon, authenticated;
grant execute on function public.handle_new_user()
  to public, anon, authenticated;
grant execute on function public.receive_stock_purchase(
  uuid, uuid, uuid, jsonb
) to public, anon, authenticated;
grant execute on function public.register_visit_payment(
  uuid, uuid, uuid, numeric, text, text
) to public, anon, authenticated;
grant execute on function public.touch_procurement_updated_at()
  to public, anon, authenticated;

grant create on schema public to public, anon, authenticated;
