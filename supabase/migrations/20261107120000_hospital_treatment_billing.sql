-- Hospital treatment charges are not payments. Existing visits/finance are untouched.
begin;
do $preflight$
declare missing text;
begin
 select string_agg(t||'.'||c,', ') into missing from (values
 ('hospitalizations','org_id'),('hospitalizations','is_active'),('hospital_tasks','hospitalization_id'),
 ('hospital_tasks','status'),('hospital_tasks','completed_by'),('hospital_tasks','completion_note'),
 ('stock','qty'),('stock','unit'),('stock','purchase_price'),('services','price'),('orgs','currency'),
 ('stock_movements','quantity_before'),('stock_movements','quantity_after'),('clinic_users','is_active'),('staff','is_active')
 ) required(t,c) where not exists(select 1 from information_schema.columns x
 where x.table_schema='public' and x.table_name=t and x.column_name=c);
 if missing is not null then raise exception 'Hospital billing preflight: missing %',missing; end if;
 if exists(select 1 from information_schema.columns where table_schema='public' and
 ((table_name='stock' and column_name in ('qty','price','purchase_price')) or
 (table_name='services' and column_name='price')) and udt_name<>'numeric') then
 raise exception 'Hospital billing requires numeric quantities and prices'; end if;
end
$preflight$;

alter table public.hospitalizations add column if not exists billing_currency text;
alter table public.hospital_tasks add column if not exists billing_managed boolean not null default false;
create unique index if not exists hospitalizations_billing_org_id_idx on public.hospitalizations(org_id,id);
create unique index if not exists hospital_tasks_billing_org_id_idx on public.hospital_tasks(org_id,id);
alter table public.stock_movements add column if not exists hospital_task_id uuid;
do $movement_fk$
begin
 if not exists(select 1 from pg_constraint where conrelid='public.stock_movements'::regclass and conname='stock_movements_hospital_task_fk') then
 alter table public.stock_movements add constraint stock_movements_hospital_task_fk foreign key(org_id,hospital_task_id) references public.hospital_tasks(org_id,id) on delete restrict;
 end if;
end
$movement_fk$;

create table if not exists public.hospital_treatment_items(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.orgs(id),
 task_id uuid not null,hospitalization_id uuid not null,kind text not null check(kind in ('service','stock')),
 catalog_id uuid not null,name_snap text not null,unit_snap text not null,
 quantity numeric not null check(quantity>0 and quantity<=1000000 and quantity=round(quantity,6)),
 price_snap numeric(14,2) not null check(price_snap>=0),currency text not null,
 created_at timestamptz not null default now(),unique(task_id,kind,catalog_id),unique(org_id,id),
 foreign key(org_id,task_id) references public.hospital_tasks(org_id,id) on delete restrict,
 foreign key(org_id,hospitalization_id) references public.hospitalizations(org_id,id) on delete restrict
);
create table if not exists public.hospital_treatment_charges(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.orgs(id),
 hospitalization_id uuid not null,task_id uuid not null,item_id uuid not null unique,
 quantity numeric not null check(quantity>0),amount numeric(18,2) not null check(amount>=0),
 stock_movement_id uuid references public.stock_movements(id) on delete restrict,
 actor_id uuid not null references public.clinic_users(id),created_at timestamptz not null default now(),
 foreign key(org_id,item_id) references public.hospital_treatment_items(org_id,id) on delete restrict,
 foreign key(org_id,hospitalization_id) references public.hospitalizations(org_id,id) on delete restrict,
 foreign key(org_id,task_id) references public.hospital_tasks(org_id,id) on delete restrict
);
create table if not exists public.hospital_treatment_events(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.orgs(id),
 hospitalization_id uuid not null,task_id uuid not null,actor_id uuid not null references public.clinic_users(id),
 action text not null check(action in ('create','complete','cancel')),request_key uuid not null,
 request_payload jsonb not null,result jsonb not null,created_at timestamptz not null default now(),
 unique(org_id,request_key),foreign key(org_id,task_id) references public.hospital_tasks(org_id,id),
 foreign key(org_id,hospitalization_id) references public.hospitalizations(org_id,id)
);
create index if not exists hospital_items_episode_idx on public.hospital_treatment_items(org_id,hospitalization_id);
create index if not exists hospital_charges_episode_idx on public.hospital_treatment_charges(org_id,hospitalization_id);
alter table public.hospital_treatment_items enable row level security;
alter table public.hospital_treatment_charges enable row level security;
alter table public.hospital_treatment_events enable row level security;
revoke all on public.hospital_treatment_items,public.hospital_treatment_charges,public.hospital_treatment_events from public,anon,authenticated;
grant select,insert on public.hospital_treatment_items,public.hospital_treatment_charges,public.hospital_treatment_events to service_role;

