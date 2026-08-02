begin;

alter table public.audit_events
  enable row level security;

revoke all privileges
  on table public.audit_events
  from public, anon, authenticated, service_role;

grant select, insert
  on table public.audit_events
  to service_role;

comment on table public.audit_events is
  'Append-only CRM audit log. Direct browser access is denied; trusted backend service_role may select and insert.';

commit;
