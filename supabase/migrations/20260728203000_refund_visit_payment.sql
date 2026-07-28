begin;

alter table public.finance_transactions
  add column if not exists reverses_transaction_id uuid;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.finance_transactions'::regclass
      and conname = 'finance_transactions_reverses_transaction_fk'
  ) then
    alter table public.finance_transactions
      add constraint finance_transactions_reverses_transaction_fk
      foreign key (reverses_transaction_id)
      references public.finance_transactions(id)
      on delete restrict;
  end if;
end
$migration$;

drop index if exists public.finance_transactions_reversal_once_idx;

create unique index if not exists finance_transactions_reversal_once_idx
  on public.finance_transactions (reverses_transaction_id)
  where reverses_transaction_id is not null
    and transaction_type <> 'refund';

create index if not exists finance_transactions_reversals_idx
  on public.finance_transactions (
    org_id,
    reverses_transaction_id,
    occurred_at desc
  )
  where reverses_transaction_id is not null
    and transaction_type = 'refund';

create unique index if not exists finance_transactions_refund_idempotency_idx
  on public.finance_transactions (
    org_id,
    external_provider,
    external_reference
  )
  where external_provider = 'pugcrm-payment-refund'
    and external_reference is not null;

create or replace function public.refund_visit_payment(
  p_org_id uuid,
  p_transaction_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  payment_row public.finance_transactions%rowtype;
  updated_payment_row public.finance_transactions%rowtype;
  refund_row public.finance_transactions%rowtype;
  visit_row public.visits%rowtype;
  service_total numeric := 0;
  stock_total numeric := 0;
  subtotal_value numeric := 0;
  discount_value numeric := 0;
  total_value numeric := 0;
  refunded_before numeric := 0;
  refunded_after numeric := 0;
  refundable_before numeric := 0;
  refundable_after numeric := 0;
  paid_after numeric := 0;
  remaining_after numeric := 0;
  refund_amount numeric := round(coalesce(p_amount, 0), 2);
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  normalized_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  new_financial_status text;
  refund_time timestamptz := now();
begin
  if not exists (
    select 1
    from public.clinic_users as actor
    where actor.org_id = p_org_id
      and actor.id = p_user_id
      and actor.is_active
      and actor.role in ('owner', 'admin')
  ) then
    raise exception using
      errcode = '42501',
      message = 'Finance actor is outside organization';
  end if;

  if refund_amount <= 0 then
    raise exception using
      errcode = '22023',
      message = 'Refund amount must be positive';
  end if;

  if normalized_reason is null then
    raise exception using
      errcode = '22023',
      message = 'Refund reason is required';
  end if;

  if char_length(normalized_reason) > 500 then
    raise exception using
      errcode = '22023',
      message = 'Refund reason is too long';
  end if;

  if normalized_key is null
     or char_length(normalized_key) > 180 then
    raise exception using
      errcode = '22023',
      message = 'Invalid refund idempotency key';
  end if;

  select *
  into payment_row
  from public.finance_transactions
  where id = p_transaction_id
    and org_id = p_org_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Payment transaction not found';
  end if;

  if payment_row.transaction_type <> 'payment'
     or payment_row.visit_id is null then
    raise exception using
      errcode = '22023',
      message = 'Only visit payments can be refunded';
  end if;

  if payment_row.status = 'cancelled' then
    raise exception using
      errcode = '55000',
      message = 'Cancelled payment cannot be refunded';
  end if;

  if payment_row.status <> 'completed' then
    raise exception using
      errcode = '55000',
      message = 'Only completed payments can be refunded';
  end if;

  select *
  into refund_row
  from public.finance_transactions
  where org_id = p_org_id
    and external_provider = 'pugcrm-payment-refund'
    and external_reference = normalized_key;

  if found then
    if refund_row.reverses_transaction_id
       is distinct from p_transaction_id then
      raise exception using
        errcode = '23505',
        message = 'Refund key belongs to another payment';
    end if;

    return jsonb_build_object(
      'transaction', to_jsonb(refund_row),
      'idempotent_replay', true
    );
  end if;

  select *
  into visit_row
  from public.visits
  where id = payment_row.visit_id
    and org_id = p_org_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Visit not found';
  end if;

  select coalesce(sum(amount), 0)
  into refunded_before
  from public.finance_transactions
  where org_id = p_org_id
    and reverses_transaction_id = payment_row.id
    and transaction_type = 'refund'
    and status = 'completed';

  refundable_before := greatest(
    payment_row.amount - refunded_before,
    0
  );

  if refundable_before <= 0 then
    raise exception using
      errcode = '55000',
      message = 'Payment is fully refunded';
  end if;

  if refund_amount > refundable_before then
    raise exception using
      errcode = '22023',
      message = 'Refund amount exceeds refundable balance';
  end if;

  insert into public.finance_transactions (
    org_id,
    visit_id,
    cash_shift_id,
    created_by,
    transaction_type,
    payment_method,
    financial_account_id,
    status,
    source,
    category,
    amount,
    currency,
    description,
    counterparty,
    reverses_transaction_id,
    external_provider,
    external_reference,
    occurred_at,
    metadata
  ) values (
    p_org_id,
    payment_row.visit_id,
    null,
    p_user_id,
    'refund',
    payment_row.payment_method,
    payment_row.financial_account_id,
    'completed',
    'visit',
    'Повернення платежу',
    refund_amount,
    payment_row.currency,
    normalized_reason,
    payment_row.counterparty,
    payment_row.id,
    'pugcrm-payment-refund',
    normalized_key,
    refund_time,
    jsonb_build_object(
      'original_payment_id', payment_row.id,
      'refund_reason', normalized_reason,
      'refunded_by', p_user_id,
      'original_payment_amount', payment_row.amount
    )
  )
  returning *
  into refund_row;

  refunded_after := refunded_before + refund_amount;
  refundable_after := greatest(
    payment_row.amount - refunded_after,
    0
  );

  update public.finance_transactions
  set
    updated_at = refund_time,
    metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object(
        'refunded_amount', refunded_after,
        'refundable_amount', refundable_after,
        'refund_status', case
          when refundable_after <= 0 then 'refunded'
          else 'partial'
        end,
        'last_refund_at', refund_time,
        'last_refunded_by', p_user_id,
        'last_refund_reason', normalized_reason
      )
  where id = payment_row.id
    and org_id = p_org_id
  returning *
  into updated_payment_row;

  select coalesce(
    sum(coalesce(qty, 0) * coalesce(price_snap, 0)),
    0
  )
  into service_total
  from public.visit_services
  where visit_id = visit_row.id;

  select coalesce(
    sum(coalesce(qty, 0) * coalesce(price_snap, 0)),
    0
  )
  into stock_total
  from public.visit_stock
  where visit_id = visit_row.id;

  subtotal_value := service_total + stock_total;
  discount_value := greatest(
    coalesce(visit_row.discount_amount, 0),
    0
  );
  total_value := greatest(
    subtotal_value - discount_value,
    0
  );

  select coalesce(
    sum(
      case
        when transaction_type = 'payment' then amount
        when transaction_type = 'refund' then -amount
        else 0
      end
    ),
    0
  )
  into paid_after
  from public.finance_transactions
  where org_id = p_org_id
    and visit_id = visit_row.id
    and status = 'completed';

  paid_after := greatest(paid_after, 0);
  remaining_after := greatest(total_value - paid_after, 0);

  new_financial_status := case
    when total_value > 0 and remaining_after <= 0 then 'paid'
    when paid_after > 0 then 'partial'
    else 'unpaid'
  end;

  update public.visits
  set
    subtotal_amount = subtotal_value,
    total_amount = total_value,
    paid_amount = paid_after,
    financial_status = new_financial_status
  where id = visit_row.id
    and org_id = p_org_id;

  return jsonb_build_object(
    'transaction', to_jsonb(refund_row),
    'payment_id', payment_row.id,
    'visit_id', visit_row.id,
    'refund_amount', refund_amount,
    'refunded_total', refunded_after,
    'refundable_after', refundable_after,
    'paid_after', paid_after,
    'remaining', remaining_after,
    'financial_status', new_financial_status,
    'idempotent_replay', false
  );
end;
$function$;

revoke all on function public.refund_visit_payment(
  uuid,
  uuid,
  uuid,
  numeric,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.refund_visit_payment(
  uuid,
  uuid,
  uuid,
  numeric,
  text,
  text
) to service_role;

commit;
