// =========================
// Doc.PUG CRM Mini — app.js
// PDF + Print fixed + SERVICES (registry + visit lines) + TOTAL
// =========================

// ===== Helpers =====
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ===== Storage keys =====
const OWNERS_KEY = "docpug_owners_v1";
const PATIENTS_KEY = "docpug_patients_v1";
const VISITS_KEY = "docpug_visits_v1";
const DISCHARGES_KEY = "docpug_discharges_v1";

const FILES_KEY = "docpug_files_v1";
const VISIT_FILES_KEY = "docpug_visit_files_v1";
const MIGRATION_KEY = "docpug_files_migrated_v1";

// ✅ Services registry
const SERVICES_KEY = "docpug_services_v1";

// ✅ Stock registry (пока просто ключ, UI добавим дальше)
const STOCK_KEY = "docpug_stock_v1";

// ===== State =====
const state = {
  route: "owners",
  apiOk: null,
  me: null,
  owners: [],
  selectedOwnerId: null,
  selectedPetId: null,
  selectedPet: null,
  selectedVisitId: null,

  dischargeListenersBound: false,
  printCssInjected: false,

  servicesUiBound: false,
  stockUiBound: false,
};

const LS = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  },
};

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowISO() {
  return new Date().toISOString();
}

function setApiStatus(ok, text) {
  state.apiOk = ok;
  const dot = $("#apiDot");
  const line = $("#apiLine");
  if (!dot || !line) return;
  dot.style.background =
    ok === true ? "var(--ok)" : ok === false ? "var(--danger)" : "#777";
  line.textContent = text;
}

function setMeLine(text) {
  const el = $("#meLine");
  if (el) el.textContent = text;
}

// ===== Router (hash with params) =====
const TAB_ROUTES = new Set([
  "owners",
  "patients",
  "visits",
  "services", // ✅ NEW
  "calendar",
  "stock",
]);

function parseHash() {
  const raw = (location.hash || "").replace("#", "").trim();
  if (!raw) return { route: "owners", id: null };
  const [route, id] = raw.split(":");
  return { route: (route || "owners").trim(), id: id || null };
}

function setHash(route, id = null) {
  const next = id ? `${route}:${id}` : route;
  if (location.hash.replace("#", "") !== next) location.hash = next;
}

function setRoute(route) {
  const pageExists = $(`.page[data-page="${route}"]`);
  if (!pageExists) route = "owners";

  state.route = route;

  $$(".page").forEach((p) => {
    p.classList.toggle("active", p.dataset.page === route);
  });

  if (TAB_ROUTES.has(route)) {
    $$("#tabs .tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.route === route);
    });
  }
}

function routeFromHash() {
  const { route, id } = parseHash();

  if (TAB_ROUTES.has(route)) {
    setRoute(route);

    if (route === "owners") renderOwners();
    if (route === "patients") renderPatientsTab();
    if (route === "visits") renderVisitsTab();
    if (route === "services") renderServicesTab(); // ✅ NEW
    if (route === "stock") renderStockTab();


    return;
  }

  if (route === "owner") {
    if (id) openOwner(id, { pushHash: false });
    else setHash("owners");
    return;
  }

  if (route === "patient") {
    if (id) openPatient(id, { pushHash: false });
    else setHash("owners");
    return;
  }

  if (route === "visit") {
    if (id) openVisit(id, { pushHash: false });
    else setHash("owners");
    return;
  }

  setHash("owners");
}

function initTabs() {
  const tabs = $("#tabs");
  if (!tabs) return;

  tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    const route = btn.dataset.route;
    if (!TAB_ROUTES.has(route)) return;
    setHash(route);
  });

  window.addEventListener("hashchange", routeFromHash);
  routeFromHash();
}

// ===== API /api/me =====
async function loadMe() {
  if (location.protocol === "file:") {
    state.me = null;
    setApiStatus(false, "API: /api/me ❌ (открыто через file://)");
    setMeLine("Гость • открой через http://localhost:8080");
    return;
  }

  setApiStatus(null, "API: проверяю /api/me …");
  setMeLine("Загрузка профиля…");

  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    state.me = data?.user || data?.me || data || null;

    const name =
      state.me?.name ||
      state.me?.first_name ||
      state.me?.username ||
      "Пользователь";

    const tgId =
      state.me?.tg_user_id || state.me?.id || state.me?.user_id || null;

    setApiStatus(true, "API: /api/me ✅");
    setMeLine(tgId ? `${name} • tg_id: ${tgId}` : `${name}`);
  } catch {
    state.me = null;
    setApiStatus(false, "API: /api/me ❌ (пока нет бэка — это ок)");
    setMeLine("Гость • подключим бэк позже");
  }
}

// ===== Storage seed =====
function seedIfEmpty() {
  const owners = LS.get(OWNERS_KEY, []);
  const patients = LS.get(PATIENTS_KEY, []);

  if (!owners.length) {
    const ownerId = String(Date.now());
    LS.set(OWNERS_KEY, [
      { id: ownerId, name: "Іван Петренко", phone: "+38050…", note: "Боярка" },
    ]);

    LS.set(PATIENTS_KEY, [
      {
        id: String(Date.now() + 1),
        owner_id: ownerId,
        name: "Мойша",
        species: "пес",
        breed: "Мопс",
        age: "3.8",
        weight_kg: "5",
        notes: "Чешет нос",
      },
    ]);
  } else if (!patients.length) {
    LS.set(PATIENTS_KEY, patients);
  }

  if (!LS.get(VISITS_KEY, null)) LS.set(VISITS_KEY, []);
  if (!LS.get(FILES_KEY, null)) LS.set(FILES_KEY, []);
  if (!LS.get(VISIT_FILES_KEY, null)) LS.set(VISIT_FILES_KEY, []);
  if (!LS.get(DISCHARGES_KEY, null)) LS.set(DISCHARGES_KEY, {});

  // ✅ seed stock registry (if absent)
if (!LS.get(STOCK_KEY, null)) {
  LS.set(STOCK_KEY, [
    { id: "stk_meloxivet", name: "Мелоксивет", price: 70, unit: "шт", qty: 10, active: true },
  ]);
}

  // ✅ seed services registry (if absent)
  if (!LS.get(SERVICES_KEY, null)) {
    LS.set(SERVICES_KEY, [
      { id: "svc_exam", name: "Огляд", price: 500, active: true },
      { id: "svc_trip", name: "Виїзд", price: 1500, active: true },
      { id: "svc_vax", name: "Вакцинація", price: 800, active: true },

      // (можеш залишити або прибрати)
      { id: "svc_consult", name: "Консультація", price: 500, active: true },
      { id: "svc_cat_castr", name: "Кастрація кота", price: 2500, active: true },
      { id: "svc_dog_castr", name: "Кастрація пса", price: 3500, active: true },
    ]);
  }
}
async function loadOwners() {
  try {
    const res = await fetch("/api/owners");
    const json = await res.json();

    if (!json.ok) {
      alert(json.error || "Помилка завантаження власників");
      return;
    }

    state.owners = Array.isArray(json.data) ? json.data : [];
    renderOwners();
  } catch (e) {
    console.error(e);
    alert("Помилка завантаження власників (network)");
  }
}

async function createPatientApi(payload) {
  const res = await fetch("/api/patients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) {
    alert(json.error || "Помилка створення пацієнта");
    return null;
  }
  return json.data;
}

