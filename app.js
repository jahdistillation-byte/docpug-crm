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

// =========================
// FILES helpers (LOCAL links)
// =========================

// если нет такой функции — добавь (чтобы не было ReferenceError)
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

// =========================
// FILE HELPERS (needed for uploads)
// =========================
function fileIdFromStored(storedName) {
  if (!storedName) return null;
  return "file_" + String(storedName).replace(/[^a-zA-Z0-9]/g, "_");
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

// =========================
// Legacy migration (safe stub)
// Some builds call migrateLegacyVisitFilesIfNeeded() during init.
// If legacy file-linking is no longer used, this keeps the app from crashing.
// =========================
async function migrateLegacyVisitFilesIfNeeded() {
  return; // no-op
}

// ✅ Services registry
const SERVICES_KEY = "docpug_services_v1";
const SERVICES_CAT_KEY = "docpug_services_cat_v1"; // { [id]: "Категорія" }

function normalizeServiceRow(s) {
  const cat =
    (s?.cat ?? s?.category ?? s?.section ?? s?.group ?? s?.type ?? "").toString().trim();

  return {
    ...s,
    cat: cat || "Інше",
  };
}

// ✅ Stock registry (пока просто ключ, UI добавим дальше)
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

  // ✅ ПОИСК В ВИЗИТЕ (добавь)
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

  // services_json: array OR string
  const sj = visit.services_json;
  let sjArr = null;
  if (Array.isArray(sj)) sjArr = sj;
  else if (typeof sj === "string") {
    try { sjArr = JSON.parse(sj); } catch { sjArr = null; }
  }

  // IMPORTANT:
  // Server may always return `services: []` even when services_json has data.
  // So we refresh services from services_json when services is missing OR empty.
  const hasServicesArr = Array.isArray(visit.services);
  const hasSjArr = Array.isArray(sjArr);
  if (!hasServicesArr || (visit.services.length === 0 && hasSjArr && sjArr.length > 0)) {
    visit.services = hasSjArr ? sjArr : [];
  }

  // stock_json: array OR string
  const stj = visit.stock_json;
  let stArr = null;
  if (Array.isArray(stj)) stArr = stj;
  else if (typeof stj === "string") {
    try { stArr = JSON.parse(stj); } catch { stArr = null; }
  }

  // Same issue as services: server can return `stock: []` even when stock_json has data.
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

  // ✅ то что уже есть в кеше
  const prev = state.visitsById.get(vid) || null;

  try {
    const res = await fetch(`/api/visits?id=${encodeURIComponent(vid)}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok || !json || !json.ok) return prev; // ✅ тихо возвращаем кеш

    const arr = Array.isArray(json.data) ? json.data : (json.data ? [json.data] : []);
    let v = arr[0] || null;

    v = normalizeVisitFromServer(v);

    // ✅ если сервер прислал пусто, но в кеше было — НЕ теряем
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
  return b; // если диагноза нет — оставляем только жалобы
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
  "services",
  "calendar",
  "stock",
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
  const pageExists = $(`.page[data-page="${r}"]`);
  const finalRoute = pageExists ? r : "owners";

  state.route = finalRoute;

  $$(".page").forEach((p) => {
    p.classList.toggle("active", p.dataset.page === finalRoute);
  });

  if (TAB_ROUTES.has(finalRoute)) {
    $$("#tabs .tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.route === finalRoute);
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
    if (route === "services") renderServicesTab();
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
// Идея: локалка = кеш/офлайн, сервер = истина.
// Поэтому демо-данные добавляем ТОЛЬКО если мы реально офлайн (file://) И пусто.
function seedIfEmpty() {
  // базовые ключи всегда должны существовать
  if (!LS.get(VISITS_KEY, null)) LS.set(VISITS_KEY, []);
  if (!LS.get(FILES_KEY, null)) LS.set(FILES_KEY, []);
  if (!LS.get(VISIT_FILES_KEY, null)) LS.set(VISIT_FILES_KEY, []);
  if (!LS.get(DISCHARGES_KEY, null)) LS.set(DISCHARGES_KEY, {});

  // seed stock registry (if absent)
  if (!LS.get(STOCK_KEY, null)) {
    LS.set(STOCK_KEY, [
      { id: "stk_meloxivet", name: "Мелоксивет", price: 70, unit: "шт", qty: 10, active: true },
    ]);
  }

  // seed services registry (if absent)
    if (!LS.get(SERVICES_KEY, null)) {
    LS.set(SERVICES_KEY, [
      { id: "svc_exam",       name: "Огляд",            price: 500,  active: true, cat: "Терапія" },
      { id: "svc_trip",       name: "Виїзд",            price: 1500, active: true, cat: "Виїзд" },
      { id: "svc_vax",        name: "Вакцинація",       price: 800,  active: true, cat: "Терапія" },

      { id: "svc_consult",    name: "Консультація",     price: 500,  active: true, cat: "Терапія" },
      { id: "svc_cat_castr",  name: "Кастрація кота",   price: 2500, active: true, cat: "Хірургія" },
      { id: "svc_dog_castr",  name: "Кастрація пса",    price: 3500, active: true, cat: "Хірургія" },

      // приклад аналізів (можеш прибрати)
      // { id: "svc_cbc",     name: "ЗАК",              price: 450,  active: true, cat: "Аналізи" },
    ]);
  }

  // Демо-данные владельца/пациента — только если офлайн (file://) и пусто
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
    // если владельцы есть, но пациентов нет — ничего не выдумываем
    if (!Array.isArray(patients)) LS.set(PATIENTS_KEY, []);
  }
}

// ===== API: Owners =====
async function loadOwners() {
  try {
    const res = await fetch("/api/owners", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /owners HTTP", res.status, text);
      alert(`Помилка завантаження власників (HTTP ${res.status})`);
      state.owners = [];
      // кеш не трогаем
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

    const arr = Array.isArray(json.data)
      ? json.data
      : (json.data ? [json.data] : []);


    state.owners = arr;


    // ✅ кеш в localStorage (чтобы ownerById работал даже без state.owners)
    LS.set(OWNERS_KEY, arr);

    renderOwners();

    // если открыт владелец — обновим страницу владельца
    if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);

    return arr;
  } catch (e) {
    console.error("loadOwners failed:", e);
    alert("Помилка завантаження власників (network)");
    // не убиваем кеш, просто UI показываем что есть
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
      headers: { Accept: "application/json" },
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /patients HTTP", res.status, text);
      alert(`Помилка завантаження пацієнтів (HTTP ${res.status})`);
      state.patients = [];
      // кеш не трогаем
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

    const arr = Array.isArray(json.data)
      ? json.data
      : (json.data ? [json.data] : []);

    state.patients = arr;

    // ✅ кеш в localStorage
    savePatients(arr);

    // ✅ UI
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
// Services API (server-first)
// =========================
async function loadServicesApi() {
  try {
    const res = await fetch("/api/services", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    // если сервер не ок — берём кеш
    if (!res.ok || !json || !json.ok) {
      console.warn("loadServicesApi failed:", res.status, text);
      const cached = LS.get(SERVICES_KEY, []);
      state.services = Array.isArray(cached) ? cached : [];
      return state.services;
    }

    const arr = Array.isArray(json.data)
      ? json.data
      : (json.data ? [json.data] : []);

    // ✅ 1) читаем карту категорий
    const catMap = loadServicesCatMap();

    // ✅ 2) наклеиваем cat на то, что пришло с сервера
    const merged = (Array.isArray(arr) ? arr : []).map((s) => {
      const id = String(s?.id || "");
      const savedCat = catMap[id];

      const rawCat =
        (s?.cat ?? s?.category ?? s?.section ?? s?.group ?? s?.type ?? savedCat ?? "");

      const cat = String(rawCat || "").trim() || "Інше";

      return { ...s, cat };
    });

    state.services = merged;
    LS.set(SERVICES_KEY, merged); // кэш для оффлайна
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
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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
      headers: { Accept: "application/json" },
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

    // убрать пустые поля
    Object.keys(bodyObj).forEach((k) => {
      if (bodyObj[k] === "" || bodyObj[k] == null) delete bodyObj[k];
    });

    const res = await fetch("/api/patients", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
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

    // сервер может вернуть объект или массив — нормализуем
    const created = Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
    if (!created) return null;

    // ✅ обновим state + кеш сразу, чтобы UI был моментально
    const next = [created, ...(Array.isArray(state.patients) ? state.patients : [])]
      // на всякий случай уберем дубль по id
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

    // =========================
// Owners API (robust + include)
// =========================
async function createOwner(name, phone = "", note = "") {
  try {
    const payload = {
      name: String(name || "").trim(),
      phone: String(phone || "").trim(),
      note: String(note || "").trim(),
    };
    // убрать пустые
    Object.keys(payload).forEach((k) => {
      if (payload[k] === "") delete payload[k];
    });

    const res = await fetch("/api/owners", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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
      headers: { Accept: "application/json" },
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

// =========================
// Visits API (robust + normalize + cache)
// =========================
async function loadVisitsApi(params = {}) {
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch("/api/visits" + (qs ? `?${qs}` : ""), {
      credentials: "include",
      headers: { Accept: "application/json" },
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

    const arr = Array.isArray(json.data)
      ? json.data
      : (json.data ? [json.data] : []);

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
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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
  credentials: "include", // ✅ ВАЖНО
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
  },
  body: JSON.stringify(payload || {}),
});

    // ✅ читаем как текст (чтобы не падать на HTML/405)
    const text = await res.text();

    // ✅ пробуем распарсить JSON
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }

    // ✅ если сервер вернул не-200/ok — покажем нормальную ошибку
    if (!res.ok) {
      console.error("updateVisitApi HTTP error:", res.status, text);
      alert(`API error ${res.status}`);
      return null;
    }

    // ✅ если JSON нет или формат не тот
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

    // --- НОРМАЛИЗАЦИЯ ---
    const raw = Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
    let updated = normalizeVisitFromServer(raw);

    // если сервер вернул вообще пусто — не ломаем кеш
    if (!updated || updated.id == null) {
      console.warn("updateVisitApi: updated visit has no id:", updated, json);
      return updated || null;
    }

    const vid = String(updated.id);

    // --- 🔒 НЕ ДАЁМ ПРОПАДАТЬ SERVICES / STOCK ---
    const prev = state.visitsById.get(vid) || null;
    if (prev) {
      const prevServices = Array.isArray(prev.services) ? prev.services : [];
      const prevStock = Array.isArray(prev.stock) ? prev.stock : [];

      const updHasServices = Array.isArray(updated.services) && updated.services.length > 0;
      const updHasStock = Array.isArray(updated.stock) && updated.stock.length > 0;

      // если сервер вернул "урезанный" визит (без services/stock) — сохраняем старое
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
// Push helpers (services/stock) — keep other fields intact
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
    const res = await fetch(`/api/visits?id=${encodeURIComponent(String(visitId))}`, {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}

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
// Discharges (LOCAL ONLY пока)
// =========================
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

// =========================
// Data getters (SERVER)
// =========================
async function getVisitsByPetId(petId) {
  return await loadVisitsApi({ pet_id: petId });
}

async function getVisitById(visitId) {
  if (!visitId) return null;
  const arr = await loadVisitsApi({ id: visitId });
  return arr[0] || null;
}

function getOwnerById(ownerId) {
  const arr =
    Array.isArray(state.owners) && state.owners.length
      ? state.owners
      : LS.get(OWNERS_KEY, []);

  return (arr || []).find((o) => String(o.id) === String(ownerId)) || null;
}

function getPetsByOwnerId(ownerId) {
  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients();

  return (patients || []).filter((p) => String(p.owner_id) === String(ownerId));
}

// =========================
// SERVICES registry
// =========================
function loadServices() {
  const arr =
    Array.isArray(state.services) && state.services.length
      ? state.services
      : LS.get(SERVICES_KEY, []);

  return arr || [];
}

function getServiceById(id) {
  return loadServices().find((s) => String(s.id) === String(id)) || null;
}

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
  if (!Number.isFinite(idx)) return false;
  if (idx < 0 || idx >= current.services.length) return false;

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
      // ✅ поддержка camelCase + snake_case
      const serviceId = line.serviceId || line.service_id;

      const qtyRaw = line.qty ?? line.quantity ?? 1;
      const qty = Math.max(1, Number(qtyRaw) || 1);

      const snapName = line.nameSnap ?? line.name_snap ?? "";
      const snapPrice = line.priceSnap ?? line.price_snap;

      // локальный реестр (fallback, если снапшота нет)
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

// =========================
// Services PRO HTML (for A4 discharge)
// =========================
function renderServicesProA4(expanded = [], total = 0) {
  if (!expanded.length) {
    return `<div class="hint" style="opacity:.75">—</div>`;
  }

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
// ✅ STOCK lines inside VISIT (snapshot) + totals  (SERVER VISIT)
// =========================
function ensureVisitStockShape(visit) {
  if (!visit) return;
  if (!Array.isArray(visit.stock)) visit.stock = [];
}

// ✅ SERVER: add stock line into VISIT + (optionally) decrement local STOCK registry
async function addStockLineToVisit(

  visitId,

  stockId,

  qty = 1,

  { snap = true, decrement = false } = {}

) {

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
// ✅ SERVER: remove stock line from VISIT + (optionally) restore local STOCK registry
async function removeStockLineFromVisit(visitId, index, { restore = true } = {}) {

  if (!visitId) return false;

  const vid = String(visitId);

  const current = getVisitByIdSync(vid) || (await fetchVisitById(vid));

  if (!current) return false;

  ensureVisitStockShape(current);

  const idx = Number(index);

  if (!Number.isFinite(idx)) return false;

  if (idx < 0 || idx >= current.stock.length) return false;

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

// =========================
// ✅ STOCK lines inside VISIT (snapshot) + totals
// =========================
function expandStockLines(visit) {
  const lines = Array.isArray(visit?.stock) ? visit.stock : [];

  return lines
    .filter((line) => line && (line.stockId || line.stock_id))
    .map((line) => {
      const stockId = line.stockId || line.stock_id;
      const it = getStockById(stockId);

      const name = String(
        line.nameSnap ??
        line.name_snap ??
        it?.name ??
        "Невідома позиція"
      ).trim();

      const unit = String(
        line.unitSnap ??
        line.unit_snap ??
        it?.unit ??
        "шт"
      ).trim();

      const price = Number(
        line.priceSnap ??
        line.price_snap ??
        it?.price ??
        it?.price_uah ??
        it?.sell_price ??
        it?.sale_price ??
        it?.cost ??
        0
      ) || 0;

      const qty = Math.max(
        1,
        Number(line.qty ?? line.quantity ?? 1) || 1
      );

      const lineTotal = price * qty;

      return { name, unit, price, qty, lineTotal };
    });
}

function calcStockTotal(visit) {
  return expandStockLines(visit).reduce(
    (sum, x) => sum + (Number(x?.lineTotal) || 0),
    0
  );
}

// =========================
// ✅ VISIT UI refresh helper (used by services/stock tabs)
// =========================
async function refreshVisitUIIfOpen() {
  if (state.route !== "visit" || !state.selectedVisitId) return;

  // 1) cache
  let v = getVisitByIdSync(state.selectedVisitId);

  // 2) fetch if cache empty
  if (!v) v = await fetchVisitById(state.selectedVisitId);
  if (!v) return;

  const pet =
    state.selectedPet ||
    loadPatients().find((p) => p.id === v.pet_id) ||
    null;

  renderVisitPage(v, pet);
  renderDischargeA4(state.selectedVisitId);
}


// =========================
// ✅ SERVICES UI (registry) — bind once per page
// =========================
function initServicesUI() {
  const page = document.querySelector('.page[data-page="services"]');
  if (!page) return;

  // ✅ защита от повторного навешивания
  if (page.dataset.boundServices === "1") return;
  page.dataset.boundServices = "1";

  page.querySelector("#servicesSearch")?.addEventListener("input", async (e) => {
  state.servicesQuery = String(e.target.value || "");
  renderServicesTab();
});

  // add
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

  // actions: edit/toggle/delete
  page.querySelector("#servicesList")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-svc-action]");
    if (!btn) return;

    const action = btn.dataset.svcAction;
    const id = btn.dataset.svcId;
    if (!action || !id) return;

    const items = loadServices();
    const q = String(state.servicesQuery || "").trim().toLowerCase();
const filtered = (items || []).filter((s) => {
  if (!q) return true;
  const name = String(s?.name || "").toLowerCase();
  const cat = String(s?.cat || "").toLowerCase();
  return (name + " " + cat).includes(q);
});
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

// =========================
// ✅ STOCK UI (registry) — bind once per page
// =========================
function initStockUI() {
  const page = document.querySelector('.page[data-page="stock"]');
  if (!page) return;

  // ✅ защита от повторного навешивания
  if (page.dataset.boundStock === "1") return;
  page.dataset.boundStock = "1";

  // add
  page.querySelector("#btnAddStock")?.addEventListener("click", async () => {
    const name = (prompt("Назва позиції (препарат/товар):", "") || "").trim();
    if (!name) return;

    const priceRaw = (prompt("Ціна (грн) за одиницю:", "0") || "0").trim();
    const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

    const unit = (prompt("Одиниця (шт/мл/таб/фл…):", "шт") || "шт").trim() || "шт";

    const qtyRaw = (prompt("Початковий залишок:", "0") || "0").trim();
    const qty = Math.max(0, Number(qtyRaw.replace(",", ".")) || 0);

    const id =
      "stk_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2);

    const items = loadStock();
    items.unshift({ id, name, price, unit, qty, active: true });
    saveStock(items);

    renderStockTab();
    await refreshVisitUIIfOpen();
  });

  // actions
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

      const priceRaw =
        (prompt("Ціна (грн) за одиницю:", String(cur.price ?? 0)) || "0").trim();
      const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

      const unit =
        (prompt("Одиниця:", String(cur.unit || "шт")) || "шт").trim() || "шт";

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

// =========================
// ✅ Renders — IMPORTANT: reset dataset-bound because innerHTML replaces nodes
// =========================
function renderServicesTab() {
  const page = document.querySelector('.page[data-page="services"]');
  if (!page) return;

  const items = Array.isArray(loadServices()) ? loadServices() : [];

  // ✅ поиск (храним строку в state)
  state.servicesQuery = state.servicesQuery ?? "";
  const q = String(state.servicesQuery || "").trim().toLowerCase();

  // ✅ ВОТ ОНО: filtered (у тебя его не было -> падало)
  const filtered = items.filter((s) => {
    if (!q) return true;
    const hay = [
      s?.name,
      s?.cat,
      s?.id
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  // ❗️после innerHTML старые кнопки исчезают -> надо разрешить bind заново
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

  // ✅ биндим поиск (после innerHTML!)
  const search = page.querySelector("#servicesSearch");
  if (search) {
    search.addEventListener("input", () => {
      state.servicesQuery = String(search.value || "");
      renderServicesTab(); // перерисовка списка
    });
  }

  const list = page.querySelector("#servicesList");
  if (!list) return;

  if (!filtered.length) {
    list.innerHTML = `<div class="hint">Поки порожньо. Натисни “Додати”.</div>`;
    initServicesUI();
    return;
  }

  // ✅ группируем по категории (если пусто -> "Інше")
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

function renderStockTab() {
  const page = document.querySelector('.page[data-page="stock"]');
  if (!page) return;

  const items = loadStock();

  // ❗️после innerHTML старые кнопки исчезают -> надо разрешить bind заново
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
  // пробуем взять визит из кеша
  const v = getVisitByIdSync(visitId) || {};
  const date = String(v.date || todayISO());
  return `DocPUG_${date}_visit_${String(visitId)}.pdf`;
}

// =========================
// PDF / PRINT (A4) — robust + Telegram
// =========================
async function downloadA4Pdf(visitId) {
  if (typeof window.html2pdf === "undefined") {
    alert(
      "html2pdf не подключен. Проверь, что html2pdf.bundle.min.js подключён перед app.js"
    );
    return;
  }

  const a4 = document.getElementById("disA4");
  if (!a4) return alert("Не найден блок A4 (#disA4).");

  // сохраняем форму в discharge (локально, как и было)
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
    // html2pdf бывает разных версий — делаем максимально совместимо
    const worker = window.html2pdf().set(opt).from(a4).toPdf();

    let pdfBlob = null;

    // вариант 1 (некоторые сборки)
    if (typeof worker.outputPdf === "function") {
      pdfBlob = await worker.outputPdf("blob");
    }
    // вариант 2 (классический html2pdf)
    else if (typeof worker.output === "function") {
      pdfBlob = await worker.output("blob");
    }

    if (!pdfBlob) throw new Error("html2pdf: не удалось получить blob");

  // =========================
// Android Telegram FIX:
// не открываем blob: (Android часто блокирует)
// а загружаем PDF на сервер и открываем https URL
// =========================
const filename = a4FilenameFromVisit(visitId);

let uploadedUrl = null;
try {
  const fd = new FormData();
  fd.append("files", new File([pdfBlob], filename, { type: "application/pdf" }));

  const upRes = await fetch("/api/upload", { method: "POST", body: fd });
  const upJson = await upRes.json();

  if (!upJson.ok) throw new Error(upJson.error || "upload failed");
  const f0 = upJson.files && upJson.files[0];
  if (!f0?.url) throw new Error("upload: no file url");

  // делаем абсолютную ссылку
  uploadedUrl = new URL(f0.url, window.location.origin).toString();
} catch (e) {
  console.warn("PDF upload failed, fallback to blob:", e);
}

// tg openLink работает лучше с https, чем с blob
const tg =
  window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

if (uploadedUrl) {
  if (tg && typeof tg.openLink === "function") {
    tg.openLink(uploadedUrl, { try_instant_view: false });
  } else {
    window.location.href = uploadedUrl; // в браузере тоже ок
  }
  return;
}

// ===== fallback (если upload не удался): blob (может не работать в Android TG)
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
// OWNERS — server state rendering
// =========================
function renderOwners() {
  const list = $("#ownersList");
  if (!list) return;

  list.innerHTML = "";

  const q = String($("#globalSearch")?.value || "").trim().toLowerCase();

  const ownersRaw = Array.isArray(state.owners) ? state.owners : [];

  const owners = ownersRaw.filter((owner) => {
    if (!q) return true;

    const hay = [
      owner.name,
      owner.phone,
      owner.note,
    ].filter(Boolean).join(" ").toLowerCase();

    return hay.includes(q);
  });

  if (!owners.length) {
    list.innerHTML = `<div class="hint">Нічого не знайдено.</div>`;
    return;
  }

  owners.forEach((owner) => {
    const el = document.createElement("div");
    el.className = "item";
    el.dataset.openOwner = String(owner.id);
    el.style.cursor = "pointer";

    const petsCount = (state.patients || []).filter(
      p => String(p.owner_id) === String(owner.id)
    ).length;

    el.innerHTML = `
      <div class="left" style="flex:1; min-width:0;">
        <div class="name" style="font-size:20px;">
          👤 ${escapeHtml(owner.name || "Без имени")}
        </div>

        <div class="meta" style="margin-top:6px;">
          📞 ${escapeHtml(owner.phone || "Не указан")}
        </div>

        ${
          owner.note
            ? `<div class="meta">📍 ${escapeHtml(owner.note)}</div>`
            : ""
        }

        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
          <div class="pill">🐾 ${petsCount} пацієнтів</div>
          <div class="pill">📝 CRM</div>
        </div>
      </div>

      <div class="right" style="display:flex; gap:8px; align-items:center; flex:0 0 auto;">
        <button class="iconBtn" title="Редагувати" data-edit-owner="${escapeHtml(owner.id)}">✏️</button>
        <button class="iconBtn" title="Удалить" data-del="${escapeHtml(owner.id)}">🗑</button>
      </div>
    `;

    list.appendChild(el);
  });
}
// =========================
// PATIENTS TAB — server first (state), LS only fallback
// =========================
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

  // ✅ server-first
  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients(); // fallback если сервер ещё не грузили

  const owners =
    Array.isArray(state.owners) && state.owners.length
      ? state.owners
      : LS.get(OWNERS_KEY, []); // fallback

  const ownerById = new Map((owners || []).map((o) => [o.id, o]));

  if (!patients.length) {
    list.innerHTML = `<div class="hint">Поки пацієнтів немає. Додай їх у “Власники → Тварина”.</div>`;
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
      el.dataset.openPet = p.id; // data-open-pet

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

       <div class="right" style="display:flex; gap:6px;">
  <button class="iconBtn" title="Редагувати" data-edit-pet="${escapeHtml(p.id)}">✏️</button>
  <button class="iconBtn" title="Видалити пацієнта" data-del-pet="${escapeHtml(p.id)}">🗑</button>
</div>
      `;

      list.appendChild(el);
    });

  // один обработчик на весь список
  list.onclick = async (e) => {
    /// ✏️ edit
const editBtn = e.target.closest("[data-edit-pet]");
if (editBtn) {
  e.preventDefault();
  e.stopPropagation();

  const petId = editBtn.dataset.editPet;
  if (!petId) return;

  const pet = (state.patients || []).find((p) => String(p.id) === String(petId));
  if (!pet) return alert("Пацієнта не знайдено");

  const name = (prompt("Кличка:", pet.name || "") || "").trim();
  if (!name) return;

  const species = askSpecies(pet.species || "dog");
if (!species) return;
  const breed = (prompt("Порода:", pet.breed || "") || "").trim();
  const age = (prompt("Вік:", pet.age || "") || "").trim();
  const weight_kg = (prompt("Вага кг:", pet.weight_kg || "") || "").trim();
  const notes = (prompt("Нотатки:", pet.notes || "") || "").trim();

  const updated = await updatePatientApi(petId, {
    name,
    species,
    breed,
    age,
    weight_kg,
    notes,
  });

  if (!updated) return;

  await loadPatientsApi();
  renderPatientsTab();

  if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);

  return;
}
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

// =========================
// VISITS TAB — SERVER ONLY (state.visits from /api/visits)
// =========================
// =========================
// VISITS TAB — SERVER ONLY (safe clicks)
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

  const list = page.querySelector("#visitsTabList");
  const search = page.querySelector("#visitsSearch");
  if (!list) return;

  // загрузка визитов
  if (!Array.isArray(state.visits) || !state.visits.length) {
    list.innerHTML = `<div class="hint">Завантаження…</div>`;
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

    list.innerHTML = "";

    if (!filtered.length) {
      list.innerHTML = `<div class="hint">Нічого не знайдено.</div>`;
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

      list.appendChild(el);
    });
  }

  // поиск
  search?.addEventListener("input", paint);

  // ✅ ОДИН обработчик — без конфликтов
  list.onclick = async (e) => {

    const card = e.target.closest(".item[data-visit-id]");
    if (!card) return;

    const visitId = card.dataset.visitId;

    // delete
    if (e.target.closest('[data-action="delete"]')) {
      e.preventDefault();
      e.stopPropagation();

      if (!confirm("Видалити візит?")) return;

      const ok = await deleteVisitApi(visitId);
      if (ok) {
        const arr = await loadVisitsApi();
        state.visits = arr;
        paint();
      }
      return;
    }

    // open (кнопка ИЛИ клик по карточке)
    if (
      e.target.closest('[data-action="open"]') ||
      e.target.closest(".item[data-visit-id]")
    ) {
      openVisit(visitId);
    }
  };

  paint();
}
// =========================
// OWNER PAGE — server first patients list (render only)
// =========================
function renderOwnerPage(ownerId) {
  const owner = getOwnerById(ownerId);
  if (!owner) {
    alert("Владелец не найден");
    setHash("owners");
    return;
  }

  state.selectedOwnerId = String(ownerId);

  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients();

  const pets = (patients || []).filter(
    (p) => String(p.owner_id) === String(ownerId)
  );

  const allVisits = Array.from(state.visitsById.values());

  const ownerPetIds = new Set(pets.map((p) => String(p.id)));

  const ownerVisits = allVisits.filter((v) =>
    ownerPetIds.has(String(v.pet_id))
  );

  const visitsCount = ownerVisits.length;

  const lastVisit = ownerVisits
    .slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];

  const totalPaid = ownerVisits.reduce((sum, v) => {
    return sum + calcServicesTotal(v) + calcStockTotal(v);
  }, 0);

  const ownerName = $("#ownerName");
  const ownerMeta = $("#ownerMeta");

  if (ownerName) {
    ownerName.innerHTML = `
      <div class="ownerHero">
        <div>
          <div class="ownerHeroLabel">Картка власника</div>
          <div class="ownerHeroName">👤 ${escapeHtml(owner.name || "Без имени")}</div>

          <div class="ownerHeroMeta">
            <span>📞 ${escapeHtml(owner.phone || "Телефон не указан")}</span>
            ${
              owner.note
                ? `<span>📍 ${escapeHtml(owner.note)}</span>`
                : ""
            }
          </div>
        </div>

        <div class="ownerHeroActions">
          <button class="ghost" data-edit-owner="${escapeHtml(owner.id)}">✏️ Редагувати</button>
          <button class="primary" id="btnAddPet">+ Животное</button>
        </div>
      </div>

      <div class="ownerStats">
        <div class="ownerStat">
          <div class="ownerStatIcon">🐾</div>
          <div>
            <div class="ownerStatValue">${pets.length}</div>
            <div class="ownerStatLabel">пацієнтів</div>
          </div>
        </div>

        <div class="ownerStat">
          <div class="ownerStatIcon">📋</div>
          <div>
            <div class="ownerStatValue">${visitsCount}</div>
            <div class="ownerStatLabel">візитів</div>
          </div>
        </div>

        <div class="ownerStat">
          <div class="ownerStatIcon">💰</div>
          <div>
            <div class="ownerStatValue">${escapeHtml(String(totalPaid))} грн</div>
            <div class="ownerStatLabel">оплачено</div>
          </div>
        </div>

        <div class="ownerStat">
          <div class="ownerStatIcon">📅</div>
          <div>
            <div class="ownerStatValue">${escapeHtml(lastVisit?.date || "—")}</div>
            <div class="ownerStatLabel">останній візит</div>
          </div>
        </div>
      </div>
    `;
  }

  if (ownerMeta) ownerMeta.textContent = "";

  const list = $("#petsList");
  if (!list) return;

  list.innerHTML = "";

  if (!pets.length) {
    list.innerHTML = `<div class="hint">Пока нет животных. Нажми “+ Животное”.</div>`;
    return;
  }

  pets.forEach((pet) => {
    const petVisits = ownerVisits.filter(
      (v) => String(v.pet_id) === String(pet.id)
    );

    const petLastVisit = petVisits
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];

    const el = document.createElement("div");
    el.className = "item ownerPetCard";

    el.innerHTML = `
      <div
        class="left"
        data-open-pet="${escapeHtml(String(pet.id))}"
        style="width:100%; cursor:pointer;"
      >
        <div class="ownerPetTop">
          <div>
            <div class="name" style="font-size:19px;">
              🐾 ${escapeHtml(pet.name || "Без клички")}
            </div>

            <div class="meta" style="margin-top:6px;">
              ${escapeHtml(speciesLabel(pet.species))}
              ${pet.breed ? " • " + escapeHtml(pet.breed) : ""}
              ${pet.age ? " • " + escapeHtml(pet.age) : ""}
              ${pet.weight_kg ? " • " + escapeHtml(String(pet.weight_kg)) + " кг" : ""}
            </div>
          </div>

          <div class="ownerPetBadges">
            <div class="pill">📋 ${petVisits.length} візитів</div>
            <div class="pill">📅 ${escapeHtml(petLastVisit?.date || "—")}</div>
          </div>
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

      <div class="right" style="display:flex; gap:8px; align-items:center;">
        <button class="iconBtn" title="Видалити" data-del-pet="${escapeHtml(String(pet.id))}">🗑</button>
      </div>
    `;

    list.appendChild(el);
  });
}

