-- TEST FIXTURE ONLY. Never apply this file to a hosted Supabase project.
-- Minimal production-shaped dependencies for the Medical Core migration.

create schema if not exists extensions;

create table public.orgs (
  id uuid primary key,
  name text
);

create table public.patients (
  id uuid primary key,
  org_id uuid not null references public.orgs(id),
  name text not null
);

create table public.visits (
  id uuid primary key,
  org_id uuid not null references public.orgs(id),
  pet_id uuid not null references public.patients(id),
  date date
);

insert into public.orgs (id, name) values
  ('00000000-0000-4000-8000-000000000001', 'Clinic A'),
  ('00000000-0000-4000-8000-000000000002', 'Clinic B');

insert into public.patients (id, org_id, name) values
  (
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'Жужа'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'Луна'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000002',
    'Рекс'
  );

insert into public.visits (id, org_id, pet_id, date) values
  (
    '20000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    current_date
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    current_date
  );
