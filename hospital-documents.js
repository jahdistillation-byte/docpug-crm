/* One read-only hospital summary, with optional saved charges. */
function hospitalDocumentText(source) {
  const translations={
    "Підсумок стаціонару":["Hospital stay summary","Zusammenfassung des stationären Aufenthalts","Podsumowanie pobytu"],
    "Лікування, результати, рекомендації та вартість в одному документі.":["Treatment, results, recommendations and charges in one document.","Behandlung, Ergebnisse, Empfehlungen und Kosten in einem Dokument.","Leczenie, wyniki, zalecenia i koszty w jednym dokumencie."],
    "Показати вартість":["Include charges","Kosten anzeigen","Pokaż koszty"],
    "Немає госпіталізацій для формування підсумку.":["No hospital stays available for a summary.","Keine stationären Aufenthalte für eine Zusammenfassung vorhanden.","Brak pobytów do podsumowania."],
    "Діагноз":["Diagnosis","Diagnose","Rozpoznanie"],
    "Стан пацієнта":["Patient condition","Patientenzustand","Stan pacjenta"],
    "Виконані призначення":["Completed treatments","Durchgeführte Maßnahmen","Wykonane zlecenia"],
    "Виконані призначення не зафіксовані.":["No completed treatments have been recorded.","Keine durchgeführten Maßnahmen erfasst.","Brak zapisanych wykonanych zleceń."],
    "Результат / примітка":["Result / note","Ergebnis / Notiz","Wynik / uwaga"],
    "Дані підсумку не узгоджені. Оновіть карту та повторіть спробу.":["Summary data is inconsistent. Refresh the stay and try again.","Zusammenfassungsdaten sind nicht konsistent. Stationskarte aktualisieren und erneut versuchen.","Dane podsumowania są niespójne. Odśwież kartę i spróbuj ponownie."],
    "Рекомендації власнику":["Recommendations for the owner","Empfehlungen für den Tierhalter","Zalecenia dla opiekuna"],
    "Примітки":["Notes","Notizen","Uwagi"],
    "Рахунок стаціонару":["Hospital bill","Stationäre Rechnung","Rachunek za pobyt"],
    "Послуги та матеріали за виконаними призначеннями. Доступно під час лікування та після виписки.":["Services and materials from completed treatments. Available during the stay and after discharge.","Leistungen und Materialien durchgeführter Maßnahmen. Während des Aufenthalts und nach der Entlassung verfügbar.","Usługi i materiały z wykonanych zleceń. Dostępne podczas pobytu i po wypisie."],
    "Немає госпіталізацій для формування рахунку.":["No hospital stays available for a bill.","Keine stationären Aufenthalte für eine Rechnung vorhanden.","Brak pobytów, dla których można utworzyć rachunek."],
    "Триває":["Ongoing","Laufend","W trakcie"],"Виписано":["Discharged","Entlassen","Wypisano"],
    "госпіталізацій":["hospital stays","Aufenthalte","pobytów"],
    "Не вдалося завантажити госпіталізації.":["Could not load hospital stays.","Stationäre Aufenthalte konnten nicht geladen werden.","Nie udało się wczytać pobytów."],
    "Дані рахунку не узгоджені. Оновіть карту та повторіть спробу.":["Bill data is inconsistent. Refresh the stay and try again.","Rechnungsdaten sind nicht konsistent. Stationskarte aktualisieren und erneut versuchen.","Dane rachunku są niespójne. Odśwież kartę i spróbuj ponownie."],
    "Госпіталізація не відповідає пацієнту.":["Hospital stay does not match the patient.","Aufenthalt gehört nicht zu diesem Patienten.","Pobyt nie dotyczy tego pacjenta."],
    "Клініку змінено. Відкрийте документ повторно.":["Clinic changed. Open the document again.","Klinik gewechselt. Dokument erneut öffnen.","Zmieniono klinikę. Otwórz dokument ponownie."],
    "Зачекайте завершення формування попереднього PDF.":["Wait for the previous PDF to finish.","Warten Sie, bis die vorherige PDF fertig ist.","Poczekaj na zakończenie tworzenia poprzedniego PDF."],
    "Дата формування":["Generated on","Erstellt am","Data utworzenia"],
    "Найменування":["Item","Position","Pozycja"],"Кількість":["Quantity","Menge","Ilość"],
    "Ціна":["Unit price","Einzelpreis","Cena jednostkowa"],"Сума":["Amount","Betrag","Kwota"],
    "Всього нараховано":["Total charges","Gesamtbetrag","Łączna kwota"],
    "Нарахувань за виконані призначення ще немає.":["There are no charges for completed treatments yet.","Noch keine Beträge für durchgeführte Maßnahmen vorhanden.","Brak naliczeń za wykonane zlecenia."],
    "Документ відображає нарахування станом на дату формування та не підтверджує оплату.":["This document shows charges as of its generation date and does not confirm payment.","Dieses Dokument zeigt die Beträge zum Erstellungsdatum und bestätigt keine Zahlung.","Dokument przedstawia naliczenia na dzień utworzenia i nie potwierdza zapłaty."],
    "Період госпіталізації":["Hospital stay","Aufenthaltszeitraum","Okres pobytu"],
    "Сформувати PDF":["Generate PDF","PDF erstellen","Utwórz PDF"],
    "Формування…":["Generating…","Wird erstellt…","Generowanie…"],
    "Послуга":["Service","Leistung","Usługa"],"Матеріал":["Material","Material","Materiał"],
  };
  const index={en:0,de:1,pl:2}[getInterfaceLanguage()];
  return index!==undefined&&translations[source]?translations[source][index]:hospitalBillingText(source);
}

