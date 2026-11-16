begin;

alter table public.staff add column branch_ids uuid[];

update public.staff as staff
set branch_ids = array[branches.id]
from public.branches as branches
where branches.org_id = staff.org_id and branches.is_primary;

-- Existing rows belonging to removed organizations have no branch to backfill.
-- Enforce the assignment on all new and modified rows.
alter table public.staff
  add constraint staff_has_branch
  check (branch_ids is not null and cardinality(branch_ids) > 0) not valid;

create function public.validate_staff_branches()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  branch_id uuid;
  branch_active boolean;
  previous_ids uuid[] := '{}';
begin
  if tg_op = 'UPDATE' and new.org_id is not distinct from old.org_id then
    if new.branch_ids is not distinct from old.branch_ids then
      return new;
    end if;
    previous_ids := old.branch_ids;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 0));

  if tg_op = 'INSERT' and new.branch_ids is null then
    select array[id] into new.branch_ids
    from public.branches
    where org_id = new.org_id and is_primary
    for share;
  end if;

  if new.branch_ids is null or cardinality(new.branch_ids) = 0 then
    raise exception using errcode = '23514', message = 'STAFF_BRANCH_REQUIRED';
  end if;

  if cardinality(new.branch_ids) <> (select count(distinct id) from unnest(new.branch_ids) as branch(id)) then
    raise exception using errcode = '23514', message = 'STAFF_BRANCH_INVALID';
  end if;

  foreach branch_id in array new.branch_ids loop
    if branch_id = any(previous_ids) then
      continue;
    end if;

    select is_active into branch_active from public.branches
    where org_id = new.org_id and id = branch_id
    for share;

    if branch_active is distinct from true then
      raise exception using errcode = '23514', message = 'STAFF_BRANCH_INVALID';
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function public.validate_staff_branches() from public, anon, authenticated;
create trigger staff_validate_branches
before insert or update of org_id, branch_ids on public.staff
for each row execute function public.validate_staff_branches();

commit;
