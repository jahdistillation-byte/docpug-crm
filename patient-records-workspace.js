/* Presentation for the patient's visit history and clinical diary. */
(() => {
  const copy={uk:{title:'Історія візитів',open:'Відкрити візит',calendar:'Відкрити запис',temp:'Температура',weight:'Вага',pulse:'Пульс'},en:{title:'Visit history',open:'Open visit',calendar:'Open appointment',temp:'Temperature',weight:'Weight',pulse:'Pulse'},de:{title:'Besuchsverlauf',open:'Besuch öffnen',calendar:'Termin öffnen',temp:'Temperatur',weight:'Gewicht',pulse:'Puls'},pl:{title:'Historia wizyt',open:'Otwórz wizytę',calendar:'Otwórz termin',temp:'Temperatura',weight:'Masa ciała',pulse:'Tętno'}};
  const words=()=>copy[getInterfaceLanguage()]||copy.uk;
  window.mountPugVisitHistory=box=>{
    if(!box)return;
    box.classList.add('pugVisitHistory');
    const head=document.createElement('header');head.className='prHistoryHeading';
    const title=document.createElement('h2');title.textContent=words().title;
    const count=document.createElement('span');count.className='prHistoryCount';count.textContent=String(box.querySelectorAll('.premiumVisitCard').length);head.append(title,count);box.prepend(head);
    box.querySelectorAll('.premiumVisitCard').forEach(card=>{
      const hint=card.querySelector('.premiumVisitOpenHint');
      if(hint){const button=document.createElement('button');button.className='prOpenVisit';button.type='button';button.textContent=card.dataset.openCalendarEvent?words().calendar:words().open;button.insertAdjacentHTML('beforeend','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>');hint.replaceWith(button);}
      // Keyboard activation belongs to the card, while nested buttons retain their native behavior.
      card.addEventListener('keydown',event=>{if(event.target===card&&['Enter',' '].includes(event.key)){event.preventDefault();card.click();}});
    });
  };
  window.renderPugMedcardVitals=(item,format)=>{
    const t=words(),svg=paths=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const fields=[['temperature',t.temp,svg('<path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Z"/><path d="M12 7v10"/>'), '°C'],['weight_kg',t.weight,svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 10a4 4 0 0 1 8 0M12 10l2-2"/>'),translateInterfaceText('patients.card.kg')],['pulse',t.pulse,getStockIcon('heart'),'']];
    return fields.filter(([field])=>item[field]).map(([field,label,glyph,unit])=>`<span class="prVitalTag"><span class="prVitalLabel">${glyph}${escapeHtml(label)}</span><strong>${escapeHtml(format(item[field]))}${unit?' '+escapeHtml(unit):''}</strong></span>`).join('')||escapeHtml(translateInterfaceText('patients.card.medcard.parametersNotSpecified'));
  };
})();