// =========================
// NAV: open pages (server-first)
// =========================
function openOwner(ownerId, opts = { pushHash: true }) {
  setRoute("owner");
  renderOwnerPage(ownerId);
  if (opts.pushHash) setHash("owner", ownerId);
}

// ===== Patient page =====
function openPatient(petId, opts = { pushHash: true }) {
  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients();

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
          ${escapeHtml(speciesLabel(pet.species))}
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

  $("#btnAddVisit")?.addEventListener("click", () => {
    const pet = state.selectedPet;
    if (!pet) return alert("Пацієнт не обраний");
    openVisitModalForCreate(pet);
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
  if (!box || !pet) return;

  if (tab === "overview") {
    box.innerHTML = `<div class="hint">Завантаження…</div>`;

    const visits = await getVisitsByPetId(pet.id);
    cacheVisits(visits);

    const lastVisit = visits
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];

    const totalPaid = visits.reduce((sum, v) => {
      return sum + calcServicesTotal(v) + calcStockTotal(v);
    }, 0);

    box.innerHTML = `
      <div class="patientStats">
        <div class="ownerStat">
          <div class="ownerStatIcon">📋</div>
          <div>
            <div class="ownerStatValue">${visits.length}</div>
            <div class="ownerStatLabel">візитів</div>
          </div>
        </div>

        <div class="ownerStat">
          <div class="ownerStatIcon">⚖️</div>
          <div>
            <div class="ownerStatValue">${escapeHtml(pet.weight_kg || "—")}</div>
            <div class="ownerStatLabel">вага, кг</div>
          </div>
        </div>

        <div class="ownerStat">
          <div class="ownerStatIcon">📅</div>
          <div>
            <div class="ownerStatValue">${escapeHtml(lastVisit?.date || "—")}</div>
            <div class="ownerStatLabel">останній візит</div>
          </div>
        </div>

        <div class="ownerStat">
          <div class="ownerStatIcon">💰</div>
          <div>
            <div class="ownerStatValue">${escapeHtml(String(totalPaid))} грн</div>
            <div class="ownerStatLabel">сума</div>
          </div>
        </div>
      </div>

      <div class="patientGrid">
        <div class="patientInfoBox">
          <h2>Паспорт пацієнта</h2>
          <div class="patientInfoRow"><b>Кличка:</b> ${escapeHtml(pet.name || "—")}</div>
          <div class="patientInfoRow"><b>Вид:</b> ${escapeHtml(speciesLabel ? speciesLabel(pet.species) : pet.species || "—")}</div>
          <div class="patientInfoRow"><b>Порода:</b> ${escapeHtml(pet.breed || "—")}</div>
          <div class="patientInfoRow"><b>Вік:</b> ${escapeHtml(pet.age || "—")}</div>
          <div class="patientInfoRow"><b>Вага:</b> ${escapeHtml(pet.weight_kg || "—")} кг</div>
        </div>

        <div class="patientInfoBox">
          <h2>Нотатки лікаря</h2>
          <div class="meta" style="white-space:pre-wrap;">${escapeHtml(pet.notes || "Поки нотаток немає.")}</div>
        </div>
      </div>
    `;
    return;
  }

  if (tab === "visits") {
    await renderVisits(pet.id);
    return;
  }
if (tab === "medcard") {
  await renderMedcardTab(pet);
  return;
}
  if (tab === "labs") {
    renderLabsTab(pet);
    return;
  }

  if (tab === "files") {
  renderPatientFilesTab(pet);
  return;
}

  if (tab === "finance") {
    const visits = await getVisitsByPetId(pet.id);
    cacheVisits(visits);

    const servicesTotal = visits.reduce((sum, v) => sum + calcServicesTotal(v), 0);
    const stockTotal = visits.reduce((sum, v) => sum + calcStockTotal(v), 0);
    const grandTotal = servicesTotal + stockTotal;
    const avg = visits.length ? Math.round(grandTotal / visits.length) : 0;

    box.innerHTML = `
      <div class="patientStats">
        <div class="ownerStat">
          <div class="ownerStatIcon">💰</div>
          <div>
            <div class="ownerStatValue">${escapeHtml(String(grandTotal))} грн</div>
            <div class="ownerStatLabel">усього</div>
          </div>
        </div>

        <div class="ownerStat">
          <div class="ownerStatIcon">🧾</div>
          <div>
            <div class="ownerStatValue">${escapeHtml(String(servicesTotal))} грн</div>
            <div class="ownerStatLabel">послуги</div>
          </div>
        </div>

        <div class="ownerStat">
          <div class="ownerStatIcon">💊</div>
          <div>
            <div class="ownerStatValue">${escapeHtml(String(stockTotal))} грн</div>
            <div class="ownerStatLabel">препарати</div>
          </div>
        </div>

        <div class="ownerStat">
          <div class="ownerStatIcon">📊</div>
          <div>
            <div class="ownerStatValue">${escapeHtml(String(avg))} грн</div>
            <div class="ownerStatLabel">середній чек</div>
          </div>
        </div>
      </div>
    `;
    return;
  }
}
const PATIENT_FILES_KEY = "DOCPUG_PATIENT_FILES_V1";

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
  const rawUrl =
    file.url ||
    file.path ||
    file.href ||
    file.fileUrl ||
    file.file_url ||
    "";

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
  "Біохімія": [
    "ALT",
    "AST",
    "GGT",
    "ALP",
    "UREA",
    "CREA",
    "ALB",
    "TP",
    "GLU",
    "TBIL",
    "GLOB",
  ],

  "ЗАК": [
    "WBC",
    "RBC",
    "HGB",
    "PLT",
    "HCT",
    "NEU_BAND",
    "NEU_SEG",
    "LYM",
    "EOS",
    "BASO",
    "MONO",
  ],
};

