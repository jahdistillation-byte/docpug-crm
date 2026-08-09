-- Medical Core: structured diagnoses that live across visits.
--
-- The browser never talks to Supabase directly. Flask is the only application
-- caller and uses the server-only service role, so these tables deliberately
-- stay closed to PUBLIC, anon and authenticated.

begin;

do $migration$
declare
  missing_columns text[];
begin
  if to_regclass('public.orgs') is null
     or to_regclass('public.patients') is null
     or to_regclass('public.visits') is null then
    raise exception using
      errcode = '55000',
      message = 'Medical Core requires orgs, patients and visits';
  end if;

  select array_agg(required.column_name order by required.column_name)
  into missing_columns
  from (
    values
      ('orgs', 'id', 'uuid'),
      ('patients', 'id', 'uuid'),
      ('patients', 'org_id', 'uuid'),
      ('visits', 'id', 'uuid'),
      ('visits', 'org_id', 'uuid'),
      ('visits', 'pet_id', 'uuid')
  ) as required(table_name, column_name, udt_name)
  where not exists (
    select 1
    from information_schema.columns as existing
    where existing.table_schema = 'public'
      and existing.table_name = required.table_name
      and existing.column_name = required.column_name
      and existing.udt_name = required.udt_name
  );

  if coalesce(cardinality(missing_columns), 0) > 0 then
    raise exception using
      errcode = '55000',
      message = format(
        'Medical Core preflight failed; missing or non-uuid columns: %s',
        array_to_string(missing_columns, ', ')
      );
  end if;
end
$migration$;

create unique index if not exists patients_org_id_id_uidx
  on public.patients (org_id, id);

create unique index if not exists visits_org_id_id_uidx
  on public.visits (org_id, id);

create table if not exists public.patient_diagnoses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete restrict,
  patient_id uuid not null,
  source_visit_id uuid,
  diagnosis_code text check (
    diagnosis_code is null or char_length(diagnosis_code) <= 100
  ),
  diagnosis_name text not null check (
    char_length(trim(diagnosis_name)) between 1 and 300
  ),
  clinical_note text check (
    clinical_note is null or char_length(clinical_note) <= 4000
  ),
  certainty text not null default 'confirmed' check (
    certainty in ('provisional', 'confirmed')
  ),
  severity text check (
    severity is null
    or severity in ('mild', 'moderate', 'severe', 'critical')
  ),
  status text not null default 'active' check (
    status in ('active', 'remission', 'resolved', 'entered_in_error')
  ),
  onset_at date,
  diagnosed_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  status_reason text check (
    status_reason is null or char_length(status_reason) <= 1000
  ),
  created_by uuid not null,
  updated_by uuid not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_diagnoses_org_id_id_key unique (org_id, id),
  constraint patient_diagnoses_patient_fk
    foreign key (org_id, patient_id)
    references public.patients(org_id, id)
    on delete restrict,
  constraint patient_diagnoses_visit_fk
    foreign key (org_id, source_visit_id)
    references public.visits(org_id, id)
    on delete restrict,
  constraint patient_diagnoses_error_reason_check check (
    status <> 'entered_in_error'
    or char_length(trim(coalesce(status_reason, ''))) between 1 and 1000
  )
);

create index if not exists patient_diagnoses_patient_history_idx
  on public.patient_diagnoses (org_id, patient_id, diagnosed_at desc, id);

create index if not exists patient_diagnoses_patient_active_idx
  on public.patient_diagnoses (
    org_id,
    patient_id,
    severity,
    diagnosed_at desc,
    id
  )
  where status in ('active', 'remission');

create index if not exists patient_diagnoses_source_visit_idx
  on public.patient_diagnoses (org_id, source_visit_id)
  where source_visit_id is not null;

create table if not exists public.patient_diagnosis_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete restrict,
  patient_id uuid not null,
  diagnosis_id uuid not null,
  event_type text not null check (
    event_type in ('created', 'updated', 'status_changed')
  ),
  from_status text,
  to_status text,
  changes jsonb not null default '{}'::jsonb,
  reason text,
  actor_id uuid not null,
  occurred_at timestamptz not null default now(),
  constraint patient_diagnosis_events_diagnosis_fk
    foreign key (org_id, diagnosis_id)
    references public.patient_diagnoses(org_id, id)
    on delete restrict,
  constraint patient_diagnosis_events_patient_fk
    foreign key (org_id, patient_id)
    references public.patients(org_id, id)
    on delete restrict
);

create index if not exists patient_diagnosis_events_timeline_idx
  on public.patient_diagnosis_events (
    org_id,
    diagnosis_id,
    occurred_at desc,
    id
  );

create index if not exists patient_diagnosis_events_patient_idx
  on public.patient_diagnosis_events (
    org_id,
    patient_id,
    occurred_at desc,
    id
  );