async function deleteOwner(id) {
  const res = await fetch(`/api/owners/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  const json = await res.json();
  if (!json.ok) {
    alert(json.error || "Помилка видалення власника");
    return false;
  }

  return true;
}

function loadPatients() {
  return LS.get(PATIENTS_KEY, []);
}
function savePatients(p) {
  LS.set(PATIENTS_KEY, p);
}

function loadVisits() {
  return LS.get(VISITS_KEY, []);
}
function saveVisits(v) {
  LS.set(VISITS_KEY, v);
}

// ===== Discharges =====
function loadDischarges() {
  return LS.get(DISCHARGES_KEY, {});
}
function saveDischarges(obj) {
  LS.set(DISCHARGES_KEY, obj);
}
function getDischarge(visitId) {
  return loadDischarges()[visitId] || null;
}
function setDischarge(visitId, data) {
  const all = loadDischarges();
  all[visitId] = {
    ...(all[visitId] || {}),
    ...data,
    updated_at: nowISO(),
  };
  saveDischarges(all);
}

// ===== Data getters =====
function getVisitsByPetId(petId) {
  return loadVisits().filter((x) => x.pet_id === petId);
}
function getVisitById(visitId) {
  return loadVisits().find((v) => v.id === visitId) || null;
}
function getOwnerById(ownerId) {
  return state.owners.find((o) => o.id === ownerId);
}
function getPetsByOwnerId(ownerId) {
  return loadPatients().filter((p) => p.owner_id === ownerId);
}

// =========================
// ✅ SERVICES registry + visit services lines
// =========================
function loadServices() {
  return LS.get(SERVICES_KEY, []);
}
function saveServices(items) {
  LS.set(SERVICES_KEY, items);
}
function getServiceById(id) {
  return loadServices().find((s) => s.id === id) || null;
}

function ensureVisitServicesShape(visit) {
  if (!visit) return;
  if (!Array.isArray(visit.services)) visit.services = [];
}

function addServiceLineToVisit(visitId, serviceId, qty = 1, { snap = true } = {}) {
  const visits = loadVisits();
  const v = visits.find((x) => x.id === visitId);
  if (!v) return false;

  ensureVisitServicesShape(v);

  const svc = getServiceById(serviceId);
  if (!svc) return false;

  const line = {
    serviceId,
    qty: Math.max(1, Number(qty) || 1),
  };

  // snapshot: freeze price/name at moment of visit
  if (snap) {
    line.priceSnap = Number(svc.price) || 0;
    line.nameSnap = String(svc.name || "").trim();
  }

  v.services.push(line);
  saveVisits(visits);
  return true;
}

function removeServiceLineFromVisit(visitId, index) {
  const visits = loadVisits();
  const v = visits.find((x) => x.id === visitId);
  if (!v) return false;

  ensureVisitServicesShape(v);

  if (index < 0 || index >= v.services.length) return false;
  v.services.splice(index, 1);
  saveVisits(visits);
  return true;
}

function expandServiceLines(visit) {
  const lines = Array.isArray(visit?.services) ? visit.services : [];
  return lines.map((line) => {
    const svc = getServiceById(line.serviceId);

    const name = line.nameSnap || svc?.name || "Невідома послуга";
    const price = Number.isFinite(Number(line.priceSnap))
      ? Number(line.priceSnap)
      : Number(svc?.price || 0);

    const qty = Math.max(1, Number(line.qty) || 1);
    return { name, price, qty, lineTotal: price * qty };
  });
}

function calcServicesTotal(visit) {
  return expandServiceLines(visit).reduce((sum, x) => sum + (Number(x.lineTotal) || 0), 0);
}

// =========================
// ✅ Services PRO HTML (for A4 discharge)
// =========================
function renderServicesProA4(expanded = [], total = 0) {
  // expanded: [{name, price, qty, lineTotal}]
  if (!expanded.length) {
    return `<div class="hint" style="opacity:.75">—</div>`;
  }

  const left = expanded.map((x) => `
    <div class="svcChip">
      ${escapeHtml(x.name || "—")}
      <small>${escapeHtml(String(x.qty))} × ${escapeHtml(String(x.price))} грн</small>
    </div>
  `).join("");

  const rows = expanded.map((x) => `
    <tr>
      <td title="${escapeHtml(x.name || "")}">${escapeHtml(x.name || "—")}</td>
      <td>${escapeHtml(String(x.qty))}</td>
      <td>${escapeHtml(String(x.price))}</td>
      <td>${escapeHtml(String(x.lineTotal))}</td>
    </tr>
  `).join("");

  return `
    <div class="servicesPro">

      <table class="servicesTable">
        <thead>
          <tr>
            <th>Послуга</th>
            <th>К-сть</th>
            <th>Ціна</th>
            <th>Сума</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="3">Разом</td>
            <td>${escapeHtml(String(total))} грн</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}


// =========================
// ✅ STOCK lines inside VISIT (snapshot) + totals
// =========================
function ensureVisitStockShape(visit) {
  if (!visit) return;
  if (!Array.isArray(visit.stock)) visit.stock = [];
}
function addStockLineToVisit(
  visitId,
  stockId,
  qty = 1,
  { snap = true, decrement = true } = {}
) {
  const visits = loadVisits();
  const v = visits.find((x) => x.id === visitId);
  if (!v) return false;

  ensureVisitStockShape(v);

  const it = getStockById(stockId);
  if (!it || it.active === false) return false;

  const q = Math.max(1, Number(qty) || 1);

  // decrement from stock
  if (decrement) {
    const stock = loadStock();
    const idx = stock.findIndex((x) => x.id === stockId);
    if (idx < 0) return false;

    const curQty = Number(stock[idx].qty) || 0;
    if (curQty < q) return false;

    stock[idx].qty = curQty - q;
    saveStock(stock);
  }

  const line = { stockId, qty: q };

  if (snap) {
    line.priceSnap = Number(it.price) || 0;
    line.nameSnap = String(it.name || "").trim();
    line.unitSnap = String(it.unit || "шт").trim();
  }

  v.stock.push(line);
  saveVisits(visits);
  return true;
}

function removeStockLineFromVisit(visitId, index, { restore = true } = {}) {
  const visits = loadVisits();
  const v = visits.find((x) => x.id === visitId);
  if (!v) return false;

  ensureVisitStockShape(v);
  if (index < 0 || index >= v.stock.length) return false;

  const line = v.stock[index];
  v.stock.splice(index, 1);
  saveVisits(visits);

  // restore into stock
  if (restore && line?.stockId) {
    const stock = loadStock();
    const idx = stock.findIndex((x) => x.id === line.stockId);
    if (idx >= 0) {
      const curQty = Number(stock[idx].qty) || 0;
      const q = Math.max(1, Number(line.qty) || 1);
      stock[idx].qty = curQty + q;
      saveStock(stock);
    }
  }

  return true;
}

function expandStockLines(visit) {
  const lines = Array.isArray(visit?.stock) ? visit.stock : [];
  return lines.map((line) => {
    const it = getStockById(line.stockId);

    const name = line.nameSnap || it?.name || "Невідома позиція";
    const unit = line.unitSnap || it?.unit || "шт";
    const price = Number.isFinite(Number(line.priceSnap))
      ? Number(line.priceSnap)
      : Number(it?.price || 0);

    const qty = Math.max(1, Number(line.qty) || 1);
    return { name, unit, price, qty, lineTotal: price * qty };
  });
}

function calcStockTotal(visit) {
  return expandStockLines(visit).reduce((sum, x) => sum + (Number(x.lineTotal) || 0), 0);
}

// =========================
// ✅ SERVICES TAB (registry UI)
// =========================
function renderServicesTab() {
  const page = $(`.page[data-page="services"]`);
  if (!page) return;

  // index.html уже содержит #servicesList и #btnAddService.
  const list = $("#servicesList", page);
  if (!list) return;

  const items = loadServices().slice().sort((a, b) => {
    const an = String(a.name || "");
    const bn = String(b.name || "");
    return an.localeCompare(bn, "uk");
  });

  if (!items.length) {
    list.innerHTML = `<div class="hint">Поки послуг немає. Натисни “+ Додати”.</div>`;
    return;
  }

  list.innerHTML = items
    .map((s) => {
      const active = s.active !== false;
      return `
        <div class="item">
          <div class="left" style="width:100%;">
            <div class="name">${escapeHtml(s.name || "—")}</div>
            <div class="meta">
              <b>${escapeHtml(String(Number(s.price) || 0))} грн</b>
              ${active ? "" : " • <span style='color:#ff9a9a'>вимкнено</span>"}
              • <span class="mono">id: ${escapeHtml(s.id)}</span>
            </div>
          </div>
          <div class="right" style="display:flex; gap:6px; align-items:center;">
            <button class="miniBtn" data-svc-action="edit" data-svc-id="${escapeHtml(s.id)}">Ред.</button>
            <button class="miniBtn" data-svc-action="toggle" data-svc-id="${escapeHtml(s.id)}">
              ${active ? "Вимкн." : "Увімк."}
            </button>
            <button class="miniBtn danger" data-svc-action="del" data-svc-id="${escapeHtml(s.id)}">🗑</button>
          </div>
        </div>
      `;
    })
    .join("");

  // bind UI once
  if (!state.servicesUiBound) initServicesUI();
}

function initServicesUI() {
  const page = $(`.page[data-page="services"]`);
  if (!page) return;

  // add
  $("#btnAddService", page)?.addEventListener("click", () => {
    const name = (prompt("Назва послуги:", "") || "").trim();
    if (!name) return;

    const priceRaw = (prompt("Ціна (грн):", "0") || "0").trim();
    const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

    const id = "svc_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2);

    const items = loadServices();
    items.unshift({ id, name, price, active: true });
    saveServices(items);

    renderServicesTab();
  });

  // actions: edit/toggle/delete
  $("#servicesList", page)?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-svc-action]");
    if (!btn) return;

    const action = btn.dataset.svcAction;
    const id = btn.dataset.svcId;
    if (!action || !id) return;

    const items = loadServices();
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return;

    if (action === "edit") {
      const cur = items[idx];
      const name = (prompt("Назва:", cur.name || "") || "").trim();
      if (!name) return;

      const priceRaw = (prompt("Ціна (грн):", String(cur.price ?? 0)) || "0").trim();
      const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

      items[idx] = { ...cur, name, price };
      saveServices(items);
      renderServicesTab();

      // если открыт визит — перерисуем страницу визита (чтобы селект показывал новые цены)
      if (state.route === "visit" && state.selectedVisitId) {
        const v = getVisitById(state.selectedVisitId);
        const pet = state.selectedPet || (v ? loadPatients().find((p) => p.id === v.pet_id) : null);
        if (v) renderVisitPage(v, pet);
        renderDischargeA4(state.selectedVisitId);
      }
      return;
    }


    
    if (action === "toggle") {
      items[idx].active = items[idx].active === false ? true : false;
      saveServices(items);
      renderServicesTab();

      // обновим визит UI
      if (state.route === "visit" && state.selectedVisitId) {
        const v = getVisitById(state.selectedVisitId);
        const pet = state.selectedPet || (v ? loadPatients().find((p) => p.id === v.pet_id) : null);
        if (v) renderVisitPage(v, pet);
      }
      return;
    }

    if (action === "del") {
      const cur = items[idx];
      if (!confirm(`Видалити послугу "${cur.name}"?`)) return;
      items.splice(idx, 1);
      saveServices(items);
      renderServicesTab();
      return;
    }
  });

  state.servicesUiBound = true;
}
// =========================
// ✅ STOCK registry (warehouse)
// =========================
function loadStock() {
  return LS.get(STOCK_KEY, []);
}
function saveStock(items) {
  LS.set(STOCK_KEY, items);
}
function getStockById(id) {
  return loadStock().find((x) => x.id === id) || null;
}

