begin;

create table if not exists public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 150),
  account_type text not null check (
    account_type in ('cash', 'bank', 'terminal', 'safe', 'other')
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
    or system_key in ('cash', 'bank', 'terminal', 'safe', 'other')
  )
);

create unique index if not exists financial_accounts_one_default_per_type_idx
  on public.financial_accounts (org_id, account_type)
  where is_default;

create index if not exists financial_accounts_org_active_idx
  on public.financial_accounts (org_id, is_active, account_type);

alter table public.financial_accounts enable row level security;
revoke all on table public.financial_accounts from anon, authenticated;
grant all on table public.financial_accounts to service_role;

insert into public.financial_accounts (
  org_id,
  name,
  account_type,
  system_key,
  currency,
  is_default,
  is_active
)
select
  org.id,
  account.name,
  account.account_type,
  account.system_key,
  'UAH',
  true,
  true
from public.orgs as org
cross join (
  values
    ('Каса', 'cash', 'cash'),
    ('Банк / термінал', 'bank', 'bank'),
    ('Сейф', 'safe', 'safe')
) as account(name, account_type, system_key)
on conflict (org_id, system_key) do update
set
  name = excluded.name,
  account_type = excluded.account_type,
  is_default = true,
  is_active = true,
  updated_at = now(),
  version = public.financial_accounts.version + 1;

alter table public.finance_transactions
  add column if not exists financial_account_id uuid;

create or replace function public.resolve_default_financial_account(
  p_org_id uuid,
  p_payment_method text
)
returns uuid
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
  select account.id
  from public.financial_accounts as account
  where account.org_id = p_org_id
    and account.system_key = case
      when p_payment_method = 'cash' then 'cash'
      else 'bank'
    end
    and account.is_default
    and account.is_active
  order by account.id
  limit 1
$function$;

update public.finance_transactions as transaction
set financial_account_id = public.resolve_default_financial_account(
  transaction.org_id,
  transaction.payment_method
)
where transaction.financial_account_id is null;

create or replace function public.populate_finance_transaction_account()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  if new.financial_account_id is null then
    new.financial_account_id := public.resolve_default_financial_account(
      new.org_id,
      new.payment_method
    );
  end if;

  if new.financial_account_id is null then
    raise exception using
      errcode = '23503',
      message = 'default financial account not found';
  end if;

  return new;
end
$function$;

drop trigger if exists populate_finance_transaction_account_trigger
  on public.finance_transactions;

create trigger populate_finance_transaction_account_trigger
before insert or update of org_id, payment_method, financial_account_id
on public.finance_transactions
for each row
execute function public.populate_finance_transaction_account();

alter table public.finance_transactions
  alter column financial_account_id set not null;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.finance_transactions'::regclass
      and conname = 'finance_transactions_account_fk'
  ) then
    alter table public.finance_transactions
      add constraint finance_transactions_account_fk
      foreign key (org_id, financial_account_id)
      references public.financial_accounts(org_id, id)
      on delete restrict;
  end if;
end
$migration$;

create index if not exists finance_transactions_org_account_occurred_idx
  on public.finance_transactions (org_id, financial_account_id, occurred_at desc)
  where status = 'completed';

create or replace function public.get_financial_account_balances(
  p_org_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
  with account_balances as (
    select
      account.id,
      account.name,
      account.account_type,
      account.system_key,
      account.currency,
      account.is_default,
      account.is_active,
      coalesce(
        sum(
          case
            when transaction.transaction_type in ('payment', 'deposit')
              then transaction.amount
            when transaction.transaction_type in (
              'refund',
              'expense',
              'withdrawal'
            )
              then -transaction.amount
            else 0
          end
        ) filter (where transaction.status = 'completed'),
        0
      ) as balance,
      count(transaction.id) filter (
        where transaction.status = 'completed'
      ) as operations_count,
      max(transaction.occurred_at) filter (
        where transaction.status = 'completed'
      ) as last_activity_at
    from public.financial_accounts as account
    left join public.finance_transactions as transaction
      on transaction.org_id = account.org_id
      and transaction.financial_account_id = account.id
    where account.org_id = p_org_id
      and account.is_active
      and account.system_key in ('cash', 'bank', 'safe')
    group by account.id
  ),
  ordered_accounts as (
    select *
    from account_balances
    order by case system_key
      when 'cash' then 1
      when 'bank' then 2
      when 'safe' then 3
      else 4
    end
  )
  select jsonb_build_object(
    'currency',
    'UAH',
    'total_balance',
    round(coalesce(sum(balance), 0), 2),
    'accounts',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'name', name,
          'account_type', account_type,
          'system_key', system_key,
          'currency', currency,
          'balance', round(balance, 2),
          'operations_count', operations_count,
          'last_activity_at', last_activity_at
        )
      ),
      '[]'::jsonb
    )
  )
  from ordered_accounts
$function$;

revoke all on function public.resolve_default_financial_account(uuid, text)
  from public, anon, authenticated;
revoke all on function public.get_financial_account_balances(uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_default_financial_account(uuid, text)
  to service_role;
grant execute on function public.get_financial_account_balances(uuid)
  to service_role;

commit;
