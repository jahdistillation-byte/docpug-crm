// ==========================================================================
// Doc.PUG CRM Mini — app.js (ЯДРО: СОСТОЯНИЕ, РОУТИНГ, АНАЛИТИКА, API)
// Часть 1 (Строки 1 — 1500)
// ==========================================================================

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

let calendarMode = "day";

// =========================
// FILES helpers (LOCAL links)
// =========================
function fileIdFromStored(storedName) {
  return "f_" + String(storedName || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function loadVisitFilesLinks() {
  const arr = LS.get(VISIT_FILES_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function saveVisitFilesLinks(arr) {
  LS.set(VISIT_FILES_KEY, Array.isArray(arr) ? arr : []);
}

function getFileIdsForVisit(visitId) {
  const vid = String(visitId || "");
  if (!vid) return [];
  return loadVisitFilesLinks()
    .filter((x) => String(x.visit_id) === vid)
    .map((x) => String(x.file_id))
    .filter(Boolean);
}

function linkFilesToVisit(visitId, fileIds) {
  const vid = String(visitId || "");
  if (!vid) return;

  const ids = (Array.isArray(fileIds) ? fileIds : [])
    .map((x) => String(x || ""))
    .filter(Boolean);

  if (!ids.length) return;

  const links = loadVisitFilesLinks();

  for (const fid of ids) {
    const exists = links.some(
      (r) => String(r.visit_id) === vid && String(r.file_id) === fid
    );
    if (!exists) links.push({ visit_id: vid, file_id: fid, created_at: nowISO() });
  }

  saveVisitFilesLinks(links);
}

function detachFileFromVisit(visitId, fileId) {
  const vid = String(visitId || "");
  const fid = String(fileId || "");
  if (!vid || !fid) return;

  const next = loadVisitFilesLinks().filter(
    (r) => !(String(r.visit_id) === vid && String(r.file_id) === fid)
  );
  saveVisitFilesLinks(next);
}

function upsertFilesFromServerMeta(serverMeta) {
  const list = Array.isArray(serverMeta) ? serverMeta : [];
  if (!list.length) return;

  const cur = Array.isArray(LS.get(FILES_KEY, []))
    ? LS.get(FILES_KEY, [])
    : [];

  const byId = new Map(cur.map((f) => [String(f.id), f]));

  for (const m of list) {
    if (!m) continue;

    const stored = m.stored_name || m.storedName || "";
    if (!stored) continue;

    const id = String(m.id || fileIdFromStored(stored));

    const row = {
      id,
      stored_name: stored,
      url: m.url || `/uploads/${stored}`,
      name: m.name || m.original_name || stored,
      size: Number(m.size || 0),
      type: m.type || m.mime || "",
    };

    const prev = byId.get(id) || {};
    byId.set(id, { ...prev, ...row });
  }

  const next = Array.from(byId.values());
  if (typeof state !== "undefined") state.files = next;
  LS.set(FILES_KEY, next);
}

async function migrateLegacyVisitFilesIfNeeded() {
  return; // no-op
}

// ✅ Services registry
const SERVICES_KEY = "docpug_services_v1";
const SERVICES_CAT_KEY = "docpug_services_cat_v1";

function normalizeServiceRow(s) {
  const cat =
    (s?.cat ?? s?.category ?? s?.section ?? s?.group ?? s?.type ?? "").toString().trim();

  return {
    ...s,
    cat: cat || "Інше",
  };
}

// ✅ Stock registry
const STOCK_KEY = "docpug_stock_v1";

// ===== State =====
const state = {
  route: "owners",
  apiOk: null,
  me: null,

  owners: [],
  patients: [],
  visits: [],
  services: [],

  selectedOwnerId: null,
  selectedPetId: null,
  selectedPet: null,
  selectedVisitId: null,

  visitSvcQuery: "",
  visitStkQuery: "",
  servicesQuery: "",

  dischargeListenersBound: false,
  ownersUiBound: false,
  printCssInjected: false,
  visitAddBtnsBound: false,
  visitFilesUiBound: false,

  visitsById: new Map(),
};

// ===== Visits cache helpers (server) =====
function cacheVisits(arr) {
  (arr || []).forEach((v) => {
    if (v && v.id != null) state.visitsById.set(String(v.id), v);
  });
}

function getVisitByIdSync(id) {
  if (!id) return null;
  return state.visitsById.get(String(id)) || null;
}

function normalizeVisitFromServer(visit) {
  if (!visit) return visit;

  const sj = visit.services_json;
  let sjArr = null;
  if (Array.isArray(sj)) sjArr = sj;
  else if (typeof sj === "string") {
    try { sjArr = JSON.parse(sj); } catch { sjArr = null; }
  }

  const hasServicesArr = Array.isArray(visit.services);
  const hasSjArr = Array.isArray(sjArr);
  if (!hasServicesArr || (visit.services.length === 0 && hasSjArr && sjArr.length > 0)) {
    visit.services = hasSjArr ? sjArr : [];
  }

  const stj = visit.stock_json;
  let stArr = null;
  if (Array.isArray(stj)) stArr = stj;
  else if (typeof stj === "string") {
    try { stArr = JSON.parse(stj); } catch { stArr = null; }
  }

  const hasStockArr = Array.isArray(visit.stock);
  const hasStArr = Array.isArray(stArr);
  if (!hasStockArr || (visit.stock.length === 0 && hasStArr && stArr.length > 0)) {
    visit.stock = hasStArr ? stArr : [];
  }

  return visit;
}

async function fetchVisitById(id) {
  if (!id) return null;
  const vid = String(id);
  const prev = state.visitsById.get(vid) || null;

  try {
    const res = await fetch(`/api/visits?id=${encodeURIComponent(vid)}`, {
      credentials: "include",
      headers: { Accept: "application/json", ...getOrgHeaders() },
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok || !json || !json.ok) return prev;

    const arr = Array.isArray(json.data) ? json.data : (json.data ? [json.data] : []);
    let v = arr[0] || null;

    v = normalizeVisitFromServer(v);

    if (prev && v) {
      if (Array.isArray(prev.services) && prev.services.length && (!Array.isArray(v.services) || v.services.length === 0)) {
        v.services = prev.services;
        v.services_json = prev.services;
      }
      if (Array.isArray(prev.stock) && prev.stock.length && (!Array.isArray(v.stock) || v.stock.length === 0)) {
        v.stock = prev.stock;
        v.stock_json = prev.stock;
      }
    }

    if (v?.id != null) state.visitsById.set(vid, v);
    return v || prev;
  } catch (e) {
    console.warn("fetchVisitById failed, return cache:", e);
    return prev;
  }
}

// ===== LocalStorage helper =====
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

function getOrgHeaders() {
    const orgId = sessionStorage.getItem("pug_active_org_id");
    return orgId ? { "X-Org-ID": orgId } : {};
}


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

function buildVisitNote(dx, complaint) {
  const a = String(dx || "").trim();
  const b = String(complaint || "").trim();
  if (a && b) return `Діагноз: ${a}\n\nСкарги/анамнез: ${b}`;
  if (a) return `Діагноз: ${a}`;
  return b;
}

function setMeLine(text) {
  const el = $("#meLine");
  if (el) el.textContent = text;
}

// ===== Router =====
const TAB_ROUTES = new Set([
  "owners",
  "patients",
  "visits",
  "services",
  "calendar",
  "stock",
  "settings",
]);

function parseHash() {
  const raw = (location.hash || "").replace("#", "").trim();
  if (!raw) return { route: "owners", id: null };

  const [routeRaw, idRaw] = raw.split(":");
  const route = (routeRaw || "owners").trim() || "owners";
  const id = idRaw != null ? String(idRaw).trim() : null;
  return { route, id };
}

function setHash(route, id = null) {
  const r = String(route || "owners").trim() || "owners";
  const next = id ? `${r}:${id}` : r;
  if (location.hash.replace("#", "") !== next) location.hash = next;
}

function setRoute(route) {
  const r = String(route || "owners").trim() || "owners";
  const pageExists = document.querySelector(`.page[data-page="${r}"]`);
  const finalRoute = pageExists ? r : "owners";

  state.route = finalRoute;

  // Переключаем секции (в новом HTML они скрыты через display: none)
  Array.from(document.querySelectorAll(".page")).forEach((p) => {
    p.classList.toggle("active", p.dataset.page === finalRoute);
    if (p.dataset.page === finalRoute) {
      p.style.display = "block";
    } else {
      p.style.display = "none";
    }
  });

  // Подсвечиваем активную вкладку в новом боковом меню
  if (TAB_ROUTES.has(finalRoute)) {
    Array.from(document.querySelectorAll("#tabs .menu-item, #tabs .tab")).forEach((btn) => {
      const btnRoute = btn.dataset.target || btn.dataset.route;
      btn.classList.toggle("active", btnRoute === finalRoute);
    });
  }
}

function initTabs() {
  const tabs = document.getElementById("tabs");
  if (!tabs) return;

  tabs.addEventListener("click", (e) => {
    // Ловим клик по новому классу .menu-item
    const btn = e.target.closest(".menu-item") || e.target.closest(".tab");
    if (!btn) return;
    
    // Берем маршрут из нового data-target
    const route = btn.dataset.target || btn.dataset.route;
    if (!TAB_ROUTES.has(route)) return;
    
    setHash(route);
  });

  window.addEventListener("hashchange", routeFromHash);
  routeFromHash();
}

async function routeFromHash() {
  const { route, id } = parseHash();

  if (TAB_ROUTES.has(route)) {
    setRoute(route);
    if (route === "owners") renderOwners();
    if (route === "patients") renderPatientsTab();
    if (route === "visits") renderVisitsTab();
    if (route === "services") renderServicesTab();
    if (route === "stock") renderStockTab();
    if (route === "calendar") renderCalendarTab();
     if (route === "settings") {
       // Поскольку настройки статические, просто инициализируем их UI
       initSettingsUI();
    }
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

  if (route === "settings") renderSettingsTab();

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
    const name = state.me?.name || state.me?.first_name || state.me?.username || "Пользователь";
    const tgId = state.me?.tg_user_id || state.me?.id || state.me?.user_id || null;

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
  if (!LS.get(VISITS_KEY, null)) LS.set(VISITS_KEY, []);
  if (!LS.get(FILES_KEY, null)) LS.set(FILES_KEY, []);
  if (!LS.get(VISIT_FILES_KEY, null)) LS.set(VISIT_FILES_KEY, []);
  if (!LS.get(DISCHARGES_KEY, null)) LS.set(DISCHARGES_KEY, {});

  if (!LS.get(STOCK_KEY, null)) {
    LS.set(STOCK_KEY, [
      { id: "stk_meloxivet", name: "Мелоксивет", price: 70, unit: "шт", qty: 10, active: true },
    ]);
  }

  if (!LS.get(SERVICES_KEY, null)) {
    LS.set(SERVICES_KEY, [
      { id: "svc_exam",       name: "Огляд",            price: 500,  active: true, cat: "Терапія" },
      { id: "svc_trip",       name: "Виїзд",            price: 1500, active: true, cat: "Виїзд" },
      { id: "svc_vax",        name: "Вакцинація",       price: 800,  active: true, cat: "Терапія" },
      { id: "svc_consult",    name: "Консультація",     price: 500,  active: true, cat: "Терапія" },
      { id: "svc_cat_castr",  name: "Кастрація кота",   price: 2500, active: true, cat: "Хірургія" },
      { id: "svc_dog_castr",  name: "Кастрація пса",    price: 3500, active: true, cat: "Хірургія" },
    ]);
  }

  if (location.protocol !== "file:") return;

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
  } else {
    if (!Array.isArray(patients)) LS.set(PATIENTS_KEY, []);
  }
}

// ===== API: Owners =====
async function loadOwners() {
  try {
   const res = await fetch("/api/owners", {
    credentials: "include",
    headers: { Accept: "application/json", ...getOrgHeaders() },
});
    const text = await res.text()
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /owners HTTP", res.status, text);
      alert(`Помилка завантаження власників (HTTP ${res.status})`);
      state.owners = [];
      renderOwners();
      return [];
    }

    if (!json || !json.ok) {
      console.error("API /owners bad json", json, text);
      alert(json?.error || "Помилка завантаження власників");
      state.owners = [];
      renderOwners();
      return [];
    }

    const arr = Array.isArray(json.data) ? json.data : (json.data ? [json.data] : []);
    state.owners = arr;
    LS.set(OWNERS_KEY, arr);

    renderOwners();
    if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
    return arr;
  } catch (e) {
    console.error("loadOwners failed:", e);
    alert("Помилка завантаження власників (network)");
    state.owners = Array.isArray(state.owners) ? state.owners : [];
    renderOwners();
    return [];
  }
}

// ===== API: Patients =====
async function loadPatientsApi() {
  try {
    const res = await fetch("/api/patients", {
      credentials: "include",
      headers: { Accept: "application/json", ...getOrgHeaders() },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /patients HTTP", res.status, text);
      alert(`Помилка завантаження пацієнтів (HTTP ${res.status})`);
      state.patients = [];
      renderPatientsTab();
      if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
      return [];
    }

    if (!json || !json.ok) {
      console.error("API /patients bad json", json, text);
      alert(json?.error || "Помилка завантаження пацієнтів");
      state.patients = [];
      renderPatientsTab();
      if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
      return [];
    }

    const arr = Array.isArray(json.data) ? json.data : (json.data ? [json.data] : []);
    state.patients = arr;
    savePatients(arr);

    renderPatientsTab();
    if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
    return arr;
  } catch (e) {
    console.error("loadPatientsApi failed:", e);
    alert("Помилка завантаження пацієнтів (network)");
    state.patients = [];
    renderPatientsTab();
    if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
    return [];
  }
}

// =========================
// Services API
// =========================
async function loadServicesApi() {
  try {
    const res = await fetch("/api/services", {
      credentials: "include",
      headers: { Accept: "application/json", ...getOrgHeaders() },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok || !json || !json.ok) {
      console.warn("loadServicesApi failed:", res.status, text);
      const cached = LS.get(SERVICES_KEY, []);
      state.services = Array.isArray(cached) ? cached : [];
      return state.services;
    }

    const arr = Array.isArray(json.data) ? json.data : (json.data ? [json.data] : []);
    const catMap = loadServicesCatMap();

    const merged = (Array.isArray(arr) ? arr : []).map((s) => {
      const id = String(s?.id || "");
      const savedCat = catMap[id];
      const rawCat = (s?.cat ?? s?.category ?? s?.section ?? s?.group ?? s?.type ?? savedCat ?? "");
      const cat = String(rawCat || "").trim() || "Інше";
      return { ...s, cat };
    });

    state.services = merged;
    LS.set(SERVICES_KEY, merged);
    return merged;
  } catch (e) {
    console.warn("loadServicesApi network fail:", e);
    const cached = LS.get(SERVICES_KEY, []);
    state.services = Array.isArray(cached) ? cached : [];
    return state.services;
  }
}

async function createServiceApi(payload) {
  try {
    const res = await fetch("/api/services", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...getOrgHeaders() },
      body: JSON.stringify(payload || {}),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok || !json || !json.ok) return null;
    return Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
  } catch (e) {
    console.error("createServiceApi failed:", e);
    return null;
  }
}

async function updateServiceApi(id, patch) {
  try {
    const res = await fetch(`/api/services?id=${encodeURIComponent(String(id))}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...getOrgHeaders() },
      body: JSON.stringify(patch || {}),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok || !json || !json.ok) return null;
    return Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
  } catch (e) {
    console.error("updateServiceApi failed:", e);
    return null;
  }
}

async function deleteServiceApi(id) {
  try {
    const res = await fetch(`/api/services?id=${encodeURIComponent(String(id))}`, {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json", ...getOrgHeaders() },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return !!(res.ok && json && json.ok);
  } catch (e) {
    console.error("deleteServiceApi failed:", e);
    return false;
  }
}

async function createPatientApi(payload) {
  try {
    const bodyObj = {
      owner_id: payload?.owner_id,
      name: (payload?.name || "").trim(),
      species: (payload?.species || "").trim(),
      breed: (payload?.breed || "").trim(),
      age: (payload?.age || "").trim(),
      weight_kg: (payload?.weight_kg || "").trim(),
      notes: (payload?.notes || payload?.note || "").trim(),
    };

    Object.keys(bodyObj).forEach((k) => {
      if (bodyObj[k] === "" || bodyObj[k] == null) delete bodyObj[k];
    });

    const res = await fetch("/api/patients", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...getOrgHeaders() },
      credentials: "include",
      body: JSON.stringify(bodyObj),
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /patients POST HTTP", res.status, text);
      alert(`Помилка сервера при створенні пацієнта (HTTP ${res.status})`);
      return null;
    }

    if (!json || !json.ok) {
      console.error("API /patients POST bad json", json, text);
      alert(json?.error || "Помилка створення пацієнта");
      return null;
    }

    const created = Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
    if (!created) return null;

    const next = [created, ...(Array.isArray(state.patients) ? state.patients : [])]
      .filter((x, i, a) => i === a.findIndex((y) => String(y?.id) === String(x?.id)));

    state.patients = next;
    savePatients(next);
    return created;
  } catch (err) {
    console.error("createPatientApi failed:", err);
    alert("Помилка зʼєднання з сервером");
    return null;
  }
}

async function createOwner(name, phone = "", note = "") {
  try {
    const payload = {
      name: String(name || "").trim(),
      phone: String(phone || "").trim(),
      note: String(note || "").trim(),
    };
    Object.keys(payload).forEach((k) => {
      if (payload[k] === "") delete payload[k];
    });

    const res = await fetch("/api/owners", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...getOrgHeaders() },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /owners POST HTTP", res.status, text);
      alert(`Помилка створення власника (HTTP ${res.status})`);
      return null;
    }

    if (!json || !json.ok) {
      console.error("API /owners POST bad json:", json, text);
      alert(json?.error || "Помилка створення власника");
      return null;
    }

    return Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
  } catch (e) {
    console.error("createOwner failed:", e);
    alert("Помилка зʼєднання з сервером");
    return null;
  }
}

async function updateOwner(id, payload = {}) {
  try {
    const bodyObj = {
      name: String(payload.name || "").trim(),
      phone: String(payload.phone || "").trim(),
      note: String(payload.note || "").trim(),
    };

    Object.keys(bodyObj).forEach((k) => {
      if (bodyObj[k] === "") delete bodyObj[k];
    });

    const res = await fetch(`/api/owners/${encodeURIComponent(id)}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...getOrgHeaders() },
      body: JSON.stringify(bodyObj),
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /owners PUT HTTP", res.status, text);
      alert(`Помилка оновлення власника (HTTP ${res.status})`);
      return null;
    }

    if (!json || !json.ok) {
      console.error("API /owners PUT bad json:", json, text);
      alert(json?.error || "Помилка оновлення власника");
      return null;
    }

    return Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
  } catch (e) {
    console.error("updateOwner failed:", e);
    alert("Помилка зʼєднання з сервером");
    return null;
  }
}

async function deleteOwner(id) {
  try {
    const res = await fetch(`/api/owners/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json", ...getOrgHeaders() },
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /owners DELETE HTTP", res.status, text);
      alert(`Помилка видалення власника (HTTP ${res.status})`);
      return false;
    }

    if (!json || !json.ok) {
      console.error("API /owners DELETE bad json:", json, text);
      alert(json?.error || "Помилка видалення власника");
      return false;
    }
    return true;
  } catch (e) {
    console.error("deleteOwner failed:", e);
    alert("Помилка зʼєднання з сервером");
    return false;
  }
}

// =========================
// Local cache helpers
// =========================
function loadPatients() { return LS.get(PATIENTS_KEY, []); }
function savePatients(p) { LS.set(PATIENTS_KEY, p); }
function loadVisits() { return LS.get(VISITS_KEY, []); }
function saveVisits(v) { LS.set(VISITS_KEY, v); }

// =========================
// Visits API
// =========================
async function loadVisitsApi(params = {}) {
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch("/api/visits" + (qs ? `?${qs}` : ""), {
      credentials: "include",
      headers: { Accept: "application/json", ...getOrgHeaders() },
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /visits HTTP", res.status, text);
      alert(`Помилка завантаження візитів (HTTP ${res.status})`);
      return [];
    }

    if (!json || !json.ok) {
      console.error("API /visits bad json:", json, text);
      alert(json?.error || "Помилка завантаження візитів");
      return [];
    }

    const arr = Array.isArray(json.data) ? json.data : (json.data ? [json.data] : []);
    const normArr = arr.map(normalizeVisitFromServer);
    cacheVisits(normArr);
    return normArr;
  } catch (e) {
    console.error("loadVisitsApi failed:", e);
    alert("Помилка зʼєднання з сервером");
    return [];
  }
}

async function createVisitApi(payload) {
  try {
    const res = await fetch("/api/visits", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...getOrgHeaders() },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /visits POST HTTP", res.status, text);
      alert(`Помилка сервера при створенні візиту (HTTP ${res.status})`);
      return null;
    }

    if (!json || !json.ok) {
      console.error("API /visits POST bad json:", json, text);
      alert(json?.error || "Помилка створення візиту");
      return null;
    }

    const created = Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
    if (created?.id) cacheVisits([created]);
    return created;
  } catch (e) {
    console.error("createVisitApi failed:", e);
    alert("Помилка зʼєднання з сервером");
    return null;
  }
}

async function updateVisitApi(visitId, payload) {
  try {
    const url = `/api/visits?id=${encodeURIComponent(String(visitId || "").trim())}`;
    const res = await fetch(url, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload || {}),
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }

    if (!res.ok) {
      console.error("updateVisitApi HTTP error:", res.status, text);
      alert(`API error ${res.status}`);
      return null;
    }

    if (!json || typeof json !== "object") {
      console.error("updateVisitApi: server returned non-JSON:", text);
      alert("Сервер повернув не JSON (перевір /api/visits PUT)");
      return null;
    }

    if (!json.ok) {
      console.error("updateVisitApi: json.ok=false:", json);
      alert(json.error || "update failed");
      return null;
    }

    const raw = Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
    let updated = normalizeVisitFromServer(raw);

    if (!updated || updated.id == null) {
      console.warn("updateVisitApi: updated visit has no id:", updated, json);
      return updated || null;
    }

    const vid = String(updated.id);
    const prev = state.visitsById.get(vid) || null;
    if (prev) {
      const prevServices = Array.isArray(prev.services) ? prev.services : [];
      const prevStock = Array.isArray(prev.stock) ? prev.stock : [];
      const updHasServices = Array.isArray(updated.services) && updated.services.length > 0;
      const updHasStock = Array.isArray(updated.stock) && updated.stock.length > 0;

      if (!updHasServices && prevServices.length) {
        updated.services = prevServices;
        updated.services_json = prevServices;
      }
      if (!updHasStock && prevStock.length) {
        updated.stock = prevStock;
        updated.stock_json = prevStock;
      }
    }

    cacheVisits([updated]);
    return updated;
  } catch (e) {
    console.error("updateVisitApi failed:", e);
    alert("Помилка зʼєднання з сервером");
    return null;
  }
}

// =========================
// Push helpers (services/stock)
// =========================
async function pushVisitServicesToServer(visitId, servicesArr) {
  const vid = String(visitId);
  const current = getVisitByIdSync(vid) || (await fetchVisitById(vid));
  if (!current) return false;

  const services = Array.isArray(servicesArr) ? servicesArr : [];
  const stock = Array.isArray(current.stock) ? current.stock : [];

  const payload = {
    pet_id: current.pet_id,
    date: current.date,
    note: current.note,
    rx: current.rx,
    weight_kg: current.weight_kg,
    services,
    services_json: services,
    stock,
    stock_json: stock,
  };

  const updated = await updateVisitApi(vid, payload);
  if (!updated) return false;

  const cached = state.visitsById.get(vid) || current;
  cached.services = services;
  cached.services_json = services;
  cached.stock = stock;
  cached.stock_json = stock;

  state.visitsById.set(vid, cached);
  if (String(state.selectedVisitId) === vid) state.selectedVisit = cached;
  return true;
}

async function pushVisitStockToServer(visitId, stockArr) {
  const vid = String(visitId);
  const current = getVisitByIdSync(vid) || (await fetchVisitById(vid));
  if (!current) return false;

  const stock = Array.isArray(stockArr) ? stockArr : [];
  const services = Array.isArray(current.services) ? current.services : [];

  const payload = {
    pet_id: current.pet_id,
    date: current.date,
    note: current.note,
    rx: current.rx,
    weight_kg: current.weight_kg,
    services,
    services_json: services,
    stock,
    stock_json: stock,
  };

  const updated = await updateVisitApi(vid, payload);
  if (!updated) return false;

  const cached = state.visitsById.get(vid) || current;
  cached.services = services;
  cached.services_json = services;
  cached.stock = stock;
  cached.stock_json = stock;

  state.visitsById.set(vid, cached);
  if (String(state.selectedVisitId) === vid) state.selectedVisit = cached;
  return true;
}

async function deleteVisitApi(visitId) {
  try {
    const res = await fetch(`/api/visits/${encodeURIComponent(String(visitId))}`, {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json", ...getOrgHeaders() },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /visits DELETE HTTP", res.status, text);
      alert(`Помилка сервера при видаленні візиту (HTTP ${res.status})`);
      return false;
    }

    if (!json || !json.ok) {
      console.error("API /visits DELETE bad json:", json, text);
      alert(json?.error || "Помилка видалення візиту");
      return false;
    }

    state.visitsById.delete(String(visitId));
    return true;
  } catch (e) {
    console.error("deleteVisitApi failed:", e);
    alert("Помилка зʼєднання з сервером");
    return false;
  }
}

// =========================
// Discharges (LOCAL ONLY)
// =========================
function loadDischarges() { return LS.get(DISCHARGES_KEY, {}); }
function saveDischarges(obj) { LS.set(DISCHARGES_KEY, obj); }
function getDischarge(visitId) { return loadDischarges()[visitId] || null; }

function setDischarge(visitId, data) {
  const all = loadDischarges();
  all[visitId] = {
    ...(all[visitId] || {}),
    ...data,
    updated_at: nowISO(),
  };
  saveDischarges(all);
}

// =========================
// Data getters (SERVER)
// =========================
async function getVisitsByPetId(petId) { return await loadVisitsApi({ pet_id: petId }); }
async function getVisitById(visitId) {
  if (!visitId) return null;
  const arr = await loadVisitsApi({ id: visitId });
  return arr[0] || null;
}

function getOwnerById(ownerId) {
  const arr = Array.isArray(state.owners) && state.owners.length ? state.owners : LS.get(OWNERS_KEY, []);
  return (arr || []).find((o) => String(o.id) === String(ownerId)) || null;
}

function getPetsByOwnerId(ownerId) {
  const patients = Array.isArray(state.patients) && state.patients.length ? state.patients : loadPatients();
  return (patients || []).filter((p) => String(p.owner_id) === String(ownerId));
}

// =========================
// SERVICES registry
// =========================
function loadServices() {
  const arr = Array.isArray(state.services) && state.services.length ? state.services : LS.get(SERVICES_KEY, []);
  return arr || [];
}

function getServiceById(id) { return loadServices().find((s) => String(s.id) === String(id)) || null; }
function loadServicesCatMap() {
  const map = LS.get(SERVICES_CAT_KEY, {});
  return map && typeof map === "object" ? map : {};
}

function saveServiceCatToMap(id, cat) {
  const map = loadServicesCatMap();
  map[String(id)] = String(cat || "Інше");
  LS.set(SERVICES_CAT_KEY, map);
}

function ensureVisitServicesShape(visit) {
  if (!visit) return;
  if (!Array.isArray(visit.services)) visit.services = [];
}

// =========================
// SERVICES in VISIT
// =========================
async function addServiceLineToVisit(visitId, serviceId, qty) {
  if (!visitId || !serviceId) return false;

  const vid = String(visitId);
  const current = getVisitByIdSync(vid) || (await fetchVisitById(vid));
  if (!current) return false;

  ensureVisitServicesShape(current);
  const svc = getServiceById(serviceId);
  if (!svc || svc.active === false) return false;

  const q = Math.max(1, Number(qty) || 1);
  const price = Number(svc.price) || 0;

  const line = {
    serviceId: String(serviceId),
    service_id: String(serviceId),
    qty: q,
    quantity: q,
    priceSnap: price,
    price_snap: price,
    nameSnap: String(svc.name || "").trim(),
    name_snap: String(svc.name || "").trim(),
  };

  current.services = [...current.services, line];
  current.services_json = current.services;

  state.visitsById.set(vid, current);
  if (String(state.selectedVisitId) === vid) state.selectedVisit = current;

  pushVisitServicesToServer(vid, current.services).catch((e) => {
    console.error("Background service save failed:", e);
    alert("Послуга додалась на екрані, але не збереглась на сервері. Натисни Оновити.");
  });
  return true;
}

async function removeServiceLineFromVisit(visitId, index) {
  if (!visitId) return false;

  const vid = String(visitId);
  const current = getVisitByIdSync(vid) || (await fetchVisitById(vid));
  if (!current) return false;

  ensureVisitServicesShape(current);
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= current.services.length) return false;

  const nextServices = current.services.slice();
  nextServices.splice(idx, 1);

  current.services = nextServices;
  current.services_json = nextServices;

  state.visitsById.set(vid, current);
  if (String(state.selectedVisitId) === vid) state.selectedVisit = current;

  pushVisitServicesToServer(vid, nextServices).catch((e) => {
    console.error("Background service remove failed:", e);
    alert("Послуга прибралась на екрані, але не збереглась на сервері. Натисни Оновити.");
  });
  return true;
}

// =========================
// Helpers for totals / A4
// =========================
function expandServiceLines(visit) {
  const lines = Array.isArray(visit?.services) ? visit.services : [];
  return lines
    .filter((line) => line && (line.serviceId || line.service_id))
    .map((line) => {
      const serviceId = line.serviceId || line.service_id;
      const qtyRaw = line.qty ?? line.quantity ?? 1;
      const qty = Math.max(1, Number(qtyRaw) || 1);
      const snapName = line.nameSnap ?? line.name_snap ?? "";
      const snapPrice = line.priceSnap ?? line.price_snap;

      const svc = getServiceById(serviceId);
      const name = String(snapName || svc?.name || "Невідома послуга").trim();
      const snapPriceNum = Number(snapPrice);
      const price = Number.isFinite(snapPriceNum) ? snapPriceNum : Number(svc?.price || 0);

      return { name, price, qty, lineTotal: price * qty };
    });
}

function calcServicesTotal(visit) {
  return expandServiceLines(visit).reduce((sum, x) => sum + (Number(x.lineTotal) || 0), 0);
}

function renderServicesProA4(expanded = [], total = 0) {
  if (!expanded.length) return `<div class="hint" style="opacity:.75">—</div>`;

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
// ✅ STOCK lines inside VISIT
// =========================
function ensureVisitStockShape(visit) {
  if (!visit) return;
  if (!Array.isArray(visit.stock)) visit.stock = [];
}

async function addStockLineToVisit(visitId, stockId, qty = 1, { snap = true, decrement = false } = {}) {
  if (!visitId || !stockId) return false;

  const vid = String(visitId);
  const current = getVisitByIdSync(vid) || (await fetchVisitById(vid));
  if (!current) return false;

  ensureVisitStockShape(current);
  const it = getStockById(stockId);
  if (!it || it.active === false) return false;

  const q = Math.max(1, Number(qty) || 1);
  const price = Number(it.price ?? it.price_uah ?? it.sell_price ?? it.sale_price ?? it.cost ?? 0) || 0;

  const line = {
    stockId: String(stockId),
    stock_id: String(stockId),
    qty: q,
    quantity: q,
    priceSnap: price,
    price_snap: price,
    nameSnap: String(it.name || "").trim(),
    name_snap: String(it.name || "").trim(),
    unitSnap: String(it.unit || "шт").trim(),
    unit_snap: String(it.unit || "шт").trim(),
  };

  current.stock = [...current.stock, line];
  current.stock_json = current.stock;

  state.visitsById.set(vid, current);
  if (String(state.selectedVisitId) === vid) state.selectedVisit = current;

  pushVisitStockToServer(vid, current.stock).catch((e) => {
    console.error("Background stock save failed:", e);
    alert("Препарат додався на екрані, але не зберігся на сервері. Натисни Оновити.");
  });
  return true;
}

// ==========================================================================
// Doc.PUG CRM Mini — app.js (УПРАВЛЕНИЕ СКЛАДОМ, ПРАЙС-ЛИСТАМИ И ЖУРНАЛАМИ)
// Часть 2 (Строки 1501 — 2000)
// ==========================================================================

async function removeStockLineFromVisit(visitId, index, { restore = true } = {}) {
  if (!visitId) return false;
  const vid = String(visitId);
  const current = getVisitByIdSync(vid) || (await fetchVisitById(vid));
  if (!current) return false;

  ensureVisitStockShape(current);
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= current.stock.length) return false;

  const nextStock = current.stock.slice();
  nextStock.splice(idx, 1);

  current.stock = nextStock;
  current.stock_json = nextStock;

  state.visitsById.set(vid, current);
  if (String(state.selectedVisitId) === vid) state.selectedVisit = current;

  pushVisitStockToServer(vid, nextStock).catch((e) => {
    console.error("Background stock remove failed:", e);
    alert("Препарат прибрався на екрані, але не зберігся на сервері. Натисни Оновити.");
  });
  return true;
}

function expandStockLines(visit) {
  const lines = Array.isArray(visit?.stock) ? visit.stock : [];
  return lines
    .filter((line) => line && (line.stockId || line.stock_id))
    .map((line) => {
      const stockId = line.stockId || line.stock_id;
      const it = getStockById(stockId);

      const name = String(line.nameSnap ?? line.name_snap ?? it?.name ?? "Невідома позиція").trim();
      const unit = String(line.unitSnap ?? line.unit_snap ?? it?.unit ?? "шт").trim();
      const price = Number(line.priceSnap ?? line.price_snap ?? it?.price ?? it?.price_uah ?? it?.sell_price ?? it?.sale_price ?? it?.cost ?? 0) || 0;
      const qty = Math.max(1, Number(line.qty ?? line.quantity ?? 1) || 1);
      const lineTotal = price * qty;

      return { name, unit, price, qty, lineTotal };
    });
}

function calcStockTotal(visit) {
  return expandStockLines(visit).reduce((sum, x) => sum + (Number(x?.lineTotal) || 0), 0);
}

async function refreshVisitUIIfOpen() {
  if (state.route !== "visit" || !state.selectedVisitId) return;

  let v = getVisitByIdSync(state.selectedVisitId);
  if (!v) v = await fetchVisitById(state.selectedVisitId);
  if (!v) return;

  const pet = state.selectedPet || loadPatients().find((p) => p.id === v.pet_id) || null;
  renderVisitPage(v, pet);
  renderDischargeA4(state.selectedVisitId);
}

function initServicesUI() {
  const page = document.querySelector('.page[data-page="services"]');
  if (!page) return;

  if (page.dataset.boundServices === "1") return;
  page.dataset.boundServices = "1";

  page.querySelector("#servicesSearch")?.addEventListener("input", async (e) => {
    state.servicesQuery = String(e.target.value || "");
    renderServicesTab();
  });

  page.querySelector("#btnAddService")?.addEventListener("click", async () => {
    const name = (prompt("Назва послуги:", "") || "").trim();
    if (!name) return;

    const cat = (prompt("Категорія (Терапія/Аналізи/Хірургія/Діагностика/Виїзд/Інше):", "Терапія") || "Терапія").trim() || "Інше";
    const priceRaw = (prompt("Ціна (грн):", "0") || "0").trim();
    const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

    const created = await createServiceApi({ name, price, active: true, cat });
    if (!created) return alert("Не вдалося створити послугу");

    saveServiceCatToMap(created.id, cat);
    await loadServicesApi();
    renderServicesTab();
    await refreshVisitUIIfOpen();
  });

  page.querySelector("#servicesList")?.addEventListener("click", async (e) => {
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

      const cat = (prompt("Категорія:", String(cur.cat || "Терапія")) || "Терапія").trim() || "Інше";
      const priceRaw = (prompt("Ціна (грн):", String(cur.price ?? 0)) || "0").trim();
      const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

      const updated = await updateServiceApi(id, { name, price, cat });
      if (!updated) return alert("Не вдалося оновити");

      saveServiceCatToMap(id, cat);
      await loadServicesApi();
      renderServicesTab();
      await refreshVisitUIIfOpen();
      return;
    }

    if (action === "toggle") {
      const cur = items[idx];
      const nextActive = cur.active === false ? true : false;
      const updated = await updateServiceApi(id, { active: nextActive });
      if (!updated) return alert("Не вдалося змінити active");

      await loadServicesApi();
      renderServicesTab();
      await refreshVisitUIIfOpen();
      return;
    }

    if (action === "del") {
      const cur = items[idx];
      if (!confirm(`Видалити послугу "${cur.name}"?`)) return;

      const ok = await deleteServiceApi(id);
      if (!ok) return alert("Не вдалося видалити");

      await loadServicesApi();
      renderServicesTab();
      await refreshVisitUIIfOpen();
      return;
    }
  });
}

function initStockUI() {
  const page = document.querySelector('.page[data-page="stock"]');
  if (!page) return;

  if (page.dataset.boundStock === "1") return;
  page.dataset.boundStock = "1";

  page.querySelector("#btnAddStock")?.addEventListener("click", async () => {
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
    await refreshVisitUIIfOpen();
  });

  page.querySelector("#stockList")?.addEventListener("click", async (e) => {
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
      await refreshVisitUIIfOpen();
      return;
    }

    if (action === "qty") {
      const cur = items[idx];
      const qtyRaw = (prompt("Новий залишок:", String(cur.qty ?? 0)) || "0").trim();
      const qty = Math.max(0, Number(qtyRaw.replace(",", ".")) || 0);

      items[idx] = { ...cur, qty };
      saveStock(items);

      renderStockTab();
      await refreshVisitUIIfOpen();
      return;
    }

    if (action === "toggle") {
      items[idx].active = items[idx].active === false ? true : false;
      saveStock(items);

      renderStockTab();
      await refreshVisitUIIfOpen();
      return;
    }

    if (action === "del") {
      const cur = items[idx];
      if (!confirm(`Видалити позицію "${cur.name}"?`)) return;

      items.splice(idx, 1);
      saveStock(items);

      renderStockTab();
      await refreshVisitUIIfOpen();
      return;
    }
  });
}

function renderServicesTab() {
  const page = document.querySelector('.page[data-page="services"]');
  if (!page) return;

  const items = Array.isArray(loadServices()) ? loadServices() : [];
  state.servicesQuery = state.servicesQuery ?? "";
  const q = String(state.servicesQuery || "").trim().toLowerCase();

  const filtered = items.filter((s) => {
    if (!q) return true;
    const hay = [s?.name, s?.cat, s?.id].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  page.dataset.boundServices = "0";

  page.innerHTML = `
    <div class="card">
      <div class="row" style="gap:10px; flex-wrap:wrap;">
        <h2 style="flex:1;">Послуги</h2>
        <input
          id="servicesSearch"
          class="inp"
          type="search"
          placeholder="Пошук послуг…"
          value="${escapeHtml(state.servicesQuery || "")}"
          style="max-width:260px;"
        />
        <button id="btnAddService" class="btn">+ Додати</button>
      </div>
      <div class="hint">Локальний реєстр послуг (поки що). Активні — доступні у візиті.</div>
      <div id="servicesList" class="list"></div>
    </div>
  `;

  const search = page.querySelector("#servicesSearch");
  if (search) {
    search.addEventListener("input", () => {
      state.servicesQuery = String(search.value || "");
      renderServicesTab();
    });
  }

  const list = page.querySelector("#servicesList");
  if (!list) return;

  if (!filtered.length) {
    list.innerHTML = `<div class="hint">Поки порожньо. Натисни “Додати”.</div>`;
    initServicesUI();
    return;
  }

  const groups = groupBy(filtered, (s) => String(s?.cat || "").trim() || "Інше");
  const order = ["Терапія", "Аналізи", "Хірургія", "Діагностика", "Виїзд", "Інше"];

  const cats = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  list.innerHTML = cats.map((cat) => {
    const rows = (groups[cat] || []).map((s) => `
      <div class="item">
        <div class="left" style="width:100%">
          <div class="name">${escapeHtml(s?.name || "—")}</div>
          <div class="meta">${escapeHtml(String(Number(s?.price)||0))} грн • ${s?.active === false ? "❌ вимкнено" : "✅ активно"}</div>
          <div class="pill">id: ${escapeHtml(String(s?.id || ""))}</div>
        </div>
        <div class="right" style="display:flex; gap:6px;">
          <button class="iconBtn" data-svc-action="edit" data-svc-id="${escapeHtml(String(s?.id || ""))}">✏️</button>
          <button class="iconBtn" data-svc-action="toggle" data-svc-id="${escapeHtml(String(s?.id || ""))}">⚡️</button>
          <button class="iconBtn" data-svc-action="del" data-svc-id="${escapeHtml(String(s?.id || ""))}">🗑</button>
        </div>
      </div>
    `).join("");

    return `
      <div class="svcSection">
        <div class="svcSectionTitle">${escapeHtml(cat)}</div>
        ${rows}
      </div>
    `;
  }).join("");

  initServicesUI();

  function groupBy(arr, keyFn) {
    return (arr || []).reduce((acc, item) => {
      const k = String(keyFn(item) || "Інше").trim() || "Інше";
      (acc[k] ||= []).push(item);
      return acc;
    }, {});
  }
}
// ==========================================================================
// Doc.PUG CRM Mini — app.js (ПЕЧАТЬ PDF ДЛЯ TELEGRAM, РЕЕСТРЫ ЖИВОТНЫХ И ВИЗИТОВ)
// Часть 3 (Строки 2001 — 2500)
// ==========================================================================

function renderStockTab() {
  const page = document.querySelector('.page[data-page="stock"]');
  if (!page) return;

  const items = loadStock();
  page.dataset.boundStock = "0";

  page.innerHTML = `
    <div class="card">
      <div class="row">
        <h2>Склад</h2>
        <button id="btnAddStock" class="btn">+ Додати</button>
      </div>
      <div class="hint">Локальний склад (поки що). Залишок змінюється при додаванні/видаленні у візиті.</div>
      <div id="stockList" class="list"></div>
    </div>
  `;

  const list = page.querySelector("#stockList");
  if (!list) return;

  if (!items.length) {
    list.innerHTML = `<div class="hint">Поки порожньо. Натисни “Додати”.</div>`;
  } else {
    list.innerHTML = items.map((it) => `
      <div class="item">
        <div class="left" style="width:100%">
          <div class="name">${escapeHtml(it.name || "—")}</div>
          <div class="meta">
            ${escapeHtml(String(Number(it.price)||0))} грн/${escapeHtml(it.unit||"шт")}
            • залишок: <b>${escapeHtml(String(Number(it.qty)||0))}</b>
            • ${it.active === false ? "❌ вимкнено" : "✅ активно"}
          </div>
          <div class="pill">id: ${escapeHtml(it.id)}</div>
        </div>
        <div class="right" style="display:flex; gap:6px;">
          <button class="iconBtn" data-stk-action="edit" data-stk-id="${escapeHtml(it.id)}">✏️</button>
          <button class="iconBtn" data-stk-action="qty" data-stk-id="${escapeHtml(it.id)}">📦</button>
          <button class="iconBtn" data-stk-action="toggle" data-stk-id="${escapeHtml(it.id)}">⚡️</button>
          <button class="iconBtn" data-stk-action="del" data-stk-id="${escapeHtml(it.id)}">🗑</button>
        </div>
      </div>
    `).join("");
  }
  initStockUI();
}

function a4FilenameFromVisit(visitId) {
  const v = getVisitByIdSync(visitId) || {};
  const date = String(v.date || todayISO());
  return `DocPUG_${date}_visit_${String(visitId)}.pdf`;
}

async function downloadA4Pdf(visitId) {
  if (typeof window.html2pdf === "undefined") {
    alert("html2pdf не подключен. Проверь, что html2pdf.bundle.min.js подключён перед app.js");
    return;
  }

  const a4 = document.getElementById("disA4");
  if (!a4) return alert("Не найден block A4 (#disA4).");

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
    pagebreak: { mode: ["css", "legacy"] },
  };

  try {
    const worker = window.html2pdf().set(opt).from(a4).toPdf();
    let pdfBlob = null;

    if (typeof worker.outputPdf === "function") {
      pdfBlob = await worker.outputPdf("blob");
    } else if (typeof worker.output === "function") {
      pdfBlob = await worker.output("blob");
    }

    if (!pdfBlob) throw new Error("html2pdf: не удалось получить blob");

    const filename = a4FilenameFromVisit(visitId);
    let uploadedUrl = null;
    try {
      const fd = new FormData();
      fd.append("files", new File([pdfBlob], filename, { type: "application/pdf" }));

      const upRes = await fetch("/api/upload", { method: "POST", body: fd });
      const upJson = await upRes.json();

      if (!upJson.ok) throw new Error(upJson.error || "upload failed");
      const f0 = upJson.files && upJson.files[0];
      if (f0?.url) {
        uploadedUrl = new URL(f0.url, window.location.origin).toString();
      }
    } catch (e) {
      console.warn("PDF upload failed, fallback to blob:", e);
    }

    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

    if (uploadedUrl) {
      if (tg && typeof tg.openLink === "function") {
        tg.openLink(uploadedUrl, { try_instant_view: false });
      } else {
        window.location.href = uploadedUrl;
      }
      return;
    }

    const blobUrl = URL.createObjectURL(pdfBlob);
    try {
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    }
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

// =========================
// PATIENTS TAB — ИСПРАВЛЕННЫЙ РЕНДЕР
// =========================
function renderPatientsTab() {
  const page = document.querySelector('.page[data-page="patients"]');
  if (!page) return;

  // Очищаем и задаем структуру страницы
  page.innerHTML = `
    <div class="glass-card" style="padding: 24px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 24px;">
        <h2 style="margin:0;">Пацієнти</h2>
        <div class="hint">Всі пацієнти клініки</div>
      </div>
      <div id="patientsTabList"></div>
    </div>
  `;

  const patientListElement = document.getElementById("patientsTabList");
  if (!patientListElement) return;

  const patients = Array.isArray(state.patients) && state.patients.length ? state.patients : loadPatients();
  const owners = Array.isArray(state.owners) && state.owners.length ? state.owners : LS.get(OWNERS_KEY, []);
  const ownerById = new Map((owners || []).map((o) => [o.id, o]));

  if (!patients.length) {
    patientListElement.innerHTML = `<div class="hint" style="text-align:center; padding: 40px; opacity: 0.5;">Поки пацієнтів немає.</div>`;
    return;
  }

  patientListElement.innerHTML = "";
  patients
    .slice()
    .sort((a, b) => String(b.id).localeCompare(String(a.id)))
    .forEach((p) => {
      const owner = ownerById.get(p.owner_id);
      const ownerLine = owner ? (owner.name || "") : "";

      const el = document.createElement("div");
      el.className = "glass-card";
      el.style.cssText = "padding: 16px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; border-radius: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); cursor:pointer; transition: 0.2s;";
      el.dataset.openPet = p.id;

      el.innerHTML = `
        <div style="flex:1;">
          <div style="font-size: 1.2rem; font-weight: 600;">🐾 ${escapeHtml(p.name || "Без клички")}</div>
          <div style="font-size: 0.9rem; opacity: 0.6; margin-top: 4px;">
            ${escapeHtml(p.species || "")}
            ${p.breed ? " • " + escapeHtml(p.breed) : ""}
            ${p.age ? " • " + escapeHtml(p.age) : ""}
            ${p.weight_kg ? " • " + escapeHtml(p.weight_kg) + " кг" : ""}
            ${ownerLine ? " • 👤 " + escapeHtml(ownerLine) : ""}
          </div>
        </div>
        <div style="display:flex; gap:10px;">
          <button class="iconBtn" title="Редагувати" data-edit-pet="${escapeHtml(p.id)}">✏️</button>
          <button class="iconBtn" title="Видалити" data-del-pet="${escapeHtml(p.id)}">🗑</button>
        </div>
      `;
      patientListElement.appendChild(el);
    });

  // Делегированный клик
  patientListElement.onclick = async (e) => {
    const editBtn = e.target.closest("[data-edit-pet]");
    if (editBtn) {
      e.preventDefault(); e.stopPropagation();
      const petId = editBtn.dataset.editPet;
      const pet = (state.patients || []).find((p) => String(p.id) === String(petId));
      if (!pet) return;

      const name = (prompt("Кличка:", pet.name || "") || "").trim();
      if (!name) return;
      const species = askSpecies(pet.species || "dog");
      if (!species) return;
      
      const updated = await updatePatientApi(petId, { 
        name, species, 
        breed: (prompt("Порода:", pet.breed || "") || "").trim(),
        age: (prompt("Вік:", pet.age || "") || "").trim(),
        weight_kg: (prompt("Вага кг:", pet.weight_kg || "") || "").trim(),
        notes: (prompt("Нотатки:", pet.notes || "") || "").trim()
      });
      if (updated) {
        await loadPatientsApi();
        renderPatientsTab();
      }
      return;
    }

    const delBtn = e.target.closest("[data-del-pet]");
    if (delBtn) {
      e.preventDefault(); e.stopPropagation();
      const petId = delBtn.dataset.delPet;
      if (petId) deletePatientEverywhere(petId);
      return;
    }

    const openZone = e.target.closest("[data-open-pet]");
    if (openZone) {
      const petId = openZone.dataset.openPet;
      if (petId) openPatient(petId);
    }
  };
}

// =========================
// VISITS TAB — ИСПРАВЛЕННЫЙ РЕНДЕР
// =========================
async function renderVisitsTab() {
  const page = document.querySelector('.page[data-page="visits"]');
  if (!page) return;

  page.innerHTML = `
    <div class="card">
      <div class="row">
        <h2>Візити</h2>
        <input id="visitsSearch" class="inp" placeholder="Пошук…" style="max-width:260px" />
      </div>
      <div class="hint">Всі візити з сервера. Клік по картці — відкрити.</div>
      <div id="visitsTabList" class="list"></div>
    </div>
  `;

  const visitListElement = document.getElementById("visitsTabList");
  const search = document.getElementById("visitsSearch");
  if (!visitListElement) return;

  if (!Array.isArray(state.visits) || !state.visits.length) {
    visitListElement.innerHTML = `<div class="hint">Завантаження…</div>`;
    const arr = await loadVisitsApi();
    state.visits = Array.isArray(arr) ? arr : [];
  }

  function paint() {
    const visits = Array.isArray(state.visits) ? state.visits : [];
    const patients = state.patients?.length ? state.patients : loadPatients();
    const owners = state.owners?.length ? state.owners : LS.get(OWNERS_KEY, []);

    const petById = new Map((patients || []).map(p => [String(p.id), p]));
    const ownerById = new Map((owners || []).map(o => [String(o.id), o]));
    const q = (search?.value || "").trim().toLowerCase();

    const filtered = visits
      .slice()
      .sort((a, b) => String(b.id).localeCompare(String(a.id)))
      .filter(v => {
        if (!q) return true;
        const pet = petById.get(String(v.pet_id));
        const owner = pet ? ownerById.get(String(pet.owner_id)) : null;

        return [
          v.date, v.note, v.rx,
          pet?.name, pet?.species, pet?.breed,
          owner?.name, owner?.phone
        ].filter(Boolean).join(" ").toLowerCase().includes(q);
      });

    visitListElement.innerHTML = "";

    if (!filtered.length) {
      visitListElement.innerHTML = `<div class="hint">Нічого не знайдено.</div>`;
      return;
    }

    filtered.forEach(v => {
      const pet = petById.get(String(v.pet_id));
      const owner = pet ? ownerById.get(String(pet.owner_id)) : null;

      const el = document.createElement("div");
      el.className = "item";
      el.dataset.visitId = String(v.id);
      el.style.cursor = "pointer";

      el.innerHTML = `
        <div class="left" style="width:100%;">
          <div class="name">${escapeHtml(v.date || "—")}</div>
          <div class="meta">
            ${escapeHtml(pet?.name || "—")}
            ${pet?.species ? " • " + escapeHtml(pet.species) : ""}
            ${owner?.name ? " • " + escapeHtml(owner.name) : ""}
          </div>
          ${v.note ? `<div class="meta" style="opacity:.85">${escapeHtml(v.note)}</div>` : ""}
        </div>
        <div class="right" style="display:flex; gap:6px;">
          <button class="iconBtn" data-action="open">➡️</button>
          <button class="iconBtn" data-action="delete">🗑</button>
        </div>
      `;
      visitListElement.appendChild(el);
    });
  }

  search?.addEventListener("input", paint);

  visitListElement.onclick = async (e) => {
    const card = e.target.closest(".item[data-visit-id]");
    if (!card) return;

    const visitId = card.dataset.visitId;

    if (e.target.closest('[data-action="delete"]')) {
      e.preventDefault(); e.stopPropagation();
      if (!confirm("Видалити візит?")) return;

      const ok = await deleteVisitApi(visitId);
      if (ok) {
        const arr = await loadVisitsApi();
        state.visits = arr;
        paint();
      }
      return;
    }

    if (e.target.closest('[data-action="open"]') || e.target.closest(".item[data-visit-id]")) {
      openVisit(visitId);
    }
  };

  paint();
}

// =========================
// OWNER PAGE — Рендеринг карточки владельца и его животных
// =========================
async function renderOwnerPage(ownerId) {
  const owner = getOwnerById(ownerId);
  if (!owner) {
    alert("Власника не знайдено");
    setHash("owners");
    return;
  }

  state.selectedOwnerId = String(ownerId);

  // Гарантируем наличие данных
  const patients = Array.isArray(state.patients) && state.patients.length ? state.patients : await loadPatientsApi();
  const pets = (patients || []).filter((p) => String(p.owner_id) === String(ownerId));

    // Гарантируем, что визиты загружены
  if (!Array.isArray(state.visits) || state.visits.length === 0) {
      state.visits = await loadVisitsApi();
  }
  
  const ownerPetIds = new Set(pets.map((p) => String(p.id)));
  // Фильтруем все загруженные визиты
  const ownerVisits = state.visits.filter((v) => ownerPetIds.has(String(v.pet_id)));
  
  const visitsCount = ownerVisits.length;
  // Считаем суммы: если визит null, берем 0
  const totalPaid = ownerVisits.reduce((sum, v) => sum + (calcServicesTotal(v) || 0) + (calcStockTotal(v) || 0), 0);
  // Сортируем и берем последний
  const lastVisit = ownerVisits.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];

  // 1. Рендер Hero-блока (инфо владельца и статистика)
  const ownerNameEl = $("#ownerName");
  if (ownerNameEl) {
    ownerNameEl.innerHTML = `
      <div class="glass-card" style="background: linear-gradient(135deg, rgba(76, 29, 149, 0.2), rgba(15, 23, 42, 0.4)); padding: 24px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); width: 100%; margin-bottom: 30px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <h2 style="margin:0; font-size: 1.8rem; color: #fff;">👤 ${escapeHtml(owner.name || "Без імені")}</h2>
            <div style="margin-top:8px; opacity: 0.7;">📞 ${escapeHtml(owner.phone || "Телефон не вказано")}</div>
            ${owner.note ? `<div style="margin-top:4px; opacity: 0.5;">📍 ${escapeHtml(owner.note)}</div>` : ""}
          </div>
          <button class="btn-tab" data-edit-owner="${escapeHtml(owner.id)}">✏️ Редагувати</button>
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; margin-top: 24px;">
          <div style="background: rgba(0,0,0,0.2); padding: 16px; border-radius: 12px; text-align: center;">
            <div style="font-size: 0.7rem; opacity: 0.5; text-transform: uppercase;">Пацієнтів</div>
            <div style="font-size: 1.4rem; font-weight: 700; color: #a855f7;">${pets.length}</div>
          </div>
          <div style="background: rgba(0,0,0,0.2); padding: 16px; border-radius: 12px; text-align: center;">
            <div style="font-size: 0.7rem; opacity: 0.5; text-transform: uppercase;">Візитів</div>
            <div style="font-size: 1.4rem; font-weight: 700; color: #a855f7;">${visitsCount}</div>
          </div>
          <div style="background: rgba(0,0,0,0.2); padding: 16px; border-radius: 12px; text-align: center;">
            <div style="font-size: 0.7rem; opacity: 0.5; text-transform: uppercase;">Всього сплачено</div>
            <div style="font-size: 1.4rem; font-weight: 700; color: #a855f7;">${totalPaid} ₴</div>
          </div>
          <div style="background: rgba(0,0,0,0.2); padding: 16px; border-radius: 12px; text-align: center;">
            <div style="font-size: 0.7rem; opacity: 0.5; text-transform: uppercase;">Останній візит</div>
            <div style="font-size: 1.1rem; font-weight: 600; margin-top: 4px;">${escapeHtml(lastVisit?.date || "—")}</div>
          </div>
        </div>
      </div>
    `;
  }

  // 2. Рендер списка животных с "рамкой"
  const list = $("#petsList");
  if (!list) return;

  // Добавляем класс рамки из CSS
  list.className = "pets-container"; 
  list.innerHTML = "";

  if (!pets.length) {
    list.innerHTML = `<div class="hint" style="text-align:center; padding: 40px; opacity: 0.5;">Поки немає тварин у цього власника.</div>`;
  } else {
    pets.forEach((pet) => {
      const petVisits = ownerVisits.filter((v) => String(v.pet_id) === String(pet.id));
      
      const el = document.createElement("div");
      el.className = "pet-card"; // Используем стиль карточки
      el.style.cssText = "cursor:pointer; display: flex; justify-content: space-between; align-items: center;";
      el.dataset.openPet = String(pet.id);

      el.innerHTML = `
        <div style="flex:1;">
          <div style="font-size: 1.2rem; font-weight: 600; margin-bottom: 4px;">🐾 ${escapeHtml(pet.name || "Без імені")}</div>
          <div style="font-size: 0.9rem; opacity: 0.6;">
             ${escapeHtml(typeof speciesLabel === "function" ? speciesLabel(pet.species) : pet.species)}
             ${pet.breed ? " • " + escapeHtml(pet.breed) : ""}
             • ${petVisits.length} візитів
          </div>
        </div>
        <div style="padding-left: 15px;">
          <button class="iconBtn" data-del-pet="${escapeHtml(String(pet.id))}">🗑</button>
        </div>
      `;
      list.appendChild(el);
    });
  }

  // Переключаем секции
  document.querySelectorAll(".page").forEach(p => p.style.display = "none");
  const ownerPage = document.querySelector('[data-page="owner"]');
  if (ownerPage) ownerPage.style.display = "block";
}

// =========================
// NAV: Навигация по страницам
// =========================
function openOwner(ownerId, opts = { pushHash: true }) {
  setRoute("owner");
  renderOwnerPage(ownerId);
  if (opts.pushHash) setHash("owner", ownerId);
}

function openPatient(petId, opts = { pushHash: true }) {
  const patients = Array.isArray(state.patients) && state.patients.length ? state.patients : loadPatients();
  const pet = (patients || []).find((p) => String(p.id) === String(petId));
  if (!pet) return alert("Пацієнт не знайдено");

  state.selectedPetId = String(petId);
  state.selectedPet = pet;
  state.selectedOwnerId = String(pet.owner_id || state.selectedOwnerId || "");

  renderPatientCard(pet);
  setRoute("patient");
  if (opts.pushHash) setHash("patient", petId);
}

async function renderPatientCard(pet) {
  const root = $("#patientCardRoot");
  if (!root) return;

  const owner = pet?.owner_id ? getOwnerById(pet.owner_id) : null;

  root.innerHTML = `
    <div class="patientHero">
      <div>
        <button class="ghost" id="btnBackOwner">← Назад</button>
        <div class="patientLabel">Медична карта пацієнта</div>
        <div class="patientName">🐾 ${escapeHtml(pet.name || "Пацієнт")}</div>
        <div class="patientMetaLine">
          ${escapeHtml(typeof speciesLabel === "function" ? speciesLabel(pet.species) : pet.species)}
          ${pet.breed ? " • " + escapeHtml(pet.breed) : ""}
          ${pet.age ? " • " + escapeHtml(pet.age) : ""}
          ${pet.weight_kg ? " • " + escapeHtml(String(pet.weight_kg)) + " кг" : ""}
        </div>
        <div class="patientOwnerLine">
          👤 ${escapeHtml(owner?.name || "Власник не указан")}
          ${owner?.phone ? " • 📞 " + escapeHtml(owner.phone) : ""}
        </div>
      </div>
      <div class="patientActions">
        <button class="ghost" data-edit-pet="${escapeHtml(String(pet.id))}">✏️ Редагувати</button>
        <button class="primary" id="btnAddVisit">+ Візит</button>
      </div>
    </div>

    <div class="patientTabs">
      <button class="patientTab active" data-patient-tab="overview">Обзор</button>
      <button class="patientTab" data-patient-tab="visits">Визиты</button>
      <button class="patientTab" data-patient-tab="medcard">Веткартка</button>
      <button class="patientTab" data-patient-tab="labs">Анализы</button>
      <button class="patientTab" data-patient-tab="files">Файлы</button>
      <button class="patientTab" data-patient-tab="finance">Финансы</button>
    </div>
    <div id="patientTabContent"></div>
  `;

  bindPatientCardButtons();
  await renderPatientTab("overview", pet);
}

function bindPatientCardButtons() {
  $("#btnBackOwner")?.addEventListener("click", () => {
    if (state.selectedOwnerId) openOwner(state.selectedOwnerId);
    else setHash("owners");
  });

  $$(".patientTab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      $$(".patientTab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.patientTab;
      await renderPatientTab(tab, state.selectedPet);
    });
  });
}

async function renderPatientTab(tab, pet) {
  const box = $("#patientTabContent");
  const root = $("#patientCardRoot");
  if (!root || !pet) return;

  const stats = getFinancialStats(pet.id, 'patient');

  // Шаг 1: Полностью обновляем контейнер, включая кнопку Назад и Новый визит
  root.innerHTML = `
    <div style="margin-bottom: 16px;">
      <button id="btnBackToProfile" class="patient-tab-btn" style="background: rgba(255,255,255,0.05); padding: 8px 14px; border-radius: 10px;">
        ← Назад до списку
      </button>
    </div>

    <div class="glass-card" style="background: linear-gradient(135deg, rgba(147, 51, 234, 0.15), rgba(15, 23, 42, 0.4)); padding: 24px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); margin-bottom: 24px; width:100%;">
      <div style="display:flex; justify-content:space-between; align-items:start;">
        <div>
          <div style="font-size:0.75rem; text-transform:uppercase; opacity:0.5; letter-spacing:1px; margin-bottom:4px;">Медична карта пацієнта</div>
          <h2 style="margin:0; font-size: 2.2rem; color: #fff;">🐾 ${escapeHtml(pet.name || "Без імені")}</h2>
          <div style="margin-top:6px; opacity: 0.7; font-size: 0.95rem;">
            ${escapeHtml(typeof speciesLabel === "function" ? speciesLabel(pet.species) : pet.species)} 
            ${pet.breed ? " • " + escapeHtml(pet.breed) : ""}
          </div>
        </div>
        <button class="btn-primary" id="btnAddVisit" style="box-shadow: 0 4px 15px rgba(147, 51, 234, 0.4); border:none; padding: 12px 20px; border-radius: 12px; font-weight:600; cursor:pointer;">+ Новий візит</button>
      </div>

      <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 24px;">
        <div style="background: rgba(0,0,0,0.2); padding: 14px; border-radius: 12px; text-align: center; border: 1px solid rgba(255,255,255,0.03);">
          <div style="font-size: 0.7rem; opacity: 0.5; text-transform: uppercase; margin-bottom: 4px;">Візитів</div>
          <div style="font-size: 1.4rem; font-weight: 700; color: #c084fc;">${stats.count}</div>
        </div>
        <div style="background: rgba(0,0,0,0.2); padding: 14px; border-radius: 12px; text-align: center; border: 1px solid rgba(255,255,255,0.03);">
          <div style="font-size: 0.7rem; opacity: 0.5; text-transform: uppercase; margin-bottom: 4px;">Вага</div>
          <div style="font-size: 1.4rem; font-weight: 700; color: #c084fc;">${escapeHtml(pet.weight_kg || "—")} кг</div>
        </div>
        <div style="background: rgba(0,0,0,0.2); padding: 14px; border-radius: 12px; text-align: center; border: 1px solid rgba(255,255,255,0.03);">
          <div style="font-size: 0.7rem; opacity: 0.5; text-transform: uppercase; margin-bottom: 4px;">Останній візит</div>
          <div style="font-size: 1.1rem; font-weight: 600; color: #fff; margin-top: 4px;">${escapeHtml(stats.lastDate || "—")}</div>
        </div>
        <div style="background: rgba(0,0,0,0.2); padding: 14px; border-radius: 12px; text-align: center; border: 1px solid rgba(255,255,255,0.03);">
          <div style="font-size: 0.7rem; opacity: 0.5; text-transform: uppercase; margin-bottom: 4px;">Всього сплачено</div>
          <div style="font-size: 1.4rem; font-weight: 700; color: #22c55e;">${stats.total} ₴</div>
        </div>
      </div>
    </div>

    <div class="patient-tabs-nav" style="display:flex; gap:6px; margin-bottom:24px; padding:6px; background: rgba(255, 255, 255, 0.04); border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.08); width: fit-content; backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px);">
      <button class="patient-tab-btn" data-p-tab="overview">👁️ Обзор</button>
      <button class="patient-tab-btn" data-p-tab="visits">📅 Візити</button>
      <button class="patient-tab-btn" data-p-tab="medcard">🩺 Веткарта</button>
      <button class="patient-tab-btn" data-p-tab="labs">🧪 Аналізи</button>
      <button class="patient-tab-btn" data-p-tab="files">📁 Файли</button>
      <button class="patient-tab-btn" data-p-tab="finance">💎 Фінанси</button>
      <button class="patient-tab-btn" data-p-tab="edit">✏️ Редагувати</button>
    </div>

    <div id="patientTabContent" style="animation: fadeIn 0.3s ease-in-out;"></div>
  `;

  // ОЖИВЛЯЕМ КНОПКУ «НАЗАД»
  const btnBack = document.getElementById("btnBackToProfile");
  if (btnBack) {
    btnBack.onclick = () => {
      // Здесь вызываем твою глобальную функцию перехода назад. 
      // Например, если у тебя используется хэш-роутер, то:
      window.location.hash = "#patients"; 
      // Или если функция отрисовки списка клиентов называется renderPatientsList:
      // if (typeof renderPatientsList === "function") renderPatientsList();
    };
  }

     // ОЖИВЛЯЕМ КНОПКУ «+ НОВИЙ ВІЗИТ» — БРОНЕБОЙНЫЙ ВАРИАНТ С ЛОГАМИ
        // ОЖИВЛЯЕМ КНОПКУ «+ НОВИЙ ВІЗИТ» — ВАРИАНТ С АВТО-СОЗДАНИЕМ МОДАЛКИ
        // ОЖИВЛЯЕМ КНОПКУ «+ НОВИЙ ВІЗИТ» — ИСПРАВЛЕННЫЙ ВАРИАНТ ПОД НАШУ ФУНКЦИЮ
       // ОЖИВЛЯЕМ КНОПКУ «+ НОВИЙ ВІЗИТ» — ИСПРАВЛЕННЫЙ ВАРИАНТ ПОД НАШУ ФУНКЦИЮ
    const btnAddVisit = document.getElementById("btnAddVisit");
    if (btnAddVisit) {
      btnAddVisit.onclick = () => {
        // 1. Синхронизируем состояние приложения перед открытием
        if (typeof state === "undefined") window.state = {};
        state.selectedPet = pet;
        state.selectedPetId = pet ? (pet.id || pet._id) : null;

        // 2. Вызываем оригинальную функцию создания визита
        if (typeof openVisitModalForCreate === "function") {
          openVisitModalForCreate(pet);
        } else {
          alert("Помилка: функція openVisitModalForCreate не знайдена в системі.");
        }
      };
    }

  // Навешиваем клики на вкладки
  root.querySelectorAll("[data-p-tab]").forEach((btn) => {
    btn.onclick = () => {
      const targetTab = btn.dataset.pTab;
      renderPatientTab(targetTab, pet);
    };
  });

  const dynamicBox = $("#patientTabContent");
  if (!dynamicBox) return;

  // Красим вкладки
  root.querySelectorAll("[data-p-tab]").forEach((btn) => {
    const isActive = btn.dataset.pTab === tab;
    btn.style.padding = "10px 18px";
    btn.style.borderRadius = "10px";
    btn.style.border = "none";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "14px";
    btn.style.fontWeight = isActive ? "600" : "500";
    btn.style.color = isActive ? "#fff" : "rgba(255, 255, 255, 0.6)";
    btn.style.background = isActive ? "rgba(255, 255, 255, 0.15)" : "transparent";
    btn.style.boxShadow = isActive ? "0 4px 15px rgba(0, 0, 0, 0.2), inset 0 1px 1px rgba(255, 255, 255, 0.2)" : "none";
    btn.style.transition = "all 0.2s ease";
  });

  // Шаг 2: Контент табов
  if (tab === "overview") {
    dynamicBox.innerHTML = `
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
        <div class="glass-card" style="background: rgba(255,255,255,0.02); padding:20px; border-radius:16px; border: 1px solid rgba(255,255,255,0.05);">
          <h3 style="margin-top:0; color:#fff; font-size:1.2rem; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom:10px;">📋 Паспорт пацієнта</h3>
          <div style="display:flex; flex-direction:column; gap:12px; margin-top:15px; font-size:0.95rem;">
            <div><span style="opacity:0.5;">Кличка:</span> <b style="color:#fff; margin-left:6px;">${escapeHtml(pet.name || "—")}</b></div>
            <div><span style="opacity:0.5;">Вид:</span> <span style="color:#fff; margin-left:6px;">${escapeHtml(pet.species || "—")}</span></div>
            <div><span style="opacity:0.5;">Порода:</span> <span style="color:#fff; margin-left:6px;">${escapeHtml(pet.breed || "—")}</span></div>
            <div><span style="opacity:0.5;">Вік:</span> <span style="color:#fff; margin-left:6px;">${escapeHtml(pet.age || "—")}</span></div>
          </div>
        </div>
        
        <div class="glass-card" style="background: rgba(255,255,255,0.02); padding:20px; border-radius:16px; border: 1px solid rgba(255,255,255,0.05);">
          <h3 style="margin-top:0; color:#fff; font-size:1.2rem; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom:10px;">📝 Нотатки лікаря</h3>
          <div style="margin-top:15px; color: rgba(255,255,255,0.85); white-space:pre-wrap; line-height:1.5; font-size:0.95rem;">${escapeHtml(pet.notes || "Поки нотаток немає.")}</div>
        </div>
      </div>
    `;
    return;
  }

  if (tab === "visits") {
    dynamicBox.innerHTML = `<div class="hint">Завантаження візитів…</div>`;
    if (typeof renderVisits === "function") await renderVisits(pet.id);
    return;
  }
  if (tab === "medcard") {
    if (typeof renderMedcardTab === "function") await renderMedcardTab(pet);
    return;
  }
  if (tab === "labs") {
    if (typeof renderLabsTab === "function") renderLabsTab(pet);
    return;
  }
  if (tab === "files") {
    if (typeof renderPatientFilesTab === "function") renderPatientFilesTab(pet);
    return;
  }
  if (tab === "edit") {
    if (typeof renderEditPetForm === "function") {
       renderEditPetForm(pet);
    } else {
       dynamicBox.innerHTML = `
         <div class="glass-card" style="padding: 20px; border-radius: 16px;">
           <h3 style="margin-top:0; color:#fff; margin-bottom: 15px;">✏️ Редагувати профіль</h3>
           <p style="opacity: 0.7;">Розділ редагування данных ${escapeHtml(pet.name)} знаходиться в розробці.</p>
         </div>
       `;
    }
    return;
  }

  if (tab === "finance") {
    dynamicBox.innerHTML = `<div class="hint">Формування финансової аналітики…</div>`;
    const petVisits = Array.isArray(state.visits) ? state.visits.filter(v => String(v.pet_id) === String(pet.id)) : [];
    const sortedVisits = petVisits.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const servicesTotal = petVisits.reduce((sum, v) => sum + calcServicesTotal(v), 0);
    const stockTotal = petVisits.reduce((sum, v) => sum + calcStockTotal(v), 0);
    const grandTotal = servicesTotal + stockTotal;
    const avg = petVisits.length ? Math.round(grandTotal / petVisits.length) : 0;

    const checksHtml = sortedVisits.length
      ? sortedVisits.map((v) => {
          const s = calcServicesTotal(v); const st = calcStockTotal(v);
          return `
            <div style="display:flex; justify-content:space-between; padding:12px; background:rgba(255,255,255,0.02); border-radius:8px; margin-bottom:8px; border:1px solid rgba(255,255,255,0.04);">
              <div>
                <div style="font-weight:600; color:#fff;">${escapeHtml(v.date || "—")}</div>
                <div style="font-size:0.8rem; opacity:0.6; margin-top:2px;">Послуги: ${s} ₴ · Препарати: ${st} ₴</div>
              </div>
              <div style="font-weight:700; color:#22c55e; align-self:center;">${s + st} ₴</div>
            </div>
          `;
        }).join("")
      : `<div class="hint">Поки витрат немає.</div>`;

    dynamicBox.innerHTML = `
      <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; margin-bottom:20px;">
        <div style="background:rgba(255,255,255,0.02); padding:12px; border-radius:10px; text-align:center; border:1px solid rgba(255,255,255,0.04);">
          <div style="font-size:0.75rem; opacity:0.5;">УСЬОГО</div>
          <div style="font-size:1.2rem; font-weight:700; color:#fff; margin-top:4px;">${grandTotal} ₴</div>
        </div>
        <div style="background:rgba(255,255,255,0.02); padding:12px; border-radius:10px; text-align:center; border:1px solid rgba(255,255,255,0.04);">
          <div style="font-size:0.75rem; opacity:0.5;">ПОСЛУГИ</div>
          <div style="font-size:1.2rem; font-weight:700; color:#fff; margin-top:4px;">${servicesTotal} ₴</div>
        </div>
        <div style="background:rgba(255,255,255,0.02); padding:12px; border-radius:10px; text-align:center; border:1px solid rgba(255,255,255,0.04);">
          <div style="font-size:0.75rem; opacity:0.5;">ПРЕПАРАТИ</div>
          <div style="font-size:1.2rem; font-weight:700; color:#fff; margin-top:4px;">${stockTotal} ₴</div>
        </div>
        <div style="background:rgba(255,255,255,0.02); padding:12px; border-radius:10px; text-align:center; border:1px solid rgba(255,255,255,0.04);">
          <div style="font-size:0.75rem; opacity:0.5;">СЕРЕДНІЙ ЧЕК</div>
          <div style="font-size:1.2rem; font-weight:700; color:#22c55e; margin-top:4px;">${avg} ₴</div>
        </div>
      </div>
      <div class="glass-card" style="padding:20px; border-radius:16px;">
        <h3 style="margin-top:0; color:#fff; margin-bottom:15px;">🧾 Історія витрат пацієнта</h3>
        <div style="max-height:300px; overflow-y:auto; padding-right:6px;">${checksHtml}</div>
      </div>
    `;
    return;
  }
}

const PATIENT_FILES_KEY = "DOCPUG_PATIENT_FILES_V1";

// ==========================================================================
// Doc.PUG CRM Mini — app.js (ФАЙЛЫ, РЕФЕРЕНСЫ ЛАБОРАТОРИИ И ГРАФИКИ ВЕТЕРИНАРОВ)
// Часть 5 (Строки 3001 — 3500)
// ==========================================================================

function loadPatientFiles() {
  try {
    const raw = localStorage.getItem(PATIENT_FILES_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function savePatientFiles(obj) {
  localStorage.setItem(PATIENT_FILES_KEY, JSON.stringify(obj || {}));
}

function getPatientFiles(petId) {
  const all = loadPatientFiles();
  const arr = all[String(petId)] || [];
  return Array.isArray(arr) ? arr : [];
}

function setPatientFiles(petId, arr) {
  const all = loadPatientFiles();
  all[String(petId)] = Array.isArray(arr) ? arr : [];
  savePatientFiles(all);
}

async function uploadPatientFile(file) {
  const fd = new FormData();
  fd.append("files", file);

  const res = await fetch("/api/upload", {
    method: "POST",
    body: fd,
  });

  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "Upload failed");

  const uploaded = json.files?.[0];
  if (!uploaded) throw new Error("No uploaded file");

  return uploaded;
}

function renderPatientFilesTab(pet) {
  const box = $("#patientTabContent");
  if (!box || !pet) return;

  const petId = String(pet.id);
  const files = getPatientFiles(petId);

  box.innerHTML = `
    <div class="patientInfoBox">
      <div class="row" style="gap:10px; flex-wrap:wrap;">
        <div style="flex:1;">
          <h2>Файли пацієнта</h2>
          <div class="hint">Рентген, УЗД, PDF, фото, лабораторії та інші документи.</div>
        </div>
        <button class="primary" id="btnAddPatientFile" type="button">+ Прикріпити файл</button>
        <input id="patientFileInput" type="file" accept="image/*,.pdf,.doc,.docx" style="display:none;" />
      </div>
      <div id="patientFilesList" class="list" style="margin-top:16px;">
        ${
          files.length
            ? files.map(renderPatientFileRow).join("")
            : `<div class="hint">Поки файлів немає. Натисни “+ Прикріпити файл”.</div>`
        }
      </div>
    </div>
  `;

  $("#btnAddPatientFile")?.addEventListener("click", () => {
    $("#patientFileInput")?.click();
  });

  $("#patientFileInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const type = (prompt("Тип файлу: рентген / УЗД / PDF / фото / лабораторія", "PDF") || "Файл").trim();
    const note = (prompt("Коментар:", "") || "").trim();

    const uploaded = await uploadPatientFile(file);
    const arr = getPatientFiles(petId);
    arr.unshift({
      id: "pfile_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2),
      name: uploaded.name || file.name,
      url: uploaded.url || uploaded.path || uploaded.href || "",
      size: file.size,
      mime: file.type,
      type,
      note,
      date: todayISO(),
      created_at: new Date().toISOString(),
    });

    setPatientFiles(petId, arr);
    e.target.value = "";
    renderPatientFilesTab(pet);
  });

  $("#patientFilesList")?.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del-patient-file]");
    if (!del) return;

    const id = del.dataset.delPatientFile;
    if (!confirm("Видалити файл з картки?")) return;

    const next = getPatientFiles(petId).filter((x) => String(x.id) !== String(id));
    setPatientFiles(petId, next);
    renderPatientFilesTab(pet);
  });
}

function renderPatientFileRow(file) {
  const rawUrl = file.url || file.path || file.href || file.fileUrl || file.file_url || "";
  const url = rawUrl ? new URL(rawUrl, window.location.origin).toString() : "";

  return `
    <div class="item">
      <div class="left" style="width:100%;">
        <div class="name">📎 ${escapeHtml(file.name || "Файл")}</div>
        <div class="meta">
          ${escapeHtml(file.type || "Файл")} • ${escapeHtml(file.date || "—")}
          ${file.size ? " • " + escapeHtml(formatFileSize(file.size)) : ""}
        </div>
        ${file.note ? `<div class="history" style="white-space:pre-wrap;">${escapeHtml(file.note)}</div>` : ""}
      </div>
      <div class="right" style="display:flex; gap:8px;">
        ${
          url
            ? `<a class="miniBtn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Відкрити</a>`
            : `<span class="hint">немає url</span>`
        }
        <button class="iconBtn" title="Видалити" data-del-patient-file="${escapeHtml(file.id)}">🗑</button>
      </div>
    </div>
  `;
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const LABS_KEY = "docpug_labs_v1";

const LAB_REF = {
  dog: {
    ALT: [6, 70, "Од/л"],
    AST: [10, 43, "Од/л"],
    GGT: [1, 5, "Од/л"],
    ALP: [8, 76, "Од/л"],
    UREA: [3.5, 9.2, "ммоль/л"],
    CREA: [44.2, 114.92, "мкмоль/л"],
    ALB: [20, 46, "г/л"],
    TP: [50, 78, "г/л"],
    GLU: [3.33, 6.38, "ммоль/л"],
    TBIL: [0, 10.26, "мкмоль/л"],
    GLOB: [27, 44, "г/л"],
    WBC: [5.4, 15.4, "тис./мкл"],
    RBC: [5.5, 10.4, "млн/мм³"],
    HGB: [110, 180, "г/л"],
    PLT: [117, 490, "тис./мкл"],
    HCT: [0.330, 0.560, "л/л"],
    NEU_BAND: [0, 3, "%"],
    NEU_SEG: [35, 75, "%"],
    LYM: [20, 55, "%"],
    EOS: [2, 7, "%"],
    BASO: [0, 3, "%"],
    MONO: [1, 5, "%"],
  },
  cat: {
    ALT: [28, 76, "Од/л"],
    AST: [12, 40, "Од/л"],
    GGT: [2, 9.5, "Од/л"],
    ALP: [0, 62, "Од/л"],
    UREA: [5.35, 12.12, "ммоль/л"],
    CREA: [88.4, 194.48, "мкмоль/л"],
    ALB: [20, 46, "г/л"],
    TP: [60, 82, "г/л"],
    GLU: [3.33, 7.21, "ммоль/л"],
    TBIL: [0, 6.84, "мкмоль/л"],
    GLOB: [26, 51, "г/л"],
    WBC: [5.4, 15.4, "тис./мкл"],
    RBC: [5.5, 10.4, "млн/мм³"],
    HGB: [100, 140, "г/л"],
    PLT: [100, 518, "тис./мкл"],
    HCT: [0.260, 0.470, "л/л"],
    NEU_BAND: [0, 3, "%"],
    NEU_SEG: [35, 75, "%"],
    LYM: [20, 55, "%"],
    EOS: [2, 7, "%"],
    BASO: [0, 3, "%"],
    MONO: [1, 5, "%"],
  },
};

const LAB_LABELS = {
  ALT: "АЛТ",
  AST: "АСТ",
  GGT: "ГГТ",
  ALP: "Лужна фосфатаза",
  UREA: "Сечовина",
  CREA: "Креатинін",
  ALB: "Альбумін",
  TP: "Загальний білок",
  GLU: "Глюкоза",
  TBIL: "Білірубін загальний",
  GLOB: "Глобулін",
  WBC: "Лейкоцити",
  RBC: "Еритроцити",
  HGB: "Гемоглобін",
  PLT: "Тромбоцити",
  HCT: "Гематокрит",
  NEU_BAND: "Нейтрофіли паличкоядерні",
  NEU_SEG: "Нейтрофіли сегментоядерні",
  LYM: "Лімфоцити",
  EOS: "Еозинофіли",
  BASO: "Базофіли",
  MONO: "Моноцити",
};

const LAB_GROUPS = {
  "Біохімія": ["ALT", "AST", "GGT", "ALP", "UREA", "CREA", "ALB", "TP", "GLU", "TBIL", "GLOB"],
  "ЗАК": ["WBC", "RBC", "HGB", "PLT", "HCT", "NEU_BAND", "NEU_SEG", "LYM", "EOS", "BASO", "MONO"],
};

function getPetSpeciesKey(pet) {
  const s = String(pet?.species || "").toLowerCase().trim();
  if (s === "cat" || s.includes("кот") || s.includes("кіт") || s.includes("cat")) return "cat";
  if (s === "dog" || s.includes("пес") || s.includes("соб") || s.includes("dog")) return "dog";
  return "dog";
}

async function loadStaffApi() {
  try {
    const res = await fetch("/api/staff");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Cannot load staff");
    return Array.isArray(json.items) ? json.items : Array.isArray(json.data) ? json.data : [];
  } catch (e) {
    console.error("loadStaffApi failed:", e);
    alert("Не вдалося завантажити ветеринарів: " + (e?.message || e));
    return [];
  }
}

async function loadCalendarApi() {
  try {
    const res = await fetch("/api/calendar");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Cannot load calendar");
    return Array.isArray(json.items) ? json.items : Array.isArray(json.data) ? json.data : [];
  } catch (e) {
    console.error("loadCalendarApi failed:", e);
    alert("Не вдалося завантажити календар: " + (e?.message || e));
    return [];
  }
}

async function loadStaffScheduleApi(date) {
  try {
    const res = await fetch(`/api/staff-schedule?date=${encodeURIComponent(date)}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Cannot load staff schedule");
    return Array.isArray(json.items) ? json.items : Array.isArray(json.data) ? json.data : [];
  } catch (e) {
    console.error("loadStaffScheduleApi failed:", e);
    alert("Не вдалося завантажити графік змін: " + (e?.message || e));
    return [];
  }
}

async function saveStaffScheduleApi(payload) {
  try {
    const res = await fetch("/api/staff-schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Cannot save staff schedule");
    return json.data || json.item || null;
  } catch (e) {
    console.error("saveStaffScheduleApi failed:", e);
    alert("Не вдалося зберегти зміну: " + (e?.message || e));
    return null;
  }
}
// ==========================================================================
// Doc.PUG CRM Mini — app.js (ИНТЕРАКТИВНЫЙ КАЛЕНДАРЬ, СМЕНЫ И DRAG-AND-DROP)
// Часть 6 (Строки 3501 — 4000)
// ==========================================================================

async function renderCalendarTab() {
  const page = document.querySelector('.page[data-page="calendar"]');
  if (!page) return;

  const today = window.__calendarDate || (
    typeof todayISO === "function"
      ? todayISO()
      : new Date().toISOString().slice(0, 10)
  );

  page.innerHTML = `
    <div class="card">
      <div class="hint">Завантаження календаря…</div>
    </div>
  `;

  const staff = await loadStaffApi();
  const events = await loadCalendarApi();
  const staffSchedule = await loadStaffScheduleApi(today);

  const activeStaffIds = new Set(
    staffSchedule
      .filter((x) => x.is_active !== false)
      .map((x) => String(x.staff_id))
  );

  const staffOnShift = staffSchedule.length
    ? staff.filter((doc) => activeStaffIds.has(String(doc.id)))
    : staff;

  const todayEvents = events.filter((x) => String(x.event_date || "") === today);

  if (calendarMode === "week") {
    const base = new Date(today);
    const day = base.getDay() || 7;
    const monday = new Date(base);
    monday.setDate(base.getDate() - day + 1);

    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d.toISOString().slice(0, 10);
    });

    const dayNames = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
    const weekEvents = events.filter((ev) => weekDays.includes(String(ev.event_date || "")));

    page.innerHTML = `
      <div class="card calendarCard">
        <div class="calendarHeader">
          <div>
            <h2>Календар</h2>
            <div class="hint">Тижневий розклад записів клініки.</div>
          </div>
          <div class="calendarModes">
            <button class="ghost" data-cal-mode="day">День</button>
            <button class="primary" data-cal-mode="week">Тиждень</button>
            <button class="ghost" data-cal-mode="month">Місяць</button>
            <button class="ghost" data-cal-mode="schedule">Ветеринари</button>
            <button class="ghost" data-cal-mode="routes">Маршрути</button>
          </div>
        </div>
        <div class="calendarTop">
          <button class="ghost" id="calPrevWeek" type="button">←</button>
          <div class="calendarDate">${escapeHtml(weekDays[0])} — ${escapeHtml(weekDays[6])}</div>
          <button class="ghost" id="calNextWeek" type="button">→</button>
        </div>
        <div class="weekCalendarGrid">
          ${weekDays.map((date, i) => {
            const dayEvents = weekEvents
              .filter((ev) => String(ev.event_date || "") === date)
              .sort((a, b) => String(a.start_time || "").localeCompare(String(b.start_time || "")));

            return `
              <div class="weekDayCol">
                <div class="weekDayHead">
                  <div class="weekDayName">${dayNames[i]}</div>
                  <div class="weekDayDate">${escapeHtml(date)}</div>
                </div>
                <div class="weekDayBody" data-week-date="${escapeHtml(date)}">
                  ${
                    dayEvents.length
                      ? dayEvents.map((ev) => `
                        <div class="weekEventCard" data-cal-event-id="${escapeHtml(String(ev.id))}">
                          <div class="weekEventTime">
                            ${escapeHtml(String(ev.start_time || "").slice(0, 5))} — ${escapeHtml(String(ev.end_time || "").slice(0, 5))}
                          </div>
                          <div class="weekEventTitle">${escapeHtml(ev.title || "Візит")}</div>
                          <div class="weekEventVet">
                            👨‍⚕️ ${escapeHtml((staff.find((s) => String(s.id) === String(ev.staff_id))?.name) || "Лікар не вказаний")}
                          </div>
                          ${ev.note ? `<div class="weekEventMeta">${escapeHtml(ev.note)}</div>` : ""}
                        </div>
                      `).join("")
                      : `<div class="weekEmpty">Немає записів</div>`
                  }
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;

    $("[data-cal-mode='day']")?.addEventListener("click", async () => { calendarMode = "day"; await renderCalendarTab(); });
    $("[data-cal-mode='month']")?.addEventListener("click", async () => { calendarMode = "month"; await renderCalendarTab(); });
    $("[data-cal-mode='schedule']")?.addEventListener("click", async () => { calendarMode = "schedule"; await renderCalendarTab(); });
    $("[data-cal-mode='routes']")?.addEventListener("click", async () => { calendarMode = "routes"; await renderCalendarTab(); });

    $("#calPrevWeek")?.addEventListener("click", async () => {
      const d = new Date(weekDays[0]); d.setDate(d.getDate() - 7);
      window.__calendarDate = d.toISOString().slice(0, 10); await renderCalendarTab();
    });
    $("#calNextWeek")?.addEventListener("click", async () => {
      const d = new Date(weekDays[0]); d.setDate(d.getDate() + 7);
      window.__calendarDate = d.toISOString().slice(0, 10); await renderCalendarTab();
    });

    $$("[data-cal-event-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.dataset.calEventId;
        const ev = weekEvents.find((x) => String(x.id) === String(id));
        if (!ev) return;
        openCalendarEditModal(ev, ev.event_date || today, async () => { await renderCalendarTab(); });
      });
    });
    return;
  }
  if (calendarMode === "month") {
    const base = new Date(today);
    const year = base.getFullYear();
    const month = base.getMonth();

    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);

    const startDay = monthStart.getDay() || 7;
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - startDay + 1);

    const monthDays = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d.toISOString().slice(0, 10);
    });

    const monthNames = [
      "Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень",
      "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"
    ];

    const dayNames = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

    const monthEvents = events.filter((ev) => {
      const d = String(ev.event_date || "");
      return monthDays.includes(d);
    });

    const scheduleRows = await loadStaffScheduleRangeApi(
  monthDays[0],
  monthDays[monthDays.length - 1]
);