// =========================
// ✅ STOCK TAB (registry UI)
// =========================
function renderStockTab() {
  const page = $(`.page[data-page="stock"]`);
  if (!page) return;

  const list = $("#stockList", page);
  if (!list) return;

  const items = loadStock().slice().sort((a, b) => {
    const an = String(a.name || "");
    const bn = String(b.name || "");
    return an.localeCompare(bn, "uk");
  });

  if (!items.length) {
    list.innerHTML = `<div class="hint">Поки складу немає. Натисни “+ Додати”.</div>`;
    return;
  }

  list.innerHTML = items
    .map((it) => {
      const active = it.active !== false;
      const price = Number(it.price) || 0;
      const qty = Number(it.qty) || 0;
      const unit = String(it.unit || "шт");
      return `
        <div class="item">
          <div class="left" style="width:100%;">
            <div class="name">${escapeHtml(it.name || "—")}</div>
            <div class="meta">
              <b>${escapeHtml(String(price))} грн</b> / ${escapeHtml(unit)}
              • Залишок: <b>${escapeHtml(String(qty))}</b>
              ${active ? "" : " • <span style='color:#ff9a9a'>вимкнено</span>"}
              • <span class="mono">id: ${escapeHtml(it.id)}</span>
            </div>
          </div>

          <div class="right" style="display:flex; gap:6px; align-items:center;">
            <button class="miniBtn" data-stk-action="edit" data-stk-id="${escapeHtml(it.id)}">Ред.</button>
            <button class="miniBtn" data-stk-action="qty" data-stk-id="${escapeHtml(it.id)}">Залишок</button>
            <button class="miniBtn" data-stk-action="toggle" data-stk-id="${escapeHtml(it.id)}">
              ${active ? "Вимкн." : "Увімк."}
            </button>
            <button class="miniBtn danger" data-stk-action="del" data-stk-id="${escapeHtml(it.id)}">🗑</button>
          </div>
        </div>
      `;
    })
    .join("");

  if (!state.stockUiBound) initStockUI();
}

function initStockUI() {
  const page = $(`.page[data-page="stock"]`);
  if (!page) return;

  // add
  $("#btnAddStock", page)?.addEventListener("click", () => {
    const name = (prompt("Назва позиції (препарат/товар):", "") || "").trim();
    if (!name) return;

    const priceRaw = (prompt("Ціна (грн) за одиницю:", "0") || "0").trim();
    const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

    const unit = (prompt("Одиниця (шт/мл/таб/фл…):", "шт") || "шт").trim() || "шт";

    const qtyRaw = (prompt("Початковий залишок:", "0") || "0").trim();
    const qty = Math.max(0, Number(qtyRaw.replace(",", ".")) || 0);

    const id = "stk_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2);

    const items = loadStock();
    items.unshift({ id, name, price, unit, qty, active: true });
    saveStock(items);

    renderStockTab();
  });

  // actions
  $("#stockList", page)?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-stk-action]");
    if (!btn) return;

    const action = btn.dataset.stkAction;
    const id = btn.dataset.stkId;
    if (!action || !id) return;

    const items = loadStock();
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return;

    if (action === "edit") {
      const cur = items[idx];

      const name = (prompt("Назва:", cur.name || "") || "").trim();
      if (!name) return;

      const priceRaw = (prompt("Ціна (грн) за одиницю:", String(cur.price ?? 0)) || "0").trim();
      const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

      const unit = (prompt("Одиниця:", String(cur.unit || "шт")) || "шт").trim() || "шт";

      items[idx] = { ...cur, name, price, unit };
      saveStock(items);
      renderStockTab();
      return;
    }

    if (action === "qty") {
      const cur = items[idx];
      const qtyRaw = (prompt("Новий залишок:", String(cur.qty ?? 0)) || "0").trim();
      const qty = Math.max(0, Number(qtyRaw.replace(",", ".")) || 0);

      items[idx] = { ...cur, qty };
      saveStock(items);
      renderStockTab();
      return;
    }

    if (action === "toggle") {
      items[idx].active = items[idx].active === false ? true : false;
      saveStock(items);
      renderStockTab();
      return;
    }

    if (action === "del") {
      const cur = items[idx];
      if (!confirm(`Видалити позицію "${cur.name}"?`)) return;
      items.splice(idx, 1);
      saveStock(items);
      renderStockTab();
      return;
    }
  });

  state.stockUiBound = true;
}

// ===== Files schema =====
function loadFiles() {
  return LS.get(FILES_KEY, []);
}
function saveFiles(items) {
  LS.set(FILES_KEY, items);
}
function loadVisitFiles() {
  return LS.get(VISIT_FILES_KEY, []);
}
function saveVisitFiles(items) {
  LS.set(VISIT_FILES_KEY, items);
}

function fileIdFromStored(storedName) {
  const s = String(storedName || "");
  return "f_" + s.replace(/[^a-zA-Z0-9_]/g, "_");
}

function upsertFilesFromServerMeta(serverFilesMeta) {
  const files = loadFiles();
  const map = new Map(files.map((f) => [f.id, f]));

  (serverFilesMeta || []).forEach((meta) => {
    const stored = meta?.stored_name;
    if (!stored) return;

    const id = fileIdFromStored(stored);
    const prev = map.get(id);

    map.set(id, {
      id,
      stored_name: stored,
      url: meta.url || (stored ? `/uploads/${stored}` : "#"),
      name: meta.name || prev?.name || stored,
      size: Number(meta.size ?? prev?.size ?? 0),
      type: meta.type || prev?.type || "",
      created_at: prev?.created_at || nowISO(),
    });
  });

  const next = Array.from(map.values());
  saveFiles(next);
  return next;
}

function linkFilesToVisit(visitId, fileIds) {
  const links = loadVisitFiles();
  const existing = new Set(
    links.filter((l) => l.visit_id === visitId).map((l) => l.file_id)
  );

  const toAdd = (fileIds || [])
    .filter((fid) => fid && !existing.has(fid))
    .map((fid) => ({
      id: "vf_" + Date.now() + "_" + Math.random().toString(16).slice(2),
      visit_id: visitId,
      file_id: fid,
      created_at: nowISO(),
    }));

  if (toAdd.length) saveVisitFiles([...toAdd, ...links]);
}

function getFilesForVisit(visitId) {
  const files = loadFiles();
  const byId = new Map(files.map((f) => [f.id, f]));

  const links = loadVisitFiles().filter((l) => l.visit_id === visitId);
  links.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

  return links.map((l) => byId.get(l.file_id)).filter(Boolean);
}

function detachFileFromVisit(visitId, fileId) {
  saveVisitFiles(
    loadVisitFiles().filter(
      (l) => !(l.visit_id === visitId && l.file_id === fileId)
    )
  );
}

function countLinksForFile(fileId) {
  return loadVisitFiles().filter((l) => l.file_id === fileId).length;
}

function deleteFileEverywhereLocal(fileId) {
  saveVisitFiles(loadVisitFiles().filter((l) => l.file_id !== fileId));
  saveFiles(loadFiles().filter((f) => f.id !== fileId));
}

function getFileById(fileId) {
  return loadFiles().find((f) => f.id === fileId) || null;
}

// ===== Migration: legacy visit.files -> files + visit_files =====
function migrateLegacyVisitFilesIfNeeded() {
  if (LS.get(MIGRATION_KEY, false) === true) return;

  const visits = loadVisits();
  const hasLegacy = visits.some((v) => Array.isArray(v.files) && v.files.length);

  if (!hasLegacy) {
    LS.set(MIGRATION_KEY, true);
    return;
  }

  let allMeta = [];
  visits.forEach((v) => {
    if (Array.isArray(v.files) && v.files.length) allMeta = allMeta.concat(v.files);
  });

  upsertFilesFromServerMeta(allMeta);

  let changed = false;
  visits.forEach((v) => {
    if (Array.isArray(v.files) && v.files.length) {
      const ids = v.files
        .map((meta) => (meta?.stored_name ? fileIdFromStored(meta.stored_name) : null))
        .filter(Boolean);

      linkFilesToVisit(v.id, ids);
      delete v.files;
      changed = true;
    }
  });

  if (changed) saveVisits(visits);

  LS.set(MIGRATION_KEY, true);
  console.log("✅ Migration done: legacy visit.files -> files + visit_files");
}

// ===== Visit note helpers (Dx + note) =====
function parseVisitNoteToDxAndNote(note) {
  const s = String(note || "");
  const parts = s.split("•").map((x) => x.trim()).filter(Boolean);
  const dxIdx = parts.findIndex((p) => /^Dx:\s*/i.test(p));

  let dx = "";
  let rest = parts;

  if (dxIdx >= 0) {
    dx = parts[dxIdx].replace(/^Dx:\s*/i, "").trim();
    rest = parts.filter((_, i) => i !== dxIdx);
  }

  return { dx, note: rest.join(" • ") };
}

function buildVisitNote(dx, note) {
  const out = [];
  if (String(dx || "").trim()) out.push(`Dx: ${String(dx).trim()}`);
  if (String(note || "").trim()) out.push(String(note).trim());
  return out.join(" • ");
}

