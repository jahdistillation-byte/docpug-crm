create table if not exists public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  created_by uuid references public.clinic_users(id) on delete set null,
  provider text not null,
  status text not null default 'created',
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'UAH',
  provider_invoice_id text,
  page_url text,
  idempotency_key text not null,
  finance_transaction_id uuid references public.finance_transactions(id) on delete set null,
  provider_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_intents_provider_check
    check (provider in ('monobank')),
  constraint payment_intents_status_check
    check (status in (
      'created', 'processing', 'success', 'failure', 'reversed', 'expired'
    )),
  constraint payment_intents_currency_check
    check (currency in ('UAH')),
  constraint payment_intents_idempotency_unique
    unique (org_id, provider, idempotency_key),
  constraint payment_intents_provider_invoice_unique
    unique (provider, provider_invoice_id)
);

create index if not exists payment_intents_visit_created_idx
  on public.payment_intents (org_id, visit_id, created_at desc);

alter table public.payment_intents enable row level security;

revoke all on table public.payment_intents from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_intents to service_role;

comment on table public.payment_intents is
  'Server-only payment provider intents. A finance transaction is created only after provider confirmation.';
