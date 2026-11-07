/* Calendar presentation. Existing appointment and schedule commands remain authoritative. */
(() => {
  const copy = {
    uk: ['Сьогодні','Календар','Графік команди','Створити запис','Налаштувати графік','Записи поза колонками розкладу','Без призначеного спеціаліста','Переглянути','Оберіть час, щоб створити запис','Вибраний час','Оберіть дату, час і спеціаліста','Перевіряємо розклад…','Час вільний у межах зміни','Є перетин з іншим записом','Час поза робочою зміною','Не вдалося перевірити розклад. Перевірка повториться при збереженні.','Завершення','Наступного дня','Пацієнт','Деталі прийому','Причина звернення','Новий запис','Оберіть пацієнта або додайте нового','Записів','Спеціалістів на зміні','Налаштування зміни'],
    en: ['Today','Calendar','Team schedule','New appointment','Configure schedule','Appointments outside schedule columns','No clinician assigned','View','Choose a time to create an appointment','Selected time','Choose a date, time and clinician','Checking schedule…','Available within the shift','Overlaps another appointment','Outside working hours','Could not check the schedule. It will be checked again when saving.','Ends','Next day','Patient','Appointment details','Reason for visit','New appointment','Select a patient or add a new one','Appointments','Staff on shift','Shift settings'],
    de: ['Heute','Kalender','Teamplan','Neuer Termin','Dienstplan einrichten','Termine außerhalb der Planspalten','Keine behandelnde Person zugewiesen','Ansehen','Zeit für einen neuen Termin wählen','Gewählte Zeit','Datum, Zeit und behandelnde Person wählen','Dienstplan wird geprüft…','Innerhalb der Schicht verfügbar','Überschneidung mit einem Termin','Außerhalb der Arbeitszeit','Dienstplan konnte nicht geprüft werden. Er wird beim Speichern erneut geprüft.','Ende','Am nächsten Tag','Patient','Termindetails','Vorstellungsgrund','Neuer Termin','Patient wählen oder neu hinzufügen','Termine','Teammitglieder im Dienst','Schichteinstellungen'],
    pl: ['Dzisiaj','Kalendarz','Grafik zespołu','Nowa wizyta','Ustaw grafik','Wizyty poza kolumnami grafiku','Nie przypisano specjalisty','Zobacz','Wybierz godzinę nowej wizyty','Wybrany czas','Wybierz datę, godzinę i specjalistę','Sprawdzanie grafiku…','Wolny termin w godzinach pracy','Termin koliduje z inną wizytą','Poza godzinami pracy','Nie udało się sprawdzić grafiku. Zostanie sprawdzony ponownie przy zapisie.','Koniec','Następnego dnia','Pacjent','Szczegóły wizyty','Powód wizyty','Nowa wizyta','Wybierz pacjenta lub dodaj nowego','Wizyty','Pracownicy na zmianie','Ustawienia zmiany'],
  };
  const t = i => (copy[typeof getInterfaceLanguage === 'function' ? getInterfaceLanguage() : 'uk'] || copy.uk)[i];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => typeof getStockIcon === 'function' ? getStockIcon(name) : '';
  const minutes = value => /^\d{2}:\d{2}$/.test(String(value).slice(0,5)) ? Number(value.slice(0,2))*60+Number(value.slice(3,5)) : NaN;
  const time = value => `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
  const keyboardClick = element => {
    element.setAttribute('role','button'); element.tabIndex=0;
    element.addEventListener('keydown',event => {
      if (event.target !== element || !['Enter',' '].includes(event.key)) return;
      event.preventDefault(); element.click();
    });
  };

  window.mountPugCalendarWorkspace = (page, {mode, date, staff, events}) => {
    const card = page?.querySelector('.calendarCard');
    if (!card || card.classList.contains('pugCalendarWorkspace')) return;
    card.classList.add('pugCalendarWorkspace'); card.dataset.calendarMode=mode;
    const header=card.querySelector('.calendarHeader'), dateNav=card.querySelector('.calendarTop');
    const switcher=header?.querySelector('.calendarViewGroup');
    if (!header || !dateNav || !switcher) return;
    const heading=document.createElement('header'); heading.className='pcHeading';
    heading.innerHTML=`<div><span class="pcEyebrow">PUG CRM</span><h1>${esc(t(mode==='month'?2:1))}</h1></div>`;
    const toolbar=document.createElement('div'); toolbar.className='pcToolbar';
    switcher.querySelector('.calendarViewGroupLabel')?.remove();
    switcher.setAttribute('aria-label', t(1));
    switcher.querySelectorAll('[data-cal-mode]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.calMode===mode)));
    const today=document.createElement('button'); today.type='button'; today.className='pcToday'; today.textContent=t(0);
    today.addEventListener('click',async()=>{ window.__calendarDate=todayISO(); await renderCalendarTab(); });
    dateNav.appendChild(today);
    const dateButtons=[...dateNav.querySelectorAll('button')];
    dateButtons[0].innerHTML=icon('chevron'); dateButtons[0].classList.add('pcPrevious');
    const next=dateButtons.find(button => /^calNext/.test(button.id));
    if(next){next.innerHTML=icon('chevron'); next.classList.add('pcNext');}
    let action=mode==='month' ? header.querySelector('[data-open-team-schedule]') : header.querySelector('#calendarCreateVisitButton');
    if (!action && mode!=='month') {
      action=document.createElement('button'); action.type='button';
      action.addEventListener('click',()=>openVisitFromCalendar('10:00',''));
    }
    if(action){action.className='pcPrimary'; action.innerHTML=`${icon('plus')}<span>${esc(t(mode==='month'?4:3))}</span>`;}
    toolbar.append(dateNav,switcher); if(action)toolbar.appendChild(action);
    const subbar=document.createElement('div'); subbar.className='pcSubbar';
    const dayEvents=events.filter(event=>String(event.event_date)===date);
    const columns=[...card.querySelectorAll('[data-calendar-doctor-column]')];
    const summary=document.createElement('span'); summary.textContent=mode==='day' ? `${t(23)}: ${dayEvents.length} · ${t(24)}: ${columns.length}` : mode==='month' ? t(25) : '';
    subbar.appendChild(summary);
    if(mode!=='month' && (isOwner() || isAdmin())){
      const schedule=header.querySelector('[data-open-team-schedule]');
      if(schedule){schedule.className='pcScheduleLink';schedule.innerHTML=`${icon('clock')}<span>${esc(t(4))}</span>`;subbar.appendChild(schedule);}
    }
    header.remove(); card.prepend(heading,toolbar,subbar);
    if(mode==='week'){
      const locale=typeof getCalendarLocale==='function'?getCalendarLocale():'uk-UA';
      card.querySelectorAll('.weekDayCol').forEach(column=>{
        const day=column.querySelector('[data-week-date]')?.dataset.weekDate;
        const label=column.querySelector('.weekDayDate');
        if(day&&label)label.textContent=new Intl.DateTimeFormat(locale,{day:'numeric',month:'short'}).format(new Date(`${day}T12:00:00`));
        const count=document.createElement('span');count.className='pcWeekCount';count.textContent=column.querySelectorAll('[data-cal-event-id]').length;
        column.querySelector('.weekDayHead>div')?.appendChild(count);
        column.classList.toggle('pcCurrentDay',day===todayISO());
        column.querySelectorAll('[data-cal-event-id]').forEach(element=>{
          const event=events.find(item=>String(item.id)===element.dataset.calEventId); if(!event)return;
          keyboardClick(element);
          const employee=staff.find(person=>String(person.id)===String(event.staff_id));
          const vet=element.querySelector('.weekEventVet');if(vet)vet.textContent=employee?.name||t(6);
          const note=element.querySelector('.weekEventMeta');
          const title=String(event.title||'').toLowerCase(), text=String(event.note||'').toLowerCase().trim();
          if(note&&text&&title.includes(text))note.remove();
          element.title=[event.title,event.note,employee?.name].filter(Boolean).join(' · ');
        });
      });
    }
    if(mode==='day'){
      card.querySelectorAll('[data-edit-calendar-event]').forEach(element=>{
        keyboardClick(element);
        const event=events.find(item=>String(item.id)===element.dataset.editCalendarEvent);
        if(event)element.title=[String(event.start_time||'').slice(0,5),event.title,event.note].filter(Boolean).join(' · ');
        const note=element.querySelector('.calendarTimelineEventNote');
        if(note&&event&&String(event.title||'').toLowerCase().includes(String(event.note||'').toLowerCase().trim()))note.remove();
      });
      const visible=new Set(columns.map(column=>String(column.dataset.staffId)));
      const outside=dayEvents.filter(event=>!visible.has(String(event.staff_id||'')));
      if(outside.length){
        const details=document.createElement('details');details.className='pcOutside';
        details.innerHTML=`<summary>${icon('clock')}<span>${esc(t(5))}</span><strong>${outside.length}</strong>${icon('chevron')}</summary><div class="pcOutsideList"></div>`;
        outside.forEach(event=>{
          const button=document.createElement('button');button.type='button';
          const employee=staff.find(person=>String(person.id)===String(event.staff_id));
          button.innerHTML=`<time>${esc(String(event.start_time||'').slice(0,5))}</time><span><strong>${esc(event.title)}</strong><small>${esc(employee?.name||t(6))}</small></span><span>${esc(t(7))}</span>`;
          button.addEventListener('click',()=>openCalendarEditModal(event,date,()=>renderCalendarTab()));
          details.querySelector('.pcOutsideList').appendChild(button);
        });
        subbar.after(details);
      }
    }
    if(mode==='month'){
      card.querySelectorAll('[data-month-date]').forEach(cell=>{keyboardClick(cell);cell.setAttribute('aria-label',cell.dataset.monthDate);});
      card.querySelectorAll('.monthStaffPill').forEach(pill=>{pill.textContent=pill.textContent.replace('👨‍⚕️','').trim();pill.title=pill.textContent;});
    }
    card.querySelectorAll('.calendarEmptyShiftIcon,.monthDrawerPlaceholderIcon').forEach(element=>element.innerHTML=icon('clock'));
  };

  function initBooking(){
    const modal=document.getElementById('visitModal');if(!modal)return;
    modal.classList.add('pugBookingWorkspace');
    const patientBlock=modal.querySelector('.pugVisitPatientBlock');
    const quickPatient=modal.querySelector('.pugQuickPatientBox');
    if(quickPatient)modal.querySelector('.pugVisitBody')?.appendChild(quickPatient);
    const vaccination=modal.querySelector('.pugQuickVaccinationBlock');
    if(vaccination&&quickPatient){
      vaccination.classList.add('pcVaccinationSection');
      quickPatient.querySelector('.pugQuickPatientGrid')?.appendChild(vaccination);
      const labels=[...vaccination.children].filter(child=>child.tagName==='LABEL');
      const detailIds=['visitNewPetRabiesDetails','visitNewPetGeneralVaccinationDetails'];
      labels.forEach((label,index)=>{
        const card=document.createElement('section');card.className='pcVaccinationCard';
        vaccination.appendChild(card);card.appendChild(label);
        const details=document.getElementById(detailIds[index]);if(details)card.appendChild(details);
      });
    }
    const detailsBlock=modal.querySelector('.pugVisitDetailsBlock');
    const reasonBlock=modal.querySelector('.pugVisitMedicalBlock');
    if(detailsBlock&&reasonBlock)detailsBlock.appendChild(reasonBlock);
    const dialog=modal.querySelector('[role="dialog"]');
    const title=modal.querySelector('.pugVisitTitle');
    if(title){title.id='pugBookingTitle';dialog?.setAttribute('aria-labelledby',title.id);}
    modal.querySelector('.pugVisitIcon').innerHTML=icon('clock');
    modal.querySelectorAll('.pugSectionTitle').forEach((heading,index)=>{
      const symbol=heading.querySelector('span');if(symbol)symbol.innerHTML=icon(['medical','clock','edit'][index]||'medical');
    });
    modal.querySelector('.pugSearchIcon').innerHTML=icon('search');
    const selected=document.createElement('div');selected.className='pcBookingPatient';selected.hidden=true;
    modal.querySelector('.pugSearchWrap')?.after(selected);
    const updatePatient=()=>{
      const id=document.getElementById('visitPatientSelect')?.value;
      const patient=(window.__visitPatientList||[]).find(item=>String(item.id)===String(id));
      selected.hidden=!patient;
      if(patient)selected.innerHTML=`${icon('medical')}<div><strong>${esc(patient.name)}</strong><small>${esc([patient.species,patient.breed].filter(Boolean).join(' · '))}</small><small>${esc([patient.owner_name,patient.owner_phone].filter(Boolean).join(' · '))}</small></div>`;
    };
    const status=document.createElement('div');status.className='pcBookingAvailability';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    modal.querySelector('.pugVisitFieldsGrid')?.after(status);
    const footSummary=document.createElement('div');footSummary.className='pcBookingSummary';
    modal.querySelector('.pugVisitFoot')?.prepend(footSummary);
    let revision=0,timer=null,controller=null;
    const value=id=>document.getElementById(id)?.value||'';
    const isOpen=()=>modal.classList.contains('open');
    const updateSummary=()=>{
      const start=minutes(value('visitStartTime')),duration=Number(value('visitDuration')),end=start+duration;
      footSummary.textContent=Number.isFinite(end)&&duration>0 ? `${t(9)}: ${value('visitStartTime')}–${time(end)} · ${duration} ${translateInterfaceText('calendar.detail.15.min').replace(/^15\s*/,'')}` : '';
    };
    const check=async()=>{
      clearTimeout(timer); controller?.abort(); const request=++revision;
      updateSummary(); if(!isOpen())return;
      const date=value('visitDate'),start=value('visitStartTime'),staffId=value('visitStaff'),duration=Number(value('visitDuration'));
      status.className='pcBookingAvailability';status.textContent=t(10);
      if(!date||!staffId||staffId.startsWith('__')||!Number.isFinite(minutes(start))||!duration)return;
      if(minutes(start)+duration>1440){status.classList.add('is-warning');status.textContent=translateInterfaceText('calendar.detail.appointment.extends.past.midnight');return;}
      if(modal.dataset.visitId){status.textContent='';return;}
      status.textContent=t(11);controller=new AbortController();
      try{
        const read=async url=>{const response=await fetch(url,{credentials:'include',cache:'no-store',headers:{Accept:'application/json',...getOrgHeaders()},signal:controller.signal});const json=await response.json();if(!response.ok||json.ok!==true)throw Error('calendar-read');const items=json.items??json.data;if(!Array.isArray(items))throw Error('calendar-shape');return items;};
        const [events,schedule]=await Promise.all([read('/api/calendar'),read(`/api/staff-schedule?date=${encodeURIComponent(date)}`)]);
        if(request!==revision||!isOpen())return;
        const startAt=minutes(start),endAt=startAt+duration;
        const busy=events.some(event=>String(event.staff_id)===staffId&&String(event.event_date)===date&&minutes(event.start_time)<endAt&&minutes(event.end_time)>startAt);
        const inShift=schedule.some(row=>String(row.staff_id)===staffId&&row.is_active!==false&&minutes(row.start_time)<=startAt&&minutes(row.end_time)>=endAt);
        status.classList.toggle('is-warning',busy||!inShift);status.classList.toggle('is-available',!busy&&inShift);
        status.textContent=t(busy?13:!inShift?14:12);
      }catch(error){if(request===revision&&isOpen()&&error.name!=='AbortError'){status.className='pcBookingAvailability is-warning';status.textContent=t(15);}}
    };
    const scheduleCheck=()=>{++revision;controller?.abort();clearTimeout(timer);updateSummary();if(isOpen()){status.className='pcBookingAvailability';status.textContent=t(11);timer=setTimeout(check,250);}};
    ['visitDate','visitStartTime','visitDuration','visitStaff'].forEach(id=>{
      const field=document.getElementById(id);field?.addEventListener('input',scheduleCheck);field?.addEventListener('change',scheduleCheck);
    });
    new MutationObserver(()=>{
      if(isOpen()){
        // Localize existing text without replacing form fields or their listeners.
        modal.querySelector('.pugVisitIcon').innerHTML=icon('clock');
        modal.querySelector('.pugSearchIcon').innerHTML=icon('search');
        modal.querySelectorAll('.pugSectionTitle span').forEach((element,index)=>{element.innerHTML=icon(['medical','clock','edit'][index]||'medical');});
        modal.querySelectorAll('.pugQuickPatientTitle,.pugQuickGroupTitle,.pcVaccinationCard>label>span').forEach(element=>{element.textContent=element.textContent.replace(/^[^\p{L}\p{N}]+/u,'');});
        modal.querySelectorAll('.pugSectionTitle strong').forEach((element,index)=>{element.textContent=t([18,19,20][index]||19);});
        const save=document.getElementById('visitSave'),cancel=document.getElementById('visitCancel');
        if(save)save.textContent=translateInterfaceText('calendar.detail.save.appointment').replace('💾','').trim();
        if(cancel)cancel.textContent=translateInterfaceText('calendar.detail.cancel.2').replace('✕','').trim();
        modal.querySelector('#visitClose')?.setAttribute('aria-label',translateInterfaceText('calendar.detail.close'));
        updatePatient();scheduleCheck();
      }else{++revision;controller?.abort();clearTimeout(timer);status.textContent='';footSummary.textContent='';}
    }).observe(modal,{attributes:true,attributeFilter:['class']});
    // Keyboard access to the existing patient picker; keep its original click handler.
    new MutationObserver(()=>{modal.querySelectorAll('[data-select-visit-patient]:not([role])').forEach(keyboardClick);updatePatient();}).observe(document.getElementById('visitPatientResults'),{childList:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initBooking,{once:true});else initBooking();
})();
