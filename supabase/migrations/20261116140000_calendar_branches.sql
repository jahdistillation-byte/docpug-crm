begin;

alter table public.branches add constraint branches_org_id_id_key unique (org_id, id);

alter table public.calendar_events add column branch_id uuid;
alter table public.visits add column branch_id uuid;

update public.calendar_events as event
set branch_id = branch.id
from public.branches as branch
where branch.org_id = event.org_id and branch.is_primary;

update public.visits as visit
set branch_id = branch.id
from public.branches as branch
where branch.org_id = visit.org_id and branch.is_primary;

-- Preserve legacy appointments whose organization was removed. New writes must have a branch.
alter table public.calendar_events
  add constraint calendar_events_branch_fk foreign key (org_id, branch_id) references public.branches(org_id, id),
  add constraint calendar_events_branch_required check (org_id is null or branch_id is not null) not valid;
alter table public.visits
  add constraint visits_branch_fk foreign key (org_id, branch_id) references public.branches(org_id, id),
  add constraint visits_branch_required check (org_id is null or branch_id is not null);

create function public.default_record_branch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.branch_id is null and new.org_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 0));
    select id into new.branch_id from public.branches
    where org_id = new.org_id and is_primary;
  end if;
  return new;
end;
$$;
revoke all on function public.default_record_branch() from public, anon, authenticated;

create trigger calendar_event_default_branch
before insert on public.calendar_events
for each row execute function public.default_record_branch();

create trigger visit_default_branch
before insert on public.visits
for each row execute function public.default_record_branch();

commit;
