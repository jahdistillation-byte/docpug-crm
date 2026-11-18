begin;

create index stock_movements_branch_history on public.stock_movements(org_id, stock_id, branch_id, created_at desc);

alter table public.visit_stock add column inventory_branch_id uuid references public.branches(id),
  add column inventory_request_id uuid;
create unique index visit_stock_inventory_request on public.visit_stock(visit_id, inventory_request_id)
where inventory_request_id is not null;
update public.visit_stock vs set inventory_branch_id = b.id
from public.visits v join public.branches b on b.org_id = v.org_id and b.is_primary
where vs.visit_id = v.id and vs.inventory_synced is true;

alter table public.hospitalizations add column branch_id uuid;
update public.hospitalizations h set branch_id=b.id from public.branches b
where b.org_id=h.org_id and b.is_primary;
alter table public.hospitalizations add constraint hospitalizations_branch_fk
  foreign key (org_id, branch_id) references public.branches(org_id,id);
alter table public.hospitalizations add constraint hospitalizations_branch_required
  check (org_id is null or branch_id is not null);
create trigger hospital_default_branch before insert or update of org_id, branch_id on public.hospitalizations
for each row execute function public.default_record_branch();

create or replace function public.sync_primary_stock_balance()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  target_branch uuid;
  remaining_delta numeric;
begin
  select coalesce(new.qty, 0) - coalesce(sum(quantity), 0) into remaining_delta
  from stock_branch_balances where org_id = new.org_id and stock_id = new.id;
  if remaining_delta = 0 then return new; end if;

  target_branch := nullif(current_setting('pug.stock_branch',true),'')::uuid;
  if target_branch is null then
    select id into strict target_branch from branches where org_id=new.org_id and is_primary;
  end if;
  insert into stock_branch_balances(org_id,stock_id,branch_id,quantity)
  values(new.org_id,new.id,target_branch,0) on conflict do nothing;
  update stock_branch_balances set quantity=quantity+remaining_delta
  where org_id=new.org_id and stock_id=new.id and branch_id=target_branch and quantity+remaining_delta>=0;
  if not found then
    raise exception using errcode='23514', message='STOCK_BRANCH_INSUFFICIENT';
  end if;
  return new;
end;
$$;

create function public.tag_stock_movement_branch()
returns trigger language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  branch_quantity numeric;
begin
  if new.branch_id is not null then return new; end if;
  new.branch_id := nullif(current_setting('pug.stock_branch',true),'')::uuid;
  if new.branch_id is null then
    select id into new.branch_id from branches where org_id=new.org_id and is_primary;
    return new;
  end if;
  if new.movement_type::text in ('income','writeoff') then
    select quantity into branch_quantity from stock_branch_balances
    where org_id=new.org_id and stock_id=new.stock_id and branch_id=new.branch_id;
    if found then
      new.quantity_after := branch_quantity;
      new.quantity_before := branch_quantity + case when new.movement_type::text='writeoff' then new.quantity else -new.quantity end;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.tag_stock_movement_branch() from public,anon,authenticated;
create trigger tag_stock_movement_branch before insert on public.stock_movements
for each row execute function public.tag_stock_movement_branch();