function hospitalSummaryDocumentOptions(hospitalizations) {
  return [...hospitalizations].sort((a,b)=>String(b.admitted_at||'').localeCompare(String(a.admitted_at||''))).map(h=>({value:h.id,
    label:`${formatPatientDocumentDate(h.admitted_at)} — ${h.discharged_at?formatPatientDocumentDate(h.discharged_at):hospitalDocumentText(h.is_active===false?'Виписано':'Триває')}${h.diagnosis?' · '+h.diagnosis:''}`}));
}

function hospitalSummaryPriceControl(checked=true) {
  return `<label class="hospitalDocumentPriceToggle"><input type="checkbox" data-hospital-show-prices ${checked?'checked':''}><span>${escapeHtml(hospitalDocumentText('Показати вартість'))}</span></label>`;
}

function renderHospitalSummaryDocumentCard(hospitalizations) {
  const ui=getPatientDocumentsUi();
  return renderPatientDocumentCard({type:'hospital-summary',icon:hospitalWardIcon('bed'),title:hospitalDocumentText('Підсумок стаціонару'),
    description:hospitalDocumentText('Лікування, результати, рекомендації та вартість в одному документі.'),
    badge:ui.hospitalBadge,options:hospitalSummaryDocumentOptions(hospitalizations),selectLabel:ui.selectHospital,
    emptyText:hospitalDocumentText('Немає госпіталізацій для формування підсумку.'),controls:hospitalSummaryPriceControl()});
}

function hospitalDocumentQuantity(value) {
  const [whole,fraction='']=hospitalBillingNumber(value).text.split('.');
  const decimal=new Intl.NumberFormat(getCalendarLocale()).formatToParts(1.1).find(p=>p.type==='decimal')?.value||'.';
  const tail=fraction.replace(/0+$/,'');
  return BigInt(whole).toLocaleString(getCalendarLocale())+(tail?decimal+tail:'');
}