function getPetSpeciesKey(pet) {
  const s = String(pet?.species || "").toLowerCase().trim();

  if (s === "cat" || s.includes("кот") || s.includes("кіт") || s.includes("cat")) return "cat";
  if (s === "dog" || s.includes("пес") || s.includes("соб") || s.includes("dog")) return "dog";

  return "dog";
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
      editLabForPet(pet, id);
      return;
    }

    const pdf = e.target.closest("[data-pdf-lab]");
if (pdf) {
  const id = pdf.dataset.pdfLab;
  if (!id) return;

  const lab = loadLabs().find((x) => String(x.id) === String(id));
  if (!lab) return alert("Аналіз не знайдено");

  await downloadLabPdf(pet, lab);
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

  box.innerHTML = `<div class="hint">Завантаження…</div>`;

  const visits = await getVisitsByPetId(petId);
  cacheVisits(visits);

  if (!visits.length) {
    box.innerHTML = `
      <div class="patientInfoBox">
        <h2>Історія візитів</h2>
        <div class="hint">Поки візитів немає. Натисни “+ Візит”.</div>
      </div>
    `;
    return;
  }

  box.innerHTML = `
    <div class="patientVisitsList">
      ${visits
        .slice()
        .sort((a, b) => String(b.date || b.id).localeCompare(String(a.date || a.id)))
        .map((v) => {
          const parsed = parseVisitNote(v.note || "");
          const dx = parsed.dx || "Без діагнозу";
          const complaint = parsed.complaint || "Скарги не вказані";

          const servicesTotal = calcServicesTotal(v);
          const stockTotal = calcStockTotal(v);
          const grandTotal = servicesTotal + stockTotal;

          return `
            <div class="item visitCard" data-open-visit="${escapeHtml(String(v.id))}" style="cursor:pointer;">
              <div class="left" style="width:100%;">
                <div class="visitCardTop">
                  <div>
                    <div class="visitDate">${escapeHtml(v.date || "—")}</div>
                    <div class="visitDx">Діагноз: ${escapeHtml(dx)}</div>
                  </div>

                  <div class="visitCardBadges">
                    <div class="pill">💰 ${escapeHtml(String(grandTotal))} грн</div>
                    <div class="pill">📄 Візит</div>
                  </div>
                </div>

                <div class="visitMiniBlock">
                  <div class="history-label">Скарга / стан</div>
                  <div class="visitMiniText">${escapeHtml(complaint)}</div>
                </div>

                ${
                  v.rx
                    ? `
                      <div class="visitMiniBlock">
                        <div class="history-label">Призначення</div>
                        <div class="visitMiniText">${escapeHtml(v.rx)}</div>
                      </div>
                    `
                    : ""
                }
              </div>

              <div class="right" style="display:flex; gap:6px;">
                <button class="iconBtn" title="Редагувати" data-edit-visit="${escapeHtml(String(v.id))}">✏️</button>
                <button class="iconBtn" title="Видалити візит" data-del-visit="${escapeHtml(String(v.id))}">🗑</button>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;

  box.onclick = async (e) => {
    const editBtn = e.target.closest("[data-edit-visit]");
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();

      const visitId = editBtn.dataset.editVisit;
      if (visitId) await openVisitModalForEdit(visitId);
      return;
    }

    const delBtn = e.target.closest("[data-del-visit]");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();

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
    .map((s) => {
      return `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} — ${escapeHtml(
        String(Number(s.price) || 0)
      )} грн</option>`;
    })
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

      return `<option value="${escapeHtml(it.id)}">${escapeHtml(it.name)} — ${escapeHtml(
        String(price)
      )} грн/${escapeHtml(unit)} • залишок: ${escapeHtml(String(left))}</option>`;
    })
    .join("");

  select.innerHTML = options || `<option value="">Немає препаратів</option>`;
}