// =========================
// PRINT / PDF helpers
// =========================
function ensurePrintCss() {
  if (state.printCssInjected) return;
  const style = document.createElement("style");
  style.id = "docpug-print-style";
  style.textContent = `
    /* Print ONLY the A4 block */
    @media print {
      body { background: #fff !important; }
      body.docpug-printing * { visibility: hidden !important; }
      body.docpug-printing #disA4,
      body.docpug-printing #disA4 * { visibility: visible !important; }
      body.docpug-printing #disA4 {
        position: fixed !important;
        left: 0 !important;
        top: 0 !important;
        width: 210mm !important;
        min-height: 297mm !important;
        margin: 0 !important;
        box-shadow: none !important;
        border-radius: 0 !important;
      }
    }
  `;
  document.head.appendChild(style);
  state.printCssInjected = true;
}

function a4FilenameFromVisit(visitId) {
  const { visit, pet } = getContextForVisit(visitId);
  const d = (visit?.date || todayISO()).replaceAll(":", "-");
  const petName = (pet?.name || "patient").replace(/[^\p{L}\p{N}_-]+/gu, "_");
  return `DocPUG_${petName}_${d}_visit_${visitId}.pdf`;
}

async function downloadA4Pdf(visitId) {
  if (typeof window.html2pdf === "undefined") {
    alert("html2pdf не подключен. Проверь, что html2pdf.bundle.min.js подключён перед app.js");
    return;
  }

  const a4 = document.getElementById("disA4");
  if (!a4) return alert("Не найден блок A4 (#disA4).");

  setDischarge(visitId, readDischargeForm());
  renderDischargeA4(visitId);

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const opt = {
    margin: 0,
    filename: a4FilenameFromVisit(visitId),
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      backgroundColor: null,
      logging: false,
      scrollX: 0,
      scrollY: 0,
      onclone: (doc) => {
        const el = doc.getElementById("disA4");
        if (el) {
          el.style.transform = "none";
          el.style.maxWidth = "none";
          el.style.boxShadow = "none";
        }
        const pc = doc.querySelector(".printCard");
        if (pc) pc.style.transform = "none";
      },
    },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait", compress: true },
    pagebreak: { mode: ["avoid-all"] },
  };

  try {
    const worker = window.html2pdf().set(opt).from(a4).toPdf();
    const pdfBlob = await worker.outputPdf("blob");

    const blobUrl = URL.createObjectURL(pdfBlob);

    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (tg && typeof tg.openLink === "function") {
      tg.openLink(blobUrl, { try_instant_view: false });
    } else {
      window.open(blobUrl, "_blank");
    }

    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } catch (e) {
    console.error(e);
    alert("Не удалось сформировать PDF: " + (e?.message || e));
  } finally {
    document.body.style.overflow = prevOverflow;
  }
}

function printA4Only(visitId) {
  ensurePrintCss();

  setDischarge(visitId, readDischargeForm());
  renderDischargeA4(visitId);

  document.body.classList.add("docpug-printing");
  setTimeout(() => {
    window.print();
    setTimeout(() => document.body.classList.remove("docpug-printing"), 300);
  }, 50);
}

// ===== Render Owners =====
function renderOwners() {
  const list = $("#ownersList");
  if (!list) return;

  list.innerHTML = "";

  if (!state.owners.length) {
    list.innerHTML = `<div class="hint">Пока пусто. Нажми “Добавить”.</div>`;
    return;
  }

  state.owners.forEach((owner) => {
    const el = document.createElement("div");
    el.className = "item";

    el.innerHTML = `
      <div class="left" data-open-owner="${escapeHtml(owner.id)}" style="cursor:pointer;">
        <div class="name">${escapeHtml(owner.name || "Без имени")}</div>
        <div class="meta">${escapeHtml(owner.phone || "")}${
          owner.note ? " • " + escapeHtml(owner.note) : ""
        }</div>
        <div class="pill">id: ${escapeHtml(owner.id)}</div>
      </div>
      <div class="right">
        <button class="iconBtn" title="Удалить" data-del="${escapeHtml(owner.id)}">🗑</button>
      </div>
    `;
    list.appendChild(el);
  });
}

// ===== Patients tab =====
function renderPatientsTab() {
  const page = $(`.page[data-page="patients"]`);
  if (!page) return;

  page.innerHTML = `
    <div class="card">
      <div class="row">
        <h2>Пацієнти</h2>
      </div>
      <div class="hint">Список всіх пацієнтів (клік — відкрити картку).</div>
      <div id="patientsTabList" class="list"></div>
    </div>
  `;

  const list = $("#patientsTabList", page);
  if (!list) return;

  const patients = loadPatients();
  const owners = (Array.isArray(state.owners) && state.owners.length)
  ? state.owners
  : LS.get(OWNERS_KEY, []);
  
  const ownerById = new Map(owners.map((o) => [o.id, o]));

  if (!patients.length) {
    list.innerHTML = `<div class="hint">Поки пацієнтів немає. Додай їх у “Владельцы → Животное”.</div>`;
    return;
  }

  list.innerHTML = "";

  patients
    .slice()
    .sort((a, b) => String(b.id).localeCompare(String(a.id)))
    .forEach((p) => {
      const owner = ownerById.get(p.owner_id);
      const ownerLine = owner ? (owner.name || "") : "";

      const el = document.createElement("div");
      el.className = "item";
      el.style.cursor = "pointer";
      el.dataset.openPet = p.id;

      el.innerHTML = `
        <div class="left" style="width:100%">
          <div class="name">${escapeHtml(p.name || "Без клички")}</div>
          <div class="meta">
            ${escapeHtml(p.species || "")}
            ${p.breed ? " • " + escapeHtml(p.breed) : ""}
            ${p.age ? " • " + escapeHtml(p.age) : ""}
            ${p.weight_kg ? " • " + escapeHtml(p.weight_kg) + " кг" : ""}
            ${ownerLine ? " • " + escapeHtml(ownerLine) : ""}
          </div>
        </div>

        <div class="right">
          <button class="iconBtn" title="Видалити пацієнта" data-del-pet="${escapeHtml(p.id)}">🗑</button>
        </div>
      `;

      list.appendChild(el);
    });

  // один обработчик на весь список
  list.onclick = (e) => {
    // 🗑 delete
    const delBtn = e.target.closest("[data-del-pet]");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      const petId = delBtn.dataset.delPet;
      if (petId) deletePatientEverywhere(petId);
      return;
    }

    // open
    const openZone = e.target.closest("[data-open-pet]");
    if (!openZone) return;
    const petId = openZone.dataset.openPet;
    if (petId) openPatient(petId);
  };
}

