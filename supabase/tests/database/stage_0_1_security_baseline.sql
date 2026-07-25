begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

-- These probes verify ALTER DEFAULT PRIVILEGES without leaving objects behind.
create table public.stage_0_1_default_acl_probe (
  id bigserial primary key
);

create function public.stage_0_1_default_acl_probe()
returns integer
language sql
as $function$
  select 1
$function$;

select plan(26);

select is(
  (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relname = any(array[
        'calendar_events', 'cash_shifts', 'clinic_users',
        'finance_transactions', 'hospital_tasks', 'hospitalizations',
        'organizations', 'orgs', 'owners', 'patient_medcard_entries',
        'patients', 'profiles', 'services', 'specializations', 'staff',
        'staff_finance_adjustments', 'staff_month_goals',
        'staff_rating_snapshots', 'staff_schedule', 'stock',
        'stock_movements', 'stock_purchase_items',
        'stock_purchase_transactions', 'stock_purchases', 'suppliers',
        'users', 'visit_services', 'visit_stock', 'visits'
      ])
  ),
  29::bigint,
  'the tested schema contains all audited business tables'
);

select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relname = any(array[
        'calendar_events', 'cash_shifts', 'clinic_users',
        'finance_transactions', 'hospital_tasks', 'hospitalizations',
        'organizations', 'orgs', 'owners', 'patient_medcard_entries',
        'patients', 'profiles', 'services', 'specializations', 'staff',
        'staff_finance_adjustments', 'staff_month_goals',
        'staff_rating_snapshots', 'staff_schedule', 'stock',
        'stock_movements', 'stock_purchase_items',
        'stock_purchase_transactions', 'stock_purchases', 'suppliers',
        'users', 'visit_services', 'visit_stock', 'visits'
      ])
      and not relation.relrowsecurity
  ),
  'RLS is enabled on every audited business table'
);

select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relname = any(array[
        'calendar_events', 'cash_shifts', 'clinic_users',
        'finance_transactions', 'hospital_tasks', 'hospitalizations',
        'organizations', 'orgs', 'owners', 'patient_medcard_entries',
        'patients', 'profiles', 'services', 'specializations', 'staff',
        'staff_finance_adjustments', 'staff_month_goals',
        'staff_rating_snapshots', 'staff_schedule', 'stock',
        'stock_movements', 'stock_purchase_items',
        'stock_purchase_transactions', 'stock_purchases', 'suppliers',
        'users', 'visit_services', 'visit_stock', 'visits'
      ])
      and has_table_privilege(
        'anon',
        relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      )
  ),
  'anon has no table privileges on audited business tables'
);

select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relname = any(array[
        'calendar_events', 'cash_shifts', 'clinic_users',
        'finance_transactions', 'hospital_tasks', 'hospitalizations',
        'organizations', 'orgs', 'owners', 'patient_medcard_entries',
        'patients', 'profiles', 'services', 'specializations', 'staff',
        'staff_finance_adjustments', 'staff_month_goals',
        'staff_rating_snapshots', 'staff_schedule', 'stock',
        'stock_movements', 'stock_purchase_items',
        'stock_purchase_transactions', 'stock_purchases', 'suppliers',
        'users', 'visit_services', 'visit_stock', 'visits'
      ])
      and has_table_privilege(
        'authenticated',
        relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      )
  ),
  'authenticated has no table privileges on audited business tables'
);

select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    cross join unnest(array['anon', 'authenticated']) as client(role_name)
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relname = any(array[
        'calendar_events', 'cash_shifts', 'clinic_users',
        'finance_transactions', 'hospital_tasks', 'hospitalizations',
        'organizations', 'orgs', 'owners', 'patient_medcard_entries',
        'patients', 'profiles', 'services', 'specializations', 'staff',
        'staff_finance_adjustments', 'staff_month_goals',
        'staff_rating_snapshots', 'staff_schedule', 'stock',
        'stock_movements', 'stock_purchase_items',
        'stock_purchase_transactions', 'stock_purchases', 'suppliers',
        'users', 'visit_services', 'visit_stock', 'visits'
      ])
      and has_any_column_privilege(
        client.role_name,
        relation.oid,
        'SELECT,INSERT,UPDATE,REFERENCES'
      )
  ),
  'client roles have no column-level privileges on business tables'
);

