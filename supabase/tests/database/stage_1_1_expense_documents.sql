begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

create temporary table stage_1_1_results (
  name text primary key,
  payload jsonb not null
) on commit drop;

select has_table('public', 'financial_accounts', 'financial accounts table exists');
select has_table('public', 'expense_documents', 'expense documents table exists');
select has_table('public', 'finance_documents', 'private document metadata table exists');
select has_table('public', 'recurring_expense_templates', 'recurring templates table exists');
select has_table('public', 'finance_audit_log', 'finance audit table exists');

select ok(
  not exists (
    select 1 from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'financial_accounts', 'expense_documents', 'finance_documents',
        'recurring_expense_templates', 'finance_audit_log'
      ]) and not relation.relrowsecurity
  ),
  'RLS is enabled on every Stage 1.1 table'
);

select ok(
  not exists (
    select 1 from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join unnest(array['anon', 'authenticated']) as client(role_name)
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'financial_accounts', 'expense_documents', 'finance_documents',
        'recurring_expense_templates', 'finance_audit_log'
      ])
      and has_table_privilege(client.role_name, relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
  ),
  'browser roles have no Stage 1.1 table privileges'
);

select ok(
  not exists (
    select 1 from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'financial_accounts', 'expense_documents', 'finance_documents',
        'recurring_expense_templates', 'finance_audit_log'
      ])
      and not has_table_privilege('service_role', relation.oid, 'SELECT,INSERT,UPDATE,DELETE')
  ),
  'service_role retains Stage 1.1 CRUD privileges'
);

select is(
  (select public from storage.buckets where id = 'finance-documents'),
  false,
  'finance document bucket is private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'finance-documents'),
  10485760::bigint,
  'finance document bucket is limited to 10 MiB'
);
select ok(
  (select allowed_mime_types @> array['application/pdf', 'image/jpeg', 'image/png']::text[]
   from storage.buckets where id = 'finance-documents'),
  'finance document bucket has an explicit MIME allowlist'
);

select is(
  (select count(*) from public.financial_accounts where is_default),
  8::bigint,
  'four deterministic default accounts are seeded for each fixture organization'
);
select is(
  (select count(distinct (org_id, system_key)) from public.financial_accounts where is_default),
  8::bigint,
  'default account mapping is unique per organization and system key'
);

select is(
  (select count(*) from public.expense_documents where is_legacy),
  4::bigint,
  'all four legacy completed manual expenses were backfilled'
);
select is(
  (select sum(amount) from public.expense_documents where is_legacy),
  1000.10::numeric,
  'legacy backfill preserves the exact numeric total'
);
select is(
  (select count(*) from public.finance_transactions
   where id in (
     '20000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000002',
     '20000000-0000-0000-0000-000000000003',
     '20000000-0000-0000-0000-000000000004'
   ) and expense_document_id is not null and amount in (100.01, 200.02, 300.03, 400.04)),
  4::bigint,
  'legacy transactions remain in place with their original amounts and new links'
);
select is(
  (select count(*) from public.expense_documents
   where is_legacy and category in ('Зарплата', 'Закупівля препаратів')),
  2::bigint,
  'legacy-only reserved categories are preserved for reconciliation'
);

-- A duplicate backfill candidate is ignored by the transaction link, proving
-- that re-running the data step cannot duplicate or overwrite the source row.
insert into public.expense_documents (
  org_id, document_number, document_kind, status, amount, category,
  expense_date, payment_method, financial_account_id, paid_at,
  transaction_id, idempotency_key, created_by, updated_by, is_legacy
)
select org_id, 'SHOULD-NOT-INSERT', 'expense', 'paid', amount, category,
  expense_date, payment_method, financial_account_id, paid_at,
  transaction_id, 'duplicate-backfill-probe', created_by, updated_by, true
from public.expense_documents
where transaction_id = '20000000-0000-0000-0000-000000000001'
on conflict (transaction_id) do nothing;
select is(
  (select count(*) from public.expense_documents where is_legacy),
  4::bigint,
  'backfill conflict handling is idempotent'
);
select is(
  (select amount from public.finance_transactions
   where id = '20000000-0000-0000-0000-000000000001'),
  100.01::numeric,
  'idempotent backfill does not alter the source amount'
);

