/* Inventory navigation over the existing, organization-scoped purchasing APIs. */
function stockWorkspaceText(value) {
  const labels = {
    "Новий товар": ["New item", "Neuer Artikel", "Nowy towar"],
    "Залишок буде додано під час приймання закупівлі.": ["Stock will be added when the purchase is received.", "Der Bestand wird beim Wareneingang hinzugefügt.", "Stan zostanie dodany przy przyjęciu zakupu."],
    "Замовлення → приймання → залишки на складі": ["Order → receive → stock", "Bestellung → Wareneingang → Bestand", "Zamówienie → przyjęcie → stan"],
    "Збереження замовлення не змінює залишки. Товар надійде на склад після приймання.": ["Saving an order does not change stock. Items enter inventory after receipt.", "Eine Bestellung ändert den Bestand nicht. Erst der Wareneingang erhöht ihn.", "Zapis zamówienia nie zmienia stanów. Towar trafi do magazynu po przyjęciu."],
    "Додаткові дані": ["Additional details", "Weitere Angaben", "Dodatkowe dane"],
    "За потреби": ["Optional", "Optional", "Opcjonalnie"],
    "Зберегти замовлення": ["Save order", "Bestellung speichern", "Zapisz zamówienie"],
    "Пошук у каталозі": ["Search inventory", "Bestand durchsuchen", "Szukaj w katalogu"],
    "Вкажіть фактично отриману кількість. Лише ці товари буде додано на склад.": ["Enter the quantities actually delivered. Only these items will be added to stock.", "Geben Sie die tatsächlich erhaltenen Mengen ein. Nur diese werden eingebucht.", "Wpisz faktycznie otrzymane ilości. Tylko one zostaną dodane do magazynu."],
    "Залишиться отримати": ["Still expected", "Noch ausstehend", "Pozostanie do przyjęcia"],
    "Перевірте кількість": ["Check quantity", "Menge prüfen", "Sprawdź ilość"],
    "Позицій до приймання": ["Items to receive", "Anzunehmende Positionen", "Pozycje do przyjęcia"],
    "Підтвердити приймання": ["Confirm receipt", "Wareneingang bestätigen", "Potwierdź przyjęcie"],
    "Додайте постачальника, щоб створити замовлення.": ["Add a supplier to create an order.", "Fügen Sie einen Lieferanten hinzu, um zu bestellen.", "Dodaj dostawcę, aby utworzyć zamówienie."],
    "Залишки": ["Inventory", "Bestand", "Stany"],
    "Закупівлі": ["Purchases", "Einkäufe", "Zakupy"],
    "Постачальники": ["Suppliers", "Lieferanten", "Dostawcy"],
    "Нова закупівля": ["New purchase", "Neuer Einkauf", "Nowy zakup"],
    "Новий постачальник": ["New supplier", "Neuer Lieferant", "Nowy dostawca"],
    "Замовлення, поставки та їх оплата в одному списку.": ["Orders, deliveries and payments in one list.", "Bestellungen, Lieferungen und Zahlungen in einer Liste.", "Zamówienia, dostawy i płatności na jednej liście."],
    "Контакти та реквізити ваших постачальників.": ["Your suppliers’ contacts and details.", "Kontakte und Angaben Ihrer Lieferanten.", "Kontakty i dane dostawców."],
    "Закупівель за цими умовами немає.": ["No purchases match these filters.", "Keine Einkäufe für diese Filter.", "Brak zakupów dla tych filtrów."],
    "Постачальників не знайдено.": ["No suppliers found.", "Keine Lieferanten gefunden.", "Nie znaleziono dostawców."],
    "Не вдалося завантажити дані. Повторіть спробу.": ["Could not load data. Please try again.", "Daten konnten nicht geladen werden. Bitte erneut versuchen.", "Nie udało się wczytać danych. Spróbuj ponownie."],
    "Усі поставки": ["All deliveries", "Alle Lieferungen", "Wszystkie dostawy"],
    "Усі оплати": ["All payments", "Alle Zahlungen", "Wszystkie płatności"],
    "Пошук за назвою постачальника": ["Search supplier name", "Nach Lieferantennamen suchen", "Szukaj dostawcy po nazwie"],
    "Знайти": ["Search", "Suchen", "Szukaj"],
    "Закупівлі постачальника": ["Supplier purchases", "Einkäufe beim Lieferanten", "Zakupy u dostawcy"],
    "Попередні": ["Previous", "Zurück", "Poprzednie"],
    "Наступні": ["Next", "Weiter", "Następne"],
    "Закупівлю створено. Залишок зміниться після приймання.": ["Purchase created. Stock changes after receipt.", "Einkauf erstellt. Der Bestand ändert sich nach dem Wareneingang.", "Zakup utworzony. Stan zmieni się po przyjęciu."],
    "Поставку прийнято. Залишки оновлено.": ["Delivery received. Inventory updated.", "Lieferung angenommen. Bestand aktualisiert.", "Dostawa przyjęta. Stany zaktualizowane."],
    "Постачальника додано.": ["Supplier added.", "Lieferant hinzugefügt.", "Dostawca dodany."],
    "Навігація складу": ["Inventory navigation", "Lagernavigation", "Nawigacja magazynu"],
  };
  const language = getInterfaceLanguage();
  const index = { en: 0, de: 1, pl: 2 }[language];
  if (labels[value] && index !== undefined) return labels[value][index];
  const financeText = getFinanceInterfaceText(value);
  return financeText !== value ? financeText : getStockInterfaceText(value);
}

