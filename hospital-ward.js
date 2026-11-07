/* Hospital visual workspace. Existing clinical APIs and task actions remain shared. */
function hospitalWardText(source) {
  const translations = {
    "Турбота під контролем.": ["Care under control.", "Fürsorge im Blick.", "Opieka pod kontrolą."],
    "Стан пацієнтів і найближчі кроки — перед очима.": ["Patient condition and next steps, at a glance.", "Patientenzustand und nächste Schritte auf einen Blick.", "Stan pacjentów i kolejne działania w jednym miejscu."],
    "Відкрити стаціонар": ["Open hospital stay", "Stationskarte öffnen", "Otwórz kartę pobytu"],
    "Найближче призначення": ["Next treatment", "Nächste Maßnahme", "Najbliższe zlecenie"],
    "у плані": ["planned", "geplant", "w planie"],
    "Прострочено": ["Overdue", "Überfällig", "Zaległe"],
    "Без часу": ["No time set", "Ohne Zeitangabe", "Bez godziny"],
    "Невиконані призначення без часу": ["Pending treatments without a scheduled time", "Offene Maßnahmen ohne Zeitangabe", "Oczekujące zlecenia bez godziny"],
    "Призначень у плані немає": ["No planned treatments", "Keine Maßnahmen geplant", "Brak zaplanowanych zleceń"],
    "Не вдалося завантажити призначення": ["Could not load treatments", "Maßnahmen konnten nicht geladen werden", "Nie udało się wczytać zleceń"],
    "Не вдалося завантажити стаціонар": ["Could not load hospital patients", "Stationspatienten konnten nicht geladen werden", "Nie udało się wczytać pacjentów szpitala"],
    "Повторити": ["Retry", "Erneut versuchen", "Spróbuj ponownie"],
    "Дані пацієнта": ["Patient details", "Patientendaten", "Dane pacjenta"],
    "Медична карта": ["Medical record", "Krankenakte", "Dokumentacja medyczna"],
    "Кличка, власник, палата або лікар…": ["Patient, owner, room or doctor…", "Patient, Halter, Zimmer oder Arzt…", "Pacjent, opiekun, sala lub lekarz…"],
    "Пошук пацієнта…": ["Find a patient…", "Patient suchen…", "Szukaj pacjenta…"],
    "Завантаження стаціонару…": ["Loading hospital patients…", "Stationspatienten werden geladen…", "Wczytywanie pacjentów szpitala…"],
    "У стаціонарі ще немає пацієнтів": ["No hospitalized patients yet", "Noch keine stationären Patienten", "Brak pacjentów w szpitalu"],
    "Для початку прийміть пацієнта у стаціонар.": ["Admit a patient to get started.", "Nehmen Sie zunächst einen Patienten auf.", "Przyjmij pacjenta, aby rozpocząć."],
    "Змінити пошук або фільтр": ["Change search or filter", "Suche oder Filter ändern", "Zmień wyszukiwanie lub filtr"],
  };
  const index = {en:0,de:1,pl:2}[getInterfaceLanguage()];
  return index !== undefined && translations[source] ? translations[source][index] : getHospitalInterfaceText(source);
}