const scheduleByDate = new Map(
  monthDays.map((date) => [
    date,
    scheduleRows.filter((row) => String(row.work_date || "") === date),
  ])
);

page.innerHTML = `
  <div class="card calendarCard">
    <div class="calendarHeader">
      <div>
        <h2>Місячний графік</h2>
        <div class="hint">Плануй зміни ветеринарів на весь місяць.</div>
      </div>
      <div class="calendarModes">
        <button class="ghost" data-cal-mode="day">День</button>
        <button class="ghost" data-cal-mode="week">Тиждень</button>
        <button class="primary" data-cal-mode="month">Місяць</button>
        <button class="ghost" data-cal-mode="schedule">Ветеринари</button>
        <button class="ghost" data-cal-mode="routes">Маршрути</button>
      </div>
    </div>

    <div class="calendarTop">
      <button class="ghost" id="calPrevMonth" type="button">←</button>
      <div class="calendarDate">${monthNames[month]} ${year}</div>
      <button class="ghost" id="calNextMonth" type="button">→</button>
    </div>

    <div class="monthPlannerLayout">
      <div class="monthPlannerMain">
        <div class="monthWeekHead">
          ${dayNames.map((d) => `<div>${d}</div>`).join("")}
        </div>

        <div class="monthGrid">
          ${monthDays.map((date) => {
            const d = new Date(date);
            const isCurrentMonth = d.getMonth() === month;
            const isToday = date === (typeof todayISO === "function" ? todayISO() : new Date().toISOString().slice(0, 10));

            const daySchedule = scheduleByDate.get(date) || [];
            const activeIds = new Set(
              daySchedule
                .filter((x) => x.is_active !== false)
                .map((x) => String(x.staff_id))
            );

            const activeStaff = daySchedule.length
              ? staff.filter((doc) => activeIds.has(String(doc.id)))
              : [];

            const dayEvents = monthEvents.filter((ev) => String(ev.event_date || "") === date);

            return `
              <div class="monthDay ${isCurrentMonth ? "" : "muted"} ${isToday ? "today" : ""}" data-month-date="${escapeHtml(date)}">
                <div class="monthDayTop">
                  <div class="monthDayNum">${d.getDate()}</div>
                  ${dayEvents.length ? `<div class="monthVisitCount">${dayEvents.length} записів</div>` : ""}
                </div>

                <div class="monthStaffList">
                  ${
                    activeStaff.length
                      ? activeStaff.slice(0, 3).map((doc) => `
                        <div class="monthStaffPill" style="border-left:4px solid ${escapeHtml(doc.color || "#7C5CFF")}">
                          👨‍⚕️ ${escapeHtml(doc.name || "Працівник")}
                        </div>
                      `).join("")
                      : `<div class="monthEmptyShift">Змін немає</div>`
                  }
                  ${activeStaff.length > 3 ? `<div class="monthMore">+${activeStaff.length - 3} ще</div>` : ""}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>

      <aside class="monthShiftDrawer" id="monthShiftDrawer">
        <div class="monthDrawerPlaceholder">
          <div class="monthDrawerPlaceholderIcon">📅</div>
          <div class="monthDrawerPlaceholderTitle">Обери день</div>
          <div class="hint">Натисни на дату в календарі, щоб налаштувати графік зміни.</div>
        </div>
      </aside>
    </div>
  </div>
