-- Finance is accessed only through server.py with the service-role key.
-- Keep invoice source rows and financial operations out of the public Data API.

begin;

do $migration$
declare
  server_only_table text;
begin
  foreach server_only_table in array array[
    'visits',
    'visit_services',
    'visit_stock',
    'finance_transactions',
    'financial_accounts',
    'cash_shifts'
  ]
  loop
    if to_regclass(
      format('%I.%I', 'public', server_only_table)
    ) is not null then
      execute format(
        'alter table %I.%I enable row level security',
        'public',
        server_only_table
      );

      execute format(
        'revoke all privileges on table %I.%I from public, anon, authenticated',
        'public',
        server_only_table
      );

      execute format(
        'grant all privileges on table %I.%I to service_role',
        'public',
        server_only_table
      );
    end if;
  end loop;
end
$migration$;

do $migration$
declare
  server_only_function text;
begin
  foreach server_only_function in array array[
    'public.register_visit_payment(uuid,uuid,uuid,numeric,text,text)',
    'public.cancel_visit_payment(uuid,uuid,uuid,text)',
    'public.refund_visit_payment(uuid,uuid,uuid,numeric,text,text)',
    'public.edit_manual_expense(uuid,uuid,uuid,numeric,text,text,timestamp with time zone,text,text,text)'
  ]
  loop
    if to_regprocedure(server_only_function) is not null then
      execute format(
        'revoke all privileges on function %s from public, anon, authenticated',
        server_only_function
      );

      execute format(
        'grant execute on function %s to service_role',
        server_only_function
      );
    end if;
  end loop;
end
$migration$;

commit;
