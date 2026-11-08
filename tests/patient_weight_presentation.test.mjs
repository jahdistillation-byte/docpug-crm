import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={window:{}};
vm.runInNewContext(readFileSync(new URL('../patient-overview-workspace.js',import.meta.url),'utf8'),context);
const {sortPugPatientWeights:sort,getPugPatientCurrentWeight:current}=context.window;
test('a late entry of an old measurement does not replace the current measurement',()=>{
 const rows=[{weight_kg:12,measured_at:'2026-08-18T11:00:00Z',created_at:'2026-11-07T12:00:00Z'},{weight_kg:33,measured_at:'2026-10-18T12:00:00Z',created_at:'2026-10-18T12:00:00Z'}];
 assert.equal(current({weight_kg:21},rows),33);
 assert.equal(sort(rows)[0],rows[1]);assert.equal(rows[0].weight_kg,12);
});
test('timestamps use chronological ordering across time zones, with entry time as a tie breaker',()=>{
 const rows=[{weight_kg:5,measured_at:'2026-10-18T12:00:00+03:00',created_at:'2026-10-18T10:00:00Z'},{weight_kg:6,measured_at:'2026-10-18T10:00:00Z',created_at:'2026-10-18T10:00:00Z'},{weight_kg:7,measured_at:'2026-10-18T10:00:00Z',created_at:'2026-10-18T11:00:00Z'}];
 assert.equal(current({},rows),7);
});
test('empty history falls back to the profile; invalid measurements do not become current',()=>{
 assert.equal(current({weight_kg:4.5},[]),4.5);assert.equal(current({},[]),0);
 assert.equal(current({weight_kg:4.5},[{weight_kg:-1},{weight_kg:0},{weight_kg:'invalid'},{weight_kg:501}]),4.5);
 assert.equal(current({},[{weight_kg:'2.35',created_at:'2026-11-08'}]),2.35);
});
