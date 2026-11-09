begin;

alter table public.services add column if not exists achievement_track text
  check (achievement_track in ('surgery', 'dentistry', 'ultrasound', 'followup'));

create or replace function public.get_staff_achievement_progress(p_org_id uuid, p_staff_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  with completed_visits as (
    select v.id, v.patient_id
    from public.visits v
    where v.org_id = p_org_id and v.staff_id = p_staff_id
      and coalesce(lower(trim(v.status::text)), '') not in ('cancelled', 'canceled', 'no_show')
      and (lower(trim(v.status::text)) in ('completed', 'done', 'finished')
           or v.completed_at is not null or v.closed_by is not null)
  ), service_cases as (
    select s.achievement_track as track, count(distinct v.id) as total
    from completed_visits v
    join public.visit_services line on line.visit_id = v.id
    join public.services s on s.id = line.service_id and s.org_id = p_org_id
    where s.achievement_track is not null
    group by s.achievement_track
  ), vaccinations as (
    select v.id, lower(trim(p.species::text)) as species
    from completed_visits v
    join public.patient_vaccinations vaccination
      on vaccination.source_visit_id = v.id and vaccination.patient_id = v.patient_id
      and vaccination.org_id = p_org_id
    join public.patients p on p.id = v.patient_id and p.org_id = p_org_id
  )
  select coalesce((select jsonb_object_agg(track, total) from service_cases), '{}'::jsonb)
    || jsonb_build_object(
      'cat_vaccines', (select count(distinct id) from vaccinations where species in ('cat','кіт','кішка','кот','кошка')),
      'dog_vaccines', (select count(distinct id) from vaccinations where species in ('dog','собака','пес')),
      'hospital', (select count(*) from public.hospitalizations h where h.org_id = p_org_id
        and h.doctor_id = p_staff_id and h.is_active is false and h.discharged_at is not null)
    );
$$;

revoke all on function public.get_staff_achievement_progress(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_staff_achievement_progress(uuid, uuid) to service_role;

commit;
