-- Stage 1.1: UAH-only expense documents, accounts, private attachments and
-- append-only audit. The Flask backend is the only caller: all tables and RPCs
-- remain unavailable to PUBLIC, anon and authenticated.

begin;

do $migration$
declare
  missing_columns text[];
begin
  if to_regclass('public.orgs') is null
     or to_regclass('public.finance_transactions') is null then
    raise exception using
      errcode = '55000',
      message = 'Stage 1.1 requires the production-equivalent Stage 0.1 baseline';
  end if;

  select array_agg(required.column_name order by required.column_name)
  into missing_columns
  from unnest(array[
    'id', 'org_id', 'created_by', 'transaction_type', 'payment_method',
    'status', 'source', 'category', 'amount', 'currency', 'description',
    'counterparty', 'document_url', 'external_provider',
    'external_reference', 'occurred_at', 'created_at', 'updated_at', 'metadata'
  ]) as required(column_name)
  where not exists (
    select 1
    from information_schema.columns as existing
    where existing.table_schema = 'public'
      and existing.table_name = 'finance_transactions'
      and existing.column_name = required.column_name
  );

  if coalesce(cardinality(missing_columns), 0) > 0 then
    raise exception using
      errcode = '55000',
      message = format(
        'Stage 1.1 preflight failed; finance_transactions is missing: %s',
        array_to_string(missing_columns, ', ')
      );
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orgs'
      and column_name = 'id'
      and udt_name = 'uuid'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Stage 1.1 preflight failed; public.orgs.id must be uuid';
  end if;
end
$migration$;

create table if not exists public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 150),
  account_type text not null check (
    account_type in ('cash', 'bank', 'terminal', 'other')
  ),
  system_key text,
  currency text not null default 'UAH' check (currency = 'UAH'),
  is_default boolean not null default false,
  is_active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_accounts_org_id_id_key unique (org_id, id),
  constraint financial_accounts_org_system_key_key unique (org_id, system_key),
  constraint financial_accounts_system_key_check check (
    system_key is null
    or system_key in ('cash', 'bank', 'terminal', 'other')
  )
);

create unique index if not exists financial_accounts_one_default_per_type_idx
  on public.financial_accounts (org_id, account_type)
  where is_default;
create index if not exists financial_accounts_org_active_idx
  on public.financial_accounts (org_id, is_active, account_type);

create table if not exists public.expense_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete restrict,
  document_number text not null,
  document_kind text not null default 'expense' check (
    document_kind in ('expense', 'reversal')
  ),
  status text not null check (
    status in ('planned', 'paid', 'cancelled', 'reversed')
  ),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'UAH' check (currency = 'UAH'),
  category text not null check (char_length(trim(category)) between 1 and 150),
  subcategory text,
  description text,
  counterparty text,
  document_url text,
  expense_date date not null,
  due_date date,
  payment_method text check (
    payment_method is null
    or payment_method in ('cash', 'card', 'transfer', 'terminal', 'other')
  ),
  financial_account_id uuid,
  paid_at timestamptz,
  transaction_id uuid,
  idempotency_key text not null check (
    char_length(trim(idempotency_key)) between 1 and 200
  ),
  marketing_campaign text,
  marketing_channel text,
  marketing_leads integer check (marketing_leads is null or marketing_leads >= 0),
  marketing_new_clients integer check (
    marketing_new_clients is null or marketing_new_clients >= 0
  ),
  marketing_revenue numeric(14, 2) check (
    marketing_revenue is null or marketing_revenue >= 0
  ),
  recurring_template_id uuid,
  reverses_document_id uuid,
  reversed_by_document_id uuid,
  reversal_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid,
  reversed_at timestamptz,
  reversed_by uuid,
  created_by uuid not null,
  updated_by uuid not null,
  paid_by uuid,
  is_legacy boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expense_documents_org_id_id_key unique (org_id, id),
  constraint expense_documents_org_number_key unique (org_id, document_number),
  constraint expense_documents_org_idempotency_key unique (org_id, idempotency_key),
  constraint expense_documents_transaction_id_key unique (transaction_id),
  constraint expense_documents_reverses_document_id_key unique (reverses_document_id),
  constraint expense_documents_account_fk foreign key (org_id, financial_account_id)
    references public.financial_accounts(org_id, id) on delete restrict,
  constraint expense_documents_reverses_fk foreign key (org_id, reverses_document_id)
    references public.expense_documents(org_id, id) on delete restrict,
  constraint expense_documents_reversed_by_document_fk foreign key (org_id, reversed_by_document_id)
    references public.expense_documents(org_id, id) on delete restrict,
  constraint expense_documents_lifecycle_check check (
    (status = 'planned' and transaction_id is null and paid_at is null)
    or (status = 'cancelled' and transaction_id is null and cancelled_at is not null)
    or (status = 'paid' and transaction_id is not null and paid_at is not null
        and payment_method is not null and financial_account_id is not null)
    or (status = 'reversed' and transaction_id is not null and paid_at is not null
        and reversed_at is not null and reversed_by_document_id is not null)
  ),
  constraint expense_documents_kind_check check (
    (document_kind = 'expense' and reverses_document_id is null)
    or (document_kind = 'reversal' and reverses_document_id is not null and status = 'paid')
  ),
  constraint expense_documents_dates_check check (
    due_date is null or due_date >= expense_date
  ),
  constraint expense_documents_marketing_funnel_check check (
    marketing_new_clients is null
    or (marketing_leads is not null and marketing_new_clients <= marketing_leads)
  ),
  constraint expense_documents_marketing_category_check check (
    not (
      marketing_campaign is not null or marketing_channel is not null
      or coalesce(marketing_leads, 0) > 0
      or coalesce(marketing_new_clients, 0) > 0
      or coalesce(marketing_revenue, 0) > 0
    )
    or lower(category) ~ '(маркетинг|marketing)'
  )
);

create index if not exists expense_documents_org_date_idx
  on public.expense_documents (org_id, expense_date desc, id);
create index if not exists expense_documents_org_status_date_idx
  on public.expense_documents (org_id, status, expense_date desc);
create index if not exists expense_documents_org_category_date_idx
  on public.expense_documents (org_id, category, expense_date desc);
create index if not exists expense_documents_marketing_idx
  on public.expense_documents (org_id, expense_date desc)
  where marketing_campaign is not null or marketing_channel is not null;

create table if not exists public.finance_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete restrict,
  expense_document_id uuid,
  storage_bucket text not null default 'finance-documents' check (
    storage_bucket = 'finance-documents'
  ),
  storage_path text not null check (char_length(trim(storage_path)) between 1 and 1000),
  original_name text not null check (char_length(trim(original_name)) between 1 and 500),
  mime_type text not null check (
    mime_type in (
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
      'image/heic', 'image/heif'
    )
  ),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  checksum_sha256 text check (
    checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-fA-F]{64}$'
  ),
  uploaded_by uuid not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  constraint finance_documents_org_id_id_key unique (org_id, id),
  constraint finance_documents_storage_path_key unique (storage_bucket, storage_path),
  constraint finance_documents_expense_fk foreign key (org_id, expense_document_id)
    references public.expense_documents(org_id, id) on delete restrict,
  constraint finance_documents_delete_check check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  )
);
create index if not exists finance_documents_expense_idx
  on public.finance_documents (org_id, expense_document_id, created_at)
  where deleted_at is null;

create table if not exists public.recurring_expense_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 150),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'UAH' check (currency = 'UAH'),
  category text not null check (char_length(trim(category)) between 1 and 150),
  subcategory text,
  description text,
  counterparty text,
  document_number text,
  document_url text,
  frequency text not null default 'monthly' check (
    frequency in ('monthly', 'quarterly', 'yearly')
  ),
  interval_months integer not null default 1 check (interval_months in (1, 3, 12)),
  day_of_month integer check (day_of_month between 1 and 31),
  next_due_date date,
  payment_method text check (
    payment_method is null
    or payment_method in ('cash', 'card', 'transfer', 'terminal', 'other')
  ),
  financial_account_id uuid,
  marketing_campaign text,
  marketing_channel text,
  marketing_leads integer check (marketing_leads is null or marketing_leads >= 0),
  marketing_new_clients integer check (
    marketing_new_clients is null or marketing_new_clients >= 0
  ),
  marketing_revenue numeric(14, 2) check (
    marketing_revenue is null or marketing_revenue >= 0
  ),
  is_active boolean not null default true,
  idempotency_key text not null check (
    char_length(trim(idempotency_key)) between 1 and 200
  ),
  last_confirmed_at timestamptz,
  last_created_document_id uuid,
  version integer not null default 1 check (version > 0),
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recurring_expense_templates_org_id_id_key unique (org_id, id),
  constraint recurring_expense_templates_org_key unique (org_id, idempotency_key),
  constraint recurring_expense_templates_account_fk foreign key (org_id, financial_account_id)
    references public.financial_accounts(org_id, id) on delete restrict,
  constraint recurring_expense_templates_document_fk foreign key (org_id, last_created_document_id)
    references public.expense_documents(org_id, id) on delete restrict,
  constraint recurring_expense_templates_frequency_interval_check check (
    (frequency = 'monthly' and interval_months = 1)
    or (frequency = 'quarterly' and interval_months = 3)
    or (frequency = 'yearly' and interval_months = 12)
  ),
  constraint recurring_expense_templates_marketing_funnel_check check (
    marketing_new_clients is null
    or (marketing_leads is not null and marketing_new_clients <= marketing_leads)
  ),
  constraint recurring_expense_templates_marketing_category_check check (
    not (
      marketing_campaign is not null or marketing_channel is not null
      or coalesce(marketing_leads, 0) > 0
      or coalesce(marketing_new_clients, 0) > 0
      or coalesce(marketing_revenue, 0) > 0
    )
    or lower(category) ~ '(маркетинг|marketing)'
  )
);
create index if not exists recurring_expense_templates_org_active_idx
  on public.recurring_expense_templates (org_id, is_active, next_due_date);

alter table public.expense_documents
  add constraint expense_documents_recurring_template_fk
  foreign key (org_id, recurring_template_id)
  references public.recurring_expense_templates(org_id, id) on delete restrict;
create index if not exists expense_documents_recurring_template_idx
  on public.expense_documents (org_id, recurring_template_id, expense_date desc)
  where recurring_template_id is not null;

create table if not exists public.finance_audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs(id) on delete restrict,
  entity_type text not null check (
    entity_type in (
      'financial_account', 'expense_document', 'finance_document',
      'recurring_expense_template'
    )
  ),
  entity_id uuid not null,
  action text not null check (char_length(trim(action)) between 1 and 100),
  actor_id uuid not null,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists finance_audit_log_entity_idx
  on public.finance_audit_log (org_id, entity_type, entity_id, created_at desc);
create index if not exists finance_audit_log_org_created_idx
  on public.finance_audit_log (org_id, created_at desc);

