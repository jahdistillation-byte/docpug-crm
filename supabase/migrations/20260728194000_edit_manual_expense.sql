begin;

create or replace function public.edit_manual_expense(
  p_org_id uuid,
  p_transaction_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_category text,
  p_payment_method text,
  p_occurred_at timestamptz,
  p_counterparty text default null,
  p_description text default null,
  p_document_url text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  transaction_row public.finance_transactions%rowtype;
  account_id uuid;
  edited_transaction public.finance_transactions%rowtype;
  edit_time timestamptz := now();
begin
  if p_amount is null
     or p_amount <= 0
     or p_amount > 1000000000 then
    raise exception using
      errcode = '22023',
      message = 'Invalid expense amount';
  end if;

  if nullif(trim(coalesce(p_category, '')), '') is null
     or length(trim(p_category)) > 150 then
    raise exception using
      errcode = '22023',
      message = 'Invalid expense category';
  end if;

  if p_payment_method not in (
    'cash',
    'card',
    'terminal',
    'transfer',
    'other'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Invalid payment method';
  end if;

  if p_occurred_at is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid expense date';
  end if;

  if length(coalesce(p_counterparty, '')) > 300
     or length(coalesce(p_description, '')) > 2000
     or length(coalesce(p_document_url, '')) > 2000 then
    raise exception using
      errcode = '22023',
      message = 'Expense details are too long';
  end if;

  select *
  into transaction_row
  from public.finance_transactions
  where id = p_transaction_id
    and org_id = p_org_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Expense transaction not found';
  end if;

  if transaction_row.transaction_type <> 'expense'
     or transaction_row.source <> 'manual'
     or transaction_row.status <> 'completed'
     or transaction_row.visit_id is not null then
    raise exception using
      errcode = '55000',
      message = 'Only completed manual expenses can be edited';
  end if;

  account_id := public.resolve_default_financial_account(
    p_org_id,
    p_payment_method
  );

  if account_id is null then
    raise exception using
      errcode = '23503',
      message = 'Default financial account not found';
  end if;

  update public.finance_transactions
  set
    amount = round(p_amount, 2),
    category = trim(p_category),
    payment_method = p_payment_method,
    financial_account_id = account_id,
    occurred_at = p_occurred_at,
    counterparty = nullif(trim(coalesce(p_counterparty, '')), ''),
    description = coalesce(
      nullif(trim(coalesce(p_description, '')), ''),
      'Витрата'
    ),
    document_url = nullif(trim(coalesce(p_document_url, '')), ''),
    updated_at = edit_time,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'edited_at', edit_time,
      'edited_by', p_user_id,
      'edit_count', coalesce(
        (metadata->>'edit_count')::integer,
        0
      ) + 1
    )
  where id = transaction_row.id
    and org_id = p_org_id
  returning *
  into edited_transaction;

  return jsonb_build_object(
    'transaction', to_jsonb(edited_transaction),
    'previous_amount', transaction_row.amount,
    'previous_payment_method', transaction_row.payment_method
  );
end;
$function$;

revoke all on function public.edit_manual_expense(
  uuid,
  uuid,
  uuid,
  numeric,
  text,
  text,
  timestamptz,
  text,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.edit_manual_expense(
  uuid,
  uuid,
  uuid,
  numeric,
  text,
  text,
  timestamptz,
  text,
  text,
  text
) to service_role;

commit;
