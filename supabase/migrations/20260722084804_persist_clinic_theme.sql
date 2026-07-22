alter table public.orgs
  add column if not exists theme text not null default 'purple';

alter table public.orgs
  drop constraint if exists orgs_theme_check;

alter table public.orgs
  add constraint orgs_theme_check
  check (theme in ('purple', 'black', 'white', 'blue', 'green'));
