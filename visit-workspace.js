/* Clinical workspace: rearrange existing fields without replacing their handlers. */
(() => {
 const copy={uk:{ownerTitle:'План для власника',ownerHint:'Призначення та рекомендації з цього блоку увійдуть до виписки.',ownerBadge:'У виписці',exam:'Огляд пацієнта',examHint:'Причина звернення, анамнез і об’єктивні показники.',assessment:'Оцінка та діагноз',assessmentHint:'Клінічні висновки та план діагностики.',care:'Лікування та рекомендації',careHint:'Допомога на прийомі та подальший план для власника.',ai:'Оформлення та клінічний консультант',save:'Зберегти',bill:'Рахунок',draft:'Чернетка',active:'Триває',done:'Завершено'},en:{ownerTitle:'Plan for the owner',ownerHint:'Prescriptions and recommendations from this section appear in the discharge document.',ownerBadge:'In the discharge document',exam:'Patient examination',examHint:'Reason for visit, history and objective findings.',assessment:'Assessment and diagnosis',assessmentHint:'Clinical findings and diagnostic plan.',care:'Treatment and recommendations',careHint:'Care provided and the owner’s follow-up plan.',ai:'Documentation and clinical assistant',save:'Save',bill:'Invoice',draft:'Draft',active:'In progress',done:'Completed'},de:{ownerTitle:'Plan für den Tierhalter',ownerHint:'Verordnungen und Empfehlungen aus diesem Abschnitt erscheinen im Entlassungsbericht.',ownerBadge:'Im Entlassungsbericht',exam:'Untersuchung',examHint:'Vorstellungsgrund, Anamnese und objektive Befunde.',assessment:'Beurteilung und Diagnose',assessmentHint:'Klinische Beurteilung und diagnostischer Plan.',care:'Behandlung und Empfehlungen',careHint:'Durchgeführte Behandlung und weiterer Plan.',ai:'Dokumentation und klinischer Assistent',save:'Speichern',bill:'Rechnung',draft:'Entwurf',active:'In Behandlung',done:'Abgeschlossen'},pl:{ownerTitle:'Plan dla opiekuna',ownerHint:'Zalecenia z tej sekcji znajdą się w wypisie.',ownerBadge:'W wypisie',exam:'Badanie pacjenta',examHint:'Powód wizyty, wywiad i wyniki badania.',assessment:'Ocena i rozpoznanie',assessmentHint:'Wnioski kliniczne i plan diagnostyczny.',care:'Leczenie i zalecenia',careHint:'Wykonane czynności i dalszy plan dla opiekuna.',ai:'Dokumentacja i asystent kliniczny',save:'Zapisz',bill:'Rachunek',draft:'Szkic',active:'W toku',done:'Zakończona'}};
 const words=()=>copy[getInterfaceLanguage()]||copy.uk;
 const glyph=name=>name==='sparkles'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z"/></svg>':getStockIcon(name);
 function heading(section,title,description,name){
   let head=section.querySelector(':scope>.visitSectionHead');if(!head){head=document.createElement('header');head.className='visitSectionHead';section.prepend(head);}
   head.innerHTML=`<div><span class="visitSectionIcon" aria-hidden="true">${glyph(name)}</span><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div></div>`;
 }
 window.mountPugVisitWorkspace=(visit,pet)=>{
   const page=document.querySelector('.page[data-page="visit"]'),workspace=page?.querySelector('.visitWorkspace'),main=workspace?.querySelector('.visitWorkspaceMain');if(!main)return;
   const t=words();page.classList.add('pugVisitWorkspace');workspace.id='pugVisitWorkspaceRoot';
   const exam=main.querySelector('.visitSectionCard:has(#visitReasonForVisit)');
   if(exam&&!workspace.dataset.clinicalLayout){
     const grid=exam.querySelector('.visitMedicalGrid'),assessment=document.createElement('section'),care=document.createElement('section');assessment.className='visitSectionCard vwAssessmentCard';care.className='visitSectionCard vwCareCard';
     const assessmentGrid=document.createElement('div'),careGrid=document.createElement('div');assessmentGrid.className=careGrid.className='visitMedicalGrid';assessment.append(assessmentGrid);care.append(careGrid);
     const assessmentBlock=grid.querySelector('.visitAssessmentBlock'),diagnosticPlan=grid.querySelector('#visitDiagnosticPlan')?.closest('label'),performed=grid.querySelector('#visitPerformedCare')?.closest('label'),communication=grid.querySelector('.visitOwnerCommunication'),legacy=grid.querySelector('#visitMedRx');
     [assessmentBlock,diagnosticPlan].filter(Boolean).forEach(el=>assessmentGrid.append(el));[performed,legacy,communication].filter(Boolean).forEach(el=>careGrid.append(el));grid.querySelector('.visitActionGrid')?.remove();
     exam.after(assessment,care);workspace.dataset.clinicalLayout='1';
   }
   if(exam)heading(exam,t.exam,t.examHint,'medical');
   const assessment=main.querySelector('.vwAssessmentCard'),care=main.querySelector('.vwCareCard');if(assessment)heading(assessment,t.assessment,t.assessmentHint,'shield');if(care)heading(care,t.care,t.careHint,'capsule');
   workspace.querySelectorAll('.visitSectionIcon').forEach(el=>{if(!el.querySelector('svg'))el.innerHTML=glyph(el.closest('.visitSectionCard')?.querySelector('#visitStkSearch')?'box':'layers');});
   workspace.querySelectorAll('.visitSummaryAvatar').forEach(el=>el.innerHTML=glyph('paw'));
   workspace.querySelectorAll('.visitServicePickerIcon').forEach(el=>el.innerHTML=glyph('medical'));
   const servicesStage=workspace.querySelector('[data-visit-stage-target="#visitSvcSearch"]');if(servicesStage)servicesStage.dataset.visitStageTarget='.visitSectionCard:has(#visitSvcSelect)';
   const stageTargets=['.visitSectionCard:has(#visitReasonForVisit)','.vwAssessmentCard','.vwCareCard','.visitSectionCard:has(#visitSvcSelect)','.visitWorkspaceSidebar'];
   workspace.querySelectorAll('[data-visit-stage-target]').forEach((button,index)=>{if(stageTargets[index])button.dataset.visitStageTarget=stageTargets[index];});
   const ownerHead=workspace.querySelector('.visitOwnerCommunicationHead');
   if(ownerHead)ownerHead.innerHTML=`<div class="vwOwnerHeading"><span class="vwOwnerIcon" aria-hidden="true">${glyph('medical')}</span><div><strong>${escapeHtml(t.ownerTitle)}</strong><span>${escapeHtml(t.ownerHint)}</span></div></div><span class="visitOwnerCommunicationBadge">${escapeHtml(t.ownerBadge)}</span>`;
   const title=workspace.querySelector('.visitWorkspaceHeader h1');if(title&&pet?.name)title.textContent=pet.name;
   const completed=Boolean(visit?.completed_at||visit?.closed_by)||['completed','done','finished'].includes(String(visit?.status||visit?.calendar_status||'').toLowerCase());
   const status=workspace.querySelector('.visitWorkspaceStatus');if(status){status.dataset.state=completed?'completed':['in_progress','active','started'].includes(String(visit?.status||visit?.calendar_status))?'active':'draft';status.querySelectorAll(':scope>span:not(.visitWorkspaceStatusDot)').forEach(el=>el.remove());[...status.childNodes].filter(el=>el.nodeType===3).forEach(el=>el.remove());const label=document.createElement('span');label.textContent=completed?t.done:status.dataset.state==='active'?t.active:t.draft;status.append(label);}
   const ai=workspace.querySelector('#visitAiWorkspace');if(ai){
     let details=workspace.querySelector('.vwAiDisclosure');if(!details){details=document.createElement('details');details.className='vwAiDisclosure';const summary=document.createElement('summary');summary.innerHTML=`<span class="vwAiGlyph">${glyph('sparkles')}</span><strong>PUG AI</strong><span class="vwAiCaption">${escapeHtml(t.ai)}</span><span class="vwAiChevron">${glyph('chevron')}</span>`;details.append(summary);ai.before(details);details.append(ai);}
     const launcher=workspace.querySelector('#visitAiConsultLauncher');if(launcher){const original=launcher.onclick;launcher.onclick=event=>{details.open=true;original?.call(launcher,event);details.scrollIntoView({behavior:'smooth',block:'start'});};}
   }
   // Strip decorative emoji from system buttons, never from clinical input values.
   workspace.querySelectorAll('#visitMedSave,#btnPrintVisitPdf,#visitCompleteButton,[data-ai-workspace-tab],#visitAiRecordText').forEach(el=>{
     [...el.childNodes].filter(node=>node.nodeType===3).forEach(node=>node.nodeValue=node.nodeValue.replace(/^[^\p{L}\p{N}]+/u,''));
   });
   workspace.querySelectorAll('#visitAiRecordIcon,.visitAiConsultLauncherIcon').forEach(el=>el.innerHTML=glyph('sparkles'));
   const save=workspace.querySelector('#visitMedSave');
   let bar=workspace.querySelector('.vwMobileActions');if(!bar){bar=document.createElement('div');bar.className='vwMobileActions';const bill=document.createElement('button');bill.type='button';bill.className='vwMobileBill';bill.onclick=()=>workspace.querySelector('[data-visit-stage-target=".visitWorkspaceSidebar"]')?.click();const quick=document.createElement('button');quick.type='button';quick.className='vwMobileSave';quick.onclick=()=>workspace.querySelector('#visitMedSave')?.click();bar.append(bill,quick);workspace.append(bar);}
   bar.querySelector('.vwMobileBill').textContent=t.bill;
   const sync=()=>{const quick=bar.querySelector('.vwMobileSave');quick.disabled=Boolean(save?.disabled);quick.textContent=save?.disabled?save.textContent:t.save;};sync();
   if(save&&!save.dataset.vwObserved){new MutationObserver(sync).observe(save,{attributes:true,attributeFilter:['disabled'],childList:true,subtree:true});save.dataset.vwObserved='1';}
 };
})();