select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    cross join unnest(
      array['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    ) as required(privilege_name)
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relname = any(array[
        'calendar_events', 'cash_shifts', 'clinic_users',
        'finance_transactions', 'hospital_tasks', 'hospitalizations',
        'organizations', 'orgs', 'owners', 'patient_medcard_entries',
        'patients', 'profiles', 'services', 'specializations', 'staff',
        'staff_finance_adjustments', 'staff_month_goals',
        'staff_rating_snapshots', 'staff_schedule', 'stock',
        'stock_movements', 'stock_purchase_items',
        'stock_purchase_transactions', 'stock_purchases', 'suppliers',
        'users', 'visit_services', 'visit_stock', 'visits'
      ])
      and not has_table_privilege(
        'service_role',
        relation.oid,
        required.privilege_name
      )
  ),
  'service_role keeps CRUD privileges on every business table'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'staff_schedule'
      and policyname = 'Allow select for all'
  ),
  0::bigint,
  'the public staff_schedule policy was removed'
);

with expected(signature) as (
  values
    ('public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)'),
    ('public.delete_visit_with_stock_restore(uuid,uuid,uuid)'),
    ('public.get_finance_expenses_overview(uuid,date,date)'),
    ('public.get_finance_overview(uuid,date,date)'),
    ('public.handle_new_user()'),
    ('public.receive_stock_purchase(uuid,uuid,uuid,jsonb)'),
    ('public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)'),
    ('public.touch_procurement_updated_at()')
)
select is(
  count(*) filter (
    where to_regprocedure(signature) is not null
  ),
  8::bigint,
  'the tested schema contains every exact audited function signature'
)
from expected;

with expected(signature) as (
  values
    ('public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)'),
    ('public.delete_visit_with_stock_restore(uuid,uuid,uuid)'),
    ('public.get_finance_expenses_overview(uuid,date,date)'),
    ('public.get_finance_overview(uuid,date,date)'),
    ('public.handle_new_user()'),
    ('public.receive_stock_purchase(uuid,uuid,uuid,jsonb)'),
    ('public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)'),
    ('public.touch_procurement_updated_at()')
)
select ok(
  not exists (
    select 1
    from expected
    where has_function_privilege(
      'anon',
      to_regprocedure(signature),
      'EXECUTE'
    )
  ),
  'anon cannot execute any audited application function'
);

with expected(signature) as (
  values
    ('public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)'),
    ('public.delete_visit_with_stock_restore(uuid,uuid,uuid)'),
    ('public.get_finance_expenses_overview(uuid,date,date)'),
    ('public.get_finance_overview(uuid,date,date)'),
    ('public.handle_new_user()'),
    ('public.receive_stock_purchase(uuid,uuid,uuid,jsonb)'),
    ('public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)'),
    ('public.touch_procurement_updated_at()')
)
select ok(
  not exists (
    select 1
    from expected
    where has_function_privilege(
      'authenticated',
      to_regprocedure(signature),
      'EXECUTE'
    )
  ),
  'authenticated cannot execute any audited application function'
);

with expected(signature) as (
  values
    ('public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)'),
    ('public.delete_visit_with_stock_restore(uuid,uuid,uuid)'),
    ('public.get_finance_expenses_overview(uuid,date,date)'),
    ('public.get_finance_overview(uuid,date,date)'),
    ('public.handle_new_user()'),
    ('public.receive_stock_purchase(uuid,uuid,uuid,jsonb)'),
    ('public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)'),
    ('public.touch_procurement_updated_at()')
)
select ok(
  not exists (
    select 1
    from expected
    where has_function_privilege(
      'public',
      to_regprocedure(signature),
      'EXECUTE'
    )
  ),
  'PUBLIC cannot execute any audited application function'
);

with expected(signature) as (
  values
    ('public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)'),
    ('public.delete_visit_with_stock_restore(uuid,uuid,uuid)'),
    ('public.get_finance_expenses_overview(uuid,date,date)'),
    ('public.get_finance_overview(uuid,date,date)'),
    ('public.handle_new_user()'),
    ('public.receive_stock_purchase(uuid,uuid,uuid,jsonb)'),
    ('public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)'),
    ('public.touch_procurement_updated_at()')
)
select ok(
  not exists (
    select 1
    from expected
    where not has_function_privilege(
      'service_role',
      to_regprocedure(signature),
      'EXECUTE'
    )
  ),
  'service_role can execute every audited application function'
);

select is(
  (
    select prosecdef
    from pg_proc
    where oid = to_regprocedure(
      'public.receive_stock_purchase(uuid,uuid,uuid,jsonb)'
    )
  ),
  false,
  'purchase receipt RPC is SECURITY INVOKER'
);

select is(
  (
    select prosecdef
    from pg_proc
    where oid = to_regprocedure(
      'public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)'
    )
  ),
  false,
  'purchase creation RPC is SECURITY INVOKER'
);

select is(
  (
    select prosecdef
    from pg_proc
    where oid = to_regprocedure(
      'public.get_finance_overview(uuid,date,date)'
    )
  ),
  false,
  'finance overview RPC is SECURITY INVOKER'
);

