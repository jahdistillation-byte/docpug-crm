begin;

alter table public.stock add constraint stock_branch_org_item_key unique (org_id, id);
alter table public.branches add constraint stock_branch_org_branch_key unique (org_id, id);

create table public.stock_branch_balances (
  org_id uuid not null,
  stock_id uuid not null,
  branch_id uuid not null,
  quantity numeric not null check (quantity >= 0 and quantity < 'Infinity'::numeric),
  primary key (org_id, stock_id, branch_id),
  foreign key (org_id, stock_id) references public.stock(org_id, id) on delete cascade,
  foreign key (org_id, branch_id) references public.branches(org_id, id)
);

create table public.stock_branch_operations (
  id uuid primary key,
  org_id uuid not null,
  stock_id uuid not null,
  from_branch_id uuid,
  to_branch_id uuid,
  quantity numeric not null check (quantity > 0 and quantity < 'Infinity'::numeric),
  created_by uuid not null,
  comment text check (char_length(comment)<=2000),
  created_at timestamptz not null default now(),
  foreign key (org_id, stock_id) references public.stock(org_id, id) on delete restrict,
  foreign key (org_id, from_branch_id) references public.branches(org_id, id),
  foreign key (org_id, to_branch_id) references public.branches(org_id, id),
  check (from_branch_id is distinct from to_branch_id)
);
alter table public.stock_movements add column branch_id uuid, add column branch_operation_id uuid;
alter table public.stock_movements add constraint stock_movement_branch_fk
  foreign key (org_id, branch_id) references public.branches(org_id, id);
alter table public.stock_movements add constraint stock_movement_branch_operation_fk
  foreign key (branch_operation_id) references public.stock_branch_operations(id)
  deferrable initially deferred;

create index stock_branch_operations_history on public.stock_branch_operations(org_id, stock_id, created_at desc);

alter table public.stock_branch_balances enable row level security;
alter table public.stock_branch_operations enable row level security;
revoke all on public.stock_branch_balances, public.stock_branch_operations from public, anon, authenticated;
grant select, insert, update on public.stock_branch_balances to service_role;
grant select, insert on public.stock_branch_operations to service_role;

insert into public.stock_branch_balances(org_id, stock_id, branch_id, quantity)
select s.org_id, s.id, b.id, coalesce(s.qty, 0)
from public.stock s
join public.branches b on b.org_id = s.org_id and b.is_primary;

create function public.sync_primary_stock_balance()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  primary_id uuid;
  remaining_delta numeric;
begin
  -- Legacy stock writes affect the primary branch. Branch-aware RPCs already
  -- update the allocated balances before changing the aggregate.
  select coalesce(new.qty, 0) - coalesce(sum(quantity), 0) into remaining_delta
  from stock_branch_balances where org_id = new.org_id and stock_id = new.id;
  if remaining_delta = 0 then
    return new;
  end if;

  select id into strict primary_id from branches where org_id = new.org_id and is_primary;
  insert into stock_branch_balances(org_id, stock_id, branch_id, quantity)
  values (new.org_id, new.id, primary_id, 0) on conflict do nothing;
  update stock_branch_balances set quantity = quantity + remaining_delta
  where org_id = new.org_id and stock_id = new.id and branch_id = primary_id
    and quantity + remaining_delta >= 0;
  if not found then
    raise exception using errcode = '23514', message = 'STOCK_BRANCH_INSUFFICIENT';
  end if;
  return new;
end;
$$;
revoke all on function public.sync_primary_stock_balance() from public, anon, authenticated;
create trigger sync_primary_stock_balance after insert or update of qty on public.stock
for each row execute function public.sync_primary_stock_balance();

create function public.record_stock_branch_operation(
  p_org_id uuid, p_stock_id uuid, p_actor_id uuid, p_operation_id uuid,
  p_from_branch uuid, p_to_branch uuid, p_quantity numeric, p_comment text default null
) returns void language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  prior stock_branch_operations;
  item stock;
  balance_before numeric;
  movement_kind stock_movements.movement_type%type;
begin
  if p_quantity is null or p_quantity <= 0 or p_quantity >= 'Infinity'::numeric
     or p_from_branch is not distinct from p_to_branch then
    raise exception using errcode = '22023', message = 'STOCK_BRANCH_INVALID_OPERATION';
  end if;

  select * into item from stock
  where org_id = p_org_id and id = p_stock_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'STOCK_BRANCH_ITEM_NOT_FOUND';
  end if;

  select * into prior from stock_branch_operations where id = p_operation_id;
  if found then
    if (prior.org_id, prior.stock_id, prior.created_by, prior.from_branch_id, prior.to_branch_id, prior.quantity, prior.comment)
       is distinct from (p_org_id, p_stock_id, p_actor_id, p_from_branch, p_to_branch, p_quantity, p_comment) then
      raise exception using errcode = '23505', message = 'STOCK_BRANCH_OPERATION_CONFLICT';
    end if;
    return;
  end if;

  perform id from branches
  where org_id = p_org_id and id in (p_from_branch, p_to_branch) and is_active
  order by id for share;
  if (select count(*) from branches
      where org_id = p_org_id and id in (p_from_branch, p_to_branch) and is_active)
     <> num_nonnulls(p_from_branch, p_to_branch) then
    raise exception using errcode = '22023', message = 'STOCK_BRANCH_INVALID_BRANCH';
  end if;

  if p_from_branch is not null then
    update stock_branch_balances set quantity = quantity - p_quantity
    where org_id = p_org_id and stock_id = p_stock_id and branch_id = p_from_branch
      and quantity >= p_quantity
    returning quantity + p_quantity into balance_before;
    if not found then
      raise exception using errcode = '23514', message = 'STOCK_BRANCH_INSUFFICIENT';
    end if;
  end if;
  if p_to_branch is not null then
    insert into stock_branch_balances(org_id, stock_id, branch_id, quantity)
    values (p_org_id, p_stock_id, p_to_branch, p_quantity)
    on conflict (org_id, stock_id, branch_id) do update
    set quantity = stock_branch_balances.quantity + excluded.quantity
    returning quantity - p_quantity into balance_before;
  end if;

  if p_from_branch is null or p_to_branch is null then
    update stock set qty = coalesce(item.qty, 0) + case when p_from_branch is null then p_quantity else -p_quantity end,
      updated_at = now()
    where org_id = p_org_id and id = p_stock_id;

    movement_kind := case when p_from_branch is null then 'income' else 'writeoff' end;
    insert into stock_movements(org_id, stock_id, created_by, movement_type, quantity,
      quantity_before, quantity_after, unit_cost, name_snap, comment, branch_id, branch_operation_id)
    values (p_org_id, p_stock_id, p_actor_id,
      movement_kind, p_quantity, balance_before,
      balance_before + case when p_from_branch is null then p_quantity else -p_quantity end,
      coalesce(item.purchase_price, 0), item.name, coalesce(p_comment, 'Рух складу філії'), coalesce(p_from_branch,p_to_branch), p_operation_id);
  end if;

  insert into stock_branch_operations(id, org_id, stock_id, from_branch_id, to_branch_id, quantity, created_by, comment)
  values (p_operation_id, p_org_id, p_stock_id, p_from_branch, p_to_branch, p_quantity, p_actor_id, p_comment);
end;
$$;
revoke all on function public.record_stock_branch_operation(uuid, uuid, uuid, uuid, uuid, uuid, numeric, text)
from public, anon, authenticated;
grant execute on function public.record_stock_branch_operation(uuid, uuid, uuid, uuid, uuid, uuid, numeric, text)
to service_role;

commit;
