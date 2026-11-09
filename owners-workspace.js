/* Owner directory presentation. Existing delegated commands remain authoritative. */
(() => {
  const translations = {
    uk: {title:'Власники',subtitle:'Контакти та улюбленці — в одному місці.',add:'Додати власника',search:'Ім’я, телефон, улюбленець або порода',clear:'Очистити пошук',all:'Усі',with:'З тваринами',without:'Без тварин',missing:'Немає контактів',sort:'Сортування',recent:'Нещодавно додані',nameSort:'За ім’ям',petsSort:'За кількістю тварин',owners:'Власників',patients:'Пацієнтів',noContacts:'Без контактів',owner:'Власник',contacts:'Контакти',pets:'Улюбленці',open:'Відкрити',actions:'Дії з власником',edit:'Редагувати',remove:'Видалити',noPets:'Ще немає тварин',unnamed:'Без імені',unnamedPet:'Без клички',copy:'Копіювати телефон',shown:'Показано {count} із {total}',empty:'Нічого не знайдено',emptyHint:'Спробуйте інше ім’я, номер телефону або змініть фільтр.',first:'Додайте першого власника',firstHint:'Контакти власників та їхні улюбленці з’являться тут.',reset:'Скинути пошук і фільтри'},
    en: {title:'Owners',subtitle:'Contacts and pets, all in one place.',add:'Add owner',search:'Name, phone, pet or breed',clear:'Clear search',all:'All',with:'With pets',without:'Without pets',missing:'No contacts',sort:'Sort',recent:'Recently added',nameSort:'By name',petsSort:'By pet count',owners:'Owners',patients:'Patients',noContacts:'Without contacts',owner:'Owner',contacts:'Contacts',pets:'Pets',open:'Open',actions:'Owner actions',edit:'Edit',remove:'Delete',noPets:'No pets yet',unnamed:'Unnamed owner',unnamedPet:'Unnamed pet',copy:'Copy phone number',shown:'Showing {count} of {total}',empty:'No owners found',emptyHint:'Try another name, phone number or filter.',first:'Add your first owner',firstHint:'Owner contacts and their pets will appear here.',reset:'Reset search and filters'},
    de: {title:'Tierhalter',subtitle:'Kontakte und Tiere an einem Ort.',add:'Tierhalter hinzufügen',search:'Name, Telefon, Tier oder Rasse',clear:'Suche löschen',all:'Alle',with:'Mit Tieren',without:'Ohne Tiere',missing:'Keine Kontakte',sort:'Sortieren',recent:'Zuletzt hinzugefügt',nameSort:'Nach Name',petsSort:'Nach Tieranzahl',owners:'Tierhalter',patients:'Patienten',noContacts:'Ohne Kontaktdaten',owner:'Tierhalter',contacts:'Kontakte',pets:'Tiere',open:'Öffnen',actions:'Aktionen für Tierhalter',edit:'Bearbeiten',remove:'Löschen',noPets:'Noch keine Tiere',unnamed:'Ohne Namen',unnamedPet:'Tier ohne Namen',copy:'Telefonnummer kopieren',shown:'{count} von {total} angezeigt',empty:'Keine Tierhalter gefunden',emptyHint:'Anderen Namen, Telefonnummer oder Filter versuchen.',first:'Ersten Tierhalter hinzufügen',firstHint:'Hier erscheinen Kontakte und die zugehörigen Tiere.',reset:'Suche und Filter zurücksetzen'},
    pl: {title:'Właściciele',subtitle:'Kontakty i zwierzęta w jednym miejscu.',add:'Dodaj właściciela',search:'Imię, telefon, zwierzę lub rasa',clear:'Wyczyść wyszukiwanie',all:'Wszyscy',with:'Ze zwierzętami',without:'Bez zwierząt',missing:'Brak kontaktów',sort:'Sortowanie',recent:'Ostatnio dodani',nameSort:'Według nazwy',petsSort:'Według liczby zwierząt',owners:'Właściciele',patients:'Pacjenci',noContacts:'Bez danych kontaktowych',owner:'Właściciel',contacts:'Kontakty',pets:'Zwierzęta',open:'Otwórz',actions:'Działania właściciela',edit:'Edytuj',remove:'Usuń',noPets:'Brak zwierząt',unnamed:'Bez imienia',unnamedPet:'Zwierzę bez imienia',copy:'Kopiuj numer telefonu',shown:'Wyświetlono {count} z {total}',empty:'Nie znaleziono właścicieli',emptyHint:'Spróbuj innej nazwy, numeru telefonu lub filtra.',first:'Dodaj pierwszego właściciela',firstHint:'Tutaj pojawią się kontakty właścicieli i ich zwierzęta.',reset:'Resetuj wyszukiwanie i filtry'},
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const text = () => translations[typeof getInterfaceLanguage==='function' ? getInterfaceLanguage() : 'uk'] || translations.uk;
  const icon = name => name==='message' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/></svg>' : typeof getStockIcon==='function' && ['paw','plus','search','close','partners'].includes(name) ? getStockIcon(name) : ownerCatalogIcon(name,16);
  const contact = value => String(value ?? '').trim();
  const hasContacts = owner => [owner.phone,owner.email,owner.telegram].some(value=>contact(value));

  function mount(page,view){
    if(page.classList.contains('pugOwnersWorkspace'))return;
    page.classList.add('pugOwnersWorkspace','ownersCardsMode');
    const previous=page.firstElementChild;
    const add=document.getElementById('btnAddOwner');
    const heading=document.createElement('header');heading.className='pwHeading';
    heading.innerHTML='<div><span class="pwEyebrow">PUG CRM</span><h1></h1><p></p></div>';
    if(add)heading.appendChild(add);
    previous.replaceWith(heading);
    const columns=document.createElement('div');columns.className='pwColumns';columns.setAttribute('aria-hidden','true');
    view.querySelector('#ownersCardsGrid').before(columns);
    const count=document.createElement('div');count.className='pwResultCount';count.setAttribute('role','status');count.setAttribute('aria-live','polite');
    view.querySelector('.ownersCatalogToolbar').after(count);
    page.addEventListener('click',event=>{
      const petButton=event.target.closest('[data-open-client-pet]');
      if(petButton){
        event.stopPropagation();
        openPatient(petButton.dataset.openClientPet);
        return;
      }

      if(event.target.closest('[data-owner-reset]')){
        const input=document.getElementById('globalSearch');
        state.ownersCatalogFilter='all';
        if(input){input.value='';input.dispatchEvent(new Event('input'));input.focus();}else{renderOwners();}
      }
    });
    page.addEventListener('keydown',event=>{
      if(event.key!=='Escape')return;
      const panel=page.querySelector('.ownerCatalogMenu.open');if(!panel)return;
      const id=panel.dataset.ownerMenuPanel;panel.classList.remove('open');
      const button=[...page.querySelectorAll('[data-owner-menu]')].find(item=>item.dataset.ownerMenu===id);
      button?.setAttribute('aria-expanded','false');button?.focus();event.preventDefault();
    });
  }

  window.renderPugOwnersWorkspace = () => {
    const page=document.querySelector('.page[data-page="owners"]');
    const view=document.getElementById('ownersCardsView'),grid=document.getElementById('ownersCardsGrid'),empty=document.getElementById('ownersCardsEmpty');
    if(!page||!view||!grid||!empty)return false;
    mount(page,view);
    const t=text(),owners=Array.isArray(state.owners)?state.owners:[],patients=Array.isArray(state.patients)?state.patients:[];
    const petsByOwner=new Map();
    patients.forEach(patient=>{const key=String(patient.owner_id);if(!petsByOwner.has(key))petsByOwner.set(key,[]);petsByOwner.get(key).push(patient);});
    const petsOf=id=>petsByOwner.get(String(id))||[];
    const input=document.getElementById('globalSearch'),query=contact(input?.value).toLowerCase();
    const filter=state.ownersCatalogFilter||'all',sort=state.ownersCatalogSort||'recent';
    page.querySelector('h1').textContent=t.title;page.querySelector('.pwHeading p').textContent=t.subtitle;
    const add=document.getElementById('btnAddOwner');if(add){add.removeAttribute('data-i18n');add.innerHTML=`${icon('plus')}<span>${esc(t.add)}</span>`;}
    const missingCount=owners.filter(owner=>!hasContacts(owner)).length;
    view.querySelector('.ownersOverview').innerHTML=`<span><strong id="ownersTotalCount">${owners.length}</strong> ${esc(t.owners)}</span><span><strong id="ownersPatientsCount">${patients.length}</strong> ${esc(t.patients)}</span><span class="${missingCount?'pwNeedsContact':''}"><strong id="ownersMissingContactsCount">${missingCount}</strong> ${esc(t.noContacts)}</span>`;
    const labels={'all':t.all,'with-pets':t.with,'without-pets':t.without,'missing-contacts':t.missing};
    page.querySelector('.ownersFilterGroup').setAttribute('aria-label',t.title);
    page.querySelectorAll('[data-owners-filter]').forEach(button=>{button.textContent=labels[button.dataset.ownersFilter];const active=button.dataset.ownersFilter===filter;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    const sortInput=document.getElementById('ownersSortSelect');sortInput.value=sort;sortInput.setAttribute('aria-label',t.sort);
    page.querySelector('.ownersSortControl>span').textContent=t.sort;
    [...sortInput.options].forEach(option=>option.textContent=({recent:t.recent,name:t.nameSort,pets:t.petsSort})[option.value]);
    page.querySelector('.pwColumns').innerHTML=`<span>${esc(t.owner)}</span><span>${esc(t.contacts)}</span><span>${esc(t.pets)}</span><span></span>`;
    let visible=owners.filter(owner=>{
      const pets=petsOf(owner.id);
      const fields=[owner.name,owner.email,owner.telegram,owner.note,...pets.flatMap(pet=>[pet.name,pet.breed,pet.species])];
      if(!matchesClientSearch(query,fields,owner.phone))return false;
      return filter==='with-pets'?pets.length>0:filter==='without-pets'?pets.length===0:filter==='missing-contacts'?!hasContacts(owner):true;
    });
    if(sort==='name')visible=[...visible].sort((a,b)=>contact(a.name).localeCompare(contact(b.name),getInterfaceLanguage(),{sensitivity:'base'}));
    if(sort==='pets')visible=[...visible].sort((a,b)=>petsOf(b.id).length-petsOf(a.id).length);
    grid.innerHTML=visible.map(owner=>{
      const id=esc(owner.id),name=contact(owner.name)||t.unnamed,initials=name.split(/\s+/).slice(0,2).map(word=>word.charAt(0).toUpperCase()).join('');
      const pets=petsOf(owner.id),matches=pet=>query&&[pet.name,pet.breed,pet.species].filter(Boolean).join(' ').toLowerCase().includes(query);
      const ordered=query?[...pets.filter(matches),...pets.filter(pet=>!matches(pet))]:pets;
      const petsTitle=pets.map(pet=>[contact(pet.name)||t.unnamedPet,pet.breed||pet.species].filter(Boolean).join(' · ')).join(', ');
      const phone=contact(owner.phone),email=contact(owner.email),telegram=contact(owner.telegram),note=contact(owner.note);
      const contactHtml=phone?`<button type="button" class="ownerCatalogContact ownerPhoneCopy" data-copy-owner-phone="${esc(phone)}" title="${esc(t.copy)}" aria-label="${esc(t.copy+': '+phone)}">${icon('phone')}<span>${esc(phone)}</span><span class="ownerPhoneCopyLabel" role="status">${esc(t.copy)}</span></button>`:'';
      const other=email||telegram;
      return `<article class="ownerCatalogCard pwOwnerRow" data-open-owner="${id}">
        <div class="pwIdentity"><span class="ownerCatalogAvatar" aria-hidden="true">${esc(initials)}</span><div><button type="button" class="pwOwnerName" data-open-owner="${id}">${esc(name)}</button>${note?`<small class="pwOwnerNote" title="${esc(note)}">${esc(note)}</small>`:''}</div></div>
        <div class="ownerCatalogContacts">${contactHtml}${other?`<span class="ownerCatalogContact ${phone?'pwSecondaryContact':''}">${icon(email?'mail':'message')}<span>${esc(other)}</span></span>`:''}${!hasContacts(owner)?`<span class="pwMissingContact">${esc(t.missing)}</span>`:''}</div>
        <div class="ownerCatalogPets" title="${esc(petsTitle)}">${pets.length?ordered.slice(0,2).map(pet=>`<button type="button" class="ownerCatalogPet" data-open-client-pet="${esc(pet.id)}" title="${esc([pet.name,pet.breed||pet.species].filter(Boolean).join(' · '))}">${icon('paw')}<span>${esc(contact(pet.name)||t.unnamedPet)}</span></button>`).join('')+(pets.length>2?`<span class="ownerCatalogPetMore" aria-label="${esc(petsTitle)}">+${pets.length-2}</span>`:''):`<span class="ownerCatalogPetsEmpty">${esc(t.noPets)}</span>`}</div>
        <div class="pwRowActions"><button type="button" class="ownerCatalogOpen" data-open-owner="${id}" aria-label="${esc(t.open+': '+name)}">${esc(t.open)}${icon('arrow')}</button>
          <div class="ownerCatalogActions"><button type="button" class="ownerCatalogMenuButton" data-owner-menu="${id}" aria-label="${esc(t.actions+': '+name)}" aria-expanded="false">${icon('more')}</button>
          <div class="ownerCatalogMenu" data-owner-menu-panel="${id}"><button type="button" data-edit-owner="${id}">${icon('edit')}${esc(t.edit)}</button><button type="button" class="ownerCatalogDelete" data-delete-owner="${id}">${icon('trash')}${esc(t.remove)}</button></div></div></div>
      </article>`;
    }).join('');
    page.querySelector('.pwResultCount').textContent=t.shown.replace('{count}',visible.length).replace('{total}',owners.length);
    grid.hidden=!visible.length;empty.hidden=visible.length>0;
    if(!visible.length)empty.innerHTML=`${icon('search')}<h2>${esc(owners.length?t.empty:t.first)}</h2><p>${esc(owners.length?t.emptyHint:t.firstHint)}</p><button type="button" ${owners.length?'data-owner-reset':'data-action="add-owner"'}>${esc(owners.length?t.reset:t.add)}</button>`;
    view.hidden=false;
    return true;
  };
})();
