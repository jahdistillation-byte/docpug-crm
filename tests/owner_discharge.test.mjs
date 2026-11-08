import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
async function render({patient={},clinical={},saved={},rx=''}={}) {
 const a4={innerHTML:'',querySelectorAll:()=>[]};
 const pet={id:'p',owner_id:'o',species:'dog',age:4,microchip_number:'000123456789012',...patient};
 const visit={id:'v',pet_id:'p',date:'2026-11-08',clinical_data:clinical,rx};
 const e=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 const context=vm.createContext({document:{getElementById:()=>a4},state:{patients:[pet],staff:[],clinicProfile:{name:'Clinic'}},getVisitByIdSync:()=>visit,getOwnerById:()=>({name:'Owner'}),getDischarge:()=>saved,parseVisitNote:()=>({}),expandServiceLines:()=>[],expandStockLines:()=>[],calcServicesTotal:()=>0,calcStockTotal:()=>0,formatVisitFinanceMoney:x=>String(x),escapeHtml:e});
 vm.runInContext(slice('function normalizeVisitHomeTreatmentItem(','function getVisitHomeTreatmentsText(')+slice('async function renderDischargeA4(','function normalizeJsonArray('),context);
 await context.renderDischargeA4('v');return a4.innerHTML;
}
test('owner prescription labels preserve exact doses without invented units and escape text',async()=>{
 const html=await render({clinical:{home_treatments:[{name:'<script>',dose:'0.5',route:'Перорально',frequency:'2 рази на день',duration:'5 днів'}]}});
 for(const text of ['Доза / кількість','Як застосовувати','Як часто','Тривалість','&lt;script&gt;','<dd>0.5</dd>'])assert.ok(html.includes(text));
 assert.ok(!html.includes('0.5 мг'));
});
test('legacy and performed-care decimal text is never split at decimal points',async()=>{
 const html=await render({rx:'Препарат — 0.5 мл.\nІнший — 1.25 мл.',clinical:{performed_care:'Введено 0.5 мл.'}});
 assert.match(html,/Препарат — 0\.5 мл\./);assert.match(html,/Інший — 1\.25 мл\./);assert.match(html,/Введено 0\.5 мл\./);
});
test('explicit edited discharge instructions take precedence over structured visit data',async()=>{
 const html=await render({saved:{rx:'Виправлено лікарем: 0.25 мл.'},clinical:{home_treatments:[{name:'Old',dose:'0.5 мл'}]}});
 assert.match(html,/Виправлено лікарем: 0\.25 мл\./);assert.doesNotMatch(html,/Old/);
});
test('identity is owner readable and microchip is optional; total is shown once',async()=>{
 let html=await render();assert.match(html,/08\.11\.2026/);assert.match(html,/Собака/);assert.match(html,/4 роки/);assert.match(html,/000123456789012/);assert.doesNotMatch(html,/disModernGrandTotalBadge/);
 html=await render({patient:{age:'',microchip_number:'',birth_date:'2022-03-01'}});assert.doesNotMatch(html,/Номер чипа/);assert.match(html,/Дата народження/);assert.match(html,/01\.03\.2022/);
});
