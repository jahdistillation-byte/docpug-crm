/* One hospital stay, shared catalogues, atomic completion and a separate charge sheet. */
function hospitalBillingText(text) {
  const map={
    "Рахунок":["Bill","Rechnung","Rachunek"],"Послуги та матеріали":["Services and materials","Leistungen und Materialien","Usługi i materiały"],
    "Додати позицію":["Add item","Position hinzufügen","Dodaj pozycję"],"Послуги":["Services","Leistungen","Usługi"],"Матеріали":["Materials","Materialien","Materiały"],
    "Оберіть позицію":["Choose item","Position wählen","Wybierz pozycję"],
    "Нічого не знайдено":["No results","Keine Ergebnisse","Brak wyników"],
    "Залишок":["Stock","Bestand","Stan"],
    "Пошук послуги…":["Search services…","Leistungen suchen…","Szukaj usługi…"],
    "Пошук препарату або матеріалу…":["Search medicines or materials…","Medikamente oder Materialien suchen…","Szukaj leku lub materiału…"],
    "Планова вартість":["Estimated cost","Geplante Kosten","Planowany koszt"],"Нараховано":["Charged","Berechnet","Naliczono"],
    "Фактична кількість":["Actual quantity","Tatsächliche Menge","Rzeczywista ilość"],"Підтвердити виконання":["Confirm completion","Durchführung bestätigen","Potwierdź wykonanie"],
    "Нарахувань ще немає":["No charges yet","Noch keine Berechnungen","Brak naliczeń"],"Сума з’явиться після виконання призначень.":["Charges appear after treatments are completed.","Beträge erscheinen nach Durchführung der Maßnahmen.","Kwoty pojawią się po wykonaniu zleceń."],
    "Перевірити результат":["Check result","Ergebnis prüfen","Sprawdź wynik"],"Є незавершений запит":["A request is awaiting confirmation","Eine Anfrage wartet auf Bestätigung","Żądanie oczekuje na potwierdzenie"],
    "Результат не підтверджено. Повторна перевірка не дублює операцію.":["Result unconfirmed. Checking again does not duplicate the operation.","Ergebnis unbestätigt. Erneutes Prüfen dupliziert den Vorgang nicht.","Wynik niepotwierdzony. Ponowne sprawdzenie nie powiela operacji."],
    "Оновити карту":["Refresh stay","Stationskarte aktualisieren","Odśwież kartę"],"Скасувати призначення?":["Cancel treatment?","Maßnahme stornieren?","Anulować zlecenie?"],
    "Матеріали ще не списуються. Вартість буде нарахована після виконання.":["Materials are used and charges added upon completion.","Materialverbrauch und Berechnung erfolgen bei Durchführung.","Materiały i opłaty zostaną rozliczone po wykonaniu."],
    "Вкажіть використану кількість у складських одиницях. Нуль — не використано.":["Enter actual use in inventory units. Zero means unused.","Verbrauch in Lagereinheiten angeben. Null bedeutet nicht verwendet.","Podaj zużycie w jednostkach magazynowych. Zero oznacza brak zużycia."],
    "Нарахування за виконані призначення":["Charges for completed treatments","Berechnung durchgeführter Maßnahmen","Opłaty za wykonane zlecenia"],
    "Перевірте кількість позицій.":["Check item quantities.","Positionsmengen prüfen.","Sprawdź ilości pozycji."],
    "Не вдалося зберегти запит у браузері. Повторіть спробу.":["Could not retain the request in this browser. Try again.","Anfrage konnte im Browser nicht gesichert werden. Erneut versuchen.","Nie udało się zachować żądania w przeglądarce. Spróbuj ponownie."],
    "Операцію збережено. Оновіть карту для перегляду.":["Operation saved. Refresh the stay to view it.","Vorgang gespeichert. Stationskarte zur Ansicht aktualisieren.","Operacja zapisana. Odśwież kartę, aby ją zobaczyć."],
    "Недостатньо даних для відновлення запиту.":["Cannot restore this request.","Anfrage kann nicht wiederhergestellt werden.","Nie można przywrócić żądania."],
  };
  const i={en:0,de:1,pl:2}[getInterfaceLanguage()];return i!==undefined&&map[text]?map[text][i]:hospitalWardText(text);
}