create or replace function public.validate_patient_diagnosis()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  new.diagnosis_name := trim(new.diagnosis_name);
  new.diagnosis_code := nullif(trim(new.diagnosis_code), '');
  new.clinical_note := nullif(trim(new.clinical_note), '');
  new.status_reason := nullif(trim(new.status_reason), '');

  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id
       or new.patient_id is distinct from old.patient_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception using
        errcode = '22000',
        message = 'Diagnosis identity fields cannot be changed';
    end if;

    if old.status = 'entered_in_error' then
      raise exception using
        errcode = '22000',
        message = 'An erroneous diagnosis cannot be changed';
    end if;

    if new.status is distinct from old.status and not (
      (old.status = 'active' and new.status in (
        'remission', 'resolved', 'entered_in_error'
      ))
      or (old.status = 'remission' and new.status in (
        'active', 'resolved', 'entered_in_error'
      ))
      or (old.status = 'resolved' and new.status in (
        'active', 'entered_in_error'
      ))
    ) then
      raise exception using
        errcode = '22000',
        message = format(
          'Invalid diagnosis status transition: %s -> %s',
          old.status,
          new.status
        );
    end if;

    if new.status is distinct from old.status then
      new.status_changed_at := now();
    end if;

    new.version := old.version + 1;
    new.updated_at := now();
  end if;

  if new.source_visit_id is not null and not exists (
    select 1
    from public.visits as visit
    where visit.org_id = new.org_id
      and visit.id = new.source_visit_id
      and visit.pet_id = new.patient_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Source visit must belong to the same clinic and patient';
  end if;

  return new;
end
$function$;

create or replace function public.audit_patient_diagnosis()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  event_name text;
  event_changes jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.patient_diagnosis_events (
      org_id,
      patient_id,
      diagnosis_id,
      event_type,
      to_status,
      changes,
      reason,
      actor_id
    ) values (
      new.org_id,
      new.patient_id,
      new.id,
      'created',
      new.status,
      jsonb_build_object(
        'diagnosis_name', new.diagnosis_name,
        'diagnosis_code', new.diagnosis_code,
        'certainty', new.certainty,
        'severity', new.severity,
        'clinical_note', new.clinical_note,
        'onset_at', new.onset_at,
        'diagnosed_at', new.diagnosed_at,
        'source_visit_id', new.source_visit_id
      ),
      new.status_reason,
      new.created_by
    );

    return new;
  end if;

  event_name := case
    when new.status is distinct from old.status then 'status_changed'
    else 'updated'
  end;

  event_changes := jsonb_strip_nulls(jsonb_build_object(
    'diagnosis_name', case
      when new.diagnosis_name is distinct from old.diagnosis_name
      then jsonb_build_object('from', old.diagnosis_name, 'to', new.diagnosis_name)
    end,
    'diagnosis_code', case
      when new.diagnosis_code is distinct from old.diagnosis_code
      then jsonb_build_object('from', old.diagnosis_code, 'to', new.diagnosis_code)
    end,
    'certainty', case
      when new.certainty is distinct from old.certainty
      then jsonb_build_object('from', old.certainty, 'to', new.certainty)
    end,
    'severity', case
      when new.severity is distinct from old.severity
      then jsonb_build_object('from', old.severity, 'to', new.severity)
    end,
    'clinical_note', case
      when new.clinical_note is distinct from old.clinical_note
      then jsonb_build_object('from', old.clinical_note, 'to', new.clinical_note)
    end,
    'onset_at', case
      when new.onset_at is distinct from old.onset_at
      then jsonb_build_object('from', old.onset_at, 'to', new.onset_at)
    end,
    'diagnosed_at', case
      when new.diagnosed_at is distinct from old.diagnosed_at
      then jsonb_build_object('from', old.diagnosed_at, 'to', new.diagnosed_at)
    end,
    'source_visit_id', case
      when new.source_visit_id is distinct from old.source_visit_id
      then jsonb_build_object('from', old.source_visit_id, 'to', new.source_visit_id)
    end,
    'status', case
      when new.status is distinct from old.status
      then jsonb_build_object('from', old.status, 'to', new.status)
    end
  ));

  insert into public.patient_diagnosis_events (
    org_id,
    patient_id,
    diagnosis_id,
    event_type,
    from_status,
    to_status,
    changes,
    reason,
    actor_id
  ) values (
    new.org_id,
    new.patient_id,
    new.id,
    event_name,
    old.status,
    new.status,
    event_changes,
    case
      when new.status is distinct from old.status then new.status_reason
      else null
    end,
    new.updated_by
  );

  return new;
end
$function$;

create or replace function public.prevent_patient_diagnosis_event_changes()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'Diagnosis events are append-only';
end
$function$;

drop trigger if exists patient_diagnoses_validate_trigger
  on public.patient_diagnoses;
create trigger patient_diagnoses_validate_trigger
before insert or update on public.patient_diagnoses
for each row execute function public.validate_patient_diagnosis();

drop trigger if exists patient_diagnoses_audit_trigger
  on public.patient_diagnoses;
create trigger patient_diagnoses_audit_trigger
after insert or update on public.patient_diagnoses
for each row execute function public.audit_patient_diagnosis();

drop trigger if exists patient_diagnoses_prevent_delete_trigger
  on public.patient_diagnoses;
create trigger patient_diagnoses_prevent_delete_trigger
before delete on public.patient_diagnoses
for each row execute function public.prevent_patient_diagnosis_event_changes();

drop trigger if exists patient_diagnosis_events_immutable_trigger
  on public.patient_diagnosis_events;
create trigger patient_diagnosis_events_immutable_trigger
before update or delete on public.patient_diagnosis_events
for each row execute function public.prevent_patient_diagnosis_event_changes();

alter table public.patient_diagnoses enable row level security;
alter table public.patient_diagnosis_events enable row level security;

revoke all privileges on table public.patient_diagnoses
  from public, anon, authenticated, service_role;
revoke all privileges on table public.patient_diagnosis_events
  from public, anon, authenticated, service_role;

grant select, insert, update on table public.patient_diagnoses
  to service_role;
grant select, insert on table public.patient_diagnosis_events
  to service_role;

revoke all privileges on function public.validate_patient_diagnosis()
  from public, anon, authenticated;
revoke all privileges on function public.audit_patient_diagnosis()
  from public, anon, authenticated;
revoke all privileges on function public.prevent_patient_diagnosis_event_changes()
  from public, anon, authenticated;

commit;