function renderHospitalSummaryDocumentHtml({hospitalization,tasks,bill=null,clinic,includePrices=true,generatedAt=new Date()}) {
  const e=escapeHtml,t=s=>e(hospitalDocumentText(s));
  const invalid=()=>{throw Error(hospitalDocumentText('Дані підсумку не узгоджені. Оновіть карту та повторіть спробу.'));};
  if(!Array.isArray(tasks)||tasks.some(task=>String(task.hospitalization_id)!==String(hospitalization.id)))invalid();
  let financialContent='';
  if(includePrices){
  if(!bill||String(bill.hospitalization_id)!==String(hospitalization.id)||!Array.isArray(bill.charges))invalid();
  const total=hospitalBillingNumber(bill.total,2,true,1000000000000000000n).units;
  let sum=0n;
  const rows=bill.charges.map(c=>{
    if(c.currency!==bill.currency||!['stock','service'].includes(c.kind))invalid();
    const quantity=hospitalBillingNumber(c.quantity).text,price=hospitalBillingPrice(c.price);
    const amount=hospitalBillingNumber(c.amount,2,true,1000000000000000000n).units;
    if(hospitalBillingAmount({price_snap:c.price},quantity)!==amount)invalid();
    sum+=amount;
    return `<tr><td><strong>${e(c.name)}</strong><small>${t(c.kind==='service'?'Послуга':'Матеріал')} · ${e(formatPatientDocumentDate(c.created_at,true))}</small></td><td>${e(hospitalDocumentQuantity(quantity))} ${e(c.unit)}</td><td>${e(hospitalBillingMoney(price,bill.currency))}</td><td>${e(hospitalBillingMoney(amount,bill.currency))}</td></tr>`;
  }).join('');
  if(sum!==total)invalid();
  financialContent=`<div class="disModernTableWrap hospitalBillTableWrap"><table class="disModernTable hospitalBillTable"><colgroup><col style="width:44%"><col style="width:16%"><col style="width:20%"><col style="width:20%"></colgroup><thead><tr><th>${t('Найменування')}</th><th>${t('Кількість')}</th><th>${t('Ціна')}</th><th>${t('Сума')}</th></tr></thead><tbody>${rows||`<tr><td colspan="4">${t('Нарахувань за виконані призначення ще немає.')}</td></tr>`}</tbody></table></div>
    <div class="disModernFinanceSummary hospitalBillTotal"><span>${t('Всього нараховано')}</span><strong>${e(hospitalBillingMoney(total,bill.currency))}</strong></div>
    <section class="disModernSection hospitalBillDisclaimer"><p>${t('Документ відображає нарахування станом на дату формування та не підтверджує оплату.')}</p></section>`;
  }
  const section=(title,value)=>value?`<section class="disModernSection hospitalSummarySection"><h3>${t(title)}</h3><p>${e(value)}</p></section>`:'';
  const period=`${formatPatientDocumentDate(hospitalization.admitted_at,true)} — ${hospitalization.discharged_at?formatPatientDocumentDate(hospitalization.discharged_at,true):hospitalDocumentText(hospitalization.is_active===false?'Виписано':'Триває')}`;
  const completed=tasks.filter(task=>task.status==='completed').sort((a,b)=>String(a.completed_at||a.scheduled_at||'').localeCompare(String(b.completed_at||b.scheduled_at||'')));
  const treatments=completed.map(task=>{
    const used=(task.items||[]).filter(item=>item.actual_quantity!==undefined&&hospitalBillingNumber(item.actual_quantity,6,true).units>0n);
    return `<article class="disModernSection hospitalSummaryTreatment"><h4>${e(task.title||hospitalDocumentText('Призначення'))}</h4>${task.instructions?`<p>${e(task.instructions)}</p>`:''}${used.length?`<ul class="hospitalSummaryUsedItems">${used.map(item=>`<li>${e(item.name_snap)} · ${e(hospitalDocumentQuantity(item.actual_quantity))} ${e(item.unit_snap)}</li>`).join('')}</ul>`:''}${task.completion_note?`<p><b>${t('Результат / примітка')}:</b> ${e(task.completion_note)}</p>`:''}<small>${e(formatPatientDocumentDate(task.completed_at||task.scheduled_at,true))}${task.completed_by_name?' · '+e(task.completed_by_name):''}</small></article>`;
  }).join('');
  const content=section('Період госпіталізації',period)+section('Діагноз',hospitalization.diagnosis||'—')
    +section('Стан пацієнта',hospitalDocumentText({stable:'Стабільний',observation:'Під наглядом',critical:'Критичний'}[hospitalization.status]||'Не вказаний'))
    +section('Примітки',hospitalization.notes)
    +`<section class="hospitalSummaryTreatments"><h3>${t('Виконані призначення')}</h3>${treatments||`<p>${t('Виконані призначення не зафіксовані.')}</p>`}</section>`
    +section('Рекомендації власнику',hospitalization.recommendations)+financialContent;
  const patient=hospitalization.patient||{};
  const shell=renderPatientDocumentShell({title:hospitalDocumentText('Підсумок стаціонару'),
    number:'HSP-'+String(hospitalization.id).replaceAll('-','').slice(0,12).toUpperCase(),
    dateLabel:hospitalDocumentText('Дата формування')+': '+formatPatientDocumentDate(generatedAt,true),
    pet:{...patient,species:patient.species?speciesLabel(patient.species):'',breed:patient.breed?getCalendarBreedLabel(patient.breed):''},
    owner:hospitalization.owner||{},doctorName:hospitalization.doctor_name,
    clinic:{...clinic,document_accent_color:clinic.document_accent_color||'#326b96'},
    body:'<div data-hospital-bill-content></div>'});
  // Localize the shared shell before adding catalogue names and other original bill text.
  const template=document.createElement('template');template.innerHTML=shell;
  const originals=[];
  template.content.querySelectorAll('.disModernClinicName,.disModernClinicContacts,.disModernCardMain,.disModernInfoRow b,.disModernSignName,.disModernFooter span').forEach(node=>{
    const index=originals.push(node.textContent)-1;node.dataset.hospitalOriginal=String(index);node.textContent='PUG_HOSPITAL_ORIGINAL_'+index;
  });
  template.innerHTML=localizePatientDocumentHtml(template.innerHTML);
  template.content.querySelectorAll('[data-hospital-original]').forEach(node=>{node.textContent=originals[Number(node.dataset.hospitalOriginal)];node.removeAttribute('data-hospital-original');});
  template.content.querySelector('[data-hospital-bill-content]').outerHTML=content;
  template.content.querySelector('.disModernDoc').classList.add('hospitalBillDocument','hospitalSummaryDocument');
  return template.innerHTML;
}

