/* A supplier payment is recorded once in the ledger; no banking API is called. */
function stockPaymentText(value) {
  const labels = {
    "Зафіксувати оплату": ["Record payment", "Zahlung erfassen", "Zarejestruj płatność"],
    "Доплатити": ["Record remaining payment", "Restzahlung erfassen", "Zarejestruj dopłatę"],
    "Фактична оплата": ["Actual payment", "Tatsächliche Zahlung", "Faktyczna płatność"],
    "Сума оплати": ["Payment amount", "Zahlungsbetrag", "Kwota płatności"],
    "Фінансовий рахунок": ["Financial account", "Finanzkonto", "Rachunek finansowy"],
    "Оберіть рахунок": ["Choose account", "Konto wählen", "Wybierz rachunek"],
    "Баланс рахунку": ["Account balance", "Kontostand", "Saldo rachunku"],
    "Після оплати": ["After payment", "Nach Zahlung", "Po płatności"],
    "Підтвердити оплату": ["Confirm payment", "Zahlung bestätigen", "Potwierdź płatność"],
    "Оплата вже відбулася. Підтверджую суму та рахунок.": ["The payment has occurred. I confirm the amount and account.", "Die Zahlung ist erfolgt. Ich bestätige Betrag und Konto.", "Płatność została wykonana. Potwierdzam kwotę i rachunek."],
    "Це облік фактичної оплати, а не переказ грошей у банку.": ["This records an actual payment; it does not make a bank transfer.", "Dies erfasst eine erfolgte Zahlung, keine Banküberweisung.", "To zapis faktycznej płatności, nie przelew bankowy."],
    "Сума повинна бути більшою за нуль і не перевищувати залишок.": ["Enter a positive amount no greater than the balance due.", "Geben Sie einen positiven Betrag bis zum offenen Betrag ein.", "Wpisz dodatnią kwotę nie większą niż pozostała do zapłaty."],
    "Немає активного рахунку у валюті закупівлі.": ["No active account in the purchase currency.", "Kein aktives Konto in der Einkaufswährung.", "Brak aktywnego rachunku w walucie zakupu."],
    "Перевірте початкові залишки та поповнення: баланс стане від’ємним.": ["Check opening balances and deposits: the balance will be negative.", "Anfangsbestände und Einzahlungen prüfen: Der Saldo wird negativ.", "Sprawdź salda początkowe i wpłaty: saldo będzie ujemne."],
    "Повторити перевірку": ["Check again", "Erneut prüfen", "Sprawdź ponownie"],
    "Оновити документ": ["Refresh document", "Dokument aktualisieren", "Odśwież dokument"],
    "Оплату зафіксовано. Оновіть документ.": ["Payment recorded. Refresh the document.", "Zahlung erfasst. Aktualisieren Sie das Dokument.", "Płatność zapisana. Odśwież dokument."],
    "Результат не підтверджено. Повторіть перевірку тим самим запитом.": ["Result unconfirmed. Check again using the same request.", "Ergebnis unbestätigt. Mit derselben Anfrage erneut prüfen.", "Wynik niepotwierdzony. Sprawdź ponownie tym samym żądaniem."],
    "Останні оплати": ["Recent payments", "Letzte Zahlungen", "Ostatnie płatności"],
    "Платежів ще немає.": ["No payments yet.", "Noch keine Zahlungen.", "Brak płatności."],
    "Оплату зафіксовано. Фінансові дані оновлено.": ["Payment recorded. Financial data updated.", "Zahlung erfasst. Finanzdaten aktualisiert.", "Płatność zapisana. Dane finansowe zaktualizowane."],
  };
  const index = {en:0,de:1,pl:2}[getInterfaceLanguage()];
  return labels[value] && index !== undefined ? labels[value][index] : stockWorkspaceText(value);
}

function stockPaymentMoney(value, allowZero = false) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(text)) throw Error("Invalid money");
  const [whole, fraction = ""] = text.split(".");
  const canonical = `${whole}.${fraction.padEnd(2,"0")}`;
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2,"0"));
  if (cents > 100000000000n || cents < (allowZero ? 0n : 1n)) throw Error("Invalid money");
  return {canonical, cents};
}

function stockPaymentRequestKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
  return [...bytes].map((b,i)=>([4,6,8,10].includes(i)?"-":"")+b.toString(16).padStart(2,"0")).join("");
}

