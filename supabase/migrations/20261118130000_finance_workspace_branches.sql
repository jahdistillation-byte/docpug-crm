begin;

-- Resolve the ledger scope from the source document, then from a manual
-- assignment. A reversal inherits its original operation's scope.
create view public.finance_transaction_branch_scope
with (security_invoker = true) as
select entry.*,
  coalesce(visit.branch_id, purchase.branch_id, entry.branch_id,
           original_visit.branch_id, original_purchase.branch_id, original.branch_id) as effective_branch_id
from public.finance_transactions entry
left join public.visits visit on visit.id = entry.visit_id and visit.org_id = entry.org_id
left join public.stock_purchases purchase on purchase.id = entry.stock_purchase_id and purchase.org_id = entry.org_id
left join public.finance_transactions original on original.id = entry.reverses_transaction_id and original.org_id = entry.org_id
left join public.visits original_visit on original_visit.id = original.visit_id and original_visit.org_id = entry.org_id
left join public.stock_purchases original_purchase on original_purchase.id = original.stock_purchase_id and original_purchase.org_id = entry.org_id;

revoke all on public.finance_transaction_branch_scope from public, anon, authenticated;
grant select on public.finance_transaction_branch_scope to service_role;

-- Keep the organization RPCs for existing callers. Derive branch variants from
-- the same ledger formulas and abort if the expected query sources have changed.
do $migration$
declare
  report record;
  original text;
  scoped text;
  source_name text;
  source_count integer;
  expected_count integer;
  replacement text;
begin
  for report in select * from (values
    ('get_finance_overview_currency', 'uuid,date,date,text', 'uuid,uuid,date,date,text', 2, 1, 1, 1),
    ('get_finance_expenses_overview_currency', 'uuid,date,date,text', 'uuid,uuid,date,date,text', 1, 0, 0, 0),
    ('get_financial_account_balances', 'uuid', 'uuid,uuid', 1, 0, 0, 0)
  ) as r(name, old_args, new_args, ledger_count, visits_count, stock_count, purchases_count)
  loop
    original := pg_get_functiondef(to_regprocedure(format('public.%I(%s)', report.name, report.old_args)));
    if original is null or strpos(original, format('FUNCTION public.%I(p_org_id uuid', report.name)) = 0 then
      raise exception 'Missing supported finance function %', report.name;
    end if;

    scoped := replace(original, format('FUNCTION public.%I(p_org_id uuid', report.name),
                       format('FUNCTION public.%I(p_org_id uuid, p_branch_id uuid', report.name || '_by_branch'));

    for source_name, expected_count in select * from (values
      ('finance_transactions', report.ledger_count),
      ('visits', report.visits_count),
      ('stock_movements', report.stock_count),
      ('stock_purchases', report.purchases_count)
    ) as sources(name, expected)
    loop
      -- Boundaries matter: do not replace references to unrelated names with
      -- a shared prefix or unverified syntax.
      select count(*) into source_count from regexp_matches(
        scoped, '(from|join)[[:space:]]+public\.' || source_name || '\M', 'gi');
      if source_count <> expected_count then
        raise exception 'Unexpected finance source % in %: expected %, got %',
          source_name, report.name, expected_count, source_count;
      end if;
      if source_name = 'finance_transactions' then
        replacement := '(select * from public.finance_transaction_branch_scope where org_id = p_org_id and effective_branch_id = p_branch_id)';
      else
        replacement := format('(select * from public.%I where org_id = p_org_id and branch_id = p_branch_id)', source_name);
      end if;
      -- PostgreSQL permits a derived table without an alias from v16 onward.
      -- Add the original table name only when the source has no existing alias.
      scoped := regexp_replace(scoped,
        '((?:from|join)[[:space:]]+)public\.' || source_name || '\M(?=[[:space:]]+(?:where|group|order|having|limit|on|join|left|right|inner|full|cross|union)\M|[[:space:]]*[);])',
        '\1' || replacement || ' as ' || source_name, 'gi');
      scoped := regexp_replace(scoped, '((?:from|join)[[:space:]]+)public\.' || source_name || '\M',
                               '\1' || replacement, 'gi');
    end loop;
    execute scoped;
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated',
                   report.name || '_by_branch', report.new_args);
    execute format('grant execute on function public.%I(%s) to service_role',
                   report.name || '_by_branch', report.new_args);
  end loop;
end;
$migration$;

commit;