alter table public.finance_transactions
  add column if not exists accounting_kind text,
  add column if not exists financial_account_id uuid,
  add column if not exists expense_document_id uuid,
  add column if not exists stock_purchase_id uuid,
  add column if not exists payroll_reference_id uuid,
  add column if not exists reverses_transaction_id uuid;

update public.finance_transactions
set accounting_kind = case
  when transaction_type = 'payment' then 'client_payment'
  when transaction_type = 'refund' then 'client_refund'
  when transaction_type = 'expense' then 'operating_expense'
  when transaction_type = 'deposit' then 'cash_deposit'
  when transaction_type = 'withdrawal' then 'cash_withdrawal'
  else 'other'
end
where accounting_kind is null;

alter table public.finance_transactions
  alter column accounting_kind set not null;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_transactions'::regclass
      and conname = 'finance_transactions_accounting_kind_check'
  ) then
    alter table public.finance_transactions
      add constraint finance_transactions_accounting_kind_check check (
        accounting_kind in (
          'client_payment', 'client_refund', 'operating_expense',
          'operating_expense_reversal', 'cash_deposit', 'cash_withdrawal',
          'supplier_payment', 'supplier_advance', 'payroll_payment', 'other'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_transactions'::regclass
      and conname = 'finance_transactions_org_id_id_key'
  ) then
    alter table public.finance_transactions
      add constraint finance_transactions_org_id_id_key unique (org_id, id);
  end if;
end
$migration$;

insert into public.financial_accounts (
  org_id, name, account_type, system_key, currency, is_default, is_active
)
select org.id, account.name, account.account_type, account.system_key,
       'UAH', true, true
from public.orgs as org
cross join (values
  ('Готівкова каса', 'cash', 'cash'),
  ('Банківський рахунок', 'bank', 'bank'),
  ('Термінал', 'terminal', 'terminal'),
  ('Інший рахунок', 'other', 'other')
) as account(name, account_type, system_key)
on conflict (org_id, system_key) do nothing;

update public.finance_transactions as transaction
set financial_account_id = account.id
from public.financial_accounts as account
where transaction.financial_account_id is null
  and account.org_id = transaction.org_id
  and account.is_default
  and account.system_key = case
    when transaction.payment_method = 'cash' then 'cash'
    when transaction.payment_method = 'transfer' then 'bank'
    when transaction.payment_method in ('card', 'terminal') then 'terminal'
    else 'other'
  end;

alter table public.finance_transactions
  alter column financial_account_id set not null;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_transactions'::regclass
      and conname = 'finance_transactions_account_fk'
  ) then
    alter table public.finance_transactions
      add constraint finance_transactions_account_fk
      foreign key (org_id, financial_account_id)
      references public.financial_accounts(org_id, id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_transactions'::regclass
      and conname = 'finance_transactions_expense_document_fk'
  ) then
    alter table public.finance_transactions
      add constraint finance_transactions_expense_document_fk
      foreign key (org_id, expense_document_id)
      references public.expense_documents(org_id, id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_transactions'::regclass
      and conname = 'finance_transactions_reverses_fk'
  ) then
    alter table public.finance_transactions
      add constraint finance_transactions_reverses_fk
      foreign key (org_id, reverses_transaction_id)
      references public.finance_transactions(org_id, id) on delete restrict;
  end if;

  if to_regclass('public.stock_purchases') is not null and not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_transactions'::regclass
      and conname = 'finance_transactions_stock_purchase_fk'
  ) then
    begin
      alter table public.stock_purchases
        add constraint stock_purchases_org_id_id_key unique (org_id, id);
    exception when duplicate_object then null;
    end;
    alter table public.finance_transactions
      add constraint finance_transactions_stock_purchase_fk
      foreign key (org_id, stock_purchase_id)
      references public.stock_purchases(org_id, id) on delete restrict;
  end if;
end
$migration$;

create unique index if not exists finance_transactions_expense_document_idx
  on public.finance_transactions (expense_document_id)
  where expense_document_id is not null;
create unique index if not exists finance_transactions_reversal_once_idx
  on public.finance_transactions (reverses_transaction_id)
  where reverses_transaction_id is not null;
create index if not exists finance_transactions_org_account_date_idx
  on public.finance_transactions (org_id, financial_account_id, occurred_at desc);
create index if not exists finance_transactions_org_accounting_date_idx
  on public.finance_transactions (org_id, accounting_kind, occurred_at desc);
create unique index if not exists finance_transactions_expense_idempotency_idx
  on public.finance_transactions (org_id, external_provider, external_reference)
  where external_provider in (
    'pugcrm-expense', 'pugcrm-expense-payment', 'pugcrm-expense-reversal'
  ) and external_reference is not null;

-- Backfill every existing completed manual expense. The source transaction is
-- retained byte-for-byte in its legacy columns and receives only new links.
insert into public.expense_documents (
  id, org_id, document_number, document_kind, status, amount, currency,
  category, description, counterparty, document_url, expense_date,
  payment_method, financial_account_id, paid_at, transaction_id,
  idempotency_key, created_by, updated_by, paid_by, is_legacy,
  created_at, updated_at
)
select
  gen_random_uuid(), transaction.org_id,
  'LEGACY-' || upper(replace(transaction.id::text, '-', '')),
  'expense', 'paid', transaction.amount, 'UAH',
  coalesce(nullif(trim(transaction.category), ''), 'Без категорії'),
  transaction.description, transaction.counterparty, transaction.document_url,
  (transaction.occurred_at at time zone 'Europe/Kyiv')::date,
  coalesce(transaction.payment_method, 'other'),
  transaction.financial_account_id, transaction.occurred_at, transaction.id,
  'legacy-finance-transaction:' || transaction.id::text,
  transaction.created_by,
  transaction.created_by,
  transaction.created_by, true, transaction.created_at, transaction.updated_at
from public.finance_transactions as transaction
where transaction.transaction_type = 'expense'
  and transaction.status = 'completed'
  and transaction.source = 'manual'
  and transaction.created_by is not null
on conflict (transaction_id) do nothing;

do $migration$
begin
  if exists (
    select 1
    from public.finance_transactions
    where transaction_type = 'expense'
      and status = 'completed'
      and source = 'manual'
      and created_by is null
  ) then
    raise exception using
      errcode = '23502',
      message = 'legacy manual expense has no creating user';
  end if;
end
$migration$;

update public.finance_transactions as transaction
set expense_document_id = document.id,
    accounting_kind = 'operating_expense'
