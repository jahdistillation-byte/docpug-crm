begin;

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  address text not null default '' check (char_length(address) <= 500),
  is_active boolean not null default true,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  check (not is_primary or is_active)
);

create index branches_org_idx on public.branches(org_id);
create unique index branches_one_primary on public.branches(org_id) where is_primary;

alter table public.branches enable row level security;
revoke all on public.branches from public, anon, authenticated;
grant select, insert, update on public.branches to service_role;

create function public.create_primary_branch()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.branches(org_id, name, address, is_primary)
  values (new.id, 'Основна філія', left(coalesce(new.address, ''), 500), true);
  return new;
end;
$$;
revoke all on function public.create_primary_branch() from public, anon, authenticated;

create trigger org_create_primary_branch
after insert on public.orgs
for each row execute function public.create_primary_branch();

insert into public.branches(org_id, name, address, is_primary)
select id, 'Основна філія', left(coalesce(address, ''), 500), true from public.orgs;

create function public.update_clinic_branch(
  p_org_id uuid, p_branch_id uuid, p_name text, p_address text,
  p_is_active boolean, p_make_primary boolean
) returns public.branches
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  branch public.branches;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));

  select * into branch from public.branches
  where org_id = p_org_id and id = p_branch_id for update;
  if not found then
    return null;
  end if;

  if (branch.is_primary or p_make_primary) and not p_is_active then
    raise exception using errcode = '23514', message = 'PRIMARY_BRANCH_MUST_BE_ACTIVE';
  end if;

  if p_make_primary then
    update public.branches set is_primary = false
    where org_id = p_org_id and is_primary and id <> p_branch_id;
  end if;

  update public.branches
  set name = p_name, address = p_address, is_active = p_is_active,
      is_primary = branch.is_primary or p_make_primary
  where org_id = p_org_id and id = p_branch_id
  returning * into branch;
  return branch;
end;
$$;
revoke all on function public.update_clinic_branch(uuid, uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.update_clinic_branch(uuid, uuid, text, text, boolean, boolean) to service_role;

commit;
