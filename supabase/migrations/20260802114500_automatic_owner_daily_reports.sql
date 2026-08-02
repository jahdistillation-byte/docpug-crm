create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

create table if not exists public.clinic_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  report_date date not null,
  channel text not null default 'telegram',
  status text not null default 'processing',
  attempt_count integer not null default 1,
  telegram_message_id text,
  error_message text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  sent_at timestamp with time zone,
  constraint clinic_report_deliveries_channel_check check (
    channel = 'telegram'
  ),
  constraint clinic_report_deliveries_status_check check (
    status in ('processing', 'sent', 'failed')
  ),
  constraint clinic_report_deliveries_attempt_count_check check (
    attempt_count between 1 and 3
  ),
  unique (org_id, report_date, channel)
);

create index if not exists clinic_report_deliveries_status_idx
  on public.clinic_report_deliveries (status, report_date);

alter table public.clinic_report_deliveries enable row level security;

revoke all on table public.clinic_report_deliveries
  from public, anon, authenticated, service_role;

grant select, insert, update on table public.clinic_report_deliveries
  to service_role;

create table if not exists public.clinic_report_dispatch_auth (
  singleton boolean primary key default true check (singleton),
  token_hash text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.clinic_report_dispatch_auth enable row level security;

revoke all on table public.clinic_report_dispatch_auth
  from public, anon, authenticated, service_role;

grant select on table public.clinic_report_dispatch_auth
  to service_role;

do $migration$
declare
  dispatch_token text;
begin
  select decrypted_secret
    into dispatch_token
  from vault.decrypted_secrets
  where name = 'owner_daily_report_dispatch_token'
  limit 1;

  if dispatch_token is null then
    dispatch_token := replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', '');

    perform vault.create_secret(
      dispatch_token,
      'owner_daily_report_dispatch_token',
      'Bearer token used only by Supabase Cron to invoke the CRM report dispatcher'
    );
  end if;

  insert into public.clinic_report_dispatch_auth (
    singleton,
    token_hash,
    updated_at
  ) values (
    true,
    encode(extensions.digest(dispatch_token, 'sha256'), 'hex'),
    now()
  )
  on conflict (singleton) do update
    set token_hash = excluded.token_hash,
        updated_at = excluded.updated_at;
end
$migration$;

do $migration$
declare
  existing_job_id bigint;
begin
  select jobid
    into existing_job_id
  from cron.job
  where jobname = 'owner-daily-report-dispatch'
  limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'owner-daily-report-dispatch',
    '*/10 * * * *',
    $cron$
      select net.http_post(
        url := 'https://docpug-crm.onrender.com/api/internal/reports/daily-dispatch',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'owner_daily_report_dispatch_token'
            limit 1
          )
        ),
        body := jsonb_build_object('source', 'supabase-cron'),
        timeout_milliseconds := 15000
      );
    $cron$
  );
end
$migration$;

comment on table public.clinic_report_deliveries is
  'Idempotency and delivery history for automatic owner reports.';

comment on table public.clinic_report_dispatch_auth is
  'SHA-256 hash of the private Supabase Cron dispatcher token.';