function hospitalBillingNumber(value,scale=6,zero=false,max=1000000n) {
  const text=String(value??'').trim().replace(',','.');
  if(!new RegExp('^(0|[1-9]\\d{0,18})(\\.\\d{1,'+scale+'})?$').test(text))throw Error('Invalid decimal');
  const [whole,fraction='']=text.split('.'),factor=10n**BigInt(scale),units=BigInt(whole)*factor+BigInt(fraction.padEnd(scale,'0'));
  if(units<(zero?0n:1n)||units>max*factor)throw Error('Invalid quantity');
  return {units,text:whole+(fraction?'.'+fraction:''),factor};
}
function hospitalBillingPrice(value) {return hospitalBillingNumber(value,2,true,1000000000n).units;}
function hospitalBillingAmount(item,quantity) {return (hospitalBillingNumber(quantity,6,true).units*hospitalBillingPrice(item.price_snap??item.price)+500000n)/1000000n;}
function hospitalBillingMoney(cents,currency) {
  const parts=new Intl.NumberFormat(getCalendarLocale()).formatToParts(1.1),decimal=parts.find(p=>p.type==='decimal')?.value||'.';
  return (cents/100n).toLocaleString(getCalendarLocale())+decimal+String(cents%100n).padStart(2,'0')+' '+currency;
}
async function hospitalBillingRequest(path,options={}) {
  const response=await fetch(path,{credentials:'include',...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...getOrgHeaders()}});
  const json=await response.json().catch(()=>null);
  if(!response.ok||json?.ok!==true){const error=Error(json?.error||hospitalBillingText('Результат не підтверджено. Повторна перевірка не дублює операцію.'));error.definitive=[400,403,404,409,503].includes(response.status)&&String(json?.code||'').startsWith('HOSPITAL_');throw error;}
  return json.data;
}