function bindStockDialogKeyboard(overlay, close) {
  const previousFocus = document.activeElement;
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
    if (event.key !== "Tab") return;
    const focusable = [...overlay.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex="0"]')]
      .filter(element => !element.disabled && element.getClientRects().length);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  return () => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
}

function mountStockNavigation(page) {
  if (!isOwnerOrAdmin()) return;
  const container = page.querySelector(".stockPremiumPage");
  if (!container) return;
  const selected = state.stockSection || "balances";
  container.insertAdjacentHTML("afterbegin", `<nav class="stockWorkspaceNav" aria-label="${escapeHtml(stockWorkspaceText("Навігація складу"))}">
    ${[["balances", "Залишки", "box"], ["purchases", "Закупівлі", "layers"], ["suppliers", "Постачальники", "partners"]].map(([key, label, icon]) =>
      `<button type="button" data-stock-section="${key}" ${selected === key ? 'aria-current="page"' : ""}>${getStockIcon(icon)}${escapeHtml(stockWorkspaceText(label))}</button>`
    ).join("")}
  </nav>`);
  container.querySelectorAll("[data-stock-section]").forEach(button => {
    button.addEventListener("click", () => {
      state.stockSection = button.dataset.stockSection;
      state.stockWorkspaceNotice = "";
      renderStockTab();
      page.querySelector(`[data-stock-section="${state.stockSection}"]`)?.focus({ preventScroll: true });
    });
  });
}