function initVisitUI() {
  if (state.visitUiBound) return;
  state.visitUiBound = true;

  // back + discharge (capture so nothing can block it лол)
  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest("#btnBackPatient")) {
        if (state.selectedPetId) openPatient(state.selectedPetId);
        else if (state.selectedOwnerId) openOwner(state.selectedOwnerId);
        else setHash("owners");
        return;
      }

      if (e.target.closest("#btnDischarge")) {
        const visitId = state.selectedVisitId;
        if (!visitId) return alert("Спочатку відкрий візит.");
        openDischargeModal(visitId);
        return;
      }
    },
    true
  );

  // SERVICES + STOCK (capture=true)
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
  setDischarge(vid, {

  complaint,

  dx,

  rx,

});

  if (btn) btn.textContent = "✅ Збережено";
  if (hint) hint.textContent = "Медична частина збережена.";

  renderDischargeA4(vid);

  setTimeout(() => {
    if (btn) btn.textContent = "💾 Зберегти";
    if (hint) hint.textContent = "Можна редагувати прямо тут. Після змін натисни “Зберегти”.";
  }, 1200);

  return;
}
      // add service
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
renderDischargeA4(vid);
        return;
      }

      // remove service
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
  renderDischargeA4(vid);
}

return;
      }

      // add stock
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
  renderDischargeA4(vid);
}

