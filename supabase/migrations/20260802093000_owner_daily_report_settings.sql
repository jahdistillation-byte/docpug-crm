create table if not exists public.clinic_report_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  telegram_chat_id text,
  daily_enabled boolean not null default false,
  daily_time time without time zone not null default '21:00:00',
  timezone text not null default 'Europe/Kyiv',
  updated_by uuid references public.clinic_users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint clinic_report_settings_chat_id_check check (
    telegram_chat_id is null
    or telegram_chat_id ~ '^-?[0-9]{5,20}$'
  ),
  constraint clinic_report_settings_timezone_check check (
    timezone = 'Europe/Kyiv'
  )
);

alter table public.clinic_report_settings enable row level security;

revoke all on table public.clinic_report_settings
  from public, anon, authenticated, service_role;

grant select, insert, update on table public.clinic_report_settings
  to service_role;

comment on table public.clinic_report_settings is
  'Server-only owner report delivery settings. Telegram bot token is never stored here.';