async function postStockSupplierPayment(purchaseId, payload) {
  const response = await fetch(`/api/finance/purchases/${encodeURIComponent(purchaseId)}/payments`, {
    method:"POST",credentials:"include",headers:{"Content-Type":"application/json",...getOrgHeaders()},body:JSON.stringify(payload),
  });
  const result = await response.json().catch(()=>null);
  if (!response.ok || result?.ok !== true || !result.data?.transaction_id) {
    const error = Error(result?.error || stockPaymentText("Результат не підтверджено. Повторіть перевірку тим самим запитом."));
    error.status=response.status; error.code=result?.code;
    throw error;
  }
  return result.data;
}

async function openStockSupplierPayment(purchase, onPaid, documentOptions = {}) {
  document.querySelector(".stockPaymentOverlay")?.remove();
  const text = value=>escapeHtml(stockPaymentText(value));
  const overlay=document.createElement("div"); overlay.className="stockPaymentOverlay";
  overlay.innerHTML=`<section class="stockPaymentForm" role="dialog" aria-modal="true" aria-label="${text("Фактична оплата")}"><p role="status">${text("Завантаження…")}</p><button type="button" data-payment-close>${text("Закрити")}</button></section>`;
  document.body.appendChild(overlay);
  let busy=false, requestPayload=null;
  const close=()=>{if(busy)return;overlay.remove();restoreFocus();};
  const restoreFocus=bindStockDialogKeyboard(overlay,close);
  overlay.addEventListener("click",event=>{if(event.target===overlay||event.target.closest("[data-payment-close]"))close();});
  overlay.querySelector("button").focus({preventScroll:true});
  try {
    const state=await stockApiRequest(`/api/finance/purchases/${encodeURIComponent(purchase.id)}/payment-state`,{method:"GET"});
    if(!overlay.isConnected)return;
    const current=state.purchase;
    const remaining=stockPaymentMoney(current.remaining_amount,true);
    const currency=current.currency;
    const accounts=(state.accounts||[]).filter(a=>a.currency===currency&&["cash","bank","safe"].includes(a.account_type));
    if(!remaining.cents||current.status==="cancelled"||!accounts.length){
      overlay.querySelector("p").textContent=stockPaymentText(!accounts.length?"Немає активного рахунку у валюті закупівлі.":"Оновити документ");return;
    }
    overlay.innerHTML=`<form class="stockPaymentForm" role="dialog" aria-modal="true" aria-labelledby="stockPaymentTitle">
      <header><span class="stockDocumentIcon">${getStockIcon("wallet")}</span><div><span class="stockDocumentEyebrow">${text("Фактична оплата")}</span><h2 id="stockPaymentTitle">${escapeHtml(purchase.supplier?.name||stockPaymentText("Закупівля"))}</h2></div><button type="button" data-payment-close aria-label="${text("Закрити")}">${getStockIcon("close")}</button></header>
      <div class="stockPaymentBody"><p>${text("Це облік фактичної оплати, а не переказ грошей у банку.")}</p>
        <div class="stockPaymentDue"><span>${text("Залишок за документом")}</span><strong>${escapeHtml(formatClinicMoney(current.remaining_amount,currency))}</strong></div>
        <label><span>${text("Фінансовий рахунок")}</span><select name="account" required><option value="">${text("Оберіть рахунок")}</option>${accounts.map(a=>`<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} · ${escapeHtml(formatClinicMoney(a.balance,currency))}</option>`).join("")}</select></label>
        <label><span>${text("Сума оплати")} · ${escapeHtml(currency)}</span><input type="text" name="amount" inputmode="decimal" autocomplete="off" required value="${remaining.canonical}"></label>
        <div class="stockPaymentProjection"><span>${text("Баланс рахунку")}: <b data-payment-before>—</b></span><span>${text("Після оплати")}: <b data-payment-after>—</b></span></div>
        <p class="stockPaymentWarning" hidden>${text("Перевірте початкові залишки та поповнення: баланс стане від’ємним.")}</p>
        <label><span>${text("Примітка")}</span><textarea name="note" rows="2" maxlength="500"></textarea></label>
        <label class="stockPaymentConfirm"><input type="checkbox" name="confirmed" required><span>${text("Оплата вже відбулася. Підтверджую суму та рахунок.")}</span></label>
        <p class="stockPaymentError" role="alert" hidden></p>
      </div><footer><button type="button" data-payment-close>${text("Скасувати")}</button><button type="button" data-payment-refresh hidden>${text("Оновити документ")}</button><button type="submit" data-payment-submit disabled>${text("Підтвердити оплату")}</button></footer>
    </form>`;
    const form=overlay.querySelector("form"), submit=form.querySelector("[data-payment-submit]"), errorBox=form.querySelector(".stockPaymentError");
    const inputs=[form.elements.account,form.elements.amount,form.elements.note,form.elements.confirmed];
    const update=()=>{
      if(requestPayload)return;
      let amount=null;try{amount=stockPaymentMoney(form.elements.amount.value);}catch{}
      const account=accounts.find(a=>a.id===form.elements.account.value);
      const valid=Boolean(amount&&amount.cents<=remaining.cents&&account);
      submit.disabled=!valid||!form.elements.confirmed.checked;
      form.querySelector("[data-payment-before]").textContent=account?formatClinicMoney(account.balance,currency):"—";
      form.querySelector("[data-payment-after]").textContent=account&&amount?formatClinicMoney((Number(account.balance)-Number(amount.canonical)).toFixed(2),currency):"—";
      form.querySelector(".stockPaymentWarning").hidden=!(account&&amount&&Number(account.balance)<Number(amount.canonical));
      if(form.elements.amount.value&&!amount||amount&&amount.cents>remaining.cents){errorBox.hidden=false;errorBox.textContent=stockPaymentText("Сума повинна бути більшою за нуль і не перевищувати залишок.");}
      else {errorBox.hidden=true;}
    };
    form.addEventListener("input",update);form.addEventListener("change",update);update();
    form.elements.account.focus({preventScroll:true});
    form.querySelector("[data-payment-refresh]").addEventListener("click",()=>{
      close();void openStockPurchaseDocument(purchase.id,documentOptions);
    });
    form.addEventListener("submit",async event=>{
      event.preventDefault();if(busy)return;
      if(!requestPayload){
        let amount;try{amount=stockPaymentMoney(form.elements.amount.value);}catch{return;}
        if(amount.cents>remaining.cents||!form.elements.confirmed.checked||!accounts.some(a=>a.id===form.elements.account.value))return;
        requestPayload={amount:amount.canonical,financial_account_id:form.elements.account.value,
          expected_paid_amount:stockPaymentMoney(current.paid_amount,true).canonical,
          expected_total_amount:stockPaymentMoney(current.total_amount).canonical,currency,
          idempotency_key:stockPaymentRequestKey(),note:form.elements.note.value.trim()};
      }
      busy=true;form.inert=true;form.setAttribute("aria-busy","true");submit.disabled=true;errorBox.hidden=true;
      let result;
      try {result=await postStockSupplierPayment(purchase.id,requestPayload);}
      catch(error){
        busy=false;form.inert=false;form.removeAttribute("aria-busy");errorBox.hidden=false;errorBox.textContent=error.status ? error.message : stockPaymentText("Результат не підтверджено. Повторіть перевірку тим самим запитом.");
        if([400,403,404,409,503].includes(error.status)){
          inputs.forEach(input=>{input.disabled=true;});submit.hidden=true;form.querySelector("[data-payment-refresh]").hidden=false;
        }else{
          inputs.forEach(input=>{input.disabled=true;});submit.textContent=stockPaymentText("Повторити перевірку");submit.disabled=false;
        }
        return;
      }
      busy=false;close();
      try {if(onPaid)await onPaid(result);}
      catch {
        overlay.innerHTML=`<section class="stockPaymentForm" role="dialog" aria-modal="true"><p role="status">${text("Оплату зафіксовано. Оновіть документ.")}</p><button type="button" data-payment-close>${text("Закрити")}</button></section>`;
        document.body.appendChild(overlay);overlay.querySelector("button").focus();
      }
    });
  } catch(error) {
    if(overlay.isConnected)overlay.querySelector("p").textContent=error.message||stockPaymentText("Оновити документ");
  }
}

async function loadStockSupplierPaymentHistory(details,purchaseId) {
  if(!details.open||details.dataset.loaded||details.dataset.loading)return;
  details.dataset.loading="true";
  const body=details.querySelector(".stockDocumentPaymentRows");
  body.textContent=stockPaymentText("Завантаження…");
  try{
    const data=await stockApiRequest(`/api/finance/purchases/${encodeURIComponent(purchaseId)}/payment-state`,{method:"GET"});
    if(!details.isConnected)return;
    body.innerHTML=(data.payments||[]).map(payment=>`<article><div><strong>${escapeHtml(formatClinicMoney(payment.amount,payment.currency))}</strong><small>${escapeHtml(payment.account_name||"—")} · ${escapeHtml(new Date(payment.occurred_at).toLocaleString(getCalendarLocale()))}</small>${payment.note?`<p>${escapeHtml(payment.note)}</p>`:""}</div></article>`).join("")||`<p>${escapeHtml(stockPaymentText("Платежів ще немає."))}</p>`;
    details.dataset.loaded="true";
  }catch(error){body.textContent=error.message||stockPaymentText("Оновити документ");}
  finally{delete details.dataset.loading;}
}