// ===== Visits TAB (ALL VISITS) =====
function renderVisitsTab() {
  const page = $(`.page[data-page="visits"]`);
  if (!page) return;

  // ✅ правильный контейнер для вкладки "Визиты"
  const list = $("#visitsTabList", page) || $("#visitsList", page); // fallback на всякий
  const search = $("#visitsSearch", page);
  if (!list) return;

  const visits = loadVisits();
  const patients = loadPatients();
  const owners = (Array.isArray(state.owners) && state.owners.length)
    ? state.owners
    : LS.get(OWNERS_KEY, []);

  const petById = new Map(patients.map((p) => [p.id, p]));
  const ownerById = new Map(owners.map((o) => [o.id, o]));

  const q = (search?.value || "").trim().toLowerCase();
  const sorted = visits.slice().sort((a, b) => String(b.id).localeCompare(String(a.id)));

  const filtered = !q
    ? sorted
    : sorted.filter((v) => {
        const pet = petById.get(v.pet_id);
        const owner = pet ? ownerById.get(pet.owner_id) : null;

        const hay = [
          v.date,
          v.note,
          v.rx,
          v.weight_kg,
          pet?.name,
          pet?.species,
          pet?.breed,
          owner?.name,
          owner?.phone,
          owner?.note,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return hay.includes(q);
      });

  list.innerHTML = "";

  if (!filtered.length) {
    list.innerHTML = `<div class="hint">Нічого не знайдено.</div>`;
    return;
  }

  filtered.forEach((v) => {
    const pet = petById.get(v.pet_id);
    const owner = pet ? ownerById.get(pet.owner_id) : null;

    const petLine = pet
      ? `${pet.name || "—"}${pet.species ? " • " + pet.species : ""}${pet.breed ? " • " + pet.breed : ""}`
      : "Пацієнт: —";

    const ownerLine = owner
      ? `${owner.name || "—"}${owner.phone ? " • " + owner.phone : ""}`
      : "Власник: —";

    const el = document.createElement("div");
    el.className = "item";
    el.style.cursor = "pointer";
    el.dataset.openVisit = v.id;

    el.innerHTML = `
      <div class="left" style="width:100%;">
        <div class="name">${escapeHtml(v.date || "—")}</div>
        <div class="meta">${escapeHtml(petLine)} • ${escapeHtml(ownerLine)}</div>
        ${v.note ? `<div class="meta" style="opacity:.9;margin-top:6px;">${escapeHtml(v.note)}</div>` : ""}
      </div>
      <div class="right" style="display:flex; gap:6px;">
        <button class="iconBtn" title="Відкрити" data-open-visit="${escapeHtml(v.id)}">➡️</button>
        <button class="iconBtn" title="Видалити" data-del-visit="${escapeHtml(v.id)}">🗑</button>
      </div>
    `;

    // ✅ ВОТ ЭТОГО НЕ ХВАТАЛО
    list.appendChild(el);
  });
}

// ===== Owner page =====
function renderOwnerPage(ownerId) {
  const owner = getOwnerById(ownerId);
  if (!owner) {
    alert("Владелец не найден");
    setHash("owners");
    return;
  }

  state.selectedOwnerId = ownerId;

  const ownerName = $("#ownerName");
  const ownerMeta = $("#ownerMeta");

  if (ownerName) ownerName.textContent = owner.name || "Без имени";
  if (ownerMeta) {
    ownerMeta.textContent =
      `${owner.phone || ""}${owner.note ? " • " + owner.note : ""}`.trim() || "—";
  }

  const pets = getPetsByOwnerId(ownerId);
  const list = $("#petsList");
  if (!list) return;

  list.innerHTML = "";

  if (!pets.length) {
    list.innerHTML = `<div class="hint">Пока нет животных. Нажми “+ Животное”.</div>`;
    return;
  }

  pets.forEach((pet) => {
    const el = document.createElement("div");
    el.className = "item";

    el.innerHTML = `
      <div class="left" data-open-pet="${escapeHtml(pet.id)}" style="width:100%; cursor:pointer;">
        <div class="name">${escapeHtml(pet.name || "Без клички")}</div>
        <div class="meta">
          ${escapeHtml(pet.species || "")}
          ${pet.breed ? " • " + escapeHtml(pet.breed) : ""}
          ${pet.age ? " • " + escapeHtml(pet.age) : ""}
          ${pet.weight_kg ? " • " + escapeHtml(pet.weight_kg) + " кг" : ""}
        </div>

        ${
          pet.notes
            ? `
          <div class="history">
            <div class="history-label">Історія / нотатки лікаря</div>
            ${escapeHtml(pet.notes)}
          </div>
        `
            : ""
        }
      </div>

      <div class="right">
        <button class="iconBtn" title="Удалить" data-del-pet="${escapeHtml(pet.id)}">🗑</button>
      </div>
    `;
    list.appendChild(el);
  });
}

function openOwner(ownerId, opts = { pushHash: true }) {
  setRoute("owner");
  renderOwnerPage(ownerId);
  if (opts.pushHash) setHash("owner", ownerId);
}

// ===== Patient page =====
function openPatient(petId, opts = { pushHash: true }) {
  const pet = loadPatients().find((p) => p.id === petId);
  if (!pet) return alert("Пациент не найден");

  state.selectedPetId = petId;
  state.selectedPet = pet;
  state.selectedOwnerId = pet.owner_id || state.selectedOwnerId;

  const patientName = $("#patientName");
  const patientMeta = $("#patientMeta");

  if (patientName) patientName.textContent = pet.name || "Пациент";
  if (patientMeta) {
    patientMeta.textContent =
      `${pet.species || ""}${pet.breed ? " • " + pet.breed : ""}${pet.age ? " • " + pet.age : ""}${
        pet.weight_kg ? " • " + pet.weight_kg + " кг" : ""
      }`.trim() || "—";
  }

  renderVisits(petId);
  setRoute("patient");
  if (opts.pushHash) setHash("patient", petId);
}

function renderVisits(petId) {
  const list = $("#visitsList");
  if (!list) return;

  const visits = getVisitsByPetId(petId);
  list.innerHTML = "";

  if (!visits.length) {
    list.innerHTML = `<div class="hint">Поки візитів немає. Натисни “+ Візит”.</div>`;
    return;
  }

  visits.forEach((v) => {
    const el = document.createElement("div");
    el.className = "item";
    el.dataset.visitId = v.id;

    el.innerHTML = `
      <div class="left" style="width:100%; cursor:pointer;">
        <div class="name">${escapeHtml(v.date || "—")}</div>
        ${v.note ? `<div class="meta">${escapeHtml(v.note)}</div>` : ""}
        ${
          v.rx
            ? `
          <div class="history" style="margin-top:6px;">
            <div class="history-label">Призначення</div>
            ${escapeHtml(v.rx)}
          </div>
        `
            : ""
        }
      </div>

      <div class="right" style="display:flex; gap:6px;">
  <button class="iconBtn" title="Редагувати візит" data-edit-visit="${escapeHtml(v.id)}">✏️</button>
  <button class="iconBtn" title="Видалити візит" data-del-visit="${escapeHtml(v.id)}">🗑</button>
</div>
    `;
    list.appendChild(el);
  });
}

// ===== Visit page =====
function openVisit(visitId, opts = { pushHash: true }) {
  const visit = getVisitById(visitId);
  if (!visit) return alert("Визит не найден");

  ensureVisitServicesShape(visit);
  ensureVisitStockShape(visit);

  state.selectedVisitId = visitId;

  const pet = loadPatients().find((p) => p.id === visit.pet_id) || null;
  if (pet) {
    state.selectedPetId = pet.id;
    state.selectedPet = pet;
    state.selectedOwnerId = pet.owner_id || state.selectedOwnerId;
  }

  renderVisitPage(visit, pet);
  setRoute("visit");
  if (opts.pushHash) setHash("visit", visitId);
}

// ===== Visit page rendering =====
function renderVisitPage(visit, pet) {
  const pill = $("#visitDatePill");
  if (pill) pill.textContent = visit.date || "—";

  const meta = $("#visitMeta");
  if (meta) {
    const parts = [];
    if (pet?.name) parts.push(pet.name);
    if (pet?.species) parts.push(pet.species);
    if (pet?.breed) parts.push(pet.breed);
    if (visit?.weight_kg) parts.push(`${visit.weight_kg} кг`);
    meta.textContent = parts.length ? parts.join(" • ") : "—";
  }

  const box = $("#visitNoteBox");
  if (box) {
    const note = visit.note || "";
    const rx = visit.rx || "";

    ensureVisitServicesShape(visit);

    const svcOptions = loadServices()
      .filter((s) => s.active !== false)
      .map(
        (s) =>
          `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} — ${escapeHtml(
            s.price
          )} грн</option>`
      )
      .join("");

    const expanded = expandServiceLines(visit);
    const total = calcServicesTotal(visit);

    const svcListHtml = expanded.length
      ? expanded
          .map(
            (x, idx) => `
            <div class="fileRow" style="align-items:center;">
              <div class="fileMain">
                <div class="fileName">${escapeHtml(x.name)}</div>
                <div class="fileMeta">${escapeHtml(String(x.qty))} × ${escapeHtml(
              String(x.price)
            )} грн = <b>${escapeHtml(String(x.lineTotal))} грн</b></div>
              </div>
              <div class="fileActions">
                <button class="miniBtn danger" data-svc-del="${idx}">Прибрати</button>
              </div>
            </div>
          `
          )
          .join("")
      : `<div class="hint">Поки послуг немає. Додай нижче.</div>`;

      // ===== STOCK (prepare UI vars) =====
ensureVisitStockShape(visit);

const stkOptions = loadStock()
  .filter((it) => it.active !== false)
  .map((it) => {
    const left = Number(it.qty) || 0;
    const unit = String(it.unit || "шт");
    const price = Number(it.price) || 0;
    return `<option value="${escapeHtml(it.id)}">${escapeHtml(it.name)} — ${escapeHtml(String(price))} грн/${escapeHtml(unit)} • залишок: ${escapeHtml(String(left))}</option>`;
  })
  .join("");

const stkExpanded = expandStockLines(visit);
const stkTotal = calcStockTotal(visit);

const stkListHtml = stkExpanded.length
  ? stkExpanded
      .map(
        (x, idx) => `
          <div class="fileRow" style="align-items:center;">
            <div class="fileMain">
              <div class="fileName">${escapeHtml(x.name)}</div>
              <div class="fileMeta">${escapeHtml(String(x.qty))} × ${escapeHtml(
          String(x.price)
        )} грн = <b>${escapeHtml(String(x.lineTotal))} грн</b></div>
            </div>
            <div class="fileActions">
              <button class="miniBtn danger" data-stk-del="${idx}">Прибрати</button>
            </div>
          </div>
        `
      )
      .join("")
  : `<div class="hint">Поки препаратів немає. Додай нижче.</div>`;

    box.innerHTML = `
      ${note ? `<div style="margin-bottom:10px;"><div class="history-label">Скарга / стан</div>${escapeHtml(note)}</div>` : ""}
      ${rx ? `<div style="margin-bottom:12px;"><div class="history-label">Призначення</div>${escapeHtml(rx)}</div>` : ""}

      <div class="history" style="margin-top:10px;">
        <div class="history-label">Послуги</div>

        <div style="display:flex; gap:8px; align-items:center; margin:10px 0; flex-wrap:wrap;">
          <select id="visitSvcSelect" style="flex:1; min-width:220px;">${
            svcOptions || `<option value="">(Немає послуг)</option>`
          }</select>
          <input id="visitSvcQty" type="number" min="1" value="1" style="width:90px;" />
          <button id="visitSvcAdd" class="miniBtn">Додати</button>
        </div>

        <div id="visitSvcList">${svcListHtml}</div>

        <div style="margin-top:10px; display:flex; justify-content:flex-end;">
          <div class="pill">Разом за послуги: <b>${escapeHtml(String(total))} грн</b></div>
        </div>
      </div>

            <div class="history" style="margin-top:10px;">
        <div class="history-label">Препарати (склад)</div>

        <div style="display:flex; gap:8px; align-items:center; margin:10px 0; flex-wrap:wrap;">
          <select id="visitStkSelect" style="flex:1; min-width:220px;">${
            stkOptions || `<option value="">(Немає препаратів)</option>`
          }</select>
          <input id="visitStkQty" type="number" min="1" value="1" style="width:90px;" />
          <button id="visitStkAdd" class="miniBtn">Додати</button>
        </div>

        <div id="visitStkList">${stkListHtml}</div>

        <div style="margin-top:10px; display:flex; justify-content:flex-end;">
          <div class="pill">Разом за препарати: <b>${escapeHtml(String(stkTotal))} грн</b></div>
        </div>
      </div>

      
      ${(!note && !rx && !expanded.length && !stkExpanded.length) ? `<div class="hint" style="margin-top:10px;">Поки порожньо.</div>` : ""}
    `;

// =========================
// SERVICES: bind add
// =========================
const svcAddBtn = $("#visitSvcAdd");
const svcSel = $("#visitSvcSelect");
const svcQtyEl = $("#visitSvcQty");

if (svcAddBtn && svcSel && svcQtyEl) {
  svcAddBtn.onclick = () => {
    const vid = state.selectedVisitId;
    if (!vid) return alert("Спочатку відкрий візит.");

    const serviceId = svcSel.value;
    if (!serviceId) return;

    const qty = Math.max(1, Number(svcQtyEl.value || 1));

    const ok = addServiceLineToVisit(vid, serviceId, qty, { snap: true });
    if (!ok) return alert("Не вдалося додати послугу.");

    const fresh = getVisitById(vid);
    if (fresh) ensureVisitServicesShape(fresh);

    renderVisitPage(fresh || visit, pet);
    renderDischargeA4(vid);
  };
}

// =========================
// SERVICES: bind delete
// =========================
const svcList = $("#visitSvcList");
if (svcList) {
  svcList.onclick = (e) => {
    const del = e.target.closest("[data-svc-del]");
    if (!del) return;

    const vid = state.selectedVisitId;
    if (!vid) return;

    const idx = Number(del.dataset.svcDel);
    if (!Number.isFinite(idx)) return;

    removeServiceLineFromVisit(vid, idx);

    const fresh = getVisitById(vid);
    if (fresh) ensureVisitServicesShape(fresh);

    renderVisitPage(fresh || visit, pet);
    renderDischargeA4(vid);
  };
}

   // =========================
// STOCK: bind add
// =========================
const stkAddBtn = $("#visitStkAdd");
const stkSel = $("#visitStkSelect");
const stkQtyEl = $("#visitStkQty");

if (stkAddBtn && stkSel && stkQtyEl) {
  stkAddBtn.onclick = () => {
    const vid = state.selectedVisitId;
    if (!vid) return alert("Спочатку відкрий візит.");

    const stockId = stkSel.value;
    if (!stockId) return;

    const qty = Math.max(1, Number(stkQtyEl.value || 1));

    const ok = addStockLineToVisit(vid, stockId, qty, { snap: true, decrement: true });
    if (!ok) return alert("Не вдалося додати препарат зі складу.");

    const fresh = getVisitById(vid);
    if (fresh) ensureVisitStockShape(fresh);

    renderVisitPage(fresh || visit, pet);
    renderDischargeA4(vid);
  };
}

// =========================
// STOCK: bind delete
// =========================
const stkList = $("#visitStkList");
if (stkList) {
  stkList.onclick = (e) => {
    const del = e.target.closest("[data-stk-del]");
    if (!del) return;

    const vid = state.selectedVisitId;
    if (!vid) return;

    const idx = Number(del.dataset.stkDel);
    if (!Number.isFinite(idx)) return;

    removeStockLineFromVisit(vid, idx, { restore: true });

    const fresh = getVisitById(vid);
    if (fresh) ensureVisitStockShape(fresh);

    renderVisitPage(fresh || visit, pet);
    renderDischargeA4(vid);
  };
}
  }

  // ===== Files under visit =====
  renderVisitFiles(visit.id);
}

// ===== Files rendering (unchanged) =====
function fileBadge(type, name) {
  const n = (name || "").toLowerCase();
  const t = (type || "").toLowerCase();
  const ext = n.includes(".") ? n.split(".").pop() : "";

  if (t.includes("pdf") || ext === "pdf") return { icon: "📄", label: "PDF" };
  if (t.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "heic"].includes(ext))
    return { icon: "🖼️", label: "IMG" };
  if (ext === "dcm") return { icon: "🩻", label: "DICOM" };
  return { icon: "📎", label: ext ? ext.toUpperCase() : "FILE" };
}