`;

$("[data-cal-mode='day']")?.addEventListener("click", async () => { calendarMode = "day"; await renderCalendarTab(); });
$("[data-cal-mode='week']")?.addEventListener("click", async () => { calendarMode = "week"; await renderCalendarTab(); });
$("[data-cal-mode='schedule']")?.addEventListener("click", async () => { calendarMode = "schedule"; await renderCalendarTab(); });
$("[data-cal-mode='routes']")?.addEventListener("click", async () => { calendarMode = "routes"; await renderCalendarTab(); });

$("#calPrevMonth")?.addEventListener("click", async () => {
  const d = new Date(year, month - 1, 1);
  window.__calendarDate = d.toISOString().slice(0, 10);
  await renderCalendarTab();
});

$("#calNextMonth")?.addEventListener("click", async () => {
  const d = new Date(year, month + 1, 1);
  window.__calendarDate = d.toISOString().slice(0, 10);
  await renderCalendarTab();
});

const openMonthShiftDrawer = (date) => {
  const drawer = $("#monthShiftDrawer");
  if (!drawer) return;

  const daySchedule = scheduleByDate.get(date) || [];
  const activeIds = new Set(
    daySchedule
      .filter((x) => x.is_active !== false)
      .map((x) => String(x.staff_id))
  );

  drawer.innerHTML = `
    <div class="monthDrawerCard">
      <div class="monthDrawerHead">
        <div>
          <div class="monthDrawerTitle">📅 Графік на ${escapeHtml(date)}</div>
          <div class="hint">Обери, хто працює в цей день.</div>
        </div>
        <button class="ghost" id="monthDrawerClose" type="button">×</button>
      </div>

      <div class="monthDrawerQuick">
        <button class="ghost" id="monthAllActive" type="button">Усі на зміні</button>
        <button class="ghost" id="monthAllOff" type="button">Усім вихідний</button>
      </div>
      <div class="monthBulkBox">
  <div class="monthBulkTitle">Масове призначення</div>

  <label class="monthBulkField">
    <span>Лікар</span>
    <select id="monthBulkStaff">
      ${staff.map((doc) => `
        <option value="${escapeHtml(String(doc.id))}">
          ${escapeHtml(doc.name || "Працівник")}
        </option>
      `).join("")}
    </select>
  </label>

  <div class="monthBulkDates">
    <label class="monthBulkField">
      <span>Від</span>
      <input id="monthBulkFrom" type="date" value="${escapeHtml(date)}">
    </label>

    <label class="monthBulkField">
      <span>До</span>
      <input id="monthBulkTo" type="date" value="${escapeHtml(date)}">
    </label>
  </div>

  <div class="monthBulkDays">
    <button type="button" class="monthBulkDay active" data-bulk-day="1">Пн</button>
    <button type="button" class="monthBulkDay active" data-bulk-day="2">Вт</button>
    <button type="button" class="monthBulkDay active" data-bulk-day="3">Ср</button>
    <button type="button" class="monthBulkDay active" data-bulk-day="4">Чт</button>
    <button type="button" class="monthBulkDay active" data-bulk-day="5">Пт</button>
    <button type="button" class="monthBulkDay" data-bulk-day="6">Сб</button>
    <button type="button" class="monthBulkDay" data-bulk-day="7">Нд</button>
  </div>

  <button class="primary monthBulkApply" id="monthBulkApply" type="button">
    Застосувати графік
  </button>