create or replace function public.assert_hospital_billing_actor(p_org_id uuid,p_user_id uuid)
returns void language plpgsql stable security invoker set search_path=public,pg_temp as $function$
begin
 if p_org_id is null or p_user_id is null or not exists(select 1 from clinic_users
 where org_id=p_org_id and id=p_user_id and is_active and role in ('owner','admin','vet','assistant')) then
 raise exception using errcode='42501',message='hospital actor forbidden'; end if;
end
$function$;

create or replace function public.hospital_task_command(
 p_org_id uuid,p_user_id uuid,p_action text,p_request_key uuid,
 p_hospitalization_id uuid,p_task_id uuid,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $function$
declare
 h public.hospitalizations%rowtype;t public.hospital_tasks%rowtype;
 prior public.hospital_treatment_events%rowtype;item public.hospital_treatment_items%rowtype;
 s public.stock%rowtype;svc public.services%rowtype;line jsonb;actual jsonb;
 request_data jsonb;response jsonb;catalog_currency text;quantity numeric;price numeric;
 item_id uuid;catalog uuid;kind text;name text;unit text;movement uuid;remaining numeric;
 scheduled timestamptz;staff_id uuid;total numeric:=0;actual_count integer;
begin
 perform public.assert_hospital_billing_actor(p_org_id,p_user_id);
 if p_action is null or p_action not in ('create','complete','cancel') or p_request_key is null
 or jsonb_typeof(p_payload) is distinct from 'object' then
 raise exception using errcode='22023',message='invalid hospital command'; end if;
 request_data:=jsonb_build_object('action',p_action,'actor',p_user_id,'hospitalization',p_hospitalization_id,'task',p_task_id,'payload',p_payload);
 perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||p_request_key::text,0));
 select * into prior from hospital_treatment_events where org_id=p_org_id and request_key=p_request_key;
 if found then
  if prior.request_payload is distinct from request_data then raise exception using errcode='23505',message='hospital key payload conflict'; end if;
  return prior.result||jsonb_build_object('idempotent_replay',true);
 end if;
 -- Same lock order for creation/completion/cancellation and discharge's row update.
 if p_action='create' then
  select * into h from hospitalizations where org_id=p_org_id and id=p_hospitalization_id for update;
 else
  select hospitalization_id into item_id from hospital_tasks where org_id=p_org_id and id=p_task_id;
  select * into h from hospitalizations where org_id=p_org_id and id=item_id for update;
 end if;
 if not found then raise exception using errcode='P0002',message='hospitalization not found'; end if;
 if not h.is_active then raise exception using errcode='55000',message='hospitalization closed'; end if;
 select currency into catalog_currency from orgs where id=p_org_id for share;
 if catalog_currency is null or catalog_currency not in ('UAH','EUR','USD','GBP','PLN','CHF') then
 raise exception using errcode='22023',message='invalid hospital currency'; end if;
 if p_action='create' then
  if p_payload->>'task_type' is null or p_payload->>'task_type' not in ('medication','infusion','feeding','measurement','procedure','examination','other')
  or length(trim(coalesce(p_payload->>'title',''))) not between 1 and 300
  or length(coalesce(p_payload->>'instructions',''))>5000
  or p_payload->>'currency' is distinct from catalog_currency
  or jsonb_typeof(p_payload->'items') is distinct from 'array'
  or jsonb_array_length(p_payload->'items')>50 then
  raise exception using errcode='22023',message='invalid treatment data or currency'; end if;
  scheduled:=(p_payload->>'scheduled_at')::timestamptz;
  if scheduled is null or not isfinite(scheduled) then raise exception using errcode='22023',message='invalid treatment schedule'; end if;
  if h.billing_currency is not null and h.billing_currency<>catalog_currency then
  raise exception using errcode='40001',message='hospital currency changed'; end if;
  update hospitalizations set billing_currency=catalog_currency where org_id=p_org_id and id=h.id;
  insert into hospital_tasks(org_id,hospitalization_id,task_type,title,instructions,scheduled_at,status,created_by,billing_managed)
  values(p_org_id,h.id,p_payload->>'task_type',trim(p_payload->>'title'),nullif(trim(p_payload->>'instructions'),''),scheduled,'planned',p_user_id,true) returning * into t;
  for line in select value from jsonb_array_elements(p_payload->'items') loop
   if jsonb_typeof(line) is distinct from 'object' or jsonb_typeof(line->'quantity') is distinct from 'string'
    or (line->>'quantity')!~'^[0-9]+(\.[0-9]{1,6})?$' then raise exception using errcode='22023',message='invalid item quantity'; end if;
   quantity:=(line->>'quantity')::numeric;kind:=line->>'kind';catalog:=(line->>'catalog_id')::uuid;
   if quantity<=0 or quantity>1000000 then raise exception using errcode='22023',message='invalid item quantity'; end if;
   if kind='service' then
    select * into svc from services where org_id=p_org_id and id=catalog and active for share;
    if not found then raise exception using errcode='P0002',message='active service not found'; end if;
    if quantity<>trunc(quantity) then raise exception using errcode='22023',message='service quantity must be integer'; end if;
    price:=round(svc.price,2);name:=svc.name;unit:='послуга';
   elsif kind='stock' then
    select * into s from stock where org_id=p_org_id and id=catalog and active for share;
    if not found then raise exception using errcode='P0002',message='active stock not found'; end if;
    price:=round(s.price,2);name:=s.name;unit:=s.unit;
   else raise exception using errcode='22023',message='invalid item kind'; end if;
   if price<0 or price::text in ('NaN','Infinity','-Infinity') or price>1000000000 then
    raise exception using errcode='22023',message='invalid catalogue price'; end if;
   if jsonb_typeof(line->'expected_price') is distinct from 'string' or (line->>'expected_price')!~'^[0-9]+(\.[0-9]{1,2})?$' then
    raise exception using errcode='22023',message='invalid expected price'; end if;
   if price<>(line->>'expected_price')::numeric then raise exception using errcode='40001',message='catalogue price changed'; end if;
   insert into hospital_treatment_items(org_id,task_id,hospitalization_id,kind,catalog_id,name_snap,unit_snap,quantity,price_snap,currency)
   values(p_org_id,t.id,h.id,kind,catalog,name,unit,quantity,price,catalog_currency);
  end loop;
 else
  select * into t from hospital_tasks where org_id=p_org_id and id=p_task_id for update;
  if t.status not in ('planned','overdue') then raise exception using errcode='55000',message='treatment already closed'; end if;
  if p_action='complete' then
   staff_id:=(p_payload->>'completed_by')::uuid;
   if staff_id is null or not exists(select 1 from staff where org_id=p_org_id and id=staff_id and is_active) then
   raise exception using errcode='P0002',message='active staff not found'; end if;
   if length(coalesce(p_payload->>'completion_note',''))>5000
   or (t.task_type='measurement' and length(trim(coalesce(p_payload->>'completion_note','')))=0)
   or jsonb_typeof(p_payload->'actual_items') is distinct from 'array' then
   raise exception using errcode='22023',message='invalid completion data'; end if;
   select count(*) into actual_count from hospital_treatment_items where org_id=p_org_id and task_id=t.id;
   if actual_count>0 and h.billing_currency is distinct from catalog_currency then
    raise exception using errcode='40001',message='hospital currency changed'; end if;
   if jsonb_array_length(p_payload->'actual_items')<>actual_count or
   (select count(distinct value->>'item_id') from jsonb_array_elements(p_payload->'actual_items'))<>actual_count
   or exists(select 1 from jsonb_array_elements(p_payload->'actual_items') a where not exists(
     select 1 from hospital_treatment_items i where i.org_id=p_org_id and i.task_id=t.id and i.id::text=a->>'item_id')) then
   raise exception using errcode='40001',message='treatment items changed'; end if;
   -- Global stock lock order prevents two multi-material completions deadlocking.
   perform 1 from stock where org_id=p_org_id and id in (select i.catalog_id from hospital_treatment_items i
     where i.org_id=p_org_id and i.task_id=t.id and i.kind='stock') order by id for update;
   for item in select * from hospital_treatment_items where org_id=p_org_id and task_id=t.id order by id loop
    select value into actual from jsonb_array_elements(p_payload->'actual_items') where value->>'item_id'=item.id::text;
    if jsonb_typeof(actual->'quantity') is distinct from 'string' or (actual->>'quantity')!~'^[0-9]+(\.[0-9]{1,6})?$' then
    raise exception using errcode='22023',message='invalid actual quantity'; end if;
    quantity:=(actual->>'quantity')::numeric;
    if quantity<0 or quantity>1000000 or (item.kind='service' and quantity<>trunc(quantity)) then
    raise exception using errcode='22023',message='invalid actual quantity'; end if;
    if quantity=0 then continue; end if;
    movement:=null;
    if item.kind='stock' then
     select * into s from stock where org_id=p_org_id and id=item.catalog_id;
     if not found or not s.active then raise exception using errcode='P0002',message='active stock not found'; end if;
     if s.unit<>item.unit_snap then raise exception using errcode='40001',message='stock unit changed'; end if;
     if s.qty::text in ('NaN','Infinity','-Infinity') or s.qty<quantity then
     raise exception using errcode='22023',message='insufficient stock'; end if;
     remaining:=s.qty-quantity;
     update stock set qty=remaining,updated_at=now() where org_id=p_org_id and id=s.id;
     insert into stock_movements(org_id,stock_id,created_by,movement_type,quantity,quantity_before,quantity_after,unit_cost,name_snap,comment,hospital_task_id)
     values(p_org_id,s.id,p_user_id,'writeoff',quantity,s.qty,remaining,s.purchase_price,item.name_snap,'Списано у стаціонарі · '||t.title,t.id) returning id into movement;
    end if;
    insert into hospital_treatment_charges(org_id,hospitalization_id,task_id,item_id,quantity,amount,stock_movement_id,actor_id)
    values(p_org_id,h.id,t.id,item.id,quantity,round(quantity*item.price_snap,2),movement,p_user_id);
    total:=total+round(quantity*item.price_snap,2);
   end loop;
   perform set_config('pug.hospital_command','on',true);
   update hospital_tasks set status='completed',completed_at=now(),completed_by=staff_id,
    completion_note=nullif(trim(p_payload->>'completion_note'),''),billing_managed=true,updated_at=now()
    where org_id=p_org_id and id=t.id returning * into t;
  else
   perform set_config('pug.hospital_command','on',true);
   update hospital_tasks set status='cancelled',billing_managed=true,updated_at=now()
    where org_id=p_org_id and id=t.id returning * into t;
  end if;
 end if;
 response:=jsonb_build_object('task',to_jsonb(t),'charged_amount',round(total,2)::text,'currency',coalesce(h.billing_currency,catalog_currency),'idempotent_replay',false);
 insert into hospital_treatment_events(org_id,hospitalization_id,task_id,actor_id,action,request_key,request_payload,result)
 values(p_org_id,h.id,t.id,p_user_id,p_action,p_request_key,request_data,response);
 return response;
