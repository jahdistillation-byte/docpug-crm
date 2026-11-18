begin;

alter table public.clinic_report_settings
  add column branch_id uuid,
  drop constraint clinic_report_settings_pkey,
  add constraint clinic_report_settings_scope_key unique nulls not distinct (org_id, branch_id),
  add constraint clinic_report_settings_branch_fk
    foreign key (org_id, branch_id) references public.branches(org_id, id) on delete cascade;

alter table public.clinic_report_deliveries
  add column branch_id uuid,
  drop constraint clinic_report_deliveries_org_id_report_date_channel_key,
  add constraint clinic_report_deliveries_scope_key
    unique nulls not distinct (org_id, branch_id, report_date, channel),
  add constraint clinic_report_deliveries_branch_fk
    foreign key (org_id, branch_id) references public.branches(org_id, id) on delete cascade;

alter table public.finance_transactions
  add column branch_id uuid,
  add constraint finance_transactions_branch_fk
    foreign key (org_id, branch_id) references public.branches(org_id, id);

create function public.get_branch_daily_report_finance(
  p_org_id uuid, p_branch_id uuid, p_start timestamptz, p_end timestamptz, p_currency text
) returns jsonb language sql stable set search_path = public, pg_temp
as $$
  with scoped as (
    select t.transaction_type, t.amount, t.visit_id
    from public.finance_transactions t
    left join public.visits v on v.org_id = t.org_id and v.id = t.visit_id
    left join public.stock_purchases p on p.org_id = t.org_id and p.id = t.stock_purchase_id
    left join public.finance_transactions original on original.org_id = t.org_id
      and original.id = t.reverses_transaction_id
    where t.org_id = p_org_id and t.currency = p_currency and t.status = 'completed'
      and t.occurred_at >= p_start and t.occurred_at < p_end
      and coalesce(v.branch_id, p.branch_id, t.branch_id, original.branch_id) = p_branch_id
  )
  select jsonb_build_object(
    'payments', coalesce(sum(amount) filter (where transaction_type in ('payment', 'income')), 0),
    'refunds', coalesce(sum(amount) filter (where transaction_type = 'refund'), 0),
    'expenses', coalesce(sum(amount) filter (where transaction_type = 'expense'), 0),
    'average_check', coalesce(
      sum(amount) filter (where transaction_type = 'payment' and visit_id is not null)
        / nullif(count(distinct visit_id) filter (where transaction_type = 'payment'), 0), 0)
  ) from scoped;
$$;

revoke all on function public.get_branch_daily_report_finance(uuid,uuid,timestamptz,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.get_branch_daily_report_finance(uuid,uuid,timestamptz,timestamptz,text)
  to service_role;

commit;
