begin;

alter table public.stock_purchases add column branch_id uuid;
alter table public.stock_purchases add constraint stock_purchase_branch_fk
  foreign key (org_id, branch_id) references public.branches(org_id, id);
create index stock_purchase_branch_orders on public.stock_purchases(org_id, branch_id, order_date desc);

update public.stock_purchases purchase
set branch_id = receipts.branch_id
from (
  select org_id, purchase_id, (array_agg(distinct branch_id))[1] as branch_id
  from public.stock_purchase_receipt_branches
  group by org_id, purchase_id
  having count(distinct branch_id) = 1
) receipts
where purchase.org_id = receipts.org_id and purchase.id = receipts.purchase_id;

create function public.assign_stock_purchase_branch()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  new.branch_id := coalesce(new.branch_id, nullif(current_setting('pug.purchase_branch', true), '')::uuid);
  return new;
end;
$$;

create trigger assign_stock_purchase_branch before insert on public.stock_purchases
for each row execute function public.assign_stock_purchase_branch();

create function public.create_stock_purchase_at_branch(
  p_org_id uuid, p_supplier_id uuid, p_user_id uuid, p_order_date date,
  p_expected_date date, p_invoice_number text, p_discount_amount numeric,
  p_currency text, p_document_url text, p_note text, p_items jsonb, p_branch_id uuid
) returns jsonb language plpgsql set search_path = public, pg_temp
as $$
begin
  perform 1 from branches where id = p_branch_id and org_id = p_org_id and is_active for share;
  if not found then
    raise exception using errcode = '22023', message = 'STOCK_BRANCH_UNAVAILABLE';
  end if;

  perform set_config('pug.purchase_branch', p_branch_id::text, true);
  return to_jsonb(public.create_stock_purchase(
    p_org_id, p_supplier_id, p_user_id, p_order_date, p_expected_date,
    p_invoice_number, p_discount_amount, p_currency, p_document_url, p_note, p_items
  ));
end;
$$;

revoke all on function public.create_stock_purchase_at_branch(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function public.create_stock_purchase_at_branch(uuid,uuid,uuid,date,date,text,numeric,text,text,text,jsonb,uuid)
  to service_role;
commit;