</div>

      <div class="monthDrawerStaff">
        ${staff.map((doc) => {
          const active = activeIds.has(String(doc.id));
          return `
            <button
              class="monthShiftToggle ${active ? "active" : ""}"
              type="button"
              data-month-shift-staff="${escapeHtml(String(doc.id))}"
              style="border-left:5px solid ${escapeHtml(doc.color || "#7C5CFF")}"
            >
              <span>👨‍⚕️ ${escapeHtml(doc.name || "Працівник")}</span>
              <b>${active ? "На зміні" : "Вихідний"}</b>
            </button>
          `;
        }).join("")}
      </div>

      <div class="monthDrawerActions">
        <button class="ghost" id="monthGoToDay" type="button">Відкрити день</button>
        <button class="primary" id="monthSaveShift" type="button">💾 Зберегти</button>
      </div>
    </div>
  `;

  drawer.classList.add("open");

  const setToggleState = (btn, active) => {
    btn.classList.toggle("active", active);
    const label = btn.querySelector("b");
    if (label) label.textContent = active ? "На зміні" : "Вихідний";
  };

  $("#monthDrawerClose")?.addEventListener("click", () => {
    drawer.classList.remove("open");
    drawer.innerHTML = `
      <div class="monthDrawerPlaceholder">
        <div class="monthDrawerPlaceholderIcon">📅</div>
        <div class="monthDrawerPlaceholderTitle">Обери день</div>
        <div class="hint">Натисни на дату в календарі, щоб налаштувати графік зміни.</div>
      </div>
    `;
  });

  $$(".monthShiftToggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      setToggleState(btn, !btn.classList.contains("active"));
    });
  });

  $("#monthAllActive")?.addEventListener("click", () => {
    $$(".monthShiftToggle").forEach((btn) => setToggleState(btn, true));
  });

  $("#monthAllOff")?.addEventListener("click", () => {
    $$(".monthShiftToggle").forEach((btn) => setToggleState(btn, false));
  });
  $$(".monthBulkDay").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.classList.toggle("active");
  });
});

$("#monthBulkApply")?.addEventListener("click", async () => {
  const staffId = $("#monthBulkStaff")?.value;
  const from = $("#monthBulkFrom")?.value;
  const to = $("#monthBulkTo")?.value;

  if (!staffId || !from || !to) {
    alert("Оберіть лікаря та період.");
    return;
  }

  const activeWeekDays = new Set(
    $$(".monthBulkDay.active").map((btn) => Number(btn.dataset.bulkDay))
  );

  if (!activeWeekDays.size) {
    alert("Оберіть хоча б один день тижня.");
    return;
  }

  const start = new Date(from);
  const end = new Date(to);

  if (start > end) {
    alert("Дата 'Від' не може бути пізніше дати 'До'.");
    return;
  }

  const dates = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    const jsDay = cursor.getDay();
    const isoDay = jsDay === 0 ? 7 : jsDay;

    if (activeWeekDays.has(isoDay)) {
      dates.push(cursor.toISOString().slice(0, 10));
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  if (!dates.length) {
    alert("У вибраному періоді немає відповідних днів.");
    return;
  }

  if (!confirm(`Призначити ${dates.length} змін?`)) return;

  await Promise.all(
    dates.map((workDate) =>
      saveStaffScheduleApi({
        work_date: workDate,
        staff_id: staffId,
        is_active: true,
      })
    )
  );

  await renderCalendarTab();
});

  $("#monthGoToDay")?.addEventListener("click", async () => {
    window.__calendarDate = date;
    calendarMode = "day";
    await renderCalendarTab();
  });

  $("#monthSaveShift")?.addEventListener("click", async () => {
    const activeStaffIds = new Set(
      $$(".monthShiftToggle.active").map((btn) => String(btn.dataset.monthShiftStaff))
    );

    await Promise.all(
      staff.map((doc) =>
        saveStaffScheduleApi({
          work_date: date,
          staff_id: doc.id,
          is_active: activeStaffIds.has(String(doc.id)),
        })
      )
    );

    await renderCalendarTab();
  });
};

$$("[data-month-date]").forEach((cell) => {
  cell.addEventListener("click", () => {
    const date = cell.dataset.monthDate;
    if (!date) return;

    $$("[data-month-date]").forEach((x) => x.classList.remove("selected"));
    cell.classList.add("selected");

    openMonthShiftDrawer(date);
  });
});

return;
  }

  if (calendarMode === "schedule") {
    const schedule = await loadStaffScheduleApi(today);
    const specializations = await loadSpecializationsApi();
    const scheduleMap = new Map(schedule.map((x) => [String(x.staff_id), x]));

    page.innerHTML = `
      <div class="card calendarCard">
        <div class="row" style="justify-content:space-between;align-items:center;">
          <div>
            <h2>Ветеринари</h2>
            <div class="hint">Співробітники клініки, ставки, спеціалізації та налаштування календаря.</div>
          </div>
          <button class="primary" id="btnAddStaff">+ Додати ветеринара</button>
        </div>
        <div class="calendarModes">
          <button class="ghost" data-cal-mode="day">День</button>
          <button class="ghost" data-cal-mode="week">Тиждень</button>
          <button class="ghost" data-cal-mode="month">Місяць</button>
          <button class="primary" data-cal-mode="schedule">Ветеринари</button>
          <button class="ghost" data-cal-mode="routes">Маршрути</button>
        </div>
        <div class="specPanel">
          <div class="specPanelHead">
            <div>
              <div class="specPanelTitle">Напрями клініки</div>
              <div class="hint">Створюй власні фільтри: хірург, дерматолог, екзовет, УЗД...</div>
            </div>
            <button class="primary" id="btnAddSpec" type="button">+ Додати напрям</button>
          </div>
          <div class="specList">
            ${specializations.length ? specializations.map((s) => `<div class="specPill" style="border-left:5px solid ${escapeHtml(s.color || "#7C5CFF")}">${escapeHtml(s.name || "Напрям")}</div>`).join("") : `<div class="hint">Напрями ще не створені.</div>`}
          </div>
        </div>
        <div class="vetList">
          ${staff.map((doc) => {
            const row = scheduleMap.get(String(doc.id));
            const isActive = row ? row.is_active !== false : false;
            return `
              <div class="vetCard" style="border-left:5px solid ${escapeHtml(doc.color || "#7C5CFF")}">
                <div class="vetInfo">
                  <div class="scheduleName">👨‍⚕️ ${escapeHtml(doc.name || "Працівник")}</div>
                  <div class="hint">🩺 ${escapeHtml(doc.specialization || "Спеціалізація не вказана")}</div>
                  <div class="hint">📞 ${escapeHtml(doc.phone || "Telephone не вказано")}</div>
                  <div class="hint">💰 Ставка: ${escapeHtml(String(doc.shift_rate || 0))} грн / зміна</div>
                  <div class="hint">📈 Відсоток: ${escapeHtml(String(doc.percent_rate || 0))}%</div>
                </div>
                <div class="vetActions">
                  <button class="ghost" type="button" data-edit-staff="${escapeHtml(String(doc.id))}">✏️ Редагувати</button>
                  <button class="scheduleStatus ${isActive ? "active" : ""}" type="button" data-schedule-staff-id="${escapeHtml(String(doc.id))}">${isActive ? "На зміні" : "Вихідний"}</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;

    $("#btnAddStaffFromCalendar")?.addEventListener("click", () => { openCreateStaffModal(); });
    $("#btnAddSpec")?.addEventListener("click", async () => {
      const name = (prompt("Назва напряму: хірург, дерматолог, екзовет...") || "").trim();
      if (!name) return;
      const created = await createSpecializationApi({ name, color: "#7C5CFF" });
      if (created) await renderCalendarTab();
    });

    $("[data-cal-mode='day']")?.addEventListener("click", async () => { calendarMode = "day"; await renderCalendarTab(); });
    $("[data-cal-mode='week']")?.addEventListener("click", async () => { calendarMode = "week"; await renderCalendarTab(); });
    $("[data-cal-mode='month']")?.addEventListener("click", async () => { calendarMode = "month"; await renderCalendarTab(); });
    $("[data-cal-mode='routes']")?.addEventListener("click", async () => { calendarMode = "routes"; await renderCalendarTab(); });

    $$(".scheduleStatus").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const staffId = btn.dataset.scheduleStaffId;
        const isActive = !btn.classList.contains("active");
        const saved = await saveStaffScheduleApi({ work_date: today, staff_id: staffId, is_active: isActive });
        if (!saved) return;
        btn.classList.toggle("active", isActive);
        btn.textContent = isActive ? "На зміні" : "Вихідний";
      });
    });

    $$("[data-edit-staff]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.editStaff;
        const staffRow = staff.find((x) => String(x.id) === String(id));
        if (!staffRow) return;
        openEditStaffModal(staffRow);
      });
    });
    return;
  }

  const hours = [];
  for (let h = 7; h <= 24; h++) { hours.push(String(h).padStart(2, "0") + ":00"); }

  const staffHtml = staffOnShift.map((doc) => {
    const docEvents = todayEvents.filter((e) => String(e.staff_id || "") === String(doc.id));
    const toMinutes = (t) => {
      const [h, m] = String(t || "00:00").split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };

    return `
      <div class="calDoctorCol">
        <div class="calDoctorHead" style="border-left:5px solid ${escapeHtml(doc.color || "#7C5CFF")}">
          <div class="calDoctorName">👨‍⚕️ ${escapeHtml(doc.name || "Працівник")}</div>
          <div class="calDoctorMeta">${escapeHtml(doc.role === "assistant" ? "Асистент" : "Ветеринар")} · ${docEvents.length} записів</div>
        </div>
        ${hours.map((hour) => {
          const hourStart = toMinutes(hour);
          const hourEvents = docEvents.filter((ev) => {
            const start = String(ev.start_time || "").slice(0, 5);
            return toMinutes(start) === hourStart;
          });

          const isCoveredByLongEvent = docEvents.some((ev) => {
            const start = toMinutes(String(ev.start_time || "").slice(0, 5));
            const end = toMinutes(String(ev.end_time || "").slice(0, 5));
            return start < hourStart && end > hourStart;
          });

          return `
            <div class="calSlot ${isCoveredByLongEvent ? "calSlotCovered" : ""}" data-hour="${escapeHtml(hour)}" data-staff-id="${escapeHtml(String(doc.id))}" data-staff-name="${escapeHtml(doc.name || "")}">
              ${
                hourEvents.length
                  ? hourEvents.map((ev) => {
                      const start = String(ev.start_time || "").slice(0, 5);
                      const end = String(ev.end_time || "").slice(0, 5);
                      const startMin = toMinutes(start);
                      const endMin = toMinutes(end || start);
                      const durationMinutes = Math.max(60, endMin - startMin);
                      const slots = Math.max(1, durationMinutes / 60);
                      const height = Math.round(slots * 86 + (slots - 1) * 8 - 16);

                      return `
                        <div class="calEventCard calEventLong" data-edit-calendar-event="${escapeHtml(String(ev.id))}" style="border-left:5px solid ${escapeHtml(doc.color || "#7C5CFF")}; min-height:${height}px;">
                          <div class="calEventTop">
                            <div class="calEventTitle">${escapeHtml(ev.title || "Запис")}</div>
                            <button class="calEventDelete" data-del-calendar-event="${escapeHtml(String(ev.id))}" type="button">×</button>
                          </div>
                          <div class="calEventTime">${escapeHtml(start)}${end ? `— ${escapeHtml(end)}` : ""}</div>
                          ${ev.note ? `<div class="calEventMeta">📝 ${escapeHtml(ev.note)}</div>` : ""}
                          ${ev.location ? `<div class="calEventMeta">📍 ${escapeHtml(ev.location)}</div>` : ""}
                        </div>
                      `;
                    }).join("")
                  : isCoveredByLongEvent ? "" : `<div class="calEmptySlot" data-empty-slot="1" data-hour="${escapeHtml(hour)}" data-staff-id="${escapeHtml(String(doc.id))}">+ Запис</div>`
              }
            </div>
          `;
        }).join("")}
      </div>
    `;
  }).join("");

  const staffPaletteHtml = staffOnShift.map((doc) => `
    <div class="calStaffDrag" draggable="true" data-drag-staff-id="${escapeHtml(doc.id)}" data-drag-staff-name="${escapeHtml(doc.name || "")}" data-drag-staff-color="${escapeHtml(doc.color || "#7C5CFF")}" style="border-left:5px solid ${escapeHtml(doc.color || "#7C5CFF")}">
      <div class="calStaffDragName">👨‍⚕️ ${escapeHtml(doc.name || "Працівник")}</div>
      <div class="calStaffDragRole">${escapeHtml(doc.role === "assistant" ? "Асистент" : "Ветеринар")}</div>
    </div>
  `).join("");

  page.innerHTML = `
    <div class="card calendarCard">
      <div class="calendarHeader">
        <div>
          <h2>Календар</h2>
          <div class="hint">Перетягни ветеринара справа на потрібний час.</div>
        </div>
        <div class="calendarModes">
          <button class="primary" data-cal-mode="day">День</button>
          <button class="ghost" data-cal-mode="week">Тиждень</button>
          <button class="ghost" data-cal-mode="month">Місяць</button>
          <button class="ghost" data-cal-mode="schedule">Ветеринари</button>
          <button class="ghost" data-cal-mode="routes">Маршрути</button>
        </div>
      </div>
      <div class="calendarTop">
        <button class="ghost" id="calPrevDay" type="button">←</button>
        <div class="calendarDate">${escapeHtml(today)}</div>
        <button class="ghost" id="calNextDay" type="button">→</button>
      </div>
      <div class="calendarWorkArea">
        <div class="calendarDayGrid">
          <div class="calTimeCol">
            <div class="calTimeHead">Час</div>
            ${hours.map((h) => `<div class="calTime">${escapeHtml(h)}</div>`).join("")}
          </div>
          <div class="calDoctorsGrid">${staffHtml || `<div class="hint">Ветеринарів поки немає.</div>`}</div>
        </div>
        <aside class="calStaffPanel">
          <div class="calStaffPanelHead">
            <div>
              <div class="calStaffPanelTitle">Ветеринари</div>
              <div class="calStaffPanelSub">Перетягни в слот</div>
            </div>
            <button class="miniBtn" id="btnAddStaffFromCalendar" type="button">+ Додати</button>
          </div>
          <div class="calStaffDragList">${staffPaletteHtml || `<div class="hint">Немає співробітників.</div>`}</div>
        </aside>
      </div>
    </div>
  `;

  $$(".calStaffDrag").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", JSON.stringify({
        staff_id: card.dataset.dragStaffId,
        staff_name: card.dataset.dragStaffName,
        color: card.dataset.dragStaffColor,
      }));
      e.dataTransfer.effectAllowed = "copy";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => { card.classList.remove("dragging"); });
  });

  $$(".calSlot").forEach((slot) => {
    slot.addEventListener("click", (e) => {
      if (slot.classList.contains("calSlotCovered")) return;
      if (slot.querySelector(".calEventCard")) return;
      const target = e.target.closest("[data-empty-slot]") || slot;
      const hour = target.dataset.hour || slot.dataset.hour;
      const staffId = target.dataset.staffId || slot.dataset.staffId;
      if (!hour || !staffId) return;
      openVisitFromCalendar(hour, staffId);
    });

    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("calSlotDrop"); });
    slot.addEventListener("dragleave", () => { slot.classList.remove("calSlotDrop"); });
    slot.addEventListener("drop", async (e) => {
      e.preventDefault(); slot.classList.remove("calSlotDrop");
      let data = null;
      try { data = JSON.parse(e.dataTransfer.getData("text/plain") || "{}"); } catch { return; }

      const staffId = data.staff_id; if (!staffId) return;
      const hour = slot.dataset.hour;
      const title = (prompt(`Запис на ${hour}. Назва:`, "Новий прийом") || "").trim();
      if (!title) return;

      const durationRaw = prompt("Тривалість у хвилинах:", "60") || "60";
      const duration = Math.max(15, Number(durationRaw) || 60);
      const endTime = addMinutesToTime(hour, duration);
      const note = (prompt("Коментар:", "") || "").trim();

      const created = await createCalendarEventApi({ title, event_date: today, start_time: hour, end_time: endTime, staff_id: staffId, note });
      if (created) await renderCalendarTab();
    });
  });

  $("#btnAddStaffFromCalendar")?.addEventListener("click", async () => { alert("Наступний крок: зробимо форму додавання ветеринара в Supabase."); });
  $("#calPrevDay")?.addEventListener("click", async () => { const d = new Date(today); d.setDate(d.getDate() - 1); window.__calendarDate = d.toISOString().slice(0, 10); await renderCalendarTab(); });
  $("#calNextDay")?.addEventListener("click", async () => { const d = new Date(today); d.setDate(d.getDate() + 1); window.__calendarDate = d.toISOString().slice(0, 10); await renderCalendarTab(); });

  $$("[data-del-calendar-event]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.delCalendarEvent; if (!id) return;
      if (!confirm("Видалити запис з календаря?")) return;
      const ok = await deleteCalendarEventApi(id); if (ok) await renderCalendarTab();
    });
  });

  $$("[data-edit-calendar-event]").forEach((card) => {
    card.addEventListener("click", async (e) => {
      if (e.target.closest("[data-del-calendar-event]")) return;
      const id = card.dataset.editCalendarEvent; if (!id) return;
      const ev = todayEvents.find((x) => String(x.id) === String(id));
      if (!ev) return alert("Запис не знайдено");
      openCalendarEditModal(ev, today, async () => { await renderCalendarTab(); });
    });
  });

  $$("[data-cal-mode]").forEach((btn) => { btn.addEventListener("click", async () => { calendarMode = btn.dataset.calMode; await renderCalendarTab(); }); });
}
// ==========================================================================
// Doc.PUG CRM Mini — app.js (ПЕРСОНАЛ, МОДАЛКИ КАЛЕНДАРЯ И КАРТОЧКИ АНАЛИЗОВ)
// Часть 5
// ==========================================================================

async function openCreateStaffModal() {
  // Сначала открыть окно
  const staffDrawer = document.getElementById("staffDrawer");
  staffDrawer.classList.add("open");
  staffDrawer.setAttribute("aria-hidden", "false");

  // Затем очистить поля
  document.getElementById("staffId").value = "";
  document.getElementById("staffName").value = "";
  document.getElementById("staffRole").value = "vet";
  document.getElementById("staffSpecialization").value = "";
  document.getElementById("staffPhone").value = "";
  document.getElementById("staffShiftRate").value = 0;
  document.getElementById("staffPercentRate").value = 0;
  document.getElementById("staffColor").value = "#7C5CFF";
  document.getElementById("staffNote").value = "";

  if (typeof renderStaffSpecsBox === "function") await renderStaffSpecsBox([]);
}


async function loadSpecializationsApi() {
  try {
    const res = await fetch("/api/specializations");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Cannot load specializations");
    return Array.isArray(json.data) ? json.data : [];
  } catch (e) {
    console.error("loadSpecializationsApi failed:", e);
    return [];
  }
}

async function createSpecializationApi(payload) {
  try {
    const res = await fetch("/api/specializations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const json = await res.json();

    if (!json.ok) {
      alert(json.error || "Не вдалося створити напрям");
      return null;
    }
    return json.data || null;
  } catch (e) {
    console.error("createSpecializationApi failed:", e);
    alert("Помилка створення напряму");
    return null;
  }
}

async function createStaffApi(payload) {
  try {
    const res = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await res.json();

    if (!json.ok) {
      alert(json.error || "Помилка створення ветеринара");
      return null;
    }
    return json.data || null;
  } catch (e) {
    console.error(e);
    alert("Помилка створення ветеринара");
    return null;
  }
}

async function createCalendarEventApi(payload) {
  try {
    const res = await fetch("/api/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const json = await res.json();

    if (!json.ok) {
      alert(json.error === "time slot busy"
        ? "Цей час вже зайнятий у цього лікаря"
        : "Не вдалося створити запис: " + (json.error || "unknown error")
      );
      return null;
    }
    return json.data || json.item || null;
  } catch (e) {
    console.error("createCalendarEventApi failed:", e);
    alert("Помилка створення запису: " + (e?.message || e));
    return null;
  }
}

async function updateCalendarEventApi(eventId, payload) {
  try {
    const res = await fetch(`/api/calendar/${encodeURIComponent(eventId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const json = await res.json();

    if (!json.ok) {
      alert("Не вдалося оновити запис: " + (json.error || "unknown error"));
      return null;
    }
    return json.data || json.item || null;
  } catch (e) {
    console.error("updateCalendarEventApi failed:", e);
    alert("Помилка оновлення запису: " + (e?.message || e));
    return null;
  }
}

async function deleteCalendarEventApi(eventId) {
  try {
    const res = await fetch(`/api/calendar/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
    });
    const json = await res.json();

    if (!json.ok) {
      alert("Не вдалося видалити запис: " + (json.error || "unknown error"));
      return false;
    }
    return true;
  } catch (e) {
    console.error("deleteCalendarEventApi failed:", e);
    alert("Помилка видалення запису: " + (e?.message || e));
    return false;
  }
}

function addMinutesToTime(time, minutes) {
  const [h, m] = String(time || "00:00").split(":").map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  d.setMinutes(d.getMinutes() + Number(minutes || 60));
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function loadLabs() {
  const arr = LS.get(LABS_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function saveLabs(arr) {
  LS.set(LABS_KEY, Array.isArray(arr) ? arr : []);
}

function getLabsByPetId(petId) {
  return loadLabs().filter((x) => String(x.pet_id) === String(petId));
}

function getLabStatus(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "empty";
  if (n < min) return "low";
  if (n > max) return "high";
  return "normal";
}

function labStatusLabel(status) {
  if (status === "low") return "↓ нижче";
  if (status === "high") return "↑ вище";
  if (status === "normal") return "норма";
  return "—";
}

function labScalePercent(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;

  const span = max - min;
  const visualMin = min - span * 0.6;
  const visualMax = max + span * 0.6;

  const pct = ((n - visualMin) / (visualMax - visualMin)) * 100;
  return Math.max(3, Math.min(97, pct));
}

function renderLabScale(value, min, max) {
  const status = getLabStatus(value, min, max);
  const pct = labScalePercent(value, min, max);

  return `
    <div class="labScale">
      <div class="labScaleNorm"></div>
      <div class="labScaleDot lab-${status}" style="left:${pct}%"></div>
    </div>
  `;
}

function ensureCalendarModal() {
  let modal = document.getElementById("calendarEventModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "calendarEventModal";
  modal.innerHTML = `
    <div class="modal__backdrop" data-close-calendar-modal></div>
    <div class="modal__panel calEditPanel">
      <div class="modal__head">
        <div>
          <div class="modal__title">Редагування запису</div>
          <div class="modal__sub">Час, лікар, коментар</div>
        </div>
        <button class="iconBtn" data-close-calendar-modal type="button">✕</button>
      </div>
      <div class="modal__body">
        <label class="field">
          <div class="label">Назва</div>
          <input class="input" id="calEditTitle">
        </label>
        <div class="medFormGrid">
          <label class="field">
            <div class="label">Початок</div>
            <input class="input" id="calEditStart" type="time">
          </label>
          <label class="field">
            <div class="label">Кінець</div>
            <input class="input" id="calEditEnd" type="time">
          </label>
        </div>
        <label class="field">
          <div class="label">Коментар</div>
          <textarea class="textarea" id="calEditNote" rows="4"></textarea>
        </label>
      </div>
      <div class="modal__foot">
        <button class="ghost" data-close-calendar-modal type="button">Скасувати</button>
        <button class="primary" id="calEditSaveBtn" type="button">Зберегти</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-calendar-modal]")) {
      modal.classList.remove("open");
    }
  });
  return modal;
}

function openCalendarEditModal(ev, today, onSaved) {
  const modal = ensureCalendarModal();

  $("#calEditTitle").value = ev.title || "";
  $("#calEditStart").value = String(ev.start_time || "").slice(0, 5);
  $("#calEditEnd").value = String(ev.end_time || "").slice(0, 5);
  $("#calEditNote").value = ev.note || "";

  modal.classList.add("open");

  $("#calEditSaveBtn").onclick = async () => {
    const title = ($("#calEditTitle").value || "").trim();
    const start_time = ($("#calEditStart").value || "").trim();
    const end_time = ($("#calEditEnd").value || "").trim();
    const note = ($("#calEditNote").value || "").trim();

    if (!title || !start_time || !end_time) {
      alert("Заповни назву, початок і кінець");
      return;
    }

    const updated = await updateCalendarEventApi(ev.id, {
      title,
      event_date: ev.event_date || today,
      start_time,
      end_time,
      staff_id: ev.staff_id,
      note,
    });

    if (updated) {
      modal.classList.remove("open");
      if (typeof onSaved === "function") await onSaved();
    }
  };
}

function renderLabsTab(pet) {
  const box = $("#patientTabContent");
  if (!box || !pet) return;

  const speciesKey = getPetSpeciesKey(pet);
  const speciesLabel = speciesKey === "cat" ? "кіт" : "собака";
  const labs = getLabsByPetId(pet.id).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  box.innerHTML = `
    <div class="patientInfoBox">
      <div class="row" style="align-items:flex-start;">
        <div>
          <h2>Аналізи</h2>
          <div class="hint">Норми підтягуються автоматично: ${escapeHtml(speciesLabel)}.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="primary" id="btnAddBioLab">+ БХ</button>
          <button class="primary" id="btnAddCbcLab">+ ЗАК</button>
        </div>
      </div>
      <div id="labsList" class="labsList">
        ${
          labs.length
            ? labs.map((lab) => renderLabCard(lab, speciesKey)).join("")
            : `<div class="hint">Поки аналізів немає. Натисни “+ БХ” або “+ ЗАК”.</div>`
        }
      </div>
    </div>
  `;

  $("#btnAddBioLab")?.addEventListener("click", () => addLabForPet(pet, "Біохімія"));
  $("#btnAddCbcLab")?.addEventListener("click", () => addLabForPet(pet, "ЗАК"));

  $("#labsList")?.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-lab]");
    if (del) {
      const id = del.dataset.delLab;
      if (!id) return;
      if (!confirm("Видалити аналіз?")) return;

      const next = loadLabs().filter((x) => String(x.id) !== String(id));
      saveLabs(next);
      renderLabsTab(pet);
      return;
    }

    const edit = e.target.closest("[data-edit-lab]");
    if (edit) {
      const id = edit.dataset.editLab;
      if (!id) return;
      if (typeof editLabForPet === "function") editLabForPet(pet, id);
      return;
    }

    const pdf = e.target.closest("[data-pdf-lab]");
    if (pdf) {
      const id = pdf.dataset.pdfLab;
      if (!id) return;
      const lab = loadLabs().find((x) => String(x.id) === String(id));
      if (!lab) return alert("Аналіз не знайдено");
      if (typeof downloadLabPdf === "function") await downloadLabPdf(pet, lab);
      return;
    }
  });
}