return;
      }

      // remove stock
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
  renderDischargeA4(vid);
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
    // 🔍 ПОИСК ПОСЛУГ И ПРЕПАРАТОВ (делегированно, чтобы не слетал при renderVisitPage)
  document.addEventListener(
  "input",
  (e) => {
    const t = e.target;

    // поиск услуг
    if (t && t.id === "visitSvcSearch") {
      state.visitSvcQuery = String(t.value || "");
      refreshVisitServiceSelect();
      return;
    }

    // поиск препаратов
    if (t && t.id === "visitStkSearch") {
      state.visitStkQuery = String(t.value || "");
      refreshVisitStockSelect();
      return;
    }
  },
  true
);
}

// ===== Visit page =====
async function openVisit(visitId, opts = { pushHash: true }) {
  const vid = String(visitId || "").trim();
  if (!vid) return;

  let visit = getVisitByIdSync(vid);

  // 🔁 если визита нет — пробуем загрузить с сервера
  if (!visit) {
    try {
      const arr = await loadVisitsApi({ id: vid });
      visit = arr?.[0] || null;
    } catch {}
  }

  // ⛔ только ТЕПЕРЬ можно сказать что не найдено
  if (!visit) {
    alert("Візит не знайдено");
    setHash("visits");
    return;
  }

  ensureVisitServicesShape(visit);
  ensureVisitStockShape(visit);

  state.selectedVisitId = vid;

  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients();

  const pet =
    (patients || []).find((p) => String(p.id) === String(visit.pet_id)) || null;

  if (pet) {
    state.selectedPet = pet;
    state.selectedPetId = String(pet.id);
    state.selectedOwnerId = pet.owner_id || state.selectedOwnerId;
  }

  renderVisitPage(visit, pet);
  renderVisitFiles(vid);
  initVisitUI();
  setRoute("visit");

  if (opts.pushHash) setHash("visit", vid);
}