async function openHospitalBillingWorkspace(hospitalization) {
  if(!hospitalization?.id)return;
  document.getElementById('hospitalTasksModal')?.remove();
  const overlay=document.createElement('div');overlay.id='hospitalTasksModal';overlay.className='hospitalTasksOverlay hospitalWardOverlay';
  const e=escapeHtml,t=s=>e(hospitalBillingText(s)),icon=hospitalWardIcon;
  const storageKey='pug:hospital-pending:'+JSON.stringify([getOrgHeaders(),typeof state!=='undefined'?state.me?.id:null,hospitalization.id]);
  let busy=false,closed=false,catalog,bill,tasks,staff,tab='tasks',selected=[],draft={},summaryPrices=true;
  const close=async()=>{if(busy)return;closed=true;overlay.remove();restoreFocus();await renderHospitalTab();document.querySelector(`[data-hospital-assignments="${CSS.escape(String(hospitalization.id))}"]`)?.focus({preventScroll:true});};
  const restoreFocus=bindStockDialogKeyboard(overlay,close);
  const shell=()=>{overlay.innerHTML=`<div class="hospitalTasksBackdrop" data-close-hospital-tasks></div><section class="hospitalTasksModal" role="dialog" aria-modal="true" aria-labelledby="hospitalWardDialogTitle"><header class="hospitalTasksHeader"><div><div class="hospitalTasksEyebrow">${t('КАРТА СТАЦІОНАРУ')}</div><h2 id="hospitalWardDialogTitle">${e(hospitalization.patient_name||hospitalBillingText('Пацієнт'))}</h2><p>${e(hospitalization.diagnosis||'—')} · ${e(hospitalization.room||'—')}</p></div><button type="button" class="hospitalTasksClose" data-close-hospital-tasks aria-label="${t('Закрити')}">${icon('close')}</button></header>${hospitalWardPatientDetails(hospitalization)}<div class="hospitalBillingBody"><p role="status">${t('Завантаження призначень…')}</p></div><footer class="hospitalWardDialogFooter"><button class="hospitalWardSecondary" type="button" data-billing-medical>${icon('clipboard')}${t('Медична карта')}</button>${hospitalization.is_active!==false?`<button class="hospitalWardDischarge" type="button" data-billing-discharge>${t('Виписати')}</button>`:''}</footer></section>`;};
  shell();document.body.appendChild(overlay);overlay.querySelector('.hospitalTasksClose').focus({preventScroll:true});
  overlay.addEventListener('click',async event=>{
    if(event.target.closest('[data-close-hospital-tasks]'))void close();
    if(busy)return;
    if(event.target.closest('[data-billing-medical]')){await close();openPatient(hospitalization.patient_id);}
    const discharge=event.target.closest('[data-billing-discharge]');if(discharge)await hospitalWardDischarge(hospitalization,discharge,close);
  });
  const body=()=>overlay.querySelector('.hospitalBillingBody');
  function pending(){const saved=sessionStorage.getItem(storageKey);return saved?JSON.parse(saved):null;}
  function clearPending(record){if(pending()?.payload?.idempotency_key===record.payload.idempotency_key)sessionStorage.removeItem(storageKey);}
  function errorPanel(message,buttonText='Оновити карту',handler=load){body().innerHTML=`<div class="hospitalBillingNotice" role="alert"><p>${e(message)}</p><button class="hospitalWardSecondary" type="button">${t(buttonText)}</button></div>`;body().querySelector('button').addEventListener('click',handler);body().querySelector('button').focus({preventScroll:true});}
  async function submit(path,payload){
    if(busy)return;
    const record={path,payload:{...payload,idempotency_key:payload.idempotency_key||stockPaymentRequestKey()}};
    try{sessionStorage.setItem(storageKey,JSON.stringify(record));}catch{errorPanel(hospitalBillingText('Не вдалося зберегти запит у браузері. Повторіть спробу.'));return;}
    await send(record);
  }
  async function send(record){
    if(busy)return;busy=true;body().inert=true;body().setAttribute('aria-busy','true');
    try{
      if(!record.path?.startsWith('/api/hospital')||!record.payload?.idempotency_key)throw Object.assign(Error(hospitalBillingText('Недостатньо даних для відновлення запиту.')),{definitive:true});
      await hospitalBillingRequest(record.path,{method:record.path.endsWith('/complete')||record.path.endsWith('/tasks')?'POST':'DELETE',body:JSON.stringify(record.payload)});
      clearPending(record);busy=false;body().inert=false;await load();
    }catch(error){
      busy=false;body().inert=false;body().removeAttribute('aria-busy');
      if(error.definitive){clearPending(record);errorPanel(error.message);}
      else errorPanel(hospitalBillingText('Результат не підтверджено. Повторна перевірка не дублює операцію.'),'Перевірити результат',()=>send(record));
    }
  }
  async function load(){
    if(closed||!overlay.isConnected)return;
    let record;try{record=pending();}catch{errorPanel(hospitalBillingText('Недостатньо даних для відновлення запиту.'));return;}
    if(record){errorPanel(hospitalBillingText('Є незавершений запит'),'Перевірити результат',()=>send(record));return;}
    try{
      [tasks,staff,catalog,bill]=await Promise.all([
        hospitalWardRead(`/api/hospitalizations/${encodeURIComponent(hospitalization.id)}/tasks`),loadStaffApi(),
        hospitalBillingRequest(`/api/hospitalizations/${encodeURIComponent(hospitalization.id)}/catalog`),
        hospitalBillingRequest(`/api/hospitalizations/${encodeURIComponent(hospitalization.id)}/billing`),
      ]);
      if(closed||!overlay.isConnected)return;
      if(!Array.isArray(bill.items)||!Array.isArray(bill.charges))throw Error(hospitalBillingText('Не вдалося завантажити призначення'));
      tasks=tasks.map(task=>({...task,items:bill.items.filter(i=>i.task_id===task.id)}));staff=(Array.isArray(staff)?staff:[]).filter(s=>s.is_active!==false);
      selected=[];draft={};render();
    }catch(error){if(!closed)errorPanel(error.message||hospitalBillingText('Не вдалося завантажити призначення'));}
  }
  function currency(){return bill.currency;}
  function captureDraft(){const form=body().querySelector('#hospitalTaskCreateForm');if(form)draft=Object.fromEntries(['type','title','instructions','scheduled'].map(name=>[name,form.elements.namedItem(name).value]));}
  function tabs(){return `<div class="hospitalBillingTabs" role="tablist" aria-label="${t('КАРТА СТАЦІОНАРУ')}">${[['tasks','Призначення'],['bill','Рахунок']].map(([id,label])=>`<button id="hospital-billing-tab-${id}" type="button" role="tab" aria-controls="hospital-billing-panel" aria-selected="${tab===id}" data-billing-tab="${id}">${t(label)}${id==='bill'?`<span>${e(hospitalBillingMoney(hospitalBillingNumber(bill.total,2,true,1000000000000000000n).units,currency()))}</span>`:''}</button>`).join('')}</div>`;}
  function itemRows(items,quantities=false){return items.map(item=>`<div class="hospitalBillingItem"><div><strong>${e(item.name_snap)}</strong><small>${e(item.quantity)} ${e(item.unit_snap)} · ${e(hospitalBillingMoney(hospitalBillingPrice(item.price_snap),item.currency))}</small></div>${quantities?`<label><span>${t('Фактична кількість')} · ${e(item.unit_snap)}</span><input type="text" inputmode="decimal" data-actual-item="${e(item.id)}" value="${e(item.quantity)}" aria-label="${t('Фактична кількість')} · ${e(item.name_snap)}"></label>`:`<b>${e(hospitalBillingMoney(hospitalBillingAmount(item,item.quantity),item.currency))}</b>`}</div>`).join('');}
  function taskCard(task){
    const actionable=bill.is_active&&['planned','overdue'].includes(task.status);
    const statusText={completed:'Виконано',cancelled:'Скасовано',planned:'Очікує виконання',overdue:'Прострочено'}[task.status]||task.status;
    const displayItems=task.status==='completed'?task.items.map(item=>({...item,quantity:bill.charges.find(c=>c.item_id===item.id)?.quantity||'0'})):task.items;
    return `<article class="hospitalTaskItem"><div class="hospitalTaskIcon">${hospitalWardTaskIcon(task.task_type)}</div><div class="hospitalTaskContent"><div class="hospitalTaskTop"><div><span class="hospitalTaskType">${t(statusText)}</span><h4>${e(task.title)}</h4></div><time>${e(formatHospitalDateTime(task.scheduled_at))}</time></div>${task.instructions?`<p>${e(task.instructions)}</p>`:''}<div class="hospitalBillingItems">${itemRows(displayItems)}</div>${task.status==='completed'?`<p class="hospitalWardResultNote">${e(task.completion_note||'')} ${e(task.completed_by_name||'')} · ${e(formatHospitalDateTime(task.completed_at))}</p>`:''}${actionable?`<div class="hospitalTaskActions"><button type="button" class="hospitalTaskCompleteButton" data-billing-complete="${e(task.id)}">${icon('check')}${t('Виконано')}</button><button type="button" class="hospitalTaskDeleteButton" data-billing-cancel="${e(task.id)}">${t('Скасувати')}</button></div>`:''}</div></article>`;
  }
  function render(){
    body().innerHTML=tabs()+`<div id="hospital-billing-panel" role="tabpanel" aria-labelledby="hospital-billing-tab-${tab}">${tab==='tasks'?`<div class="hospitalTasksLayout"><section class="hospitalTasksTimeline"><div class="hospitalTasksSectionHead"><div><h3>${t('Призначення')}</h3><p>${t('План процедур та догляду')}</p></div><span class="hospitalTasksCount">${tasks.filter(x=>['planned','overdue'].includes(x.status)).length} ${t('активних')}</span></div><div class="hospitalTasksList">${[...tasks].sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at)).map(taskCard).join('')||`<p class="hospitalTasksEmpty">${t('Призначень поки немає')}</p>`}</div></section>${bill.is_active?createForm():''}</div>`:renderBill()}</div>`;
    body().querySelectorAll('[data-billing-tab]').forEach(button=>button.addEventListener('click',()=>{captureDraft();tab=button.dataset.billingTab;render();}));
    body().querySelectorAll('[data-billing-complete]').forEach(b=>b.addEventListener('click',()=>{captureDraft();completionForm(tasks.find(t=>t.id===b.dataset.billingComplete));}));
    body().querySelectorAll('[data-billing-cancel]').forEach(b=>b.addEventListener('click',()=>{
      captureDraft();
      const task=tasks.find(t=>t.id===b.dataset.billingCancel);
      body().innerHTML=`<div class="hospitalBillingNotice"><h3>${t('Скасувати призначення?')}</h3><p>${e(task.title)}</p><div class="hospitalBillingKind"><button type="button" class="hospitalWardSecondary" data-cancel-back>${t('Закрити')}</button><button type="button" class="hospitalWardPrimary" data-cancel-confirm>${t('Скасувати')}</button></div></div>`;
      body().querySelector('[data-cancel-back]').addEventListener('click',render);
      body().querySelector('[data-cancel-confirm]').addEventListener('click',()=>submit(`/api/hospital-tasks/${encodeURIComponent(task.id)}`,{}));
      body().querySelector('[data-cancel-back]').focus({preventScroll:true});
    }));
    bindCreateForm();
    const priceControl=body().querySelector('[data-hospital-show-prices]');
    priceControl?.addEventListener('change',()=>{summaryPrices=priceControl.checked;});
    const pdfButton=body().querySelector('[data-hospital-bill-pdf]');
    pdfButton?.addEventListener('click',async()=>{
      if(pdfButton.disabled)return;
      const original=pdfButton.innerHTML;pdfButton.disabled=true;pdfButton.textContent=hospitalDocumentText('Формування…');
      const includePrices=priceControl?priceControl.checked:summaryPrices;
      if(priceControl)priceControl.disabled=true;
      body().querySelector('.hospitalDocumentError')?.remove();
      try{await downloadHospitalSummaryPdf(hospitalization.id,hospitalization.patient_id,{includePrices});}
      catch(error){const message=document.createElement('p');message.className='hospitalDocumentError';message.setAttribute('role','alert');message.textContent=error.message||getPatientDocumentsUi().createFailed;pdfButton.after(message);}
      finally{pdfButton.disabled=false;pdfButton.innerHTML=original;if(priceControl)priceControl.disabled=false;}
    });
    body().querySelector('[data-billing-tab][aria-selected=true]')?.focus({preventScroll:true});
  }
  function createForm(){const now=new Date(),local=new Date(now-now.getTimezoneOffset()*60000).toISOString().slice(0,16);return `<aside class="hospitalTaskCreateCard"><h3>${t('Нове призначення')}</h3><form id="hospitalTaskCreateForm"><label class="hospitalTaskField"><span>${t('Тип')}</span><select name="type" class="hospitalTaskInput">${[['medication','Препарат'],['infusion','Інфузія'],['feeding','Годування'],['measurement','Вимірювання'],['procedure','Процедура'],['examination','Огляд'],['other','Інше']].map(([key,label])=>`<option value="${key}">${t(label)}</option>`).join('')}</select></label><label class="hospitalTaskField"><span>${t('Назва')}</span><input name="title" class="hospitalTaskInput" maxlength="300" required></label><label class="hospitalTaskField"><span>${t('Дата і час')}</span><input name="scheduled" type="datetime-local" class="hospitalTaskInput" value="${local}" required></label><label class="hospitalTaskField"><span>${t('Інструкція')}</span><textarea name="instructions" class="hospitalTaskTextarea" rows="3" maxlength="5000"></textarea></label><fieldset class="hospitalBillingPicker"><legend>${t('Послуги та матеріали')}</legend><div class="hospitalBillingKind"><button type="button" data-picker-kind="service" aria-pressed="true">${t('Послуги')}</button><button type="button" data-picker-kind="stock" aria-pressed="false">${t('Матеріали')}</button></div><div class="hospitalBillingSearch"><span class="hospitalBillingSearchIcon" aria-hidden="true">${icon('search')}</span><input type="search" class="hospitalTaskInput" data-picker-search role="combobox" aria-autocomplete="list" aria-controls="hospitalCatalogResults" aria-expanded="false" autocomplete="off" spellcheck="false"></div>
      <div class="hospitalCatalogMenu" data-picker-menu hidden>
        <div id="hospitalCatalogResults" class="hospitalCatalogResults" role="listbox" aria-label="${t('Оберіть позицію')}"></div>
        <p class="hospitalCatalogEmpty" role="status" hidden>${t('Нічого не знайдено')}</p>
      </div>
      <button type="button" class="hospitalWardSecondary" data-picker-add disabled>${icon('plus')}${t('Додати позицію')}</button></fieldset><div class="hospitalBillingSelected"></div><div class="hospitalBillingEstimate"><span>${t('Планова вартість')}</span><strong data-plan-total></strong></div><p class="hospitalBillingHelp">${t('Матеріали ще не списуються. Вартість буде нарахована після виконання.')}</p><p class="hospitalBillingValidation" role="alert" hidden></p><button type="submit" class="hospitalTaskCreateButton">${t('Додати призначення')}</button></form></aside>`;}
  function bindCreateForm(){
    const form=body().querySelector('#hospitalTaskCreateForm');if(!form)return;let kind='service';
    for(const [name,value] of Object.entries(draft))form.elements.namedItem(name).value=value;
    const search = form.querySelector('[data-picker-search]');
    const menu = form.querySelector('[data-picker-menu]');
    const results = menu.querySelector('[role="listbox"]');
    const empty = menu.querySelector('[role="status"]');
    const addButton = form.querySelector('[data-picker-add]');
    const kindButtons = form.querySelectorAll('[data-picker-kind]');
    let choice = null;
    let rows = [];
    let activeIndex = -1;

    function updateSearchLabel() {
      const label = hospitalBillingText(kind === 'service' ? 'Пошук послуги…' : 'Пошук препарату або матеріалу…');
      search.placeholder = label;
      search.setAttribute('aria-label', label);
    }

    function highlight(index) {
      results.children[activeIndex]?.setAttribute('aria-selected', 'false');
      activeIndex = index;
      const option = results.children[index];
      if (option) {
        option.setAttribute('aria-selected', 'true');
        search.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({block:'nearest'});
      } else {
        search.removeAttribute('aria-activedescendant');
      }
    }

    function closeChoices() {
      highlight(-1);
      menu.hidden = true;
      search.setAttribute('aria-expanded', 'false');
    }

    function showChoices() {
      highlight(-1);
      const catalogRows = kind === 'service' ? catalog.services : catalog.stock;
      rows = window.pugVisitCatalogSearch(catalogRows, search.value, kind)
        .filter(row => !selected.some(item => item.catalog_id === row.id && item.kind === kind));
      results.innerHTML = rows.map((row, index) => {
        const price = hospitalBillingMoney(hospitalBillingPrice(row.price), catalog.currency);
        const unit = kind === 'stock' ? ' / ' + e(row.unit) : '';
        const balance = kind === 'stock'
          ? `<small>${t('Залишок')} · ${e(row.qty)} ${e(row.unit)}</small>`
          : '';
        return `<div class="hospitalCatalogOption" id="hospitalCatalogOption-${index}"
          role="option" aria-selected="false" data-catalog-index="${index}">
          <span><strong>${e(row.name)}</strong>${balance}</span>
          <span class="hospitalCatalogPrice">${e(price)}${unit}</span>
        </div>`;
      }).join('');
      empty.hidden = rows.length > 0;
      menu.hidden = false;
      results.scrollTop = 0;
      search.setAttribute('aria-expanded', 'true');
    }

    function clearChoice() {
      choice = null;
      addButton.disabled = true;
    }

    function chooseRow(index) {
      const row = rows[index];
      if (!row) return;
      choice = row;
      search.value = row.name;
      addButton.disabled = selected.length >= 50;
      closeChoices();
    }

    kindButtons.forEach(button => button.addEventListener('click', () => {
      if (kind === button.dataset.pickerKind) return;
      kind = button.dataset.pickerKind;
      kindButtons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      search.value = '';
      clearChoice();
      updateSearchLabel();
      if (document.activeElement === search) showChoices();
      else search.focus();
    }));
    search.addEventListener('focus', showChoices);
    search.addEventListener('click', () => { if (menu.hidden) showChoices(); });
    search.addEventListener('input', () => { clearChoice(); showChoices(); });
    search.addEventListener('blur', closeChoices);
    search.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (menu.hidden) showChoices();
        if (!rows.length) return;
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const start = activeIndex === -1 && direction === -1 ? 0 : activeIndex;
        highlight((start + direction + rows.length) % rows.length);
      } else if (event.key === 'Enter' && !menu.hidden) {
        event.preventDefault();
        chooseRow(activeIndex === -1 && rows.length === 1 ? 0 : activeIndex);
      } else if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeChoices();
      }
    });
    results.addEventListener('mousedown', event => {
      if (event.target.closest('[data-catalog-index]')) event.preventDefault();
    });
    results.addEventListener('click', event => {
      const option = event.target.closest('[data-catalog-index]');
      if (option) chooseRow(Number(option.dataset.catalogIndex));
    });
    updateSearchLabel();
    const estimate=()=>{try{let total=0n;for(const item of selected){const input=form.querySelector(`[data-selected-quantity="${CSS.escape(item.id)}"]`);item.quantity=hospitalBillingNumber(input.value).text;if(item.kind==='service'&&hospitalBillingNumber(item.quantity).units%1000000n)throw Error();total+=hospitalBillingAmount(item,item.quantity);}form.querySelector('[data-plan-total]').textContent=hospitalBillingMoney(total,catalog.currency);form.querySelector('[type=submit]').disabled=false;}catch{form.querySelector('[data-plan-total]').textContent='—';form.querySelector('[type=submit]').disabled=true;}};
    const selectedRows=()=>{form.querySelector('.hospitalBillingSelected').innerHTML=selected.map(x=>`<div class="hospitalBillingSelectedItem"><label><strong>${e(x.name)}</strong><span>${t('Кількість')} · ${e(x.unit)}</span><input class="hospitalTaskInput" type="text" inputmode="decimal" data-selected-quantity="${e(x.id)}" value="${e(x.quantity)}"></label><button type="button" class="hospitalTaskDeleteButton" data-remove-item="${e(x.id)}" aria-label="${t('Видалити')} · ${e(x.name)}">${icon('close')}</button></div>`).join('');form.querySelectorAll('[data-selected-quantity]').forEach(input=>input.addEventListener('input',estimate));form.querySelectorAll('[data-remove-item]').forEach(b=>b.addEventListener('click',()=>{selected=selected.filter(x=>x.id!==b.dataset.removeItem);selectedRows();}));estimate();};
    addButton.addEventListener('click', () => {
      if (!choice || selected.length >= 50) return;
      selected.push({
        ...choice, id: stockPaymentRequestKey(), catalog_id: choice.id, kind, quantity: '1',
        unit: kind === 'stock' ? choice.unit : hospitalBillingText('Послуги')
      });
      if (!form.elements.title.value) form.elements.title.value = choice.name;
      search.value = '';
      clearChoice();
      selectedRows();
      if (document.activeElement === search) showChoices();
      else search.focus();
    });
    form.addEventListener('submit',async event=>{event.preventDefault();estimate();if(form.querySelector('[type=submit]').disabled)return;const payload={task_type:form.elements.type.value,title:form.elements.title.value.trim(),instructions:form.elements.instructions.value.trim(),scheduled_at:new Date(form.elements.scheduled.value).toISOString(),currency:catalog.currency,items:selected.map(x=>({kind:x.kind,catalog_id:x.catalog_id,quantity:x.quantity,expected_price:hospitalBillingNumber(x.price,2,true,1000000000n).text}))};await submit(`/api/hospitalizations/${encodeURIComponent(hospitalization.id)}/tasks`,payload);});selectedRows();
  }
  function completionForm(task){
    body().innerHTML=`<div class="hospitalBillingCompletion"><button class="hospitalWardSecondary" type="button" data-complete-back>${icon('chevron')}${t('Призначення')}</button><h3>${e(task.title)}</h3>${task.instructions?`<p>${e(task.instructions)}</p>`:''}<form><div class="hospitalBillingItems">${itemRows(task.items,true)}</div>${task.items.length?`<p class="hospitalBillingHelp">${t('Вкажіть використану кількість у складських одиницях. Нуль — не використано.')}</p>`:''}<label class="hospitalTaskField"><span>${t('Хто виконав')}</span><select name="staff" class="hospitalTaskInput" required><option value="">${t('Оберіть працівника')}</option>${staff.map(x=>`<option value="${e(x.id)}">${e(x.name)}</option>`).join('')}</select></label><label class="hospitalTaskField"><span>${t(task.task_type==='measurement'?'Результат вимірювання':'Примітка')}</span><textarea name="note" class="hospitalTaskTextarea" maxlength="5000" rows="3" ${task.task_type==='measurement'?'required':''}></textarea></label><div class="hospitalBillingEstimate"><span>${t('Нараховано')}</span><strong data-actual-total></strong></div><p class="hospitalBillingValidation" role="alert" hidden>${t('Перевірте кількість позицій.')}</p><button class="hospitalTaskCreateButton" type="submit">${t('Підтвердити виконання')}</button></form></div>`;
    body().querySelector('[data-complete-back]').addEventListener('click',render);const form=body().querySelector('form');
    const values=()=>task.items.map(item=>{const quantity=hospitalBillingNumber(form.querySelector(`[data-actual-item="${CSS.escape(item.id)}"]`).value,6,true);if(item.kind==='service'&&quantity.units%1000000n)throw Error();return {item_id:item.id,quantity:quantity.text};});
    const update=()=>{try{const actual=values();const total=actual.reduce((sum,x,i)=>sum+hospitalBillingAmount(task.items[i],x.quantity),0n);form.querySelector('[data-actual-total]').textContent=hospitalBillingMoney(total,currency());form.querySelector('[type=submit]').disabled=false;form.querySelector('[role=alert]').hidden=true;}catch{form.querySelector('[data-actual-total]').textContent='—';form.querySelector('[type=submit]').disabled=true;form.querySelector('[role=alert]').hidden=false;}};
    form.querySelectorAll('[data-actual-item]').forEach(x=>x.addEventListener('input',update));form.addEventListener('submit',async event=>{event.preventDefault();update();if(form.querySelector('[type=submit]').disabled)return;await submit(`/api/hospital-tasks/${encodeURIComponent(task.id)}/complete`,{completed_by:form.elements.staff.value,completion_note:form.elements.note.value.trim(),actual_items:values()});});update();form.querySelector('input,select')?.focus({preventScroll:true});
  }
  function renderBill(){return `<section class="hospitalBillingSheet"><h3>${t('Нарахування за виконані призначення')}</h3>${bill.charges.length?bill.charges.map(c=>`<article class="hospitalBillingCharge"><div><strong>${e(c.name)}</strong><small>${e(c.quantity)} ${e(c.unit)} × ${e(hospitalBillingMoney(hospitalBillingPrice(c.price),c.currency))} · ${e(formatHospitalDateTime(c.created_at))}</small></div><b>${e(hospitalBillingMoney(hospitalBillingNumber(c.amount,2,true,1000000000000000000n).units,c.currency))}</b></article>`).join(''):`<div class="hospitalBillingBlank"><h3>${t('Нарахувань ще немає')}</h3><p>${t('Сума з’явиться після виконання призначень.')}</p></div>`}<div class="hospitalBillingBillTotal"><span>${t('Разом')}</span><strong>${e(hospitalBillingMoney(hospitalBillingNumber(bill.total,2,true,1000000000000000000n).units,currency()))}</strong></div><div class="hospitalBillPdfAction"><div class="hospitalSummaryExport"><span>${e(hospitalDocumentText('Підсумок стаціонару'))}</span>${hospitalSummaryPriceControl(summaryPrices)}</div><button type="button" class="hospitalWardPrimary" data-hospital-bill-pdf>${icon('clipboard')}${e(hospitalDocumentText('Сформувати PDF'))}</button></div></section>`;}
  await load();
}
