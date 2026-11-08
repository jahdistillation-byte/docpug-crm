/* Owner profile and its editors. This layer only decorates existing controls. */
(() => {
  const copies={uk:{empty:'Контактні дані ще не додані.',add:'Додати контакти'},en:{empty:'No contact details added yet.',add:'Add contact details'},de:{empty:'Noch keine Kontaktdaten hinterlegt.',add:'Kontaktdaten hinzufügen'},pl:{empty:'Nie dodano jeszcze danych kontaktowych.',add:'Dodaj dane kontaktowe'}};
  const clean=value=>String(value||'').replace(/^[^\p{L}\p{N}]+/u,'').trim();
  const svg=paths=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  window.getPugPetSpeciesIcon=name=>name==='cat'?svg('<path d="M5 10 4 3l7 4h2l7-4-1 7a8 8 0 1 1-14 0Z"/><path d="M8 12h.01M16 12h.01M10 16l2 1 2-1M12 17v2M3 14l4 1M17 15l4-1"/>'):name==='dog'?svg('<path d="M7 6c2-3 8-3 10 0l3 2c2 2 1 6-1 6l-2-3v5a5 5 0 0 1-10 0v-5l-2 3c-2 0-3-4-1-6l3-2Z"/><path d="M9 11h.01M15 11h.01M10 15h4l-2 2-2-2ZM12 17v2"/>'):getStockIcon('paw');
  window.mountPugOwnerProfile=(page,owner)=>{
    if(!page)return;
    page.classList.add('pugOwnerProfileWorkspace');
    const topContacts=page.querySelector('.ownerPremiumContacts');
    if(topContacts){[...topContacts.children].forEach((element,index)=>element.hidden=![owner.phone,owner.email,owner.note][index]);topContacts.hidden=![owner.phone,owner.email,owner.note].some(Boolean);}
    page.querySelectorAll('.ownerProfilePetAvatar,.ownerPetsTitleIcon').forEach(element=>element.innerHTML=getStockIcon('paw'));
    const details=page.querySelector('#ownerContactPanel');
    if(details){
      const items=[...details.querySelectorAll('.ownerDetailsItem')];
      items.forEach(item=>{const value=item.querySelector('strong')?.textContent.trim();item.hidden=!value||value==='—';});
      if(items.every(item=>item.hidden)){
        const t=copies[getInterfaceLanguage()]||copies.uk;
        const hint=document.createElement('p');hint.className='opNoContact';hint.textContent=t.empty;
        const add=document.createElement('button');add.type='button';add.className='opAddContact';add.dataset.editOwner=String(owner.id);add.textContent=t.add;
        details.append(hint,add);
      }
    }
  };
  window.decoratePugOwnerForm=overlay=>{
    if(!overlay)return;
    overlay.classList.add('pugOwnerPetEditor');
    overlay.querySelectorAll('[data-add-pet-species]').forEach(button=>{const icon=button.querySelector('.addPetSpeciesEmoji');if(icon)icon.innerHTML=window.getPugPetSpeciesIcon(button.dataset.addPetSpecies);});
    overlay.querySelectorAll('.addPetInputIcon').forEach((element,index)=>element.innerHTML=getStockIcon(index?'search':'paw'));
    overlay.querySelectorAll('.addPetLabel[data-i18n]').forEach(element=>element.textContent=clean(element.textContent));
    const weight=overlay.querySelector('#addPetWeight')?.closest('label'),age=overlay.querySelector('#addPetAge')?.closest('label');
    if(weight&&age)age.after(weight);
  };
  function init(){
    const modal=document.getElementById('ownerModal');if(!modal)return;
    modal.classList.add('pugOwnerEditor');
    const update=()=>{
      const icon=modal.querySelector('.pugVisitIcon');if(icon)icon.innerHTML=svg('<circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>');
      const title=modal.querySelector('#ownerModalTitle');if(title)modal.querySelector('[role="dialog"]')?.setAttribute('aria-labelledby',title.id);
      modal.querySelectorAll('.pugQuickGroupTitle,#ownerModalSave,#ownerModalCancel').forEach(element=>element.textContent=clean(element.textContent));
      modal.querySelectorAll('#ownerModalPhoneCountry option').forEach(option=>{const code=option.textContent.match(/\+\d+/)?.[0]||'';option.textContent=`${option.value==='US'?'US/CA':option.value} ${code}`;});
    };
    update();new MutationObserver(update).observe(modal,{attributes:true,attributeFilter:['class']});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