// =========================
// Visit page rendering (SERVER save)
// =========================
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
  if (!box) return;

  const note = String(visit.note || "").trim();
  const rx = String(visit.rx || "").trim();

  const parsed = parseVisitNote(note);
  const dx = parsed.dx || "";
  const complaint = parsed.complaint || "";

  // --- SERVICES ---
  ensureVisitServicesShape(visit);

  const svcQ = String(state.visitSvcQuery || "").trim().toLowerCase();

  const svcOptions = loadServices()
    .filter((s) => s.active !== false)
    .filter((s) => !svcQ || String(s.name || "").toLowerCase().includes(svcQ))
    .map((s) => {
      return `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} — ${escapeHtml(
        String(Number(s.price) || 0)
      )} грн</option>`;
    })
    .join("");

  const expanded = expandServiceLines(visit);
  const total = calcServicesTotal(visit);

  const svcListHtml = expanded.length
    ? expanded
        .map(
          (x, idx) => `
            <div class="visitLine">
              <div>
                <div class="visitLineName">${escapeHtml(x.name)}</div>
                <div class="visitLineMeta">
                  ${escapeHtml(String(x.qty))} × ${escapeHtml(String(x.price))} грн
                </div>
              </div>

              <div class="visitLineRight">
                <b>${escapeHtml(String(x.lineTotal))} грн</b>
                <button type="button" class="miniBtn danger" data-svc-del="${idx}">Прибрати</button>
              </div>
            </div>
          `
        )
        .join("")
    : `<div class="hint">Поки послуг немає. Додай нижче.</div>`;

  // --- STOCK ---
  ensureVisitStockShape(visit);

  const stkQ = String(state.visitStkQuery || "").trim().toLowerCase();

  const stkOptions = loadStock()
    .filter((it) => it.active !== false)
    .filter((it) => !stkQ || String(it.name || "").toLowerCase().includes(stkQ))
    .map((it) => {
      const left = Number(it.qty) || 0;
      const unit = String(it.unit || "шт");
      const price = Number(it.price) || 0;

      return `<option value="${escapeHtml(it.id)}">${escapeHtml(it.name)} — ${escapeHtml(
        String(price)
      )} грн/${escapeHtml(unit)} • залишок: ${escapeHtml(String(left))}</option>`;
    })
    .join("");

  const stkExpanded = expandStockLines(visit);
  const stkTotal = calcStockTotal(visit);

  const stkListHtml = stkExpanded.length
    ? stkExpanded
        .map(
          (x, idx) => `
            <div class="visitLine">
              <div>
                <div class="visitLineName">${escapeHtml(x.name)}</div>
                <div class="visitLineMeta">
                  ${escapeHtml(String(x.qty))} × ${escapeHtml(String(x.price))} грн/${escapeHtml(x.unit || "шт")}
                </div>
              </div>

              <div class="visitLineRight">
                <b>${escapeHtml(String(x.lineTotal))} грн</b>
                <button type="button" class="miniBtn danger" data-stk-del="${idx}">Прибрати</button>
              </div>
            </div>
          `
        )
        .join("")
    : `<div class="hint">Поки препаратів немає. Додай нижче.</div>`;

  const grandTotal = total + stkTotal;

  box.innerHTML = `
    <div class="visitMoneyGrid">
      <div class="visitMoneyCard">
        <div class="visitMoneyLabel">Послуги</div>
        <div class="visitMoneyValue">${escapeHtml(String(total))} грн</div>
      </div>

      <div class="visitMoneyCard">
        <div class="visitMoneyLabel">Препарати</div>
        <div class="visitMoneyValue">${escapeHtml(String(stkTotal))} грн</div>
      </div>

      <div class="visitMoneyCard visitMoneyCardTotal">
        <div class="visitMoneyLabel">Разом</div>
        <div class="visitMoneyValue">${escapeHtml(String(grandTotal))} грн</div>
      </div>
    </div>

    <div class="visitBlock">
      <div class="visitBlockHead">
        <div class="visitBlockTitle">Медична частина</div>
        <button type="button" class="miniBtn" id="visitMedSave">💾 Зберегти</button>
      </div>

      <div class="visitMedGrid visitMedGridEdit">
        <label class="field visitMedItem">
          <div class="history-label">Діагноз</div>
          <input
            class="input"
            id="visitMedDx"
            type="text"
            placeholder="Напр.: цистит / гастроентерит / отит"
            value="${escapeHtml(dx)}"
          />
        </label>

        <label class="field visitMedItem">
          <div class="history-label">Скарга / стан</div>
          <textarea
            class="textarea visitMedTextarea"
            id="visitMedComplaint"
            rows="5"
            placeholder="Скарги, анамнез, стан на момент огляду..."
          >${escapeHtml(complaint)}</textarea>
        </label>

        <label class="field visitMedItem visitMedItemWide">
          <div class="history-label">Призначення</div>
          <textarea
            class="textarea visitMedTextarea"
            id="visitMedRx"
            rows="6"
            placeholder="Препарат • доза • кратність • курс"
          >${escapeHtml(rx)}</textarea>
        </label>
      </div>

      <div class="hint" id="visitMedSaveHint" style="margin-top:10px;">
        Можна редагувати прямо тут. Після змін натисни “Зберегти”.
      </div>
    </div>

    <div class="visitBlock">
      <div class="visitBlockTitle">Послуги</div>

      <div class="visitPicker">
        <input id="visitSvcSearch" type="search" placeholder="Пошук послуги…" value="${escapeHtml(state.visitSvcQuery || "")}" />
        <select id="visitSvcSelect">${svcOptions || `<option value="">Немає послуг</option>`}</select>
        <input id="visitSvcQty" type="number" min="1" value="1" />
        <button id="visitSvcAdd" type="button" class="miniBtn">Додати</button>
      </div>

      <div class="visitLines">${svcListHtml}</div>
    </div>

    <div class="visitBlock">
      <div class="visitBlockTitle">Препарати / склад</div>

      <div class="visitPicker">
        <input id="visitStkSearch" type="search" placeholder="Пошук препарату…" value="${escapeHtml(state.visitStkQuery || "")}" />
        <select id="visitStkSelect">${stkOptions || `<option value="">Немає препаратів</option>`}</select>
        <input id="visitStkQty" type="number" min="1" value="1" />
        <button id="visitStkAdd" type="button" class="miniBtn">Додати</button>
      </div>

      <div class="visitLines">${stkListHtml}</div>
    </div>
  `;
}
function parseVisitNote(note) {
  const t = String(note || "");

  // ожидаем формат:
  // "Діагноз: ...\n\nСкарги/анамнез: ..."
  const dxMatch = t.match(/Діагноз:\s*(.*?)(\n|$)/i);
  const dx = (dxMatch?.[1] || "").trim();

  const compMatch = t.match(/Скарги\/анамнез:\s*([\s\S]*)/i);
  const complaint = (compMatch?.[1] || "").trim();

  // если нет шаблонов — считаем весь note жалобой
  return {
    dx: dx || "",
    complaint: complaint || (!dx ? t.trim() : ""),
  };
}

function fillDischargeForm(visit, existing) {
  // existing = то, что ты сохраняешь в local discharge (если есть)
  const ex = existing || {};

  const parsed = parseVisitNote(visit?.note || "");
  const complaint = (ex.complaint ?? ex.disComplaint ?? parsed.complaint ?? "").toString();
  const dx = (ex.dx ?? ex.disDx ?? parsed.dx ?? "").toString();
  const parsedRx = parseRxCombined(visit?.rx || "");
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

  const patients = (Array.isArray(state.patients) && state.patients.length)
    ? state.patients
    : loadPatients();

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
                <td>${escapeHtml(String(totalS))} грн</td>
              </tr>
            </tfoot>
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
              .join("") || `
                <tr>
                  <td colspan="5">—</td>
                </tr>
              `
            }
          </tbody>

          <tfoot>
            <tr>
              <td colspan="4">Разом</td>
              <td>
                ${escapeHtml(String((calcServicesTotal(v) || 0) + (calcStockTotal(v) || 0)))} грн
              </td>
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

  // пробуем вытащить секции по маркерам
  const recsMatch = t.match(/(?:^|\n)Рекомендації:\n([\s\S]*?)(?=\n\nКонтроль \/ при погіршенні:\n|\s*$)/);
  const followMatch = t.match(/(?:^|\n)Контроль \/ при погіршенні:\n([\s\S]*)$/);

  const recs = (recsMatch?.[1] || "").trim();
  const follow = (followMatch?.[1] || "").trim();

  // "чистый rx" = то что до "Рекомендації:" (если есть)
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
    } catch {
      return [];
    }
  }
  return [];
}

function safeVisitArray(primary, backup) {
  // primary = visit.services или visit.stock
  // backup  = visit.services_json или visit.stock_json (могут быть строкой)
  const a = normalizeJsonArray(primary);
  if (a.length) return a;
  return normalizeJsonArray(backup);
}
function initDischargeModalUI() {
  if (state.dischargeListenersBound) return;

  const modal = $("#dischargeModal");
  if (!modal) return; // если в HTML нет модалки — просто выходим

  const live = () => {
    const vid = modal.dataset.visitId;
    if (vid) renderDischargeA4(vid);
  };

  ["#disComplaint", "#disDx", "#disRx", "#disRecs", "#disFollow"].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener("input", live);
  });

  document.addEventListener(
  "click",
  async (e) => {
    const modal = $("#dischargeModal");
    if (!modal) return;

    const vid = modal.dataset.visitId;

    // --- SAVE ---
    if (e.target.closest("#disSave")) {
      e.preventDefault();
      e.stopPropagation();
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
  rx: buildRxCombined(form.rx, form.recs, form.follow),

  // ✅ НЕ ДАЁМ СЕРВЕРУ ЗАТЕРЕТЬ
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

    // --- PRINT ---
    if (e.target.closest("#disPrint")) {
      e.preventDefault();
      e.stopPropagation();
      if (!vid) return;
      printA4Only(vid);
      return;
    }

    // --- DOWNLOAD PDF ---
    if (e.target.closest("#disDownload")) {
      e.preventDefault();
      e.stopPropagation();
      if (!vid) return;
      await downloadA4Pdf(vid);
      return;
    }

    // --- CLOSE ---
    if (e.target.closest("[data-close-discharge]")) {
      closeDischargeModal();
      return;
    }
  },
  true
);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDischargeModal();
      closeVisitModal();
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

  // ✅ ВАЖНО: гарантируем, что визит есть (кеш или сервер)
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



// ===== UI init (Owners) — server-first (delegated, survives rerenders) =====
function initOwnersUI() {
  if (state.ownersUiBound) return;
  state.ownersUiBound = true;

  // Delegated clicks so buttons keep working after innerHTML rerenders
  document.addEventListener("click", async (e) => {
    // ➕ Добавить владельца (support a few possible ids/selectors)
    const addBtn = e.target.closest("#btnAddOwner, [data-action='add-owner'], [data-action='addOwner'], .btnAddOwner");
    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();

      const name = (prompt("Имя владельца:") || "").trim();
      if (!name) return;

      const phone = (prompt("Телефон (необязательно):") || "").trim();
      const note = (prompt("Заметка/город (необязательно):") || "").trim();

      const created = await createOwner(name, phone, note);
      if (!created) return;

      // ✅ всегда берём актуальный список с сервера
      await loadOwners();
      return;
    }

    // 🗑 / ➡️ Клик по списку владельцев
    const ownersList = e.target.closest("#ownersList");
    if (!ownersList) return;
// ✏️ Редактирование
const editBtn = e.target.closest("[data-edit-owner]");
if (editBtn) {
  e.preventDefault();
  e.stopPropagation();

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

      await loadOwners();
      return;
    }

    // ➡️ Открытие владельца
    const openZone = e.target.closest("[data-open-owner]");
    if (openZone) {
      const ownerId = openZone.dataset.openOwner;
      if (ownerId) openOwner(ownerId);
    }
  });

  // Back button can stay direct (usually static), but also make it safe:
  document.addEventListener("click", (e) => {
    if (e.target.closest("#btnBackOwners")) setHash("owners");
  });
}