end
$function$;

create or replace function public.get_hospital_billing_state(p_org_id uuid,p_user_id uuid,p_hospitalization_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $function$
declare h public.hospitalizations%rowtype;items jsonb;charges jsonb;total numeric;
begin
 perform assert_hospital_billing_actor(p_org_id,p_user_id);
 select * into h from hospitalizations where org_id=p_org_id and id=p_hospitalization_id;
 if not found then raise exception using errcode='P0002',message='hospitalization not found'; end if;
 select coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('quantity',i.quantity::text,'price_snap',i.price_snap::text) order by i.created_at,i.id),'[]') into items
 from hospital_treatment_items i where org_id=p_org_id and hospitalization_id=h.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'task_id',c.task_id,'item_id',c.item_id,'kind',i.kind,'name',i.name_snap,
 'unit',i.unit_snap,'quantity',c.quantity::text,'price',i.price_snap::text,'amount',c.amount::text,'currency',i.currency,'created_at',c.created_at) order by c.created_at,c.id),'[]'),coalesce(sum(c.amount),0) into charges,total
 from hospital_treatment_charges c join hospital_treatment_items i on i.org_id=c.org_id and i.id=c.item_id
 where c.org_id=p_org_id and c.hospitalization_id=h.id;
 return jsonb_build_object('hospitalization_id',h.id,'currency',coalesce(h.billing_currency,(select currency from orgs where id=p_org_id)),
 'is_active',h.is_active,'items',items,'charges',charges,'total',round(total,2)::text);
