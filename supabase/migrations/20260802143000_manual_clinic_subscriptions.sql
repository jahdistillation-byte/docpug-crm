create table if not exists public.clinic_subscriptions (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  plan_name text not null default 'ЗБТ',
  status text not null default 'unconfigured',
  access_starts_on date,
  access_ends_on date,
  monthly_price numeric(12, 2),
  currency text not null default 'UAH',
  note text,
  updated_by uuid references public.clinic_users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint clinic_subscriptions_status_check check (
    status in ('unconfigured', 'trial', 'active', 'paused')
  ),
  constraint clinic_subscriptions_period_check check (
    access_ends_on is null
    or access_starts_on is null
    or access_ends_on > access_starts_on
  ),
  constraint clinic_subscriptions_price_check check (
    monthly_price is null or monthly_price >= 0
  ),
  constraint clinic_subscriptions_currency_check check (
    currency = 'UAH'
  )
);

create table if not exists public.clinic_subscription_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  action text not null,
  amount numeric(12, 2),
  currency text not null default 'UAH',
  period_starts_on date,
  period_ends_on date,
  before_data jsonb,
  after_data jsonb not null,
  note text,
  actor_user_id uuid references public.clinic_users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  constraint clinic_subscription_events_action_check check (
    action in ('created', 'extended', 'period_set', 'paused', 'resumed')
  ),
  constraint clinic_subscription_events_amount_check check (
    amount is null or amount >= 0
  ),
  constraint clinic_subscription_events_currency_check check (
    currency = 'UAH'
  )
);

create index if not exists clinic_subscription_events_org_created_idx
  on public.clinic_subscription_events (org_id, created_at desc);

alter table public.clinic_subscriptions enable row level security;
alter table public.clinic_subscription_events enable row level security;

revoke all on table public.clinic_subscriptions
  from public, anon, authenticated, service_role;
revoke all on table public.clinic_subscription_events
  from public, anon, authenticated, service_role;

grant select, insert, update on table public.clinic_subscriptions
  to service_role;
grant select, insert on table public.clinic_subscription_events
  to service_role;

insert into public.clinic_subscriptions (org_id)
select id from public.orgs
on conflict (org_id) do nothing;

create or replace function public.ensure_clinic_subscription()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  insert into public.clinic_subscriptions (org_id)
  values (new.id)
  on conflict (org_id) do nothing;

  return new;
end;
$function$;

drop trigger if exists orgs_ensure_clinic_subscription
  on public.orgs;

create trigger orgs_ensure_clinic_subscription
after insert on public.orgs
for each row
execute function public.ensure_clinic_subscription();

revoke execute on function public.ensure_clinic_subscription()
  from public, anon, authenticated;

create or replace function public.manage_clinic_subscription(
  p_org_id uuid,
  p_action text,
  p_actor_user_id uuid,
  p_months integer default null,
  p_access_starts_on date default null,
  p_access_ends_on date default null,
  p_monthly_price numeric default null,
  p_amount numeric default null,
  p_note text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  old_row public.clinic_subscriptions%rowtype;
  new_row public.clinic_subscriptions%rowtype;
  clean_action text := lower(trim(coalesce(p_action, '')));
  extension_months integer := coalesce(p_months, 1);
  extension_base date;
  event_action text;
  event_amount numeric(12, 2);
begin
  if not exists (
    select 1 from public.orgs where id = p_org_id
  ) then
    raise exception using errcode = 'P0002', message = 'CLINIC_NOT_FOUND';
  end if;

  insert into public.clinic_subscriptions (org_id)
  values (p_org_id)
  on conflict (org_id) do nothing;

  select * into old_row
  from public.clinic_subscriptions
  where org_id = p_org_id
  for update;

  if p_monthly_price is not null and p_monthly_price < 0 then
    raise exception using errcode = '22023', message = 'PRICE_INVALID';
  end if;

  if p_amount is not null and p_amount < 0 then
    raise exception using errcode = '22023', message = 'AMOUNT_INVALID';
  end if;

  if clean_action = 'extend' then
    if extension_months < 1 or extension_months > 24 then
      raise exception using errcode = '22023', message = 'MONTHS_INVALID';
    end if;

    extension_base := greatest(
      coalesce(old_row.access_ends_on, current_date),
      current_date
    );

    update public.clinic_subscriptions
    set
      status = 'active',
      access_starts_on = coalesce(access_starts_on, current_date),
      access_ends_on = (
        extension_base + make_interval(months => extension_months)
      )::date,
      monthly_price = coalesce(p_monthly_price, monthly_price),
      note = coalesce(nullif(trim(p_note), ''), note),
      updated_by = p_actor_user_id,
      updated_at = now()
    where org_id = p_org_id
    returning * into new_row;

    event_action := 'extended';
    event_amount := coalesce(
      p_amount,
      case
        when new_row.monthly_price is null then null
        else new_row.monthly_price * extension_months
      end
    );

  elsif clean_action = 'set_period' then
    if p_access_starts_on is null
       or p_access_ends_on is null
       or p_access_ends_on <= p_access_starts_on then
      raise exception using errcode = '22023', message = 'PERIOD_INVALID';
    end if;

    update public.clinic_subscriptions
    set
      status = 'active',
      access_starts_on = p_access_starts_on,
      access_ends_on = p_access_ends_on,
      monthly_price = coalesce(p_monthly_price, monthly_price),
      note = coalesce(nullif(trim(p_note), ''), note),
      updated_by = p_actor_user_id,
      updated_at = now()
    where org_id = p_org_id
    returning * into new_row;

    event_action := 'period_set';
    event_amount := p_amount;

  elsif clean_action = 'pause' then
    update public.clinic_subscriptions
    set
      status = 'paused',
      note = coalesce(nullif(trim(p_note), ''), note),
      updated_by = p_actor_user_id,
      updated_at = now()
    where org_id = p_org_id
    returning * into new_row;

    event_action := 'paused';
    event_amount := null;

  elsif clean_action = 'resume' then
    update public.clinic_subscriptions
    set
      status = case
        when access_ends_on is null then 'unconfigured'
        else 'active'
      end,
      note = coalesce(nullif(trim(p_note), ''), note),
      updated_by = p_actor_user_id,
      updated_at = now()
    where org_id = p_org_id
    returning * into new_row;

    event_action := 'resumed';
    event_amount := null;

  else
    raise exception using errcode = '22023', message = 'ACTION_INVALID';
  end if;

  insert into public.clinic_subscription_events (
    org_id,
    action,
    amount,
    period_starts_on,
    period_ends_on,
    before_data,
    after_data,
    note,
    actor_user_id
  )
  values (
    p_org_id,
    event_action,
    event_amount,
    new_row.access_starts_on,
    new_row.access_ends_on,
    to_jsonb(old_row),
    to_jsonb(new_row),
    nullif(trim(p_note), ''),
    p_actor_user_id
  );

  return to_jsonb(new_row);
end;
$function$;

revoke execute on function public.manage_clinic_subscription(
  uuid, text, uuid, integer, date, date, numeric, numeric, text
) from public, anon, authenticated;

grant execute on function public.manage_clinic_subscription(
  uuid, text, uuid, integer, date, date, numeric, numeric, text
) to service_role;

comment on table public.clinic_subscriptions is
  'Server-only current manual access period for each clinic.';
comment on table public.clinic_subscription_events is
  'Append-only server-side history of manual clinic subscription changes.';