// =========================
// OWNER UI — server-first
// =========================
function initOwnerUI() {
  // ➕ add pet (server)
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

    // ✅ перезагружаем пациентов с сервера и обновляем владельца
    await loadPatientsApi();
    renderOwnerPage(ownerId);
  });

  // pets list click: delete/open
  $("#petsList")?.addEventListener("click", async (e) => {
    // 🗑 delete pet (server)
    const delBtn = e.target.closest("[data-del-pet]");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();

      const petId = delBtn.dataset.delPet;
      if (!petId) return;

      if (!confirm("Видалити пацієнта назавжди?")) return;

      const ok = await deletePatientApi(petId);
      if (!ok) {
        alert("Не вдалося видалити пацієнта.");
        return;
      }

      // ✅ обновляем список пациентов с сервера
      await loadPatientsApi();

      // если удалили текущего выбранного — сбросим
      if (state.selectedPetId === petId) {
        state.selectedPetId = null;
        state.selectedPet = null;
      }

      if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
      return;
    }

    // open pet
    const openZone = e.target.closest("[data-open-pet]");
    if (openZone) {
      const petId = openZone.dataset.openPet;
      if (petId) openPatient(petId);
    }
  });
}


// =========================
// VISITS TAB UI — server-first
// =========================
function initVisitsTabUI() {
  const page = $(`.page[data-page="visits"]`);
  if (!page) return;

  page.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-visit]");
    if (del) {
      e.preventDefault();
      e.stopPropagation();

      const visitId = del.dataset.delVisit;
      if (!visitId) return;

      if (!confirm("Видалити візит назавжди?")) return;

      const ok = await deleteVisitApi(visitId);
      if (!ok) {
        alert("Не вдалося видалити візит.");
        return;
      }

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
      e.preventDefault();
      e.stopPropagation();

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
// VISIT_FILES (LOCAL links) — minimal working
// =========================

// visit_files: [{ visit_id, file_id, created_at }]
function loadVisitFilesLinks() {
  const arr = LS.get(VISIT_FILES_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function saveVisitFilesLinks(arr) {
  LS.set(VISIT_FILES_KEY, Array.isArray(arr) ? arr : []);
}

// вернуть file_ids привязанные к визиту
function getFileIdsForVisit(visitId) {
  const vid = String(visitId || "");
  if (!vid) return [];
  return loadVisitFilesLinks()
    .filter((x) => String(x.visit_id) === vid)
    .map((x) => String(x.file_id))
    .filter(Boolean);
}

// ✅ привязать список fileIds к визиту (добавляет, без дублей)
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
      (r) => String(r.visit_id) === vid && String(r.file_id) === String(fid)
    );
    if (!exists) {
      links.push({
        visit_id: vid,
        file_id: String(fid),
        created_at: nowISO(),
      });
    }
  }

  saveVisitFilesLinks(links);
}

// ✅ отвязать 1 файл от визита
function detachFileFromVisit(visitId, fileId) {
  const vid = String(visitId || "");
  const fid = String(fileId || "");
  if (!vid || !fid) return;

  const next = loadVisitFilesLinks().filter(
    (r) => !(String(r.visit_id) === vid && String(r.file_id) === fid)
  );

  saveVisitFilesLinks(next);
}


// =========================
// VISIT MODAL helpers (GLOBAL)
// =========================
function openVisitModalForCreate(pet) {
  const modal = $("#visitModal");
  if (!modal) return alert("Не знайдено #visitModal в HTML");

  delete modal.dataset.visitId;

  $("#visitDate").value = todayISO();
  $("#visitNote").value = "";
  $("#visitDx").value = "";
  $("#visitWeight").value = pet?.weight_kg || "";
  $("#visitRx").value = "";

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

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
  const raw = prompt(
    "Вид пацієнта:\n1 — пес\n2 — кіт",
    cur === "cat" ? "2" : "1"
  );

  if (raw === null) return null;

  const v = String(raw).trim().toLowerCase();

  if (v === "2" || v === "cat" || v.includes("кот") || v.includes("кіт")) return "cat";
  return "dog";
}

function getPetSpeciesKey(pet) {
  return normalizeSpecies(pet?.species);
}

async function openVisitModalForEdit(visitId) {
  const modal = $("#visitModal");
  if (!modal) return alert("Не знайдено #visitModal в HTML");

  const v = await fetchVisitById(visitId);
  if (!v) return alert("Візит не знайдено");

  modal.dataset.visitId = String(visitId);

  $("#visitDate").value = v.date || todayISO();
  $("#visitNote").value = v.note || "";
  $("#visitDx").value = "";
  $("#visitWeight").value = v.weight_kg || "";
  $("#visitRx").value = v.rx || "";

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}
// =========================
// PATIENT UI — server-first
// =========================
function initPatientUI() {
  $("#btnBackOwner")?.addEventListener("click", () => {
    if (state.selectedOwnerId) openOwner(state.selectedOwnerId);
    else setHash("owners");
  });

  // ➕ create visit (server)
  $("#btnAddVisit")?.addEventListener("click", () => {
    const pet = state.selectedPet;
    if (!pet) return alert("Пацієнт не обраний");
    openVisitModalForCreate(pet);
  });

  // list clicks: delete / edit / open
  $("#visitsList")?.addEventListener("click", async (e) => {
    // 🗑 delete visit (server)
    const delBtn = e.target.closest("[data-del-visit]");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();

      const visitId = delBtn.dataset.delVisit;
      if (!visitId) return;

      if (!confirm("Видалити цей візит?")) return;

      const ok = await deleteVisitApi(visitId);
      if (!ok) {
        alert("Не вдалося видалити візит.");
        return;
      }

      // ✅ обновим список визитов пациента с сервера
      if (state.selectedPetId) {
        await renderVisits(state.selectedPetId); // server (getVisitsByPetId)
      }
      return;
    }

    // ✏️ edit visit (server)
    const editBtn = e.target.closest("[data-edit-visit]");
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();

      const visitId = editBtn.dataset.editVisit;
      if (visitId) await openVisitModalForEdit(visitId);
      return;
    }

    // ➡️ open visit
    const item = e.target.closest(".item");
if (!item) return;

const visitId = item.dataset.openVisit; // ✅ правильно
if (visitId) openVisit(visitId);
  });

  // ✅ ВАЖНО: биндим файлы 1 раз, независимо от вкладок
  if (!state.visitFilesUiBound) initVisitFilesUI();
}

// =========================
// VISIT FILES UI — server-first + safe fallback
// =========================
function initVisitFilesUI() {
  // ---------- Upload files -> server -> meta -> (try attach) -> local links ----------
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

      // сервер может вернуть files[] или data[]
      const savedMeta = Array.isArray(json.files)
        ? json.files
        : Array.isArray(json.data)
          ? json.data
          : [];

      if (!savedMeta.length) throw new Error("Сервер не повернув файли");

      // сохраняем meta локально
      upsertFilesFromServerMeta(savedMeta);

      // получаем fileIds (local)
      const fileIds = savedMeta
        .map((m) => (m?.stored_name ? fileIdFromStored(m.stored_name) : null))
        .filter(Boolean);

     // ✅ Привязка файлов к визиту — пока ЛОКАЛЬНО.
// (server endpoint /api/visits/:id/files пока отсутствует)
try {
  // уже есть savedMeta и fileIds выше по коду
  linkFilesToVisit(visitId, fileIds);

  // перерисуем список файлов, если функция реально существует
  if (typeof renderVisitFiles === "function") {
    renderVisitFiles(visitId);
  }
} catch (attachErr) {
  console.warn("⚠️ local attach files failed:", attachErr);
  // даже если упало — не валим весь экран
}
    } catch (err) {
      console.error(err);
      alert("Помилка завантаження: " + (err?.message || err));
      if (state.selectedVisitId && typeof renderVisitFiles === "function") {
  renderVisitFiles(state.selectedVisitId);
}
    } finally {
      // сброс input
      try { e.target.value = ""; } catch {}
    }
  });

  // ---------- Actions on files list: detach / delete ----------

  state.visitFilesUiBound = true;
}
// =========================
// VISIT MODAL — buttons + SAVE (server-first, safe)
// =========================

// modal buttons
$("#visitCancel")?.addEventListener("click", closeVisitModal);
$("#visitClose")?.addEventListener("click", closeVisitModal);
$("#visitModal")?.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeVisitModal();
});

