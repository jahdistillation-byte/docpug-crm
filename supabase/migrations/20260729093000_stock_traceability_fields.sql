alter table public.stock
  add column if not exists expiry_date date,
  add column if not exists batch_number text;

comment on column public.stock.expiry_date is
  'Optional best-before or expiry date used by deterministic stock alerts.';

comment on column public.stock.batch_number is
  'Optional manufacturer batch or lot number.';

alter table public.stock
  drop constraint if exists stock_batch_number_length;

alter table public.stock
  add constraint stock_batch_number_length
  check (
    batch_number is null
    or char_length(trim(batch_number)) between 1 and 120
  );

create index if not exists stock_org_expiry_active_idx
  on public.stock (org_id, expiry_date)
  where active = true and expiry_date is not null;