function addLabForPet(pet, groupName) {
  const date = prompt("Дата аналізу:", todayISO()) || todayISO();
  const keys = LAB_GROUPS[groupName] || [];
  const values = {};

  keys.forEach((key) => {
    const label = LAB_LABELS[key] || key;
    const raw = prompt(`${label}:`, "");
    if (raw !== null && String(raw).trim() !== "") {
      values[key] = Number(String(raw).replace(",", "."));
    }
  });

  const lab = {
    id: "lab_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2),
    pet_id: String(pet.id),
    type: groupName,
    date,
    values,
    created_at: new Date().toISOString(),
  };

  const arr = loadLabs();
  arr.unshift(lab);
  saveLabs(arr);
  renderLabsTab(pet);
}

// ==========================================================================
// Doc.PUG CRM Mini — app.js (РЕДАКТИРОВАНИЕ ЛАБ, РЕНДЕРИНГ PDF И СЕЛЕКТОРЫ ПРИЕМА)
// Часть 7
// ==========================================================================

function editLabForPet(pet, labId) {
  const arr = loadLabs();
  const idx = arr.findIndex((x) => String(x.id) === String(labId));
  if (idx < 0) return alert("Аналіз не знайдено");

  const lab = arr[idx];
  const keys = LAB_GROUPS[lab.type] || Object.keys(lab.values || {});
  const nextValues = { ...(lab.values || {}) };

  const date = prompt("Дата аналізу:", lab.date || todayISO()) || lab.date || todayISO();

  keys.forEach((key) => {
    const label = LAB_LABELS[key] || key;
    const oldVal = nextValues[key] ?? "";
    const raw = prompt(`${label}:`, String(oldVal));

    if (raw === null) return;

    if (String(raw).trim() === "") {
      delete nextValues[key];
    } else {
      nextValues[key] = Number(String(raw).replace(",", "."));
    }
  });

  arr[idx] = {
    ...lab,
    date,
    values: nextValues,
    updated_at: new Date().toISOString(),
  };

  saveLabs(arr);
  renderLabsTab(pet);
}

async function downloadLabPdf(pet, labId) {
  if (typeof window.html2pdf === "undefined") {
    return alert("html2pdf не подключен");
  }

  const lab = loadLabs().find((x) => String(x.id) === String(labId));
  if (!lab) return alert("Аналіз не знайдено");

  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.left = "-99999px";
  root.style.top = "0";
  root.innerHTML = renderLabPdfHtml(pet, lab);
  document.body.appendChild(root);

  const a4 = root.querySelector(".labPdfA4");
  if (!a4) {
    root.remove();
    return alert("Не вдалося створити PDF");
  }

  const filename = `DocPUG_${String(lab.type || "lab")}_${String(pet.name || "patient")}_${String(lab.date || todayISO())}.pdf`;

  try {
    await window.html2pdf()
      .set({
        margin: 0,
        filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: null,
          logging: false,
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait", compress: true },
      })
      .from(a4)
      .save();
  } catch (e) {
    console.error(e);
    alert("Не вдалося скачати PDF: " + (e?.message || e));
  } finally {
    root.remove();
  }
}

