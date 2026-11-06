import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Invoked by a local disposable PostgreSQL runner, never against production.
export async function runSupplierPaymentDbTests(connectionString, pgModule) {
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.pathname.startsWith('/pug_supplier_test'), 'Refusing a non-test database');
  const {Client} = pgModule;
  const root = fileURLToPath(new URL('../',import.meta.url));
  const client = new Client({connectionString});
  await client.connect();
  const extract = (text,name) => {
    const start = text.indexOf('create or replace function public.'+name+'(');
    assert.ok(start>=0,name);
    return text.slice(start,text.indexOf('$function$;',start)+'$function$;'.length);
  };
  const org='00000000-0000-4000-8000-000000000001', foreignOrg='00000000-0000-4000-8000-000000000002';
  const owner='10000000-0000-4000-8000-000000000001', doctor='10000000-0000-4000-8000-000000000002';
  const account='20000000-0000-4000-8000-000000000001', otherAccount='20000000-0000-4000-8000-000000000002';
  const purchase='30000000-0000-4000-8000-000000000001', second='30000000-0000-4000-8000-000000000002';
  let keySequence=1;
  const key=()=>`40000000-0000-4000-8000-${String(keySequence++).padStart(12,'0')}`;
  const pay = (c,{id=purchase,amount='30.00',paid='0.00',total='100.00',acct=account,currency='UAH',requestKey=key(),actor=owner,clinic=org,note=''}={}) =>
    c.query('select public.pay_stock_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result',[clinic,actor,id,acct,amount,paid,total,currency,requestKey,note]).then(r=>r.rows[0].result);
  const state=()=>client.query('select public.get_stock_purchase_payment_state($1,$2,$3) result',[org,owner,purchase]).then(r=>r.rows[0].result);
  const rejected=async(fn,code)=>assert.rejects(fn,error=>error.code===code);
  const reset=async()=>{
    await client.query('truncate stock_supplier_payment_audit,finance_transactions');
    await client.query("update stock_purchases set status='ordered',total_amount=100,paid_amount=0,payment_status='unpaid'");
    await client.query("update financial_accounts set currency='UAH',is_active=true");
    await client.query("insert into finance_transactions(org_id,created_by,transaction_type,accounting_kind,amount,currency,payment_method,financial_account_id,source,status) values($1,$2,'deposit','cash_deposit',1000,'UAH','cash',$3,'manual','completed')",[org,owner,account]);
  };
  try {
    await client.query(readFileSync(root+'supabase/tests/fixtures/supplier_payments_live_baseline.sql','utf8'));
    assert.equal((await client.query("select to_regprocedure('public.assert_finance_actor(uuid,uuid)') actor,to_regclass('public.finance_audit_log') audit")).rows[0].audit,null);
    await client.query("insert into orgs values('ffffffff-ffff-4fff-8fff-ffffffffffff'); insert into clinic_users(id,org_id,username,role) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','ffffffff-ffff-4fff-8fff-ffffffffffff','historic','owner'); insert into financial_accounts(id,org_id,name,account_type,currency) values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','ffffffff-ffff-4fff-8fff-ffffffffffff','Historic','cash','UAH'); insert into finance_transactions(id,org_id,created_by,transaction_type,amount,currency,financial_account_id) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','ffffffff-ffff-4fff-8fff-ffffffffffff','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','deposit',123.45,'UAH','dddddddd-dddd-4ddd-8ddd-dddddddddddd')");
    const historic=(await client.query("select to_jsonb(t) data from finance_transactions t")).rows[0].data;
    await client.query(readFileSync(root+'supabase/migrations/20261106183000_stock_purchase_supplier_payments.sql','utf8'));
    const migrated=(await client.query("select to_jsonb(t)-'accounting_kind'-'stock_purchase_id' data from finance_transactions t")).rows[0].data;
    assert.deepEqual(migrated,historic,'Migration must preserve historical transactions');
    await client.query(readFileSync(root+'supabase/migrations/20261106183000_stock_purchase_supplier_payments.sql','utf8'));
    const balances=readFileSync(root+'supabase/migrations/20260728141927_financial_accounts_balances.sql','utf8');
    await client.query(extract(balances,'get_financial_account_balances'));
    await client.query(extract(balances,'populate_finance_transaction_account'));
    await client.query('create trigger populate_finance_transaction_account_trigger before insert or update of org_id,payment_method,financial_account_id,currency on finance_transactions for each row execute function populate_finance_transaction_account()');
    await client.query('insert into orgs values($1),($2)',[org,foreignOrg]);
    await client.query("insert into clinic_users(id,org_id,username,role,is_active) values($1,$2,'owner','owner',true),($3,$2,'vet','vet',true)",[owner,org,doctor]);
    await client.query("insert into suppliers(id,org_id,name) values('90000000-0000-4000-8000-000000000001',$1,'Test supplier')",[org]);
    await client.query("insert into stock_purchases(id,org_id,supplier_id,purchase_number,currency,total_amount) values($1,$3,'90000000-0000-4000-8000-000000000001','TEST-1','UAH',100),($2,$3,'90000000-0000-4000-8000-000000000001','TEST-2','UAH',100)",[purchase,second,org]);
    await client.query("insert into financial_accounts(id,org_id,name,account_type,system_key,currency) values($1,$3,'Cash','cash','cash','UAH'),($2,$4,'Foreign cash','cash','cash','UAH')",[account,otherAccount,org,foreignOrg]);
    await client.query("insert into stock values('80000000-0000-4000-8000-000000000001',$1,12.3)",[org]);
    await reset();
    const requestKey=key();
    let result=await pay(client,{requestKey,amount:'30.25'});
    assert.equal(result.paid_amount,'30.25'); assert.equal(result.remaining_amount,'69.75');
    assert.equal(result.payment_status,'partial');
    let snapshot=await state();
    assert.equal(snapshot.accounts[0].balance,'969.75'); assert.equal(snapshot.payments.length,1);
    assert.equal((await pay(client,{requestKey,amount:'30.25'})).idempotent_replay,true);
    await rejected(()=>pay(client,{requestKey,amount:'31.00'}),'23505');
    await rejected(()=>pay(client,{id:second,requestKey,amount:'30.25'}),'23505');
    result=await pay(client,{amount:'69.75',paid:'30.25'});
    assert.equal(result.paid_amount,'100.00'); assert.equal(result.remaining_amount,'0.00'); assert.equal(result.payment_status,'paid');
    snapshot=await state(); assert.equal(snapshot.accounts[0].balance,'900.00'); assert.equal(snapshot.payments.length,2);
    const totals=await client.query("select accounting_kind,source,stock_purchase_id from finance_transactions where external_provider='pugcrm-supplier-payment'");
    assert.ok(totals.rows.every(r=>r.accounting_kind==='supplier_payment'&&r.source==='stock'&&r.stock_purchase_id===purchase));
    assert.equal((await client.query('select count(*) from stock_supplier_payment_audit')).rows[0].count,'2');
    await rejected(()=>client.query("delete from stock_supplier_payment_audit"),'55000');
    assert.equal((await client.query('select qty from stock')).rows[0].qty,'12.3');
    assert.equal((await client.query('select status from stock_purchases where id=$1',[purchase])).rows[0].status,'ordered');
    const balance=await client.query('select get_financial_account_balances($1) result',[org]);
    assert.equal(balance.rows[0].result.accounts[0].balance,900);
    await rejected(()=>client.query("update finance_transactions set amount=1 where external_provider='pugcrm-supplier-payment'"),'55000');
    await rejected(()=>client.query("delete from finance_transactions where external_provider='pugcrm-supplier-payment'"),'55000');

    await reset();
    for(const invalid of ['0','-1','NaN','Infinity','0.001','1000000001']) await rejected(()=>pay(client,{amount:invalid}),'22023');
    await rejected(()=>pay(client,{amount:'101'}),'22023');
    await rejected(()=>pay(client,{paid:'1'}),'40001');
    await rejected(()=>pay(client,{total:'90'}),'40001');
    await rejected(()=>pay(client,{actor:doctor}),'42501');
    await rejected(()=>pay(client,{clinic:foreignOrg}),'42501');
    await rejected(()=>pay(client,{acct:otherAccount}),'P0002');
    await rejected(()=>pay(client,{currency:'EUR'}),'22023');
    await client.query("update financial_accounts set currency='EUR' where id=$1",[account]);
    await rejected(()=>pay(client),'22023');
    await reset();
    await client.query("update financial_accounts set is_active=false where id=$1",[account]);
    await rejected(()=>pay(client),'P0002');
    await reset();
    await client.query("update stock_purchases set status='cancelled' where id=$1",[purchase]);
    await rejected(()=>pay(client),'55000');
    await reset();

    await client.query(`create function fail_test_supplier_audit() returns trigger language plpgsql as $$begin if new.action='supplier_payment' then raise exception 'simulated audit failure'; end if; return new; end$$;
      create trigger fail_test_supplier_audit before insert on stock_supplier_payment_audit for each row execute function fail_test_supplier_audit();`);
    await rejected(()=>pay(client),'P0001');
    assert.equal((await state()).purchase.paid_amount,'0.00');
    assert.equal((await client.query("select count(*) from finance_transactions where external_provider='pugcrm-supplier-payment'")).rows[0].count,'0');
    await client.query('drop trigger fail_test_supplier_audit on stock_supplier_payment_audit');

    const first=new Client({connectionString}), concurrent=new Client({connectionString});
    await first.connect();await concurrent.connect();
    try {
      await first.query('begin');
      const duplicateKey=key();
      await pay(first,{amount:'40',requestKey:duplicateKey});
      const duplicate=pay(concurrent,{amount:'40',requestKey:duplicateKey});
      assert.equal(await Promise.race([duplicate.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),50))]),false,'Concurrent replay must wait for the original commit');
      await first.query('commit');
      assert.equal((await duplicate).idempotent_replay,true);
      assert.equal((await state()).purchase.paid_amount,'40.00');
      await reset();
      await first.query('begin');
      await pay(first,{amount:'40'});
      const secondAttempt=pay(concurrent,{amount:'30'}).then(()=>({code:null}),e=>e);
      assert.equal(await Promise.race([secondAttempt.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),50))]),false,'Concurrent payment must wait for the purchase lock');
      await first.query('commit');
      assert.equal((await secondAttempt).code,'40001');
      assert.equal((await state()).purchase.paid_amount,'40.00');
    } finally { await first.end(); await concurrent.end(); }
    const signature='public.pay_stock_purchase(uuid,uuid,uuid,uuid,numeric,numeric,numeric,text,uuid,text)';
    const acl=await client.query("select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') authenticated,has_function_privilege('service_role',$1,'execute') service",[signature]);
    assert.deepEqual(acl.rows[0],{anon:false,authenticated:false,service:true});
    const auditAcl=await client.query("select has_table_privilege('anon','public.stock_supplier_payment_audit','select') anon,has_table_privilege('authenticated','public.stock_supplier_payment_audit','insert') authenticated,has_table_privilege('service_role','public.stock_supplier_payment_audit','update') can_update,has_table_privilege('service_role','public.stock_supplier_payment_audit','delete') can_delete,has_table_privilege('service_role','public.stock_supplier_payment_audit','insert') can_insert");
    assert.deepEqual(auditAcl.rows[0],{anon:false,authenticated:false,can_update:false,can_delete:false,can_insert:true});
    await client.query('set role service_role');
    assert.equal((await state()).purchase.paid_amount,'40.00');
    assert.equal((await pay(client,{amount:'20',paid:'40'})).paid_amount,'60.00');
    await client.query('reset role');
    console.log('PASS PostgreSQL live baseline: installation without Stage 1.1, historical data preserved, repeat installation, partial/full payment, exact decimals, account balances, replay/conflict, stale state, actor/tenant/currency/account checks, rollback, concurrent requests, ledger/audit immutability and ACL.');
  } finally { await client.end(); }
}
