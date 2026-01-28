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
  patients: [], // ✅ список пациентов с сервера
  visits: [],   // ✅ список визитов с сервера (по выбранному пациенту или все)

  selectedOwnerId: null,
  selectedPetId: null,
  selectedPet: null,
  selectedVisitId: null,

  dischargeListenersBound: false,
  printCssInjected: false,

  servicesUiBound: false,
  stockUiBound: false,
  visitFilesUiBound: false,

  // ✅ Visits cache (server)
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

async function fetchVisitById(id) {
  if (!id) return null;

  // loadVisitsApi у тебя ниже уже делает "массивизацию" и кеширование,
  // но тут страхуемся на случай странного ответа
  const data = await loadVisitsApi({ id });

  const arr = Array.isArray(data) ? data : (data ? [data] : []);
  const v = arr[0] || null;

  if (v?.id != null) state.visitsById.set(String(v.id), v);
  return v;
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
  const id = (idRaw || null);

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
      { id: "svc_exam", name: "Огляд", price: 500, active: true },
      { id: "svc_trip", name: "Виїзд", price: 1500, active: true },
      { id: "svc_vax", name: "Вакцинація", price: 800, active: true },

      // (можеш залишити або прибрати)
      { id: "svc_consult", name: "Консультація", price: 500, active: true },
      { id: "svc_cat_castr", name: "Кастрація кота", price: 2500, active: true },
      { id: "svc_dog_castr", name: "Кастрація пса", price: 3500, active: true },
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

    cacheVisits(arr);
    return arr;
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
    const res = await fetch(`/api/visits/${encodeURIComponent(visitId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      console.error("API /visits PUT HTTP", res.status, text);
      alert(`Помилка сервера при оновленні візиту (HTTP ${res.status})`);
      return null;
    }

    if (!json || !json.ok) {
      console.error("API /visits PUT bad json:", json, text);
      alert(json?.error || "Помилка оновлення візиту");
      return null;
    }

    const updated = Array.isArray(json.data) ? (json.data[0] || null) : (json.data || null);
    if (updated?.id) cacheVisits([updated]);
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
  const current = await fetchVisitById(visitId);
  if (!current) return false;

  const payload = {
    pet_id: current.pet_id,
    date: current.date,
    note: current.note,
    rx: current.rx,
    weight_kg: current.weight_kg,
    services: Array.isArray(servicesArr) ? servicesArr : [],
    stock: Array.isArray(current.stock) ? current.stock : [],
  };

  const updated = await updateVisitApi(visitId, payload);
  return !!updated;
}

async function pushVisitStockToServer(visitId, stockArr) {
  const current = await fetchVisitById(visitId);
  if (!current) return false;

  const payload = {
    pet_id: current.pet_id,
    date: current.date,
    note: current.note,
    rx: current.rx,
    weight_kg: current.weight_kg,
    services: Array.isArray(current.services) ? current.services : [],
    stock: Array.isArray(stockArr) ? stockArr : [],
  };

  const updated = await updateVisitApi(visitId, payload);
  return !!updated;
}

async function deleteVisitApi(visitId) {
  try {
    const res = await fetch(`/api/visits/${encodeURIComponent(visitId)}`, {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" },
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

    // почистим кеш визитов
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
  const arr = Array.isArray(state.owners) && state.owners.length
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
// SERVICES registry (LOCAL registry ok)
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

// =========================
// ✅ SERVER: add/remove service line in VISIT
// =========================
async function addServiceLineToVisit(visitId, serviceId, qty = 1, { snap = true } = {}) {
  if (!visitId || !serviceId) return false;

  const current = await fetchVisitById(visitId);
  if (!current) return false;

  ensureVisitServicesShape(current);

  const svc = getServiceById(serviceId);
  if (!svc) return false;

  const line = {
    serviceId,
    qty: Math.max(1, Number(qty) || 1),
  };

  if (snap) {
    line.priceSnap = Number(svc.price) || 0;
    line.nameSnap = String(svc.name || "").trim();
  }

  const nextServices = [...current.services, line];

  const ok = await pushVisitServicesToServer(visitId, nextServices);
  if (!ok) return false;

  // обновим локальный кеш визита (чтобы UI сразу видел новое)
  const fresh = await fetchVisitById(visitId);
  if (fresh?.id) cacheVisits([fresh]);

  return true;
}

async function removeServiceLineFromVisit(visitId, index) {
  if (!visitId) return false;

  const current = await fetchVisitById(visitId);
  if (!current) return false;

  ensureVisitServicesShape(current);

  const idx = Number(index);
  if (!Number.isFinite(idx)) return false;
  if (idx < 0 || idx >= current.services.length) return false;

  const nextServices = current.services.slice();
  nextServices.splice(idx, 1);

  const ok = await pushVisitServicesToServer(visitId, nextServices);
  if (!ok) return false;

  const fresh = await fetchVisitById(visitId);
  if (fresh?.id) cacheVisits([fresh]);

  return true;
}

// =========================
// Helpers for totals / A4
// =========================
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
  { snap = true, decrement = true } = {}
) {
  if (!visitId || !stockId) return false;

  const current = await fetchVisitById(visitId);
  if (!current) return false;

  ensureVisitStockShape(current);

  const it = getStockById(stockId);
  if (!it || it.active === false) return false;

  const q = Math.max(1, Number(qty) || 1);

  // ✅ decrement from LOCAL stock registry
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

  const nextStock = [...current.stock, line];

  const ok = await pushVisitStockToServer(visitId, nextStock);
  if (!ok) return false;

  // обновим кеш визита
  const fresh = await fetchVisitById(visitId);
  if (fresh?.id) cacheVisits([fresh]);

  return true;
}

// ✅ SERVER: remove stock line from VISIT + (optionally) restore local STOCK registry
async function removeStockLineFromVisit(visitId, index, { restore = true } = {}) {
  if (!visitId) return false;

  const current = await fetchVisitById(visitId);
  if (!current) return false;

  ensureVisitStockShape(current);

  const idx = Number(index);
  if (!Number.isFinite(idx)) return false;
  if (idx < 0 || idx >= current.stock.length) return false;

  const line = current.stock[idx];

  const nextStock = current.stock.slice();
  nextStock.splice(idx, 1);

  const ok = await pushVisitStockToServer(visitId, nextStock);
  if (!ok) return false;

  // ✅ restore into LOCAL stock registry
  if (restore && line?.stockId) {
    const stock = loadStock();
    const sidx = stock.findIndex((x) => x.id === line.stockId);
    if (sidx >= 0) {
      const curQty = Number(stock[sidx].qty) || 0;
      const q = Math.max(1, Number(line.qty) || 1);
      stock[sidx].qty = curQty + q;
      saveStock(stock);
    }
  }

  // обновим кеш визита
  const fresh = await fetchVisitById(visitId);
  if (fresh?.id) cacheVisits([fresh]);

  return true;
}

// =========================
// ✅ STOCK lines inside VISIT (snapshot) + totals
// =========================
function expandStockLines(visit) {
  const lines = Array.isArray(visit?.stock) ? visit.stock : [];

  return lines
    .filter((line) => line && line.stockId)
    .map((line) => {
      const it = getStockById(line.stockId);

      const name = String(line.nameSnap || it?.name || "Невідома позиція").trim();
      const unit = String(line.unitSnap || it?.unit || "шт").trim();

      const priceSnapNum = Number(line.priceSnap);
      const price = Number.isFinite(priceSnapNum) ? priceSnapNum : Number(it?.price || 0);

      const qty = Math.max(1, Number(line.qty) || 1);
      const lineTotal = (Number(price) || 0) * qty;

      return { name, unit, price: Number(price) || 0, qty, lineTotal };
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
// ✅ SERVICES UI (registry)
// =========================
function initServicesUI() {
  const page = $(`.page[data-page="services"]`);
  if (!page) return;

  // add
  $("#btnAddService", page)?.addEventListener("click", async () => {
    const name = (prompt("Назва послуги:", "") || "").trim();
    if (!name) return;

    const priceRaw = (prompt("Ціна (грн):", "0") || "0").trim();
    const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

    const id =
      "svc_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2);

    const items = loadServices();
    items.unshift({ id, name, price, active: true });
    saveServices(items);

    renderServicesTab();
    await refreshVisitUIIfOpen();
  });

  // actions: edit/toggle/delete
  $("#servicesList", page)?.addEventListener("click", async (e) => {
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

      const priceRaw =
        (prompt("Ціна (грн):", String(cur.price ?? 0)) || "0").trim();
      const price = Math.max(0, Number(priceRaw.replace(",", ".")) || 0);

      items[idx] = { ...cur, name, price };
      saveServices(items);
      renderServicesTab();

      await refreshVisitUIIfOpen();
      return;
    }

    if (action === "toggle") {
      items[idx].active = items[idx].active === false ? true : false;
      saveServices(items);
      renderServicesTab();

      await refreshVisitUIIfOpen();
      return;
    }

    if (action === "del") {
      const cur = items[idx];
      if (!confirm(`Видалити послугу "${cur.name}"?`)) return;

      items.splice(idx, 1);
      saveServices(items);
      renderServicesTab();

      await refreshVisitUIIfOpen();
      return;
    }
  });

  state.servicesUiBound = true;
}

// =========================
// ✅ STOCK UI (registry)
// =========================
function initStockUI() {
  const page = $(`.page[data-page="stock"]`);
  if (!page) return;

  // add
  $("#btnAddStock", page)?.addEventListener("click", async () => {
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
  $("#stockList", page)?.addEventListener("click", async (e) => {
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
      const qtyRaw =
        (prompt("Новий залишок:", String(cur.qty ?? 0)) || "0").trim();
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

  state.stockUiBound = true;
}

function renderServicesTab() {
  const page = document.querySelector('.page[data-page="services"]');
  if (!page) return;

  const items = loadServices();

  page.innerHTML = `
    <div class="card">
      <div class="row">
        <h2>Послуги</h2>
        <button id="btnAddService" class="btn">+ Додати</button>
      </div>

      <div class="hint">Локальний реєстр послуг (поки що). Активні — доступні у візиті.</div>
      <div id="servicesList" class="list"></div>
    </div>
  `;

  const list = page.querySelector("#servicesList");
  if (!list) return;

  if (!items.length) {
    list.innerHTML = `<div class="hint">Поки порожньо. Натисни “Додати”.</div>`;
  } else {
    list.innerHTML = items.map((s) => `
      <div class="item">
        <div class="left" style="width:100%">
          <div class="name">${escapeHtml(s.name || "—")}</div>
          <div class="meta">${escapeHtml(String(Number(s.price)||0))} грн • ${s.active === false ? "❌ вимкнено" : "✅ активно"}</div>
          <div class="pill">id: ${escapeHtml(s.id)}</div>
        </div>
        <div class="right" style="display:flex; gap:6px;">
          <button class="iconBtn" data-svc-action="edit" data-svc-id="${escapeHtml(s.id)}">✏️</button>
          <button class="iconBtn" data-svc-action="toggle" data-svc-id="${escapeHtml(s.id)}">⚡️</button>
          <button class="iconBtn" data-svc-action="del" data-svc-id="${escapeHtml(s.id)}">🗑</button>
        </div>
      </div>
    `).join("");
  }

  if (!state.servicesUiBound) initServicesUI();
}

function renderStockTab() {
  const page = document.querySelector('.page[data-page="stock"]');
  if (!page) return;

  const items = []; // временно, чтобы приложение ожило

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

  if (!state.stockUiBound) initStockUI();
}
// =========================
// ✅ Files schema (LOCAL cache of server files meta)
// =========================
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
    loadVisitFiles().filter((l) => !(l.visit_id === visitId && l.file_id === fileId))
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

// =========================
// ✅ Migration: legacy visit.files -> files + visit_files
// =========================
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
    pagebreak: { mode: ["avoid-all"] },
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

    const blobUrl = URL.createObjectURL(pdfBlob);

    const tg =
      window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

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

// =========================
// OWNERS — server state rendering
// =========================
function renderOwners() {
  const list = $("#ownersList");
  if (!list) return;

  list.innerHTML = "";

  const owners = Array.isArray(state.owners) ? state.owners : [];

  if (!owners.length) {
    list.innerHTML = `<div class="hint">Пока пусто. Нажми “Добавить”.</div>`;
    return;
  }

  owners.forEach((owner) => {
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

// =========================
// VISITS TAB — SERVER ONLY (state.visits from /api/visits)
// =========================
async function renderVisitsTab() {
  const page = $(`.page[data-page="visits"]`);
  if (!page) return;

  const list = $("#visitsTabList", page) || $("#visitsList", page);
  const search = $("#visitsSearch", page);
  if (!list) return;

  // если визиты ещё не загружены — загрузим с сервера
  if (!Array.isArray(state.visits) || !state.visits.length) {
    list.innerHTML = `<div class="hint">Завантаження візитів…</div>`;
    const arr = await loadVisitsApi(); // ✅ server
    state.visits = Array.isArray(arr) ? arr : [];
  }

  const visits = Array.isArray(state.visits) ? state.visits : [];

  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients(); // fallback

  const owners =
    Array.isArray(state.owners) && state.owners.length
      ? state.owners
      : LS.get(OWNERS_KEY, []); // fallback

  const petById = new Map((patients || []).map((p) => [p.id, p]));
  const ownerById = new Map((owners || []).map((o) => [o.id, o]));

  const q = (search?.value || "").trim().toLowerCase();
  const sorted = visits
    .slice()
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));

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
      ? `${pet.name || "—"}${pet.species ? " • " + pet.species : ""}${
          pet.breed ? " • " + pet.breed : ""
        }`
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
        ${
          v.note
            ? `<div class="meta" style="opacity:.9;margin-top:6px;">${escapeHtml(
                v.note
              )}</div>`
            : ""
        }
      </div>
      <div class="right" style="display:flex; gap:6px;">
        <button class="iconBtn" title="Відкрити" data-open-visit="${escapeHtml(
          v.id
        )}">➡️</button>
        <button class="iconBtn" title="Видалити" data-del-visit="${escapeHtml(
          v.id
        )}">🗑</button>
      </div>
    `;

    // чтобы клик по кнопкам не открывал карточку
    el.querySelectorAll("[data-open-visit],[data-del-visit]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    list.appendChild(el);
  });

  // ✅ один обработчик на список
  list.onclick = async (e) => {
    const delBtn = e.target.closest("[data-del-visit]");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      const vid = delBtn.dataset.delVisit;
      if (!vid) return;
      if (!confirm("Видалити візит?")) return;

      const ok = await deleteVisitApi(vid);
      if (ok) {
        // перезагрузим с сервера и перерисуем
        const arr = await loadVisitsApi();
        state.visits = Array.isArray(arr) ? arr : [];
        renderVisitsTab();
      }
      return;
    }

    const openBtn = e.target.closest("[data-open-visit]");
    const openCard = e.target.closest("[data-open-visit],[data-open-visit-card],[data-open-visit-row],[data-open-visit]");
    const zone = openBtn || e.target.closest("[data-open-visit]") || e.target.closest("[data-open-visit-card]") || e.target.closest("[data-open-visit-row]");

    const open = e.target.closest("[data-open-visit]") || e.target.closest("[data-open-visit-card]") || e.target.closest("[data-open-visit-row]");
    const card = e.target.closest("[data-open-visit]");
    if (card) {
      const vid = card.dataset.openVisit;
      if (vid) openVisit(vid);
      return;
    }

    // клик по самой карточке
    const item = e.target.closest(".item[data-open-visit]");
    if (item?.dataset?.openVisit) openVisit(item.dataset.openVisit);
  };
}

