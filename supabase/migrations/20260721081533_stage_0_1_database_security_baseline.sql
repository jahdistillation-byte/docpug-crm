-- Stage 0.1: close the direct Data API surface around the existing Flask app.
--
-- The browser does not query Supabase directly. All application access is made
-- by server.py with a server-only secret, so anon/authenticated receive no
-- privileges on the business schema. This migration is intentionally
-- idempotent because the production schema predates migration tracking.

begin;

-- Refuse to record this migration against an empty or drifted database. A
-- production-equivalent schema snapshot must be loaded first in local/CI.
do $migration$
declare
  missing_tables text[];
  missing_functions text[];
begin
  select array_agg(expected.object_name order by expected.object_name)
  into missing_tables
  from unnest(array[
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
  ]) as expected(object_name)
  where to_regclass(
    format('%I.%I', 'public', expected.object_name)
  ) is null;

  select array_agg(expected.object_name order by expected.object_name)
  into missing_functions
  from unnest(array[
    'public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)',
    'public.delete_visit_with_stock_restore(uuid,uuid,uuid)',
    'public.get_finance_expenses_overview(uuid,date,date)',
    'public.get_finance_overview(uuid,date,date)',
    'public.handle_new_user()',
    'public.receive_stock_purchase(uuid,uuid,uuid,jsonb)',
    'public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)',
    'public.touch_procurement_updated_at()'
  ]) as expected(object_name)
  where to_regprocedure(
    expected.object_name
  ) is null;

  if coalesce(cardinality(missing_tables), 0) > 0 then
    raise exception using
      errcode = '55000',
      message = format(
        'Stage 0.1 schema preflight failed; missing tables: %s',
        array_to_string(missing_tables, ', ')
      );
  end if;

  if coalesce(cardinality(missing_functions), 0) > 0 then
    raise exception using
      errcode = '55000',
      message = format(
        'Stage 0.1 schema preflight failed; missing functions: %s',
        array_to_string(missing_functions, ', ')
      );
  end if;
end
$migration$;

do $migration$
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
    if to_regclass(format('%I.%I', 'public', business_table)) is not null then
      execute format(
        'alter table %I.%I enable row level security',
        'public',
        business_table
      );

      execute format(
        'revoke all privileges on table %I.%I from public, anon, authenticated',
        'public',
        business_table
      );

      execute format(
        'grant all privileges on table %I.%I to service_role',
        'public',
        business_table
      );
    end if;
  end loop;
end
$migration$;

-- The only existing policy is a public USING (true) policy. Drop it explicitly
-- so it cannot become an accidental leak if a table grant is added later.
do $migration$
begin
  if to_regclass('public.staff_schedule') is not null then
    drop policy if exists "Allow select for all" on public.staff_schedule;
  end if;
end
$migration$;

-- Identity/serial sequences in public are server-only as well.
do $migration$
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
      'revoke all privileges on sequence %s from public, anon, authenticated',
      sequence_name
    );
    execute format(
      'grant all privileges on sequence %s to service_role',
      sequence_name
    );
  end loop;
end
$migration$;

-- Revoke direct calls to every application function found in the audited
-- production schema. Trigger functions remain callable by their triggers.
do $migration$
declare
  app_function text;
begin
  foreach app_function in array array[
    'public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)',
    'public.delete_visit_with_stock_restore(uuid,uuid,uuid)',
    'public.get_finance_expenses_overview(uuid,date,date)',
    'public.get_finance_overview(uuid,date,date)',
    'public.handle_new_user()',
    'public.receive_stock_purchase(uuid,uuid,uuid,jsonb)',
    'public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)',
    'public.touch_procurement_updated_at()'
  ]
  loop
    if to_regprocedure(app_function) is not null then
      execute format(
        'revoke all privileges on function %s from public, anon, authenticated',
        app_function
      );
      execute format(
        'grant execute on function %s to service_role',
        app_function
      );
    end if;
  end loop;
end
$migration$;

-- These RPCs are invoked only with service_role. SECURITY INVOKER preserves the
-- same server behaviour because service_role bypasses RLS, while eliminating an
-- unnecessary owner-privilege boundary.
do $migration$
begin
  if to_regprocedure(
    'public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)'
  ) is not null then
    alter function public.create_stock_purchase(
      uuid, uuid, uuid, date, date, text, numeric, text, text, text, jsonb
    ) security invoker;
    alter function public.create_stock_purchase(
      uuid, uuid, uuid, date, date, text, numeric, text, text, text, jsonb
    ) set search_path = public, pg_temp;
  end if;

  if to_regprocedure(
    'public.get_finance_overview(uuid,date,date)'
  ) is not null then
    alter function public.get_finance_overview(
      uuid, date, date
    ) security invoker;
    alter function public.get_finance_overview(
      uuid, date, date
    ) set search_path = public, pg_temp;
  end if;

  if to_regprocedure(
    'public.receive_stock_purchase(uuid,uuid,uuid,jsonb)'
  ) is not null then
    alter function public.receive_stock_purchase(
      uuid, uuid, uuid, jsonb
    ) security invoker;
    alter function public.receive_stock_purchase(
      uuid, uuid, uuid, jsonb
    ) set search_path = public, pg_temp;
  end if;
end
$migration$;

-- Remove mutable search paths from the remaining application functions. The
-- auth trigger must stay SECURITY DEFINER, but direct EXECUTE was revoked above.
do $migration$
declare
  app_function text;
begin
  foreach app_function in array array[
    'public.delete_visit_with_stock_restore(uuid,uuid,uuid)',
    'public.get_finance_expenses_overview(uuid,date,date)',
    'public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)',
    'public.touch_procurement_updated_at()'
  ]
  loop
    if to_regprocedure(app_function) is not null then
      execute format(
        'alter function %s set search_path = public, pg_temp',
        app_function
      );
    end if;
  end loop;

  if to_regprocedure('public.handle_new_user()') is not null then
    alter function public.handle_new_user()
      security definer
      set search_path = public, auth, pg_temp;
  end if;
end
$migration$;

-- Prevent clients from creating objects in the exposed schema. USAGE remains
-- unchanged to avoid broad platform side effects; object grants above are the
-- actual access boundary.
revoke create on schema public from public, anon, authenticated;
grant usage on schema public to service_role;

-- Existing Supabase projects auto-exposed new public objects. Opt this project
-- into explicit grants, then preserve server-side defaults for service_role.
alter default privileges for role postgres in schema public
  revoke all privileges on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant all privileges on tables to service_role;

alter default privileges for role postgres in schema public
  revoke all privileges on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant all privileges on sequences to service_role;

-- PostgreSQL's built-in default grants EXECUTE to PUBLIC globally. A
-- schema-scoped REVOKE cannot subtract that global default, so remove it at the
-- creator-role level before defining the explicit public-schema defaults.
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

commit;