select ok(
  to_regprocedure('public.create_expense_document(uuid,uuid,text,text,numeric,text,text,text,text,text,text,date,date,text,uuid,jsonb,uuid[])') is not null,
  'create expense RPC has the exact PostgREST signature'
);
select ok(
  to_regprocedure('public.pay_expense_document(uuid,uuid,uuid,text,timestamp with time zone,text,uuid,integer)') is not null,
  'pay expense RPC has the exact PostgREST signature'
);
select ok(
  to_regprocedure('public.create_recurring_expense_template(uuid,uuid,text,jsonb)') is not null,
  'recurring create RPC accepts the p_template jsonb contract'
);
select ok(
  not (select prosecdef from pg_proc where oid =
    'public.create_expense_document(uuid,uuid,text,text,numeric,text,text,text,text,text,text,date,date,text,uuid,jsonb,uuid[])'::regprocedure),
  'expense mutations are SECURITY INVOKER'
);
select ok(
  not has_function_privilege('anon',
    'public.create_expense_document(uuid,uuid,text,text,numeric,text,text,text,text,text,text,date,date,text,uuid,jsonb,uuid[])',
    'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.create_expense_document(uuid,uuid,text,text,numeric,text,text,text,text,text,text,date,date,text,uuid,jsonb,uuid[])',
    'EXECUTE'),
  'browser roles cannot call expense mutation RPCs'
);

select has_constraint('public', 'expense_documents',
  'expense_documents_reversed_by_document_fk',
  'reversal document self-link has its own FK');
select has_constraint('public', 'expense_documents',
  'expense_documents_reversed_by_fk',
  'reversed_by actor has a distinct same-org FK');
select has_check('public', 'expense_documents',
  'expense_documents_marketing_funnel_check',
  'marketing funnel consistency is enforced by a table check');
select has_check('public', 'expense_documents',
  'expense_documents_marketing_category_check',
  'marketing metrics require a marketing category');

insert into stage_1_1_results values (
  'planned',
  public.create_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'test-planned-1', 'planned', '75.25'::numeric, 'Оренда', null,
    'SQL planned expense', 'Landlord', null, null,
    current_date - 5, current_date + 5, null, null, '{}'::jsonb, '{}'::uuid[]
  )
);
select is((select payload->'document'->>'status' from stage_1_1_results where name = 'planned'),
  'planned', 'create RPC creates a planned document without a ledger row');
select is((select payload->'document'->>'amount' from stage_1_1_results where name = 'planned'),
  75.25::numeric::text, 'money is retained exactly as numeric');
select is(
  (public.create_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'test-planned-1', 'planned', 75.25, 'Оренда', null,
    'SQL planned expense', 'Landlord', null, null,
    current_date - 5, current_date + 5, null, null, '{}'::jsonb, '{}'::uuid[]
  )->>'idempotent_replay')::boolean,
  true,
  'create RPC returns an idempotent replay'
);
select is(
  (select count(*) from public.expense_documents where idempotency_key = 'test-planned-1'),
  1::bigint,
  'create replay does not duplicate a document'
);

select throws_ok(
  $$select public.create_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'test-reserved-category', 'planned', 10.00, 'Зарплата', null,
    null, null, null, null, current_date, null, null, null, '{}'::jsonb, '{}'::uuid[]
  )$$,
  '22023', 'reserved expense category; use procurement or payroll workflow',
  'new payroll/procurement-like operating expense categories are rejected'
);
select throws_ok(
  $$select public.create_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000003',
    'test-vet-denied', 'planned', 10.00, 'Оренда', null,
    null, null, null, null, current_date, null, null, null, '{}'::jsonb, '{}'::uuid[]
  )$$,
  '42501', 'finance actor is outside organization',
  'non-manager actor is rejected inside the database'
);
select throws_ok(
  format($sql$select public.create_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'test-cross-org-account', 'paid', 10.00, 'Оренда', null,
    null, null, null, null, current_date, null, 'cash', %L, '{}'::jsonb, '{}'::uuid[]
  )$sql$, (select id from public.financial_accounts
    where org_id = '00000000-0000-0000-0000-000000000002' and system_key = 'cash')),
  '23503', 'financial account not found or inactive',
  'cross-organization financial account is rejected'
);

insert into stage_1_1_results values (
  'paid_marketing',
  public.create_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002',
    'test-paid-marketing', 'paid', 50.50, 'Маркетинг', 'Digital',
    'SQL paid marketing', 'Agency', null, null,
    current_date - 30, null, 'card', null,
    '{"campaign":"Summer","channel":"Search","leads":10,"new_clients":2,"revenue":"100.00"}'::jsonb,
    '{}'::uuid[]
  )
);
select is((select payload->'document'->>'status' from stage_1_1_results where name = 'paid_marketing'),
  'paid', 'paid create atomically transitions the document');
