import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
 const calls=[];
 const context={SETTINGS_INTERFACE_TEXT:{},state:{patients:[]},savePatients:()=>{},getOrgHeaders:()=>({}),console,alert:message=>{throw Error(message)},translateInterfaceText:k=>k,calendarErrorMessage:()=> 'request failed',showSettingsMessage:message=>{throw Error(message)},getSettingsSafeErrorText:e=>e.message,fetch:async(url,options)=>{const payload=JSON.parse(options.body);calls.push(payload);return {ok:true,text:async()=>JSON.stringify({ok:true,data:{id:'p1',...payload}})}}};
 vm.createContext(context);vm.runInContext(extract('async function createPatientApi(', 'async function loadPatientWeightsApi(')+extract('async function updatePatientApi(', 'async function savePatientNotesApi('),context);
 return {context,calls};
}
test('creation preserves the chip identifier as text and omits an empty optional value',async()=>{
 const {context,calls}=fixture();await context.createPatientApi({owner_id:'o1',name:'Pet',microchip_number:' 000123456789012 '});assert.equal(calls[0].microchip_number,'000123456789012');
 await context.createPatientApi({owner_id:'o1',name:'Pet'});assert.equal('microchip_number' in calls[1],false);
});
test('editing sends an explicit null to clear the number, while unrelated updates leave it untouched',async()=>{
 const {context,calls}=fixture();await context.updatePatientApi('p1',{microchip_number:' 000123 '});assert.equal(calls[0].microchip_number,'000123');
 await context.updatePatientApi('p1',{microchip_number:''});assert.equal(calls[1].microchip_number,null);
 await context.updatePatientApi('p1',{name:'Changed'});assert.equal('microchip_number' in calls[2],false);
});