// =========================
// OWNER PAGE — server first patients list
// =========================
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

  // ✅ server-first patients
  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients(); // fallback

  const pets = (patients || []).filter((p) => p.owner_id === ownerId);

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
      <div class="left" data-open-pet="${escapeHtml(
        pet.id
      )}" style="width:100%; cursor:pointer;">
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
        <button class="iconBtn" title="Удалить" data-del-pet="${escapeHtml(
          pet.id
        )}">🗑</button>
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
  // ✅ server-first patients
  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients(); // fallback только если state пустой

  const pet = (patients || []).find((p) => String(p.id) === String(petId));
  if (!pet) return alert("Пацієнт не знайдено");

  state.selectedPetId = String(petId);
  state.selectedPet = pet;
  state.selectedOwnerId = pet.owner_id || state.selectedOwnerId;

  const patientName = $("#patientName");
  const patientMeta = $("#patientMeta");

  if (patientName) patientName.textContent = pet.name || "Пацієнт";
  if (patientMeta) {
    patientMeta.textContent =
      `${pet.species || ""}${pet.breed ? " • " + pet.breed : ""}${
        pet.age ? " • " + pet.age : ""
      }${pet.weight_kg ? " • " + pet.weight_kg + " кг" : ""}`.trim() || "—";
  }

  // ✅ visits from server
  renderVisits(String(petId));

  setRoute("patient");
  if (opts.pushHash) setHash("patient", petId);
}