select is(
  (
    select prosecdef
    from pg_proc
    where oid = to_regprocedure('public.handle_new_user()')
  ),
  true,
  'auth trigger function remains SECURITY DEFINER'
);

select ok(
  not has_schema_privilege('anon', 'public', 'CREATE')
  and not has_schema_privilege('authenticated', 'public', 'CREATE'),
  'client roles cannot create objects in public schema'
);

select ok(
  not exists (
    select 1
    from pg_sequence as sequence
    join pg_class as relation
      on relation.oid = sequence.seqrelid
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    cross join unnest(array['anon', 'authenticated']) as client(role_name)
    where namespace.nspname = 'public'
      and has_sequence_privilege(
        client.role_name,
        sequence.seqrelid,
        'USAGE,SELECT,UPDATE'
      )
  ),
  'client roles have no privileges on public sequences'
);

select ok(
  not exists (
    select 1
    from pg_sequence as sequence
    join pg_class as relation
      on relation.oid = sequence.seqrelid
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and not has_sequence_privilege(
        'service_role'::name,
        sequence.seqrelid,
        'USAGE'
      )
  ),
  'service_role retains USAGE on public sequences'
);

select ok(
  not has_table_privilege(
    'anon',
    'public.stage_0_1_default_acl_probe',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
  )
  and not has_table_privilege(
    'authenticated',
    'public.stage_0_1_default_acl_probe',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
  ),
  'new tables do not inherit client privileges'
);

select ok(
  has_table_privilege(
    'service_role',
    'public.stage_0_1_default_acl_probe',
    'SELECT'
  )
  and has_table_privilege(
    'service_role',
    'public.stage_0_1_default_acl_probe',
    'INSERT'
  )
  and has_table_privilege(
    'service_role',
    'public.stage_0_1_default_acl_probe',
    'UPDATE'
  )
  and has_table_privilege(
    'service_role',
    'public.stage_0_1_default_acl_probe',
    'DELETE'
  ),
  'new tables inherit service_role CRUD privileges'
);

select ok(
  not has_sequence_privilege(
    'anon'::name,
    'public.stage_0_1_default_acl_probe_id_seq',
    'USAGE,SELECT,UPDATE'
  )
  and not has_sequence_privilege(
    'authenticated'::name,
    'public.stage_0_1_default_acl_probe_id_seq',
    'USAGE,SELECT,UPDATE'
  ),
  'new sequences do not inherit client privileges'
);

select ok(
  has_sequence_privilege(
    'service_role'::name,
    'public.stage_0_1_default_acl_probe_id_seq',
    'USAGE'
  ),
  'new sequences inherit service_role privileges'
);

select ok(
  not has_function_privilege(
    'public',
    'public.stage_0_1_default_acl_probe()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.stage_0_1_default_acl_probe()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.stage_0_1_default_acl_probe()',
    'EXECUTE'
  ),
  'new functions do not inherit client or PUBLIC execution'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.stage_0_1_default_acl_probe()',
    'EXECUTE'
  ),
  'new functions inherit service_role execution'
);

select ok(
  (
    select proconfig = array['search_path=public, pg_temp']
    from pg_proc
    where oid = to_regprocedure(
      'public.create_stock_purchase(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb)'
    )
  )
  and (
    select proconfig = array['search_path=public, pg_temp']
    from pg_proc
    where oid = to_regprocedure(
      'public.delete_visit_with_stock_restore(uuid,uuid,uuid)'
    )
  )
  and (
    select proconfig = array['search_path=public, pg_temp']
    from pg_proc
    where oid = to_regprocedure(
      'public.get_finance_expenses_overview(uuid,date,date)'
    )
  )
  and (
    select proconfig = array['search_path=public, pg_temp']
    from pg_proc
    where oid = to_regprocedure(
      'public.get_finance_overview(uuid,date,date)'
    )
  )
  and (
    select proconfig = array['search_path=public, pg_temp']
    from pg_proc
    where oid = to_regprocedure(
      'public.receive_stock_purchase(uuid,uuid,uuid,jsonb)'
    )
  )
  and (
    select proconfig = array['search_path=public, pg_temp']
    from pg_proc
    where oid = to_regprocedure(
      'public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)'
    )
  )
  and (
    select proconfig = array['search_path=public, pg_temp']
    from pg_proc
    where oid = to_regprocedure(
      'public.touch_procurement_updated_at()'
    )
  )
  and (
    select proconfig = array['search_path=public, auth, pg_temp']
    from pg_proc
    where oid = to_regprocedure('public.handle_new_user()')
  ),
  'all audited functions have fixed search paths'
);

select * from finish();

rollback;
