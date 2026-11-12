begin;

alter table public.services drop constraint if exists services_achievement_track_check;
alter table public.services add constraint services_achievement_track_check
  check (achievement_track in ('surgery', 'dentistry', 'ultrasound', 'followup', 'therapy', 'dermatology'));

create table if not exists public.staff_legendary_awards (
  org_id uuid not null,
  staff_id uuid not null,
  award_number smallint not null check (award_number between 1 and 3),
  unlocked_at timestamptz not null default now(),
  primary key (org_id, staff_id, award_number)
);
alter table public.staff_legendary_awards enable row level security;
revoke all on table public.staff_legendary_awards from public, anon, authenticated;
grant select, insert on table public.staff_legendary_awards to service_role;

create or replace function public.get_clinic_rating_points(p_org_id uuid, p_start date, p_end date)
returns jsonb
language sql stable
set search_path = ''
as $$
  with veterinarians as (
    select id from public.staff
    where org_id = p_org_id and is_active is true and role = 'vet'
  ), completed_visits as (
    select v.id, v.pet_id, vet.id as staff_id, v.date::date as activity_date
    from public.visits v
    join veterinarians vet on vet.id::text = v.staff_id::text
    where v.org_id = p_org_id and v.date < p_end
      and coalesce(lower(trim(v.status::text)), '') not in ('cancelled', 'canceled', 'no_show')
      and (lower(trim(v.status::text)) in ('completed', 'done', 'finished')
           or v.completed_at is not null or v.closed_by is not null)
  ), service_events as (
    select distinct v.id, v.staff_id, v.activity_date, s.achievement_track as track
    from completed_visits v
    join public.visit_services line on line.visit_id::text = v.id::text
    join public.services s on s.id::text = lower(trim(line.service_id::text)) and s.org_id = p_org_id
    where s.achievement_track in ('surgery', 'dentistry', 'ultrasound', 'therapy', 'dermatology')
  ), animal_visits as (
    select v.*, case
      when lower(trim(p.species::text)) in ('dog', 'собака', 'пес') then 'canine'
      when lower(trim(p.species::text)) in ('cat', 'кіт', 'кішка', 'кот', 'кошка') then 'feline'
    end as track
    from completed_visits v
    join public.patients p on p.id::text = v.pet_id::text and p.org_id = p_org_id
  ), achievement_events as (
    select staff_id, activity_date, track from service_events
    union all
    select staff_id, activity_date, track from animal_visits where track is not null
    union all
    select v.staff_id, v.activity_date,
      case when v.track = 'canine' then 'dog_vaccines' else 'cat_vaccines' end
    from animal_visits v
    where v.track is not null and exists (
      select 1 from public.patient_vaccinations vaccination
      where vaccination.org_id = p_org_id and vaccination.source_visit_id::text = v.id::text
        and vaccination.patient_id::text = v.pet_id::text
    )
    union all
    select vet.id, (h.discharged_at::timestamptz at time zone 'Europe/Kyiv')::date, 'hospital'
    from public.hospitalizations h
    join veterinarians vet on vet.id::text = h.doctor_id::text
    where h.org_id = p_org_id and h.is_active is false and h.discharged_at is not null
      and (h.discharged_at::timestamptz at time zone 'Europe/Kyiv')::date < p_end
  ), thresholds(track, first, second, third) as (
    values ('cat_vaccines',10,25,100), ('dog_vaccines',10,25,100),
      ('canine',10,25,100), ('feline',10,25,100), ('surgery',5,25,75),
      ('dentistry',5,20,50), ('ultrasound',5,25,100), ('hospital',5,20,50),
      ('therapy',5,20,50), ('dermatology',5,20,50)
  ), progress as (
    select staff_id, track, count(*) as current_count,
      count(*) filter (where activity_date < p_start) as previous_count
    from achievement_events group by staff_id, track
  ), stages as (
    select p.staff_id,
      sum((p.previous_count < t.first and p.current_count >= t.first)::int
          + (p.previous_count < t.second and p.current_count >= t.second)::int
          + (p.previous_count < t.third and p.current_count >= t.third)::int)
        + (count(*) filter (where p.previous_count >= t.second) < 3
           and count(*) filter (where p.current_count >= t.second) >= 3)::int as total
    from progress p join thresholds t using (track) group by p.staff_id
  ), visit_counts as (
    select staff_id, count(*) as total from completed_visits
    where activity_date >= p_start group by staff_id
  ), practice_counts as (
    select staff_id, count(distinct id) as total from service_events
    where activity_date >= p_start and track in ('surgery', 'therapy', 'dentistry')
    group by staff_id
  ), legendary_counts as (
    select staff_id, count(*) as total from public.staff_legendary_awards
    where org_id = p_org_id and (unlocked_at at time zone 'Europe/Kyiv')::date >= p_start
      and (unlocked_at at time zone 'Europe/Kyiv')::date < p_end
    group by staff_id
  )
  select coalesce(jsonb_object_agg(vet.id::text, jsonb_build_object(
    'visits', coalesce(v.total, 0),
    'practice_visits', coalesce(p.total, 0),
    'stages', coalesce(s.total, 0),
    'legendary', coalesce(l.total, 0),
    'points', 10 * coalesce(v.total, 0) + 20 * coalesce(p.total, 0)
      + 50 * coalesce(s.total, 0) + 250 * coalesce(l.total, 0)
  )), '{}'::jsonb)
  from veterinarians vet
  left join visit_counts v on v.staff_id = vet.id
  left join practice_counts p on p.staff_id = vet.id
  left join stages s on s.staff_id = vet.id
  left join legendary_counts l on l.staff_id = vet.id;
$$;

revoke all on function public.get_clinic_rating_points(uuid, date, date) from public, anon, authenticated;
grant execute on function public.get_clinic_rating_points(uuid, date, date) to service_role;

commit;
