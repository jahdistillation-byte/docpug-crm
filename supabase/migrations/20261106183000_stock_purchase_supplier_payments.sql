-- Registers actual supplier payments, not bank transfers.
-- No historical balances/payments are rewritten. Apply only after schema review.
begin;

do $preflight$
declare missing text;
begin
  select string_agg(required.t || '.' || required.c, ', ') into missing
  from (values
    ('stock_purchases','id'), ('stock_purchases','org_id'),
    ('stock_purchases','supplier_id'), ('stock_purchases','purchase_number'),
    ('stock_purchases','currency'), ('stock_purchases','total_amount'),
    ('stock_purchases','paid_amount'), ('stock_purchases','payment_status'),
    ('stock_purchases','status'), ('stock_purchases','updated_at'),
    ('suppliers','id'), ('suppliers','org_id'), ('suppliers','name'),
    ('financial_accounts','id'), ('financial_accounts','org_id'),
    ('financial_accounts','name'), ('financial_accounts','account_type'),
    ('financial_accounts','currency'), ('financial_accounts','is_active'),
    ('finance_transactions','id'), ('finance_transactions','org_id'),
    ('finance_transactions','created_by'), ('finance_transactions','transaction_type'),
    ('finance_transactions','amount'),
    ('finance_transactions','currency'), ('finance_transactions','payment_method'),
    ('finance_transactions','financial_account_id'), ('finance_transactions','category'),
    ('finance_transactions','description'), ('finance_transactions','counterparty'),
    ('finance_transactions','source'), ('finance_transactions','status'),
    ('finance_transactions','external_provider'),
    ('finance_transactions','external_reference'), ('finance_transactions','occurred_at'),
    ('finance_transactions','metadata')
  ) required(t,c)
  where not exists (select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=required.t and c.column_name=required.c);
  if missing is not null then
    raise exception 'Supplier payment preflight: missing columns: %', missing;
  end if;
  if to_regclass('public.orgs') is null or not exists (
    select 1 from information_schema.columns where table_schema='public'
      and table_name='clinic_users' and column_name='is_active' and udt_name='bool'
  ) then raise exception 'Supplier payments require orgs and active clinic users'; end if;
  if exists (select 1 from information_schema.columns where table_schema='public'
    and ((table_name='stock_purchases' and column_name in ('paid_amount','total_amount'))
      or (table_name='finance_transactions' and column_name='amount')) and udt_name <> 'numeric') then
    raise exception 'Supplier payment money columns must be numeric';
  end if;
end
$preflight$;

-- Compatible with the inspected live baseline. No historical backfill/default.
alter table public.finance_transactions
  add column if not exists accounting_kind text,
  add column if not exists stock_purchase_id uuid;
create unique index if not exists stock_purchases_supplier_payment_org_id_idx
  on public.stock_purchases(org_id,id);
do $constraints$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.finance_transactions'::regclass
    and conname='finance_supplier_payment_purchase_fk') then
    alter table public.finance_transactions add constraint finance_supplier_payment_purchase_fk
      foreign key(org_id,stock_purchase_id) references public.stock_purchases(org_id,id) on delete restrict;
  end if;
end
$constraints$;

-- Separate audit; does not install/replace the Stage 1.1 expense subsystem.
create table if not exists public.stock_supplier_payment_audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete restrict,
  entity_type text not null check(entity_type='financial_account'),
  entity_id uuid not null,
  action text not null check(action='supplier_payment'),
  actor_id uuid not null references public.clinic_users(id) on delete restrict,
  before_data jsonb not null,
  after_data jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key(org_id,entity_id) references public.financial_accounts(org_id,id) on delete restrict
);
alter table public.stock_supplier_payment_audit enable row level security;
revoke all on public.stock_supplier_payment_audit from public,anon,authenticated;
grant select,insert on public.stock_supplier_payment_audit to service_role;

create or replace function public.assert_stock_supplier_payment_actor(p_org_id uuid,p_user_id uuid)
returns void language plpgsql stable security invoker set search_path=public,pg_temp
as $function$
begin
  if p_org_id is null or p_user_id is null or not exists (
    select 1 from public.clinic_users where org_id=p_org_id and id=p_user_id
      and is_active and role in ('owner','admin')
  ) then raise exception using errcode='42501', message='finance actor is outside organization'; end if;