from public.expense_documents as document
where document.transaction_id = transaction.id
  and document.org_id = transaction.org_id
  and transaction.expense_document_id is distinct from document.id;

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
values (
  'finance-documents', 'finance-documents', false, 10485760,
  array[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'image/heic', 'image/heif'
  ]::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.assert_operating_expense_category(
  p_category text
)
returns void
language plpgsql
immutable
security invoker
set search_path = public, pg_temp
as $function$
declare
  normalized text := lower(trim(coalesce(p_category, '')));
begin
  if normalized = '' then
    raise exception using errcode = '22023', message = 'expense category is required';
  end if;

  if normalized ~ '(закупівл|закупк|постачальник|зарплат|виплат[аи] персонал|procurement|supplier[ _-]*payment|payroll|salary)' then
    raise exception using
      errcode = '22023',
      message = 'reserved expense category; use procurement or payroll workflow';
  end if;
end
$function$;

create or replace function public.guard_operating_expense_category()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  if tg_table_name = 'expense_documents'
     and (new.is_legacy or new.document_kind = 'reversal') then
    return new;
  end if;
  perform public.assert_operating_expense_category(new.category);
  return new;
end
$function$;

drop trigger if exists guard_operating_expense_category on public.expense_documents;
create trigger guard_operating_expense_category
before insert or update of category on public.expense_documents
for each row execute function public.guard_operating_expense_category();

drop trigger if exists guard_recurring_expense_category on public.recurring_expense_templates;
create trigger guard_recurring_expense_category
before insert or update of category on public.recurring_expense_templates
for each row execute function public.guard_operating_expense_category();

create or replace function public.create_recurring_expense_template(
  p_org_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_template jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  template_row public.recurring_expense_templates%rowtype;
  amount_value numeric;
  category_value text;
  frequency_value text;
  interval_value integer;
  method_value text;
  account_id uuid;
begin
  perform public.assert_finance_actor(p_org_id, p_user_id);
  if p_template is null or jsonb_typeof(p_template) <> 'object' then
    raise exception using errcode = '22023', message = 'template payload must be an object';
  end if;
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null
     or char_length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;

  select * into template_row from public.recurring_expense_templates
  where org_id = p_org_id and idempotency_key = trim(p_idempotency_key);
  if found then
    return jsonb_build_object('template', to_jsonb(template_row), 'idempotent_replay', true);
  end if;

  amount_value := (p_template->>'amount')::numeric;
  category_value := trim(coalesce(p_template->>'category', ''));
  frequency_value := lower(trim(coalesce(p_template->>'frequency', 'monthly')));
  interval_value := coalesce(nullif(p_template->>'interval_months', '')::integer,
    case frequency_value when 'monthly' then 1 when 'quarterly' then 3 when 'yearly' then 12 end);
  method_value := nullif(lower(trim(coalesce(p_template->>'payment_method', ''))), '');

  if nullif(trim(coalesce(p_template->>'name', '')), '') is null then
    raise exception using errcode = '22023', message = 'template name is required';
  end if;
  if amount_value is null or amount_value <= 0 or amount_value <> round(amount_value, 2)
     or amount_value::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'amount must be a positive two-decimal value';
  end if;
  perform public.assert_operating_expense_category(category_value);
  if frequency_value not in ('monthly', 'quarterly', 'yearly')
     or interval_value is distinct from case frequency_value
       when 'monthly' then 1 when 'quarterly' then 3 when 'yearly' then 12 end then
    raise exception using errcode = '22023', message = 'invalid recurring frequency';
  end if;

  if method_value is not null then
    account_id := public.resolve_financial_account(
      p_org_id, method_value, nullif(p_template->>'financial_account_id', '')::uuid
    );
  elsif nullif(p_template->>'financial_account_id', '') is not null then
    raise exception using errcode = '22023', message = 'payment method is required for account';
  end if;

  insert into public.recurring_expense_templates (
    org_id, name, amount, currency, category, subcategory, description,
    counterparty, document_number, document_url, frequency, interval_months,
    day_of_month, next_due_date, payment_method, financial_account_id,
    marketing_campaign, marketing_channel, marketing_leads,
    marketing_new_clients, marketing_revenue, is_active, idempotency_key,
    created_by, updated_by
  ) values (
    p_org_id, trim(p_template->>'name'), amount_value, 'UAH', category_value,
    nullif(trim(p_template->>'subcategory'), ''),
    nullif(trim(p_template->>'description'), ''),
    nullif(trim(p_template->>'counterparty'), ''),
    nullif(trim(p_template->>'document_number'), ''),
    nullif(trim(p_template->>'document_url'), ''), frequency_value, interval_value,
    nullif(p_template->>'day_of_month', '')::integer,
    nullif(p_template->>'next_due_date', '')::date, method_value, account_id,
    nullif(trim(p_template->>'marketing_campaign'), ''),
    nullif(trim(p_template->>'marketing_channel'), ''),
    nullif(p_template->>'marketing_leads', '')::integer,
    nullif(p_template->>'marketing_new_clients', '')::integer,
    round(nullif(p_template->>'marketing_revenue', '')::numeric, 2),
    coalesce((p_template->>'is_active')::boolean, true), trim(p_idempotency_key),
    p_user_id, p_user_id
  ) returning * into template_row;

  perform public.write_finance_audit(
    p_org_id, 'recurring_expense_template', template_row.id, 'created', p_user_id,
    null, to_jsonb(template_row), '{}'::jsonb
  );
  return jsonb_build_object('template', to_jsonb(template_row), 'idempotent_replay', false);
exception when unique_violation then
  select * into template_row from public.recurring_expense_templates
  where org_id = p_org_id and idempotency_key = trim(p_idempotency_key);
  if found then
    return jsonb_build_object('template', to_jsonb(template_row), 'idempotent_replay', true);
  end if;
  raise;
end
$function$;

create or replace function public.update_recurring_expense_template(
  p_org_id uuid,
  p_user_id uuid,
  p_template_id uuid,
  p_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  template_row public.recurring_expense_templates%rowtype;
  before_row jsonb;
  invalid_key text;
  amount_value numeric;
  category_value text;
  frequency_value text;
  interval_value integer;
  method_value text;
  account_id uuid;
begin
  perform public.assert_finance_actor(p_org_id, p_user_id);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'non-empty patch object is required';
  end if;
  select key into invalid_key from jsonb_object_keys(p_patch) as patch_key(key)
  where not (key = any(array[
    'name', 'amount', 'category', 'subcategory', 'description', 'counterparty',
    'document_number', 'document_url', 'frequency', 'interval_months',
    'day_of_month', 'next_due_date', 'payment_method', 'financial_account_id',
    'marketing_campaign', 'marketing_channel', 'marketing_leads',
    'marketing_new_clients', 'marketing_revenue', 'is_active'
  ]::text[])) limit 1;
  if invalid_key is not null then
    raise exception using errcode = '22023', message = 'unsupported template patch field: ' || invalid_key;
  end if;

  select * into template_row from public.recurring_expense_templates
  where org_id = p_org_id and id = p_template_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'recurring template not found';
  end if;
  if template_row.version <> p_version then
    raise exception using errcode = '40001', message = 'recurring template version conflict';
  end if;

  before_row := to_jsonb(template_row);
  amount_value := case when p_patch ? 'amount'
    then (p_patch->>'amount')::numeric else template_row.amount end;
  category_value := case when p_patch ? 'category'
    then trim(coalesce(p_patch->>'category', '')) else template_row.category end;
  frequency_value := case when p_patch ? 'frequency'
    then lower(trim(coalesce(p_patch->>'frequency', ''))) else template_row.frequency end;
  interval_value := case when p_patch ? 'interval_months'
    then (p_patch->>'interval_months')::integer
    when p_patch ? 'frequency' then case frequency_value
      when 'monthly' then 1 when 'quarterly' then 3 when 'yearly' then 12 end
    else template_row.interval_months end;
  method_value := case when p_patch ? 'payment_method'
    then nullif(lower(trim(coalesce(p_patch->>'payment_method', ''))), '')
    else template_row.payment_method end;

  if nullif(trim(case when p_patch ? 'name' then p_patch->>'name' else template_row.name end), '') is null then
    raise exception using errcode = '22023', message = 'template name is required';
  end if;
  if amount_value is null or amount_value <= 0 or amount_value <> round(amount_value, 2) then
    raise exception using errcode = '22023', message = 'invalid template amount';
  end if;
  perform public.assert_operating_expense_category(category_value);
  if interval_value is distinct from case frequency_value
      when 'monthly' then 1 when 'quarterly' then 3 when 'yearly' then 12 end then
    raise exception using errcode = '22023', message = 'invalid recurring frequency';
  end if;
  if method_value is not null then
    account_id := public.resolve_financial_account(
      p_org_id, method_value,
      case when p_patch ? 'financial_account_id'
        then nullif(p_patch->>'financial_account_id', '')::uuid
        else template_row.financial_account_id end
    );
  elsif p_patch ? 'financial_account_id'
      and nullif(p_patch->>'financial_account_id', '') is not null then
    raise exception using errcode = '22023', message = 'payment method is required for account';
  end if;

  update public.recurring_expense_templates
  set name = case when p_patch ? 'name' then trim(p_patch->>'name') else name end,
      amount = amount_value, category = category_value,
      subcategory = case when p_patch ? 'subcategory' then nullif(trim(p_patch->>'subcategory'), '') else subcategory end,
      description = case when p_patch ? 'description' then nullif(trim(p_patch->>'description'), '') else description end,
      counterparty = case when p_patch ? 'counterparty' then nullif(trim(p_patch->>'counterparty'), '') else counterparty end,
      document_number = case when p_patch ? 'document_number' then nullif(trim(p_patch->>'document_number'), '') else document_number end,
      document_url = case when p_patch ? 'document_url' then nullif(trim(p_patch->>'document_url'), '') else document_url end,
      frequency = frequency_value, interval_months = interval_value,
      day_of_month = case when p_patch ? 'day_of_month' then nullif(p_patch->>'day_of_month', '')::integer else day_of_month end,
      next_due_date = case when p_patch ? 'next_due_date' then nullif(p_patch->>'next_due_date', '')::date else next_due_date end,
      payment_method = method_value, financial_account_id = account_id,
      marketing_campaign = case when p_patch ? 'marketing_campaign' then nullif(trim(p_patch->>'marketing_campaign'), '') else marketing_campaign end,
      marketing_channel = case when p_patch ? 'marketing_channel' then nullif(trim(p_patch->>'marketing_channel'), '') else marketing_channel end,
      marketing_leads = case when p_patch ? 'marketing_leads' then nullif(p_patch->>'marketing_leads', '')::integer else marketing_leads end,
      marketing_new_clients = case when p_patch ? 'marketing_new_clients' then nullif(p_patch->>'marketing_new_clients', '')::integer else marketing_new_clients end,
      marketing_revenue = case when p_patch ? 'marketing_revenue' then round(nullif(p_patch->>'marketing_revenue', '')::numeric, 2) else marketing_revenue end,
      is_active = case when p_patch ? 'is_active' then (p_patch->>'is_active')::boolean else is_active end,
      updated_by = p_user_id, updated_at = now(), version = version + 1
  where id = p_template_id returning * into template_row;

  perform public.write_finance_audit(
    p_org_id, 'recurring_expense_template', p_template_id, 'updated', p_user_id,
    before_row, to_jsonb(template_row), '{}'::jsonb
  );
  return jsonb_build_object('template', to_jsonb(template_row));
end
$function$;

create or replace function public.confirm_recurring_expense_template(
  p_org_id uuid,
  p_user_id uuid,
  p_template_id uuid,
  p_idempotency_key text,
  p_expense_date date,
  p_due_date date
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  template_row public.recurring_expense_templates%rowtype;
  document_row public.expense_documents%rowtype;
  create_result jsonb;
  document_id uuid;
  template_before jsonb;
  effective_expense_date date;
  target_month date;
  next_due_day integer;
begin
  perform public.assert_finance_actor(p_org_id, p_user_id);
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;

  select * into document_row from public.expense_documents
  where org_id = p_org_id and idempotency_key = trim(p_idempotency_key);
  if found then
    if document_row.recurring_template_id is distinct from p_template_id then
      raise exception using errcode = '23505', message = 'idempotency key belongs to another operation';
    end if;
    return jsonb_build_object('template_id', p_template_id,
      'document', to_jsonb(document_row), 'idempotent_replay', true);
  end if;

  select * into template_row from public.recurring_expense_templates
  where org_id = p_org_id and id = p_template_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'recurring template not found';
  end if;
  if not template_row.is_active then
    raise exception using errcode = '55000', message = 'recurring template is inactive';
  end if;

  -- Recheck after the template row lock. A concurrent confirmation may have
  -- committed while this call was waiting for the lock.
  select * into document_row from public.expense_documents
  where org_id = p_org_id and idempotency_key = trim(p_idempotency_key);
  if found then
    if document_row.recurring_template_id is distinct from p_template_id then
      raise exception using errcode = '23505', message = 'idempotency key belongs to another operation';
    end if;
    return jsonb_build_object('template', to_jsonb(template_row),
      'document', to_jsonb(document_row), 'idempotent_replay', true);
  end if;
  effective_expense_date := coalesce(
    p_expense_date,
    template_row.next_due_date,
    (now() at time zone 'Europe/Kyiv')::date
  );
  if p_due_date is not null and p_due_date < effective_expense_date then
    raise exception using errcode = '22023', message = 'invalid expense dates';
  end if;

  template_before := to_jsonb(template_row);
  create_result := public.create_expense_document(
    p_org_id, p_user_id, trim(p_idempotency_key), 'planned',
    template_row.amount, template_row.category, template_row.subcategory,
    template_row.description, template_row.counterparty, null,
    template_row.document_url, effective_expense_date, p_due_date,
    template_row.payment_method, template_row.financial_account_id,
    jsonb_build_object(
      'campaign', template_row.marketing_campaign,
      'channel', template_row.marketing_channel,
      'leads', template_row.marketing_leads,
      'new_clients', template_row.marketing_new_clients,
      'revenue', template_row.marketing_revenue
    ), '{}'::uuid[]
  );
  document_id := (create_result->'document'->>'id')::uuid;

  update public.expense_documents
  set recurring_template_id = p_template_id, updated_by = p_user_id
  where org_id = p_org_id and id = document_id
  returning * into document_row;

  target_month := (
    date_trunc('month', effective_expense_date)::date
    + make_interval(months => template_row.interval_months)
  )::date;
  next_due_day := least(
    coalesce(template_row.day_of_month, extract(day from effective_expense_date)::integer),
    extract(day from (target_month + interval '1 month - 1 day'))::integer
  );

  update public.recurring_expense_templates
  set last_confirmed_at = now(), last_created_document_id = document_id,
      next_due_date = target_month + (next_due_day - 1),
      updated_by = p_user_id, updated_at = now(), version = version + 1
  where id = p_template_id returning * into template_row;

  perform public.write_finance_audit(
    p_org_id, 'recurring_expense_template', p_template_id, 'confirmed', p_user_id,
    template_before, to_jsonb(template_row), jsonb_build_object('document_id', document_id)
  );
  return jsonb_build_object('template', to_jsonb(template_row),
    'document', to_jsonb(document_row), 'idempotent_replay', false);
end
$function$;

create or replace function public.update_expense_document(
  p_org_id uuid,
  p_user_id uuid,
  p_document_id uuid,
  p_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  document_row public.expense_documents%rowtype;
  before_row jsonb;
  allowed_keys text[];
  invalid_key text;
  new_amount numeric;
  new_category text;
  new_expense_date date;
  new_due_date date;
  new_method text;
  new_account_id uuid;
  attachment_ids uuid[] := '{}'::uuid[];
  attachment_count integer := 0;
begin
  perform public.assert_finance_actor(p_org_id, p_user_id);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'non-empty patch object is required';
  end if;

  select * into document_row
  from public.expense_documents
  where org_id = p_org_id and id = p_document_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'expense document not found';
  end if;
  if document_row.version <> p_version then
    raise exception using errcode = '40001', message = 'expense document version conflict';
  end if;

  if document_row.status = 'planned' then
    allowed_keys := array[
      'amount', 'category', 'subcategory', 'description', 'counterparty',
      'document_number', 'document_url', 'expense_date', 'due_date',
      'payment_method', 'financial_account_id', 'marketing_campaign',
      'marketing_channel', 'marketing_leads', 'marketing_new_clients',
      'marketing_revenue', 'attachment_ids'
    ];
  elsif document_row.status = 'paid' then
    allowed_keys := array[
      'description', 'counterparty', 'document_number', 'document_url',
      'marketing_campaign', 'marketing_channel', 'marketing_leads',
      'marketing_new_clients', 'marketing_revenue', 'attachment_ids'
    ];
  else
    raise exception using errcode = '55000', message = 'immutable expense document';
  end if;

  select key into invalid_key
  from jsonb_object_keys(p_patch) as patch_key(key)
  where not (key = any(allowed_keys))
  limit 1;
  if invalid_key is not null then
    raise exception using errcode = '22023', message = 'unsupported expense patch field: ' || invalid_key;
  end if;

  before_row := to_jsonb(document_row);
  new_amount := case when p_patch ? 'amount'
    then (p_patch->>'amount')::numeric else document_row.amount end;
  new_category := case when p_patch ? 'category'
    then trim(coalesce(p_patch->>'category', '')) else document_row.category end;
  new_expense_date := case when p_patch ? 'expense_date'
    then (p_patch->>'expense_date')::date else document_row.expense_date end;
  new_due_date := case when p_patch ? 'due_date'
    then nullif(p_patch->>'due_date', '')::date else document_row.due_date end;
  new_method := case when p_patch ? 'payment_method'
    then nullif(lower(trim(coalesce(p_patch->>'payment_method', ''))), '')
    else document_row.payment_method end;

  if document_row.status = 'planned' then
    if new_amount is null or new_amount <= 0 or new_amount <> round(new_amount, 2)
       or new_amount::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception using errcode = '22023', message = 'amount must be a positive two-decimal value';
    end if;
    perform public.assert_operating_expense_category(new_category);
    if new_expense_date is null or (new_due_date is not null and new_due_date < new_expense_date) then
      raise exception using errcode = '22023', message = 'invalid expense dates';
    end if;

    if new_method is null then
      if p_patch ? 'financial_account_id'
         and nullif(p_patch->>'financial_account_id', '') is not null then
        raise exception using errcode = '22023', message = 'payment method is required for account';
      end if;
      new_account_id := null;
    else
      new_account_id := public.resolve_financial_account(
        p_org_id, new_method,
        case
          when p_patch ? 'financial_account_id'
            then nullif(p_patch->>'financial_account_id', '')::uuid
          else document_row.financial_account_id
        end
      );
    end if;
  else
    new_amount := document_row.amount;
    new_category := document_row.category;
    new_expense_date := document_row.expense_date;
    new_due_date := document_row.due_date;
    new_method := document_row.payment_method;
    new_account_id := document_row.financial_account_id;
  end if;

  if p_patch ? 'attachment_ids' then
    if jsonb_typeof(p_patch->'attachment_ids') <> 'array' then
      raise exception using errcode = '22023', message = 'attachment_ids must be an array';
    end if;
    select coalesce(array_agg(value::uuid), '{}'::uuid[])
    into attachment_ids
    from jsonb_array_elements_text(p_patch->'attachment_ids');
    attachment_count := cardinality(attachment_ids);
    if attachment_count <> (
      select count(distinct attachment_id)
      from unnest(attachment_ids) as attachment(attachment_id)
    ) or attachment_count <> (
      select count(*) from public.finance_documents
      where org_id = p_org_id and id = any(attachment_ids)
        and deleted_at is null
        and (expense_document_id is null or expense_document_id = p_document_id)
    ) then
      raise exception using errcode = '23503', message = 'invalid or already linked attachment';
    end if;
  end if;

  if p_patch ? 'document_number'
     and nullif(trim(coalesce(p_patch->>'document_number', '')), '') is null then
    raise exception using errcode = '22023', message = 'document number cannot be empty';
  end if;

  update public.expense_documents
  set amount = new_amount,
      category = new_category,
      subcategory = case when p_patch ? 'subcategory'
        then nullif(trim(p_patch->>'subcategory'), '') else subcategory end,
      description = case when p_patch ? 'description'
        then nullif(trim(p_patch->>'description'), '') else description end,
      counterparty = case when p_patch ? 'counterparty'
        then nullif(trim(p_patch->>'counterparty'), '') else counterparty end,
      document_number = case when p_patch ? 'document_number'
        then nullif(trim(p_patch->>'document_number'), '') else document_number end,
      document_url = case when p_patch ? 'document_url'
        then nullif(trim(p_patch->>'document_url'), '') else document_url end,
      expense_date = new_expense_date, due_date = new_due_date,
      payment_method = new_method, financial_account_id = new_account_id,
      marketing_campaign = case when p_patch ? 'marketing_campaign'
        then nullif(trim(p_patch->>'marketing_campaign'), '') else marketing_campaign end,
      marketing_channel = case when p_patch ? 'marketing_channel'
        then nullif(trim(p_patch->>'marketing_channel'), '') else marketing_channel end,
      marketing_leads = case when p_patch ? 'marketing_leads'
        then nullif(p_patch->>'marketing_leads', '')::integer else marketing_leads end,
      marketing_new_clients = case when p_patch ? 'marketing_new_clients'
        then nullif(p_patch->>'marketing_new_clients', '')::integer else marketing_new_clients end,
      marketing_revenue = case when p_patch ? 'marketing_revenue'
        then round(nullif(p_patch->>'marketing_revenue', '')::numeric, 2) else marketing_revenue end,
      updated_by = p_user_id, version = version + 1
  where id = p_document_id
  returning * into document_row;

  if p_patch ? 'attachment_ids' then
    update public.finance_documents
    set expense_document_id = null
    where org_id = p_org_id and expense_document_id = p_document_id
      and not (id = any(attachment_ids));
    update public.finance_documents
    set expense_document_id = p_document_id
    where org_id = p_org_id and id = any(attachment_ids);
  end if;

  perform public.write_finance_audit(
    p_org_id, 'expense_document', p_document_id, 'updated', p_user_id,
    before_row, to_jsonb(document_row),
    jsonb_build_object('fields', (select jsonb_agg(key) from jsonb_object_keys(p_patch) as key))
  );
  return jsonb_build_object('document', to_jsonb(document_row));
end
$function$;

create or replace function public.cancel_expense_document(
  p_org_id uuid,
  p_user_id uuid,
  p_document_id uuid,
  p_reason text,
  p_version integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  document_row public.expense_documents%rowtype;
  before_row jsonb;
begin
  perform public.assert_finance_actor(p_org_id, p_user_id);
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'cancellation reason is required';
  end if;

  select * into document_row from public.expense_documents
  where org_id = p_org_id and id = p_document_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'expense document not found';
  end if;
  if document_row.status = 'cancelled' then
    return jsonb_build_object('document', to_jsonb(document_row), 'idempotent_replay', true);
  end if;
  if document_row.status <> 'planned' then
    raise exception using errcode = '55000', message = 'only planned expense can be cancelled';
  end if;
  if document_row.version <> p_version then
    raise exception using errcode = '40001', message = 'expense document version conflict';
  end if;

  before_row := to_jsonb(document_row);
  update public.expense_documents
  set status = 'cancelled', cancelled_at = now(), cancelled_by = p_user_id,
      reversal_reason = trim(p_reason), updated_by = p_user_id,
      version = version + 1
  where id = p_document_id returning * into document_row;
  perform public.write_finance_audit(
    p_org_id, 'expense_document', p_document_id, 'cancelled', p_user_id,
    before_row, to_jsonb(document_row), jsonb_build_object('reason', trim(p_reason))
  );
  return jsonb_build_object('document', to_jsonb(document_row), 'idempotent_replay', false);
end
$function$;

create or replace function public.reverse_expense_document(
  p_org_id uuid,
  p_user_id uuid,
  p_document_id uuid,
  p_idempotency_key text,
  p_reason text,
  p_version integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  original_row public.expense_documents%rowtype;
  reversal_row public.expense_documents%rowtype;
  transaction_row public.finance_transactions%rowtype;
  original_before jsonb;
  reversal_id uuid := gen_random_uuid();
begin
  perform public.assert_finance_actor(p_org_id, p_user_id);
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null
     or char_length(trim(p_idempotency_key)) > 180 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'reversal reason is required';
  end if;

  select * into transaction_row
  from public.finance_transactions
  where org_id = p_org_id
    and external_provider = 'pugcrm-expense-reversal'
    and external_reference = trim(p_idempotency_key);
  if found then
    select * into reversal_row from public.expense_documents
    where org_id = p_org_id and id = transaction_row.expense_document_id;
    if reversal_row.reverses_document_id is distinct from p_document_id then
      raise exception using errcode = '23505', message = 'idempotency key belongs to another reversal';
    end if;
    select * into original_row from public.expense_documents
    where org_id = p_org_id and id = p_document_id;
    return jsonb_build_object('document', to_jsonb(original_row),
      'reversal_document', to_jsonb(reversal_row),
      'transaction', to_jsonb(transaction_row), 'idempotent_replay', true);
  end if;

  select * into original_row from public.expense_documents
  where org_id = p_org_id and id = p_document_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'expense document not found';
  end if;
  select * into transaction_row
  from public.finance_transactions
  where org_id = p_org_id
    and external_provider = 'pugcrm-expense-reversal'
    and external_reference = trim(p_idempotency_key);
  if found then
    select * into reversal_row from public.expense_documents
    where org_id = p_org_id and id = transaction_row.expense_document_id;
    if reversal_row.reverses_document_id is distinct from p_document_id then
      raise exception using errcode = '23505', message = 'idempotency key belongs to another reversal';
    end if;
    return jsonb_build_object('document', to_jsonb(original_row),
      'reversal_document', to_jsonb(reversal_row),
      'transaction', to_jsonb(transaction_row), 'idempotent_replay', true);
  end if;
  if original_row.status <> 'paid' or original_row.document_kind <> 'expense' then
    raise exception using errcode = '55000', message = 'only paid expense can be reversed';
  end if;
  if original_row.version <> p_version then
    raise exception using errcode = '40001', message = 'expense document version conflict';
  end if;

  original_before := to_jsonb(original_row);
  insert into public.finance_transactions (
    org_id, created_by, transaction_type, accounting_kind, amount, currency,
    payment_method, financial_account_id, category, description,
    counterparty, source, status, cash_shift_id, visit_id,
    expense_document_id, reverses_transaction_id,
    external_provider, external_reference, occurred_at, metadata
  ) values (
    p_org_id, p_user_id, 'deposit', 'operating_expense_reversal',
    original_row.amount, 'UAH', original_row.payment_method,
    original_row.financial_account_id, original_row.category,
    'Сторно: ' || coalesce(original_row.description, original_row.document_number),
    original_row.counterparty, 'manual', 'completed', null, null, null,
    original_row.transaction_id, 'pugcrm-expense-reversal',
    trim(p_idempotency_key), now(),
    jsonb_build_object('reason', trim(p_reason), 'original_document_id', original_row.id)
  ) returning * into transaction_row;

  insert into public.expense_documents (
    id, org_id, document_number, document_kind, status, amount, currency,
    category, subcategory, description, counterparty, expense_date,
    payment_method, financial_account_id, paid_at, transaction_id,
    idempotency_key, marketing_campaign, marketing_channel, marketing_leads,
    marketing_new_clients, marketing_revenue, reverses_document_id,
    reversal_reason, created_by, updated_by, paid_by
  ) values (
    reversal_id, p_org_id,
    'REV-' || to_char((transaction_row.occurred_at at time zone 'Europe/Kyiv')::date, 'YYYYMMDD')
      || '-' || upper(substr(replace(reversal_id::text, '-', ''), 1, 8)),
    'reversal', 'paid', original_row.amount, 'UAH', original_row.category,
    original_row.subcategory, 'Сторно: ' || coalesce(original_row.description, original_row.document_number),
    original_row.counterparty,
    (transaction_row.occurred_at at time zone 'Europe/Kyiv')::date,
    original_row.payment_method, original_row.financial_account_id,
    transaction_row.occurred_at, transaction_row.id,
    'reversal:' || trim(p_idempotency_key), original_row.marketing_campaign,
    original_row.marketing_channel, original_row.marketing_leads,
    original_row.marketing_new_clients, original_row.marketing_revenue,
    original_row.id, trim(p_reason), p_user_id, p_user_id, p_user_id
  ) returning * into reversal_row;

  update public.finance_transactions
  set expense_document_id = reversal_row.id
  where id = transaction_row.id
  returning * into transaction_row;

  update public.expense_documents
  set status = 'reversed', reversed_at = transaction_row.occurred_at,
      reversed_by = p_user_id, reversed_by_document_id = reversal_row.id,
      reversal_reason = trim(p_reason), updated_by = p_user_id,
      version = version + 1
  where id = original_row.id
  returning * into original_row;

  perform public.write_finance_audit(
    p_org_id, 'expense_document', original_row.id, 'reversed', p_user_id,
    original_before, to_jsonb(original_row),
    jsonb_build_object('reversal_document_id', reversal_row.id,
      'transaction_id', transaction_row.id, 'reason', trim(p_reason))
  );
  perform public.write_finance_audit(
    p_org_id, 'expense_document', reversal_row.id, 'reversal_created', p_user_id,
    null, to_jsonb(reversal_row), jsonb_build_object('original_document_id', original_row.id)
  );
  return jsonb_build_object('document', to_jsonb(original_row),
    'reversal_document', to_jsonb(reversal_row),
    'transaction', to_jsonb(transaction_row), 'idempotent_replay', false);
exception when unique_violation then
  select * into transaction_row
  from public.finance_transactions
  where org_id = p_org_id and external_provider = 'pugcrm-expense-reversal'
    and external_reference = trim(p_idempotency_key);
  if found then
    select * into reversal_row from public.expense_documents
    where org_id = p_org_id and id = transaction_row.expense_document_id;
    if reversal_row.reverses_document_id = p_document_id then
      select * into original_row from public.expense_documents
      where org_id = p_org_id and id = p_document_id;
      return jsonb_build_object('document', to_jsonb(original_row),
        'reversal_document', to_jsonb(reversal_row),
        'transaction', to_jsonb(transaction_row), 'idempotent_replay', true);
    end if;
  end if;
  raise;
end
$function$;

create or replace function public.resolve_financial_account(
  p_org_id uuid,
  p_payment_method text,
  p_financial_account_id uuid default null
)
returns uuid
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
declare
  resolved_id uuid;
  required_system_key text;
  required_account_type text;
begin
  if p_payment_method not in ('cash', 'card', 'transfer', 'terminal', 'other') then
    raise exception using errcode = '22023', message = 'invalid payment method';
  end if;

  required_system_key := case
    when p_payment_method = 'cash' then 'cash'
    when p_payment_method = 'transfer' then 'bank'
    when p_payment_method in ('card', 'terminal') then 'terminal'
    else 'other'
  end;
  required_account_type := required_system_key;

  if p_financial_account_id is not null then
    select account.id into resolved_id
    from public.financial_accounts as account
    where account.org_id = p_org_id
      and account.id = p_financial_account_id
      and account.is_active
      and account.currency = 'UAH'
      and account.account_type = required_account_type;
  else
    select account.id into resolved_id
    from public.financial_accounts as account
    where account.org_id = p_org_id
      and account.system_key = required_system_key
      and account.is_default
      and account.is_active
      and account.currency = 'UAH'
      and account.account_type = required_account_type
    order by account.id
    limit 1;
  end if;

  if resolved_id is null then
    raise exception using errcode = '23503', message = 'financial account not found or inactive';
  end if;

  return resolved_id;
end
$function$;

create or replace function public.assert_finance_actor(
  p_org_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
begin
  if p_org_id is null or p_user_id is null or not exists (
    select 1
    from public.clinic_users as actor
    where actor.org_id = p_org_id
      and actor.id = p_user_id
      and actor.is_active
      and actor.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'finance actor is outside organization';
  end if;
end
$function$;

-- Preserve compatibility with legacy writers (visit payments, deposits and
-- procurement code) which predate accounting_kind/account columns.
create or replace function public.populate_finance_transaction_dimensions()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  if new.accounting_kind is null then
    new.accounting_kind := case
      when new.transaction_type = 'payment' then 'client_payment'
      when new.transaction_type = 'refund' then 'client_refund'
      when new.transaction_type = 'expense' then 'operating_expense'
      when new.transaction_type = 'deposit' then 'cash_deposit'
      when new.transaction_type = 'withdrawal' then 'cash_withdrawal'
      else 'other'
    end;
  end if;

  if new.financial_account_id is null then
    new.financial_account_id := public.resolve_financial_account(
      new.org_id, coalesce(new.payment_method, 'other'), null
    );
  end if;
  return new;
end
$function$;

drop trigger if exists populate_finance_transaction_dimensions
  on public.finance_transactions;
create trigger populate_finance_transaction_dimensions
before insert on public.finance_transactions
for each row execute function public.populate_finance_transaction_dimensions();

-- Guard document lifecycle even if trusted backend code accidentally performs
-- a direct table update instead of using the RPCs.
create or replace function public.guard_expense_document_update()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  if old.status in ('cancelled', 'reversed') then
    raise exception using errcode = '55000', message = 'immutable expense document';
  end if;

  if old.status = 'paid' then
    if new.status not in ('paid', 'reversed') then
      raise exception using errcode = '55000', message = 'invalid paid expense transition';
    end if;

    if row(
      new.org_id, new.document_kind, new.amount, new.currency, new.category,
      new.subcategory, new.expense_date, new.due_date, new.payment_method,
      new.financial_account_id, new.paid_at, new.transaction_id,
      new.idempotency_key, new.recurring_template_id,
      new.reverses_document_id, new.created_by,
      new.is_legacy, new.created_at
    ) is distinct from row(
      old.org_id, old.document_kind, old.amount, old.currency, old.category,
      old.subcategory, old.expense_date, old.due_date, old.payment_method,
      old.financial_account_id, old.paid_at, old.transaction_id,
      old.idempotency_key, old.recurring_template_id,
      old.reverses_document_id, old.created_by,
      old.is_legacy, old.created_at
    ) then
      raise exception using errcode = '55000', message = 'paid financial fields are immutable';
    end if;
  elsif old.status = 'planned' and new.status not in ('planned', 'paid', 'cancelled') then
    raise exception using errcode = '55000', message = 'invalid planned expense transition';
  end if;

  if new.version <= old.version then
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  return new;
end
$function$;

drop trigger if exists guard_expense_document_update on public.expense_documents;
create trigger guard_expense_document_update
before update on public.expense_documents
for each row execute function public.guard_expense_document_update();

create or replace function public.guard_linked_expense_transaction()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' and old.expense_document_id is not null then
    raise exception using errcode = '55000', message = 'linked expense transaction is immutable';
  end if;

  if tg_op = 'UPDATE' and old.expense_document_id is not null and row(
    new.org_id, new.transaction_type, new.accounting_kind, new.amount,
    new.currency, new.payment_method, new.status, new.source,
    new.financial_account_id, new.expense_document_id,
    new.reverses_transaction_id, new.occurred_at
  ) is distinct from row(
    old.org_id, old.transaction_type, old.accounting_kind, old.amount,
    old.currency, old.payment_method, old.status, old.source,
    old.financial_account_id, old.expense_document_id,
    old.reverses_transaction_id, old.occurred_at
  ) then
    raise exception using errcode = '55000', message = 'linked expense transaction is immutable';
  end if;

  if tg_op = 'UPDATE' then
    return new;
  end if;
  return old;
end
$function$;

drop trigger if exists guard_linked_expense_transaction on public.finance_transactions;
create trigger guard_linked_expense_transaction
before update or delete on public.finance_transactions
for each row execute function public.guard_linked_expense_transaction();

create or replace function public.guard_finance_audit_log()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  raise exception using errcode = '55000', message = 'finance audit log is append-only';
end
$function$;

drop trigger if exists guard_finance_audit_log on public.finance_audit_log;
create trigger guard_finance_audit_log
before update or delete on public.finance_audit_log
for each row execute function public.guard_finance_audit_log();

create or replace function public.write_finance_audit(
  p_org_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_actor_id uuid,
  p_before_data jsonb,
  p_after_data jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
volatile
security invoker
set search_path = public, pg_temp
as $function$
  insert into public.finance_audit_log (
    org_id, entity_type, entity_id, action, actor_id,
    before_data, after_data, metadata
  ) values (
    p_org_id, p_entity_type, p_entity_id, p_action, p_actor_id,
    p_before_data, p_after_data, coalesce(p_metadata, '{}'::jsonb)
  )
$function$;

create or replace function public.create_expense_document(
  p_org_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_status text,
  p_amount numeric,
  p_category text,
  p_subcategory text,
  p_description text,
  p_counterparty text,
  p_document_number text,
  p_document_url text,
  p_expense_date date,
  p_due_date date,
  p_payment_method text,
  p_financial_account_id uuid,
  p_marketing jsonb,
  p_attachment_ids uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  document_row public.expense_documents%rowtype;
  transaction_row public.finance_transactions%rowtype;
  document_id uuid := gen_random_uuid();
  account_id uuid;
  normalized_status text := lower(trim(coalesce(p_status, '')));
  normalized_method text := nullif(lower(trim(coalesce(p_payment_method, ''))), '');
  marketing jsonb := coalesce(p_marketing, '{}'::jsonb);
  attachment_count integer := coalesce(cardinality(p_attachment_ids), 0);
begin
  perform public.assert_finance_actor(p_org_id, p_user_id);
  if not exists (select 1 from public.orgs where id = p_org_id) then
    raise exception using errcode = '23503', message = 'organization not found';
  end if;
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null
     or char_length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;

  select * into document_row
  from public.expense_documents
  where org_id = p_org_id and idempotency_key = trim(p_idempotency_key);
  if found then
    select * into transaction_row from public.finance_transactions
    where id = document_row.transaction_id and org_id = p_org_id;
    return jsonb_build_object(
      'document', to_jsonb(document_row),
      'transaction', case when transaction_row.id is null then null else to_jsonb(transaction_row) end,
      'idempotent_replay', true
    );
  end if;

  if normalized_status not in ('planned', 'paid') then
    raise exception using errcode = '22023', message = 'expense status must be planned or paid';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2)
     or p_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception using errcode = '22023', message = 'amount must be a positive two-decimal value';
  end if;
  perform public.assert_operating_expense_category(p_category);
  if p_expense_date is null or (p_due_date is not null and p_due_date < p_expense_date) then
    raise exception using errcode = '22023', message = 'invalid expense dates';
  end if;
  if jsonb_typeof(marketing) <> 'object' then
    raise exception using errcode = '22023', message = 'marketing must be an object';
  end if;

  if normalized_status = 'paid' then
    account_id := public.resolve_financial_account(
      p_org_id, normalized_method, p_financial_account_id
    );
  elsif normalized_method is not null then
    account_id := public.resolve_financial_account(
      p_org_id, normalized_method, p_financial_account_id
    );
  elsif p_financial_account_id is not null then
    raise exception using errcode = '22023', message = 'payment method is required for account';
  end if;

  if attachment_count <> (
    select count(distinct attachment_id)
    from unnest(coalesce(p_attachment_ids, '{}'::uuid[])) as attachment(attachment_id)
  ) or attachment_count <> (
    select count(*)
    from public.finance_documents
    where org_id = p_org_id
      and id = any(coalesce(p_attachment_ids, '{}'::uuid[]))
      and expense_document_id is null
      and deleted_at is null
  ) then
    raise exception using errcode = '23503', message = 'invalid or already linked attachment';
  end if;

  insert into public.expense_documents (
    id, org_id, document_number, document_kind, status, amount, currency,
    category, subcategory, description, counterparty, document_url,
    expense_date, due_date, payment_method, financial_account_id,
    idempotency_key, marketing_campaign, marketing_channel, marketing_leads,
    marketing_new_clients, marketing_revenue, created_by, updated_by
  ) values (
    document_id, p_org_id,
    coalesce(nullif(trim(p_document_number), ''),
      'EXP-' || to_char(p_expense_date, 'YYYYMMDD') || '-' || upper(substr(replace(document_id::text, '-', ''), 1, 8))),
    'expense', 'planned', p_amount, 'UAH', trim(p_category),
    nullif(trim(p_subcategory), ''), nullif(trim(p_description), ''),
    nullif(trim(p_counterparty), ''), nullif(trim(p_document_url), ''),
    p_expense_date, p_due_date, normalized_method, account_id,
    trim(p_idempotency_key), nullif(trim(marketing->>'campaign'), ''),
    nullif(trim(marketing->>'channel'), ''),
    nullif(marketing->>'leads', '')::integer,
    nullif(marketing->>'new_clients', '')::integer,
    round(nullif(marketing->>'revenue', '')::numeric, 2),
    p_user_id, p_user_id
  ) returning * into document_row;

  if coalesce(document_row.marketing_leads, 0) < 0
     or coalesce(document_row.marketing_new_clients, 0) < 0
     or coalesce(document_row.marketing_revenue, 0) < 0 then
    raise exception using errcode = '22023', message = 'marketing metrics cannot be negative';
  end if;

  if attachment_count > 0 then
    update public.finance_documents
    set expense_document_id = document_id
    where org_id = p_org_id and id = any(p_attachment_ids);
  end if;

  if normalized_status = 'paid' then
    insert into public.finance_transactions (
      org_id, created_by, transaction_type, accounting_kind, amount, currency,
      payment_method, financial_account_id, category, description,
      counterparty, document_url, source, status, cash_shift_id, visit_id,
      expense_document_id, external_provider, external_reference,
      occurred_at, metadata
    ) values (
      p_org_id, p_user_id, 'expense', 'operating_expense', p_amount, 'UAH',
      normalized_method, account_id, trim(p_category),
      coalesce(nullif(trim(p_description), ''), 'Операційна витрата'),
      nullif(trim(p_counterparty), ''), nullif(trim(p_document_url), ''),
      'manual', 'completed', null, null, document_id,
      'pugcrm-expense', trim(p_idempotency_key),
      (p_expense_date::timestamp + time '12:00') at time zone 'Europe/Kyiv',
      jsonb_build_object('created_via', 'expense_document_rpc')
    ) returning * into transaction_row;

    update public.expense_documents
    set status = 'paid', paid_at = transaction_row.occurred_at,
        paid_by = p_user_id, transaction_id = transaction_row.id,
        updated_by = p_user_id
    where id = document_id
    returning * into document_row;
  end if;

  perform public.write_finance_audit(
    p_org_id, 'expense_document', document_id, 'created', p_user_id,
    null, to_jsonb(document_row), jsonb_build_object('status', normalized_status)
  );

  return jsonb_build_object(
    'document', to_jsonb(document_row),
    'transaction', case when transaction_row.id is null then null else to_jsonb(transaction_row) end,
    'idempotent_replay', false
  );
exception when unique_violation then
  select * into document_row
  from public.expense_documents
  where org_id = p_org_id and idempotency_key = trim(p_idempotency_key);
  if found then
    select * into transaction_row from public.finance_transactions
    where id = document_row.transaction_id and org_id = p_org_id;
    return jsonb_build_object(
      'document', to_jsonb(document_row),
      'transaction', case when transaction_row.id is null then null else to_jsonb(transaction_row) end,
      'idempotent_replay', true
    );
  end if;
  raise;
end
$function$;

create or replace function public.pay_expense_document(
  p_org_id uuid,
  p_user_id uuid,
  p_document_id uuid,
  p_idempotency_key text,
  p_paid_at timestamptz,
  p_payment_method text,
  p_financial_account_id uuid,
  p_version integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  document_row public.expense_documents%rowtype;
  transaction_row public.finance_transactions%rowtype;
  before_row jsonb;
  account_id uuid;
  normalized_method text := lower(trim(coalesce(p_payment_method, '')));
begin
  perform public.assert_finance_actor(p_org_id, p_user_id);
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null
     or char_length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;

  select * into transaction_row
  from public.finance_transactions
  where org_id = p_org_id
    and external_provider = 'pugcrm-expense-payment'
    and external_reference = trim(p_idempotency_key);
  if found then
    if transaction_row.expense_document_id is distinct from p_document_id then
      raise exception using errcode = '23505', message = 'idempotency key belongs to another document';
    end if;
    select * into document_row from public.expense_documents
    where org_id = p_org_id and id = p_document_id;
    return jsonb_build_object('document', to_jsonb(document_row),
      'transaction', to_jsonb(transaction_row), 'idempotent_replay', true);
  end if;

  select * into document_row
  from public.expense_documents
  where org_id = p_org_id and id = p_document_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'expense document not found';
  end if;
  select * into transaction_row
  from public.finance_transactions
  where org_id = p_org_id
    and external_provider = 'pugcrm-expense-payment'
    and external_reference = trim(p_idempotency_key);
  if found then
    if transaction_row.expense_document_id is distinct from p_document_id then
      raise exception using errcode = '23505', message = 'idempotency key belongs to another document';
    end if;
    return jsonb_build_object('document', to_jsonb(document_row),
      'transaction', to_jsonb(transaction_row), 'idempotent_replay', true);
  end if;
  if document_row.status <> 'planned' then
    raise exception using errcode = '55000', message = 'only planned expense can be paid';
  end if;
  if document_row.version <> p_version then
    raise exception using errcode = '40001', message = 'expense document version conflict';
  end if;
  if p_paid_at is null then
    raise exception using errcode = '22023', message = 'paid_at is required';
  end if;

  account_id := public.resolve_financial_account(
    p_org_id, normalized_method, p_financial_account_id
  );
  before_row := to_jsonb(document_row);

  insert into public.finance_transactions (
    org_id, created_by, transaction_type, accounting_kind, amount, currency,
    payment_method, financial_account_id, category, description,
    counterparty, document_url, source, status, cash_shift_id, visit_id,
    expense_document_id, external_provider, external_reference,
    occurred_at, metadata
  ) values (
    p_org_id, p_user_id, 'expense', 'operating_expense', document_row.amount, 'UAH',
    normalized_method, account_id, document_row.category,
    coalesce(document_row.description, 'Операційна витрата'),
    document_row.counterparty, document_row.document_url,
    'manual', 'completed', null, null, document_row.id,
    'pugcrm-expense-payment', trim(p_idempotency_key), p_paid_at,
    jsonb_build_object('created_via', 'pay_expense_document')
  ) returning * into transaction_row;

  update public.expense_documents
  set status = 'paid', payment_method = normalized_method,
      financial_account_id = account_id, paid_at = p_paid_at,
      paid_by = p_user_id, transaction_id = transaction_row.id,
      updated_by = p_user_id, version = version + 1
  where id = document_row.id
  returning * into document_row;

  perform public.write_finance_audit(
    p_org_id, 'expense_document', document_row.id, 'paid', p_user_id,
    before_row, to_jsonb(document_row),
    jsonb_build_object('transaction_id', transaction_row.id)
  );
  return jsonb_build_object('document', to_jsonb(document_row),
    'transaction', to_jsonb(transaction_row), 'idempotent_replay', false);
exception when unique_violation then
  select * into transaction_row
  from public.finance_transactions
  where org_id = p_org_id
    and external_provider = 'pugcrm-expense-payment'
    and external_reference = trim(p_idempotency_key);
  if found and transaction_row.expense_document_id = p_document_id then
    select * into document_row from public.expense_documents
    where org_id = p_org_id and id = p_document_id;
    return jsonb_build_object('document', to_jsonb(document_row),
      'transaction', to_jsonb(transaction_row), 'idempotent_replay', true);
  end if;
  raise;
end
$function$;

create or replace function public.get_expense_documents_overview(
  p_org_id uuid,
  p_date_from date,
  p_date_to date,
  p_status text default null,
  p_category text default null,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
declare
  result jsonb;
  period_days integer;
  previous_from date;
  previous_to date;
begin
  if p_org_id is null or p_date_from is null or p_date_to is null
     or p_date_from > p_date_to or p_date_to - p_date_from > 366 then
    raise exception using errcode = '22023', message = 'invalid expense overview period';
  end if;
  if p_status is not null and p_status not in ('planned', 'paid', 'cancelled', 'reversed') then
    raise exception using errcode = '22023', message = 'invalid expense status filter';
  end if;

  period_days := (p_date_to - p_date_from) + 1;
  previous_to := p_date_from - 1;
  previous_from := previous_to - (period_days - 1);

  with filtered_documents as (
    select document.*
    from public.expense_documents as document
    where document.org_id = p_org_id
      and document.expense_date between p_date_from and p_date_to
      and (p_status is null or document.status = p_status)
      and (p_category is null or document.category = p_category)
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or document.document_number ilike '%' || trim(p_search) || '%'
        or document.category ilike '%' || trim(p_search) || '%'
        or coalesce(document.subcategory, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.description, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.counterparty, '') ilike '%' || trim(p_search) || '%'
      )
  ),
  current_ledger as (
    select transaction.amount,
      case when transaction.accounting_kind = 'operating_expense_reversal'
        then -transaction.amount else transaction.amount end as signed_amount,
      transaction.accounting_kind, transaction.expense_document_id,
      transaction.occurred_at, document.document_kind,
      document.category, document.marketing_campaign, document.marketing_channel,
      document.marketing_leads, document.marketing_new_clients,
      document.marketing_revenue
    from public.finance_transactions as transaction
    left join public.expense_documents as document
      on document.org_id = transaction.org_id
     and document.id = transaction.expense_document_id
    where transaction.org_id = p_org_id
      and transaction.status = 'completed'
      and transaction.accounting_kind in ('operating_expense', 'operating_expense_reversal')
      and (transaction.occurred_at at time zone 'Europe/Kyiv')::date
        between p_date_from and p_date_to
      and (p_category is null or document.category = p_category)
      and (p_status is null or document.status = p_status)
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or coalesce(document.document_number, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.category, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.subcategory, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.description, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.counterparty, '') ilike '%' || trim(p_search) || '%'
      )
  ),
  previous_ledger as (
    select case when transaction.accounting_kind = 'operating_expense_reversal'
      then -transaction.amount else transaction.amount end as signed_amount,
      transaction.accounting_kind
    from public.finance_transactions as transaction
    left join public.expense_documents as document
      on document.org_id = transaction.org_id
     and document.id = transaction.expense_document_id
    where transaction.org_id = p_org_id
      and transaction.status = 'completed'
      and transaction.accounting_kind in ('operating_expense', 'operating_expense_reversal')
      and (transaction.occurred_at at time zone 'Europe/Kyiv')::date
        between previous_from and previous_to
      and (p_category is null or document.category = p_category)
      and (p_status is null or document.status = p_status)
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or coalesce(document.document_number, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.category, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.subcategory, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.description, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.counterparty, '') ilike '%' || trim(p_search) || '%'
      )
  ),
  previous_documents as (
    select count(*) as document_count
    from public.expense_documents as document
    where document.org_id = p_org_id
      and document.expense_date between previous_from and previous_to
      and (p_status is null or document.status = p_status)
      and (p_category is null or document.category = p_category)
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or document.document_number ilike '%' || trim(p_search) || '%'
        or document.category ilike '%' || trim(p_search) || '%'
        or coalesce(document.subcategory, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.description, '') ilike '%' || trim(p_search) || '%'
        or coalesce(document.counterparty, '') ilike '%' || trim(p_search) || '%'
      )
  ),
  current_totals as (
    select
      coalesce(sum(amount) filter (where accounting_kind = 'operating_expense'), 0) as paid,
      coalesce(sum(amount) filter (where accounting_kind = 'operating_expense_reversal'), 0) as reversed,
      coalesce(sum(signed_amount), 0) as net_paid,
      count(*) as ledger_count,
      coalesce(sum(signed_amount) filter (
        where document_kind in ('expense', 'reversal') and (
          lower(trim(coalesce(category, ''))) in ('маркетинг', 'marketing')
            or marketing_campaign is not null or marketing_channel is not null
            or coalesce(marketing_leads, 0) > 0
            or coalesce(marketing_new_clients, 0) > 0
            or coalesce(marketing_revenue, 0) > 0)
      ), 0) as marketing_spend,
      coalesce(sum(case when accounting_kind = 'operating_expense_reversal'
        then -coalesce(marketing_leads, 0) else coalesce(marketing_leads, 0) end)
        filter (where document_kind in ('expense', 'reversal')), 0) as leads,
      coalesce(sum(case when accounting_kind = 'operating_expense_reversal'
        then -coalesce(marketing_new_clients, 0) else coalesce(marketing_new_clients, 0) end)
        filter (where document_kind in ('expense', 'reversal')), 0) as new_clients,
      coalesce(sum(case when accounting_kind = 'operating_expense_reversal'
        then -coalesce(marketing_revenue, 0) else coalesce(marketing_revenue, 0) end)
        filter (where document_kind in ('expense', 'reversal')), 0) as attributed_revenue
    from current_ledger
  ),
  document_totals as (
    select
      coalesce(sum(amount) filter (where status = 'planned' and document_kind = 'expense'), 0) as planned,
      coalesce(sum(amount) filter (where status = 'cancelled' and document_kind = 'expense'), 0) as cancelled,
      count(*) as document_count
    from filtered_documents
  ),
  previous_totals as (
    select coalesce(sum(signed_amount), 0) as net_paid,
      coalesce(sum(signed_amount) filter (where accounting_kind = 'operating_expense'), 0) as paid,
      count(*) as ledger_count
    from previous_ledger
  )
  select jsonb_build_object(
    'period', jsonb_build_object('date_from', p_date_from, 'date_to', p_date_to),
    'summary', jsonb_build_object(
      'planned', to_char(round(document_totals.planned, 2), 'FM999999999999990.00'),
      'planned_amount', to_char(round(document_totals.planned, 2), 'FM999999999999990.00'),
      'paid', to_char(round(current_totals.paid, 2), 'FM999999999999990.00'),
      'paid_amount', to_char(round(current_totals.paid, 2), 'FM999999999999990.00'),
      'reversed', to_char(round(current_totals.reversed, 2), 'FM999999999999990.00'),
      'reversed_amount', to_char(round(current_totals.reversed, 2), 'FM999999999999990.00'),
      'cancelled', to_char(round(document_totals.cancelled, 2), 'FM999999999999990.00'),
      'cancelled_amount', to_char(round(document_totals.cancelled, 2), 'FM999999999999990.00'),
      'net_paid', to_char(round(current_totals.net_paid, 2), 'FM999999999999990.00'),
      'net_paid_amount', to_char(round(current_totals.net_paid, 2), 'FM999999999999990.00'),
      'count', document_totals.document_count,
      'documents_count', document_totals.document_count,
      'ledger_count', current_totals.ledger_count
    ),
    'previous_period', jsonb_build_object(
      'date_from', previous_from, 'date_to', previous_to,
      'paid', to_char(round(previous_totals.paid, 2), 'FM999999999999990.00'),
      'paid_amount', to_char(round(previous_totals.paid, 2), 'FM999999999999990.00'),
      'net_paid', to_char(round(previous_totals.net_paid, 2), 'FM999999999999990.00'),
      'net_paid_amount', to_char(round(previous_totals.net_paid, 2), 'FM999999999999990.00'),
      'count', previous_documents.document_count,
      'documents_count', previous_documents.document_count,
      'ledger_count', previous_totals.ledger_count
    ),
    'marketing', jsonb_build_object(
      'spend', to_char(round(current_totals.marketing_spend, 2), 'FM999999999999990.00'),
      'leads', current_totals.leads,
      'new_clients', current_totals.new_clients,
      'revenue', to_char(round(current_totals.attributed_revenue, 2), 'FM999999999999990.00'),
      'cpl', case when current_totals.leads > 0 then
        to_char(round(current_totals.marketing_spend / current_totals.leads, 2), 'FM999999999999990.00') end,
      'cac', case when current_totals.new_clients > 0 then
        to_char(round(current_totals.marketing_spend / current_totals.new_clients, 2), 'FM999999999999990.00') end,
      'roas', case when current_totals.marketing_spend > 0 then
        to_char(round(current_totals.attributed_revenue / current_totals.marketing_spend, 4), 'FM999999999999990.0000') end
    )
  ) into result
  from current_totals cross join document_totals
    cross join previous_totals cross join previous_documents;

  return result;
end
$function$;

create or replace function public.get_finance_expenses_overview(
  p_org_id uuid,
  p_date_from date,
  p_date_to date
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
  with ledger as (
    select transaction.id, transaction.amount,
      case when transaction.accounting_kind = 'operating_expense_reversal'
        then -transaction.amount else transaction.amount end as signed_amount,
      coalesce(nullif(trim(transaction.category), ''), 'Без категорії') as category,
      nullif(trim(transaction.counterparty), '') as counterparty,
      transaction.document_url, transaction.occurred_at
    from public.finance_transactions as transaction
    where transaction.org_id = p_org_id and transaction.status = 'completed'
      and transaction.accounting_kind in ('operating_expense', 'operating_expense_reversal')
      and (transaction.occurred_at at time zone 'Europe/Kyiv')::date
        between p_date_from and p_date_to
  ),
  categories as (
    select category, sum(signed_amount) as amount, count(*) as operations_count,
      avg(abs(signed_amount)) as average_amount from ledger group by category
  ),
  daily as (
    select (occurred_at at time zone 'Europe/Kyiv')::date as day,
      sum(signed_amount) as amount, count(*) as operations_count
    from ledger group by 1
  ),
  counterparties as (
    select counterparty, sum(signed_amount) as amount, count(*) as operations_count,
      max(occurred_at) as last_operation_at
    from ledger where counterparty is not null group by counterparty
  ),
  totals as (
    select coalesce(sum(signed_amount), 0) as total,
      count(*) as operations_count,
      coalesce(avg(abs(signed_amount)), 0) as average_expense,
      count(distinct counterparty) filter (where counterparty is not null) as counterparties_count,
      count(*) filter (where document_url is not null and trim(document_url) <> '') as documents_count
    from ledger
  )
  select jsonb_build_object(
    'period', jsonb_build_object('date_from', p_date_from, 'date_to', p_date_to,
      'days_count', greatest((p_date_to - p_date_from) + 1, 1)),
    'summary', jsonb_build_object(
      'total_expenses', round(totals.total, 2),
      'transactions_count', totals.operations_count,
      'average_expense', round(totals.average_expense, 2),
      'average_daily', round(totals.total / greatest((p_date_to - p_date_from) + 1, 1), 2),
      'purchases_total', 0, 'salary_total', 0,
      'fixed_expenses_total', coalesce((select round(sum(amount), 2) from categories
        where category in ('Оренда', 'Комунальні послуги')), 0),
      'counterparties_count', totals.counterparties_count,
      'documents_count', totals.documents_count,
      'top_category', (select category from categories order by amount desc limit 1),
      'top_category_amount', coalesce((select round(amount, 2) from categories order by amount desc limit 1), 0)
    ),
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
      'category', category, 'amount', round(amount, 2),
      'operations_count', operations_count, 'average_amount', round(average_amount, 2),
      'share_percent', case when totals.total <> 0 then round(amount / totals.total * 100, 2) else 0 end
    ) order by amount desc) from categories), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'date', calendar.day, 'amount', round(coalesce(daily.amount, 0), 2),
      'operations_count', coalesce(daily.operations_count, 0)
    ) order by calendar.day)
      from generate_series(p_date_from, p_date_to, interval '1 day') as calendar(day)
      left join daily on daily.day = calendar.day::date), '[]'::jsonb),
    'counterparties', coalesce((select jsonb_agg(jsonb_build_object(
      'counterparty', counterparty, 'amount', round(amount, 2),
      'operations_count', operations_count, 'last_operation_at', last_operation_at
    ) order by amount desc) from (select * from counterparties order by amount desc limit 12) ranked), '[]'::jsonb)
  ) from totals
$function$;

do $migration$
begin
  if to_regprocedure('public.get_finance_overview_stage_0_legacy(uuid,date,date)') is null then
    alter function public.get_finance_overview(uuid, date, date)
      rename to get_finance_overview_stage_0_legacy;
  end if;
end
$migration$;

create or replace function public.get_finance_overview(
  p_org_id uuid,
  p_date_from date,
  p_date_to date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
declare
  result jsonb;
  payments numeric;
  refunds numeric;
  expenses numeric;
  stock_cost numeric;
  contribution numeric;
  daily_rows jsonb;
begin
  result := coalesce(
    public.get_finance_overview_stage_0_legacy(p_org_id, p_date_from, p_date_to),
    '{}'::jsonb
  );
  result := result || jsonb_build_object('summary', coalesce(result->'summary', '{}'::jsonb));

  select
    coalesce(sum(amount) filter (where accounting_kind = 'client_payment'), 0),
    coalesce(sum(amount) filter (where accounting_kind = 'client_refund'), 0),
    coalesce(sum(case
      when accounting_kind = 'operating_expense' then amount
      when accounting_kind = 'operating_expense_reversal' then -amount
      else 0 end), 0)
  into payments, refunds, expenses
  from public.finance_transactions
  where org_id = p_org_id and status = 'completed'
    and (occurred_at at time zone 'Europe/Kyiv')::date between p_date_from and p_date_to;

  stock_cost := coalesce((result->'summary'->>'stock_cost')::numeric, 0);
  contribution := payments - refunds - expenses - stock_cost;
  result := jsonb_set(result, '{summary,expenses}', to_jsonb(round(expenses, 2)), true);
  result := jsonb_set(result, '{summary,estimated_profit}', to_jsonb(round(contribution, 2)), true);
  result := jsonb_set(result, '{summary,cash_contribution_after_stock}', to_jsonb(round(contribution, 2)), true);

  select coalesce(jsonb_agg(jsonb_build_object(
    'date', day, 'payments', round(payments_day, 2),
    'refunds', round(refunds_day, 2), 'expenses', round(expenses_day, 2),
    'net', round(payments_day - refunds_day - expenses_day, 2)
  ) order by day), '[]'::jsonb) into daily_rows
  from (
    select (occurred_at at time zone 'Europe/Kyiv')::date as day,
      coalesce(sum(amount) filter (where accounting_kind = 'client_payment'), 0) as payments_day,
      coalesce(sum(amount) filter (where accounting_kind = 'client_refund'), 0) as refunds_day,
      coalesce(sum(case
        when accounting_kind = 'operating_expense' then amount
        when accounting_kind = 'operating_expense_reversal' then -amount
        else 0 end), 0) as expenses_day
    from public.finance_transactions
    where org_id = p_org_id and status = 'completed'
      and (occurred_at at time zone 'Europe/Kyiv')::date between p_date_from and p_date_to
    group by 1
  ) as grouped;
  result := jsonb_set(result, '{daily}', daily_rows, true);
  return result;
end
$function$;

create or replace function public.audit_finance_document_change()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  action_name text;
  actor_id uuid;
begin
  if tg_op = 'INSERT' then
    action_name := 'uploaded';
    actor_id := new.uploaded_by;
    perform public.assert_finance_actor(new.org_id, actor_id);
    perform public.write_finance_audit(
      new.org_id, 'finance_document', new.id, action_name, actor_id,
      null, to_jsonb(new), '{}'::jsonb
    );
  else
    actor_id := coalesce(new.deleted_by, new.uploaded_by);
    action_name := case
      when old.deleted_at is null and new.deleted_at is not null then 'deleted'
      when old.expense_document_id is distinct from new.expense_document_id then 'linked'
      else 'updated'
    end;
    perform public.write_finance_audit(
      new.org_id, 'finance_document', new.id, action_name, actor_id,
      to_jsonb(old), to_jsonb(new), '{}'::jsonb
    );
  end if;
  return new;
end
$function$;

drop trigger if exists audit_finance_document_change on public.finance_documents;
create trigger audit_finance_document_change
after insert or update on public.finance_documents
for each row execute function public.audit_finance_document_change();

create or replace function public.guard_finance_document_delete()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  raise exception using errcode = '55000', message = 'finance documents use soft delete';
end
$function$;

drop trigger if exists guard_finance_document_delete on public.finance_documents;
create trigger guard_finance_document_delete
before delete on public.finance_documents
for each row execute function public.guard_finance_document_delete();

do $migration$
declare
  actor_fk record;
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.clinic_users'::regclass
      and conname = 'clinic_users_org_id_id_key'
  ) then
    alter table public.clinic_users
      add constraint clinic_users_org_id_id_key unique (org_id, id);
  end if;

  for actor_fk in
    select * from (values
      ('financial_accounts', 'financial_accounts_created_by_fk', 'created_by'),
      ('expense_documents', 'expense_documents_created_by_fk', 'created_by'),
      ('expense_documents', 'expense_documents_updated_by_fk', 'updated_by'),
      ('expense_documents', 'expense_documents_paid_by_fk', 'paid_by'),
      ('expense_documents', 'expense_documents_cancelled_by_fk', 'cancelled_by'),
      ('expense_documents', 'expense_documents_reversed_by_fk', 'reversed_by'),
      ('finance_documents', 'finance_documents_uploaded_by_fk', 'uploaded_by'),
      ('finance_documents', 'finance_documents_deleted_by_fk', 'deleted_by'),
      ('recurring_expense_templates', 'recurring_templates_created_by_fk', 'created_by'),
      ('recurring_expense_templates', 'recurring_templates_updated_by_fk', 'updated_by'),
      ('finance_audit_log', 'finance_audit_log_actor_fk', 'actor_id')
    ) as constraints(table_name, constraint_name, column_name)
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', actor_fk.table_name)::regclass
        and conname = actor_fk.constraint_name
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (org_id, %I) references public.clinic_users(org_id, id) on delete restrict',
        actor_fk.table_name, actor_fk.constraint_name, actor_fk.column_name
      );
    end if;
  end loop;
end
$migration$;

do $migration$
declare
  finance_table text;
begin
  foreach finance_table in array array[
    'financial_accounts', 'expense_documents', 'finance_documents',
    'recurring_expense_templates', 'finance_audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', finance_table);
    execute format(
      'revoke all privileges on table public.%I from public, anon, authenticated',
      finance_table
    );
    execute format('grant all privileges on table public.%I to service_role', finance_table);
  end loop;
end
$migration$;

do $migration$
declare
  finance_sequence text;
begin
  for finance_sequence in
    select format('%I.%I', namespace.nspname, relation.relname)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public' and relation.relkind = 'S'
      and relation.relname like 'finance_audit_log%'
  loop
    execute format(
      'revoke all privileges on sequence %s from public, anon, authenticated',
      finance_sequence
    );
    execute format('grant all privileges on sequence %s to service_role', finance_sequence);
  end loop;
end
$migration$;

do $migration$
declare
  finance_function text;
begin
  foreach finance_function in array array[
    'public.assert_operating_expense_category(text)',
    'public.guard_operating_expense_category()',
    'public.resolve_financial_account(uuid,text,uuid)',
    'public.assert_finance_actor(uuid,uuid)',
    'public.populate_finance_transaction_dimensions()',
    'public.guard_expense_document_update()',
    'public.guard_linked_expense_transaction()',
    'public.guard_finance_audit_log()',
    'public.write_finance_audit(uuid,text,uuid,text,uuid,jsonb,jsonb,jsonb)',
    'public.create_expense_document(uuid,uuid,text,text,numeric,text,text,text,text,text,text,date,date,text,uuid,jsonb,uuid[])',
    'public.pay_expense_document(uuid,uuid,uuid,text,timestamp with time zone,text,uuid,integer)',
    'public.update_expense_document(uuid,uuid,uuid,integer,jsonb)',
    'public.cancel_expense_document(uuid,uuid,uuid,text,integer)',
    'public.reverse_expense_document(uuid,uuid,uuid,text,text,integer)',
    'public.create_recurring_expense_template(uuid,uuid,text,jsonb)',
    'public.update_recurring_expense_template(uuid,uuid,uuid,integer,jsonb)',
    'public.confirm_recurring_expense_template(uuid,uuid,uuid,text,date,date)',
    'public.get_expense_documents_overview(uuid,date,date,text,text,text)',
    'public.get_finance_expenses_overview(uuid,date,date)',
    'public.get_finance_overview_stage_0_legacy(uuid,date,date)',
    'public.get_finance_overview(uuid,date,date)',
    'public.audit_finance_document_change()',
    'public.guard_finance_document_delete()'
  ] loop
    if to_regprocedure(finance_function) is null then
      raise exception using errcode = '55000',
        message = 'Stage 1.1 function missing: ' || finance_function;
    end if;
    execute format(
      'revoke all privileges on function %s from public, anon, authenticated',
      finance_function
    );
    execute format('grant execute on function %s to service_role', finance_function);
  end loop;
end
$migration$;

commit;