function hospitalWardIcon(name) {
  const paths = {
    paw:'<ellipse cx="7" cy="5.5" rx="2" ry="2.5"/><ellipse cx="17" cy="5.5" rx="2" ry="2.5"/><ellipse cx="3.5" cy="11" rx="1.5" ry="2"/><ellipse cx="20.5" cy="11" rx="1.5" ry="2"/><path d="M7 14c-4 5 0 8 5 5 5 3 9 0 5-5-3-5-7-5-10 0Z"/>',
    bed:'<path d="M3 18V7M21 18v-7H3M3 16h18M7 11V7h5v4M12 7h5a4 4 0 0 1 4 4"/>',
    doctor:'<path d="M6 3v6a5 5 0 0 0 10 0V3M4 3h4M14 3h4M11 14v2a5 5 0 0 0 10 0v-2"/><circle cx="21" cy="11" r="2"/>',
    arrow:'<path d="M7 17 17 7M7 7h10v10"/>',
    chevron:'<path d="m6 9 6 6 6-6"/>',
    feeding:'<path d="M3 12a9 9 0 0 0 18 0H3ZM12 4v4M7 5v3M17 5v3"/>',
    thermometer:'<path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0ZM12 8v9"/><circle cx="12" cy="18" r="1"/>',
    clipboard:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 10h6M9 14h6M9 18h3"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
  };
  if (!paths[name]) return getStockIcon(name);
  return `<svg class="hospitalWardIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

function hospitalWardTaskIcon(type) {
  return hospitalWardIcon({medication:"capsule",infusion:"drop",feeding:"feeding",measurement:"thermometer",procedure:"medical",examination:"doctor"}[type] || "clipboard");
}

function hospitalWardTaskSummary(tasks, now = new Date()) {
  const planned = (Array.isArray(tasks) ? tasks : []).filter(t=>["planned","overdue"].includes(t.status));
  const validTime = t => t.scheduled_at && Number.isFinite(new Date(t.scheduled_at).getTime());
  const dated = planned.filter(validTime).sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at));
  const task = dated[0] || planned[0] || null;
  return {planned, task, overdue:!!(task && validTime(task) && new Date(task.scheduled_at)<now),
    undated:planned.filter(t=>!validTime(t)).length};
}

function renderHospitalWardCard(item) {
  const e=escapeHtml, t=s=>e(hospitalWardText(s));
  const status=["stable","observation","critical"].includes(item.status)?item.status:"observation";
  const summary=hospitalWardTaskSummary(item.hospital_tasks);
  const task=summary.task;
  const date=task?.scheduled_at?new Date(task.scheduled_at):null;
  const validDate=date && Number.isFinite(date.getTime());
  const time=validDate?date.toLocaleTimeString(getCalendarLocale(),{hour:"2-digit",minute:"2-digit"}):hospitalWardText("Без часу");
  const dateLabel=validDate?date.toLocaleDateString(getCalendarLocale(),{day:"2-digit",month:"2-digit",year:"numeric"}):"";
  const species=[item.patient_species?speciesLabel(item.patient_species):"",item.patient_breed?getCalendarBreedLabel(item.patient_breed):""].filter(Boolean).join(" · ");
  const state={stable:"Стабільний",observation:"Під наглядом",critical:"Критичний"}[status];
  return `<article class="hospitalWardCard" data-hospitalization-id="${e(String(item.id))}">
    <header class="hospitalWardPatient"><span class="hospitalWardAvatar">${hospitalWardIcon("paw")}</span><div><h2>${e(item.patient_name||hospitalWardText("Пацієнт"))}</h2><p>${e(species||hospitalWardText("Вид та порода не вказані"))}</p></div><span class="hospitalWardBadge is-${status}"><span></span>${t(state)}</span></header>
    <p class="hospitalWardDiagnosis">${e(item.diagnosis||hospitalWardText("Діагноз не вказаний"))}</p>
    <div class="hospitalWardMeta"><span>${hospitalWardIcon("bed")}${e(item.room||hospitalWardText("Палата не вказана"))}</span><span>${hospitalWardIcon("doctor")}${e(item.doctor_name||hospitalWardText("Не вказаний"))}</span></div>
    <section class="hospitalWardNext ${summary.overdue?"is-overdue":""}"><div class="hospitalWardNextHead"><span>${t("Найближче призначення")}</span>${!item.ward_tasks_error?`<span>${summary.planned.length} ${t("у плані")}</span>`:""}</div>
    ${item.ward_tasks_error?`<p class="hospitalWardTaskEmpty">${t("Не вдалося завантажити призначення")}</p>`:task?`<div class="hospitalWardNextTask"><div class="hospitalWardTime"><time ${validDate?`datetime="${e(date.toISOString())}"`:""}>${e(time)}</time><small>${e(dateLabel)}</small></div><div><h3>${e(task.title||hospitalWardText("Призначення"))}</h3>${task.instructions?`<p class="hospitalWardInstruction">${e(task.instructions)}</p>`:""}<span class="hospitalWardTaskStatus">${summary.overdue?hospitalWardIcon("clock"):""}${t(summary.overdue?"Прострочено":"Очікує виконання")}</span>${summary.undated&&validDate?`<small class="hospitalWardUndated">${t("Невиконані призначення без часу")}: ${summary.undated}</small>`:""}</div></div>`:`<p class="hospitalWardTaskEmpty">${hospitalWardIcon(summary.planned.length?"clipboard":"check")}${t((item.hospital_tasks||[]).length?"Призначень у плані немає":"Призначення ще не додані")}</p>`}
    </section><footer class="hospitalWardCardFooter"><span>${t("Надійшов")}<time>${e(formatHospitalDateTime(item.admitted_at))}</time></span><button class="hospitalWardPrimary" type="button" data-hospital-assignments="${e(String(item.id))}">${t("Відкрити стаціонар")}${hospitalWardIcon("arrow")}</button></footer>
  </article>`;
}

async function hospitalWardRead(path) {
  const response=await fetch(path,{credentials:"include",headers:{Accept:"application/json",...getOrgHeaders()}});
  const result=await response.json();
  if(!response.ok||result?.ok!==true||!Array.isArray(result.data))throw Error("Hospital data unavailable");
  return result.data;
}

async function renderHospitalWard() {
  const page=document.querySelector('.page[data-page="hospital"]');if(!page)return;
  const requestId=(page.wardRequestId||0)+1;page.wardRequestId=requestId;
  const saved={query:page.querySelector('#hospitalSearch')?.value||"",filter:page.querySelector('[data-hospital-filter][aria-pressed="true"]')?.dataset.hospitalFilter||"all"};
  const org=JSON.stringify(getOrgHeaders());
  const current=()=>page.wardRequestId===requestId&&JSON.stringify(getOrgHeaders())===org;
  const e=escapeHtml,t=s=>e(hospitalWardText(s));
  page.innerHTML=`<div class="hospitalPage hospitalWard"><p class="hospitalWardLoading" role="status">${t("Завантаження стаціонару…")}</p></div>`;
  try {
    const patients=await hospitalWardRead('/api/hospitalizations?active=true');
    // Keep requests bounded for clinics with more patients.
    let cursor=0;await Promise.all(Array.from({length:Math.min(4,patients.length)},async()=>{
      while(cursor<patients.length){const item=patients[cursor++];try{item.hospital_tasks=await hospitalWardRead(`/api/hospitalizations/${encodeURIComponent(item.id)}/tasks`);}catch{item.hospital_tasks=[];item.ward_tasks_error=true;}}
    }));
    if(!current())return;
    window.__hospitalPatients=patients;
    const counts={all:patients.length,stable:0,observation:0,critical:0};patients.forEach(p=>{counts[["stable","observation","critical"].includes(p.status)?p.status:"observation"]++;});
    page.innerHTML=`<div class="hospitalPage hospitalWard"><header class="hospitalWardHeader"><div><span class="hospitalWardEyebrow">${t("СТАЦІОНАР КЛІНІКИ")}</span><h1>${t("Турбота під контролем.")}</h1><p>${t("Стан пацієнтів і найближчі кроки — перед очима.")}</p></div><button class="hospitalWardPrimary" type="button" id="hospitalAdmitPatient">${hospitalWardIcon("plus")}${t("Прийняти у стаціонар")}</button></header>
    <div class="hospitalWardToolbar"><div class="hospitalWardFilters" role="group" aria-label="${t("У стаціонарі")}">${[["all","Усі"],["stable","Стабільні"],["observation","Під наглядом"],["critical","Критичні"]].map(([key,label])=>`<button type="button" data-hospital-filter="${key}" aria-pressed="${saved.filter===key}">${t(label)}<span>${counts[key]}</span></button>`).join("")}</div><label class="hospitalWardSearch">${hospitalWardIcon("search")}<input id="hospitalSearch" type="search" aria-label="${t("Кличка, власник, палата або лікар…")}" placeholder="${t("Пошук пацієнта…")}"></label></div>
    <section class="hospitalWardGrid" id="hospitalPatientGrid" aria-label="${t("У стаціонарі")}"></section><p class="hospitalWardResults" aria-live="polite"></p></div>`;
    const input=page.querySelector('#hospitalSearch');input.value=saved.query;
    const paint=()=>{
      const filter=page.querySelector('[data-hospital-filter][aria-pressed="true"]')?.dataset.hospitalFilter||"all";
      const query=input.value.trim().toLocaleLowerCase(getCalendarLocale());
      const filtered=patients.filter(p=>(filter==="all"||p.status===filter)&&[p.patient_name,p.owner_name,p.owner_phone,p.patient_breed,p.diagnosis,p.room,p.doctor_name].join(" ").toLocaleLowerCase(getCalendarLocale()).includes(query));
      page.querySelector('#hospitalPatientGrid').innerHTML=filtered.length?filtered.map(renderHospitalPatientCard).join(""):`<div class="hospitalWardEmpty">${hospitalWardIcon("bed")}<h2>${t(patients.length?"Пацієнтів не знайдено":"У стаціонарі ще немає пацієнтів")}</h2><p>${t(patients.length?"Змінити пошук або фільтр":"Для початку прийміть пацієнта у стаціонар.")}</p></div>`;
      page.querySelector('.hospitalWardResults').textContent=`${hospitalWardText("У стаціонарі")}: ${filtered.length} / ${patients.length}`;
    };
    page.querySelectorAll('[data-hospital-filter]').forEach(button=>button.addEventListener('click',()=>{page.querySelectorAll('[data-hospital-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));paint();}));
    input.addEventListener('input',paint);paint();bindHospitalPageActions(page,patients);
  }catch{
    if(!current())return;
    page.innerHTML=`<div class="hospitalPage hospitalWard"><div class="hospitalWardEmpty" role="alert"><h2>${t("Не вдалося завантажити стаціонар")}</h2><button class="hospitalWardPrimary" type="button">${t("Повторити")}</button></div></div>`;
    page.querySelector('button').addEventListener('click',renderHospitalTab);
  }
}

function hospitalWardPatientDetails(item) {
  const e=escapeHtml,t=s=>e(hospitalWardText(s));
  return `<details class="hospitalWardDetails"><summary>${t("Дані пацієнта")}${hospitalWardIcon("chevron")}</summary><dl>${[["Власник",item.owner_name],["Телефон",item.owner_phone],["Лікар",item.doctor_name],["Палата",item.room],["Надійшов",formatHospitalDateTime(item.admitted_at)]].map(([label,value])=>`<div><dt>${t(label)}</dt><dd>${e(value||"—")}</dd></div>`).join("")}</dl></details>`;
}

async function hospitalWardDischarge(item, button, onSuccess) {
  if(button.disabled)return;
  const original=button.innerHTML;button.disabled=true;
  try{const decision=await openHospitalDischargeConfirm(item);if(!decision.confirmed||!button.isConnected)return;
    button.textContent=hospitalWardText("Виписуємо…");
    const result=await dischargeHospitalizationApi(item.id,decision.note,decision.recommendations);if(result){if(onSuccess)await onSuccess();else await renderHospitalTab();}}
  finally{if(button.isConnected){button.disabled=false;button.innerHTML=original;}}
}