end
$function$;

create or replace function public.guard_hospital_billing_records() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $function$
begin
 if tg_table_name='hospital_tasks' then
  if old.billing_managed and (tg_op='DELETE' or old.status in ('completed','cancelled')
    or current_setting('pug.hospital_command',true) is distinct from 'on') then
   raise exception using errcode='55000',message='managed treatment is immutable outside hospital command'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
 end if;
 raise exception using errcode='55000',message='hospital billing records are immutable';
end
$function$;
drop trigger if exists guard_hospital_task_billing on public.hospital_tasks;
create trigger guard_hospital_task_billing before update or delete on public.hospital_tasks for each row execute function public.guard_hospital_billing_records();
drop trigger if exists guard_hospital_items on public.hospital_treatment_items;
create trigger guard_hospital_items before update or delete on public.hospital_treatment_items for each row execute function public.guard_hospital_billing_records();
drop trigger if exists guard_hospital_charges on public.hospital_treatment_charges;
create trigger guard_hospital_charges before update or delete on public.hospital_treatment_charges for each row execute function public.guard_hospital_billing_records();
drop trigger if exists guard_hospital_events on public.hospital_treatment_events;
create trigger guard_hospital_events before update or delete on public.hospital_treatment_events for each row execute function public.guard_hospital_billing_records();
drop trigger if exists guard_hospital_stock_movements on public.stock_movements;
create trigger guard_hospital_stock_movements before update or delete on public.stock_movements for each row when(old.hospital_task_id is not null) execute function public.guard_hospital_billing_records();
revoke all on function public.assert_hospital_billing_actor(uuid,uuid) from public,anon,authenticated;
revoke all on function public.hospital_task_command(uuid,uuid,text,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.get_hospital_billing_state(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.guard_hospital_billing_records() from public,anon,authenticated;
grant execute on function public.assert_hospital_billing_actor(uuid,uuid),public.hospital_task_command(uuid,uuid,text,uuid,uuid,uuid,jsonb),public.get_hospital_billing_state(uuid,uuid,uuid),public.guard_hospital_billing_records() to service_role;
notify pgrst,'reload schema';
commit;