async function renderStockWorkspace(page, section) {
  const version = page._stockWorkspaceVersion;
  const current = () => page.isConnected && page._stockWorkspaceVersion === version && state.stockSection === section;
  const suppliersView = section === "suppliers";
  const text = value => escapeHtml(stockWorkspaceText(value));
  page._stockLocalizationObserver?.disconnect();
  page.innerHTML = `<div class="stockPremiumPage stockWorkspace">
    <header class="stockPremiumHero">
      <div><div class="stockPremiumEyebrow">${text("ОБЛІК КЛІНІКИ")}</div>
        <h1>${text(suppliersView ? "Постачальники" : "Закупівлі")}</h1>
        <p>${text(suppliersView ? "Контакти та реквізити ваших постачальників." : "Замовлення, поставки та їх оплата в одному списку.")}</p>
      </div>
      <button class="stockPremiumAddButton" type="button" id="stockWorkspaceCreate">${getStockIcon("plus")}${text(suppliersView ? "Новий постачальник" : "Нова закупівля")}</button>
    </header>
    ${state.stockWorkspaceNotice ? `<p class="stockWorkspaceNotice" role="status">${text(state.stockWorkspaceNotice)}</p>` : ""}
    <div id="stockWorkspaceContent" aria-live="polite"><p class="stockWorkspaceState" role="status">${text("Завантаження…")}</p></div>
  </div>`;
  mountStockNavigation(page);
  const content = page.querySelector("#stockWorkspaceContent");
  const refresh = notice => {
    if (!current()) return;
    state.stockWorkspaceNotice = notice;
    state.stockPurchaseOffset = 0;
    renderStockTab();
  };
  page.querySelector("#stockWorkspaceCreate").addEventListener("click", () => {
    if (suppliersView) openFinanceSupplierCreateModal(() => refresh("Постачальника додано."));
    else openFinancePurchaseModal({ onCreated: () => {
      state.stockPurchaseStatus = "";
      state.stockPurchasePayment = "";
      state.stockPurchaseSupplier = "";
      state.stockPurchaseSupplierName = "";
      refresh("Закупівлю створено. Залишок зміниться після приймання.");
    } });
  });

  try {
    if (suppliersView) {
      const query = new URLSearchParams();
      if (state.stockSupplierSearch) query.set("search", state.stockSupplierSearch);
      const suppliers = await stockApiRequest(`/api/finance/suppliers?${query}`, { method: "GET" });
      if (!current()) return;
      if (!Array.isArray(suppliers)) throw new Error("Invalid suppliers response");
      content.innerHTML = `<form class="stockWorkspaceSearch" id="stockSupplierSearchForm">
        <label class="stockPremiumSearch">${getStockIcon("search")}<input type="search" name="search" maxlength="100" aria-label="${text("Пошук за назвою постачальника")}" placeholder="${text("Пошук за назвою постачальника")}" value="${escapeHtml(state.stockSupplierSearch || "")}"></label>
        <button type="submit">${text("Знайти")}</button></form>
        <div class="stockSupplierList">${suppliers.map(supplier => `<details class="stockSupplierCard">
          <summary>${getStockIcon("partners")}<span><strong>${escapeHtml(supplier.name)}</strong><small>${escapeHtml(supplier.contact_person || supplier.phone || "—")}</small></span>${getStockIcon("chevron")}</summary>
          <div class="stockSupplierDetail"><dl>${[["Телефон", supplier.phone], ["Email", supplier.email], ["ЄДРПОУ", supplier.edrpou], ["Адреса", supplier.address], ["Примітка", supplier.note]].filter(([, value]) => value).map(([label, value]) => `<div><dt>${text(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
            <button type="button" data-stock-supplier-purchases="${escapeHtml(supplier.id)}">${text("Закупівлі постачальника")}</button>
          </div></details>`).join("") || `<p class="stockWorkspaceState">${text("Постачальників не знайдено.")}</p>`}</div>`;
      content.querySelector("#stockSupplierSearchForm").addEventListener("submit", event => {
        event.preventDefault();
        state.stockSupplierSearch = new FormData(event.currentTarget).get("search").trim();
        renderStockTab();
      });
      content.querySelectorAll("[data-stock-supplier-purchases]").forEach(button => {
        button.addEventListener("click", () => {
          state.stockPurchaseSupplier = button.dataset.stockSupplierPurchases;
          state.stockPurchaseSupplierName = suppliers.find(s => String(s.id) === button.dataset.stockSupplierPurchases)?.name || "";
          state.stockPurchaseStatus = "";
          state.stockPurchasePayment = "";
          state.stockPurchaseOffset = 0;
          state.stockSection = "purchases";
          state.stockWorkspaceNotice = "";
          renderStockTab();
        });
      });
      return;
    }

    const offset = Math.max(0, Number(state.stockPurchaseOffset || 0));
    const params = new URLSearchParams({ limit: "20", offset: String(offset) });
    if (state.stockPurchaseStatus) params.set("status", state.stockPurchaseStatus);
    if (state.stockPurchasePayment) params.set("payment_status", state.stockPurchasePayment);
    if (state.stockPurchaseSupplier) params.set("supplier_id", state.stockPurchaseSupplier);
    const data = await stockApiRequest(`/api/finance/purchases?${params}`, { method: "GET" });
    if (!current()) return;
    if (!Array.isArray(data?.items)) throw new Error("Invalid purchases response");
    const purchases = data.items;
    const statuses = ["draft", "ordered", "partially_received", "received", "cancelled"];
    const payments = ["unpaid", "partial", "paid"];
    content.innerHTML = `<div class="stockWorkspaceFilters">
      <label><span>${text("Статус постачання")}</span><select id="stockPurchaseStatus" class="stockPremiumSelect"><option value="">${text("Усі поставки")}</option>${statuses.map(key => `<option value="${key}" ${state.stockPurchaseStatus === key ? "selected" : ""}>${text(getFinancePurchaseStatusMeta(key).label)}</option>`).join("")}</select>${getStockIcon("chevron")}</label>
      <label><span>${text("Статус оплати")}</span><select id="stockPurchasePayment" class="stockPremiumSelect"><option value="">${text("Усі оплати")}</option>${payments.map(key => `<option value="${key}" ${state.stockPurchasePayment === key ? "selected" : ""}>${text(getFinancePurchasePaymentMeta(key).label)}</option>`).join("")}</select>${getStockIcon("chevron")}</label>
      <button type="button" id="stockPurchaseReset">${text("Скинути фільтри")}</button>
    </div>
    ${state.stockPurchaseSupplierName ? `<p class="stockWorkspaceSupplierFilter">${text("Постачальник")}: <strong>${escapeHtml(state.stockPurchaseSupplierName)}</strong></p>` : ""}
    <div class="stockPurchaseList">${purchases.map(purchase => {
      const delivery = getFinancePurchaseStatusMeta(purchase.status);
      const payment = getFinancePurchasePaymentMeta(purchase.payment_status);
      return `<button type="button" class="stockPurchaseRow" data-stock-purchase="${escapeHtml(purchase.id)}">
        <span class="stockPurchaseIdentity">${getStockIcon("box")}<span><strong>${escapeHtml(purchase.purchase_number || stockWorkspaceText("Закупівля"))}</strong><small>${escapeHtml(formatFinancePurchaseDate(purchase.order_date))}</small></span></span>
        <span class="stockPurchaseSupplier">${escapeHtml(purchase.supplier?.name || stockWorkspaceText("Постачальник не вказаний"))}</span>
        <span class="stockPurchaseStatus ${delivery.className}">${text(delivery.label)}</span>
        <span class="stockPurchaseAmount">${escapeHtml(formatClinicMoney(purchase.total_amount, purchase.currency || "UAH"))}<small>${text(payment.label)}</small></span>
        ${getStockIcon("chevron")}
      </button>`;
    }).join("") || `<p class="stockWorkspaceState">${text("Закупівель за цими умовами немає.")}</p>`}</div>
    <div class="stockWorkspacePagination">
      <button type="button" id="stockPurchasePrevious" ${offset === 0 ? "disabled" : ""}>${text("Попередні")}</button>
      <span>${purchases.length ? `${offset + 1}–${offset + purchases.length}` : "0"}</span>
      <button type="button" id="stockPurchaseNext" ${data.pagination?.has_more ? "" : "disabled"}>${text("Наступні")}</button>
    </div>`;
    [["#stockPurchaseStatus", "stockPurchaseStatus"], ["#stockPurchasePayment", "stockPurchasePayment"]].forEach(([selector, key]) => {
      content.querySelector(selector).addEventListener("change", event => {
        state[key] = event.target.value;
        state.stockPurchaseOffset = 0;
        renderStockTab();
      });
    });
    content.querySelector("#stockPurchaseReset").addEventListener("click", () => {
      state.stockPurchaseStatus = state.stockPurchasePayment = state.stockPurchaseSupplier = state.stockPurchaseSupplierName = "";
      state.stockPurchaseOffset = 0;
      renderStockTab();
    });
    [["#stockPurchasePrevious", -20], ["#stockPurchaseNext", 20]].forEach(([selector, delta]) => {
      content.querySelector(selector).addEventListener("click", () => {
        state.stockPurchaseOffset = Math.max(0, offset + delta);
        renderStockTab();
      });
    });
    content.querySelectorAll("[data-stock-purchase]").forEach(button => {
      button.addEventListener("click", () => {
        const purchase = purchases.find(p => String(p.id) === button.dataset.stockPurchase);
        if (purchase) openFinancePurchaseDetailsModal(purchase, { onReceived: () => refresh("Поставку прийнято. Залишки оновлено.") });
      });
    });
  } catch (error) {
    if (!current()) return;
    content.innerHTML = `<div class="stockCatalogLoadError" role="alert"><p>${text("Не вдалося завантажити дані. Повторіть спробу.")}</p><button type="button" id="stockWorkspaceRetry">${text("Повторити")}</button></div>`;
    content.querySelector("#stockWorkspaceRetry").addEventListener("click", () => renderStockTab());
  }
}
