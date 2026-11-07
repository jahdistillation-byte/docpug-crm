import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export async function runHospitalBillingDbTests(connectionString,pg){
 const url=new URL(connectionString);assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.startsWith('/pug_hospital_test'));
 const root=fileURLToPath(new URL('../',import.meta.url));const c=new pg.Client({connectionString});await c.connect();
 const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');let k=100;
 const org=id(1),other=id(2),user=id(3),staff=id(4),h=id(5),service=id(6),stock=id(7);const key=()=>id(++k);
 const command=(action,task,payload,opts={})=>(opts.client||c).query('select hospital_task_command($1,$2,$3,$4,$5,$6,$7) result',[opts.org||org,opts.user||user,action,opts.key||key(),action==='create'?(opts.h||h):null,task,payload]).then(r=>r.rows[0].result);
 const create=(items=[{kind:'service',catalog_id:service,quantity:'1',expected_price:'100.00'},{kind:'stock',catalog_id:stock,quantity:'0.3',expected_price:'7.25'}],opts={})=>command('create',null,{task_type:'procedure',title:'Procedure',instructions:'Instruction',scheduled_at:'2026-11-07T12:00:00Z',currency:'UAH',items},opts);
 const state=()=>c.query('select get_hospital_billing_state($1,$2,$3) result',[org,user,h]).then(r=>r.rows[0].result);
 const actual=async task=>(await state()).items.filter(i=>i.task_id===task).map(i=>({item_id:i.id,quantity:i.quantity}));
 const complete=async(task,opts={})=>command('complete',task,{completed_by:staff,completion_note:'Performed',actual_items:opts.actual||await actual(task)},opts);
 const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
 try{
  await c.query(readFileSync(root+'supabase/tests/fixtures/hospital_billing_live_baseline.sql','utf8'));
  const migration=readFileSync(root+'supabase/migrations/20261107120000_hospital_treatment_billing.sql','utf8');await c.query(migration);await c.query(migration);
  await c.query("insert into orgs(id,name,theme,currency,login_prefix) values($1,'Clinic','white','UAH','one'),($2,'Other','white','UAH','two')",[org,other]);
  await c.query("insert into clinic_users(id,org_id,username,role,is_active,must_change_password) values($1,$2,'vet','vet',true,false)",[user,org]);
  await c.query("insert into staff(id,org_id,name,role,achievements_demo_mode) values($1,$2,'Vet','vet',false)",[staff,org]);
  await c.query("insert into hospitalizations(id,org_id,patient_id,admitted_at) values($1,$2,$3,now())",[h,org,id(20)]);
  await c.query("insert into services(id,org_id,name,price) values($1,$2,'Procedure',100)",[service,org]);
  await c.query("insert into stock(id,org_id,name,unit,price,qty,group_id,category,dosage_form,administration_route,target_species,purchase_price,minimum_qty) values($1,$2,'Material','мл',7.25,0.3,'materials','Other','solution','other','all',3,0)",[stock,org]);
  const requestKey=key();let created=await create(undefined,{key:requestKey});const task=created.task.id;
  assert.equal((await create(undefined,{key:requestKey})).task.id,task);assert.equal((await state()).total,'0.00');assert.equal((await c.query('select qty from stock')).rows[0].qty,'0.3');
  await reject(()=>create([],{key:requestKey}),'23505');
  await c.query('update services set price=999 where id=$1',[service]);await c.query('update stock set price=999 where id=$1',[stock]);
  const completionKey=key(),actualItems=await actual(task);let result=await complete(task,{key:completionKey,actual:actualItems});assert.equal(result.charged_amount,'102.18');
  assert.equal((await state()).total,'102.18');assert.equal((await c.query('select qty from stock')).rows[0].qty,'0.0');
  assert.equal((await complete(task,{key:completionKey,actual:actualItems})).idempotent_replay,true);await reject(()=>complete(task),'55000');
  assert.equal((await c.query('select count(*) from stock_movements')).rows[0].count,'1');
  await reject(()=>c.query('delete from hospital_tasks where id=$1',[task]),'55000');await reject(()=>c.query('update hospital_tasks set title=$1 where id=$2',['Changed',task]),'55000');
  for(const table of ['hospital_treatment_items','hospital_treatment_charges','hospital_treatment_events','stock_movements'])await reject(()=>c.query('delete from '+table),'55000');
  await reject(()=>create([{kind:'service',catalog_id:service,quantity:'1',expected_price:'100'}]),'40001');
  await reject(()=>create([],{org:other}),'42501');
  await c.query("update clinic_users set is_active=false where id=$1",[user]);await reject(()=>create([]),'42501');await c.query('update clinic_users set is_active=true where id=$1',[user]);
  for(const quantity of ['-1','0','NaN','Infinity','0.0000001',true])await reject(()=>create([{kind:'stock',catalog_id:stock,quantity,expected_price:'999'}]),'22023');
  await reject(()=>create([{kind:'service',catalog_id:service,quantity:'0.5',expected_price:'999'}]),'22023');
  const stockLine=()=>[{kind:'stock',catalog_id:stock,quantity:'0.3',expected_price:'999'}];
  let pending=(await create(stockLine())).task.id;await reject(()=>complete(pending),'22023');assert.equal((await c.query('select status from hospital_tasks where id=$1',[pending])).rows[0].status,'planned');
  await c.query('update stock set qty=1 where id=$1',[stock]);
  await c.query("create function fail_hospital_event() returns trigger language plpgsql as $$begin if new.action='complete' then raise exception 'simulated event failure'; end if; return new;end$$;create trigger fail_hospital_event before insert on hospital_treatment_events for each row execute function fail_hospital_event()");
  await reject(()=>complete(pending),'P0001');assert.equal((await c.query('select qty from stock')).rows[0].qty,'1');assert.equal((await state()).charges.length,2);await c.query('drop trigger fail_hospital_event on hospital_treatment_events');
  await reject(()=>complete(pending,{actual:[]}),'40001');
  await c.query("update stock set unit='шт' where id=$1",[stock]);await reject(()=>complete(pending),'40001');await c.query("update stock set unit='мл' where id=$1",[stock]);
  await c.query("update orgs set currency='EUR' where id=$1",[org]);await reject(()=>complete(pending),'40001');await c.query("update orgs set currency='UAH' where id=$1",[org]);
  const cancellation=await command('cancel',pending,{});assert.equal(cancellation.task.status,'cancelled');await reject(()=>complete(pending),'55000');
  pending=(await create(stockLine())).task.id;
  const concurrent=new pg.Client({connectionString});await concurrent.connect();
  try{await c.query('begin');const duplicate=key(),items=await actual(pending);await complete(pending,{key:duplicate,actual:items});const waiting=complete(pending,{key:duplicate,actual:items,client:concurrent});assert.equal(await Promise.race([waiting.then(()=>true),new Promise(r=>setTimeout(()=>r(false),50))]),false);await c.query('commit');assert.equal((await waiting).idempotent_replay,true);}finally{await concurrent.end();}
  // Two different stays compete for the same stock; the second must see the committed balance.
  await c.query('update stock set qty=0.3 where id=$1',[stock]);const h2=id(30);await c.query('insert into hospitalizations(id,org_id,patient_id,admitted_at) values($1,$2,$3,now())',[h2,org,id(31)]);
  const a=(await create(stockLine())).task.id,b=(await create(stockLine(),{h:h2})).task.id;
  const otherState=(await c.query('select get_hospital_billing_state($1,$2,$3) result',[org,user,h2])).rows[0].result;
  const bActual=otherState.items.filter(i=>i.task_id===b).map(i=>({item_id:i.id,quantity:i.quantity}));
  const cc=new pg.Client({connectionString});await cc.connect();try{await c.query('begin');await complete(a);const waiting=complete(b,{client:cc,actual:bActual}).then(()=>null,e=>e);assert.equal(await Promise.race([waiting.then(()=>true),new Promise(r=>setTimeout(()=>r(false),50))]),false);await c.query('commit');assert.equal((await waiting).code,'22023');}finally{await cc.end();}
  await c.query('update hospitalizations set is_active=false where id=$1',[h]);await reject(()=>create([]),'55000');
  const acl=(await c.query("select has_function_privilege('anon','public.hospital_task_command(uuid,uuid,text,uuid,uuid,uuid,jsonb)','execute') anon,has_function_privilege('authenticated','public.hospital_task_command(uuid,uuid,text,uuid,uuid,uuid,jsonb)','execute') authenticated")).rows[0];assert.deepEqual(acl,{anon:false,authenticated:false});
  await c.query('set role service_role');assert.equal((await state()).is_active,false);
  const serviceTask=(await create([],{h:h2})).task.id;
  assert.equal((await command('complete',serviceTask,{completed_by:staff,completion_note:'Done',actual_items:[]})).task.status,'completed');
  const unusedTask=(await create(stockLine(),{h:h2})).task.id;
  const unusedState=(await c.query('select get_hospital_billing_state($1,$2,$3) result',[org,user,h2])).rows[0].result;
  const unusedItems=unusedState.items.filter(i=>i.task_id===unusedTask).map(i=>({item_id:i.id,quantity:'0'}));
  assert.equal((await command('complete',unusedTask,{completed_by:staff,completion_note:'Not used',actual_items:unusedItems})).charged_amount,'0.00');
  assert.equal((await c.query('select qty from stock')).rows[0].qty,'0.0');
  await c.query('reset role');
  console.log('PASS hospital PostgreSQL: inspected live schema, repeat migration, snapshot prices, decimal stock, exact bill, replay/conflict, concurrent completions/stock, cancellation, rollback, unit/currency/actor checks, immutable history and ACL.');
 }finally{await c.end();}
}