select is(
  (select accounting_kind from public.finance_transactions
   where expense_document_id = (select (payload->'document'->>'id')::uuid
     from stage_1_1_results where name = 'paid_marketing')),
  'operating_expense',
  'paid create writes one operating-expense ledger row'
);
select is(
  (select account_type from public.financial_accounts where id = (
    select financial_account_id from public.finance_transactions
    where expense_document_id = (select (payload->'document'->>'id')::uuid
      from stage_1_1_results where name = 'paid_marketing'))),
  'terminal',
  'card payments resolve only to a terminal account'
);
select is(
  (select count(*) from public.finance_transactions
   where external_provider = 'pugcrm-expense'
     and external_reference = 'test-paid-marketing'),
  1::bigint,
  'paid create has exactly one idempotent ledger row'
);

insert into stage_1_1_results values (
  'paid_from_planned',
  public.pay_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    (select (payload->'document'->>'id')::uuid from stage_1_1_results where name = 'planned'),
    '30000000-0000-0000-0000-000000000001',
    now(), 'cash', null,
    (select (payload->'document'->>'version')::integer from stage_1_1_results where name = 'planned')
  )
);
select is((select payload->'document'->>'status' from stage_1_1_results where name = 'paid_from_planned'),
  'paid', 'pay RPC locks and pays a planned document');
select is(
  (public.pay_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    (select (payload->'document'->>'id')::uuid from stage_1_1_results where name = 'planned'),
    '30000000-0000-0000-0000-000000000001', now(), 'cash', null, 1
  )->>'idempotent_replay')::boolean,
  true,
  'pay RPC replays before evaluating stale lifecycle/version state'
);

insert into stage_1_1_results values (
  'paid_metadata_update',
  public.update_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    (select (payload->'document'->>'id')::uuid from stage_1_1_results where name = 'paid_from_planned'),
    (select (payload->'document'->>'version')::integer from stage_1_1_results where name = 'paid_from_planned'),
    '{"description":"Audited metadata edit"}'::jsonb
  )
);
select is((select payload->'document'->>'description' from stage_1_1_results where name = 'paid_metadata_update'),
  'Audited metadata edit', 'paid document permits audited metadata-only edits');
select throws_ok(
  format($sql$select public.update_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001', %L, %s,
    '{"amount":"1.00"}'::jsonb)$sql$,
    (select payload->'document'->>'id' from stage_1_1_results where name = 'paid_metadata_update'),
    (select payload->'document'->>'version' from stage_1_1_results where name = 'paid_metadata_update')),
  '22023', 'unsupported expense patch field: amount',
  'paid financial amount cannot be edited'
);

insert into stage_1_1_results values (
  'cancel_candidate',
  public.create_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'test-cancel', 'planned', 12.34, 'Оренда', null,
    null, null, null, null, current_date, null, null, null, '{}'::jsonb, '{}'::uuid[]
  )
);
select is(
  (public.cancel_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    (select (payload->'document'->>'id')::uuid from stage_1_1_results where name = 'cancel_candidate'),
    'No longer needed', 1
  )->'document'->>'status'),
  'cancelled',
  'only a planned document can be cancelled'
);

insert into stage_1_1_results values (
  'reversal',
  public.reverse_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    (select (payload->'document'->>'id')::uuid from stage_1_1_results where name = 'paid_marketing'),
    'test-reversal-marketing', 'Incorrect campaign charge',
    (select (payload->'document'->>'version')::integer from stage_1_1_results where name = 'paid_marketing')
  )
);
select is((select payload->'document'->>'status' from stage_1_1_results where name = 'reversal'),
  'reversed', 'storno marks the original paid document reversed');
select is((select payload->'transaction'->>'accounting_kind' from stage_1_1_results where name = 'reversal'),
  'operating_expense_reversal', 'storno creates a compensating ledger classification');
select is((select payload->'transaction'->>'transaction_type' from stage_1_1_results where name = 'reversal'),
  'deposit', 'storno cash direction is an inflow without becoming ordinary income');
select is(
  (public.reverse_expense_document(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    (select (payload->'document'->>'id')::uuid from stage_1_1_results where name = 'reversal'),
    'test-reversal-marketing', 'Incorrect campaign charge', 1
  )->>'idempotent_replay')::boolean,
  true,
  'storno replays before evaluating stale lifecycle/version state'
);

