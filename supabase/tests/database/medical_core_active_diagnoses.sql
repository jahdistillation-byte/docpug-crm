begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

select has_table(
  'public',
  'patient_diagnoses',
  'structured patient diagnoses table exists'
);
select has_table(
  'public',
  'patient_diagnosis_events',
  'append-only diagnosis event table exists'
);

select ok(
  (
    select bool_and(relation.relrowsecurity)
    from pg_class as relation
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'patient_diagnoses',
        'patient_diagnosis_events'
      )
  ),
  'RLS is enabled on both Medical Core tables'
);

select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    cross join unnest(
      array['anon', 'authenticated']
    ) as client(role_name)
    where namespace.nspname = 'public'
      and relation.relname in (
        'patient_diagnoses',
        'patient_diagnosis_events'
      )
      and has_table_privilege(
        client.role_name,
        relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      )
  ),
  'browser roles have no Medical Core table privileges'
);

select ok(
  has_table_privilege(
    'service_role',
    'public.patient_diagnoses',
    'SELECT,INSERT,UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.patient_diagnoses',
    'DELETE'
  ),
  'service role can manage diagnoses but cannot delete them'
);

select lives_ok(
  $$
    insert into public.patient_diagnoses (
      id,
      org_id,
      patient_id,
      source_visit_id,
      diagnosis_name,
      certainty,
      severity,
      created_by,
      updated_by
    ) values (
      '30000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '  Атопічний дерматит  ',
      'confirmed',
      'moderate',
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001'
    )
  $$,
  'a structured active diagnosis can be created'
);

select is(
  (
    select diagnosis_name
    from public.patient_diagnoses
    where id = '30000000-0000-4000-8000-000000000001'
  ),
  'Атопічний дерматит',
  'diagnosis names are normalized by the database'
);

select is(
  (
    select count(*)
    from public.patient_diagnosis_events
    where diagnosis_id = '30000000-0000-4000-8000-000000000001'
      and event_type = 'created'
  ),
  1::bigint,
  'creation produces exactly one audit event'
);

select throws_ok(
  $$
    insert into public.patient_diagnoses (
      org_id,
      patient_id,
      source_visit_id,
      diagnosis_name,
      created_by,
      updated_by
    ) values (
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'Cross-patient diagnosis',
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001'
    )
  $$,
  '23514',
  'Source visit must belong to the same clinic and patient',
  'a visit from another patient cannot be attached'
);

select lives_ok(
  $$
    update public.patient_diagnoses
    set status = 'remission',
        status_reason = 'Стан стабілізовано',
        updated_by = '40000000-0000-4000-8000-000000000002'
    where id = '30000000-0000-4000-8000-000000000001'
  $$,
  'active diagnosis can move to remission'
);

select is(
  (
    select version
    from public.patient_diagnoses
    where id = '30000000-0000-4000-8000-000000000001'
  ),
  2,
  'every update increments the optimistic concurrency version'
);

select is(
  (
    select count(*)
    from public.patient_diagnosis_events
    where diagnosis_id = '30000000-0000-4000-8000-000000000001'
      and event_type = 'status_changed'
      and from_status = 'active'
      and to_status = 'remission'
  ),
  1::bigint,
  'status changes are recorded in the audit timeline'
);

select throws_ok(
  $$
    update public.patient_diagnoses
    set status = 'entered_in_error',
        status_reason = null,
        updated_by = '40000000-0000-4000-8000-000000000001'
    where id = '30000000-0000-4000-8000-000000000001'
  $$,
  '23514',
  null,
  'entered-in-error requires a reason'
);

select lives_ok(
  $$
    update public.patient_diagnoses
    set status = 'entered_in_error',
        status_reason = 'Дубль запису',
        updated_by = '40000000-0000-4000-8000-000000000001'
    where id = '30000000-0000-4000-8000-000000000001'
  $$,
  'a diagnosis can be marked erroneous when a reason is supplied'
);

select throws_ok(
  $$
    update public.patient_diagnoses
    set clinical_note = 'rewritten',
        updated_by = '40000000-0000-4000-8000-000000000001'
    where id = '30000000-0000-4000-8000-000000000001'
  $$,
  '22000',
  'An erroneous diagnosis cannot be changed',
  'an erroneous medical record becomes immutable'
);

select throws_ok(
  $$
    update public.patient_diagnoses
    set patient_id = '10000000-0000-4000-8000-000000000002',
        updated_by = '40000000-0000-4000-8000-000000000001'
    where id = '30000000-0000-4000-8000-000000000001'
  $$,
  '22000',
  'Diagnosis identity fields cannot be changed',
  'a diagnosis cannot be moved to another patient'
);

select throws_ok(
  $$
    delete from public.patient_diagnoses
    where id = '30000000-0000-4000-8000-000000000001'
  $$,
  '55000',
  'Diagnosis events are append-only',
  'medical diagnoses cannot be physically deleted'
);

select throws_ok(
  $$
    update public.patient_diagnosis_events
    set reason = 'rewritten'
    where diagnosis_id = '30000000-0000-4000-8000-000000000001'
  $$,
  '55000',
  'Diagnosis events are append-only',
  'audit events cannot be rewritten'
);

select * from finish();
rollback;