// =========================
// Patient -> Visits list (SERVER)
// =========================
async function renderVisits(petId) {
  const list = $("#visitsList");
  if (!list) return;

  list.innerHTML = `<div class="hint">Завантаження…</div>`;

  const visits = await getVisitsByPetId(petId); // already server: loadVisitsApi({pet_id})
  list.innerHTML = "";

  if (!visits.length) {
    list.innerHTML = `<div class="hint">Поки візитів немає. Натисни “+ Візит”.</div>`;
    return;
  }

  // кешируем
  cacheVisits(visits);

  visits
    .slice()
    .sort((a, b) => String(b.id).localeCompare(String(a.id)))
    .forEach((v) => {
      const el = document.createElement("div");
      el.className = "item";
      el.dataset.openVisit = String(v.id);
      el.style.cursor = "pointer";

      el.innerHTML = `
  <div class="left" style="width:100%;">
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
    <button
      class="iconBtn"
      title="Відкрити"
      data-open-visit-btn="${escapeHtml(String(v.id))}"
    >➡️</button>

    <button
      class="iconBtn"
      title="Редагувати"
      data-edit-visit="${escapeHtml(String(v.id))}"
    >✏️</button>

    <button
      class="iconBtn"
      title="Видалити візит"
      data-del-visit="${escapeHtml(String(v.id))}"
    >🗑</button>
  </div>
`;

      // чтобы кнопки не открывали карточку
      el.querySelectorAll("[data-open-visit-btn],[data-del-visit]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
      });

      list.appendChild(el);
    });

  // один обработчик
  list.onclick = async (e) => {
    // delete visit
    const delBtn = e.target.closest("[data-del-visit]");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      const vid = delBtn.dataset.delVisit;
      if (!vid) return;
      if (!confirm("Видалити візит?")) return;

      const ok = await deleteVisitApi(vid);
      if (ok) renderVisits(petId);
      return;
    }

    // open visit
    const openBtn = e.target.closest("[data-open-visit-btn]");
    if (openBtn?.dataset?.openVisitBtn) {
      openVisit(openBtn.dataset.openVisitBtn);
      return;
    }

    const card = e.target.closest(".item[data-open-visit]");
    if (card?.dataset?.openVisit) openVisit(card.dataset.openVisit);
  };
}