end
$function$;

create or replace function public.write_stock_supplier_payment_audit(
  p_org_id uuid,p_entity_type text,p_entity_id uuid,p_action text,p_actor_id uuid,
  p_before_data jsonb,p_after_data jsonb,p_metadata jsonb
)
returns void language sql security invoker set search_path=public,pg_temp
as $function$
  insert into public.stock_supplier_payment_audit(
    org_id,entity_type,entity_id,action,actor_id,before_data,after_data,metadata
  ) values(p_org_id,p_entity_type,p_entity_id,p_action,p_actor_id,p_before_data,p_after_data,p_metadata)
$function$;

create unique index if not exists finance_supplier_payment_request_once_idx
  on public.finance_transactions(org_id, external_reference)
  where external_provider = 'pugcrm-supplier-payment';

create or replace function public.get_stock_purchase_payment_state(p_org_id uuid, p_user_id uuid, p_purchase_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp
as $function$
declare purchase_row public.stock_purchases%rowtype; account_rows jsonb; payment_rows jsonb;
begin
  perform public.assert_stock_supplier_payment_actor(p_org_id, p_user_id);
  select * into purchase_row from public.stock_purchases where org_id=p_org_id and id=p_purchase_id;
  if not found then raise exception using errcode='P0002', message='purchase not found'; end if;

  select coalesce(jsonb_agg(account_data order by account_data->>'name'), '[]'::jsonb) into account_rows
  from (
    select jsonb_build_object('id', a.id, 'name', a.name, 'account_type', a.account_type,
      'currency', a.currency, 'balance', round(coalesce((select sum(case
        when t.transaction_type in ('payment','deposit') then t.amount
        when t.transaction_type in ('refund','expense','withdrawal') then -t.amount else 0 end)
        from public.finance_transactions t where t.org_id=p_org_id and t.financial_account_id=a.id
        and t.status='completed'),0),2)::text) account_data
    from public.financial_accounts a where a.org_id=p_org_id and a.is_active
      and a.currency::text=purchase_row.currency::text and a.account_type::text in ('cash','bank','safe')
  ) accounts;

  select coalesce(jsonb_agg(row_data order by occurred_at desc, id desc), '[]'::jsonb) into payment_rows
  from (
    select t.id, t.occurred_at, jsonb_build_object('id',t.id,'amount',round(t.amount,2)::text,
      'currency',t.currency,'financial_account_id',t.financial_account_id,'account_name',a.name,
      'occurred_at',t.occurred_at,'note',coalesce(t.metadata->>'note','')) row_data
    from public.finance_transactions t left join public.financial_accounts a
      on a.org_id=t.org_id and a.id=t.financial_account_id
    where t.org_id=p_org_id and t.stock_purchase_id=p_purchase_id
      and t.external_provider='pugcrm-supplier-payment' and t.status='completed'
    order by t.occurred_at desc, t.id desc limit 50
  ) payments;
  return jsonb_build_object('purchase',jsonb_build_object('id',purchase_row.id,
    'purchase_number',purchase_row.purchase_number,'currency',purchase_row.currency,
    'status',purchase_row.status,'payment_status',purchase_row.payment_status,
    'total_amount',round(purchase_row.total_amount,2)::text,
    'paid_amount',round(coalesce(purchase_row.paid_amount,0),2)::text,
    'remaining_amount',round(greatest(0,purchase_row.total_amount-coalesce(purchase_row.paid_amount,0)),2)::text),
    'accounts',account_rows,'payments',payment_rows);
end
$function$;

create or replace function public.pay_stock_purchase(
  p_org_id uuid, p_user_id uuid, p_purchase_id uuid, p_financial_account_id uuid,
  p_amount numeric, p_expected_paid_amount numeric, p_expected_total_amount numeric,
  p_currency text, p_idempotency_key uuid, p_note text
)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp
as $function$
declare
  purchase_row public.stock_purchases%rowtype;
  account_row public.financial_accounts%rowtype;
  transaction_row public.finance_transactions%rowtype;
  request_payload jsonb;
  before_purchase jsonb;
  paid numeric;
  supplier_name text;
  normalized_note text := trim(coalesce(p_note,''));
  normalized_currency text := upper(trim(coalesce(p_currency,'')));
begin
  perform public.assert_stock_supplier_payment_actor(p_org_id,p_user_id);
  if p_idempotency_key is null or p_financial_account_id is null or p_purchase_id is null
     or p_amount is null or p_amount <= 0 or p_amount > 1000000000 or p_amount <> round(p_amount,2)
     or p_expected_paid_amount is null or p_expected_paid_amount < 0 or p_expected_paid_amount > 1000000000
     or p_expected_total_amount is null or p_expected_total_amount <= 0 or p_expected_total_amount > 1000000000
     or p_expected_paid_amount <> round(p_expected_paid_amount,2)
     or p_expected_total_amount <> round(p_expected_total_amount,2)
     or normalized_currency not in ('UAH','EUR','USD','GBP','PLN','CHF')
     or length(normalized_note)>500 then
    raise exception using errcode='22023', message='invalid supplier payment';
  end if;
  request_payload := jsonb_build_object('purchase_id',p_purchase_id,'account_id',p_financial_account_id,
    'amount',p_amount,'expected_paid',p_expected_paid_amount,'expected_total',p_expected_total_amount,
    'currency',normalized_currency,'note',normalized_note);
  -- Serialize the same request key even if a second caller targets another purchase.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':supplier-payment:' || p_idempotency_key::text,0));
  select * into transaction_row from public.finance_transactions
    where org_id=p_org_id and external_provider='pugcrm-supplier-payment'
      and external_reference=p_idempotency_key::text;
  if found then
    if transaction_row.stock_purchase_id is distinct from p_purchase_id
       or transaction_row.metadata->'request' is distinct from request_payload then
      raise exception using errcode='23505', message='supplier payment key payload conflict';
    end if;
    select * into purchase_row from public.stock_purchases where org_id=p_org_id and id=p_purchase_id;
    return jsonb_build_object('purchase_id',purchase_row.id,'transaction_id',transaction_row.id,
      'amount',round(transaction_row.amount,2)::text,'paid_amount',round(purchase_row.paid_amount,2)::text,
      'remaining_amount',round(greatest(0,purchase_row.total_amount-purchase_row.paid_amount),2)::text,
      'payment_status',purchase_row.payment_status,'idempotent_replay',true);
  end if;

  select * into purchase_row from public.stock_purchases where org_id=p_org_id and id=p_purchase_id for update;
  if not found then raise exception using errcode='P0002', message='purchase not found'; end if;
  if purchase_row.status::text not in ('draft','ordered','partially_received','received') then
    raise exception using errcode='55000', message='purchase cannot be paid';
  end if;
  if normalized_currency <> purchase_row.currency::text then
    raise exception using errcode='22023', message='supplier payment currency mismatch';
  end if;
  if coalesce(purchase_row.paid_amount,0) <> p_expected_paid_amount
     or purchase_row.total_amount <> p_expected_total_amount then
    raise exception using errcode='40001', message='purchase payment state changed';
  end if;
  if p_amount > purchase_row.total_amount - coalesce(purchase_row.paid_amount,0) then
    raise exception using errcode='22023', message='supplier payment exceeds remaining amount';
  end if;
  select * into account_row from public.financial_accounts
    where org_id=p_org_id and id=p_financial_account_id and is_active for update;
  if not found then raise exception using errcode='P0002', message='financial account not found or inactive'; end if;
  if account_row.currency::text <> normalized_currency or account_row.account_type::text not in ('cash','bank','safe') then
    raise exception using errcode='22023', message='supplier payment account mismatch';
  end if;
  select s.name into supplier_name from public.suppliers s where s.org_id=p_org_id and s.id=purchase_row.supplier_id;
  before_purchase := jsonb_build_object('purchase_id',purchase_row.id,'paid_amount',purchase_row.paid_amount,
    'payment_status',purchase_row.payment_status,'total_amount',purchase_row.total_amount);
  paid := coalesce(purchase_row.paid_amount,0) + p_amount;
  insert into public.finance_transactions(org_id,created_by,transaction_type,accounting_kind,amount,currency,
    payment_method,financial_account_id,category,description,counterparty,source,status,stock_purchase_id,
    external_provider,external_reference,occurred_at,metadata)
  values(p_org_id,p_user_id,'expense','supplier_payment',p_amount,normalized_currency,
    case when account_row.account_type::text='bank' then 'transfer' else 'cash' end,
    account_row.id,'Оплата постачальнику','Оплата закупівлі ' || coalesce(purchase_row.purchase_number,purchase_row.id::text),
    supplier_name,'stock','completed',purchase_row.id,'pugcrm-supplier-payment',p_idempotency_key::text,now(),
    jsonb_build_object('request',request_payload,'note',normalized_note,'purchase_before',before_purchase))
    returning * into transaction_row;
  -- Set the exact new amount, not an increment potentially repeated by another writer.
  if paid = purchase_row.total_amount then
    update public.stock_purchases set paid_amount=paid,payment_status='paid',updated_at=now()
      where org_id=p_org_id and id=purchase_row.id returning * into purchase_row;
  else
    update public.stock_purchases set paid_amount=paid,payment_status='partial',updated_at=now()
      where org_id=p_org_id and id=purchase_row.id returning * into purchase_row;
  end if;
  perform public.write_stock_supplier_payment_audit(p_org_id,'financial_account',account_row.id,'supplier_payment',p_user_id,
    before_purchase,jsonb_build_object('purchase_id',purchase_row.id,'paid_amount',purchase_row.paid_amount,
      'payment_status',purchase_row.payment_status),
    jsonb_build_object('stock_purchase_id',purchase_row.id,'transaction_id',transaction_row.id,'amount',p_amount));
  return jsonb_build_object('purchase_id',purchase_row.id,'transaction_id',transaction_row.id,
    'amount',round(transaction_row.amount,2)::text,'paid_amount',round(purchase_row.paid_amount,2)::text,
    'remaining_amount',round(greatest(0,purchase_row.total_amount-purchase_row.paid_amount),2)::text,
    'payment_status',purchase_row.payment_status,'idempotent_replay',false);