select is(
  (public.get_expense_documents_overview(
    '00000000-0000-0000-0000-000000000001',
    current_date - 30, current_date - 30, null, null, 'SQL paid marketing'
  )->'summary'->>'net_paid_amount'),
  '50.50',
  'a later reversal does not erase the original historical period'
);
select is(
  (public.get_expense_documents_overview(
    '00000000-0000-0000-0000-000000000001',
    current_date, current_date, null, null, 'SQL paid marketing'
  )->'summary'->>'net_paid_amount'),
  '-50.50',
  'the reversal is recognized in its own ledger period'
);
select is(
  (public.get_expense_documents_overview(
    '00000000-0000-0000-0000-000000000001',
    current_date - 30, current_date, null, null, 'SQL paid marketing'
  )->'marketing'->>'spend'),
  '0.00',
  'a full reversal nets marketing spend across the combined period'
);
select is(
  (public.get_expense_documents_overview(
    '00000000-0000-0000-0000-000000000001',
    current_date - 30, current_date, null, null, 'SQL paid marketing'
  )->'marketing'->>'leads')::integer,
  0,
  'a full reversal also nets manually attributed marketing outcomes'
);
select ok(
  (public.get_expense_documents_overview(
    '00000000-0000-0000-0000-000000000001',
    current_date - 30, current_date, null, null, null
  )->'summary') ?& array['planned_amount', 'paid_amount', 'reversed_amount', 'net_paid_amount', 'documents_count'],
  'overview exposes canonical UI amount/count keys'
);

insert into stage_1_1_results values (
  'template',
  public.create_recurring_expense_template(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'test-template',
    '{"name":"Monthly rent","amount":"600.00","category":"Оренда","frequency":"monthly","day_of_month":31}'::jsonb
  )
);
select is((select payload->'template'->>'frequency' from stage_1_1_results where name = 'template'),
  'monthly', 'recurring template create uses the p_template JSON contract');
insert into stage_1_1_results values (
  'confirmed_template',
  public.confirm_recurring_expense_template(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    (select (payload->'template'->>'id')::uuid from stage_1_1_results where name = 'template'),
    'test-template-confirm', date '2027-01-31', date '2027-02-05'
  )
);
select is((select payload->'document'->>'status' from stage_1_1_results where name = 'confirmed_template'),
  'planned', 'template confirmation creates a planned document only');
select is((select payload->'template'->>'next_due_date' from stage_1_1_results where name = 'confirmed_template'),
  '2027-02-28', 'month-end recurrence clamps day 31 to February month-end');
select is(
  (public.confirm_recurring_expense_template(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    (select (payload->'template'->>'id')::uuid from stage_1_1_results where name = 'template'),
    'test-template-confirm', date '2027-01-31', date '2027-02-05'
  )->>'idempotent_replay')::boolean,
  true,
  'template confirmation replay has no duplicate side effects'
);

insert into public.finance_transactions (
  org_id, created_by, transaction_type, payment_method, status, source,
  category, amount, currency, description, occurred_at
) values (
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'payment', 'cash', 'completed', 'visit', 'Legacy writer probe', 9.99, 'UAH',
  'Inserted without new dimensions', now()
);
select ok(
  exists (select 1 from public.finance_transactions
    where description = 'Inserted without new dimensions'
      and accounting_kind = 'client_payment' and financial_account_id is not null),
  'compatibility trigger supplies dimensions for existing transaction writers'
);

select ok(
  exists (select 1 from public.finance_audit_log
    where entity_type = 'expense_document' and action in ('created', 'paid', 'reversed')),
  'expense lifecycle writes append-only audit records'
);
select throws_ok(
  $$update public.finance_audit_log set action = 'tampered' where id =
    (select min(id) from public.finance_audit_log)$$,
  '55000', 'finance audit log is append-only',
  'audit records cannot be updated'
);

insert into public.finance_documents (
  org_id, storage_path, original_name, mime_type, size_bytes, uploaded_by
) values (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001/test-proof.pdf',
  'proof.pdf', 'application/pdf', 1024,
  '10000000-0000-0000-0000-000000000001'
);
select throws_ok(
  $$delete from public.finance_documents where storage_path =
    '00000000-0000-0000-0000-000000000001/test-proof.pdf'$$,
  '55000', 'finance documents use soft delete',
  'finance document metadata cannot be hard-deleted'
);

select * from finish();
rollback;