// ===== Visit page =====
async function openVisit(visitId, opts = { pushHash: true }) {
  // ✅ server-first: try cache, else fetch
  let visit = getVisitByIdSync(visitId);
  if (!visit) visit = await fetchVisitById(visitId);

  if (!visit) {
    alert("Візит не знайдено");
    return;
  }

  ensureVisitServicesShape(visit);
  ensureVisitStockShape(visit);

  state.selectedVisitId = String(visitId);

  // ✅ server-first pet
  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients(); // fallback

  const pet = (patients || []).find((p) => String(p.id) === String(visit.pet_id)) || null;

  if (pet) {
    state.selectedPetId = String(pet.id);
    state.selectedPet = pet;
    state.selectedOwnerId = pet.owner_id || state.selectedOwnerId;
  }

  renderVisitPage(visit, pet);
  setRoute("visit");
  if (opts.pushHash) setHash("visit", visitId);
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

  const note = visit.note || "";
  const rx = visit.rx || "";

  // --- SERVICES ---
  ensureVisitServicesShape(visit);

  const svcOptions = loadServices()
    .filter((s) => s.active !== false)
    .map(
      (s) =>
        `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} — ${escapeHtml(
          String(Number(s.price) || 0)
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

  // --- STOCK ---
  ensureVisitStockShape(visit);

  const stkOptions = loadStock()
    .filter((it) => it.active !== false)
    .map((it) => {
      const left = Number(it.qty) || 0;
      const unit = String(it.unit || "шт");
      const price = Number(it.price) || 0;
      return `<option value="${escapeHtml(it.id)}">${escapeHtml(
        it.name
      )} — ${escapeHtml(String(price))} грн/${escapeHtml(
        unit
      )} • залишок: ${escapeHtml(String(left))}</option>`;
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
  // SERVICES: add/remove -> server
  // =========================
  const svcAddBtn = $("#visitSvcAdd");
  const svcSel = $("#visitSvcSelect");
  const svcQtyEl = $("#visitSvcQty");

  if (svcAddBtn && svcSel && svcQtyEl) {
    svcAddBtn.onclick = async () => {
      const vid = state.selectedVisitId;
      if (!vid) return alert("Спочатку відкрий візит.");

      const serviceId = svcSel.value;
      if (!serviceId) return;

      const qty = Math.max(1, Number(svcQtyEl.value || 1));

      // берём свежий визит
      const current = await fetchVisitById(vid);
      if (!current) return alert("Візит не знайдено");

      ensureVisitServicesShape(current);

      const svc = getServiceById(serviceId);
      if (!svc) return alert("Послуга не знайдена");

      current.services.push({
        serviceId,
        qty: Math.max(1, Number(qty) || 1),
        priceSnap: Number(svc.price) || 0,
        nameSnap: String(svc.name || "").trim(),
      });

      const pushed = await pushVisitServicesToServer(vid, current.services);
      if (!pushed) return alert("Не вдалося зберегти послугу на сервері");

      const fresh = await fetchVisitById(vid);
      if (!fresh) return;

      ensureVisitServicesShape(fresh);
      ensureVisitStockShape(fresh);

      renderVisitPage(fresh, pet);
      renderDischargeA4(vid);
    };
  }

  // delete service line
  $("#visitSvcList")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-svc-del]");
    if (!btn) return;

    const idx = Number(btn.dataset.svcDel);
    if (!Number.isFinite(idx)) return;

    const vid = state.selectedVisitId;
    if (!vid) return;

    const current = await fetchVisitById(vid);
    if (!current) return alert("Візит не знайдено");

    ensureVisitServicesShape(current);
    if (idx < 0 || idx >= current.services.length) return;

    current.services.splice(idx, 1);

    const pushed = await pushVisitServicesToServer(vid, current.services);
    if (!pushed) return alert("Не вдалося зберегти зміни на сервері");

    const fresh = await fetchVisitById(vid);
    if (!fresh) return;

    ensureVisitServicesShape(fresh);
    ensureVisitStockShape(fresh);

    renderVisitPage(fresh, pet);
    renderDischargeA4(vid);
  });

  // =========================
  // STOCK: add/remove -> server
  // =========================
  const stkAddBtn = $("#visitStkAdd");
  const stkSel = $("#visitStkSelect");
  const stkQtyEl = $("#visitStkQty");

  if (stkAddBtn && stkSel && stkQtyEl) {
    stkAddBtn.onclick = async () => {
      const vid = state.selectedVisitId;
      if (!vid) return alert("Спочатку відкрий візит.");

      const stockId = stkSel.value;
      if (!stockId) return;

      const qty = Math.max(1, Number(stkQtyEl.value || 1));

      const current = await fetchVisitById(vid);
      if (!current) return alert("Візит не знайдено");

      ensureVisitStockShape(current);

      const it = getStockById(stockId);
      if (!it || it.active === false) return alert("Позиція складу не знайдена/вимкнена");

      const left = Number(it.qty) || 0;
      if (left < qty) return alert(`Недостатньо залишку. Доступно: ${left}`);

      current.stock.push({
        stockId,
        qty: Math.max(1, Number(qty) || 1),
        priceSnap: Number(it.price) || 0,
        nameSnap: String(it.name || "").trim(),
        unitSnap: String(it.unit || "шт").trim(),
      });

      const pushed = await pushVisitStockToServer(vid, current.stock);
      if (!pushed) return alert("Не вдалося зберегти препарат на сервері");

      // ⚠️ ВАЖНО: у тебя склад пока локальный, поэтому уменьшаем локальный остаток
      // (когда сделаем серверный склад — это уберём)
      const stock = loadStock();
      const sidx = stock.findIndex((x) => x.id === stockId);
      if (sidx >= 0) {
        stock[sidx].qty = Math.max(0, (Number(stock[sidx].qty) || 0) - qty);
        saveStock(stock);
      }

      const fresh = await fetchVisitById(vid);
      if (!fresh) return;

      ensureVisitServicesShape(fresh);
      ensureVisitStockShape(fresh);

      renderVisitPage(fresh, pet);
      renderDischargeA4(vid);
    };
  }

  // delete stock line
  $("#visitStkList")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-stk-del]");
    if (!btn) return;

    const idx = Number(btn.dataset.stkDel);
    if (!Number.isFinite(idx)) return;

    const vid = state.selectedVisitId;
    if (!vid) return;

    const current = await fetchVisitById(vid);
    if (!current) return alert("Візит не знайдено");

    ensureVisitStockShape(current);
    if (idx < 0 || idx >= current.stock.length) return;

    const removed = current.stock[idx];
    current.stock.splice(idx, 1);

    const pushed = await pushVisitStockToServer(vid, current.stock);
    if (!pushed) return alert("Не вдалося зберегти зміни на сервері");

    // локально возвращаем остаток (пока склад не серверный)
    if (removed?.stockId) {
      const stock = loadStock();
      const sidx = stock.findIndex((x) => x.id === removed.stockId);
      if (sidx >= 0) {
        stock[sidx].qty = (Number(stock[sidx].qty) || 0) + Math.max(1, Number(removed.qty) || 1);
        saveStock(stock);
      }
    }

    const fresh = await fetchVisitById(vid);
    if (!fresh) return;

    ensureVisitServicesShape(fresh);
    ensureVisitStockShape(fresh);

    renderVisitPage(fresh, pet);
    renderDischargeA4(vid);
  });
}
// =========================


/*
  =========================
  STOCK: позже
  =========================
  Мы специально НЕ биндим:
    - #visitStkAdd
    - #visitStkList
  И НЕ трогаем склад здесь, чтобы не смешивать локалку и сервер.
*/
// =========================
// DISCHARGE helpers (MUST exist)
// =========================
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
  const rx = (ex.rx ?? ex.disRx ?? visit?.rx ?? "").toString();
  const recs = (ex.recs ?? ex.disRecs ?? "").toString();
  const follow = (ex.follow ?? ex.disFollow ?? "").toString();

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

function renderDischargeA4(visitId) {
  const a4 = document.getElementById("disA4");
  if (!a4) return;

  // берём визит из кеша
  const v = getVisitByIdSync(visitId);
  if (!v) {
    a4.innerHTML = `<div class="hint">Візит не знайдено</div>`;
    return;
  }

  // pet + owner (если есть)
  const patients = (Array.isArray(state.patients) && state.patients.length) ? state.patients : loadPatients();
  const pet = (patients || []).find((p) => String(p.id) === String(v.pet_id)) || null;
  const owner = pet?.owner_id ? getOwnerById(pet.owner_id) : null;

  // discharge data (local)
  const dis = getDischarge(visitId) || {};
  const parsed = parseVisitNote(v.note || "");

  const complaint = String(dis.complaint ?? parsed.complaint ?? "").trim();
  const dx = String(dis.dx ?? parsed.dx ?? "").trim();
  const rx = String(dis.rx ?? v.rx ?? "").trim();
  const recs = String(dis.recs ?? "").trim();
  const follow = String(dis.follow ?? "").trim();

  // services/stock (если у тебя эти функции есть — отлично)
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
    if (!expandedS.length) stkHtml = `<div class="hint" style="opacity:.75">—</div>`;
    else {
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
              <tr><th>Препарат</th><th>К-сть</th><th>Ціна</th><th>Сума</th></tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr><td colspan="3">Разом</td><td>${escapeHtml(String(totalS))} грн</td></tr>
            </tfoot>
          </table>
        </div>
      `;
    }
  } catch {}

  a4.innerHTML = `
    <div class="printCard">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
        <div>
          <div style="font-weight:800;font-size:18px;">Направлення / Виписка</div>
          <div style="opacity:.85;margin-top:4px;">Doc.PUG</div>
        </div>
        <div class="pill">${escapeHtml(String(v.date || "—"))}</div>
      </div>

      <hr style="margin:12px 0; opacity:.25;" />

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <div class="history-label">Пацієнт</div>
          <div>${escapeHtml(pet?.name || "—")}</div>
          <div style="opacity:.85;font-size:13px;">
            ${escapeHtml([pet?.species, pet?.breed, pet?.age, v?.weight_kg ? `${v.weight_kg} кг` : ""].filter(Boolean).join(" • ") || "—")}
          </div>
        </div>
        <div>
          <div class="history-label">Власник</div>
          <div>${escapeHtml(owner?.name || "—")}</div>
          <div style="opacity:.85;font-size:13px;">
            ${escapeHtml([owner?.phone, owner?.note].filter(Boolean).join(" • ") || "—")}
          </div>
        </div>
      </div>

      <div class="history" style="margin-top:12px;">
        <div class="history-label">Скарги / стан</div>
        <div>${escapeHtml(complaint || "—")}</div>
      </div>

      <div class="history" style="margin-top:10px;">
        <div class="history-label">Діагноз</div>
        <div>${escapeHtml(dx || "—")}</div>
      </div>

      <div class="history" style="margin-top:10px;">
        <div class="history-label">Призначення</div>
        <div>${escapeHtml(rx || "—")}</div>
      </div>

      <div class="history" style="margin-top:10px;">
        <div class="history-label">Послуги</div>
        ${svcHtml}
      </div>

      <div class="history" style="margin-top:10px;">
        <div class="history-label">Препарати</div>
        ${stkHtml}
      </div>

      <div class="history" style="margin-top:10px;">
        <div class="history-label">Рекомендації</div>
        <div>${escapeHtml(recs || "—")}</div>
      </div>

      <div class="history" style="margin-top:10px;">
        <div class="history-label">Контроль / при погіршенні</div>
        <div>${escapeHtml(follow || "—")}</div>
      </div>
    </div>
  `;
}

