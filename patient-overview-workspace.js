/* Patient overview presentation and one chronological source for displayed weight. */
(() => {
  const labels={uk:{actions:'Дії',history:'Усі вимірювання',ai:'Відкрити AI-підсумок',measurement:'Останній замір',chart:'Динаміка ваги'},en:{actions:'Actions',history:'All measurements',ai:'Open AI summary',measurement:'Latest measurement',chart:'Weight trend'},de:{actions:'Aktionen',history:'Alle Messungen',ai:'KI-Zusammenfassung öffnen',measurement:'Letzte Messung',chart:'Gewichtsverlauf'},pl:{actions:'Działania',history:'Wszystkie pomiary',ai:'Otwórz podsumowanie AI',measurement:'Ostatni pomiar',chart:'Zmiany masy ciała'}};
  const text=()=>labels[getInterfaceLanguage()]||labels.uk;
  const time=value=>{const n=Date.parse(String(value||''));return Number.isFinite(n)?n:0;};
  window.sortPugPatientWeights=history=>(Array.isArray(history)?history:[]).filter(row=>Number.isFinite(Number(row.weight_kg))&&Number(row.weight_kg)>0&&Number(row.weight_kg)<=500).slice().sort((a,b)=>time(b.measured_at||b.created_at)-time(a.measured_at||a.created_at)||time(b.created_at)-time(a.created_at));
  window.getPugPatientCurrentWeight=(pet,history)=>Number(window.sortPugPatientWeights(history)[0]?.weight_kg??pet?.weight_kg??0);
  const icon=paths=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const icons={passport:icon('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 9h6M9 13h6M9 17h4"/>'),notes:icon('<path d="m15 5 4 4M4 20l4-1L20 7a3 3 0 0 0-4-4L4 15v5ZM4 20h16"/>'),minus:icon('<path d="M6 12h12"/>')};
  window.mountPugPatientHeader=root=>{
    root?.closest('[data-page="patient"]')?.classList.add('pugPatientWorkspace');
    const avatar=root?.querySelector('.patientPremiumAvatar');if(avatar)avatar.innerHTML=getStockIcon('paw');
  };
  window.mountPugPatientOverview=(root,pet,history)=>{
    if(!root)return;
    const main=root.querySelector('.patientPremiumOverviewMain'),side=root.querySelector('.patientPremiumOverviewSide');if(!main||!side)return;
    const vaccine=side.querySelector('.patientVaccinationsPanel'),passport=side.querySelector('.patientPassportCard'),notes=side.querySelector('.patientDoctorNotesCard'),ai=main.querySelector('.patientPremiumAi');
    if(vaccine)main.append(vaccine);
    if(passport)side.append(passport);if(notes)side.append(notes);
    [...side.children].forEach(child=>{if(child!==passport&&child!==notes)child.remove();});
    for(const [card,name] of [[passport,'passport'],[notes,'notes']]){
      const title=card?.querySelector('h3');if(title){title.textContent=title.textContent.replace(/^[^\p{L}\p{N}]+/u,'').trim();title.insertAdjacentHTML('afterbegin',icons[name]);}
    }
    passport?.querySelectorAll('[style*="opacity"]').forEach(el=>{el.style.removeProperty('opacity');el.classList.add('poPassportLabel');el.textContent=el.textContent.replace(/^[^\p{L}\p{N}]+/u,'').trim();});
    const save=notes?.querySelector('[data-save-patient-notes]');if(save)save.innerHTML=icons.notes+escapeHtml(translateInterfaceText('patients.card.saveNote'));
    root.querySelectorAll('.patientDiagnosisActions').forEach(actions=>{
      const buttons=[...actions.querySelectorAll('[data-diagnosis-status]')];if(!buttons.length)return;
      const menu=document.createElement('details');menu.className='poDiagnosisMenu';const summary=document.createElement('summary');summary.textContent=text().actions;
      const items=document.createElement('div');items.className='poDiagnosisMenuItems';buttons.forEach(button=>items.append(button));menu.append(summary,items);actions.append(menu);
      items.addEventListener('click',event=>{if(event.target.closest('button'))menu.open=false;});
    });
    const empty=root.querySelector('.patientDiagnosesEmpty:not(.is-error)>span');if(empty)empty.innerHTML=icons.minus;
    if(ai){
      const disclosure=document.createElement('details');disclosure.className='poAiDisclosure';
      const summary=document.createElement('summary');summary.title=text().ai;
      const title=ai.querySelector('.patientPremiumAiTitle'),glyph=ai.querySelector('.patientPremiumAiIcon');if(glyph)summary.append(glyph);if(title)summary.append(title);
      disclosure.append(summary,ai);main.append(disclosure);
    }
    const sorted=window.sortPugPatientWeights(history),panel=root.querySelector('.patientWeightPanel'),current=panel?.querySelector('.patientWeightCurrent');
    if(sorted[0]&&current){const date=document.createElement('span');date.className='poMeasurementDate';date.textContent=`${text().measurement}: ${formatCalendarDate(sorted[0].measured_at||sorted[0].created_at,{day:'2-digit',month:'2-digit',year:'numeric'})}`;current.append(date);}
    const rows=panel?.querySelector('.patientWeightHistory');if(rows&&sorted.length>3){
      const disclosure=document.createElement('details');disclosure.className='poWeightDisclosure';const summary=document.createElement('summary');summary.textContent=`${text().history} · ${sorted.length}`;
      const more=document.createElement('div');more.className='poWeightMore';[...rows.children].slice(3).forEach(row=>more.append(row));disclosure.append(summary,more);rows.append(disclosure);
    }
    if(sorted.length>=2&&panel){
      const samples=sorted.slice(0,12).reverse(),values=samples.map(row=>Number(row.weight_kg)),min=Math.min(...values),max=Math.max(...values),pad=Math.max((max-min)*.2,max*.02,.1),lo=min-pad,hi=max+pad;
      const dates=samples.map(row=>time(row.measured_at||row.created_at)),start=dates[0],span=dates.at(-1)-start;
      const points=values.map((v,i)=>[24+(span?(dates[i]-start)/span:i/(values.length-1))*552,116-(v-lo)/(hi-lo)*92]);
      const chart=document.createElement('figure');chart.className='poWeightChart';chart.setAttribute('aria-label',text().chart);
      chart.innerHTML=`<svg viewBox="0 0 600 140" role="img" aria-label="${escapeHtml(text().chart)}"><title>${escapeHtml(values.map((v,i)=>`${formatCalendarDate(samples[i].measured_at||samples[i].created_at)}: ${v} ${translateInterfaceText('patients.card.kg')}`).join('; '))}</title><path class="poChartGrid" d="M24 25H576M24 70H576M24 116H576"/><polyline points="${points.map(p=>p.join(',')).join(' ')}"/>${points.map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="${i===points.length-1?4.5:3}"><title>${escapeHtml(String(values[i]))}</title></circle>`).join('')}</svg><figcaption><span>${escapeHtml(formatCalendarDate(samples[0].measured_at||samples[0].created_at))}</span><span>${escapeHtml(`${min.toLocaleString(getCalendarLocale())}–${max.toLocaleString(getCalendarLocale())} ${translateInterfaceText('patients.card.kg')}`)}</span><span>${escapeHtml(formatCalendarDate(samples.at(-1).measured_at||samples.at(-1).created_at))}</span></figcaption>`;
      panel.querySelector('.patientWeightBody').after(chart);
    }
  };
})();
