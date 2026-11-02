create index if not exists payment_intents_visit_idx
  on public.payment_intents (visit_id);

create index if not exists payment_intents_created_by_idx
  on public.payment_intents (created_by);

create index if not exists payment_intents_finance_transaction_idx
  on public.payment_intents (finance_transaction_id);

create policy payment_intents_deny_direct_access
  on public.payment_intents
  for all
  to anon, authenticated
  using (false)
  with check (false);