// ===== Discharge modal (SERVER-safe) =====
async function openDischargeModal(visitId) {
  const modal = $("#dischargeModal");
  if (!modal) return;

  // 1) гарантируем, что визит есть (кеш или сервер)
  let visit = getVisitByIdSync(visitId);
  if (!visit) {
    visit = await fetchVisitById(visitId);
  }
  if (!visit) return alert("Візит не знайдено");

  // 2) форма + превью
  const existing = getDischarge(visitId) || null;
  fillDischargeForm(visit, existing);
  renderDischargeA4(visitId);

  modal.dataset.visitId = String(visitId);

  // bind listeners ONCE
  if (!state.dischargeListenersBound) {
    const live = () => {
      const vid = modal.dataset.visitId;
      if (vid) renderDischargeA4(vid);
    };

    ["#disComplaint", "#disDx", "#disRx", "#disRecs", "#disFollow"].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener("input", live);
    });

    // SAVE (local for now)
    $("#disSave")?.addEventListener("click", () => {
      const vid = modal.dataset.visitId;
      if (!vid) return;
      setDischarge(vid, readDischargeForm());
      renderDischargeA4(vid);
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

      // сброс старых
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


// ===== UI init (Owners) — server-first =====
function initOwnersUI() {
  // ➕ Добавить владельца
  $("#btnAddOwner")?.addEventListener("click", async () => {
    const name = (prompt("Имя владельца:") || "").trim();
    if (!name) return;

    const phone = (prompt("Телефон (необязательно):") || "").trim();
    const note = (prompt("Заметка/город (необязательно):") || "").trim();

    const created = await createOwner(name, phone, note);
    if (!created) return;

    // ✅ всегда берём актуальный список с сервера
    await loadOwners();
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

      // ✅ всегда берём актуальный список с сервера
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

  $("#btnBackOwners")?.addEventListener("click", () => setHash("owners"));
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

    const species = (prompt("Вид (пес/кот/птица…):", "пес") || "").trim();
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

      // 1) ПЫТАЕМСЯ привязать к визиту на сервере (если эндпоинт уже есть)
      //    Если эндпоинта нет — просто молча падём в fallback.
      try {
        const stored_names = savedMeta.map((m) => m?.stored_name).filter(Boolean);

        if (stored_names.length) {
          const linkRes = await fetch(`/api/visits/${encodeURIComponent(visitId)}/files`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ stored_names }),
          });

          const linkText = await linkRes.text();
          let linkJson = null;
          try { linkJson = linkText ? JSON.parse(linkText) : null; } catch {}

          if (!linkRes.ok || !linkJson || linkJson.ok !== true) {
            console.warn("⚠️ attach files endpoint not ready or failed:", linkRes.status, linkText);
            // fallback local
            linkFilesToVisit(visitId, fileIds);
          }
        } else {
          linkFilesToVisit(visitId, fileIds);
        }
      } catch (attachErr) {
        console.warn("⚠️ attach files fallback:", attachErr);
        linkFilesToVisit(visitId, fileIds);
      }

      renderVisitFiles(visitId);
    } catch (err) {
      console.error(err);
      alert("Помилка завантаження: " + (err?.message || err));
      if (state.selectedVisitId) renderVisitFiles(state.selectedVisitId);
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
      services: [],
      stock: [],
    };

    // =========================
    // EDIT (server)
    // =========================
    if (editVisitId) {
      // тянем визит с сервера, чтобы не потерять services/stock
      const current = await fetchVisitById(editVisitId);
      if (!current) return alert("Візит не знайдено");

      payload.services = Array.isArray(current.services) ? current.services : [];
      payload.stock = Array.isArray(current.stock) ? current.stock : [];

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
  return loadStock().find((x) => x.id === id) || null;
}

// =========================
// INIT
// =========================
async function init() {
  initTabs();
  seedIfEmpty();
  migrateLegacyVisitFilesIfNeeded();

  initOwnersUI();
  initOwnerUI();
  initPatientUI();
  initVisitUI();
  initVisitsTabUI();

  // услуги оставляем локально (как есть)
  // renderServicesTab();
// renderStockTab();

  $("#btnReload")?.addEventListener("click", async () => {
    await loadMe();
    await loadOwners();
    await loadPatientsApi();
  });

  await loadMe();
  await loadOwners();
  await loadPatientsApi();
}

// ===== iOS / Telegram WebApp viewport fix =====
function setVH() {
  document.documentElement.style.setProperty("--vh", `${window.innerHeight * 0.01}px`);
}
setVH();
window.addEventListener("resize", setVH);

// ===== INIT =====
init();