function fmtSize(bytes) {
  const b = Number(bytes || 0);
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  const kb = b / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function renderVisitFiles(visitId) {
  const filesList = $("#visitFilesList");
  if (!filesList) return;

  const files = getFilesForVisit(visitId);

  if (!files.length) {
    filesList.innerHTML = `<div class="hint">Поки файлів немає. Додай PDF/фото аналізів.</div>`;
    return;
  }

  filesList.innerHTML = files
    .map((f) => {
      const badge = fileBadge(f.type, f.name);
      const url = f.url || (f.stored_name ? `/uploads/${f.stored_name}` : "#");
      const size = fmtSize(f.size);
      const typeLine = [badge.label, f.type || ""].filter(Boolean).join(" • ");

      const rawName = (f.name || "").trim();
      const displayNameRaw = rawName.length >= 3 ? rawName : f.stored_name || "file";
      const shortName = displayNameRaw.length > 28 ? displayNameRaw.slice(0, 25) + "…" : displayNameRaw;

      const safeName = escapeHtml(shortName);
      const safeType = escapeHtml(typeLine);
      const safeSize = escapeHtml(size);
      const fid = escapeHtml(f.id);

      return `
        <div class="fileRow">
          <div class="fileIcon" title="${escapeHtml(badge.label)}">${escapeHtml(badge.icon)}</div>

          <div class="fileMain">
            <div class="fileName">
              <a href="${url}" target="_blank" rel="noopener noreferrer">${safeName}</a>
            </div>
            <div class="fileMeta">
              ${safeType}${size ? ` • ${safeSize}` : ""}
            </div>
          </div>

          <div class="fileActions">
            <a class="miniBtn" href="${url}" target="_blank" rel="noopener noreferrer" title="Відкрити">Відкрити</a>
            <a class="miniBtn" href="${url}" download title="Завантажити">Скачати</a>
            <button class="miniBtn danger" data-action="detach" data-file-id="${fid}" title="Відв’язати від візиту">Відв’язати</button>
            <button class="miniBtn danger2" data-action="delete" data-file-id="${fid}" title="Видалити з сервера">Видалити</button>
          </div>
        </div>
      `;
    })
    .join("");
}

// ===== Visit modal (create + edit) =====
function openVisitModalForCreate(pet) {
  const modal = $("#visitModal");
  if (!modal) return;

  state.selectedVisitId = null;

  const sub = $("#visitModalSub");
  if (sub) sub.textContent = `Пацієнт: ${pet?.name || "—"} • новий візит`;

  $("#visitDate").value = todayISO();
  $("#visitNote").value = "";
  $("#visitDx").value = "";
  $("#visitWeight").value = pet?.weight_kg || "";
  $("#visitRx").value = "";

  const saveBtn = $("#visitSave");
  if (saveBtn) saveBtn.textContent = "Сохранить визит";

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => $("#visitNote")?.focus(), 50);
}

function openVisitModalForEdit(visitId) {
  const modal = $("#visitModal");
  if (!modal) return;

  const visit = getVisitById(visitId);
  if (!visit) return alert("Візит не знайдено");

  state.selectedVisitId = visitId;

  const pet = state.selectedPet || loadPatients().find((p) => p.id === visit.pet_id) || null;
  const sub = $("#visitModalSub");
  if (sub) sub.textContent = `Пацієнт: ${pet?.name || "—"} • редагування`;

  const parsed = parseVisitNoteToDxAndNote(visit.note);

  $("#visitDate").value = visit.date || todayISO();
  $("#visitNote").value = parsed.note || "";
  $("#visitDx").value = parsed.dx || "";
  $("#visitWeight").value = visit.weight_kg || (pet?.weight_kg || "");
  $("#visitRx").value = visit.rx || "";

  const saveBtn = $("#visitSave");
  if (saveBtn) saveBtn.textContent = "Зберегти зміни";

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => $("#visitNote")?.focus(), 50);
}