end
$function$;

create or replace function public.guard_supplier_payment_ledger()
returns trigger language plpgsql security invoker set search_path=public,pg_temp
as $function$
begin
  raise exception using errcode='55000', message='supplier payment ledger is immutable';
end
$function$;
drop trigger if exists guard_supplier_payment_ledger on public.finance_transactions;
create trigger guard_supplier_payment_ledger before update or delete on public.finance_transactions
for each row when (old.external_provider='pugcrm-supplier-payment')
execute function public.guard_supplier_payment_ledger();

drop trigger if exists guard_stock_supplier_payment_audit on public.stock_supplier_payment_audit;
create trigger guard_stock_supplier_payment_audit before update or delete on public.stock_supplier_payment_audit
for each row execute function public.guard_supplier_payment_ledger();

revoke all on function public.assert_stock_supplier_payment_actor(uuid,uuid) from public,anon,authenticated;
revoke all on function public.write_stock_supplier_payment_audit(uuid,text,uuid,text,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.assert_stock_supplier_payment_actor(uuid,uuid) to service_role;
grant execute on function public.write_stock_supplier_payment_audit(uuid,text,uuid,text,uuid,jsonb,jsonb,jsonb) to service_role;
revoke all on function public.get_stock_purchase_payment_state(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.pay_stock_purchase(uuid,uuid,uuid,uuid,numeric,numeric,numeric,text,uuid,text) from public,anon,authenticated;
revoke all on function public.guard_supplier_payment_ledger() from public,anon,authenticated;
grant execute on function public.get_stock_purchase_payment_state(uuid,uuid,uuid) to service_role;
grant execute on function public.pay_stock_purchase(uuid,uuid,uuid,uuid,numeric,numeric,numeric,text,uuid,text) to service_role;
grant execute on function public.guard_supplier_payment_ledger() to service_role;

notify pgrst, 'reload schema';
commit;