create function public.add_branch_visit_stock(
  p_org_id uuid,p_visit_id uuid,p_stock_id uuid,p_actor uuid,p_qty numeric,p_price numeric,p_request_id uuid default null
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v visits;
  s stock;
  l visit_stock;
  branch_qty numeric;
begin
  if p_qty is null or p_qty<=0 or p_qty>1000000 then
    raise exception using errcode='22023',message='STOCK_BRANCH_INVALID_OPERATION';
  end if;
  select * into v from visits where org_id=p_org_id and id=p_visit_id for update;
  if not found then raise exception using errcode='P0002',message='VISIT_STOCK_VISIT_NOT_FOUND'; end if;
  if p_request_id is not null then
    select * into l from visit_stock where visit_id=v.id and inventory_request_id=p_request_id;
    if found then
      if l.stock_id<>p_stock_id or l.qty<>p_qty or (p_price is not null and l.price_snap<>p_price) then
        raise exception using errcode='23505',message='STOCK_BRANCH_OPERATION_CONFLICT';
      end if;
      select * into strict s from stock where org_id=p_org_id and id=l.stock_id;
      select quantity into branch_qty from stock_branch_balances
      where org_id=p_org_id and stock_id=s.id and branch_id=l.inventory_branch_id;
      return jsonb_build_object('line',to_jsonb(l),'stock',to_jsonb(s),
        'branch_quantity',coalesce(branch_qty,0),'replayed',true);
    end if;
  end if;
  if not exists(select 1 from orgs o where o.id=p_org_id and o.currency=v.currency) then
    raise exception using errcode='23514',message='VISIT_STOCK_CURRENCY_CHANGED';
  end if;
  if exists(select 1 from visit_stock where visit_id=v.id and inventory_synced is true
            and inventory_branch_id is distinct from v.branch_id) then
    raise exception using errcode='23514',message='VISIT_STOCK_BRANCH_CHANGED';
  end if;
  perform 1 from branches where org_id=p_org_id and id=v.branch_id and is_active for share;
  if not found then raise exception using errcode='22023',message='STOCK_BRANCH_INVALID_BRANCH'; end if;
  select * into s from stock where org_id=p_org_id and id=p_stock_id and active is not false for update;
  if not found then raise exception using errcode='P0002',message='STOCK_BRANCH_ITEM_NOT_FOUND'; end if;
  select quantity into branch_qty from stock_branch_balances
  where org_id=p_org_id and stock_id=s.id and branch_id=v.branch_id;
  if coalesce(branch_qty,0)<p_qty then
    raise exception using errcode='23514',message='STOCK_BRANCH_INSUFFICIENT',detail=coalesce(branch_qty,0)::text;
  end if;
  perform set_config('pug.stock_branch',v.branch_id::text,true);
  insert into visit_stock(visit_id,stock_id,qty,price_snap,name_snap,inventory_synced,inventory_branch_id,inventory_request_id)
  values(v.id,s.id,p_qty,coalesce(p_price,s.price,0),s.name,true,v.branch_id,p_request_id) returning * into l;
  update stock set qty=qty-p_qty,updated_at=now()
  where org_id=p_org_id and id=s.id returning * into s;
  insert into stock_movements(org_id,stock_id,visit_id,created_by,movement_type,quantity,
    quantity_before,quantity_after,unit_cost,name_snap,comment)
  values(p_org_id,s.id,v.id,p_actor,'writeoff',p_qty,branch_qty,branch_qty-p_qty,
    coalesce(s.purchase_price,0),s.name,'Списано у візит');
  return jsonb_build_object('line',to_jsonb(l),'stock',to_jsonb(s),'branch_quantity',branch_qty-p_qty);
end;
$$;

create function public.remove_branch_visit_stock(
  p_org_id uuid,p_visit_id uuid,p_line_id uuid,p_actor uuid,p_expected_qty numeric,p_expected_price numeric
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  l visit_stock;
  s stock;
  branch_id_snapshot uuid;
  branch_quantity numeric;
begin
  perform 1 from visits where org_id=p_org_id and id=p_visit_id for update;
  if not found then raise exception using errcode='P0002',message='VISIT_STOCK_VISIT_NOT_FOUND'; end if;
  select * into l from visit_stock where visit_id=p_visit_id and id=p_line_id for update;
  if not found then raise exception using errcode='P0002',message='VISIT_STOCK_LINE_NOT_FOUND'; end if;
  if l.qty is distinct from p_expected_qty or l.price_snap is distinct from p_expected_price then
    raise exception using errcode='40001',message='VISIT_STOCK_LINE_CHANGED';
  end if;
  if l.inventory_synced is true then
    branch_id_snapshot := l.inventory_branch_id;
    if branch_id_snapshot is null then
      select id into strict branch_id_snapshot from branches where org_id=p_org_id and is_primary;
    end if;
    perform set_config('pug.stock_branch',branch_id_snapshot::text,true);
    update stock set qty=qty+l.qty,updated_at=now()
    where org_id=p_org_id and id=l.stock_id returning * into s;
    if not found then raise exception using errcode='P0002',message='STOCK_BRANCH_ITEM_NOT_FOUND'; end if;
    select quantity into branch_quantity from stock_branch_balances
    where org_id=p_org_id and stock_id=s.id and branch_id=branch_id_snapshot;
    insert into stock_movements(org_id,stock_id,visit_id,created_by,movement_type,quantity,
      quantity_before,quantity_after,unit_cost,name_snap,comment)
    values(p_org_id,s.id,p_visit_id,p_actor,'income',l.qty,s.qty-l.qty,s.qty,
      coalesce(s.purchase_price,0),coalesce(l.name_snap,s.name),'Повернено після видалення з візиту');
  end if;
  delete from visit_stock where visit_id=p_visit_id and id=l.id;
  return jsonb_build_object('restored',l.inventory_synced is true,'stock',
    case when s.id is not null then to_jsonb(s) end,'line',to_jsonb(l),'branch_quantity',branch_quantity);
end;
$$;

create function public.delete_visit_with_branch_stock_restore(p_org_id uuid,p_visit_id uuid,p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  visit_branch uuid;
  restore_branches uuid[];
begin
  select branch_id into visit_branch from visits where org_id=p_org_id and id=p_visit_id for update;
  if found then
    select array_agg(distinct coalesce(inventory_branch_id, visit_branch)) into restore_branches
    from visit_stock where visit_id=p_visit_id and inventory_synced is true;
    if cardinality(restore_branches)>1 then
      raise exception using errcode='23514',message='VISIT_STOCK_BRANCH_CHANGED';
    end if;
    perform set_config('pug.stock_branch',coalesce(restore_branches[1],visit_branch)::text,true);
  end if;
  return public.delete_visit_with_stock_restore(p_org_id,p_visit_id,p_user_id);
end;
$$;

alter function public.hospital_task_command(uuid,uuid,text,uuid,uuid,uuid,jsonb)
rename to hospital_task_stock_command_core;

create function public.hospital_task_command(
  p_org_id uuid,p_user_id uuid,p_action text,p_request_key uuid,
  p_hospitalization_id uuid,p_task_id uuid,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  hospital_branch uuid;
begin
  if p_action='complete' then
    select h.branch_id into hospital_branch
    from hospital_tasks t join hospitalizations h on h.id=t.hospitalization_id and h.org_id=t.org_id
    where t.org_id=p_org_id and t.id=p_task_id;
    if hospital_branch is not null then
      perform set_config('pug.stock_branch',hospital_branch::text,true);
    end if;
  end if;
  return public.hospital_task_stock_command_core(p_org_id,p_user_id,p_action,p_request_key,p_hospitalization_id,p_task_id,p_payload);
end;
$$;

create table public.stock_purchase_receipt_branches (
  org_id uuid not null, purchase_id uuid not null, request_key text not null, branch_id uuid not null,
  primary key(org_id,purchase_id,request_key),
  foreign key(org_id,branch_id) references public.branches(org_id,id)
);
alter table public.stock_purchase_receipt_branches enable row level security;
revoke all on public.stock_purchase_receipt_branches from public,anon,authenticated;
grant select,insert on public.stock_purchase_receipt_branches to service_role;

create function public.receive_stock_purchase_at_branch(
  p_org_id uuid,p_purchase_id uuid,p_user_id uuid,p_idempotency_key text,p_items jsonb,p_note text,p_branch_id uuid
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  receipt_branch uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||p_purchase_id::text||p_idempotency_key,1));
  select branch_id into receipt_branch from stock_purchase_receipt_branches
  where org_id=p_org_id and purchase_id=p_purchase_id and request_key=p_idempotency_key;
  if found then
    if p_branch_id is not null and p_branch_id<>receipt_branch then
      raise exception using errcode='23505',message='STOCK_BRANCH_OPERATION_CONFLICT';
    end if;
  else
    select id into receipt_branch from branches where org_id=p_org_id and is_active
      and (id=p_branch_id or (p_branch_id is null and is_primary)) for share;
    if not found then raise exception using errcode='22023',message='STOCK_BRANCH_INVALID_BRANCH'; end if;
    insert into stock_purchase_receipt_branches values(p_org_id,p_purchase_id,p_idempotency_key,receipt_branch);
  end if;
  perform set_config('pug.stock_branch',receipt_branch::text,true);
  return to_jsonb(public.receive_stock_purchase(
    p_org_id=>p_org_id,p_purchase_id=>p_purchase_id,p_user_id=>p_user_id,
    p_idempotency_key=>p_idempotency_key,p_items=>p_items,p_note=>p_note));
end;
$$;

revoke all on function public.add_branch_visit_stock(uuid,uuid,uuid,uuid,numeric,numeric,uuid),
 public.remove_branch_visit_stock(uuid,uuid,uuid,uuid,numeric,numeric),
 public.delete_visit_with_branch_stock_restore(uuid,uuid,uuid),
 public.hospital_task_command(uuid,uuid,text,uuid,uuid,uuid,jsonb),
 public.receive_stock_purchase_at_branch(uuid,uuid,uuid,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.add_branch_visit_stock(uuid,uuid,uuid,uuid,numeric,numeric,uuid),
 public.remove_branch_visit_stock(uuid,uuid,uuid,uuid,numeric,numeric),
 public.delete_visit_with_branch_stock_restore(uuid,uuid,uuid),
 public.hospital_task_command(uuid,uuid,text,uuid,uuid,uuid,jsonb),
 public.receive_stock_purchase_at_branch(uuid,uuid,uuid,text,jsonb,text,uuid) to service_role;

commit;