// save visit (create/edit) — server-first
$("#visitSave")?.addEventListener("click", async () => {
  try {
    const modal = $("#visitModal");
    const editVisitId = modal?.dataset?.visitId || ""; // ✅ set in openVisitModalForEdit; empty in create

    const pet = state.selectedPet;
    if (!pet) return alert("Пацієнт не обраний");

    const date = ($("#visitDate")?.value || todayISO()).trim();
    const notePlain = ($("#visitNote")?.value || "").trim();
    const dx = ($("#visitDx")?.value || "").trim();
    const weight = ($("#visitWeight")?.value || "").trim();
    const rx = ($("#visitRx")?.value || "").trim();

    if (!notePlain && !dx && !rx) return alert("Заповни хоча б щось");

    // базовый payload
    const payload = {
  pet_id: pet.id,
  date,
  note: buildVisitNote(dx, notePlain),
  rx,
  weight_kg: weight,

  // ✅ ВСЕГДА дублируем в *_json чтобы сервер точно хранил
  services: [],
  services_json: [],
  stock: [],
  stock_json: [],
};

    // =========================
    // EDIT (server)
    // =========================
    if (editVisitId) {
      // тянем визит с сервера, чтобы не потерять services/stock
      const current = await fetchVisitById(editVisitId);
      if (!current) return alert("Візит не знайдено");

      payload.services = safeVisitArray(current.services, current.services_json);
payload.services_json = payload.services;

payload.stock = safeVisitArray(current.stock, current.stock_json);
payload.stock_json = payload.stock;

      const updated = await updateVisitApi(editVisitId, payload);
      if (!updated) return;

      closeVisitModal();

      // ✅ обновим список визитов пациента (server)
      if (state.selectedPetId) await renderVisits(state.selectedPetId);

      // ✅ переоткроем визит (server)
      await openVisit(editVisitId);

      // если пользователь на вкладке visits — перерендерим
      if (state.route === "visits") renderVisitsTab();
      return;
    }

    // =========================
    // CREATE (server)
    // =========================
    payload.services = Array.isArray(payload.services) ? payload.services : [];
payload.services_json = payload.services;

payload.stock = Array.isArray(payload.stock) ? payload.stock : [];
payload.stock_json = payload.stock;
    const created = await createVisitApi(payload);
    if (!created?.id) return;

    closeVisitModal();

    if (state.selectedPetId) await renderVisits(state.selectedPetId);

    await openVisit(created.id);

    if (state.route === "visits") renderVisitsTab();
  } catch (e) {
    console.error(e);
    alert("Помилка: " + (e?.message || e));
  }
});

// =========================
// VISIT PAGE UI (buttons on visit page)
// =========================
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
      headers: { Accept: "application/json" },
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

  // ✅ обновим patients с сервера
  await loadPatientsApi();

  // если сейчас открыт этот пациент — уходим на список
  if (state.selectedPetId === petId) {
    state.selectedPetId = null;
    state.selectedPet = null;
    state.selectedVisitId = null;
    setHash("patients");
  }

  // перерисуем
  if (state.route === "patients") renderPatientsTab();
  if (state.selectedOwnerId) renderOwnerPage(state.selectedOwnerId);
  if (state.route === "visits") renderVisitsTab();
}

async function deleteVisitEverywhere(visitId) {
  if (!visitId) return false;

  if (!confirm("Видалити візит назавжди?")) return false;

  const ok = await deleteVisitApi(visitId);
  if (!ok) return false;

  // ✅ если сейчас открыт этот визит — уйти назад
  if (state.selectedVisitId === visitId) {
    state.selectedVisitId = null;
    if (state.selectedPetId) openPatient(state.selectedPetId);
    else setHash("visits");
  }

  // ✅ обновить списки (server)
  if (state.route === "visits") renderVisitsTab();
  if (state.selectedPetId) await renderVisits(state.selectedPetId);

  return true;
}

function loadStock() {
  return LS.get(STOCK_KEY, []);
}
function saveStock(items) {
  LS.set(STOCK_KEY, items);
}
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

function medcardPromptEntry(existing = {}) {
  const today = typeof todayISO === "function"
    ? todayISO()
    : new Date().toISOString().slice(0, 10);

  const entry_date = (prompt("Дата запису:", existing.entry_date || today) || "").trim();
  if (!entry_date) return null;

  const entry_time = (prompt("Час запису, наприклад 18:40:", existing.entry_time || "") || "").trim();

  return {
    entry_date,
    entry_time,

    weight_kg: (prompt("Вага кг:", existing.weight_kg || "") || "").trim(),
    temperature: (prompt("Температура:", existing.temperature || "") || "").trim(),

    appetite: (prompt("Апетит:", existing.appetite || "") || "").trim(),
    water: (prompt("Вода / спрага:", existing.water || "") || "").trim(),
    urine: (prompt("Сечовипускання:", existing.urine || "") || "").trim(),
    stool: (prompt("Кал:", existing.stool || "") || "").trim(),

    mucosa: (prompt("Слизові / ясна:", existing.mucosa || "") || "").trim(),
    breathing: (prompt("Дихання:", existing.breathing || "") || "").trim(),
    pulse: (prompt("Пульс / серце:", existing.pulse || "") || "").trim(),

    condition: (prompt("Загальний стан:", existing.condition || "") || "").trim(),
    treatment: (prompt("Що зроблено / введено:", existing.treatment || "") || "").trim(),
    dynamics: (prompt("Динаміка:", existing.dynamics || "") || "").trim(),
    plan: (prompt("План / контроль:", existing.plan || "") || "").trim(),

    doctor: (prompt("Лікар:", existing.doctor || "") || "").trim(),
    note: (prompt("Додаткова нотатка:", existing.note || "") || "").trim(),
  };
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

      ${
        x.condition
          ? `<div class="medBlock"><div class="history-label">Стан</div><div>${escapeHtml(x.condition)}</div></div>`
          : ""
      }

      ${
        x.treatment
          ? `<div class="medBlock"><div class="history-label">Проведено / призначено</div><div>${escapeHtml(x.treatment)}</div></div>`
          : ""
      }

      ${
        x.dynamics
          ? `<div class="medBlock"><div class="history-label">Динаміка</div><div>${escapeHtml(x.dynamics)}</div></div>`
          : ""
      }

      ${
        x.plan
          ? `<div class="medBlock"><div class="history-label">План</div><div>${escapeHtml(x.plan)}</div></div>`
          : ""
      }

      ${
        x.note
          ? `<div class="medBlock"><div class="history-label">Нотатка</div><div>${escapeHtml(x.note)}</div></div>`
          : ""
      }

      ${
        x.doctor
          ? `<div class="medDoctor">👩‍⚕️ ${escapeHtml(x.doctor)}</div>`
          : ""
      }
    </div>
  `;
}

async function renderMedcardTab(pet) {
  const box = $("#patientTabContent");
  if (!box || !pet) return;

  box.innerHTML = `<div class="hint">Завантаження веткартки…</div>`;

  const items = await loadMedcardApi(pet.id);

  box.innerHTML = `
    <div class="patientInfoBox">
      <div class="row" style="align-items:flex-start; gap:12px;">
        <div>
          <h2 style="margin:0;">Ветеринарна картка</h2>
          <div class="hint">
            Медичний щоденник пацієнта: стан, температура, лікування, динаміка, план.
          </div>
        </div>

        <button class="primary" id="btnAddMedcardEntry" type="button">+ Запис</button>
      </div>

      <div id="medcardList" class="medcardList">
        ${
          items.length
            ? items.map(renderMedcardEntryCard).join("")
            : `<div class="hint">Поки записів немає. Натисни “+ Запис”.</div>`
        }
      </div>
    </div>
  `;

  $("#btnAddMedcardEntry")?.addEventListener("click", async () => {
    const payload = medcardPromptEntry();
    if (!payload) return;

    const created = await createMedcardApi(pet.id, payload);
    if (!created) return;

    await renderMedcardTab(pet);
  });

  $("#medcardList")?.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-medcard]");
    if (del) {
      const id = del.dataset.delMedcard;
      if (!id) return;

      if (!confirm("Видалити запис веткартки?")) return;

      const ok = await deleteMedcardApi(id);
      if (ok) await renderMedcardTab(pet);
      return;
    }

    const edit = e.target.closest("[data-edit-medcard]");
    if (edit) {
      const id = edit.dataset.editMedcard;
      if (!id) return;

      const current = items.find((x) => String(x.id) === String(id));
      if (!current) return alert("Запис не знайдено");

      const payload = medcardPromptEntry(current);
      if (!payload) return;

      const updated = await updateMedcardApi(id, payload);
      if (!updated) return;

      await renderMedcardTab(pet);
    }
  });
}

// =========================
// INIT
// =========================
async function init() {
  initTabs();
  seedIfEmpty();

  // legacy migration (может отсутствовать)
  if (typeof migrateLegacyVisitFilesIfNeeded === "function") {
    await migrateLegacyVisitFilesIfNeeded();
  }

  initOwnersUI();
  initOwnerUI();
  initPatientUI();
  initVisitUI();
  initDischargeModalUI();

  // услуги оставляем локально (как есть)
  // renderServicesTab();
  // renderStockTab();

  $("#btnReload")?.addEventListener("click", async () => {
    await loadMe();
    await loadOwners();
    await loadPatientsApi();
    await loadServicesApi();
  });

  // 🔍 Глобальный поиск без потери фокуса
  $("#globalSearch")?.addEventListener("input", () => {
    if (state.route === "owners") renderOwners();
    if (state.route === "patients") renderPatientsTab();
    if (state.route === "visits") renderVisitsTab();
  });

  await loadMe();
  await loadOwners();
  await loadPatientsApi();
  await loadServicesApi();
}

// ===== iOS / Telegram WebApp viewport fix =====
function setVH() {
  document.documentElement.style.setProperty("--vh", `${window.innerHeight * 0.01}px`);
}
setVH();
window.addEventListener("resize", setVH);

// ===== INIT =====
init();

// =========================
// VISIT FILES render (minimal)
// =========================
function renderVisitFiles(visitId) {
  const wrap = document.getElementById("visitFilesList");
  if (!wrap) return; // если блока нет в HTML — тихо выходим

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

  // один обработчик на wrap
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