async function downloadHospitalSummaryPdf(hospitalizationId,expectedPatientId=null,{includePrices=true}={}) {
  if(downloadHospitalSummaryPdf.busy)throw Error(hospitalDocumentText('Зачекайте завершення формування попереднього PDF.'));
  downloadHospitalSummaryPdf.busy=true;
  const org=JSON.stringify(getOrgHeaders());
  try {
    const [stays,tasks,bill,clinic]=await Promise.all([
      hospitalWardRead(`/api/hospitalizations?id=${encodeURIComponent(hospitalizationId)}`),
      hospitalWardRead(`/api/hospitalizations/${encodeURIComponent(hospitalizationId)}/tasks?actual_quantities=1`),
      includePrices?hospitalBillingRequest(`/api/hospitalizations/${encodeURIComponent(hospitalizationId)}/billing`):Promise.resolve(null),
      getPatientDocumentClinic(),
    ]);
    if(JSON.stringify(getOrgHeaders())!==org)throw Error(hospitalDocumentText('Клініку змінено. Відкрийте документ повторно.'));
    const stay=stays.find(h=>String(h.id)===String(hospitalizationId));
    if(!stay||!stay.patient?.id||String(stay.patient.id)!==String(stay.patient_id)
      ||(expectedPatientId&&String(stay.patient_id)!==String(expectedPatientId)))throw Error(hospitalDocumentText('Госпіталізація не відповідає пацієнту.'));
    const html=renderHospitalSummaryDocumentHtml({hospitalization:stay,tasks,bill,clinic,includePrices});
    if(downloadA4Pdf.busy)throw Error(hospitalDocumentText('Зачекайте завершення формування попереднього PDF.'));
    let host=document.getElementById('disA4');if(!host){host=document.createElement('div');host.id='disA4';host.className='visitDischargePrintHost';document.body.appendChild(host);}
    host.innerHTML=html;
    const filename=['PUG',sanitizePatientDocumentFilename(stay.patient.name||'patient'),'hospital_summary',includePrices?'with_prices':'medical',sanitizePatientDocumentFilename(stay.id),todayISO()].join('_')+'.pdf';
    await downloadA4Pdf(null,{render:false,filename,throwOnError:true,pageNumbers:true,pageLabel:'HSP-'+String(stay.id).replaceAll('-','').slice(0,12).toUpperCase()});
  }finally{downloadHospitalSummaryPdf.busy=false;}
}
