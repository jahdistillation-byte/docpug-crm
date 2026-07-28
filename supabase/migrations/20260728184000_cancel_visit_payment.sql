begin;

create or replace function public.cancel_visit_payment(
  p_org_id uuid,
  p_transaction_id uuid,
  p_user_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  transaction_row public.finance_transactions%rowtype;
  visit_row public.visits%rowtype;
  service_total numeric := 0;
  stock_total numeric := 0;
  subtotal_value numeric := 0;
  discount_value numeric := 0;
  total_value numeric := 0;
  paid_after numeric := 0;
  remaining_after numeric := 0;
  new_financial_status text;
  cancellation_time timestamptz := now();
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select *
  into transaction_row
  from public.finance_transactions
  where id = p_transaction_id
    and org_id = p_org_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Payment transaction not found';
  end if;

  if transaction_row.transaction_type <> 'payment'
     or transaction_row.visit_id is null then
    raise exception using
      errcode = '22023',
      message = 'Only visit payments can be cancelled';
  end if;

  if transaction_row.status = 'cancelled' then
    raise exception using
      errcode = '55000',
      message = 'Payment is already cancelled';
  end if;

  if transaction_row.status <> 'completed' then
    raise exception using
      errcode = '55000',
      message = 'Only completed payments can be cancelled';
  end if;

  select *
  into visit_row
  from public.visits
  where id = transaction_row.visit_id
    and org_id = p_org_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Visit not found';
  end if;

  update public.finance_transactions
  set
    status = 'cancelled',
    updated_at = cancellation_time,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'cancelled_at', cancellation_time,
      'cancelled_by', p_user_id,
      'cancellation_reason', coalesce(
        normalized_reason,
        'Скасовано користувачем'
      )
    )
  where id = transaction_row.id
    and org_id = p_org_id;

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
    'transaction_id', transaction_row.id,
    'visit_id', visit_row.id,
    'cancelled_amount', transaction_row.amount,
    'cancelled_at', cancellation_time,
    'paid_after', paid_after,
    'remaining', remaining_after,
    'financial_status', new_financial_status
  );
end;
$function$;

revoke all on function public.cancel_visit_payment(
  uuid,
  uuid,
  uuid,
  text
) from public, anon, authenticated;

grant execute on function public.cancel_visit_payment(
  uuid,
  uuid,
  uuid,
  text
) to service_role;

commit;
