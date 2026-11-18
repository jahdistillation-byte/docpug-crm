import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
// Uses an isolated PostgreSQL-compatible instance supplied by the test runner.
export async function runStockBranchWorkflowDbTests(PGlite) {
  const db = new PGlite();
  try {
    const load = path => db.exec(readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
    const migration = name => load('supabase/migrations/' + name + '.sql');
    const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12,'0');
    const [org, other, actor, doctor, stay, stock, b, c, purchase, visit, foreign, oldVisit, oldLine] = Array.from({length:13},(_,i)=>id(i+1));
    const query = async (sql, params=[]) => (await db.query(sql,params)).rows;
    await load('supabase/tests/fixtures/hospital_billing_live_baseline.sql');
    await db.exec(`
      alter table visits add column org_id uuid, add column currency text default 'UAH';
      create table calendar_events(id uuid primary key,org_id uuid);
      create table visit_stock(id uuid primary key default gen_random_uuid(),visit_id uuid,stock_id uuid,qty numeric,price_snap numeric,name_snap text,inventory_synced boolean);
      grant select, insert, delete, update on visits,visit_stock,stock_purchases to service_role;
      create table test_receipts(purchase_id uuid,key text,primary key(purchase_id,key));
      create function receive_stock_purchase(p_org_id uuid,p_purchase_id uuid,p_user_id uuid,p_idempotency_key text,p_items jsonb,p_note text)
      returns jsonb language plpgsql as $$
      declare new_qty numeric; amount numeric := (p_items->0->>'quantity')::numeric;
      begin
        insert into test_receipts values(p_purchase_id,p_idempotency_key) on conflict do nothing;
        if not found then return jsonb_build_object('replay',true); end if;
        update stock set qty=qty+amount where org_id=p_org_id and id=(p_items->0->>'stock_id')::uuid returning qty into new_qty;
        insert into stock_movements(org_id,stock_id,created_by,purchase_id,movement_type,quantity,quantity_before,quantity_after,unit_cost)
        values(p_org_id,(p_items->0->>'stock_id')::uuid,p_user_id,p_purchase_id,'income',amount,new_qty-amount,new_qty,0);
        return jsonb_build_object('ok',true);
      end; $$;
      grant select,insert on test_receipts to service_role;
      create function delete_visit_with_stock_restore(p_org_id uuid,p_visit_id uuid,p_user_id uuid)
      returns jsonb language plpgsql as $$
      declare line record; new_qty numeric;
      begin
        for line in select * from visit_stock where visit_id=p_visit_id and inventory_synced loop
          update stock set qty=qty+line.qty where org_id=p_org_id and id=line.stock_id returning qty into new_qty;
          insert into stock_movements(org_id,stock_id,visit_id,created_by,movement_type,quantity,quantity_before,quantity_after,unit_cost)
          values(p_org_id,line.stock_id,p_visit_id,p_user_id,'income',line.qty,new_qty-line.qty,new_qty,0);
        end loop;
        delete from visit_stock where visit_id=p_visit_id;
        delete from visits where org_id=p_org_id and id=p_visit_id;
        return jsonb_build_object('deleted',true);
      end; $$;
    `);
    await migration('20261107120000_hospital_treatment_billing');
    await migration('20261116120000_clinic_branches');
    await migration('20261116140000_calendar_branches');
    await query("insert into orgs(id,name,theme,currency,login_prefix) values($1,'Clinic','white','UAH','one'),($2,'Other','white','UAH','two')",[org,other]);
    const [{id:a}]=await query('select id from branches where org_id=$1 and is_primary',[org]);
    await query("insert into branches(id,org_id,name) values($1,$3,'B'),($2,$3,'C'),($4,$5,'Foreign')",[b,c,org,foreign,other]);
    await query("insert into clinic_users(id,org_id,username,role,is_active,must_change_password) values($1,$2,'vet','vet',true,false)",[actor,org]);
    await query("insert into staff(id,org_id,name,role,achievements_demo_mode) values($1,$2,'Vet','vet',false)",[doctor,org]);
    await query("insert into stock(id,org_id,name,unit,price,qty,group_id,category,dosage_form,administration_route,target_species,purchase_price,minimum_qty) values($1,$2,'Material','мл',7.25,0,'materials','Other','solution','other','all',3,0)",[stock,org]);
    await query('insert into visits(id,org_id,branch_id) values($1,$3,$4),($2,$3,$4)',[visit,oldVisit,org,b]);
    await query("insert into visit_stock values($1,$2,$3,0.25,7.25,'Legacy',true)",[oldLine,oldVisit,stock]);
    await query('insert into stock_purchases values($1)',[purchase]);
    await migration('20261117190000_stock_branch_balances');
    await migration('20261117193000_stock_branch_workflows');
    await query('insert into hospitalizations(id,org_id,patient_id,admitted_at,branch_id) values($1,$2,$3,now(),$4)',[stay,org,id(15),b]);
    await db.exec('set role service_role');
    const move=(n,from,to,qty)=>query('select record_stock_branch_operation($1,$2,$3,$4,$5,$6,$7)',[org,stock,actor,id(n),from,to,qty]);
    const availability=async () => {
     const rows=await query('select branch_id,quantity from stock_branch_balances where org_id=$1 and stock_id=$2',[org,stock]);
     const map=Object.fromEntries(rows.map(r=>[r.branch_id,Number(r.quantity)]));
     return [map[a]||0,map[b]||0,map[c]||0];
    };
    const receive=(key,branch,qty)=>query('select receive_stock_purchase_at_branch($1,$2,$3,$4,$5,$6,$7) as receipt',[org,purchase,actor,key,JSON.stringify([{stock_id:stock,quantity:qty}]),null,branch]);
    await receive('first',a,10); await receive('first',a,10);
    await assert.rejects(receive('first',b,10),/STOCK_BRANCH_OPERATION_CONFLICT/);
    await assert.rejects(receive('foreign',foreign,1),/STOCK_BRANCH_INVALID_BRANCH/);
    await move(31,a,b,4);
    const addVisit=(qty,key=null)=>query('select add_branch_visit_stock($1,$2,$3,$4,$5,$6,$7) result',[org,visit,stock,actor,qty,null,key]);
    const [{result:{line}}]=await addVisit(1,id(32));
    const [replay]=await addVisit(1,id(32));
    assert.equal(replay.result.line.id,line.id);
    assert.equal(replay.result.replayed,true);
    await assert.rejects(addVisit(2,id(32)),/STOCK_BRANCH_OPERATION_CONFLICT/);
    assert.equal(line.inventory_branch_id,b);
    await assert.rejects(addVisit(4),/STOCK_BRANCH_INSUFFICIENT/);
    assert.deepEqual(await availability(),[6,3,0]);
    const remove=(visit,line,qty)=>query('select remove_branch_visit_stock($1,$2,$3,$4,$5,$6)',[org,visit,line,actor,qty,7.25]);
    await remove(visit,line.id,1);
    assert.deepEqual(await availability(),[6,4,0]);
    await remove(oldVisit,oldLine,.25);
    assert.deepEqual(await availability(),[6.25,4,0]);
    await db.exec(`reset role;
      create function reject_test_visit_movement() returns trigger language plpgsql as $$
      begin
        if new.visit_id is not null and new.movement_type='writeoff' then raise exception 'simulated movement failure'; end if;
        return new;
      end; $$;
      create trigger reject_test_visit_movement before insert on stock_movements
      for each row execute function reject_test_visit_movement();
      set role service_role;`);
    await assert.rejects(addVisit(.5), /simulated movement failure/);
    assert.deepEqual(await availability(), [6.25, 4, 0]);
    assert.equal((await query('select count(*)::int as count from visit_stock where visit_id=$1', [visit]))[0].count, 0);
    await db.exec('reset role; drop trigger reject_test_visit_movement on stock_movements; set role service_role');
    await addVisit(.5);
    await query('select delete_visit_with_branch_stock_restore($1,$2,$3)',[org,visit,actor]);
    assert.deepEqual(await availability(),[6.25,4,0]);

    const command=(action,task,payload,n)=>query('select hospital_task_command($1,$2,$3,$4,$5,$6,$7) result',[org,actor,action,id(n),action==='create'?stay:null,task,JSON.stringify(payload)]).then(rows=>rows[0].result);
    const plan=async (qty,n)=>command('create',null,{task_type:'procedure',title:'Procedure',scheduled_at:'2026-11-18T12:00:00Z',currency:'UAH',items:[{kind:'stock',catalog_id:stock,quantity:qty,expected_price:'7.25'}]},n);
    const actual=async task=>(await query('select id,quantity from hospital_treatment_items where task_id=$1',[task])).map(i=>({item_id:i.id,quantity:i.quantity}));
    const task=(await plan('1',40)).task.id;
    const completion={completed_by:doctor,actual_items:await actual(task)};
    await command('complete',task,completion,41);
    assert.equal((await command('complete',task,completion,41)).idempotent_replay,true);
    assert.deepEqual(await availability(),[6.25,3,0]);
    const tooMuch=(await plan('4',42)).task.id;
    await assert.rejects(command('complete',tooMuch,{completed_by:doctor,actual_items:await actual(tooMuch)},43),/STOCK_BRANCH_INSUFFICIENT/);
    assert.equal((await query('select status from hospital_tasks where id=$1',[tooMuch]))[0].status,'planned');
    await command('cancel',tooMuch,{},44);
    await receive('next',c,.5);
    assert.deepEqual(await availability(),[6.25,3,.5]);
    const histories=await query('select branch_id,quantity_before,quantity_after,hospital_task_id,visit_id,purchase_id from stock_movements order by created_at');
    assert.ok(histories.some(x=>x.hospital_task_id===task&&x.branch_id===b&&Number(x.quantity_before)===4&&Number(x.quantity_after)===3));
    assert.ok(histories.some(x=>x.purchase_id===purchase&&x.branch_id===c));
    assert.equal(Number((await query('select qty from stock where id=$1',[stock]))[0].qty),9.75);
    console.log('PASS branch stock: receiving, transfers, visit and ward deductions, returns, replay, rollback and history.');
  } finally {
    await db.close();
  }
}