function closeVisitModal() {
  const modal = $("#visitModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

// ===== Discharge (A4 preview in modal) =====
function getContextForVisit(visitId) {
  const visit = getVisitById(visitId);
  if (!visit) return { visit: null, pet: null, owner: null };

  const pet = loadPatients().find((p) => p.id === visit.pet_id) || null;
  const owner = pet ? getOwnerById(pet.owner_id) : null;
  return { visit, pet, owner };
}

function readDischargeForm() {
  return {
    complaint: ($("#disComplaint")?.value || "").trim(),
    dx: ($("#disDx")?.value || "").trim(),
    rx: ($("#disRx")?.value || "").trim(),
    recs: ($("#disRecs")?.value || "").trim(),
    follow: ($("#disFollow")?.value || "").trim(),
  };
}

function fillDischargeForm(visit, existing) {
  const parsed = parseVisitNoteToDxAndNote(visit?.note || "");
  const defaults = {
    complaint: visit?.note || "",
    dx: parsed.dx || "",
    rx: visit?.rx || "",
    recs: "",
    follow: "",
  };

  const d = { ...defaults, ...(existing || {}) };

  const c = $("#disComplaint"); if (c) c.value = d.complaint || "";
  const dx = $("#disDx"); if (dx) dx.value = d.dx || "";
  const rx = $("#disRx"); if (rx) rx.value = d.rx || "";
  const recs = $("#disRecs"); if (recs) recs.value = d.recs || "";
  const fol = $("#disFollow"); if (fol) fol.value = d.follow || "";
}

function setA4Text(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text || "—";
}

function renderDischargeA4(visitId) {
  const { visit, pet, owner } = getContextForVisit(visitId);
  if (!visit) return;

  // на всякий случай для старых визитов
  if (typeof ensureVisitServicesShape === "function") ensureVisitServicesShape(visit);

  const d = readDischargeForm();

  const sub = $("#disSub");
  if (sub) sub.textContent = `${pet?.name || "—"} • ${visit?.date || "—"} • Візит ID: ${visitId}`;

  setA4Text("#pDate", visit?.date || "—");
  setA4Text("#pVisitId", visitId);

  setA4Text(
    "#pPet",
    [
      pet?.name || "—",
      pet?.species ? `(${pet.species})` : "",
      pet?.breed ? pet.breed : "",
    ].filter(Boolean).join(" ").trim()
  );

  const w = (visit?.weight_kg || pet?.weight_kg)
    ? `${visit?.weight_kg || pet?.weight_kg} кг`
    : "—";
  setA4Text("#pWeight", w);

  setA4Text("#pOwner", owner?.name || "—");
  setA4Text("#pPhone", owner?.phone || "—");

  setA4Text("#pComplaint", d.complaint || "—");
  setA4Text("#pDx", d.dx || "—");

  const rxEl = $("#pRx");
  if (rxEl) rxEl.textContent = d.rx || "—";

  // ✅ Послуги (окремий блок) — PRO layout
const expanded = typeof expandServiceLines === "function" ? expandServiceLines(visit) : [];
const total = typeof calcServicesTotal === "function" ? calcServicesTotal(visit) : 0;

const svcEl = $("#pServices");
const totEl = $("#pTotal");

// ВАЖНО: теперь рендерим HTML (таблица + плашки)
if (svcEl) {
  svcEl.innerHTML = renderServicesProA4(expanded, total);
}

// Старый pTotal больше не нужен (итог уже в таблице)
if (totEl) totEl.textContent = "";

// ✅ Препарати (склад) + totals
if (typeof ensureVisitStockShape === "function") ensureVisitStockShape(visit);

const stkExpandedA4 = typeof expandStockLines === "function" ? expandStockLines(visit) : [];
const stkTotalA4 = typeof calcStockTotal === "function" ? calcStockTotal(visit) : 0;

const stkEl = $("#pStock");
const stkTotEl = $("#pStockTotal");

if (stkEl) {
  if (!stkExpandedA4.length) {
    stkEl.innerHTML = `<div class="hint" style="opacity:.75">—</div>`;
  } else {
    const rows = stkExpandedA4.map((x) => `
      <tr>
        <td title="${escapeHtml(x.name || "")}">${escapeHtml(x.name || "—")}</td>
        <td>${escapeHtml(String(x.qty))}</td>
        <td>${escapeHtml(String(x.price))}</td>
        <td>${escapeHtml(String(x.lineTotal))}</td>
      </tr>
    `).join("");

    stkEl.innerHTML = `
      <div class="servicesPro">
        <table class="servicesTable">
          <thead>
            <tr>
              <th>Препарат</th>
              <th>К-сть</th>
              <th>Ціна</th>
              <th>Сума</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="3">Разом</td>
              <td>${escapeHtml(String(stkTotalA4))} грн</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  }
}

// ✅ Grand total: послуги + препарати
const grand = (Number(total) || 0) + (Number(stkTotalA4) || 0);
const gEl = $("#pGrandTotal");
if (gEl) gEl.textContent = `${grand} грн`;

if (stkTotEl) stkTotEl.textContent = "";
  const recsEl = $("#pRecs");
  if (recsEl) recsEl.textContent = d.recs || "—";

  const folEl = $("#pFollow");
  if (folEl) folEl.textContent = d.follow || "—";
}

function openDischargeModal(visitId) {
  const modal = $("#dischargeModal");
  if (!modal) return;

  const { visit } = getContextForVisit(visitId);
  if (!visit) return alert("Візит не знайдено");

  const existing = getDischarge(visitId) || null;
  fillDischargeForm(visit, existing);
  renderDischargeA4(visitId);

  modal.dataset.visitId = visitId;

  // bind listeners ONCE
  if (!state.dischargeListenersBound) {
    const live = () => {
      const vid = modal.dataset.visitId;
      if (vid) renderDischargeA4(vid);
    };

    ["#disComplaint", "#disDx", "#disRx", "#disRecs", "#disFollow"].forEach((sel) => {
      $(sel)?.addEventListener("input", live);
    });

    // SAVE
    $("#disSave")?.addEventListener("click", () => {
      const vid = modal.dataset.visitId;
      if (!vid) return;
      setDischarge(vid, readDischargeForm());
      alert("✅ Збережено");
    });

    // PRINT (A4 only)
    $("#disPrint")?.addEventListener("click", () => {
      const vid = modal.dataset.visitId;
      if (!vid) return;
      printA4Only(vid);
    });

    // DOWNLOAD PDF — Android Telegram fix
    const bindDownload = () => {
      const btn = document.getElementById("disDownload");
      if (!btn) return;

      const run = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const vid = modal.dataset.visitId;
        if (!vid) return;

        btn.textContent = "Генерую…";
        btn.disabled = true;

        Promise.resolve()
          .then(() => downloadA4Pdf(vid))
          .finally(() => {
            btn.disabled = false;
            btn.textContent = "Скачати PDF";
          });
      };

      btn.onclick = null;
      btn.ontouchstart = null;

      btn.addEventListener("click", run, { passive: false });
      btn.addEventListener("touchstart", run, { passive: false });
    };

    bindDownload();
    setTimeout(bindDownload, 0);

    // close handlers
    modal.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-discharge]")) closeDischargeModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeDischargeModal();
        closeVisitModal();
      }
    });

    state.dischargeListenersBound = true;
  }

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeDischargeModal() {
  const modal = $("#dischargeModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  delete modal.dataset.visitId;
}


// ===== UI init =====
function initOwnersUI() {
  // ➕ Добавить владельца
  $("#btnAddOwner")?.addEventListener("click", async () => {
    const name = prompt("Имя владельца:");
    if (!name) return;

    const phone = prompt("Телефон (необязательно):") || "";
    const note = prompt("Заметка/город (необязательно):") || "";

    const created = await createOwner(
      name.trim(),
      phone.trim(),
      note.trim()
    );
    if (!created) return;

    state.owners.unshift(created);
    renderOwners();
  });

  // 🗑 / ➡️ Клик по списку владельцев
  $("#ownersList")?.addEventListener("click", async (e) => {
    // 🗑 Удаление
    const delBtn = e.target.closest("[data-del]");
    if (delBtn) {
      const id = delBtn.dataset.del;
      if (!id) return;

      if (!confirm("Удалить владельца?")) return;

      const ok = await deleteOwner(id);
      if (!ok) {
        alert("Не удалось удалить владельца");
        return;
      }

      state.owners = state.owners.filter((o) => o.id !== id);
      renderOwners();
      return;
    }

    // ➡️ Открытие владельца
    const openZone = e.target.closest("[data-open-owner]");
    if (openZone) {
      const ownerId = openZone.dataset.openOwner;
      if (ownerId) openOwner(ownerId);
    }
  });

  $("#btnBackOwners")?.addEventListener("click", () => setHash("owners"));
}

function initOwnerUI() {
  $("#btnAddPet")?.addEventListener("click", async () => {
    const ownerId = state.selectedOwnerId;
    if (!ownerId) return alert("Спочатку обери власника");

    const name = prompt("Кличка:");
    if (!name) return;

    const species = prompt("Вид (пес/кот/птица…):", "пес") || "";
    const breed = prompt("Порода (необязательно):") || "";
    const age = prompt("Возраст (например: 3 года / 8 мес):") || "";
    const weight_kg = prompt("Вес (кг, например 7.5):") || "";
    const note = prompt("Заметки (необязательно):") || "";

    const created = await createPatientApi({
      owner_id: ownerId,
      name: name.trim(),
      species: species.trim(),
      breed: breed.trim(),
      age: age.trim(),
      weight_kg: weight_kg.trim(),
      note: note.trim(),
    });

    if (!created) return;

    const patients = loadPatients();
    patients.unshift({
      id: created.id,
      owner_id: created.owner_id,
      name: created.name,
      species: created.species,
      breed: created.breed,
      age: created.age,
      weight_kg: created.weight_kg,
      notes: created.note || "",
    });

    savePatients(patients);
    renderOwnerPage(ownerId);
  });

  $("#petsList")?.addEventListener("click", (e) => {
    const delBtn = e.target.closest("[data-del-pet]");
    if (delBtn) {
      const petId = delBtn.dataset.delPet;
      const patients = loadPatients().filter((p) => p.id !== petId);
      savePatients(patients);
      if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
      return;
    }

    const openZone = e.target.closest("[data-open-pet]");
    if (openZone) {
      const petId = openZone.dataset.openPet;
      if (petId) openPatient(petId);
    }
  });
}

function initVisitsTabUI() {
  const page = $(`.page[data-page="visits"]`);
  if (!page) return;

  page.addEventListener("click", (e) => {
  const del = e.target.closest("[data-del-visit]");
  if (del) {
    const visitId = del.dataset.delVisit;
    if (!visitId) return;

    if (!confirm("Видалити візит назавжди?")) return;

    const ok = deleteVisitEverywhere(visitId);
    if (!ok) alert("Не вдалося видалити візит.");
    return;
  }

  const btn = e.target.closest("[data-open-visit]");
  if (!btn) return;
  const visitId = btn.dataset.openVisit;
  if (visitId) openVisit(visitId);
});
}

function initPatientUI() {
  $("#btnBackOwner")?.addEventListener("click", () => {
    if (state.selectedOwnerId) openOwner(state.selectedOwnerId);
    else setHash("owners");
  });

  $("#btnAddVisit")?.addEventListener("click", () => {
    const pet = state.selectedPet;
    if (!pet) return alert("Пацієнт не обраний");
    openVisitModalForCreate(pet);
  });

  $("#visitsList")?.addEventListener("click", (e) => {

  // 🗑 УДАЛЕНИЕ ВИЗИТА — САМОЕ ПЕРВОЕ
  const delBtn = e.target.closest("[data-del-visit]");
  if (delBtn) {
    const visitId = delBtn.dataset.delVisit;
    if (!visitId) return;

    if (!confirm("Видалити цей візит?")) return;

    const ok = deleteVisitEverywhere(visitId);
    if (!ok) alert("Не вдалося видалити візит.");
    return;
  }

  // ✏️ РЕДАКТИРОВАНИЕ
  const editBtn = e.target.closest("[data-edit-visit]");
  if (editBtn) {
    const visitId = editBtn.dataset.editVisit;
    if (visitId) openVisitModalForEdit(visitId);
    return;
  }

  // ➡️ ОТКРЫТИЕ ВИЗИТА
  const item = e.target.closest(".item");
  if (!item) return;
  const visitId = item.dataset.visitId;
  if (visitId) openVisit(visitId);
});
  };

  // Upload files -> server -> files + links
  $("#visitFiles")?.addEventListener("change", async (e) => {
  const input = e.currentTarget; // или e.target

  try {
    const visitId = state.selectedVisitId;
    if (!visitId) {
      alert("Спочатку відкрий візит (щоб було куди прикріпляти файли).");
      return;
    }

    const chosen = Array.from(input.files || []);
    if (!chosen.length) return;

    const fd = new FormData();
    chosen.forEach((f) => fd.append("files", f));

    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error || "Upload failed");

    const savedMeta = data.files || [];
    if (!savedMeta.length) throw new Error("Сервер не повернув файли");

    upsertFilesFromServerMeta(savedMeta);

    const fileIds = savedMeta
      .map((m) => (m?.stored_name ? fileIdFromStored(m.stored_name) : null))
      .filter(Boolean);

    linkFilesToVisit(visitId, fileIds);
    renderVisitFiles(visitId);
  } catch (err) {
    console.error(err);
    alert("Помилка завантаження: " + (err?.message || err));
    if (state.selectedVisitId) renderVisitFiles(state.selectedVisitId);
  } finally {
    if (input) input.value = "";
  }
});

  // Actions on files list: detach / delete
  $("#visitFilesList")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.dataset.action;
    const fileId = btn.dataset.fileId;
    const visitId = state.selectedVisitId;
    if (!action || !fileId || !visitId) return;

    if (action === "detach") {
      detachFileFromVisit(visitId, fileId);
      renderVisitFiles(visitId);
      return;
    }

    if (action === "delete") {
      const file = getFileById(fileId);
      if (!file) return;

      const linksCount = countLinksForFile(fileId);
      const msg =
        linksCount > 1
          ? `Файл використовується у ${linksCount} візитах.\nВидалити з сервера повністю?`
          : "Видалити файл з сервера повністю?";

      if (!confirm(msg)) return;

      try {
        await fetch("/api/delete_upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stored_name: file.stored_name }),
        });

        deleteFileEverywhereLocal(fileId);
        renderVisitFiles(visitId);
      } catch (err) {
        console.error(err);
        alert("Не вдалося видалити файл: " + (err?.message || err));
      }
    }
  });

  // modal buttons
  $("#visitCancel")?.addEventListener("click", closeVisitModal);
  $("#visitClose")?.addEventListener("click", closeVisitModal);
  $("#visitModal")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeVisitModal();
  });

  // save visit (create/edit)
  $("#visitSave")?.addEventListener("click", () => {
    const pet = state.selectedPet;
    if (!pet) return alert("Пацієнт не обраний");

    const date = $("#visitDate")?.value || todayISO();
    const notePlain = ($("#visitNote")?.value || "").trim();
    const dx = ($("#visitDx")?.value || "").trim();
    const weight = ($("#visitWeight")?.value || "").trim();
    const rx = ($("#visitRx")?.value || "").trim();

    if (!notePlain && !dx && !rx) return alert("Заповни хоча б щось");

    const visits = loadVisits();

    // EDIT
    if (state.selectedVisitId) {
      const v = visits.find((x) => x.id === state.selectedVisitId);
      if (!v) return alert("Візит не знайдено");

      if (typeof ensureVisitServicesShape === "function") ensureVisitServicesShape(v);

      v.date = date;
      v.note = buildVisitNote(dx, notePlain);
      v.rx = rx;
      v.weight_kg = weight;

      saveVisits(visits);
      closeVisitModal();

      if (state.selectedPetId) renderVisits(state.selectedPetId);
      openVisit(state.selectedVisitId);

      if (state.route === "visits") renderVisitsTab();
      return;
    }

    // CREATE
    const newId = String(Date.now());
    visits.unshift({
  id: newId,
  pet_id: pet.id,
  date,
  note: buildVisitNote(dx, notePlain),
  rx,
  weight_kg: weight,
  services: [],
  stock: [], // ✅ важно
});

    saveVisits(visits);
    closeVisitModal();
    renderVisits(pet.id);

    if (state.route === "visits") renderVisitsTab();
  });

// ===== Visit page UI (buttons on visit page) =====
function initVisitUI() {
  $("#btnBackPatient")?.addEventListener("click", () => {
    if (state.selectedPetId) openPatient(state.selectedPetId);
    else if (state.selectedOwnerId) openOwner(state.selectedOwnerId);
    else setHash("owners");
  });

  $("#btnDischarge")?.addEventListener("click", () => {
    const visitId = state.selectedVisitId;
    if (!visitId) return alert("Спочатку відкрий візит.");
    openDischargeModal(visitId);
  });
}

function deletePatientEverywhere(petId) {
  const patients = loadPatients();
  const pet = patients.find((p) => p.id === petId);
  if (!pet) return;

  const name = pet.name || "Без імені";
  const visits = loadVisits();
  const hasVisits = visits.some((v) => v.pet_id === petId);

  const msg = hasVisits
    ? `У пацієнта "${name}" є візити.\nВидалити пацієнта? (візити залишаться в історії)`
    : `Видалити пацієнта "${name}"?`;

  if (!confirm(msg)) return;

  savePatients(patients.filter((p) => p.id !== petId));

  // если сейчас открыт этот пациент — уходим на список
  if (state.selectedPetId === petId) {
    state.selectedPetId = null;
    state.selectedPet = null;
    setHash("patients");
  }

  // перерисуем
  if (state.route === "patients") renderPatientsTab();
  if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
  if (state.route === "visits") renderVisitsTab();
}

function deleteVisitEverywhere(visitId) {
  if (!visitId) return false;

  const visits = loadVisits();
  const toDelete = visits.find((v) => v.id === visitId);
  if (!toDelete) return false; // не нашли визит

  // ✅ restore stock when deleting the whole visit (до удаления визита)
  if (Array.isArray(toDelete.stock) && toDelete.stock.length) {
    const stock = loadStock();
    const byId = new Map(stock.map((x) => [x.id, x]));

    toDelete.stock.forEach((line) => {
      const id = line?.stockId;
      const q = Math.max(1, Number(line?.qty) || 1);
      const item = byId.get(id);
      if (item) item.qty = (Number(item.qty) || 0) + q;
    });

    saveStock(Array.from(byId.values()));
  }

  // 1) удалить визит из VISITS
  saveVisits(visits.filter((v) => v.id !== visitId));

  // 2) убрать привязки visit_files
  saveVisitFiles(loadVisitFiles().filter((l) => l.visit_id !== visitId));

  // 3) удалить discharge по визиту
  const d = loadDischarges();
  if (d && typeof d === "object" && d[visitId]) {
    delete d[visitId];
    saveDischarges(d);
  }

  // 4) если сейчас открыт этот визит — закрыть экран визита
  if (state.selectedVisitId === visitId) {
    state.selectedVisitId = null;
    if (state.selectedPetId) openPatient(state.selectedPetId);
    else setHash("visits");
  }

  // 5) обновить списки
  if (state.route === "visits") renderVisitsTab();
  if (state.selectedPetId) renderVisits(state.selectedPetId);

  return true;
}

// ===== Init =====
async function init() {
  initTabs();
  seedIfEmpty();

  migrateLegacyVisitFilesIfNeeded();

  initOwnersUI();
  initOwnerUI();
  initPatientUI();
  initVisitUI();
  initVisitsTabUI();

  renderServicesTab();
  renderStockTab();

  $("#btnReload")?.addEventListener("click", async () => {
    await loadMe();
    await loadOwners();
  });

  await loadMe();
  await loadOwners(); // ← ВАЖНО: ждём данные, потом рендер
}

// ===== iOS / Telegram WebApp viewport fix =====
function setVH() {
  document.documentElement.style.setProperty(
    "--vh",
    `${window.innerHeight * 0.01}px`
  );
}
setVH();
window.addEventListener("resize", setVH);

// ===== INIT =====
init();