function renderLabPdfHtml(pet, lab) {
  const speciesKey = getPetSpeciesKey(pet);
  const speciesLabel = speciesKey === "cat" ? "кіт" : "собака";
  const ranges = LAB_REF[speciesKey] || LAB_REF.dog;
  const values = lab.values || {};
  const keys = LAB_GROUPS[lab.type] || Object.keys(values);

  const rows = keys.map((key) => {
    const ref = ranges[key];
    if (!ref) return "";

    const [min, max, unit] = ref;
    const value = values[key];
    const status = getLabStatus(value, min, max);

    return `
      <tr>
        <td>${escapeHtml(LAB_LABELS[key] || key)}</td>
        <td><b>${escapeHtml(value ?? "—")}</b> ${escapeHtml(unit)}</td>
        <td>${escapeHtml(String(min))}–${escapeHtml(String(max))} ${escapeHtml(unit)}</td>
        <td class="lab-${status}">${escapeHtml(labStatusLabel(status))}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="labPdfA4">
      <div class="labPdfHeader">
        <div>
          <div class="labPdfTitle">Аналіз / ${escapeHtml(lab.type || "—")}</div>
          <div class="labPdfBrand">Doc.PUG</div>
        </div>
        <div class="pill">${escapeHtml(lab.date || "—")}</div>
      </div>

      <div class="labPdfPatient">
        <div>
          <div class="history-label">Пацієнт</div>
          <div><b>${escapeHtml(pet.name || "—")}</b></div>
          <div class="meta">${escapeHtml(speciesLabel)}</div>
        </div>
      </div>

      <div class="labPdfBlock">
        <table class="servicesTable">
          <thead>
            <tr>
              <th>Показник</th>
              <th>Результат</th>
              <th>Норма</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <div class="labPdfFooter">Doc.PUG • Коли важливо — ми поруч.</div>
    </div>
  `;
}

function renderLabCard(lab, speciesKey) {
  const ranges = LAB_REF[speciesKey] || LAB_REF.dog;
  const values = lab.values || {};
  const keys = LAB_GROUPS[lab.type] || Object.keys(values);

  return `
    <div class="labCard">
      <div class="labCardHead">
        <div>
          <div class="labTitle">${escapeHtml(lab.type || "Аналіз")}</div>
          <div class="labDate">${escapeHtml(lab.date || "—")}</div>
        </div>

        <div style="display:flex; gap:8px;">
          <button class="iconBtn" title="Редагувати" data-edit-lab="${escapeHtml(lab.id)}">✏️</button>
          <button class="iconBtn" title="PDF для клієнта" data-pdf-lab="${escapeHtml(lab.id)}">📄</button>
          <button class="iconBtn" title="Видалити" data-del-lab="${escapeHtml(lab.id)}">🗑</button>
        </div>
      </div>

      <div class="labRows">
        ${keys.map((key) => {
          const value = values[key];
          const ref = ranges[key];
          if (!ref) return "";

          const [min, max, unit] = ref;
          const status = getLabStatus(value, min, max);

          return `
            <div class="labRow">
              <div class="labName">
                <b>${escapeHtml(LAB_LABELS[key] || key)}</b>
                <span>норма: ${escapeHtml(String(min))}–${escapeHtml(String(max))} ${escapeHtml(unit)}</span>
              </div>

              <div class="labValue lab-${status}">
                ${value ?? "—"} ${escapeHtml(unit)}
              </div>

              <div class="labStatus lab-${status}">
                ${labStatusLabel(status)}
              </div>

              ${renderLabScale(value, min, max)}
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

async function downloadLabPdf(pet, lab) {
  if (typeof window.html2pdf === "undefined") {
    return alert("html2pdf не підключений");
  }

  const speciesKey = getPetSpeciesKey(pet);
  const ranges = LAB_REF[speciesKey] || LAB_REF.dog;
  const keys = LAB_GROUPS[lab.type] || Object.keys(lab.values || {});

  const wrap = document.createElement("div");
  wrap.className = "labPdfA4";

  wrap.innerHTML = `
    <div class="labPdfDoc">
      <div class="labPdfHead">
        <div>
          <div class="labPdfTitle">Результати аналізу</div>
          <div class="labPdfBrand">Doc.PUG</div>
        </div>
        <div class="pill">${escapeHtml(lab.date || "—")}</div>
      </div>

      <div class="labPdfDivider"></div>

      <div class="labPdfGrid">
        <div>
          <div class="history-label">Пацієнт</div>
          <div class="a4Name">${escapeHtml(pet?.name || "—")}</div>
          <div class="a4Meta">
            ${escapeHtml([pet?.species, pet?.breed, pet?.age, pet?.weight_kg ? `${pet.weight_kg} кг` : ""].filter(Boolean).join(" • ") || "—")}
          </div>
        </div>

        <div>
          <div class="history-label">Тип аналізу</div>
          <div class="a4Name">${escapeHtml(lab.type || "Аналіз")}</div>
          <div class="a4Meta">Норми: ${speciesKey === "cat" ? "кіт" : "собака"}</div>
        </div>
      </div>

      <div class="labPdfTableBox">
        <table class="servicesTable">
          <thead>
            <tr>
              <th>Показник</th>
              <th>Результат</th>
              <th>Норма</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            ${keys.map((key) => {
              const ref = ranges[key];
              if (!ref) return "";

              const [min, max, unit] = ref;
              const value = lab.values?.[key];
              const status = getLabStatus(value, min, max);

              return `
                <tr>
                  <td>${escapeHtml(LAB_LABELS[key] || key)}</td>
                  <td><b>${escapeHtml(value ?? "—")} ${escapeHtml(unit)}</b></td>
                  <td>${escapeHtml(String(min))}–${escapeHtml(String(max))} ${escapeHtml(unit)}</td>
                  <td>${escapeHtml(labStatusLabel(status))}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);

  const filename = `DocPUG_${pet?.name || "patient"}_${lab.type || "lab"}_${lab.date || todayISO()}.pdf`;

  await window.html2pdf()
    .set({
      margin: 0,
      filename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: null },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    })
    .from(wrap)
    .save();

  wrap.remove();
}

async function renderVisits(petId) {
  const box = $("#patientTabContent");
  if (!box) return;

  box.innerHTML = ""; // Полностью очищаем контейнер вкладки от старого контента

  const visits = await getVisitsByPetId(petId);
  cacheVisits(visits);

  if (!visits.length) {
    box.innerHTML = `<div class="hint" style="text-align:center; padding: 40px; opacity: 0.5;">Поки візитів немає. Натисніть "+ Новий візит".</div>`;
    return;
  }

  // Достаем наш нативный HTML5-шаблон из index.html
  const template = document.getElementById("visit-timeline-item-template");
  if (!template) {
    console.error("Помилка: Шаблон visit-timeline-item-template не знайдено в index.html");
    return;
  }

  // Создаем обертку для всего списка (контейнер таймлайна)
  const timelineContainer = document.createElement("div");
  timelineContainer.style.cssText = "position: relative; padding-left: 0px; margin-top: 10px;";
  
  // Добавляем одну направляющую линию трека времени
  const lineTrack = document.createElement("div");
  lineTrack.style.cssText = "position: absolute; left: 12px; top: 15px; bottom: 15px; width: 2px; background: linear-gradient(180deg, #c084fc 0%, rgba(147, 51, 234, 0.1) 100%); box-shadow: 0 0 10px rgba(168, 85, 247, 0.3); opacity: 0.6;";
  timelineContainer.appendChild(lineTrack);

  // Сортируем визиты от новых к старым
  const sortedVisits = visits
    .slice()
    .sort((a, b) => String(b.date || b.id).localeCompare(String(a.date || a.id)));

  sortedVisits.forEach((v) => {
    // Глубокое клонирование структуры шаблона из index.html
    const clone = template.content.cloneNode(true);
    
    // Парсим сохраненный диагноз и жалобы
    const parsed = typeof parseVisitNote === "function" ? parseVisitNote(v.note || "") : { dx: "", complaint: v.note };
    const dx = parsed.dx || "Без встановленого діагнозу";
    const complaint = parsed.complaint || "Скарги не вказані";
    
    // Считаем общую стоимость приёма
    const grandTotal = (calcServicesTotal(v) || 0) + (calcStockTotal(v) || 0);

    // Безопасно наполняем текстовые узлы внутри клона
    const cardEl = clone.querySelector(".visit-card-el");
    cardEl.dataset.openVisit = String(v.id);
    
    clone.querySelector(".v-date").textContent = `📅 ${v.date || "—"}`;
    clone.querySelector(".v-dx").textContent = dx;
    clone.querySelector(".v-price-badge").textContent = `💰 ${grandTotal} ₴`;
    clone.querySelector(".v-complaint").textContent = complaint;

    // Блок назначений (Rx) показываем и наполняем только если в нём есть текст
    if (v.rx && v.rx.trim()) {
      clone.querySelector(".v-rx-container").style.display = "block";
      clone.querySelector(".v-rx").textContent = v.rx;
    }

    // Привязываем оригинальные data-аттрибуты с ID визита к кнопкам действий
    clone.querySelector(".v-edit-btn").dataset.editVisit = String(v.id);
    clone.querySelector(".v-del-btn").dataset.delVisit = String(v.id);

    // Добавляем премиальные hover-эффекты динамически через JS (чтобы не забивать стили)
    cardEl.addEventListener("mouseenter", () => {
      cardEl.style.background = "rgba(255, 255, 255, 0.05)";
      cardEl.style.borderColor = "rgba(168, 85, 247, 0.3)";
      cardEl.style.transform = "translateY(-2px)";
      cardEl.style.boxShadow = "0 12px 40px rgba(147, 51, 234, 0.15)";
    });
    cardEl.addEventListener("mouseleave", () => {
      cardEl.style.background = "rgba(255, 255, 255, 0.02)";
      cardEl.style.borderColor = "rgba(255, 255, 255, 0.06)";
      cardEl.style.transform = "translateY(0)";
      cardEl.style.boxShadow = "0 8px 32px rgba(0, 0, 0, 0.2)";
    });

    // Пушим карточку в контейнер
    timelineContainer.appendChild(clone);
  });

  // Вставляем собранный таймлайн в DOM
  box.appendChild(timelineContainer);

  // Железно возвращаем оригинальный обработчик кликов (делегирование событий на родителе)
  box.onclick = async (e) => {
    const editBtn = e.target.closest("[data-edit-visit]");
    if (editBtn) {
      e.preventDefault(); e.stopPropagation();
      const visitId = editBtn.dataset.editVisit;
      if (visitId && typeof openVisitModalForEdit === "function") await openVisitModalForEdit(visitId);
      return;
    }

    const delBtn = e.target.closest("[data-del-visit]");
    if (delBtn) {
      e.preventDefault(); e.stopPropagation();
      const visitId = delBtn.dataset.delVisit;
      if (!visitId) return;
      if (!confirm("Видалити цей візит?")) return;

      const ok = await deleteVisitApi(visitId);
      if (!ok) return alert("Не вдалося видалити візит.");
      await renderVisits(petId);
      return;
    }

    const card = e.target.closest("[data-open-visit]");
    if (card) {
      const visitId = card.dataset.openVisit;
      if (visitId) openVisit(visitId);
    }
  };
}

function refreshVisitServiceSelect() {
  const select = document.getElementById("visitSvcSelect");
  if (!select) return;

  const q = String(state.visitSvcQuery || "").trim().toLowerCase();
  const options = loadServices()
    .filter((s) => s.active !== false)
    .filter((s) => !q || String(s.name || "").toLowerCase().includes(q))
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} — ${escapeHtml(String(Number(s.price) || 0))} грн</option>`)
    .join("");

  select.innerHTML = options || `<option value="">Немає послуг</option>`;
}

function refreshVisitStockSelect() {
  const select = document.getElementById("visitStkSelect");
  if (!select) return;

  const q = String(state.visitStkQuery || "").trim().toLowerCase();
  const options = loadStock()
    .filter((it) => it.active !== false)
    .filter((it) => !q || String(it.name || "").toLowerCase().includes(q))
    .map((it) => {
      const left = Number(it.qty) || 0;
      const unit = String(it.unit || "шт");
      const price = Number(it.price) || 0;
      return `<option value="${escapeHtml(it.id)}">${escapeHtml(it.name)} — ${escapeHtml(String(price))} грн/${escapeHtml(unit)} • залишок: ${escapeHtml(String(left))}</option>`;
    })
    .join("");

  select.innerHTML = options || `<option value="">Немає препаратів</option>`;
}

function initVisitUI() {
  if (state.visitUiBound) return;
  state.visitUiBound = true;

  document.addEventListener("click", (e) => {
    if (e.target.closest("#btnBackPatient")) {
      if (state.selectedPetId) openPatient(state.selectedPetId);
      else if (state.selectedOwnerId) openOwner(state.selectedOwnerId);
      else setHash("owners");
      return;
    }

    if (e.target.closest("#btnDischarge")) {
      const visitId = state.selectedVisitId;
      if (!visitId) return alert("Спочатку відкрий візит.");
      if (typeof openDischargeModal === "function") openDischargeModal(visitId);
      return;
    }
  }, true);

  // ==========================================================================
// Doc.PUG CRM Mini — app.js (ЭКРАН ПРИЕМА: ДЕЛЕГИРОВАНИЕ, СЛУШАТЕЛИ И ОБРАБОТКА ВИЗИТА)
// Часть 8
// ==========================================================================

  // Обработчик кликов внутри открытого визита (услуги + склад)
  const handler = async (e) => {
    try {
      if (e.target.closest("#visitMedSave")) {
        e.preventDefault();
        e.stopPropagation();

        const vid = state.selectedVisitId;
        if (!vid) return alert("Візит не обраний");

        const current = getVisitByIdSync(vid) || (await fetchVisitById(vid));
        if (!current) return alert("Візит не знайдено");

        const dx = String(document.getElementById("visitMedDx")?.value || "").trim();
        const complaint = String(document.getElementById("visitMedComplaint")?.value || "").trim();
        const rx = String(document.getElementById("visitMedRx")?.value || "").trim();

        const services = Array.isArray(current.services) ? current.services : [];
        const stock = Array.isArray(current.stock) ? current.stock : [];

        const payload = {
          pet_id: current.pet_id,
          date: current.date,
          weight_kg: current.weight_kg,
          note: buildVisitNote(dx, complaint),
          rx,
          services,
          services_json: services,
          stock,
          stock_json: stock,
        };

        const btn = document.getElementById("visitMedSave");
        const hint = document.getElementById("visitMedSaveHint");

        if (btn) btn.textContent = "Збереження…";

        const updated = await updateVisitApi(vid, payload);
        if (!updated) {
          if (btn) btn.textContent = "💾 Зберегти";
          return alert("Не вдалося зберегти медичну частину");
        }

        const merged = {
          ...current,
          ...updated,
          note: payload.note,
          rx: payload.rx,
          services,
          services_json: services,
          stock,
          stock_json: stock,
        };

        state.visitsById.set(String(vid), merged);
        if (String(state.selectedVisitId) === String(vid)) state.selectedVisit = merged;
        
        setDischarge(vid, { complaint, dx, rx });

        if (btn) btn.textContent = "✅ Збережено";
        if (hint) hint.textContent = "Медична частина збережена.";

        if (typeof renderDischargeA4 === "function") renderDischargeA4(vid);

        setTimeout(() => {
          if (btn) btn.textContent = "💾 Зберегти";
          if (hint) hint.textContent = "Можна редагувати прямо тут. Після змін натисни “Зберегти”.";
        }, 1200);
        return;
      }

      // Добавление услуги в чек
      if (e.target.closest("#visitSvcAdd")) {
        e.preventDefault();
        e.stopPropagation();

        const vid = state.selectedVisitId;
        if (!vid) return;

        const serviceId = document.getElementById("visitSvcSelect")?.value || "";
        const qty = Math.max(1, Number(document.getElementById("visitSvcQty")?.value || 1));
        if (!serviceId) return;

        console.log("[visit-ui] add service", { vid, serviceId, qty });

        const ok = await addServiceLineToVisit(vid, serviceId, qty);
        if (!ok) return alert("Не вдалося додати послугу");

        const v = getVisitByIdSync(vid) || await fetchVisitById(vid);
        if (!v) return;

        renderVisitPage(v, state.selectedPet);
        if (typeof renderDischargeA4 === "function") renderDischargeA4(vid);
        return;
      }

      // Удаление услуги из чека
      const svcDel = e.target.closest("[data-svc-del]");
      if (svcDel) {
        e.preventDefault();
        e.stopPropagation();

        const idx = Number(svcDel.dataset.svcDel);
        if (!Number.isFinite(idx)) return;

        const vid = state.selectedVisitId;
        if (!vid) return;

        console.log("[visit-ui] del service", { vid, idx });

        const ok = await removeServiceLineFromVisit(vid, idx);
        if (!ok) return alert("Не вдалося прибрати послугу");

        const fresh = getVisitByIdSync(vid);
        if (fresh) {
          renderVisitPage(fresh, state.selectedPet);
          if (typeof renderDischargeA4 === "function") renderDischargeA4(vid);
        }
        return;
      }

      // Добавление препарата со склада
      if (e.target.closest("#visitStkAdd")) {
        e.preventDefault();
        e.stopPropagation();

        const vid = state.selectedVisitId;
        if (!vid) return;

        const stockId = document.getElementById("visitStkSelect")?.value || "";
        const qty = Math.max(1, Number(document.getElementById("visitStkQty")?.value || 1));
        if (!stockId) return;

        console.log("[visit-ui] add stock", { vid, stockId, qty });

        const ok = await addStockLineToVisit(vid, stockId, qty);
        if (!ok) return alert("Не вдалося додати препарат");

        const fresh = getVisitByIdSync(vid);
        if (fresh) {
          renderVisitPage(fresh, state.selectedPet);
          if (typeof renderDischargeA4 === "function") renderDischargeA4(vid);
        }
        return;
      }

      // Удаление препарата из чека
      const stkDel = e.target.closest("[data-stk-del]");
      if (stkDel) {
        e.preventDefault();
        e.stopPropagation();

        const idx = Number(stkDel.dataset.stkDel);
        if (!Number.isFinite(idx)) return;

        const vid = state.selectedVisitId;
        if (!vid) return;

        console.log("[visit-ui] del stock", { vid, idx });

        const ok = await removeStockLineFromVisit(vid, idx);
        if (!ok) return alert("Не вдалося прибрати препарат");

        const fresh = getVisitByIdSync(vid);
        if (fresh) {
          renderVisitPage(fresh, state.selectedPet);
          if (typeof renderDischargeA4 === "function") renderDischargeA4(vid);
        }
        return;
      }
    } catch (err) {
      console.error("Visit UI click failed:", err);
      alert("Помилка: " + (err?.message || err));
    }
  };

  document.addEventListener("click", handler, true);
  document.addEventListener("touchstart", handler, { passive: false, capture: true });

  // Делегированный инпут поиска услуг и товаров (чтобы не слетал фокус ввода при перерисовках)
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t && t.id === "visitSvcSearch") {
      state.visitSvcQuery = String(t.value || "");
      if (typeof refreshVisitServiceSelect === "function") refreshVisitServiceSelect();
      return;
    }
    if (t && t.id === "visitStkSearch") {
      state.visitStkQuery = String(t.value || "");
      if (typeof refreshVisitStockSelect === "function") refreshVisitStockSelect();
      return;
    }
  }, true);
}

// ===== Переход на страницу конкретного визита =====
async function openVisit(visitId, opts = { pushHash: true }) {
  const vid = String(visitId || "").trim();
  if (!vid) return;

  let visit = getVisitByIdSync(vid);

  if (!visit) {
    try {
      const arr = await loadVisitsApi({ id: vid });
      visit = arr?.[0] || null;
    } catch {}
  }

  if (!visit) {
    alert("Візит не знайдено");
    setHash("visits");
    return;
  }

  ensureVisitServicesShape(visit);
  ensureVisitStockShape(visit);

  state.selectedVisitId = vid;

  const patients = Array.isArray(state.patients) && state.patients.length ? state.patients : loadPatients();
  const pet = (patients || []).find((p) => String(p.id) === String(visit.pet_id)) || null;

  if (pet) {
    state.selectedPet = pet;
    state.selectedPetId = String(pet.id);
    state.selectedOwnerId = pet.owner_id || state.selectedOwnerId;
  }

  renderVisitPage(visit, pet);
  if (typeof renderVisitFiles === "function") renderVisitFiles(vid);
  initVisitUI();
  setRoute("visit");

  if (opts.pushHash) setHash("visit", vid);
}

// =========================
// Отрисовка страницы приёма и медицинских блоков
// =========================
function renderVisitPage(visit, pet) {
  // 1. Оновлюємо заголовки та мета-інформацію
  const pill = document.getElementById("visitDatePill");
  if (pill) pill.textContent = visit.date || "—";

  const meta = document.getElementById("visitMeta");
  if (meta) {
    const parts = [];
    if (pet?.name) parts.push(pet.name);
    if (pet?.species) parts.push(pet.species);
    if (pet?.breed) parts.push(pet.breed);
    if (visit?.weight_kg) parts.push(`${visit.weight_kg} кг`);
    meta.textContent = parts.length ? parts.join(" • ") : "—";
  }

  // 2. Безпечний розбір комбінованої нотатки (note) на Діагноз та Скарги
  const noteText = String(visit.note || "").trim();
  const parsed = parseVisitNote(noteText);
  
  const dxInput = document.getElementById("visitMedDx");
  if (dxInput) dxInput.value = parsed.dx || "";

  const complaintTextarea = document.getElementById("visitMedComplaint");
  if (complaintTextarea) complaintTextarea.value = parsed.complaint || "";

  const rxTextarea = document.getElementById("visitMedRx");
  if (rxTextarea) rxTextarea.value = String(visit.rx || "").trim();

  // 3. Збираємо селектор послуг
  ensureVisitServicesShape(visit);
  const svcQ = String(state.visitSvcQuery || "").trim().toLowerCase();
  const svcSelect = document.getElementById("visitSvcSelect");
  if (svcSelect) {
    svcSelect.innerHTML = loadServices()
      .filter((s) => s.active !== false)
      .filter((s) => !svcQ || String(s.name || "").toLowerCase().includes(svcQ))
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} — ${escapeHtml(String(Number(s.price) || 0))} грн</option>`)
      .join("");
  }

  // ВІДРИСОВКА ОНОВЛЕНИХ ФУТУРИСТИЧНИХ ПОСЛУГ
  const expandedServices = expandServiceLines(visit);
  const servicesTotal = calcServicesTotal(visit);
  const svcContainer = document.getElementById("visitSvcListContainer");
  if (svcContainer) {
    svcContainer.innerHTML = expandedServices.length
      ? expandedServices.map((x, idx) => `
          <div class="visitLine" style="display:flex; justify-content:space-between; align-items:center; background: rgba(255, 255, 255, 0.02); backdrop-filter: blur(10px); padding: 12px 18px; border-radius: 12px; margin-bottom: 10px; border: 1px solid rgba(255, 255, 255, 0.05); box-shadow: inset 0 1px 1px rgba(255,255,255,0.05); transition: all 0.25s ease;">
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <div style="font-weight:600; color:#fff; font-size: 0.95rem; letter-spacing: 0.3px;">${escapeHtml(x.name)}</div>
              <div style="font-size:0.8rem; color: rgba(255,255,255,0.4); font-weight: 500;">${x.qty} × <span style="color: #c084fc;">${x.price} ₴</span></div>
            </div>
            <div style="display:flex; gap:16px; align-items:center;">
              <b style="color: #fff; font-size: 1.05rem; font-weight: 700; letter-spacing: 0.5px;">${x.lineTotal} ₴</b>
              <button type="button" data-svc-del="${idx}" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 0 10px rgba(239, 68, 68, 0.05);" onmouseenter="this.style.background='rgba(239, 68, 68, 0.25)', this.style.boxShadow='0 0 15px rgba(239, 68, 68, 0.4)', this.style.color='#fff'" onmouseleave="this.style.background='rgba(239, 68, 68, 0.1)', this.style.boxShadow='none', this.style.color='#f87171'">✕</button>
            </div>
          </div>
        `).join("")
      : `<div class="hint" style="opacity:0.4; padding:12px; color:#fff; font-size: 0.9rem; font-style: italic;">Поки послуг немає. Додайте вище.</div>`;
  }

  // 4. Збираємо селектор товарів / складу
  ensureVisitStockShape(visit);
  const stkQ = String(state.visitStkQuery || "").trim().toLowerCase();
  const stkSelect = document.getElementById("visitStkSelect");
  if (stkSelect) {
    stkSelect.innerHTML = loadStock()
      .filter((it) => it.active !== false)
      .filter((it) => !stkQ || String(it.name || "").toLowerCase().includes(stkQ))
      .map((it) => `<option value="${escapeHtml(it.id)}">${escapeHtml(it.name)} — ${escapeHtml(String(Number(it.price) || 0))} грн • залишок: ${it.qty}</option>`)
      .join("");
  }

  // ВІДРИСОВКА ОНОВЛЕНОГО ФУТУРИСТИЧНОГО СКЛАДУ
  const expandedStock = expandStockLines(visit);
  const stockTotal = calcStockTotal(visit);
  const stkContainer = document.getElementById("visitStkListContainer");
  if (stkContainer) {
    stkContainer.innerHTML = expandedStock.length
      ? expandedStock.map((x, idx) => `
          <div class="visitLine" style="display:flex; justify-content:space-between; align-items:center; background: rgba(255, 255, 255, 0.02); backdrop-filter: blur(10px); padding: 12px 18px; border-radius: 12px; margin-bottom: 10px; border: 1px solid rgba(255, 255, 255, 0.05); box-shadow: inset 0 1px 1px rgba(255,255,255,0.05); transition: all 0.25s ease;">
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <div style="font-weight:600; color:#fff; font-size: 0.95rem; letter-spacing: 0.3px;">${escapeHtml(x.name)}</div>
              <div style="font-size:0.8rem; color: rgba(255,255,255,0.4); font-weight: 500;">${x.qty} × <span style="color: #c084fc;">${x.price} ₴</span></div>
            </div>
            <div style="display:flex; gap:16px; align-items:center;">
              <b style="color: #fff; font-size: 1.05rem; font-weight: 700; letter-spacing: 0.5px;">${x.lineTotal} ₴</b>
              <button type="button" data-stk-del="${idx}" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 0 10px rgba(239, 68, 68, 0.05);" onmouseenter="this.style.background='rgba(239, 68, 68, 0.25)', this.style.boxShadow='0 0 15px rgba(239, 68, 68, 0.4)', this.style.color='#fff'" onmouseleave="this.style.background='rgba(239, 68, 68, 0.1)', this.style.boxShadow='none', this.style.color='#f87171'">✕</button>
            </div>
          </div>
        `).join("")
      : `<div class="hint" style="opacity:0.4; padding:12px; color:#fff; font-size: 0.9rem; font-style: italic;">Поки препаратів немає. Додайте вище.</div>`;
  }

  // 5. Виводимо загальну фінансову суму
  const grandTotal = servicesTotal + stockTotal;
  const totalDisplay = document.getElementById("visitGrandTotal");
  if (totalDisplay) totalDisplay.textContent = `${grandTotal} ₴`;

  // Відновлюємо оригінальні обробники подій кнопок та пошуку (initVisitUI)
  if (typeof initVisitUI === "function") {
    initVisitUI();
  }

  // Навешуємо відкриття PDF виписки на кнопку
  // === СТИЛЬНАЯ ПРЕМИУМ-ВЫПИСКА ДЛЯ КЛИЕНТА ===
  const btnPdf = document.getElementById("btnPrintVisitPdf");
  if (btnPdf) {
    btnPdf.onclick = (e) => {
      e.preventDefault();
      
      const printWindow = window.open("", "_blank");
      if (!printWindow) return alert("Будь ласка, дозвольте спливаючі вікна для цього сайту!");

      // Собираем свежие строки услуг и товаров прямо из DOM для точности
      const servicesRows = expandedServices.map(x => `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #f1f5f9; color: #334155; font-size: 0.95rem;">${escapeHtml(x.name)}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f5f9; color: #64748b; text-align: center; font-size: 0.95rem;">${x.qty}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f5f9; color: #1e1b4b; text-align: right; font-weight: 600; font-size: 0.95rem;">${x.lineTotal} ₴</td>
        </tr>
      `).join("");

      const stockRows = expandedStock.map(x => `
        <tr>
          <td style="padding: 12px; border-bottom: 1px solid #f1f5f9; color: #334155; font-size: 0.95rem;">${escapeHtml(x.name)}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f5f9; color: #64748b; text-align: center; font-size: 0.95rem;">${x.qty}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f5f9; color: #1e1b4b; text-align: right; font-weight: 600; font-size: 0.95rem;">${x.lineTotal} ₴</td>
        </tr>
      `).join("");

      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Виписка: ${escapeHtml(pet?.name || "Пацієнт")}</title>
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
            body { font-family: 'Inter', sans-serif; color: #1e293b; margin: 0; padding: 40px; background: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .wrapper { max-width: 800px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #f1f5f9; padding-bottom: 24px; margin-bottom: 30px; }
            .logo { font-size: 1.6rem; font-weight: 700; color: #1e1b4b; display: flex; align-items: center; gap: 8px; }
            .logo span { color: #a855f7; }
            .clinic-info { text-align: right; font-size: 0.85rem; color: #64748b; line-height: 1.4; }
            .section { background: #f8fafc; border-radius: 12px; padding: 20px; margin-bottom: 20px; border: 1px solid #f1f5f9; }
            .section-title { font-weight: 700; font-size: 0.9rem; color: #6b21a8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
            .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
            .meta-item { font-size: 0.95rem; color: #334155; }
            .meta-item b { color: #1e293b; font-weight: 600; }
            .text-block { font-size: 0.95rem; color: #334155; line-height: 1.6; white-space: pre-wrap; margin: 0; }
            table { width: 100%; border-collapse: collapse; margin-top: 8px; }
            th { background: #f1f5f9; padding: 10px 12px; font-weight: 600; font-size: 0.85rem; color: #475569; text-align: left; text-transform: uppercase; letter-spacing: 0.5px; }
            th:first-child { border-radius: 6px 0 0 6px; }
            th:last-child { border-radius: 0 6px 6px 0; }
            .grand-total-box { display: flex; justify-content: space-between; align-items: center; background: #faf5ff; border: 1px solid #f3e8ff; border-radius: 12px; padding: 18px 24px; margin-top: 30px; }
            .grand-total-label { font-size: 1rem; font-weight: 600; color: #6b21a8; }
            .grand-total-value { font-size: 1.6rem; font-weight: 800; color: #7e22ce; }
            @media print {
              body { padding: 0; }
              .section { background: #f8fafc !important; border: 1px solid #e2e8f0 !important; }
              .grand-total-box { background: #faf5ff !important; border: 1px solid #e9d5ff !important; }
            }
          </style>
        </head>
        <body>
          <div class="wrapper">
            
            <div class="header">
              <div class="logo">🐾 Doc.PUG <span>CRM</span></div>
              <div class="clinic-info">
                <b>Ветеринарна клініка Doc.PUG</b><br>
                Електронний медичний висновок<br>
                Дата візиту: ${escapeHtml(visit.date || "")}
              </div>
            </div>
            
            <div class="section">
              <div class="section-title">🐾 Пацієнт та власник</div>
              <div class="grid-2">
                <div class="meta-item"><b>Кличка:</b> ${escapeHtml(pet?.name || "—")}</div>
                <div class="meta-item"><b>Вага:</b> ${escapeHtml(String(visit.weight_kg || "—"))} кг</div>
                <div class="meta-item"><b>Вид / Порода:</b> ${escapeHtml(pet?.species || "")} ${escapeHtml(pet?.breed || "—")}</div>
                <div class="meta-item"><b>Статус:</b> Амбулаторний прийом</div>
              </div>
            </div>

            <div class="section">
              <div class="section-title">📝 Скарги та анамнез стану</div>
              <p class="text-block">${escapeHtml(document.getElementById("visitMedComplaint")?.value || "—")}</p>
            </div>

            <div class="section">
              <div class="section-title">🔍 Встановлений діагноз</div>
              <p class="text-block" style="font-weight: 600; color: #1e293b;">${escapeHtml(document.getElementById("visitMedDx")?.value || "Клінічно здоровий")}</p>
            </div>

            <div class="section">
              <div class="section-title">💊 Призначене лікування (Rx)</div>
              <p class="text-block" style="background: #ffffff; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0;">${escapeHtml(document.getElementById("visitMedRx")?.value || "Рекомендовано нагляд")}</p>
            </div>

            ${servicesRows ? `
            <div class="section" style="background: #fff; padding: 10px 0; border: none;">
              <div class="section-title" style="padding-left: 12px;">💼 Надані клінічні послуги</div>
              <table>
                <thead>
                  <tr>
                    <th>Назва послуги</th>
                    <th style="text-align:center; width: 80px;">К-сть</th>
                    <th style="text-align:right; width: 120px;">Сума</th>
                  </tr>
                </thead>
                <tbody>${servicesRows}</tbody>
              </table>
            </div>` : ""}

            ${stockRows ? `
            <div class="section" style="background: #fff; padding: 10px 0; border: none;">
              <div class="section-title" style="padding-left: 12px;">📦 Використані медикаменти та матеріали</div>
              <table>
                <thead>
                  <tr>
                    <th>Назва препарату</th>
                    <th style="text-align:center; width: 80px;">К-сть</th>
                    <th style="text-align:right; width: 120px;">Сума</th>
                  </tr>
                </thead>
                <tbody>${stockRows}</tbody>
              </table>
            </div>` : ""}

            <div class="grand-total-box">
              <div class="grand-total-label">Загальна вартість прийому</div>
              <div class="grand-total-value">${grandTotal} ₴</div>
            </div>

          </div>
          <script>
            window.onload = function() { 
              setTimeout(function() { window.print(); }, 300); 
            };
          </script>
        </body>
        </html>
      `);
      printWindow.document.close();
    };
  }
}

function parseVisitNote(note) {
  const t = String(note || "");
  const dxMatch = t.match(/Діагноз:\s*(.*?)(\n|$)/i);
  const dx = (dxMatch?.[1] || "").trim();

  const compMatch = t.match(/Скарги\/анамнез:\s*([\s\S]*)/i);
  const complaint = (compMatch?.[1] || "").trim();

  return {
    dx: dx || "",
    complaint: complaint || (!dx ? t.trim() : ""),
  };
}

// ==========================================================================
// Doc.PUG CRM Mini — app.js (БЛАНКИ ВЫПИСОК А4, ПЕЧАТЬ И ОБРАБОТЧИКИ КАРТОЧЕК)
// Часть 8
// ==========================================================================

function fillDischargeForm(visit, existing) {
  const ex = existing || {};
  const parsed = parseVisitNote(visit?.note || "");
  
  const complaint = (ex.complaint ?? ex.disComplaint ?? parsed.complaint ?? "").toString();
  const dx = (ex.dx ?? ex.disDx ?? parsed.dx ?? "").toString();
  
  const parsedRx = typeof parseRxCombined === "function" ? parseRxCombined(visit?.rx || "") : { rx: visit?.rx || "", recs: "", follow: "" };
  const rx = (ex.rx ?? ex.disRx ?? parsedRx.rx ?? "").toString();
  const recs = (ex.recs ?? ex.disRecs ?? parsedRx.recs ?? "").toString();
  const follow = (ex.follow ?? ex.disFollow ?? parsedRx.follow ?? "").toString();

  const c = document.getElementById("disComplaint");
  const d = document.getElementById("disDx");
  const r = document.getElementById("disRx");
  const re = document.getElementById("disRecs");
  const f = document.getElementById("disFollow");

  if (c) c.value = complaint;
  if (d) d.value = dx;
  if (r) r.value = rx;
  if (re) re.value = recs;
  if (f) f.value = follow;
}

function readDischargeForm() {
  return {
    complaint: (document.getElementById("disComplaint")?.value || "").trim(),
    dx:        (document.getElementById("disDx")?.value || "").trim(),
    rx:        (document.getElementById("disRx")?.value || "").trim(),
    recs:      (document.getElementById("disRecs")?.value || "").trim(),
    follow:    (document.getElementById("disFollow")?.value || "").trim(),
  };
}

async function renderDischargeA4(visitId) {
  const a4 = document.getElementById("disA4");
  if (!a4) return;

  let v = getVisitByIdSync(visitId);
  if (!v) {
    v = await fetchVisitById(visitId);
    if (v?.id) cacheVisits([v]);
  }

  if (!v) {
    a4.innerHTML = `<div class="hint">Візит не знайдено</div>`;
    return;
  }

  const patients = (Array.isArray(state.patients) && state.patients.length) ? state.patients : loadPatients();
  const pet = (patients || []).find((p) => String(p.id) === String(v.pet_id)) || null;
  const owner = pet?.owner_id ? getOwnerById(pet.owner_id) : null;

  const dis = getDischarge(visitId) || {};
  const parsed = parseVisitNote(v.note || "");

  const complaint = String(dis.complaint ?? parsed.complaint ?? "").trim();
  const dx = String(dis.dx ?? parsed.dx ?? "").trim();

  const parsedRx = parseRxCombined(v.rx || "");
  const rx = String(dis.rx ?? parsedRx.rx ?? v.rx ?? "").trim();
  const recs = String(dis.recs ?? parsedRx.recs ?? "").trim();
  const follow = String(dis.follow ?? parsedRx.follow ?? "").trim();

  let svcHtml = "—";
  try {
    const expanded = expandServiceLines(v);
    const total = calcServicesTotal(v);
    svcHtml = renderServicesProA4(expanded, total);
  } catch {}

  let stkHtml = "—";
  try {
    const expandedS = expandStockLines(v);
    const totalS = calcStockTotal(v);

    if (!expandedS.length) {
      stkHtml = `<div class="hint" style="opacity:.75">—</div>`;
    } else {
      const rows = expandedS.map((x) => `
        <tr>
          <td>${escapeHtml(x.name || "—")}</td>
          <td>${escapeHtml(String(x.qty))}</td>
          <td>${escapeHtml(String(x.price))}</td>
          <td>${escapeHtml(String(x.lineTotal))}</td>
        </tr>
      `).join("");

      stkHtml = `
        <div class="servicesPro">
          <table class="servicesTable">
            <thead><tr><th>Препарат</th><th>К-сть</th><th>Ціна</th><th>Сума</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td colspan="3">Разом</td><td>${escapeHtml(String(totalS))} грн</td></tr></tfoot>
          </table>
        </div>
      `;
    }
  } catch {}

  a4.innerHTML = `
  <div class="a4Doc">
    <div class="a4Header">
      <div>
        <div class="a4Title">Направлення / Виписка</div>
        <div class="a4Brand">Doc.PUG</div>
      </div>
      <div class="pill">${escapeHtml(String(v.date || "—"))}</div>
    </div>

    <div class="a4Divider"></div>

    <div class="a4PatientGrid">
      <div>
        <div class="history-label">Пацієнт</div>
        <div class="a4Name">${escapeHtml(pet?.name || "—")}</div>
        <div class="a4Meta">
          ${escapeHtml([pet?.species, pet?.breed, pet?.age, v?.weight_kg ? `${v.weight_kg} кг` : ""].filter(Boolean).join(" • ") || "—")}
        </div>
      </div>
      <div>
        <div class="history-label">Власник</div>
        <div class="a4Name">${escapeHtml(owner?.name || "—")}</div>
        <div class="a4Meta">
          ${escapeHtml([owner?.phone, owner?.note].filter(Boolean).join(" • ") || "—")}
        </div>
      </div>
    </div>

    <div class="a4Block">
      <div class="history-label">Скарги / стан</div>
      <div class="preserveText">${escapeHtml(complaint || "—")}</div>
    </div>

    <div class="a4Block">
      <div class="history-label">Діагноз</div>
      <div class="preserveText">${escapeHtml(dx || "—")}</div>
    </div>

    <div class="a4Block">
      <div class="history-label">Призначення</div>
      <div class="preserveText">${escapeHtml(rx || "—")}</div>
    </div>

    <div class="a4Block dischargeFinanceBlock">
      <div class="history-label">Послуги / Препарати</div>
      <div class="servicesPro">
        <table class="servicesTable">
          <thead>
            <tr>
              <th>Назва</th>
              <th>Тип</th>
              <th>К-сть</th>
              <th>Ціна</th>
              <th>Сума</th>
            </tr>
          </thead>
          <tbody>
            ${
              [
                ...expandServiceLines(v).map(x => ({ ...x, type: "Послуга" })),
                ...expandStockLines(v).map(x => ({ ...x, type: "Препарат" }))
              ]
              .map(x => `
                <tr>
                  <td>${escapeHtml(x.name || "—")}</td>
                  <td>${escapeHtml(x.type)}</td>
                  <td>${escapeHtml(String(x.qty || 1))}</td>
                  <td>${escapeHtml(String(x.price || 0))}</td>
                  <td>${escapeHtml(String(x.lineTotal || 0))}</td>
                </tr>
              `)
              .join("") || `<tr><td colspan="5">—</td></tr>`
            }
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4">Разом</td>
              <td>${escapeHtml(String((calcServicesTotal(v) || 0) + (calcStockTotal(v) || 0)))} грн</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <div class="a4Block">
      <div class="history-label">Рекомендації</div>
      <div class="preserveText">${escapeHtml(recs || "—")}</div>
    </div>

    <div class="a4Block">
      <div class="history-label">Контроль / при погіршенні</div>
      <div class="preserveText">${escapeHtml(follow || "—")}</div>
    </div>
  </div>
`;
}

function parseRxCombined(text) {
  const t = String(text || "");
  const recsMatch = t.match(/(?:^|\n)Рекомендації:\n([\s\S]*?)(?=\n\nКонтроль \/ при погіршенні:\n|\s*$)/);
  const followMatch = t.match(/(?:^|\n)Контроль \/ при погіршенні:\n([\s\S]*)$/);

  const recs = (recsMatch?.[1] || "").trim();
  const follow = (followMatch?.[1] || "").trim();

  let rx = t;
  const cut = t.indexOf("\n\nРекомендації:\n");
  if (cut >= 0) rx = t.slice(0, cut);
  rx = rx.trim();

  return { rx, recs, follow };
}

function normalizeJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function safeVisitArray(primary, backup) {
  const a = normalizeJsonArray(primary);
  if (a.length) return a;
  return normalizeJsonArray(backup);
}

function initDischargeModalUI() {
  if (state.dischargeListenersBound) return;

  const modal = $("#dischargeModal");
  if (!modal) return;

  const live = () => {
    const vid = modal.dataset.visitId;
    if (vid) renderDischargeA4(vid);
  };

  ["#disComplaint", "#disDx", "#disRx", "#disRecs", "#disFollow"].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener("input", live);
  });

  document.addEventListener("click", async (e) => {
    const modal = $("#dischargeModal");
    if (!modal) return;
    const vid = modal.dataset.visitId;

    // Сохранение на сервер
    if (e.target.closest("#disSave")) {
      e.preventDefault(); e.stopPropagation();
      if (!vid) return;

      const form = readDischargeForm();
      setDischarge(vid, form);

      const current = getVisitByIdSync(vid) || (await fetchVisitById(vid));
      if (!current) return alert("Візит не знайдено");

      const services = safeVisitArray(current.services, current.services_json);
      const stock    = safeVisitArray(current.stock, current.stock_json);

      const payload = {
        pet_id: current.pet_id,
        date: current.date,
        weight_kg: current.weight_kg,
        note: buildVisitNote(form.dx, form.complaint),
        rx: typeof buildRxCombined === "function" ? buildRxCombined(form.rx, form.recs, form.follow) : `${form.rx}\n\nРекомендації:\n${form.recs}\n\nКонтроль / при погіршенні:\n${form.follow}`,
        services,
        services_json: services,
        stock,
        stock_json: stock,
      };

      const updated = await updateVisitApi(vid, payload);
      if (!updated) return alert("Помилка збереження візиту");

      const fresh = await fetchVisitById(vid);
      if (fresh?.id) {
        cacheVisits([fresh]);
        if (String(state.selectedVisitId) === String(vid)) state.selectedVisit = fresh;
      }

      fillDischargeForm(fresh, getDischarge(vid) || form);
      renderDischargeA4(vid);
      await refreshVisitUIIfOpen();
      alert("✅ Збережено на сервері");
      return;
    }

    if (e.target.closest("#disPrint")) {
      e.preventDefault(); e.stopPropagation();
      if (!vid) return;
      printA4Only(vid); return;
    }

    if (e.target.closest("#disDownload")) {
      e.preventDefault(); e.stopPropagation();
      if (!vid) return;
      await downloadA4Pdf(vid); return;
    }

    if (e.target.closest("[data-close-discharge]")) {
      closeDischargeModal(); return;
    }
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDischargeModal();
      if (typeof closeVisitModal === "function") closeVisitModal();
    }
  });

  state.dischargeListenersBound = true;
}

async function openDischargeModal(visitId) {
  const modal = $("#dischargeModal");
  if (!modal) return alert("Не знайдено #dischargeModal в HTML");

  const vid = String(visitId || "");
  if (!vid) return;

  modal.dataset.visitId = vid;

  let v = getVisitByIdSync(vid);
  if (!v) v = await fetchVisitById(vid);
  if (v?.id) cacheVisits([v]);

  const existing = getDischarge(vid) || {};
  fillDischargeForm(v || {}, existing);

  await renderDischargeA4(vid);
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
// =========================
// РЕНДЕР СПИСКА ВЛАДЕЛЬЦЕВ (Восстановленный)
// =========================
// =========================
// OWNERS — Адаптированный рендер для стеклянной таблицы
// =========================
function renderOwners() {
  const tbody = document.getElementById("owners-table-body");
  if (!tbody) return;

  tbody.innerHTML = "";

  const q = String(document.getElementById("globalSearch")?.value || "").trim().toLowerCase();
  const ownersRaw = Array.isArray(state.owners) ? state.owners : [];

    const filteredOwners = ownersRaw.filter((owner) => {
    if (!q) return true;
    
    // Безопасное приведение к строке и нижнему регистру
    const name = (owner.name || "").toString().toLowerCase();
    const phone = (owner.phone || "").toString().toLowerCase();
    const note = (owner.note || "").toString().toLowerCase();
    
    return name.includes(q) || phone.includes(q) || note.includes(q);
  });

  if (!filteredOwners.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; opacity: 0.5;">Нічого не знайдено.</td></tr>`;
    return;
  }

  filteredOwners.forEach((owner) => {
    const tr = document.createElement("tr");
    
    // При клике на строку открываем страницу владельца
    tr.style.cursor = "pointer";
    tr.dataset.openOwner = String(owner.id);

    const petsCount = (state.patients || []).filter(
      p => String(p.owner_id) === String(owner.id)
    ).length;

    tr.innerHTML = `
      <td style="font-weight: 600;">👤 ${escapeHtml(owner.name || "Без імені")}</td>
      <td>📞 ${escapeHtml(owner.phone || "Не вказано")}</td>
      <td>
        <span style="background: rgba(147, 51, 234, 0.2); color: #c084fc; padding: 4px 8px; border-radius: 6px; font-size: 0.8rem;">
          🐾 ${petsCount} пацієнтів
        </span>
      </td>
      <td>📍 ${escapeHtml(owner.note || "—")}</td>
      <td style="display:flex; gap:8px;">
        <button class="iconBtn" title="Редагувати" data-edit-owner="${escapeHtml(owner.id)}" style="background: transparent; border: none; cursor: pointer; font-size: 1rem;">✏️</button>
        <button class="iconBtn" title="Видалити" data-del="${escapeHtml(owner.id)}" style="background: transparent; border: none; cursor: pointer; font-size: 1rem;">🗑</button>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

// =========================
// UI ВЛАДЕЛЬЦЕВ — Адаптировано под новую таблицу
// =========================
function initOwnersUI() {
  if (state.ownersUiBound) return;
  state.ownersUiBound = true;

  document.addEventListener("click", async (e) => {
    const addBtn = e.target.closest("#btnAddOwner, [data-action='add-owner'], [data-action='addOwner'], .btnAddOwner");
    if (addBtn) {
      e.preventDefault(); e.stopPropagation();
      const name = (prompt("Имя владельца:") || "").trim();
      if (!name) return;

      const phone = (prompt("Телефон (необязательно):") || "").trim();
      const note = (prompt("Заметка/город (необязательно):") || "").trim();

      const created = await createOwner(name, phone, note);
      if (!created) return;
      await loadOwners(); return;
    }

    // ✅ ВОТ ОНО: Теперь скрипт ловит клики в новом tbody
    const ownersList = e.target.closest("#owners-table-body") || e.target.closest("#ownersList") || e.target.closest(".data-table-container");
    if (!ownersList) return;

    const editBtn = e.target.closest("[data-edit-owner]");
    if (editBtn) {
      e.preventDefault(); e.stopPropagation();
      const id = editBtn.dataset.editOwner;
      if (!id) return;

      const owner = (state.owners || []).find((o) => String(o.id) === String(id));
      if (!owner) return alert("Власника не знайдено");

      const name = (prompt("Імʼя власника:", owner.name || "") || "").trim();
      if (!name) return;

      const phone = (prompt("Телефон:", owner.phone || "") || "").trim();
      const note = (prompt("Нотатка / місто:", owner.note || "") || "").trim();

      const updated = await updateOwner(id, { name, phone, note });
      if (!updated) return;
      await loadOwners();

      if (state.selectedOwnerId && String(state.selectedOwnerId) === String(id)) {
        renderOwnerPage(id);
      }
      return;
    }

    const delBtn = e.target.closest("[data-del]");
    if (delBtn) {
      e.preventDefault(); e.stopPropagation();
      const id = delBtn.dataset.del; if (!id) return;
      if (!confirm("Удалить владельца?")) return;

      const ok = await deleteOwner(id);
      if (!ok) return alert("Не удалось удалить владельца");
      await loadOwners(); return;
    }

    const openZone = e.target.closest("[data-open-owner]");
    if (openZone) {
      e.preventDefault(); e.stopPropagation();
      const ownerId = openZone.dataset.openOwner;
      if (ownerId) openOwner(ownerId);
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#btnBackOwners")) setHash("owners");
  });
}
// ==========================================================================
// Doc.PUG CRM Mini — app.js (СПЕЦИФИКАЦИИ, МОДАЛЬНЫЕ ОКНА И ОБРАБОТЧИКИ ПРОФИЛЕЙ)
// Часть 9
// ==========================================================================

// =========================
// OWNER UI — Управление карточкой владельца
// =========================
function initOwnerUI() {
  // Добавление животного владельцу
  $("#btnAddPet")?.addEventListener("click", async () => {
    const ownerId = state.selectedOwnerId;
    if (!ownerId) return alert("Спочатку обери власника");

    const name = (prompt("Кличка:") || "").trim();
    if (!name) return;

    const species = askSpecies("dog");
    if (!species) return;
    const breed = (prompt("Порода (необязательно):") || "").trim();
    const age = (prompt("Возраст (например: 3 года / 8 мес):") || "").trim();
    const weight_kg = (prompt("Вес (кг, например 7.5):") || "").trim();
    const notes = (prompt("Заметки (необязательно):") || "").trim();

    const created = await createPatientApi({
      owner_id: ownerId,
      name,
      species,
      breed,
      age,
      weight_kg,
      notes,
    });

    if (!created) return;

    await loadPatientsApi();
    renderOwnerPage(ownerId);
  });

  // Клик по списку животных (Удаление / Открытие)
  $("#petsList")?.addEventListener("click", async (e) => {
    const delBtn = e.target.closest("[data-del-pet]");
    if (delBtn) {
      e.preventDefault(); e.stopPropagation();
      const petId = delBtn.dataset.delPet;
      if (!petId) return;

      if (!confirm("Видалити пацієнта назавжди?")) return;

      const ok = await deletePatientApi(petId);
      if (!ok) return alert("Не вдалося видалити пацієнта.");

      await loadPatientsApi();

      if (state.selectedPetId === petId) {
        state.selectedPetId = null;
        state.selectedPet = null;
      }

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

// =========================
// VISITS TAB UI — Глобальный журнал визитов
// =========================
function initVisitsTabUI() {
  const page = $(`.page[data-page="visits"]`);
  if (!page) return;

  page.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-visit]");
    if (del) {
      e.preventDefault(); e.stopPropagation();
      const visitId = del.dataset.delVisit;
      if (!visitId) return;

      if (!confirm("Видалити візит назавжди?")) return;

      const ok = await deleteVisitApi(visitId);
      if (!ok) return alert("Не вдалося видалити візит.");

      try {
        const arr = await loadVisitsApi();
        state.visits = arr;
        cacheVisits(arr);
      } catch {}

      renderVisitsTab();
      return;
    }

    const btn = e.target.closest("[data-open-visit]");
    if (btn) {
      e.preventDefault(); e.stopPropagation();
      const visitId = btn.dataset.openVisit;
      if (visitId) openVisit(visitId);
    }
  });
}

function closeVisitModal() {
  const modal = $("#visitModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  delete modal.dataset.visitId;
}

// =========================
// VISIT_FILES (Управление связями в LocalStorage)
// =========================
function loadVisitFilesLinks() {
  const arr = LS.get(VISIT_FILES_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function saveVisitFilesLinks(arr) {
  LS.set(VISIT_FILES_KEY, Array.isArray(arr) ? arr : []);
}

function getFileIdsForVisit(visitId) {
  const vid = String(visitId || "");
  if (!vid) return [];
  return loadVisitFilesLinks()
    .filter((x) => String(x.visit_id) === vid)
    .map((x) => String(x.file_id))
    .filter(Boolean);
}

function linkFilesToVisit(visitId, fileIds) {
  const vid = String(visitId || "");
  if (!vid) return;

  const ids = (Array.isArray(fileIds) ? fileIds : []).map((x) => String(x || "")).filter(Boolean);
  if (!ids.length) return;

  const links = loadVisitFilesLinks();
  for (const fid of ids) {
    const exists = links.some((r) => String(r.visit_id) === vid && String(r.file_id) === String(fid));
    if (!exists) {
      links.push({ visit_id: vid, file_id: String(fid), created_at: nowISO() });
    }
  }
  saveVisitFilesLinks(links);
}

function detachFileFromVisit(visitId, fileId) {
  const vid = String(visitId || "");
  const fid = String(fileId || "");
  if (!vid || !fid) return;

  const next = loadVisitFilesLinks().filter((r) => !(String(r.visit_id) === vid && String(r.file_id) === fid));
  saveVisitFilesLinks(next);
}

// =========================
// Спецификации видов животных и нормализаторы
// =========================
function normalizeSpecies(value) {
  const s = String(value || "").toLowerCase().trim();
  if (s === "dog" || s.includes("пес") || s.includes("соб") || s.includes("dog")) return "dog";
  if (s === "cat" || s.includes("кот") || s.includes("кіт") || s.includes("cat")) return "cat";
  return "dog";
}

function speciesLabel(value) {
  const key = normalizeSpecies(value);
  if (key === "cat") return "кіт";
  return "пес";
}

function askSpecies(current = "dog") {
  const cur = normalizeSpecies(current);
  const raw = prompt("Вид пацієнта:\n1 — пес\n2 — кіт", cur === "cat" ? "2" : "1");
  if (raw === null) return null;

  const v = String(raw).trim().toLowerCase();
  if (v === "2" || v === "cat" || v.includes("кот") || v.includes("кіт")) return "cat";
  return "dog";
}

function getPetSpeciesKey(pet) {
  return normalizeSpecies(pet?.species);
}

// =========================
// Вспомогательные функции модального окна визитов
// =========================
function openVisitModalForCreate(pet) {
  const modal = $("#visitModal");
  if (!modal) return alert("Не знайдено #visitModal в HTML");

  delete modal.dataset.visitId;

  $("#visitDate").value = todayISO();
  $("#visitNote").value = "";
  $("#visitDx").value = "";
  $("#visitWeight").value = pet?.weight_kg || pet?.weight || "";
  $("#visitRx").value = "";

  const select = $("#visitStaff");

  const fillStaffSelect = (staffList) => {
    if (!select) return;
    select.innerHTML = `
      <option value="">Оберіть ветеринара</option>
      ${staffList.map((doc) => `
        <option value="${escapeHtml(String(doc.id))}">
          ${escapeHtml(doc.name || "Працівник")}
        </option>
      `).join("")}
    `;
  };

  const fillStaffFallback = () => {
    if (!select) return;
    select.innerHTML = `
      <option value="">Оберіть ветеринара</option>
      <option value="default_doc" selected>Черговий лікар 🩺</option>
    `;
  };

  if (typeof loadStaffApi === "function") {
    loadStaffApi()
      .then((staff) => {
        if (!staff || staff.length === 0) {
          staff = [{ id: "default_doc", name: "Черговий лікар 🩺" }];
        }
        fillStaffSelect(staff);
      })
      .catch((err) => {
        console.warn("Бэкенд недоступен, ставим дефолтного врача:", err);
        fillStaffFallback();
      });
  } else {
    fillStaffFallback();
  }

  // === ЖЕЛЕЗНАЯ ФУНКЦИЯ ЗАКРЫТИЯ ===
  const closeVisitModal = () => {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    
    // Скрываем инлайново, полностью убирая видимость
    modal.style.display = "none";
    modal.style.opacity = "0";
    modal.style.pointerEvents = "none";
    
    // Убираем слушатель Esc, чтобы не засорять память
    document.removeEventListener("keydown", handleEscClose);
  };

  // Закрытие по нажатию на кнопку ESC
  const handleEscClose = (e) => {
    if (e.key === "Escape") closeVisitModal();
  };
  document.addEventListener("keydown", handleEscClose);

  // Перехватываем клик по абсолютно любым крестикам, кнопкам закрытия или "Скасувати"
  const allCloseElements = modal.querySelectorAll(".close, .btn-close, [data-close], .cancel-btn, #btnCancelVisit");
  allCloseElements.forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      closeVisitModal();
    };
  });

  // Умный поиск крестика по тексту (если в index.html это просто <span>✕</span> или кнопка без классов)
  modal.onclick = (e) => {
    const text = e.target.innerText ? e.target.innerText.trim() : "";
    if (text === "✕" || text === "Скасувати" || e.target.classList.contains("close-modal")) {
      e.preventDefault();
      closeVisitModal();
    }
  };

  // Перехватываем сохранение формы, чтобы закрывать окно и обновлять список
  const form = modal.querySelector("form");
  if (form) {
    form.addEventListener("submit", () => {
      // Даем 250мс на то, чтобы твой оригинальный асинхронный submit отправил данные на сервер Render
      setTimeout(() => {
        closeVisitModal();
        // Принудительно обновляем список визитов на экране, чтобы новый визит сразу появился
        if (state && state.selectedPetId && typeof renderVisits === "function") {
          renderVisits(state.selectedPetId);
        }
      }, 250);
    });
  }

  // === ЭФФЕКТНОЕ ЦЕНТРИРОВАНИЕ И УВЕЛИЧЕНИЕ (Apple VisionOS / macOS Style) ===
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  
  // Жестко выравниваем строго по центру экрана и увеличиваем ширину
  modal.style.position = "fixed";
  modal.style.top = "50%";
  modal.style.left = "50%";
  modal.style.transform = "translate(-50%, -50%) scale(1)";
  
  // Размеры панельки
  modal.style.width = "680px"; 
  modal.style.maxWidth = "95vw";
  modal.style.maxHeight = "85vh";
  modal.style.overflowY = "auto"; // Если поля не влезут, внутри появится аккуратный скролл
  
  // Красивые премиум-отступы и скругления
  modal.style.padding = "32px";
  modal.style.borderRadius = "24px";
  modal.style.zIndex = "10000"; // Поверх всех остальных элементов CRM
  
  // Включаем отображение
  modal.style.display = "block";
  modal.style.opacity = "1";
  modal.style.pointerEvents = "auto";
  modal.style.transition = "all 0.25s cubic-bezier(0.16, 1, 0.3, 1)";
}

// =========================
// PATIENT UI — Управление карточкой животного
// =========================
// subdivision
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

  $("#visitsList")?.addEventListener("click", async (e) => {
    // Удаление
    const delBtn = e.target.closest("[data-del-visit]");
    if (delBtn) {
      e.preventDefault(); e.stopPropagation();
      const visitId = delBtn.dataset.delVisit;
      if (!visitId) return;
      if (!confirm("Видалити цей візит?")) return;

      const ok = await deleteVisitApi(visitId);
      if (!ok) return alert("Не вдалося видалити візит.");

      if (state.selectedPetId) await renderVisits(state.selectedPetId);
      return;
    }

    // Редактирование
    const editBtn = e.target.closest("[data-edit-visit]");
    if (editBtn) {
      e.preventDefault(); e.stopPropagation();
      const visitId = editBtn.dataset.editVisit;
      if (visitId) await openVisitModalForEdit(visitId);
      return;
    }

    // Открытие визита
    const item = e.target.closest(".item");
    if (!item) return;

    const visitId = item.dataset.openVisit;
    if (visitId) openVisit(visitId);
  });

  if (!state.visitFilesUiBound) {
    if (typeof initVisitFilesUI === "function") initVisitFilesUI();
  }
}
// ==========================================================================
// Doc.PUG CRM Mini — app.js (ЗАГРУЗКА МЕДИА, АВТОДОБАВЛЕНИЕ ПАЦИЕНТОВ И ИСКЛЮЧЕНИЕ КОЛЛИЗИЙ)
// Часть 9
// ==========================================================================

function initVisitFilesUI() {
  // Загрузка файлов на сервер и привязка к визиту
  document.addEventListener("change", async (e) => {
    const input = e.target && e.target.closest ? e.target.closest("#visitFiles") : null;
    if (!input) return;

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

      const res = await fetch("/api/upload", {
        method: "POST",
        credentials: "include",
        body: fd,
      });

      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}

      if (!res.ok) {
        console.error("API /upload HTTP", res.status, text);
        throw new Error(`Upload HTTP ${res.status}`);
      }
      if (!json || json.ok !== true) {
        console.error("API /upload bad json", json, text);
        throw new Error(json?.error || "Upload failed");
      }

      const savedMeta = Array.isArray(json.files) ? json.files : (Array.isArray(json.data) ? json.data : []);
      if (!savedMeta.length) throw new Error("Сервер не повернув файли");

      upsertFilesFromServerMeta(savedMeta);

      const fileIds = savedMeta
        .map((m) => (m?.stored_name ? fileIdFromStored(m.stored_name) : null))
        .filter(Boolean);

      try {
        linkFilesToVisit(visitId, fileIds);
        if (typeof renderVisitFiles === "function") {
          renderVisitFiles(visitId);
        }
      } catch (attachErr) {
        console.warn("⚠️ local attach files failed:", attachErr);
      }
    } catch (err) {
      console.error(err);
      alert("Помилка завантаження: " + (err?.message || err));
      if (state.selectedVisitId && typeof renderVisitFiles === "function") {
        renderVisitFiles(state.selectedVisitId);
      }
    } finally {
      try { e.target.value = ""; } catch {}
    }
  });

  state.visitFilesUiBound = true;
}

// =========================
// VISIT MODAL — Управление окном записи и сохранения
// =========================
$("#visitCancel")?.addEventListener("click", closeVisitModal);
$("#visitClose")?.addEventListener("click", closeVisitModal);
$("#visitModal")?.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeVisitModal();
});

// Сохранение приёма (Создание или Редактирование) с проверкой коллизий
$("#visitSave")?.addEventListener("click", async () => {
  try {
    const modal = $("#visitModal");
    const editVisitId = modal?.dataset?.visitId || "";

    let pet = state.selectedPet;
    const selectedPatientId = ($("#visitPatientSelect")?.value || "").trim();

    if (!pet && selectedPatientId) {
      const patients = window.__visitPatientList || await loadPatientsApi();
      pet = patients.find((p) => String(p.id) === String(selectedPatientId));
    }

    // Автоматическое создание владельца и животного на лету из календаря
    if (!pet && $("#visitNewPatientBox")?.style.display !== "none") {
      const ownerName = ($("#visitNewOwnerName")?.value || "").trim();
      const ownerPhone = ($("#visitNewOwnerPhone")?.value || "").trim();
      const petName = ($("#visitNewPetName")?.value || "").trim();
      const species = ($("#visitNewPetSpecies")?.value || "").trim();
      const breed = ($("#visitNewPetBreed")?.value || "").trim();

      if (!ownerName) return alert("Вкажи власника");
      if (!ownerPhone) return alert("Вкажи телефон власника");
      if (!petName) return alert("Вкажи кличку пацієнта");

      const owner = await createOwner(ownerName, ownerPhone, "");
      if (!owner?.id) return alert("Не вдалося створити власника");

      const createdPet = await createPatientApi({
        owner_id: owner.id,
        name: petName,
        species,
        breed,
      });

      if (!createdPet?.id) return alert("Не вдалося створити пацієнта");

      pet = createdPet;
      state.selectedPet = pet;
      state.selectedPetId = pet.id;

      await loadOwners();
      await loadPatientsApi();
    }

    if (!pet) return alert("Пацієнт не обраний");

    const date = ($("#visitDate")?.value || todayISO()).trim();
    const notePlain = ($("#visitNote")?.value || "").trim();
    const dx = ($("#visitDx")?.value || "").trim();
    const weight = ($("#visitWeight")?.value || "").trim();
    const rx = ($("#visitRx")?.value || "").trim();

    const startTime = ($("#visitStartTime")?.value || "10:00").trim();
    const duration = Number($("#visitDuration")?.value || 60);
    const staffId = ($("#visitStaff")?.value || "").trim();
    const endTime = addMinutesToTime(startTime, duration);

    if (!notePlain && !dx && !rx) return alert("Заповни хоча б щось");
    if (!staffId) return alert("Оберіть ветеринара");
    if (!startTime) return alert("Оберіть час початку");

    const payload = {
      pet_id: pet.id,
      date,
      note: buildVisitNote(dx, notePlain),
      rx,
      weight_kg: weight,
      services: [],
      services_json: [],
      stock: [],
      stock_json: [],
    };

    // =========================
    // РЕЖИМ РЕДАКТИРОВАНИЯ ВИЗИТА
    // =========================
    if (editVisitId) {
      const current = await fetchVisitById(editVisitId);
      if (!current) return alert("Візит не знайдено");

      payload.services = safeVisitArray(current.services, current.services_json);
      payload.services_json = payload.services;
      payload.stock = safeVisitArray(current.stock, current.stock_json);
      payload.stock_json = payload.stock;

      const updated = await updateVisitApi(editVisitId, payload);
      if (!updated) return;

      closeVisitModal();
      if (state.selectedPetId) await renderVisits(state.selectedPetId);
      await openVisit(editVisitId);
      if (state.route === "visits") renderVisitsTab();
      return;
    }

    // =========================
    // РЕЖИМ СОЗДАНИЯ НОВОГО ВИЗИТА
    // =========================
    payload.services = Array.isArray(payload.services) ? payload.services : [];
    payload.services_json = payload.services;
    payload.stock = Array.isArray(payload.stock) ? payload.stock : [];
    payload.stock_json = payload.stock;
    
    const existingEvents = await loadCalendarApi();

    // Проверка коллизий по времени в расписании врача
    const isBusy = existingEvents.some((ev) => {
      if (String(ev.staff_id) !== String(staffId)) return false;
      if (String(ev.event_date) !== String(date)) return false;

      const evStart = String(ev.start_time || "").slice(0, 5);
      const evEnd = String(ev.end_time || "").slice(0, 5);

      return startTime < evEnd && endTime > evStart;
    });

    if (isBusy) {
      alert("Цей час уже зайнятий у цього ветеринара. Оберіть інший час.");
      return;
    }

    const created = await createVisitApi(payload);
    if (!created?.id) return;

    await createCalendarEventApi({
      title: `${pet.name || "Пацієнт"} — ${dx || notePlain || "Візит"}`,
      event_date: date,
      start_time: startTime,
      end_time: endTime,
      staff_id: staffId,
      patient_id: pet.id,
      owner_id: pet.owner_id,
      visit_id: created.id,
      note: notePlain || dx || "",
      status: "planned",
    });

    closeVisitModal();
    if (state.selectedPetId) await renderVisits(state.selectedPetId);
    await openVisit(created.id);
    if (state.route === "visits") renderVisitsTab();
  } catch (e) {
    console.error(e);
    alert("Помилка: " + (e?.message || e));
  }
});

// ==========================================================================
// Doc.PUG CRM Mini — app.js (ВЕТКАРТА, КАСКАДНЫЕ УДАЛЕНИЯ И ЖУРНАЛ СТАЦИОНАРА)
// Часть 9
// ==========================================================================

async function updatePatientApi(petId, payload = {}) {
  try {
    const bodyObj = {
      name: String(payload.name || "").trim(),
      species: String(payload.species || "").trim(),
      breed: String(payload.breed || "").trim(),
      age: String(payload.age || "").trim(),
      weight_kg: String(payload.weight_kg || "").trim(),
      notes: String(payload.notes || "").trim(),
    };

    Object.keys(bodyObj).forEach((k) => {
      if (bodyObj[k] === "") delete bodyObj[k];
    });

    const res = await fetch(`/api/patients/${encodeURIComponent(petId)}`, {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(bodyObj),
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /patients PUT HTTP", res.status, text);
      alert(`Помилка оновлення пацієнта (HTTP ${res.status})`);
      return null;
    }

    if (!json || !json.ok) {
      console.error("API /patients PUT bad json:", json, text);
      alert(json?.error || "Помилка оновлення пацієнта");
      return null;
    }

    return Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
  } catch (e) {
    console.error("updatePatientApi failed:", e);
    alert("Помилка зʼєднання з сервером");
    return null;
  }
}

// =========================
// DELETE — server-first (patients + visits)
// =========================
async function deletePatientApi(petId) {
  try {
    const res = await fetch(`/api/patients/${encodeURIComponent(petId)}`, {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json", ...getOrgHeaders() },
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /patients DELETE HTTP", res.status, text);
      alert(`Помилка сервера при видаленні пацієнта (HTTP ${res.status})`);
      return false;
    }

    if (!json || !json.ok) {
      console.error("API /patients DELETE bad json:", text);
      alert(json?.error || "Помилка видалення пацієнта");
      return false;
    }
    return true;
  } catch (e) {
    console.error("deletePatientApi failed:", e);
    alert("Помилка зʼєднання з сервером");
    return false;
  }
}

async function deletePatientEverywhere(petId) {
  const patients = loadPatients();
  const pet = patients.find((p) => p.id === petId);
  if (!pet) return;

  const name = pet.name || "Без імені";
  const msg = `Видалити пацієнта "${name}"?`;
  if (!confirm(msg)) return;

  const ok = await deletePatientApi(petId);
  if (!ok) return;

  await loadPatientsApi();

  if (state.selectedPetId === petId) {
    state.selectedPetId = null;
    state.selectedPet = null;
    state.selectedVisitId = null;
    setHash("patients");
  }

  if (state.route === "patients") renderPatientsTab();
  if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
  if (state.route === "visits") renderVisitsTab();
}

async function deleteVisitEverywhere(visitId) {
  if (!visitId) return false;
  if (!confirm("Видалити візит назавжди?")) return false;

  const ok = await deleteVisitApi(visitId);
  if (!ok) return false;

  if (state.selectedVisitId === visitId) {
    state.selectedVisitId = null;
    if (state.selectedPetId) openPatient(state.selectedPetId);
    else setHash("visits");
  }

  if (state.route === "visits") renderVisitsTab();
  if (state.selectedPetId) await renderVisits(state.selectedPetId);
  return true;
}

function loadStock() { return LS.get(STOCK_KEY, []); }
function saveStock(items) { LS.set(STOCK_KEY, items); }
function getStockById(id) {
  const sid = String(id || "");
  return loadStock().find((x) => String(x.id) === sid) || null;
}

// =========================
// PATIENT MEDCARD / VET CARD
// =========================
async function loadMedcardApi(patientId) {
  try {
    const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}/medcard`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Cannot load medcard");
    return Array.isArray(json.items) ? json.items : [];
  } catch (e) {
    console.error("loadMedcardApi failed:", e);
    alert("Не вдалося завантажити веткартку: " + (e?.message || e));
    return [];
  }
}

async function createMedcardApi(patientId, payload) {
  try {
    const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}/medcard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });

    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Cannot create medcard entry");
    return json.item || null;
  } catch (e) {
    console.error("createMedcardApi failed:", e);
    alert("Не вдалося створити запис: " + (e?.message || e));
    return null;
  }
}

async function updateMedcardApi(entryId, payload) {
  try {
    const res = await fetch(`/api/medcard/${encodeURIComponent(entryId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });

    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Cannot update medcard entry");
    return json.item || null;
  } catch (e) {
    console.error("updateMedcardApi failed:", e);
    alert("Не вдалося оновити запис: " + (e?.message || e));
    return null;
  }
}

async function deleteMedcardApi(entryId) {
  try {
    const res = await fetch(`/api/medcard/${encodeURIComponent(entryId)}`, {
      method: "DELETE",
    });

    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Cannot delete medcard entry");
    return true;
  } catch (e) {
    console.error("deleteMedcardApi failed:", e);
    alert("Не вдалося видалити запис: " + (e?.message || e));
    return false;
  }
}

function renderMedcardEntryCard(x) {
  const dateLine = [x.entry_date, x.entry_time].filter(Boolean).join(" • ") || "—";

  const vitals = [
    x.temperature ? `🌡 T: ${escapeHtml(x.temperature)}` : "",
    x.weight_kg ? `⚖️ ${escapeHtml(x.weight_kg)} кг` : "",
    x.pulse ? `❤️ ${escapeHtml(x.pulse)}` : "",
  ].filter(Boolean).join(" · ");

  const smallRows = [
    ["Апетит", x.appetite],
    ["Вода", x.water],
    ["Сеча", x.urine],
    ["Кал", x.stool],
    ["Слизові", x.mucosa],
    ["Дихання", x.breathing],
  ].filter(([, v]) => String(v || "").trim());

  return `
    <div class="medEntry">
      <div class="medEntryHead">
        <div>
          <div class="medEntryDate">${escapeHtml(dateLine)}</div>
          ${vitals ? `<div class="medEntryVitals">${vitals}</div>` : ""}
        </div>
        <div class="medEntryActions">
          <button class="iconBtn" title="Редагувати" data-edit-medcard="${escapeHtml(String(x.id))}">✏️</button>
          <button class="iconBtn" title="Видалити" data-del-medcard="${escapeHtml(String(x.id))}">🗑</button>
        </div>
      </div>

      ${
        smallRows.length
          ? `
            <div class="medEntryGrid">
              ${smallRows.map(([label, value]) => `
                <div class="medMini">
                  <div class="medMiniLabel">${escapeHtml(label)}</div>
                  <div class="medMiniValue">${escapeHtml(value || "—")}</div>
                </div>
              `).join("")}
            </div>
          `
          : ""
      }

      ${x.condition ? `<div class="medBlock"><div class="history-label">Стан</div><div>${escapeHtml(x.condition)}</div></div>` : ""}
      ${x.treatment ? `<div class="medBlock"><div class="history-label">Проведено / призначено</div><div>${escapeHtml(x.treatment)}</div></div>` : ""}
      ${x.dynamics ? `<div class="medBlock"><div class="history-label">Динаміка</div><div>${escapeHtml(x.dynamics)}</div></div>` : ""}
      ${x.plan ? `<div class="medBlock"><div class="history-label">План</div><div>${escapeHtml(x.plan)}</div></div>` : ""}
      ${x.note ? `<div class="medBlock"><div class="history-label">Нотатка</div><div>${escapeHtml(x.note)}</div></div>` : ""}
      ${x.doctor ? `<div class="medDoctor">👩‍⚕️ ${escapeHtml(x.doctor)}</div>` : ""}
    </div>
  `;
}

function ensureMedcardModal() {
  let modal = document.getElementById("medcardModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "medcardModal";
  modal.setAttribute("aria-hidden", "true");

  modal.innerHTML = `
    <div class="modal__backdrop" data-close-medcard-modal></div>
    <div class="modal__panel medcardModalPanel" role="dialog" aria-modal="true">
      <div class="modal__head">
        <div>
          <div class="modal__title" id="medcardModalTitle">Нова запись веткартки</div>
          <div class="modal__sub">Стан, лікування, динаміка та план пацієнта</div>
        </div>
        <button class="iconBtn" data-close-medcard-modal type="button">✕</button>
      </div>
      <div class="modal__body medcardModalBody">
        <div class="medFormGrid">
          <label class="field"><div class="label">Дата</div><input class="input" id="medEntryDate" type="date"></label>
          <label class="field"><div class="label">Час</div><input class="input" id="medEntryTime" type="time"></label>
          <label class="field"><div class="label">Вага, кг</div><input class="input" id="medWeight" placeholder="Напр.: 12.4"></label>
          <label class="field"><div class="label">Температура</div><input class="input" id="medTemp" placeholder="Напр.: 39.2"></label>
          <label class="field"><div class="label">Пульс / серце</div><input class="input" id="medPulse" placeholder="Напр.: 120, ритмічний"></label>
          <label class="field"><div class="label">Слизові / ясна</div><input class="input" id="medMucosa" placeholder="Рожеві / бліді / ціаноз"></label>
          <label class="field"><div class="label">Апетит</div><input class="input" id="medAppetite" placeholder="Добрий / знижений / відсутній"></label>
          <label class="field"><div class="label">Вода / спрага</div><input class="input" id="medWater" placeholder="П’є / не п’є / полідипсія"></label>
          <label class="field"><div class="label">Сечовипускання</div><input class="input" id="medUrine" placeholder="Норма / часте / немає"></label>
          <label class="field"><div class="label">Кал</div><input class="input" id="medStool" placeholder="Норма / діарея / запор"></label>
          <label class="field"><div class="label">Дихання</div><input class="input" id="medBreathing" placeholder="Норма / часте / утруднене"></label>
          <label class="field"><div class="label">Лікар</div><input class="input" id="medDoctor" placeholder="ПІБ лікаря"></label>
        </div>
        <label class="field"><div class="label">Загальний стан</div><textarea class="textarea" id="medCondition" rows="4" placeholder="Опис стану пацієнта..."></textarea></label>
        <label class="field"><div class="label">Проведено / призначено</div><textarea class="textarea" id="medTreatment" rows="4" placeholder="Препарати, маніпуляції, інфузії, процедури..."></textarea></label>
        <label class="field"><div class="label">Динаміка</div><textarea class="textarea" id="medDynamics" rows="3" placeholder="Що змінилось після лікування / за період спостереження..."></textarea></label>
        <label class="field"><div class="label">План / контроль</div><textarea class="textarea" id="medPlan" rows="3" placeholder="Контроль, повторний огляд, аналізи, зміна терапії..."></textarea></label>
        <label class="field"><div class="label">Додаткова нотатка</div><textarea class="textarea" id="medNote" rows="3" placeholder="Будь-які додаткові деталі..."></textarea></label>
      </div>
      <div class="modal__foot">
        <button class="ghost" data-close-medcard-modal type="button">Скасувати</button>
        <button class="primary" id="medcardSaveBtn" type="button">Зберегти</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-medcard-modal]")) {
      closeMedcardModal();
    }
  });
  return modal;
}

// ==========================================================================
// Doc.PUG CRM Mini — app.js (ИНСТРУМЕНТЫ СТАЦИОНАРА, БУТСТРАП И ЖИВОЙ ПОИСК)
// Финальная часть
// ==========================================================================

function medcardFormSet(existing = {}) {
  const today = typeof todayISO === "function" ? todayISO() : new Date().toISOString().slice(0, 10);

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || "";
  };

  set("medEntryDate", existing.entry_date || today);
  set("medEntryTime", existing.entry_time || "");
  set("medWeight", existing.weight_kg || "");
  set("medTemp", existing.temperature || "");
  set("medPulse", existing.pulse || "");
  set("medMucosa", existing.mucosa || "");
  set("medAppetite", existing.appetite || "");
  set("medWater", existing.water || "");
  set("medUrine", existing.urine || "");
  set("medStool", existing.stool || "");
  set("medBreathing", existing.breathing || "");
  set("medDoctor", existing.doctor || "");
  set("medCondition", existing.condition || "");
  set("medTreatment", existing.treatment || "");
  set("medDynamics", existing.dynamics || "");
  set("medPlan", existing.plan || "");
  set("medNote", existing.note || "");
}

function medcardFormRead() {
  const val = (id) => String(document.getElementById(id)?.value || "").trim();
  const entry_date = val("medEntryDate");
  if (!entry_date) {
    alert("Вкажи дату запису");
    return null;
  }

  return {
    entry_date,
    entry_time: val("medEntryTime"),
    weight_kg: val("medWeight"),
    temperature: val("medTemp"),
    pulse: val("medPulse"),
    mucosa: val("medMucosa"),
    appetite: val("medAppetite"),
    water: val("medWater"),
    urine: val("medUrine"),
    stool: val("medStool"),
    breathing: val("medBreathing"),
    condition: val("medCondition"),
    treatment: val("medTreatment"),
    dynamics: val("medDynamics"),
    plan: val("medPlan"),
    doctor: val("medDoctor"),
    note: val("medNote"),
  };
}

function closeMedcardModal() {
  const modal = document.getElementById("medcardModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  delete modal.dataset.entryId;
  delete modal.dataset.patientId;
}

// ==========================================
// ВЕТЕРИНАРНАЯ КАРТА — ЧИСТЫЙ РЕНДЕР ШАБЛОНОВ
// ==========================================
async function renderMedcardTab(pet) {
  const box = $("#patientTabContent");
  if (!box || !pet) return;

  // Очищаем старую верстку и подготавливаем каркас таба
  box.innerHTML = "";

  const container = document.createElement("div");
  container.className = "patientInfoBox";

  const rowHead = document.createElement("div");
  rowHead.className = "row";
  rowHead.style.cssText = "align-items: flex-start; gap: 12px; margin-bottom: 20px;";
  rowHead.innerHTML = `
    <div>
      <h2 style="margin:0;">Ветеринарна картка</h2>
      <div class="hint">Медичний щоденник пацієнта: стан, температура, лікування, динаміка, план.</div>
    </div>
    <button class="primary" id="btnAddMedcardEntry" type="button">+ Запис</button>
  `;
  container.appendChild(rowHead);

  const listElement = document.createElement("div");
  listElement.id = "medcardList";
  listElement.className = "medcardList";
  container.appendChild(listElement);
  box.appendChild(container);

  // Тянем записи из API
  const items = await loadMedcardApi(pet.id);

  if (!items.length) {
    listElement.innerHTML = `<div class="hint">Поки записів немає. Натисніть “+ Запис”.</div>`;
  } else {
    const mainTemplate = document.getElementById("medcard-entry-template");
    const miniTemplate = document.getElementById("medcard-mini-row-template");

    if (!mainTemplate || !miniTemplate) {
      console.error("Помилка: Шаблони medcard не знайдено в index.html");
      return;
    }

    items.forEach((x) => {
      const clone = mainTemplate.content.cloneNode(true);

      // 1. Наполнение базовой инфы
      const dateLine = [x.entry_date, x.entry_time].filter(Boolean).join(" • ") || "—";
      clone.querySelector(".med-card-date").textContent = dateLine;

      // 2. Наполнение витальных параметров (Строка: Температура, Вес, Пульс)
      const vitalsArr = [
        x.temperature ? `🌡 T: ${x.temperature}` : "",
        x.weight_kg ? `⚖️ ${x.weight_kg} кг` : "",
        x.pulse ? `❤️ ${x.pulse}` : "",
      ].filter(Boolean);
      clone.querySelector(".med-card-vitals").textContent = vitalsArr.join(" · ") || "Параметри не вказані";

      // 3. Динамическая сетка мини-параметров (Аппетит, Слизистые и т.д.)
      const grid = clone.querySelector(".med-card-vitals-grid");
      const smallRows = [
        ["Апетит", x.appetite],
        ["Вода", x.water],
        ["Сеча", x.urine],
        ["Кал", x.stool],
        ["Слизові", x.mucosa],
        ["Дихання", x.breathing],
      ].filter(([, val]) => String(val || "").trim());

      if (smallRows.length === 0) {
        grid.style.display = "none";
      } else {
        smallRows.forEach(([label, value]) => {
          const cellClone = miniTemplate.content.cloneNode(true);
          cellClone.querySelector(".med-mini-label").textContent = label;
          cellClone.querySelector(".med-mini-value").textContent = value || "—";
          grid.appendChild(cellClone);
        });
      }

      // 4. Текстовые медицинские блоки (Скрываем блоки, если они пустые)
      const fillTextBlock = (selector, dataVal) => {
        const block = clone.querySelector(selector);
        if (dataVal && dataVal.trim()) {
          block.querySelector(".m-text").textContent = dataVal;
        } else {
          block.style.display = "none";
        }
      };

      fillTextBlock(".m-block-condition", x.condition);
      fillTextBlock(".m-block-treatment", x.treatment);
      fillTextBlock(".m-block-dynamics", x.dynamics);
      fillTextBlock(".m-block-plan", x.plan);
      fillTextBlock(".m-block-note", x.note);

      // 5. Имя врача
      const docEl = clone.querySelector(".med-card-doctor");
      if (x.doctor && x.doctor.trim()) {
        docEl.textContent = `👩‍⚕️ ${x.doctor}`;
      } else {
        docEl.style.display = "none";
      }

      // 6. Айдишники к кнопкам для обработчиков редактирования/удаления
      clone.querySelector(".m-edit-btn").dataset.editMedcard = String(x.id);
      clone.querySelector(".m-del-btn").dataset.delMedcard = String(x.id);

      listElement.appendChild(clone);
    });
  }

  // ==========================================
  // ЖЕЛЕЗНЫЕ ОБРАБОТЧИКИ (Остаются без изменений)
  // ==========================================
  $("#btnAddMedcardEntry")?.addEventListener("click", () => {
    const modal = ensureMedcardModal();
    modal.dataset.patientId = String(pet.id);
    delete modal.dataset.entryId;

    const title = document.getElementById("medcardModalTitle");
    if (title) title.textContent = "Нова запись веткартки";

    medcardFormSet({});
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");

    const saveBtn = document.getElementById("medcardSaveBtn");
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const payload = medcardFormRead();
        if (!payload) return;

        const created = await createMedcardApi(pet.id, payload);
        if (!created) return;

        closeMedcardModal();
        await renderMedcardTab(pet);
      };
    }
  });

  listElement.onclick = async (e) => {
    const del = e.target.closest("[data-del-medcard]");
    if (del) {
      const id = del.dataset.delMedcard; if (!id) return;
      if (!confirm("Видалити запис веткартки?")) return;

      const ok = await deleteMedcardApi(id);
      if (ok) await renderMedcardTab(pet);
      return;
    }

    const edit = e.target.closest("[data-edit-medcard]");
    if (edit) {
      const id = edit.dataset.editMedcard; if (!id) return;
      const current = items.find((x) => String(x.id) === String(id));
      if (!current) return alert("Запис не знайдено");

      const modal = ensureMedcardModal();
      modal.dataset.patientId = String(pet.id);
      modal.dataset.entryId = String(id);

      const title = document.getElementById("medcardModalTitle");
      if (title) title.textContent = "Редагування запису веткартки";

      medcardFormSet(current);
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");

      const saveBtn = document.getElementById("medcardSaveBtn");
      if (saveBtn) {
        saveBtn.onclick = async () => {
          const payload = medcardFormRead();
          if (!payload) return;

          const updated = await updateMedcardApi(id, payload);
          if (!updated) return;

          closeMedcardModal();
          await renderMedcardTab(pet);
        };
      }
    }
  };
}

// ==========================================
// НАСТРОЙКИ СИСТЕМЫ — ЛОГИКА И ХЕНДЛЕРЫ
// ==========================================
// Функция инициализации настроек: темы, язык
function initSettingsUI() {
  const page = document.querySelector('.page[data-page="settings"]');
  if (!page) return;

  if (page.dataset.boundSettings === "1") return;
  page.dataset.boundSettings = "1";

  // Слушатель тем
  page.querySelectorAll("[data-theme-set]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.themeSet;
      // Применяем тему
      document.body.dataset.theme = theme;
      // Сохраняем в память
      LS.set("docpug_clinic_theme", theme);
      
      // Обновляем визуал кнопок
      page.querySelectorAll("[data-theme-set]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  // Слушатель языка
  const langSelect = document.getElementById("systemLanguageSelect");
  if (langSelect) {
    langSelect.addEventListener("change", (e) => {
      LS.set("docpug_clinic_lang", e.target.value);
    });
    langSelect.value = LS.get("docpug_clinic_lang", "uk");
  }
}

// Функция для применения темы при загрузке страницы
function bootstrapClinicTheme() {
  const savedTheme = LS.get("docpug_clinic_theme", "purple");
  document.body.dataset.theme = savedTheme;
  
  const activeBtn = document.querySelector(`[data-theme-set="${savedTheme}"]`);
  if (activeBtn) {
    document.querySelectorAll("[data-theme-set]").forEach((b) => b.classList.remove("active"));
    activeBtn.classList.add("active");
  }
}

// =========================
// ГЛАВНЫЙ ИНИЦИАЛИЗАТОР ПРИЛОЖЕНИЯ (BOOTSTRAP)
// =========================
async function init() {
  // === ПРЕМИУМ ЛОГИН КЛИНИКИ ===
  const authForm = document.getElementById("authForm");
  const authOverlay = document.getElementById("authOverlay");
  
  // Проверяем, входил ли пользователь ранее в этой сессии
  const cachedOrg = sessionStorage.getItem("pug_active_org_id");
  if (cachedOrg) {
    if (authOverlay) authOverlay.style.display = "none";
  }

  if (authForm) {
    authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      
      const username = document.getElementById("authUsername")?.value;
      const password = document.getElementById("authPassword")?.value;
      const errorBox = document.getElementById("authError");
      const btnSubmit = document.getElementById("btnAuthSubmit");

      if (errorBox) errorBox.style.display = "none";
      if (btnSubmit) btnSubmit.textContent = "Перевірка доступу...";

      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        
        const json = await res.get_json ? await res.get_json() : await res.json();

        if (!res.ok || !json.ok) {
          if (errorBox) {
            errorBox.textContent = json.error || "Помилка авторизації";
            errorBox.style.display = "block";
          }
          if (btnSubmit) btnSubmit.textContent = "Увійти у систему →";
          return;
        }

        // Сохраняем активный org_id в сессию браузера
        sessionStorage.setItem("pug_active_org_id", json.data.org_id);
        console.log(`Успешный вход в клинику: ${json.data.clinic_name}`);

        // Прячем красивый оверлей
        if (authOverlay) {
          authOverlay.style.transition = "all 0.4s ease";
          authOverlay.style.opacity = "0";
          setTimeout(() => authOverlay.style.display = "none", 400);
        }

        // Принудительно перезагружаем данные CRM под эту конкретную клинику
        await loadOwners();
        await loadPatientsApi();
        await loadServicesApi();

      } catch (err) {
        if (errorBox) {
          errorBox.textContent = "Не вдалося з'єднатися з сервером.";
          errorBox.style.display = "block";
        }
        if (btnSubmit) btnSubmit.textContent = "Увійти у систему →";
      }
    });
  }

  if (typeof initTabs === "function") initTabs();
  if (typeof seedIfEmpty === "function") seedIfEmpty();

  if (typeof migrateLegacyVisitFilesIfNeeded === "function") {
    await migrateLegacyVisitFilesIfNeeded();
  }

  if (typeof initOwnersUI === "function") initOwnersUI();
  if (typeof initOwnerUI === "function") initOwnerUI();
  if (typeof initPatientUI === "function") initPatientUI();
  if (typeof initVisitUI === "function") initVisitUI();
  if (typeof initDischargeModalUI === "function") initDischargeModalUI();
  
  // ВСТАВЛЯЕМ ВЫЗОВ ИНИЦИАЛИЗАЦИИ НАСТРОЕК ЗДЕСЬ
  if (typeof initSettingsUI === "function") initSettingsUI();

  // Применяем сохраненную тему
  if (typeof bootstrapClinicTheme === "function") bootstrapClinicTheme();

  $("#btnReload")?.addEventListener("click", async () => {
    await loadMe();
    await loadOwners();
    await loadPatientsApi();
    await loadServicesApi();
  });

  // Глобальный живой поиск
 // Глобальный живой поиск
  $("#globalSearch")?.addEventListener("input", () => {
    if (state.route === "owners") renderOwners();
    if (state.route === "patients") renderPatientsTab();
    if (state.route === "visits") renderVisitsTab();
  });

  // Загружаем профиль и динамическую тему клиники с сервера
  try {
    const response = await fetch("/api/me");
    const data = await response.json();
    
    if (data && data.me) {
      // Ставим имя клиники в заголовок, если есть такой элемент
      const clinicTitleEl = document.getElementById("clinicNameTitle") || document.querySelector(".clinic-title");
      if (clinicTitleEl && data.me.clinic_name) {
        clinicTitleEl.textContent = data.me.clinic_name;
      }

      // 🌟 МАГИЯ ПЕРЕКРАСКИ: если сервер вернул тему клиники, применяем её
      if (data.me.theme) {
        document.body.dataset.theme = data.me.theme;
        LS.set("docpug_clinic_theme", data.me.theme);
        console.log(`[Bootstrap] Установлена тема клиники: ${data.me.theme}`);
      }
    }
  } catch (err) {
    console.warn("Не удалось загрузить динамическую тему с сервера, катимся на локальной:", err);
    if (typeof bootstrapClinicTheme === "function") bootstrapClinicTheme();
  }

  await loadOwners();
  await loadPatientsApi();
  await loadServicesApi();
}


// Корректировка вьюпорта под мобильные платформы iOS / Telegram WebApp
function setVH() {
  document.documentElement.style.setProperty("--vh", `${window.innerHeight * 0.01}px`);
}
setVH();
window.addEventListener("resize", setVH);

// Старт CRM
init();

// =========================
// VISIT FILES — Отрисовка списка файлов приёма
// =========================
function renderVisitFiles(visitId) {
  const wrap = document.getElementById("visitFilesList");
  if (!wrap) return;

  const allFiles = LS.get(FILES_KEY, []);
  const byId = new Map((Array.isArray(allFiles) ? allFiles : []).map((f) => [String(f.id), f]));
  const ids = getFileIdsForVisit(visitId);

  if (!ids.length) {
    wrap.innerHTML = `<div class="hint">Поки файлів немає.</div>`;
    return;
  }

  wrap.innerHTML = ids
    .map((id) => {
      const f = byId.get(String(id));
      if (!f) return "";
      const url = f.url || (f.stored_name ? `/uploads/${f.stored_name}` : "#");
      const name = f.name || f.stored_name || "file";
      return `
        <div class="fileRow">
          <div class="fileMain">
            <div class="fileName">${escapeHtml(name)}</div>
            <div class="fileMeta">${escapeHtml(f.type || "")} ${f.size ? "• " + escapeHtml(String(f.size)) + " bytes" : ""}</div>
          </div>
          <div class="fileActions">
            <a class="miniBtn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Відкрити</a>
            <button type="button" class="miniBtn danger" data-detach-file="${escapeHtml(String(id))}">Відвʼязати</button>
          </div>
        </div>
      `;
    })
    .join("");

  wrap.onclick = (e) => {
    const btn = e.target.closest("[data-detach-file]");
    if (!btn) return;
    e.preventDefault();
    const fid = btn.dataset.detachFile;
    if (!fid) return;
    detachFileFromVisit(visitId, fid);
    renderVisitFiles(visitId);
  };
}

async function updateStaffApi(staffId, payload) {
  try {
    const res = await fetch(`/api/staff/${encodeURIComponent(staffId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const json = await res.json();
    if (!json.ok) { alert(json.error || "Помилка оновлення ветеринара"); return null; }
    return json.data || null;
  } catch (e) {
    console.error(e); alert("Помилка оновлення ветеринара"); return null;
  }
}

async function renderStaffSpecsBox(selectedIds = []) {
  const box = $("#staffSpecsBox");
  if (!box) return;

  const specs = await loadSpecializationsApi();
  const selected = new Set((selectedIds || []).map(String));

  box.innerHTML = specs.length
    ? specs.map((s) => `
      <label class="staffSpecCheck">
        <input type="checkbox" data-staff-spec value="${escapeHtml(String(s.id))}" ${selected.has(String(s.id)) ? "checked" : ""}>
        <span class="staffSpecDot" style="background:${escapeHtml(s.color || "#7C5CFF")}"></span>
        <span>${escapeHtml(s.name || "Напрям")}</span>
      </label>
    `).join("")
    : `<div class="hint">Спочатку додай напрями клініки вище.</div>`;
    
    
}

async function openEditStaffModal(staffRow) {
  $("#staffId").value = staffRow.id || "";
  $("#staffName").value = staffRow.name || "";
  $("#staffRole").value = staffRow.role || "vet";
  $("#staffSpecialization").value = staffRow.specialization || "";
  $("#staffPhone").value = staffRow.phone || "";
  $("#staffShiftRate").value = staffRow.shift_rate || 0;
  $("#staffPercentRate").value = staffRow.percent_rate || 0;
  $("#staffColor").value = staffRow.color || "#7C5CFF";
  $("#staffNote").value = staffRow.note || "";

  await renderStaffSpecsBox(staffRow.specialization_ids || []);
  $("#staffDrawer").classList.add("open");
  $("#staffDrawer").setAttribute("aria-hidden", "false");
}

$$("[data-close-staff]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("#staffDrawer")?.classList.remove("open");
    $("#staffDrawer")?.setAttribute("aria-hidden", "true");
  });
});

$("#staffSave")?.addEventListener("click", async () => {
  const staffId = ($("#staffId").value || "").trim();
  const specializationIds = $$("[data-staff-spec]:checked").map((el) => el.value);

  const payload = {
    name: $("#staffName").value.trim(),
    role: $("#staffRole").value,
    specialization: $("#staffSpecialization").value.trim(),
    specialization_ids: specializationIds,
    phone: $("#staffPhone").value.trim(),
    shift_rate: Number($("#staffShiftRate").value || 0),
    percent_rate: Number($("#staffPercentRate").value || 0),
    color: $("#staffColor").value,
    note: $("#staffNote").value.trim(),
  };

  if (!payload.name) { alert("Вкажи ПІБ співробітника"); return; }
  let saved = staffId ? await updateStaffApi(staffId, payload) : await createStaffApi(payload);
  if (!saved) return;

  $("#staffDrawer")?.classList.remove("open");
  $("#staffDrawer")?.setAttribute("aria-hidden", "true");
  await renderCalendarTab();
});

async function openVisitFromCalendar(hour, staffId) {
  const modal = $("#visitModal");
  if (!modal) return;

  delete modal.dataset.visitId;
  const patients = await loadPatientsApi();

  if (!Array.isArray(state.owners) || !state.owners.length) { await loadOwners(); }
  const ownersMap = new Map((state.owners || []).map((o) => [String(o.id), o]));

  window.__visitPatientList = patients.map((p) => {
    const owner = ownersMap.get(String(p.owner_id));
    return {
      ...p,
      owner_name: owner?.name || p.owner_name || p.owner || "",
      owner_phone: owner?.phone || p.owner_phone || p.phone || "",
    };
  });

 $("#visitPatientSelect") && ($("#visitPatientSelect").value = "");
$("#visitPatientSearch") && ($("#visitPatientSearch").value = "");
$("#visitPatientResults") && ($("#visitPatientResults").innerHTML = "");

const visitPatientBlock = $("#visitPatientBlock");
if (visitPatientBlock) visitPatientBlock.style.display = "block";

$("#visitDate") && ($("#visitDate").value = window.__calendarDate || todayISO());
$("#visitStartTime") && ($("#visitStartTime").value = hour || "10:00");
$("#visitDuration") && ($("#visitDuration").value = "60");

  const staff = await loadStaffApi();
  const staffSelect = $("#visitStaff");
  if (staffSelect) {
    staffSelect.innerHTML = `
      <option value="">Оберіть ветеринара</option>
      ${staff.map((doc) => `<option value="${escapeHtml(String(doc.id))}">${escapeHtml(doc.name || "Працівник")}</option>`).join("")}
    `;
    staffSelect.value = String(staffId || "");
  }

  $("#visitNote") && ($("#visitNote").value = "");
$("#visitDx") && ($("#visitDx").value = "");
$("#visitWeight") && ($("#visitWeight").value = "");
$("#visitRx") && ($("#visitRx").value = "");

const visitNewPatientBox = $("#visitNewPatientBox");
if (visitNewPatientBox) visitNewPatientBox.style.display = "none";

  const btnCreatePatientFromVisit = $("#btnCreatePatientFromVisit");
  if (btnCreatePatientFromVisit) {
    btnCreatePatientFromVisit.onclick = () => {
      const box = $("#visitNewPatientBox"); if (!box) return;
      box.style.display = box.style.display === "none" ? "block" : "none";
    };
  }

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

$("#visitPatientSearch")?.addEventListener("input", () => {
  const q = ($("#visitPatientSearch").value || "").toLowerCase().trim();
  const box = $("#visitPatientResults");
  const hidden = $("#visitPatientSelect");

  if (!box || !hidden) return;
  hidden.value = "";
  if (!q) { box.innerHTML = ""; return; }

  const patients = window.__visitPatientList || [];
  const found = patients
    .filter((p) => {
      const text = [p.name, p.owner_name, p.owner_phone, p.phone, p.species, p.breed].join(" ").toLowerCase();
      return text.includes(q);
    })
    .slice(0, 12);

  box.innerHTML = found.length
    ? found.map((p) => `
      <div class="patientSearchItem" data-select-visit-patient="${escapeHtml(String(p.id))}">
        <strong>${escapeHtml(p.name || "Пацієнт")}</strong>
        <span>${escapeHtml(p.owner_name || "Власник не вказаний")} · ${escapeHtml(p.owner_phone || p.phone || "телефон не вказаний")}</span>
      </div>
    `).join("")
    : `<div class="hint">Нічого не знайдено</div>`;

  $$("[data-select-visit-patient]").forEach((item) => {
    item.addEventListener("click", () => {
      const id = item.dataset.selectVisitPatient;
      const patient = patients.find((p) => String(p.id) === String(id));

      hidden.value = id;
      $("#visitPatientSearch").value = patient ? `${patient.name || "Пацієнт"} · ${patient.owner_name || ""}` : id;
      box.innerHTML = "";
    });
  });
});
// Эта функция считает всё для любого ID (владельца или пациента)
function getFinancialStats(entityId, type = 'owner') {
  const allVisits = Array.isArray(state.visits) ? state.visits : [];
  
  let filteredVisits = [];
  if (type === 'owner') {
    // Находим всех питомцев владельца и считаем их визиты
    const pets = (state.patients || []).filter(p => String(p.owner_id) === String(entityId));
    const petIds = new Set(pets.map(p => String(p.id)));
    filteredVisits = allVisits.filter(v => petIds.has(String(v.pet_id)));
  } else {
    // Просто считаем для конкретного пациента
    filteredVisits = allVisits.filter(v => String(v.pet_id) === String(entityId));
  }

  return {
    count: filteredVisits.length,
    total: filteredVisits.reduce((sum, v) => sum + (calcServicesTotal(v) || 0) + (calcStockTotal(v) || 0), 0),
    lastDate: filteredVisits.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0]?.date || "—"
  };
}
function initSettingsUI() {
  const page = document.querySelector('.page[data-page="settings"]');
  if (!page) return;

  // Слушатель тем
  page.querySelectorAll("[data-theme-set]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.themeSet;
      document.body.dataset.theme = theme;
      LS.set("docpug_clinic_theme", theme);
      
      page.querySelectorAll("[data-theme-set]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  // Слушатель языка
  const langSelect = document.getElementById("systemLanguageSelect");
  if (langSelect) {
    langSelect.addEventListener("change", (e) => {
      LS.set("docpug_clinic_lang", e.target.value);
      console.log("Language changed to:", e.target.value);
      // Тут в будущем будет вызов функции перевода интерфейса i18n
    });
    // Устанавливаем сохраненный язык
    langSelect.value = LS.get("docpug_clinic_lang", "uk");
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btnAddStaff');
  if (btn) {
    btn.addEventListener('click', openCreateStaffModal);
  }
});

// Глобальный перехватчик клика для нашей премиальной шторки
document.addEventListener('click', function(event) {
    // Ищем клик именно по кнопке btnAddStaff или элементам внутри неё
    if (event.target && (event.target.id === 'btnAddStaff' || event.target.closest('#btnAddStaff'))) {
        event.preventDefault();
        console.log("🚀 PUGCRM: Клик по '+ Додати ветеринара' успешно пойман!");
        
        const drawer = document.getElementById('staffDrawer');
        if (drawer) {
            drawer.classList.add('open');
            console.log("💎 PUGCRM: Шторка staffDrawer успешно открыта!");
        } else {
            console.error("❌ Ошибка: Элемент шторки #staffDrawer не найден в HTML!");
        }
    }
});

async function loadStaffScheduleRangeApi(from, to) {
  try {
    const res = await fetch(
      `${API_BASE}/staff-schedule-range?from=${from}&to=${to}`,
      {
        headers: authHeaders()
      }
    );

    const json = await res.json();

    if (!json.ok) throw new Error(json.error);

    return json.data || [];
  } catch (e) {
    console.error(e);
    return [];
  }
}
