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
  clinicProfile: null,

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
  const username = sessionStorage.getItem("pug_active_username");

  const headers = {};

  if (orgId) {
    headers["X-Org-ID"] = orgId;
  }

  if (username) {
    headers["X-Clinic-Username"] = username;
  }

  return headers;
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
// ======================================
// Универсальное окно подтверждения удаления
// ======================================

let deleteCallback = null;

function openDeleteModal(text, callback) {
  const modal = $("#deleteModal");
  const textEl = $("#deleteModalText");

  if (!modal || !textEl) {
    console.error("Не знайдено deleteModal або deleteModalText");
    return;
  }

  textEl.innerHTML = text;
  deleteCallback = callback;
  modal.style.display = "flex";
}

function closeDeleteModal() {

    $("#deleteModal").style.display = "none";

    deleteCallback = null;
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
  "team",
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
    if (route === "team") renderTeamTab();
    if (route === "calendar") {
  state.selectedVisitId = null;

  if (
    typeof closeVisitModal ===
    "function"
  ) {
    closeVisitModal();
  }

  await renderCalendarTab();
}
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
      headers: {
        Accept: "application/json",
        ...getOrgHeaders(),
      },
    });

    const text = await res.text();

    let json = null;

    try {
      json = text
        ? JSON.parse(text)
        : null;
    } catch {}

    if (!res.ok) {
      console.error(
        "API /owners HTTP",
        res.status,
        text
      );

      alert(
        `Помилка завантаження власників (HTTP ${res.status})`
      );

      state.owners = [];

      if (state.route === "owners") {
        renderOwners();
      }

      return [];
    }

    if (!json || !json.ok) {
      console.error(
        "API /owners bad json",
        json,
        text
      );

      alert(
        json?.error ||
        "Помилка завантаження власників"
      );

      state.owners = [];

      if (state.route === "owners") {
        renderOwners();
      }

      return [];
    }

    const owners = Array.isArray(json.data)
      ? json.data
      : json.data
        ? [json.data]
        : [];

    state.owners = owners;

    LS.set(
      OWNERS_KEY,
      owners
    );

    if (state.route === "owners") {
      renderOwners();
    }

    if (
      state.route === "owner" &&
      state.selectedOwnerId
    ) {
      await renderOwnerPage(
        state.selectedOwnerId
      );
    }

    return owners;
  } catch (error) {
    console.error(
      "loadOwners failed:",
      error
    );

    alert(
      "Помилка завантаження власників (network)"
    );

    state.owners =
      Array.isArray(state.owners)
        ? state.owners
        : [];

    if (state.route === "owners") {
      renderOwners();
    }

    return [];
  }
}

// ===== API: Owners =====
async function loadPatientsApi() {
  try {
    const res = await fetch(
      "/api/patients",
      {
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...getOrgHeaders(),
        },
      }
    );

    const text =
      await res.text();

    let json = null;

    try {
      json = text
        ? JSON.parse(text)
        : null;
    } catch {}

    if (!res.ok) {
      console.error(
        "API /patients HTTP",
        res.status,
        text
      );

      alert(
        `Помилка завантаження пацієнтів (HTTP ${res.status})`
      );

      state.patients = [];

      if (state.route === "patients") {
        renderPatientsTab();
      }

      return [];
    }

    if (!json || !json.ok) {
      console.error(
        "API /patients bad json",
        json,
        text
      );

      alert(
        json?.error ||
        "Помилка завантаження пацієнтів"
      );

      state.patients = [];

      if (state.route === "patients") {
        renderPatientsTab();
      }

      return [];
    }

    const patients =
      Array.isArray(json.data)
        ? json.data
        : json.data
          ? [json.data]
          : [];

    state.patients =
      patients;

    savePatients(
      patients
    );

    // Важно: API-загрузчик больше не переключает страницу сам
    if (state.route === "patients") {
      renderPatientsTab();
    }

    if (
      state.route === "owner" &&
      state.selectedOwnerId
    ) {
      await renderOwnerPage(
        state.selectedOwnerId
      );
    }

    if (
      state.route === "patient" &&
      state.selectedPetId
    ) {
      const currentPet =
        patients.find((patient) => {
          return (
            String(patient.id) ===
            String(state.selectedPetId)
          );
        });

      if (currentPet) {
        state.selectedPet =
          currentPet;
      }
    }

    return patients;
  } catch (error) {
    console.error(
      "loadPatientsApi failed:",
      error
    );

    alert(
      "Помилка завантаження пацієнтів (network)"
    );

    state.patients = [];

    if (state.route === "patients") {
      renderPatientsTab();
    }

    return [];
  }
}

// ===== API: Patients =====
async function loadPatientsApi() {
  try {
    const res = await fetch("/api/patients", {
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...getOrgHeaders(),
      },
    });

    const text = await res.text();

    let json = null;

    try {
      json = text
        ? JSON.parse(text)
        : null;
    } catch {}

    if (!res.ok) {
      console.error(
        "API /patients HTTP",
        res.status,
        text
      );

      alert(
        `Помилка завантаження пацієнтів (HTTP ${res.status})`
      );

      state.patients = [];

      if (state.route === "patients") {
        renderPatientsTab();
      }

      if (
        state.route === "owner" &&
        state.selectedOwnerId
      ) {
        await renderOwnerPage(
          state.selectedOwnerId
        );
      }

      return [];
    }

    if (!json || !json.ok) {
      console.error(
        "API /patients bad json",
        json,
        text
      );

      alert(
        json?.error ||
        "Помилка завантаження пацієнтів"
      );

      state.patients = [];

      if (state.route === "patients") {
        renderPatientsTab();
      }

      if (
        state.route === "owner" &&
        state.selectedOwnerId
      ) {
        await renderOwnerPage(
          state.selectedOwnerId
        );
      }

      return [];
    }

    const arr = Array.isArray(json.data)
      ? json.data
      : json.data
        ? [json.data]
        : [];

    state.patients = arr;

    savePatients(arr);

    if (state.route === "patients") {
      renderPatientsTab();
    }

    if (
      state.route === "owner" &&
      state.selectedOwnerId
    ) {
      await renderOwnerPage(
        state.selectedOwnerId
      );
    }

    return arr;
  } catch (e) {
    console.error(
      "loadPatientsApi failed:",
      e
    );

    alert(
      "Помилка завантаження пацієнтів (network)"
    );

    state.patients = [];

    if (state.route === "patients") {
      renderPatientsTab();
    }

    if (
      state.route === "owner" &&
      state.selectedOwnerId
    ) {
      await renderOwnerPage(
        state.selectedOwnerId
      );
    }

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

async function createOwner(name, phone, note = "") {
  try {
    const res = await fetch("/api/owners", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        name: String(name || "").trim(),
        phone: String(phone || "").trim(),
        note: String(note || "").trim(),
      }),
    });

    const json = await res.json();

    if (!res.ok || !json?.ok) {
      console.error("createOwner error:", json);
      alert(json?.error || "Не вдалося створити власника");
      return null;
    }

    return Array.isArray(json.data) ? json.data[0] : json.data;
  } catch (e) {
    console.error("createOwner failed:", e);
    alert("Помилка створення власника");
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
// Часть 2 (Строки 1501 — 2000) ыфв
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

async function renderTeamTab() {
  const page = document.querySelector('.page[data-page="team"]');
  if (!page) return;

  const today = typeof todayISO === "function"
    ? todayISO()
    : new Date().toISOString().slice(0, 10);

  page.innerHTML = `
    <div class="card">
      <div class="hint">Завантаження команди…</div>
    </div>
  `;

  const staff = await loadStaffApi();
  const specializations = await loadSpecializationsApi();
  const schedule = await loadStaffScheduleApi(today);

  const scheduleMap = new Map(schedule.map((x) => [String(x.staff_id), x]));

  page.innerHTML = `
    <div class="card teamPageCard">
      <div class="row" style="justify-content:space-between;align-items:center;">
        <div>
          <h2>Команда</h2>
          <div class="hint">Співробітники клініки, ставки, спеціалізації та профілі.</div>
        </div>
        <button class="primary" id="btnAddStaffTeam" type="button">+ Додати співробітника</button>
      </div>

      <div class="specPanel">
        <div class="specPanelHead">
          <div>
            <div class="specPanelTitle">Напрями клініки</div>
            <div class="hint">Створюй власні фільтри: хірург, дерматолог, екзовет, УЗД...</div>
          </div>
          <button class="primary" id="btnAddSpecTeam" type="button">+ Додати напрям</button>
        </div>

        <div class="specList">
          ${
            specializations.length
              ? specializations.map((s) => `
                <div class="specPill" style="border-left:5px solid ${escapeHtml(s.color || "#7C5CFF")}">
                  ${escapeHtml(s.name || "Напрям")}
                </div>
              `).join("")
              : `<div class="hint">Напрями ще не створені.</div>`
          }
        </div>
      </div>

      <div class="vetList">
        ${
          staff.length
            ? staff.map((doc) => {
                const row = scheduleMap.get(String(doc.id));
                const isActive = row ? row.is_active !== false : false;

                const staffColor = doc.color || "#7C5CFF";
                const staffName = doc.name || "Працівник";
                const staffLetter = staffName.trim().charAt(0).toUpperCase() || "?";

                return `
                  <div class="vetCard premiumVetCard" style="--staff-color:${escapeHtml(staffColor)};">
                    <div class="vetAvatarWrap">
                      ${
                        doc.avatar
                          ? `<img class="vetAvatarImg" src="${escapeHtml(doc.avatar)}" alt="${escapeHtml(staffName)}">`
                          : `<div class="vetAvatarLetter">${escapeHtml(staffLetter)}</div>`
                      }
                    </div>

                    <div class="vetInfo premiumVetInfo">
                      <div class="premiumVetTop">
                        <div>
                          <div class="premiumVetName">${escapeHtml(staffName)}</div>
                          <div class="premiumVetRole">${escapeHtml(doc.role || "Ветеринарний лікар")}</div>
                        </div>

                        <button 
                          class="scheduleStatus premiumStatus ${isActive ? "active" : ""}" 
                          type="button" 
                          data-team-schedule-staff-id="${escapeHtml(String(doc.id))}">
                          ${isActive ? "На зміні" : "Вихідний"}
                        </button>
                      </div>

                      <div class="premiumVetSpecs">
                        <span class="premiumSpecTag">${escapeHtml(doc.specialization || "Спеціалізація не вказана")}</span>
                      </div>

                      <div class="premiumVetMeta">
                        <div class="premiumMetaItem">
                          <span>Телефон</span>
                          <strong>${escapeHtml(doc.phone || "Не вказано")}</strong>
                        </div>

                        <div class="premiumMetaItem">
                          <span>Ставка</span>
                          <strong>${escapeHtml(String(doc.shift_rate || 0))} грн / зміна</strong>
                        </div>

                        <div class="premiumMetaItem">
                          <span>Відсоток</span>
                          <strong>${escapeHtml(String(doc.percent_rate || 0))}%</strong>
                        </div>
                      </div>
                    </div>

                    <div class="vetActions premiumVetActions">
                      <button class="ghost premiumProfileBtn" type="button" data-open-team-profile="${escapeHtml(String(doc.id))}">
                        👤 Профіль
                      </button>

                      <button class="ghost premiumEditBtn" type="button" data-edit-team-staff="${escapeHtml(String(doc.id))}">
                        ✏️ Редагувати
                      </button>
                    </div>
                  </div>
                `;
              }).join("")
            : `<div class="hint">Співробітників ще немає.</div>`
        }
      </div>
    </div>
  `;

  document.getElementById("btnAddStaffTeam")?.addEventListener("click", () => {
  if (typeof openCreateStaffModal === "function") {
    openCreateStaffModal();
  } else {
    console.warn("openCreateStaffModal не знайдена");
    alert("Форма додавання співробітника не підключена.");
  }
});

  document.getElementById("btnAddSpecTeam")?.addEventListener("click", async () => {
    const name = (prompt("Назва напряму: хірург, дерматолог, екзовет...") || "").trim();
    if (!name) return;

    const created = await createSpecializationApi({
      name,
      color: "#7C5CFF",
    });

    if (created) await renderTeamTab();
  });

  document.querySelectorAll("[data-team-schedule-staff-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const staffId = btn.dataset.teamScheduleStaffId;
      const isActive = !btn.classList.contains("active");

      const saved = await saveStaffScheduleApi({
        work_date: today,
        staff_id: staffId,
        is_active: isActive,
      });

      if (!saved) return;

      btn.classList.toggle("active", isActive);
      btn.textContent = isActive ? "На зміні" : "Вихідний";
    });
  });

  document.querySelectorAll("[data-edit-team-staff]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.editTeamStaff;
      const staffRow = staff.find((x) => String(x.id) === String(id));
      if (!staffRow) return;

      openEditStaffModal(staffRow);
    });
  });

  document.querySelectorAll("[data-open-team-profile]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.openTeamProfile;
    const staffRow = staff.find((x) => String(x.id) === String(id));
    if (!staffRow) return;

    renderTeamProfilePage(staffRow);
  });
});
}

async function renderTeamProfilePage(doc) {
  const page = document.querySelector('.page[data-page="team"]');
  if (!page) return;

  const staffName = doc.name || "Працівник";
  const staffLetter = staffName.trim().charAt(0).toUpperCase() || "?";
  const staffColor = doc.color || "#7C5CFF";

  const roleLabel =
    doc.role === "assistant" ? "Асистент" :
    doc.role === "admin" ? "Адміністратор" :
    "Ветеринарний лікар";

  const dashboard = await loadStaffDashboardApi(doc.id);
  const liveStats = await buildStaffLiveStats(doc.id);

Object.assign(dashboard, liveStats);

const career = buildStaffCareer({
  doc,
  dashboard,
  revenue: Number(dashboard.revenue || 0),
});

const careerPrefs = getStaffCareerPrefs(doc.id);

const unlockedTitles = getUnlockedCareerTitles(career);
const unlockedFrames = getUnlockedCareerFrames(career);

const selectedTitle = unlockedTitles.find((x) => x.id === careerPrefs.titleId);
const selectedFrame = unlockedFrames.find((x) => x.id === careerPrefs.frameId);

const profileTitle =
  careerPrefs.titleId === "none"
    ? ""
    : selectedTitle?.label || career.title || roleLabel;

const profileFrame =
  careerPrefs.frameId === "none"
    ? ""
    : selectedFrame?.id || career.activeFrame || "";

const profileFrameClass = profileFrame ? `frame-${profileFrame}` : "";

const profilePhoto = doc.avatar || "";

const revenue = Number(dashboard.revenue || 0);
  const visits = Number(dashboard.visits_this_month || 0);
  const checks = Number(dashboard.closed_checks || 0);
  const avgCheck = Number(dashboard.avg_check || 0);
  const rating = Number(dashboard.rating_avg || dashboard.rating || 0);

  const revenueGrowth = Number(dashboard.revenue_growth_percent || 0);
  const visitsGrowth = Number(dashboard.visits_growth_percent || 0);
  const checksGrowth = Number(dashboard.checks_growth_percent || 0);
  const avgCheckGrowth = Number(dashboard.avg_check_growth_percent || 0);

  page.innerHTML = `
  <div class="teamDashProfile" style="--staff-color:${escapeHtml(staffColor)};">

    <aside class="teamDashSidebar">
      <button class="teamBackBtn" id="btnBackToTeam" type="button">← Команда</button>

      <div class="teamDashAvatar ${escapeHtml(profileFrameClass)}">
        ${
          doc.avatar
            ? `<img src="${escapeHtml(doc.avatar)}" alt="${escapeHtml(staffName)}">`
            : `<span>${escapeHtml(staffLetter)}</span>`
        }
      </div>

      <div class="teamDashName">${escapeHtml(staffName)}</div>
${profileTitle ? `<div class="teamDashTitle">🏆 ${escapeHtml(profileTitle)}</div>` : ""}
<div class="teamDashRole">${escapeHtml(roleLabel)}</div>
      <div class="teamDashStatus">На зміні</div>

      <div class="teamDashContact">
        <div>📞 ${escapeHtml(doc.phone || "Телефон не вказано")}</div>
        <div>✉ Email не вказано</div>
      </div>

      <div class="teamDashNav" id="teamProfileNav">
  <button class="active" type="button" data-profile-tab="overview">▦ Огляд</button>
  <button type="button" data-profile-tab="analytics">📈 Аналітика</button>
  <button type="button" data-profile-tab="visits">🩺 Прийоми</button>
  <button type="button" data-profile-tab="finance">💰 Фінанси</button>
  <button type="button" data-profile-tab="achievements">🏆 Досягнення</button>
  <button type="button" data-profile-tab="settings">⚙ Налаштування</button>
</div>

      <div class="teamDashIdBox">
        <span>ID співробітника</span>
        <b>#STF-${escapeHtml(String(doc.id || "0000")).slice(0, 8)}</b>
      </div>

    </aside>

<main class="teamDashMain">

  <div class="teamDashTop">
    <div>
      <h1>${escapeHtml(staffName)} 👋</h1>
      <p>Ваші показники, досягнення та ефективність</p>
    </div>

    <div class="teamDashActions">
      <button class="teamGhostBtn" type="button">⬇ Експорт</button>
      <button class="teamPrimaryBtn" id="btnEditStaffFromFullProfile" type="button">✏️ Редагувати профіль</button>
    </div>
  </div>

  <div id="teamProfileContent"></div>

</main>
  </div>
`;



  document.getElementById("btnBackToTeam")?.addEventListener("click", () => {
    renderTeamTab();
  });

  document.getElementById("btnEditStaffFromFullProfile")?.addEventListener("click", () => {
    openEditStaffModal(doc);
  });


const profileState = {
  doc,
  dashboard,
  staffName,
  staffColor,
  roleLabel,
  revenue,
  visits,
  checks,
  avgCheck,
  rating,
  revenueGrowth,
  visitsGrowth,
  checksGrowth,
  avgCheckGrowth,
};

renderTeamProfileTab("overview", profileState);

document.querySelectorAll("[data-profile-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-profile-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    renderTeamProfileTab(btn.dataset.profileTab, profileState);
  });
});
}

function renderTeamProfileTab(tab, state) {
  const root = document.getElementById("teamProfileContent");
  if (!root) return;

  if (tab === "overview") {
  renderTeamOverviewTab(root, state);
  window.__lastTeamDashboard = state.dashboard;

  requestAnimationFrame(() => {
    renderStaffProfileCharts(state.dashboard, 6);
  });

  return;
}

  if (tab === "analytics") {
    renderTeamAnalyticsTab(root, state);
    return;
  }

  if (tab === "visits") {
    renderTeamVisitsTab(root, state);
    return;
  }

  if (tab === "finance") {
    renderTeamFinanceTab(root, state);
    return;
  }

  if (tab === "achievements") {
    renderTeamAchievementsTab(root, state);
    return;
  }


  if (tab === "settings") {
    renderTeamSettingsTab(root, state);
    return;
  }
}
function renderTeamOverviewTab(root, state) {
  const {
    dashboard,
    staffName,
    revenue,
    visits,
    checks,
    avgCheck,
    rating,
    revenueGrowth,
    visitsGrowth,
    checksGrowth,
    avgCheckGrowth,
    doc,
  } = state;

  root.innerHTML = `
    <section class="teamDashKpis">
      ${renderTeamKpiCard("💰", "Виручка", `${revenue.toLocaleString("uk-UA")} грн`, revenueGrowth)}
      ${renderTeamKpiCard("🐾", "Візити", visits, visitsGrowth)}
      ${renderTeamKpiCard("💳", "Середній чек", `${avgCheck.toLocaleString("uk-UA")} грн`, avgCheckGrowth)}
      ${renderTeamKpiCard("⭐", "Рейтинг клієнтів", rating ? rating.toFixed(2) : "—", 0)}
      ${renderTeamKpiCard("🧾", "Закрито чеків", checks, checksGrowth)}
    </section>

    <section class="teamDashInsight">
      <div class="teamInsightIcon">✨</div>
      <div>
        <b>Що варто знати сьогодні</b>
        <p>
          ${escapeHtml(staffName)} має стабільні показники: виручка змінилась на 
          <strong>${revenueGrowth}%</strong>, кількість візитів — на 
          <strong>${visitsGrowth}%</strong>. Поточний рейтинг клієнтів — 
          <strong>${rating ? rating.toFixed(2) : "—"}</strong>.
        </p>
      </div>
    </section>

    <section class="teamDashGrid">
      <div class="teamDashPanel teamDashPanelLarge">
        <div class="teamDashPanelHead">
         <h3>Виручка</h3>
          <span>грн</span>
        </div>
        <div class="teamChartBox">
          <canvas id="staffRevenueChart"></canvas>
        </div>
      </div>

      <div class="teamDashPanel teamDashPanelLarge">
        <div class="teamDashPanelHead">
          <h3>Кількість візитів</h3>
          <span>візити</span>
        </div>
        <div class="teamChartBox">
          <canvas id="staffVisitsChart"></canvas>
        </div>
      </div>

      <div class="teamDashPanel">
        <div class="teamDashPanelHead">
          <h3>🎯 Сьогодні</h3>
        </div>
        <div class="teamDashRows">
          <p><span>Статус</span><b>На зміні</b></p>
          <p><span>Записів сьогодні</span><b>0</b></p>
          <p><span>Виконано</span><b>0</b></p>
          <p><span>Попереду</span><b>0</b></p>
        </div>
      </div>

      <div class="teamDashPanel">
        <div class="teamDashPanelHead">
          <h3>🏆 Карʼєра</h3>
          <span>Level 1</span>
        </div>
        <div class="teamDashXp">
          <div><b>Рівень 1</b><span>0 / 100 XP</span></div>
          <i><em style="width:0%"></em></i>
          <p>До наступного рівня залишилось 100 XP</p>
        </div>
      </div>

      ${renderStaffSkillsPanel(doc)}

      <div class="teamDashPanel teamDashFull">
        <div class="teamDashPanelHead">
          <h3>💰 Фінансова інформація <span class="panelMutedTitle">(за цей місяць)</span></h3>
        </div>
        <div class="teamDashRows">
          <p><span>Ставка</span><b>${escapeHtml(String(doc.shift_rate || 0))} грн / зміна</b></p>
          <p><span>Відсоток</span><b>${escapeHtml(String(doc.percent_rate || 0))}%</b></p>
          <p><span>Бонуси</span><b>—</b></p>
          <p><span>Нараховано</span><b>${revenue.toLocaleString("uk-UA")} грн</b></p>
        </div>
      </div>
        </section>

  `;

  if (typeof bindStaffSkillsPanel === "function") {

    bindStaffSkillsPanel(root, state);

  }

}
function getStaffSkills(doc) {
  const raw = doc?.skills;

  if (Array.isArray(raw)) return raw;

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }

  return [];
}

function renderStaffSkillsPanel(doc) {
  const skills = getStaffSkills(doc);

  return `
    <div class="teamDashPanel staffSkillsPanel">
      <div class="teamDashPanelHead">
        <h3>🧠 Навички</h3>
        <button class="teamGhostBtn mini" id="btnAddStaffSkill" type="button">
          + Додати
        </button>
      </div>

      <div class="staffSkillsCards" id="staffSkillsList">
        ${
          skills.length
            ? skills.map((skill) => renderStaffSkillCard(skill)).join("")
            : `<p class="hint">Навички ще не додані. Наприклад: УЗД, хірургія, кастрація, неврологія.</p>`
        }
      </div>
    </div>
  `;
}

function renderStaffSkillCard(skill) {
  const icon = getSkillIcon(skill);

  return `
    <div class="staffSkillCard">
      <button class="staffSkillRemove" type="button" data-remove-skill="${escapeHtml(skill)}">×</button>
      <div class="staffSkillIcon">${icon}</div>
      <b>${escapeHtml(skill)}</b>
      <span>${escapeHtml(getSkillDescription(skill))}</span>
    </div>
  `;
}

function bindStaffSkillsPanel(root, state) {
  root.querySelector("#btnAddStaffSkill")?.addEventListener("click", () => {
    openStaffSkillModal(root, state);
  });

  root.querySelectorAll("[data-remove-skill]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const skill = btn.dataset.removeSkill;
      const skills = getStaffSkills(state.doc);
      const updatedSkills = skills.filter((s) => s !== skill);

      await updateStaffApi(state.doc.id, {
        ...state.doc,
        skills: updatedSkills,
      });

      state.doc.skills = updatedSkills;
      renderTeamOverviewTab(root, state);
    });
  });
}

function openStaffSkillModal(root, state) {
  const existing = document.querySelector(".staffSkillModalOverlay");
  existing?.remove();

  const presets = ["УЗД", "Хірургія", "Кастрація", "Неврологія", "Дерматологія", "Кардіологія"];

  const modal = document.createElement("div");
  modal.className = "staffSkillModalOverlay";

  modal.innerHTML = `
    <div class="staffSkillModal">
      <button class="staffSkillModalClose" type="button">×</button>

      <div class="staffSkillModalHead">
        <div class="staffSkillModalIcon">🧠</div>
        <div>
          <h2>Додати навичку</h2>
          <p>Вкажіть професійну навичку співробітника.</p>
        </div>
      </div>

      <label class="staffSkillField">
        <span>Назва навички</span>
        <input id="staffSkillInput" type="text" placeholder="Наприклад: УЗД, хірургія, кастрація">
      </label>

      <div class="staffSkillPresets">
        <span>Популярні навички</span>
        <div>
          ${presets.map((p) => `
            <button type="button" data-skill-preset="${escapeHtml(p)}">
              ${getSkillIcon(p)} ${escapeHtml(p)}
            </button>
          `).join("")}
        </div>
      </div>

      <div class="staffSkillModalActions">
        <button class="teamGhostBtn" type="button" id="btnCancelSkill">Скасувати</button>
        <button class="teamPrimaryBtn" type="button" id="btnSaveSkill">Додати +</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const input = modal.querySelector("#staffSkillInput");
  input?.focus();

  const close = () => modal.remove();

  modal.querySelector(".staffSkillModalClose")?.addEventListener("click", close);
  modal.querySelector("#btnCancelSkill")?.addEventListener("click", close);

  modal.querySelectorAll("[data-skill-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.skillPreset || "";
      input.focus();
    });
  });

  modal.querySelector("#btnSaveSkill")?.addEventListener("click", async () => {
    const cleanSkill = input.value.trim();
    if (!cleanSkill) return;

    const skills = getStaffSkills(state.doc);

    if (skills.some((s) => s.toLowerCase() === cleanSkill.toLowerCase())) {
      alert("Така навичка вже є.");
      return;
    }

    const updatedSkills = [...skills, cleanSkill];

    await updateStaffApi(state.doc.id, {
      ...state.doc,
      skills: updatedSkills,
    });

    state.doc.skills = updatedSkills;
    close();
    renderTeamOverviewTab(root, state);
  });
}
function getSkillIcon(skill) {
  const s = String(skill || "").toLowerCase();

  if (s.includes("узд") || s.includes("ультра")) return "🖥️";
  if (s.includes("хірур") || s.includes("хирург")) return "✂️";
  if (s.includes("кастр") || s.includes("стерил")) return "🐾";
  if (s.includes("невро")) return "🧠";
  if (s.includes("дермат")) return "🩹";
  if (s.includes("карді") || s.includes("кардио")) return "❤️";

  return "✨";
}

function getSkillDescription(skill) {
  const s = String(skill || "").toLowerCase();

  if (s.includes("узд")) return "Діагностика за допомогою ультразвуку";
  if (s.includes("хірур") || s.includes("хирург")) return "Хірургічні втручання різної складності";
  if (s.includes("кастр") || s.includes("стерил")) return "Стерилізація та кастрація тварин";
  if (s.includes("невро")) return "Діагностика та лікування нервової системи";
  if (s.includes("дермат")) return "Шкіра, шерсть, алергії та дерматологія";
  if (s.includes("карді") || s.includes("кардио")) return "Серце, судини та кардіологічна діагностика";

  return "Професійна навичка співробітника";
}

function renderTeamAnalyticsTab(root, state) {
  const visits = state.dashboard.live_staff_visits || [];
  const monthVisits = state.dashboard.live_month_visits || [];

  const totalRevenue = monthVisits.reduce((sum, v) => {
    return sum + calcServicesTotal(v) + calcStockTotal(v);
  }, 0);

  const avgCheck = monthVisits.length ? Math.round(totalRevenue / monthVisits.length) : 0;

  root.innerHTML = `
    <section class="teamSubHero">
      <div>
        <h2>📈 Аналітика</h2>
        <p>Динаміка роботи, виручка, візити та ефективність співробітника.</p>
      </div>
    </section>

    <section class="teamDashKpis">
      ${renderTeamKpiCard("💰", "Виручка за місяць", `${totalRevenue.toLocaleString("uk-UA")} грн`, 0)}
      ${renderTeamKpiCard("🐾", "Візитів за місяць", monthVisits.length, 0)}
      ${renderTeamKpiCard("💳", "Середній чек", `${avgCheck.toLocaleString("uk-UA")} грн`, 0)}
    </section>

<div class="teamChartRange">
  <button class="active" data-chart-range="1" type="button">1 місяць</button>
  <button data-chart-range="3" type="button">3 місяці</button>
  <button data-chart-range="6" type="button">6 місяців</button>
</div>


    <section class="teamDashGrid">
      <div class="teamDashPanel teamDashPanelLarge">
        <div class="teamDashPanelHead">
          <h3>${window.__staffChartRange === 1 ? "Виручка по днях" : "Виручка по місяцях"}</h3>
          <span>грн</span>
        </div>
        <div class="teamChartBox">
          <canvas id="staffRevenueChart"></canvas>
        </div>
      </div>

      <div class="teamDashPanel teamDashPanelLarge">
        <div class="teamDashPanelHead">
          <h3>${window.__staffChartRange === 1 ? "Кількість візитів по днях" : "Кількість візитів по місяцях"}</h3>
          <span>візити</span>
        </div>
        <div class="teamChartBox">
          <canvas id="staffVisitsChart"></canvas>
        </div>
      </div>

      <div class="teamDashPanel">
        <div class="teamDashPanelHead">
          <h3>🧠 Висновок</h3>
        </div>
        <div class="teamAnalyticsInsight">
          ${buildTeamAnalyticsInsight(totalRevenue, monthVisits.length, avgCheck)}
        </div>
      </div>

      <div class="teamDashPanel">
        <div class="teamDashPanelHead">
          <h3>📌 Показники</h3>
        </div>
        <div class="teamDashRows">
          <p><span>Усього прийомів</span><b>${visits.length}</b></p>
          <p><span>Прийомів цього місяця</span><b>${monthVisits.length}</b></p>
          <p><span>Виручка цього місяця</span><b>${totalRevenue.toLocaleString("uk-UA")} грн</b></p>
          <p><span>Середній чек</span><b>${avgCheck.toLocaleString("uk-UA")} грн</b></p>
        </div>
      </div>
    </section>
  `;

  window.__lastTeamDashboard = state.dashboard;
window.__staffChartRange = 1;
requestAnimationFrame(() => {
  renderStaffProfileCharts(state.dashboard, 1);

  const rangeBox = root.querySelector(".teamChartRange");
  if (!rangeBox) return;

  rangeBox.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chart-range]");
    if (!btn) return;

    const months = Number(btn.dataset.chartRange || 1);
    console.log("CHART RANGE CLICK:", months);

    rangeBox.querySelectorAll("[data-chart-range]").forEach((b) => {
      b.classList.remove("active");
    });

    btn.classList.add("active");
    renderStaffProfileCharts(state.dashboard, months);
  });
});
}
function buildTeamAnalyticsInsight(totalRevenue, visitsCount, avgCheck) {
  if (!visitsCount) {
    return `
      <p>Поки що немає достатньо даних для аналітики. Створіть кілька прийомів з цим співробітником — і CRM почне показувати динаміку.</p>
    `;
  }

  return `
    <p>
      За поточний місяць співробітник провів <b>${visitsCount}</b> прийомів
      на суму <b>${totalRevenue.toLocaleString("uk-UA")} грн</b>.
      Середній чек складає <b>${avgCheck.toLocaleString("uk-UA")} грн</b>.
    </p>
  `;
}

function renderTeamVisitsTab(root, state) {
  const visits = state.dashboard.live_staff_visits || [];
  const today = typeof todayISO === "function"
    ? todayISO()
    : new Date().toISOString().slice(0, 10);

  const monthVisits = state.dashboard.live_month_visits || [];

  const todayVisits = visits.filter((v) => {
    const d = String(v.date || v.event_date || "").slice(0, 10);
    return d === today;
  });

  const plannedVisits = visits.filter((v) => {
    const status = String(v.status || "").toLowerCase();
    return status.includes("plan") || status.includes("scheduled") || status.includes("заплан");
  });

  const sortedVisits = [...visits].sort((a, b) => {
    const da = new Date(a.date || a.event_date || a.created_at || 0);
    const db = new Date(b.date || b.event_date || b.created_at || 0);
    return db - da;
  });

  root.innerHTML = `
    <section class="teamSubHero">
      <div>
        <h2>🩺 Прийоми</h2>
        <p>Історія прийомів, пацієнти та робоча активність співробітника.</p>
      </div>
    </section>

    <section class="teamDashKpis">
      ${renderTeamKpiCard("📋", "Усього прийомів", visits.length, 0)}
      ${renderTeamKpiCard("📅", "Цього місяця", monthVisits.length, 0)}
      ${renderTeamKpiCard("🎯", "Сьогодні", todayVisits.length, 0)}
      ${renderTeamKpiCard("⏳", "Заплановано", plannedVisits.length, 0)}
    </section>

    <div class="teamVisitFilters">
      <button class="active" type="button" data-visit-filter="all">Усі</button>
      <button type="button" data-visit-filter="today">Сьогодні</button>
      <button type="button" data-visit-filter="month">Місяць</button>
      <button type="button" data-visit-filter="planned">Заплановані</button>
    </div>

    <section class="teamVisitsLayout">
      <div class="teamVisitsList" id="teamVisitsList">
        ${renderTeamVisitCards(sortedVisits)}
      </div>

      <div class="teamDashPanel">
        <div class="teamDashPanelHead">
          <h3>📌 Підсумок</h3>
        </div>
        <div class="teamDashRows">
          <p><span>Усього прийомів</span><b>${visits.length}</b></p>
          <p><span>Сьогодні</span><b>${todayVisits.length}</b></p>
          <p><span>Цього місяця</span><b>${monthVisits.length}</b></p>
          <p><span>Заплановано</span><b>${plannedVisits.length}</b></p>
        </div>
      </div>
    </section>
  `;

  root.querySelectorAll("[data-visit-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll("[data-visit-filter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const filter = btn.dataset.visitFilter;
      let filtered = sortedVisits;

      if (filter === "today") filtered = todayVisits;
      if (filter === "month") filtered = monthVisits;
      if (filter === "planned") filtered = plannedVisits;

      const list = root.querySelector("#teamVisitsList");
      if (list) list.innerHTML = renderTeamVisitCards(filtered);
    });
  });
}
function renderTeamVisitCards(visits) {
  if (!visits.length) {
    return `
      <div class="teamDashPanel teamDashFull">
        <h3>Прийомів ще немає</h3>
        <p class="hint">Коли співробітник буде проводити прийоми, вони зʼявляться тут.</p>
      </div>
    `;
  }

  return visits.map((v) => {
    const date = String(v.date || v.event_date || v.created_at || "").slice(0, 10) || "—";
    const time = String(v.time || v.start_time || "").slice(0, 5) || "—";
    const total = calcServicesTotal(v) + calcStockTotal(v);

    const petName =
      v.pet_name ||
      v.patient_name ||
      v.pet?.name ||
      "Пацієнт";

    const ownerName =
      v.owner_name ||
      v.client_name ||
      v.owner?.name ||
      "Власник не вказаний";

    const status = v.status || "Завершено";

    return `
      <div class="teamVisitCard">
        <div class="teamVisitIcon">🐾</div>

        <div class="teamVisitMain">
          <div class="teamVisitTitle">${escapeHtml(petName)}</div>
          <div class="teamVisitMeta">
            ${escapeHtml(date)} · ${escapeHtml(time)}
          </div>
          <div class="teamVisitOwner">
            Власник: ${escapeHtml(ownerName)}
          </div>
        </div>

        <div class="teamVisitRight">
          <span class="teamVisitStatus">${escapeHtml(status)}</span>
          <b>${total.toLocaleString("uk-UA")} грн</b>
          <button type="button" class="teamVisitOpenBtn" onclick="openVisitFromTeam('${escapeHtml(String(v.id || v.visit_id || v._id || ""))}')">
  Відкрити →
</button>
          </button>
        </div>
      </div>
    `;
  }).join("");
}
function openVisitFromTeam(visitId) {
  if (!visitId) return;

  const id = String(visitId);

  if (typeof openVisit === "function") {
    openVisit(id);
    return;
  }

  if (typeof openVisitModalForEdit === "function") {
    openVisitModalForEdit(id);
    return;
  }

  alert("Не вдалося відкрити візит");
}

async function renderTeamFinanceTab(root, state) {
  const doc = state.doc;
  const visits = state.dashboard.live_month_visits || [];

  const adjustments = await loadStaffAdjustmentsApi(doc.id);

  const revenue = visits.reduce((sum, v) => {
    return sum + calcServicesTotal(v) + calcStockTotal(v);
  }, 0);

  const shiftRate = Number(doc.shift_rate || 0);
  const percentRate = Number(doc.percent_rate || 0);

  const percentAmount = Math.round(revenue * (percentRate / 100));

  const bonuses = adjustments
    .filter((x) => x.type === "bonus")
    .reduce((sum, x) => sum + Number(x.amount || 0), 0);

  const penalties = adjustments
    .filter((x) => x.type === "penalty")
    .reduce((sum, x) => sum + Number(x.amount || 0), 0);

  const totalToPay = Math.max(0, shiftRate + percentAmount + bonuses - penalties);

  root.innerHTML = `
  <section class="teamSubHero">
    <div>
      <h2>💰 Фінанси</h2>
      <p>Нарахування, ставка, відсоток від виручки, бонуси та штрафи за цей місяць.</p>
    </div>
  </section>

  <section class="teamDashKpis">
    ${renderTeamKpiCard("💵", "Виручка", `${revenue.toLocaleString("uk-UA")} грн`, 0)}
    ${renderTeamKpiCard("🏦", "Ставка", `${shiftRate.toLocaleString("uk-UA")} грн`, 0)}
    ${renderTeamKpiCard("📈", "Відсоток", `${percentRate}%`, 0)}
    ${renderTeamKpiCard("✅", "До виплати", `${totalToPay.toLocaleString("uk-UA")} грн`, 0)}
  </section>

  <section class="teamVisitsLayout">

    <div class="teamDashPanel">
      <div class="teamDashPanelHead">
        <h3>🧾 Бонуси та штрафи</h3>
        <button class="teamPrimaryBtn"
                id="btnAddFinanceAdjustment"
                type="button">
          + Додати
        </button>
      </div>

      <div class="teamFinanceList">
        ${
          adjustments.length
            ? adjustments.map((a) => `
              <div class="teamFinanceRow">

                <div>
                  <b>
                    ${a.type === "bonus" ? "Бонус" : "Штраф"}
                    ·
                    ${escapeHtml(a.adjustment_date || "—")}
                  </b>

                  <span>
                    ${escapeHtml(a.reason || "Без коментаря")}
                  </span>
                </div>

                <strong class="${a.type === "bonus" ? "moneyPlus" : "moneyMinus"}">
                  ${a.type === "bonus" ? "+" : "-"}
                  ${Number(a.amount || 0).toLocaleString("uk-UA")} грн
                </strong>

                <button
                  class="financeDeleteBtn"
                  type="button"
                  data-delete-adjustment="${escapeHtml(a.id)}"
                  title="Видалити">

                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                    <path
                      d="M8 8L16 16M16 8L8 16"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"/>
                  </svg>

                </button>

              </div>
            `).join("")
            : `
              <div class="hint">
                Поки немає бонусів або штрафів за цей місяць.
              </div>
            `
        }
      </div>
    </div>

    <div class="teamDashPanel">
      <div class="teamDashPanelHead">
        <h3>📌 Розрахунок</h3>
      </div>

      <div class="teamDashRows">
        <p><span>Виручка місяця</span><b>${revenue.toLocaleString("uk-UA")} грн</b></p>
        <p><span>Ставка</span><b>${shiftRate.toLocaleString("uk-UA")} грн</b></p>
        <p><span>${percentRate}% від виручки</span><b>${percentAmount.toLocaleString("uk-UA")} грн</b></p>
        <p><span>Бонуси</span><b class="moneyPlus">+${bonuses.toLocaleString("uk-UA")} грн</b></p>
        <p><span>Штрафи</span><b class="moneyMinus">-${penalties.toLocaleString("uk-UA")} грн</b></p>
        <p><span>До виплати</span><b>${totalToPay.toLocaleString("uk-UA")} грн</b></p>
      </div>
    </div>

  </section>
`;

bindFinanceAdjustments(root, state);
}

function bindFinanceAdjustments(root, state) {
  root.querySelector("#btnAddFinanceAdjustment")?.addEventListener("click", () => {
    openFinanceAdjustmentModal(root, state);
  });

  root.querySelectorAll("[data-delete-adjustment]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Видалити запис?")) return;

      const id = btn.dataset.deleteAdjustment;
      await deleteStaffAdjustmentApi(id);

      renderTeamFinanceTab(root, state);
    });
  });
}
function openFinanceAdjustmentModal(root, state) {
  document.querySelector(".financeAdjustModalOverlay")?.remove();

  const modal = document.createElement("div");
  modal.className = "financeAdjustModalOverlay";

  modal.innerHTML = `
    <div class="financeAdjustModal">
      <button class="financeAdjustClose" type="button">×</button>

      <div class="financeAdjustHead">
        <div class="financeAdjustIcon">💰</div>
        <div>
          <h2>Додати нарахування</h2>
          <p>Додайте бонус або штраф співробітнику за поточний місяць.</p>
        </div>
      </div>

      <div class="financeTypeSwitch">
        <button class="active" type="button" data-adjust-type="bonus">✅ Бонус</button>
        <button type="button" data-adjust-type="penalty">⚠️ Штраф</button>
      </div>

      <label class="financeAdjustField">
        <span>Сума, грн</span>
        <input id="financeAdjustAmount" type="number" min="1" step="1" placeholder="Наприклад: 500">
      </label>

      <label class="financeAdjustField">
        <span>Причина</span>
        <input id="financeAdjustReason" type="text" placeholder="Наприклад: запізнення або бонус за результат">
      </label>

      <div class="financeQuickReasons">
        <span>Швидкі причини</span>
        <div>
          <button type="button" data-reason="Запізнення">Запізнення</button>
          <button type="button" data-reason="Пропуск зміни">Пропуск зміни</button>
          <button type="button" data-reason="Бонус за результат">Бонус за результат</button>
          <button type="button" data-reason="Додаткова зміна">Додаткова зміна</button>
        </div>
      </div>

      <div class="financeAdjustActions">
        <button class="teamGhostBtn" id="btnCancelAdjust" type="button">Скасувати</button>
        <button class="teamPrimaryBtn" id="btnSaveAdjust" type="button">Додати</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  let selectedType = "bonus";

  const close = () => modal.remove();

  modal.querySelector(".financeAdjustClose")?.addEventListener("click", close);
  modal.querySelector("#btnCancelAdjust")?.addEventListener("click", close);

  modal.querySelectorAll("[data-adjust-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedType = btn.dataset.adjustType || "bonus";

      modal.querySelectorAll("[data-adjust-type]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  modal.querySelectorAll("[data-reason]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const reasonInput = modal.querySelector("#financeAdjustReason");
      if (reasonInput) reasonInput.value = btn.dataset.reason || "";
    });
  });

  modal.querySelector("#btnSaveAdjust")?.addEventListener("click", async () => {
    const amount = Number(modal.querySelector("#financeAdjustAmount")?.value || 0);
    const reason = modal.querySelector("#financeAdjustReason")?.value?.trim() || "";

    if (!amount || amount <= 0) {
      alert("Вкажіть суму.");
      return;
    }

    const res = await createStaffAdjustmentApi(state.doc.id, {
      type: selectedType,
      amount,
      reason,
    });

    if (!res.ok) {
      alert(res.error || "Не вдалося додати запис");
      return;
    }

    close();
    renderTeamFinanceTab(root, state);
  });

  modal.querySelector("#financeAdjustAmount")?.focus();
}


async function renderTeamAchievementsTab(root, state) {
  const career = buildStaffCareer(state);
  const rating = await loadStaffRatingApi();

  const ratingRows = rating.rows || [];
  const currentStaffId = String(state.doc.id || "");

  const currentRank = ratingRows.find((r) => String(r.staff_id) === currentStaffId);
  const totalStaff = ratingRows.length;

  root.innerHTML = `
    <section class="teamSubHero">
      <div>
        <h2>🏆 Карʼєра ветеринара</h2>
        <p>Рівень, сезонний рейтинг клініки, титули та професійні досягнення.</p>
      </div>
    </section>

    ${renderClinicRatingBoard(ratingRows, currentStaffId, rating.season_key)}

    <section class="teamCareerHero">
      <div class="teamCareerLevel">
        <div class="teamCareerBadge">${career.levelIcon}</div>
        <div>
          <div class="teamCareerTitle">${escapeHtml(career.title)}</div>
          <div class="teamCareerSub">Рівень ${career.level} · ${career.xp.toLocaleString("uk-UA")} XP</div>
        </div>
      </div>

      <div class="teamCareerProgress">
        <div>
          <span>До наступного рівня</span>
          <b>${career.xpInLevel} / ${career.neededForNext} XP</b>
        </div>
        <i><em style="width:${career.progressPercent}%"></em></i>
      </div>
    </section>

    <section class="teamDashKpis">
      ${renderTeamKpiCard("⭐", "XP", career.xp.toLocaleString("uk-UA"), 0)}
      ${renderTeamKpiCard("🏅", "Відкрито", `${career.unlockedCount} / ${career.achievements.length}`, 0)}
      ${renderTeamKpiCard("👑", "Титул", career.title, 0)}
      ${renderTeamKpiCard("🏆", "Рейтинг клініки", currentRank ? `#${currentRank.rank} із ${totalStaff}` : "—", 0)}
    </section>

    <section class="teamAchievementsGrid">
      ${career.achievements.map(renderAchievementCard).join("")}
    </section>
  `;
}
function renderClinicRatingBoard(rows, currentStaffId, seasonKey) {
  if (!rows.length) {
    return `
      <section class="clinicRatingBoard">
        <div class="clinicRatingHead">
          <div>
            <h3>🏆 Рейтинг клініки</h3>
            <p>Поки немає даних рейтингу. Перерахуйте сезон на сервері.</p>
          </div>
        </div>
      </section>
    `;
  }

  const seasonLabel = formatSeasonLabel(seasonKey);

  return `
    <section class="clinicRatingBoard">
      <div class="clinicRatingHead">
        <div>
          <h3>🏆 Рейтинг клініки</h3>
          <p>Сезон ${escapeHtml(seasonLabel)} · оновлення кожні 3 місяці</p>
        </div>
        <span>${escapeHtml(seasonKey || "—")}</span>
      </div>

      <div class="clinicRatingTable">
        ${rows.map((r) => renderClinicRatingRow(r, currentStaffId)).join("")}
      </div>
    </section>
  `;
}

function renderClinicRatingRow(r, currentStaffId) {
  const rank = Number(r.rank || 0);
  const isCurrent = String(r.staff_id) === String(currentStaffId);

  const medal =
    rank === 1 ? "🥇" :
    rank === 2 ? "🥈" :
    rank === 3 ? "🥉" :
    `#${rank}`;

  const avatar = r.avatar
    ? `<img src="${escapeHtml(r.avatar)}" alt="${escapeHtml(r.staff_name || "Працівник")}">`
    : `<span>${escapeHtml(String(r.staff_name || "?").trim().charAt(0).toUpperCase() || "?")}</span>`;

  return `
    <div class="clinicRatingRow ${isCurrent ? "current" : ""} rank-${rank}">
      <div class="clinicRatingPlace">${medal}</div>

      <div class="clinicRatingAvatar">
        ${avatar}
      </div>

      <div class="clinicRatingPerson">
        <b>${escapeHtml(r.staff_name || "Працівник")}</b>
        <span>${isCurrent ? "Ваш профіль" : "Співробітник клініки"}</span>
      </div>

      <div class="clinicRatingStats">
        <div><span>Score</span><b>${Number(r.score || 0).toLocaleString("uk-UA")}</b></div>
        <div><span>Візити</span><b>${Number(r.visits_count || 0).toLocaleString("uk-UA")}</b></div>
        <div><span>Виручка</span><b>${Number(r.revenue || 0).toLocaleString("uk-UA")} грн</b></div>
        <div><span>Сер. чек</span><b>${Number(r.avg_check || 0).toLocaleString("uk-UA")} грн</b></div>
      </div>
    </div>
  `;
}

function formatSeasonLabel(seasonKey) {
  const s = String(seasonKey || "");
  const [year, q] = s.split("-Q");

  const map = {
    "1": "I квартал",
    "2": "II квартал",
    "3": "III квартал",
    "4": "IV квартал",
  };

  return `${map[q] || "поточний сезон"} ${year || ""}`.trim();
}

function buildStaffCareer(state) {
  const visits = state.dashboard.live_staff_visits || [];
  const revenue = Number(state.revenue || 0);

  const totalVisits = visits.length;
  const dogVisits = countVisitsBySpecies(visits, ["dog", "соб", "пес", "пёс"]);
  const catVisits = countVisitsBySpecies(visits, ["cat", "кіт", "кот", "кош"]);
  const vaccineVisits = countVisitsByText(visits, ["вакцин", "щепл", "vaccine"]);
  const surgeryVisits = countVisitsByText(visits, ["операц", "хірург", "хирург", "surgery"]);

  const achievements = getVeterinaryAchievements({
    totalVisits,
    dogVisits,
    catVisits,
    revenue,
    vaccineVisits,
    surgeryVisits,
    consecutiveShifts: 0,
  });

  const unlocked = achievements.filter((a) => a.unlocked);
  const xp = achievements.reduce((sum, a) => {
    return sum + (a.unlocked ? Number(a.xp || 0) : 0);
  }, totalVisits * 10);

  const level = calculateCareerLevel(xp);
  const title = getCareerTitle(totalVisits);
  const levelIcon = getCareerIcon(totalVisits);

  return {
    xp,
    level: level.level,
    xpInLevel: level.xpInLevel,
    neededForNext: level.neededForNext,
    nextLevelXp: level.nextLevelXp,
    progressPercent: level.progressPercent,
    title,
    levelIcon,
    achievements,
    unlockedCount: unlocked.length,
    clinicRank: "—",
  };
}


function renderTeamSettingsTab(root, state) {
  const career = buildStaffCareer(state);
  const titles = getUnlockedCareerTitles(career);
  const frames = getUnlockedCareerFrames(career);
  const prefs = getStaffCareerPrefs(state.doc.id);

  const profilePhoto = state.doc.avatar || "";
  const staffLetter = (state.staffName || "?").trim().charAt(0).toUpperCase() || "?";

  root.innerHTML = `
    <section class="teamSubHero">
      <div>
        <h2>⚙ Налаштування профілю</h2>
        <p>Налаштуйте професійний вигляд профілю: активний титул, фото та рамку.</p>
      </div>
    </section>

    <section class="teamDashGrid">
      <div class="teamDashPanel teamDashFull">
        <div class="teamDashPanelHead">
          <h3>🏆 Активний титул</h3>
        </div>

        <div class="careerChoiceGrid">
          ${
            titles.length
              ? titles.map((t) => `
                <button class="careerChoice ${prefs.titleId === t.id ? "active" : ""}" type="button" data-title-choice="${escapeHtml(t.id)}">
                  <span>${escapeHtml(t.icon)}</span>
                  <b>${escapeHtml(t.label)}</b>
                  <small>${escapeHtml(achievementRarityLabel(t.rarity))}</small>
                </button>
              `).join("")
              : `<div class="hint">Поки немає відкритих титулів.</div>`
          }
        </div>
      </div>

      <div class="teamDashPanel teamDashFull">
        <div class="teamDashPanelHead">
          <h3>📷 Фото профілю</h3>
          <span>PNG / JPG</span>
        </div>

        <div class="teamPhotoSettings">
          <div class="teamPhotoPreview">
            ${
              profilePhoto
                ? `<img src="${escapeHtml(profilePhoto)}" alt="${escapeHtml(state.staffName || "Працівник")}">`
                : `<span>${escapeHtml(staffLetter)}</span>`
            }
          </div>

          <div class="teamPhotoRight">
            <h4>Фото співробітника</h4>

            <p>
              Фото використовується у профілі ветеринара та списку команди.
            </p>

            <div class="teamPhotoButtons">
              <label class="teamPrimaryBtn profileUploadBtn">
                📷 Завантажити фото
                <input
                  id="staffPhotoInput"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden>
              </label>

              <button
                id="btnDeleteStaffPhoto"
                class="teamGhostBtn"
                type="button">
                🗑 Видалити фото
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="teamDashPanel teamDashFull">
        <div class="teamDashPanelHead">
          <h3>🖼 Активна рамка</h3>
        </div>

        <div class="careerChoiceGrid">
          ${
            frames.length
              ? frames.map((f) => `
                <button
                  class="careerChoice rarity-${escapeHtml(f.rarity)} ${prefs.frameId === f.id ? "active" : ""}"
                  type="button"
                  data-frame-choice="${escapeHtml(f.id)}">

                  <span>${escapeHtml(f.icon)}</span>
                  <b>${escapeHtml(f.label)}</b>
                  <small>${escapeHtml(achievementRarityLabel(f.rarity))}</small>
                </button>
              `).join("")
              : `<div class="hint">Поки немає відкритих рамок.</div>`
          }
        </div>
      </div>
    </section>
  `;

  root.querySelectorAll("[data-title-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const titleId = btn.dataset.titleChoice || "none";

      saveStaffCareerPrefs(state.doc.id, { titleId });
      applyCareerLookToSidebar(state);
      renderTeamSettingsTab(root, state);
    });
  });

  root.querySelectorAll("[data-frame-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const frameId = btn.dataset.frameChoice || "none";

      saveStaffCareerPrefs(state.doc.id, { frameId });
      applyCareerLookToSidebar(state);
      renderTeamSettingsTab(root, state);
    });
  });

  const photoInput = root.querySelector("#staffPhotoInput");

  photoInput?.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      alert("Фото завелике. Максимум 5 МБ.");
      return;
    }

    try {
      const url = await uploadFile(file);

      await updateStaffApi(state.doc.id, {
        ...state.doc,
        avatar: url,
      });

      state.doc.avatar = url;

      renderTeamSettingsTab(root, state);
      applyCareerLookToSidebar(state);
    } catch (e) {
      console.error(e);
      alert("Не вдалося завантажити фото: " + (e.message || e));
    }
  });

  root.querySelector("#btnDeleteStaffPhoto")?.addEventListener("click", async () => {
    if (!confirm("Видалити фото?")) return;

    try {
      await updateStaffApi(state.doc.id, {
        ...state.doc,
        avatar: "",
      });

      state.doc.avatar = "";

      renderTeamSettingsTab(root, state);
      applyCareerLookToSidebar(state);
    } catch (e) {
      console.error(e);
      alert("Не вдалося видалити фото: " + (e.message || e));
    }
  });
}

async function loadStaffAdjustmentsApi(staffId) {
  const res = await fetch(`/api/staff/${encodeURIComponent(staffId)}/adjustments`);
  const json = await res.json();
  return json.ok ? (json.data || []) : [];
}

async function createStaffAdjustmentApi(staffId, payload) {
  const res = await fetch(`/api/staff/${encodeURIComponent(staffId)}/adjustments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return await res.json();
}

async function deleteStaffAdjustmentApi(adjustmentId) {
  const res = await fetch(`/api/staff/adjustments/${encodeURIComponent(adjustmentId)}`, {
    method: "DELETE",
  });
  return await res.json();
}

function applyCareerLookToSidebar(state) {
  const career = buildStaffCareer(state);
  const prefs = getStaffCareerPrefs(state.doc.id);


  const titles = getUnlockedCareerTitles(career);
  const frames = getUnlockedCareerFrames(career);

  const selectedTitle = titles.find((x) => x.id === prefs.titleId);
  const selectedFrame = frames.find((x) => x.id === prefs.frameId);

  const titleText =
    prefs.titleId === "none"
      ? ""
      : selectedTitle?.label || career.title || "";

  const frameId =
    prefs.frameId === "none"
      ? ""
      : selectedFrame?.id || career.activeFrame || "";

  const avatar = document.querySelector(".teamDashAvatar");
  if (avatar) {
    avatar.className = `teamDashAvatar ${frameId ? `frame-${frameId}` : ""}`;
  }

  const nameEl = document.querySelector(".teamDashName");
  if (!nameEl) return;

  let titleEl = document.querySelector(".teamDashTitle");

  if (!titleText) {
    titleEl?.remove();
    return;
  }

  if (!titleEl) {
    titleEl = document.createElement("div");
    titleEl.className = "teamDashTitle";
    nameEl.insertAdjacentElement("afterend", titleEl);
  }

  titleEl.innerHTML = `🏆 ${escapeHtml(titleText)}`;
}
function buildStaffChartsFromVisits(visits, monthsCount = 6) {
  const monthNames = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];
  const now = new Date();
  const result = [];

  if (Number(monthsCount) === 1) {
    const year = now.getFullYear();
    const month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
      result.push({
        year,
        monthIndex: month,
        day,
        label: String(day),
        revenue: 0,
        visits: 0,
      });
    }

    visits.forEach((v) => {
      const date = new Date(v.date || v.event_date || v.created_at || "");
      if (Number.isNaN(date.getTime())) return;
      if (date.getFullYear() !== year || date.getMonth() !== month) return;

      const bucket = result[date.getDate() - 1];
      if (!bucket) return;

      bucket.visits += 1;
      bucket.revenue += calcServicesTotal(v) + calcStockTotal(v);
    });

    return result;
  }

  for (let i = monthsCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);

    result.push({
      year: d.getFullYear(),
      monthIndex: d.getMonth(),
      label: monthNames[d.getMonth()],
      revenue: 0,
      visits: 0,
    });
  }

  visits.forEach((v) => {
    const date = new Date(v.date || v.event_date || v.created_at || "");
    if (Number.isNaN(date.getTime())) return;

    const bucket = result.find((x) => {
      return x.year === date.getFullYear() && x.monthIndex === date.getMonth();
    });

    if (!bucket) return;

    bucket.visits += 1;
    bucket.revenue += calcServicesTotal(v) + calcStockTotal(v);
  });

  return result;
}
let staffRevenueChartInstance = null;
let staffVisitsChartInstance = null;

function renderStaffProfileCharts(dashboard, monthsCount = 6) {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js не завантажився");
    return;
  }

  const visits = dashboard.live_staff_visits || dashboard.live_month_visits || [];
 const chartData = buildStaffChartsFromVisits(visits, monthsCount);

  const labels = chartData.map((x) => x.label);
  const revenueValues = chartData.map((x) => x.revenue);
  const visitsValues = chartData.map((x) => x.visits);

  const revenueCanvas = document.getElementById("staffRevenueChart");
  const visitsCanvas = document.getElementById("staffVisitsChart");

  if (staffRevenueChartInstance) staffRevenueChartInstance.destroy();
  if (staffVisitsChartInstance) staffVisitsChartInstance.destroy();

  if (revenueCanvas) {
    const ctx = revenueCanvas.getContext("2d");

    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, "rgba(54, 224, 127, 0.95)");
    gradient.addColorStop(1, "rgba(54, 224, 127, 0.18)");

    staffRevenueChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Виручка",
          data: revenueValues,
          backgroundColor: gradient,
          borderRadius: 14,
          borderSkipped: false,
        }],
      },
      options: buildTeamChartOptions("грн"),
    });
  }

  if (visitsCanvas) {
    const ctx = visitsCanvas.getContext("2d");

    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, "rgba(180, 92, 255, 0.95)");
    gradient.addColorStop(1, "rgba(124, 92, 255, 0.18)");

    staffVisitsChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Візити",
          data: visitsValues,
          backgroundColor: gradient,
          borderRadius: 14,
          borderSkipped: false,
        }],
      },
      options: buildTeamChartOptions("візити"),
    });
  }
}

function switchStaffChartRange(monthsCount, btn) {
  window.__staffChartRange = Number(monthsCount || 1);

  document.querySelectorAll("[data-chart-range]").forEach((b) => {
    b.classList.remove("active");
  });

  btn?.classList.add("active");

  if (!window.__lastTeamDashboard) {
    console.warn("Немає dashboard для графіка");
    return;
  }

  renderStaffProfileCharts(window.__lastTeamDashboard, window.__staffChartRange);
}

async function buildStaffLiveStats(staffId) {
  const staffIdStr = String(staffId);

  const visits = await loadVisitsApi();
  const calendarEvents = await loadCalendarApi();

  const staffCalendarEvents = calendarEvents.filter((ev) => {
    return String(ev.staff_id || "") === staffIdStr;
  });

  const visitIdsFromCalendar = new Set(
    staffCalendarEvents
      .map((ev) => String(ev.visit_id || ev.visitId || ev.source_visit_id || ""))
      .filter(Boolean)
  );

  const staffVisits = visits.filter((v) => {
    return (
      String(v.staff_id || v.doctor_id || v.vet_id || "") === staffIdStr ||
      visitIdsFromCalendar.has(String(v.id))
    );
  });

  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const monthVisits = staffVisits.filter((v) => {
    const d = new Date(v.date || v.event_date || v.created_at || "");
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  });

  const revenue = monthVisits.reduce((sum, v) => {
    return sum + calcServicesTotal(v) + calcStockTotal(v);
  }, 0);

  const closedChecks = monthVisits.length;
  const avgCheck = closedChecks ? Math.round(revenue / closedChecks) : 0;

  return {
    revenue,
    visits_this_month: monthVisits.length,
    closed_checks: closedChecks,
    avg_check: avgCheck,
    rating_avg: 0,
    rating: 0,

    revenue_growth_percent: 0,
    visits_growth_percent: 0,
    checks_growth_percent: 0,
    avg_check_growth_percent: 0,

    live_staff_visits: staffVisits,
    live_month_visits: monthVisits,
    live_calendar_events: staffCalendarEvents,
  };
}

function buildTeamChartOptions(unitLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 800,
      easing: "easeOutQuart",
    },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: "rgba(10, 16, 34, 0.96)",
        titleColor: "#fff",
        bodyColor: "#fff",
        borderColor: "rgba(255,255,255,0.12)",
        borderWidth: 1,
        padding: 12,
        displayColors: false,
        callbacks: {
          label: function(context) {
            const value = Number(context.raw || 0);

            if (unitLabel === "грн") {
              return `${value.toLocaleString("uk-UA")} грн`;
            }

            return `${value} ${unitLabel}`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: {
          display: false,
        },
        ticks: {
  color: "rgba(255,255,255,0.72)",
  autoSkip: false,
  maxRotation: 0,
  minRotation: 0,
  font: {
    weight: "700",
    size: 10,
  },
},
        border: {
          display: false,
        },
      },
      y: {
        beginAtZero: true,
        grid: {
          color: "rgba(255,255,255,0.06)",
        },
        ticks: {
          color: "rgba(255,255,255,0.48)",
          callback: function(value) {
            if (unitLabel === "грн") {
              return Number(value).toLocaleString("uk-UA");
            }

            return value;
          },
        },
        border: {
          display: false,
        },
      },
    },
  };
}

function renderTeamKpiCard(icon, title, value, growth) {
  const g = Number(growth || 0);
  return `
    <div class="teamKpiCard">
      <div class="teamKpiIcon">${icon}</div>
      <div>
        <span>${escapeHtml(title)}</span>
        <strong>${escapeHtml(String(value))}</strong>
        <small>${g >= 0 ? "↑" : "↓"} ${Math.abs(g)}% до минулого місяця</small>
      </div>
    </div>
  `;
}

function renderTeamBars(labels, values, color) {
  const max = Math.max(...values, 1);

  return `
    <div class="teamBars">
      ${values.map((v, i) => `
        <div class="teamBarItem">
          <div class="teamBarTrack">
            <i class="${color}" style="height:${Math.round((v / max) * 100)}%"></i>
          </div>
          <span>${escapeHtml(labels[i])}</span>
        </div>
      `).join("")}
    </div>
  `;
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
    alert(
      "html2pdf не підключений. Перевір підключення html2pdf.bundle.min.js."
    );
    return;
  }

  await renderDischargeA4(visitId);

  const host =
    document.getElementById("disA4");

  const originalDocument =
    host?.querySelector(".disModernDoc");

  if (!host || !originalDocument) {
    alert(
      "Не вдалося сформувати документ виписки."
    );
    return;
  }

  const filename =
    a4FilenameFromVisit(visitId);

  /*
   * ВАЖНО:
   * Не передаём в html2pdf живой элемент из CRM.
   * Создаём отдельную чистую копию без влияния
   * body display:flex, main-content и текущего layout.
   */
  const exportRoot =
    document.createElement("div");

  exportRoot.id =
    "dischargePdfExportRoot";

  exportRoot.style.cssText = `
    position: fixed;
left: 0;
top: 0;
    width: 794px;
    min-width: 794px;
    max-width: 794px;
    margin: 0;
    padding: 0;
    display: block;
    visibility: visible;
    opacity: 1;
    background: #ffffff;
    overflow: visible;
    box-sizing: border-box;
    pointer-events: none;
    z-index: 2147483647;
    transform: none;
  `;

  const exportDocument =
    originalDocument.cloneNode(true);

  exportDocument.style.cssText += `
    display: block !important;
    position: relative !important;
    left: 0 !important;
    top: 0 !important;
    width: 794px !important;
    min-width: 794px !important;
    max-width: 794px !important;
    margin: 0 !important;
    padding: 18px !important;
    box-sizing: border-box !important;
    visibility: visible !important;
    opacity: 1 !important;
    background: #ffffff !important;
    color: #1f2937 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    overflow: visible !important;
    transform: none !important;
  `;

  exportRoot.appendChild(
    exportDocument
  );

  document.body.appendChild(
    exportRoot
  );

  try {
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });

    const images = Array.from(
      exportDocument.querySelectorAll("img")
    );

    await Promise.all(
      images.map((image) => {
        if (
          image.complete &&
          image.naturalWidth > 0
        ) {
          return Promise.resolve();
        }

        return new Promise((resolve) => {
          const finish = () => resolve();

          image.addEventListener(
            "load",
            finish,
            { once: true }
          );

          image.addEventListener(
            "error",
            finish,
            { once: true }
          );

          setTimeout(
            finish,
            4000
          );
        });
      })
    );

    await window
      .html2pdf()
      .set({
        margin: 0,

        filename,

        image: {
          type: "jpeg",
          quality: 0.98,
        },

        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: false,
          backgroundColor: "#ffffff",
          logging: false,

          scrollX: 0,
          scrollY: 0,

          x: 0,
          y: 0,

          width: 794,
          windowWidth: 794,

          onclone: (
            clonedDocument
          ) => {
            const clonedRoot =
              clonedDocument.getElementById(
                "dischargePdfExportRoot"
              );

            if (!clonedRoot) return;

            clonedRoot.style.position =
              "absolute";

            clonedRoot.style.left =
              "0";

            clonedRoot.style.top =
              "0";

            clonedRoot.style.width =
              "794px";

            clonedRoot.style.minWidth =
              "794px";

            clonedRoot.style.maxWidth =
              "794px";

            clonedRoot.style.margin =
              "0";

            clonedRoot.style.padding =
              "0";

            clonedRoot.style.display =
              "block";

            clonedRoot.style.visibility =
              "visible";

            clonedRoot.style.opacity =
              "1";

            clonedRoot.style.transform =
              "none";

            clonedRoot.style.background =
              "#ffffff";

            const clonedDoc =
              clonedRoot.querySelector(
                ".disModernDoc"
              );

            if (clonedDoc) {
              clonedDoc.style.position =
                "relative";

              clonedDoc.style.left =
                "0";

              clonedDoc.style.top =
                "0";

              clonedDoc.style.width =
                "794px";

              clonedDoc.style.minWidth =
                "794px";

              clonedDoc.style.maxWidth =
                "794px";

              clonedDoc.style.margin =
                "0";

              clonedDoc.style.padding =
                "32px";

              clonedDoc.style.display =
                "block";

              clonedDoc.style.visibility =
                "visible";

              clonedDoc.style.opacity =
                "1";

              clonedDoc.style.transform =
                "none";

              clonedDoc.style.borderRadius =
                "0";

              clonedDoc.style.boxShadow =
                "none";

              clonedDoc.style.background =
                "#ffffff";

              clonedDoc.style.boxSizing =
                "border-box";
            }
          },
        },

        jsPDF: {
          unit: "px",
          format: [
            794,
            1123,
          ],
          orientation: "portrait",
          compress: true,
        },

        pagebreak: {
          mode: [
            "css",
            "legacy",
          ],

          avoid: [
            ".disModernHead",
            ".disModernCard",
            ".disModernSection",
            ".disModernSignGrid",
            ".disModernFinanceSummary",
          ],
        },
      })
      .from(exportDocument)
.save();
  } catch (error) {
    console.error(
      "downloadA4Pdf failed:",
      error
    );

    alert(
      "Не вдалося сформувати PDF: " +
      (
        error?.message ||
        error
      )
    );
  } finally {
    exportRoot.remove();
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
        <div class="patientActionsCell">
  <button
    class="iconBtn patientActionBtn patientEditBtn"
    type="button"
    title="Редагувати пацієнта"
    aria-label="Редагувати пацієнта"
    data-edit-pet="${escapeHtml(p.id)}"
  >
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"></path>
    </svg>
  </button>

  <button
    class="iconBtn patientActionBtn patientDeleteBtn"
    type="button"
    title="Видалити пацієнта"
    aria-label="Видалити пацієнта"
    data-del-pet="${escapeHtml(p.id)}"
  >
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="M19 6l-1 14H6L5 6"></path>
      <path d="M10 11v5"></path>
      <path d="M14 11v5"></path>
    </svg>
  </button>
</div>
      `;
      patientListElement.appendChild(el);
    });

  // Делегированный клик
  patientListElement.onclick = async (e) => {
    const editBtn = e.target.closest("[data-edit-pet]");

if (editBtn) {
  e.preventDefault();
  e.stopPropagation();

  const petId = editBtn.dataset.editPet;

  const pet = (state.patients || []).find(
    (item) => String(item.id) === String(petId)
  );

  if (!pet) {
    alert("Пацієнта не знайдено.");
    return;
  }

  openAddPetModal(pet.owner_id, pet);
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
  let owner = getOwnerById(ownerId);

if (!owner) {
  await loadOwners();
  owner = getOwnerById(ownerId);
}

if (!owner) {
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
   const ownerStatus =
  Number(totalPaid || 0) >= 50000
    ? "VIP клієнт"
    : visitsCount >= 15
      ? "Постійний клієнт"
      : visitsCount > 0
        ? "Активний клієнт"
        : "Новий клієнт";
    ownerNameEl.innerHTML = `
  <div class="ownerDashboardHero">
    <div class="ownerDashTop">
      <div class="ownerDashAvatar">👤</div>

      <div class="ownerDashInfo">
        <div class="ownerDashKicker">Картка власника</div>
        <div class="ownerDashName">${escapeHtml(owner.name || "Без імені")}</div>

        <div class="ownerDashContacts">
          <span>📞 ${escapeHtml(owner.phone || "Телефон не вказано")}</span>
          ${owner.note ? `<span>📍 ${escapeHtml(owner.note)}</span>` : ""}
        </div>
      </div>

      <div class="ownerDashStatus">
        <div class="ownerDashBadge">${ownerStatus}</div>
        <button class="ownerHeroEdit" data-edit-owner="${escapeHtml(owner.id)}">✏️ Редагувати</button>
        <button class="ownerHeroBack" id="btnBackOwners">← До списку</button>
      </div>
    </div>

    <div class="ownerDashStats">
      <div class="ownerDashStat">
        <span>Пацієнтів</span>
        <strong>${pets.length}</strong>
      </div>
      <div class="ownerDashStat">
        <span>Візитів</span>
        <strong>${visitsCount}</strong>
      </div>
      <div class="ownerDashStat">
        <span>Сплачено</span>
        <strong>${totalPaid} ₴</strong>
      </div>
      <div class="ownerDashStat">
        <span>Середній чек</span>
        <strong>${visitsCount ? Math.round(Number(totalPaid || 0) / visitsCount) : 0} ₴</strong>
      </div>
      <div class="ownerDashStat">
        <span>Останній візит</span>
        <strong>${escapeHtml(lastVisit?.date || "—")}</strong>
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
          <button
  class="iconBtn"
  type="button"
  title="Видалити пацієнта"
  aria-label="Видалити пацієнта"
  data-del-pet="${escapeHtml(String(pet.id))}"
>
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M3 6h18"></path>
    <path d="M8 6V4h8v2"></path>
    <path d="M19 6l-1 14H6L5 6"></path>
    <path d="M10 11v5"></path>
    <path d="M14 11v5"></path>
  </svg>
</button>
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
    const btnAddVisit =
  document.getElementById("btnAddVisit");

if (btnAddVisit) {
  btnAddVisit.onclick = () => {
    state.selectedPet = pet || null;

    state.selectedPetId =
      pet?.id ||
      pet?._id ||
      null;

    if (
      typeof openVisitModalForCreate ===
      "function"
    ) {
      openVisitModalForCreate(pet);
    } else {
      alert(
        "Помилка: функція openVisitModalForCreate не знайдена в системі."
      );
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
  renderPatientFinanceTab(dynamicBox, pet);
  return;
}
}
function renderPatientFinanceTab(root, pet) {
  if (!root || !pet) return;

  const petVisits = (
    Array.isArray(state.visits)
      ? state.visits
      : []
  )
    .filter((visit) => {
      return String(visit.pet_id) === String(pet.id);
    })
    .sort((a, b) => {
      return String(b.date || b.created_at || "")
        .localeCompare(
          String(a.date || a.created_at || "")
        );
    });

  const financialVisits = petVisits
    .map((visit) => {
      const servicesTotal =
        calcServicesTotal(visit);

      const stockTotal =
        calcStockTotal(visit);

      return {
        ...visit,
        servicesTotal,
        stockTotal,
        total:
          Number(servicesTotal || 0) +
          Number(stockTotal || 0),
      };
    });

  const paidVisits = financialVisits.filter((visit) => {
    return Number(visit.total || 0) > 0;
  });

  const totalPaid = paidVisits.reduce((sum, visit) => {
    return sum + Number(visit.total || 0);
  }, 0);

  const servicesTotal = paidVisits.reduce((sum, visit) => {
    return sum + Number(visit.servicesTotal || 0);
  }, 0);

  const stockTotal = paidVisits.reduce((sum, visit) => {
    return sum + Number(visit.stockTotal || 0);
  }, 0);

  const visitsCount = petVisits.length;

  const avgCheck = paidVisits.length
    ? Math.round(totalPaid / paidVisits.length)
    : 0;

  const lastPayment =
    paidVisits[0] || null;

  const topServices =
    buildPatientTopServices(petVisits, 5);

  const servicesPercent = totalPaid
    ? Math.round(
        (servicesTotal / totalPaid) * 100
      )
    : 0;

  const stockPercent = totalPaid
    ? Math.max(0, 100 - servicesPercent)
    : 0;

  const visitInterval =
    calculatePatientVisitInterval(petVisits);

  const insight = buildPatientFinanceInsight({
    pet,
    visitsCount,
    totalPaid,
    avgCheck,
    topServices,
    visitInterval,
  });

  root.innerHTML = `
    <section class="patientFinancePage">
      <div class="patientFinanceHead">
        <div>
          <div class="patientFinanceKicker">
            ФІНАНСОВА ІСТОРІЯ
          </div>

          <h2>Фінанси пацієнта</h2>

          <p>
            Коротка фінансова статистика
            ${escapeHtml(pet.name || "пацієнта")}
            без зайвої бухгалтерської деталізації.
          </p>
        </div>

        <div class="patientFinanceValueBadge">
          <span>Загальна цінність</span>
          <strong>
            ${formatPatientMoney(totalPaid)}
          </strong>
        </div>
      </div>

      <div class="patientFinanceKpis">
        ${renderPatientFinanceKpi({
          icon: "💳",
          label: "Усього сплачено",
          value: formatPatientMoney(totalPaid),
          note: `${paidVisits.length} оплат`,
          accent: true,
        })}

        ${renderPatientFinanceKpi({
          icon: "📊",
          label: "Середній чек",
          value: formatPatientMoney(avgCheck),
          note: "середнє за оплачений візит",
        })}

        ${renderPatientFinanceKpi({
          icon: "🐾",
          label: "Кількість візитів",
          value: String(visitsCount),
          note: getPatientVisitCountLabel(visitsCount),
        })}

        ${renderPatientFinanceKpi({
          icon: "🧾",
          label: "Остання оплата",
          value: lastPayment
            ? formatPatientMoney(lastPayment.total)
            : "—",
          note: lastPayment
            ? formatPatientFinanceDate(
                lastPayment.date ||
                lastPayment.created_at
              )
            : "оплат ще немає",
        })}
      </div>

      <div class="patientFinanceMainGrid">
        <section class="patientFinancePanel">
          <div class="patientFinancePanelHead">
            <div>
              <span class="patientFinancePanelIcon">
                ⭐
              </span>

              <div>
                <h3>Топ послуг</h3>
                <p>
                  Найчастіші та найцінніші послуги пацієнта.
                </p>
              </div>
            </div>

            <span class="patientFinanceSmallBadge">
              TOP 5
            </span>
          </div>

          <div class="patientTopServices">
            ${
              topServices.length
                ? topServices
                    .map((service, index) => {
                      return renderPatientTopService(
                        service,
                        index
                      );
                    })
                    .join("")
                : `
                  <div class="patientFinanceEmpty">
                    Послуги ще не додані до візитів.
                  </div>
                `
            }
          </div>
        </section>

        <section class="patientFinancePanel">
          <div class="patientFinancePanelHead">
            <div>
              <span class="patientFinancePanelIcon">
                ◔
              </span>

              <div>
                <h3>Структура витрат</h3>
                <p>
                  Співвідношення послуг та препаратів.
                </p>
              </div>
            </div>
          </div>

          <div class="patientExpenseTotal">
            <span>Загальні витрати</span>
            <strong>
              ${formatPatientMoney(totalPaid)}
            </strong>
          </div>

          <div class="patientExpenseBar">
            <i
              class="services"
              style="width:${servicesPercent}%"
            ></i>

            <i
              class="stock"
              style="width:${stockPercent}%"
            ></i>
          </div>

          <div class="patientExpenseLegend">
            <div>
              <span class="services"></span>

              <div>
                <small>Послуги</small>
                <strong>${servicesPercent}%</strong>
              </div>

              <b>
                ${formatPatientMoney(servicesTotal)}
              </b>
            </div>

            <div>
              <span class="stock"></span>

              <div>
                <small>Препарати</small>
                <strong>${stockPercent}%</strong>
              </div>

              <b>
                ${formatPatientMoney(stockTotal)}
              </b>
            </div>
          </div>
        </section>
      </div>

      <section class="patientFinancePanel patientPaymentsPanel">
        <div class="patientFinancePanelHead">
          <div>
            <span class="patientFinancePanelIcon">
              🧾
            </span>

            <div>
              <h3>Останні оплати</h3>
              <p>
                Візити з фактичною сумою до сплати.
              </p>
            </div>
          </div>

          ${
            paidVisits.length > 5
              ? `
                <button
                  class="patientPaymentsToggle"
                  id="btnTogglePatientPayments"
                  type="button"
                >
                  Показати всю історію
                </button>
              `
              : ""
          }
        </div>

        <div
          class="patientPaymentsList"
          id="patientPaymentsList"
        >
          ${
            paidVisits.length
              ? paidVisits
                  .map((visit, index) => {
                    return renderPatientPaymentRow(
                      visit,
                      index >= 5
                    );
                  })
                  .join("")
              : `
                <div class="patientFinanceEmpty">
                  Оплачених візитів поки немає.
                </div>
              `
          }
        </div>
      </section>

      <section class="patientFinanceInsight">
        <div class="patientFinanceInsightIcon">
          ✨
        </div>

        <div>
          <span>CRM-висновок</span>
          <p>${escapeHtml(insight)}</p>
        </div>
      </section>
    </section>
  `;

  bindPatientFinanceActions(root);
}


function renderPatientFinanceKpi({
  icon,
  label,
  value,
  note,
  accent = false,
}) {
  return `
    <article class="patientFinanceKpi ${accent ? "accent" : ""}">
      <div class="patientFinanceKpiIcon">
        ${icon}
      </div>

      <div>
        <span>${escapeHtml(label)}</span>

        <strong>
          ${escapeHtml(value)}
        </strong>

        <small>
          ${escapeHtml(note || "")}
        </small>
      </div>
    </article>
  `;
}


function buildPatientTopServices(visits, limit = 5) {
  const servicesMap = new Map();

  (visits || []).forEach((visit) => {
    const lines = expandServiceLines(visit);

    lines.forEach((line) => {
      const name = String(
        line.name || "Послуга"
      ).trim();

      const key = name.toLowerCase();

      const current =
        servicesMap.get(key) || {
          name,
          quantity: 0,
          total: 0,
          visits: 0,
        };

      current.quantity +=
        Number(line.qty || 0);

      current.total +=
        Number(line.lineTotal || 0);

      current.visits += 1;

      servicesMap.set(key, current);
    });
  });

  return Array.from(servicesMap.values())
    .sort((a, b) => {
      if (b.total !== a.total) {
        return b.total - a.total;
      }

      return b.quantity - a.quantity;
    })
    .slice(0, limit);
}


function renderPatientTopService(service, index) {
  return `
    <div class="patientTopServiceRow">
      <div class="patientTopServiceRank">
        ${index + 1}
      </div>

      <div class="patientTopServiceInfo">
        <strong>
          ${escapeHtml(service.name || "Послуга")}
        </strong>

        <span>
          ${Number(service.quantity || 0)}
          ${getPatientServiceCountLabel(
            Number(service.quantity || 0)
          )}
        </span>
      </div>

      <b>
        ${formatPatientMoney(service.total)}
      </b>
    </div>
  `;
}


function renderPatientPaymentRow(
  visit,
  initiallyHidden = false
) {
  const serviceNames = expandServiceLines(visit)
    .map((line) => line.name)
    .filter(Boolean)
    .slice(0, 2);

  const stockNames = expandStockLines(visit)
    .map((line) => line.name)
    .filter(Boolean)
    .slice(0, 1);

  const descriptionParts = [
    ...serviceNames,
    ...stockNames,
  ];

  const description =
    descriptionParts.length
      ? descriptionParts.join(", ")
      : "Візит без деталізації";

  return `
    <article
      class="patientPaymentRow ${
        initiallyHidden ? "is-hidden" : ""
      }"
      data-patient-payment-row
    >
      <div class="patientPaymentDate">
        <strong>
          ${escapeHtml(
            formatPatientFinanceDate(
              visit.date ||
              visit.created_at
            )
          )}
        </strong>

        <span>
          Візит
        </span>
      </div>

      <div class="patientPaymentDescription">
        <strong>
          ${escapeHtml(description)}
        </strong>

        <span>
          Послуги:
          ${formatPatientMoney(visit.servicesTotal)}
          · Препарати:
          ${formatPatientMoney(visit.stockTotal)}
        </span>
      </div>

      <div class="patientPaymentAmount">
        ${formatPatientMoney(visit.total)}
      </div>
    </article>
  `;
}


function bindPatientFinanceActions(root) {
  const button =
    root.querySelector("#btnTogglePatientPayments");

  if (!button) return;

  let expanded = false;

  button.addEventListener("click", () => {
    expanded = !expanded;

    root
      .querySelectorAll(
        "[data-patient-payment-row]"
      )
      .forEach((row, index) => {
        if (index < 5) return;

        row.classList.toggle(
          "is-hidden",
          !expanded
        );
      });

    button.textContent = expanded
      ? "Показати останні 5"
      : "Показати всю історію";
  });
}


function calculatePatientVisitInterval(visits) {
  const uniqueDates = Array.from(
    new Set(
      (visits || [])
        .map((visit) => {
          return String(
            visit.date ||
            visit.created_at ||
            ""
          ).slice(0, 10);
        })
        .filter(Boolean)
    )
  )
    .map((date) => new Date(date))
    .filter((date) => {
      return !Number.isNaN(date.getTime());
    })
    .sort((a, b) => a - b);

  if (uniqueDates.length < 2) return null;

  let totalDays = 0;

  for (
    let index = 1;
    index < uniqueDates.length;
    index += 1
  ) {
    const difference =
      uniqueDates[index] -
      uniqueDates[index - 1];

    totalDays += Math.max(
      0,
      Math.round(
        difference /
        (1000 * 60 * 60 * 24)
      )
    );
  }

  return Math.max(
    1,
    Math.round(
      totalDays /
      (uniqueDates.length - 1)
    )
  );
}


function buildPatientFinanceInsight({
  pet,
  visitsCount,
  totalPaid,
  avgCheck,
  topServices,
  visitInterval,
}) {
  const petName =
    pet?.name || "Пацієнт";

  if (!visitsCount) {
    return `${petName} ще не має завершених візитів із фінансовими даними.`;
  }

  const parts = [];

  parts.push(
    `${petName} відвідав клініку ${visitsCount} ${getPatientVisitCountLabel(visitsCount)}`
  );

  if (visitInterval) {
    parts.push(
      `у середньому раз на ${visitInterval} ${getPatientDayCountLabel(visitInterval)}`
    );
  }

  if (topServices[0]?.name) {
    parts.push(
      `найцінніша послуга — ${topServices[0].name}`
    );
  }

  if (totalPaid > 0) {
    parts.push(
      `загальна сума оплат становить ${formatPatientMoney(totalPaid)}, середній чек — ${formatPatientMoney(avgCheck)}`
    );
  }

  return parts.join(". ") + ".";
}


function formatPatientMoney(value) {
  return (
    Number(value || 0).toLocaleString("uk-UA") +
    " ₴"
  );
}


function formatPatientFinanceDate(value) {
  const raw = String(value || "").slice(0, 10);

  if (!raw) return "—";

  const date = new Date(`${raw}T12:00:00`);

  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return date.toLocaleDateString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}


function getPatientVisitCountLabel(count) {
  const number = Math.abs(Number(count || 0));

  if (number % 10 === 1 && number % 100 !== 11) {
    return "візит";
  }

  if (
    number % 10 >= 2 &&
    number % 10 <= 4 &&
    (
      number % 100 < 12 ||
      number % 100 > 14
    )
  ) {
    return "візити";
  }

  return "візитів";
}


function getPatientServiceCountLabel(count) {
  const number = Math.abs(Number(count || 0));

  if (number % 10 === 1 && number % 100 !== 11) {
    return "раз";
  }

  if (
    number % 10 >= 2 &&
    number % 10 <= 4 &&
    (
      number % 100 < 12 ||
      number % 100 > 14
    )
  ) {
    return "рази";
  }

  return "разів";
}


function getPatientDayCountLabel(count) {
  const number = Math.abs(Number(count || 0));

  if (number % 10 === 1 && number % 100 !== 11) {
    return "день";
  }

  if (
    number % 10 >= 2 &&
    number % 10 <= 4 &&
    (
      number % 100 < 12 ||
      number % 100 > 14
    )
  ) {
    return "дні";
  }

  return "днів";
}
const PATIENT_FILES_KEY = "DOCPUG_PATIENT_FILES_V1";

const PATIENT_FILE_CATEGORIES = {
  all: {
    label: "Усі",
    icon: "▦",
  },

  xray: {
    label: "Рентген",
    icon: "🩻",
  },

  ultrasound: {
    label: "УЗД",
    icon: "🖥️",
  },

  media: {
    label: "Фото / відео",
    icon: "📷",
  },

  document: {
    label: "Документи",
    icon: "📄",
  },

  other: {
    label: "Інше",
    icon: "📎",
  },
};

let patientFilesActiveFilter = "all";
// ==========================================================================
// Doc.PUG CRM Mini — app.js (ФАЙЛЫ, РЕФЕРЕНСЫ ЛАБОРАТОРИИ И ГРАФИКИ ВЕТЕРИНАРОВ)
// Часть 5 (Строки 3001 — 3500)<button type="button" class="teamVisitOpenBtn" onclick="console.log(v); openVisitFromTeam('${escapeHtml(String(v.id || ""))}')">
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

  const files = getPatientFiles(petId)
    .map(normalizePatientFile)
    .sort((a, b) => {
      return String(b.date || b.created_at || "")
        .localeCompare(String(a.date || a.created_at || ""));
    });

  const counts = getPatientFileCategoryCounts(files);

  const filteredFiles =
    patientFilesActiveFilter === "all"
      ? files
      : files.filter((file) => {
          return file.category === patientFilesActiveFilter;
        });

  box.innerHTML = `
    <section class="patientFilesArchive">
      <div class="patientFilesArchiveHead">
        <div>
          <div class="patientFilesKicker">
            МЕДИЧНИЙ АРХІВ
          </div>

          <h2>Файли пацієнта</h2>

          <p>
            Рентген, УЗД, фотографії, відео та документи
            ${escapeHtml(pet.name || "пацієнта")}.
          </p>
        </div>

        <button
          class="patientFilesAddButton"
          id="btnAddPatientFile"
          type="button"
        >
          + Додати файл
        </button>
      </div>

      <div class="patientFilesStats">
        <div>
          <span>Усього файлів</span>
          <strong>${files.length}</strong>
        </div>

        <div>
          <span>Рентген</span>
          <strong>${counts.xray}</strong>
        </div>

        <div>
          <span>УЗД</span>
          <strong>${counts.ultrasound}</strong>
        </div>

        <div>
          <span>Документи</span>
          <strong>${counts.document}</strong>
        </div>
      </div>

      <div class="patientFilesFilters">
        ${Object.entries(PATIENT_FILE_CATEGORIES)
          .map(([key, meta]) => {
            const count =
              key === "all"
                ? files.length
                : counts[key] || 0;

            return `
              <button
                class="patientFilesFilter ${
                  patientFilesActiveFilter === key
                    ? "active"
                    : ""
                }"
                type="button"
                data-patient-file-filter="${escapeHtml(key)}"
              >
                <span>${meta.icon}</span>
                <b>${escapeHtml(meta.label)}</b>
                <em>${count}</em>
              </button>
            `;
          })
          .join("")}
      </div>

      <div id="patientFilesArchiveContent">
        ${
          filteredFiles.length
            ? renderPatientFilesArchive(filteredFiles)
            : renderPatientFilesEmptyState(patientFilesActiveFilter)
        }
      </div>
    </section>
  `;

  box
    .querySelector("#btnAddPatientFile")
    ?.addEventListener("click", () => {
      openPatientFileModal(pet);
    });

  box
    .querySelectorAll("[data-patient-file-filter]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        patientFilesActiveFilter =
          button.dataset.patientFileFilter || "all";

        renderPatientFilesTab(pet);
      });
    });

  box
    .querySelector("#patientFilesArchiveContent")
    ?.addEventListener("click", (event) => {
      const deleteButton = event.target.closest(
        "[data-delete-patient-file]"
      );

      if (deleteButton) {
  const fileId = deleteButton.dataset.deletePatientFile;

  const file = getPatientFiles(petId).find((item) => {
    return String(item.id) === String(fileId);
  });

  const fileTitle =
    file?.title ||
    file?.name ||
    "цей файл";

  openDeleteModal(
    `
      <div style="text-align:center;">
        <div style="
          font-size:42px;
          margin-bottom:12px;
        ">
          🗑️
        </div>

        <div style="
          font-size:18px;
          font-weight:800;
          color:#fff;
          margin-bottom:8px;
        ">
          Видалити файл?
        </div>

        <div style="
          font-size:13px;
          line-height:1.5;
          color:rgba(255,255,255,.58);
        ">
          Файл
          <strong style="color:#fff;">
            «${escapeHtml(fileTitle)}»
          </strong>
          буде видалено з медичного архіву пацієнта.
        </div>
      </div>
    `,

    () => {
      const next = getPatientFiles(petId).filter((item) => {
        return String(item.id) !== String(fileId);
      });

      setPatientFiles(petId, next);

      closeDeleteModal();
      renderPatientFilesTab(pet);
    }
  );

  return;

      }

      const editButton = event.target.closest(
        "[data-edit-patient-file]"
      );

      if (editButton) {
        const fileId = editButton.dataset.editPatientFile;

        const file = getPatientFiles(petId).find((item) => {
          return String(item.id) === String(fileId);
        });

        if (file) {
          openPatientFileModal(pet, file);
        }
      }
    });
}
function normalizePatientFile(file) {
  const originalType = String(
    file?.category ||
    file?.type ||
    ""
  )
    .trim()
    .toLowerCase();

  let category = "other";

  if (
    originalType.includes("рентген") ||
    originalType.includes("xray") ||
    originalType.includes("x-ray")
  ) {
    category = "xray";
  } else if (
    originalType.includes("узд") ||
    originalType.includes("ультра") ||
    originalType.includes("ultrasound")
  ) {
    category = "ultrasound";
  } else if (
    originalType.includes("фото") ||
    originalType.includes("video") ||
    originalType.includes("відео") ||
    originalType.includes("image") ||
    String(file?.mime || "").startsWith("image/") ||
    String(file?.mime || "").startsWith("video/")
  ) {
    category = "media";
  } else if (
    originalType.includes("pdf") ||
    originalType.includes("документ") ||
    originalType.includes("document") ||
    String(file?.mime || "").includes("pdf") ||
    String(file?.mime || "").includes("word")
  ) {
    category = "document";
  }

  return {
    ...file,
    category,
    title:
      file?.title ||
      file?.name ||
      "Файл пацієнта",
  };
}

function getPatientFileCategoryCounts(files) {
  return files.reduce(
    (acc, file) => {
      const category =
        file.category in PATIENT_FILE_CATEGORIES
          ? file.category
          : "other";

      acc[category] += 1;

      return acc;
    },
    {
      xray: 0,
      ultrasound: 0,
      media: 0,
      document: 0,
      other: 0,
    }
  );
}

function renderPatientFilesArchive(files) {
  if (patientFilesActiveFilter !== "all") {
    return `
      <div class="patientFilesGrid">
        ${files
          .map(renderPatientFileCard)
          .join("")}
      </div>
    `;
  }

  const order = [
    "xray",
    "ultrasound",
    "media",
    "document",
    "other",
  ];

  return order
    .map((category) => {
      const categoryFiles = files.filter((file) => {
        return file.category === category;
      });

      if (!categoryFiles.length) return "";

      const meta = PATIENT_FILE_CATEGORIES[category];

      return `
        <section class="patientFilesGroup">
          <div class="patientFilesGroupHead">
            <div>
              <span>${meta.icon}</span>
              <h3>${escapeHtml(meta.label)}</h3>
            </div>

            <strong>
              ${categoryFiles.length}
              ${getPatientFilesCountLabel(categoryFiles.length)}
            </strong>
          </div>

          <div class="patientFilesGrid">
            ${categoryFiles
              .map(renderPatientFileCard)
              .join("")}
          </div>
        </section>
      `;
    })
    .join("");
}

function getPatientFilesCountLabel(count) {
  const value = Number(count) || 0;

  if (value === 1) return "файл";
  if (value >= 2 && value <= 4) return "файли";

  return "файлів";
}

function renderPatientFilesEmptyState(filter) {
  const meta =
    PATIENT_FILE_CATEGORIES[filter] ||
    PATIENT_FILE_CATEGORIES.all;

  return `
    <div class="patientFilesEmpty">
      <div class="patientFilesEmptyIcon">
        ${meta.icon}
      </div>

      <h3>
        ${
          filter === "all"
            ? "Файлів ще немає"
            : `У категорії «${escapeHtml(meta.label)}» поки порожньо`
        }
      </h3>

      <p>
        Додайте медичне зображення або документ пацієнта.
      </p>

      <button
        class="patientFilesAddButton"
        type="button"
        onclick="openPatientFileModal(state.selectedPet)"
      >
        + Додати перший файл
      </button>
    </div>
  `;
}
function normalizePatientFile(file) {
  const originalType = String(
    file?.category ||
    file?.type ||
    ""
  )
    .trim()
    .toLowerCase();

  let category = "other";

  if (
    originalType.includes("рентген") ||
    originalType.includes("xray") ||
    originalType.includes("x-ray")
  ) {
    category = "xray";
  } else if (
    originalType.includes("узд") ||
    originalType.includes("ультра") ||
    originalType.includes("ultrasound")
  ) {
    category = "ultrasound";
  } else if (
    originalType.includes("фото") ||
    originalType.includes("video") ||
    originalType.includes("відео") ||
    originalType.includes("image") ||
    String(file?.mime || "").startsWith("image/") ||
    String(file?.mime || "").startsWith("video/")
  ) {
    category = "media";
  } else if (
    originalType.includes("pdf") ||
    originalType.includes("документ") ||
    originalType.includes("document") ||
    String(file?.mime || "").includes("pdf") ||
    String(file?.mime || "").includes("word")
  ) {
    category = "document";
  }

  return {
    ...file,
    category,
    title:
      file?.title ||
      file?.name ||
      "Файл пацієнта",
  };
}

function getPatientFileCategoryCounts(files) {
  return files.reduce(
    (acc, file) => {
      const category =
        file.category in PATIENT_FILE_CATEGORIES
          ? file.category
          : "other";

      acc[category] += 1;

      return acc;
    },
    {
      xray: 0,
      ultrasound: 0,
      media: 0,
      document: 0,
      other: 0,
    }
  );
}

function renderPatientFilesArchive(files) {
  if (patientFilesActiveFilter !== "all") {
    return `
      <div class="patientFilesGrid">
        ${files
          .map(renderPatientFileCard)
          .join("")}
      </div>
    `;
  }

  const order = [
    "xray",
    "ultrasound",
    "media",
    "document",
    "other",
  ];

  return order
    .map((category) => {
      const categoryFiles = files.filter((file) => {
        return file.category === category;
      });

      if (!categoryFiles.length) return "";

      const meta = PATIENT_FILE_CATEGORIES[category];

      return `
        <section class="patientFilesGroup">
          <div class="patientFilesGroupHead">
            <div>
              <span>${meta.icon}</span>
              <h3>${escapeHtml(meta.label)}</h3>
            </div>

            <strong>
              ${categoryFiles.length}
              ${getPatientFilesCountLabel(categoryFiles.length)}
            </strong>
          </div>

          <div class="patientFilesGrid">
            ${categoryFiles
              .map(renderPatientFileCard)
              .join("")}
          </div>
        </section>
      `;
    })
    .join("");
}

function getPatientFilesCountLabel(count) {
  const value = Number(count) || 0;

  if (value === 1) return "файл";
  if (value >= 2 && value <= 4) return "файли";

  return "файлів";
}

function renderPatientFilesEmptyState(filter) {
  const meta =
    PATIENT_FILE_CATEGORIES[filter] ||
    PATIENT_FILE_CATEGORIES.all;

  return `
    <div class="patientFilesEmpty">
      <div class="patientFilesEmptyIcon">
        ${meta.icon}
      </div>

      <h3>
        ${
          filter === "all"
            ? "Файлів ще немає"
            : `У категорії «${escapeHtml(meta.label)}» поки порожньо`
        }
      </h3>

      <p>
        Додайте медичне зображення або документ пацієнта.
      </p>

      <button
        class="patientFilesAddButton"
        type="button"
        onclick="openPatientFileModal(state.selectedPet)"
      >
        + Додати перший файл
      </button>
    </div>
  `;
}

function renderPatientFileCard(file) {
  const rawUrl =
    file.url ||
    file.path ||
    file.href ||
    file.fileUrl ||
    file.file_url ||
    "";

  const url = rawUrl
    ? new URL(rawUrl, window.location.origin).toString()
    : "";

  const mime = String(file.mime || file.type || "").toLowerCase();

  const isImage =
    mime.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif)$/i.test(url);

  const isVideo =
    mime.startsWith("video/") ||
    /\.(mp4|mov|webm)$/i.test(url);

  const categoryMeta =
    PATIENT_FILE_CATEGORIES[file.category] ||
    PATIENT_FILE_CATEGORIES.other;

  return `
    <article class="patientFileCard">
      <div class="patientFilePreview">
        ${
          isImage && url
            ? `
              <img
                src="${escapeHtml(url)}"
                alt="${escapeHtml(file.title || file.name || "Файл")}"
                loading="lazy"
              >
            `
            : isVideo && url
              ? `
                <video
                  src="${escapeHtml(url)}"
                  muted
                  preload="metadata"
                ></video>

                <div class="patientFilePlayIcon">▶</div>
              `
              : `
                <div class="patientFileDocumentIcon">
                  ${categoryMeta.icon}
                </div>
              `
        }

        <span class="patientFileCategory">
          ${categoryMeta.icon}
          ${escapeHtml(categoryMeta.label)}
        </span>
      </div>

      <div class="patientFileCardBody">
        <h4>
          ${escapeHtml(file.title || file.name || "Файл")}
        </h4>

        <div class="patientFileMeta">
          <span>
            ${escapeHtml(file.date || "Дата не вказана")}
          </span>

          ${
            file.size
              ? `<span>${escapeHtml(formatFileSize(file.size))}</span>`
              : ""
          }
        </div>

        ${
          file.note
            ? `
              <p class="patientFileNote">
                ${escapeHtml(file.note)}
              </p>
            `
            : ""
        }

        <div class="patientFileCardActions">
          ${
            url
              ? `
                <a
                  href="${escapeHtml(url)}"
                  target="_blank"
                  rel="noopener"
                  class="patientFileOpenButton"
                >
                  Відкрити
                </a>
              `
              : `
                <button
                  class="patientFileOpenButton"
                  type="button"
                  disabled
                >
                  Файл недоступний
                </button>
              `
          }

          <button
            class="patientFileActionButton"
            type="button"
            title="Редагувати"
            data-edit-patient-file="${escapeHtml(file.id)}"
          >
            ✏️
          </button>

          <button
            class="patientFileActionButton danger"
            type="button"
            title="Видалити"
            data-delete-patient-file="${escapeHtml(file.id)}"
          >
            🗑
          </button>
        </div>
      </div>
    </article>
  `;
}
function openPatientFileModal(pet, existingFile = null) {
  if (!pet) {
    alert("Пацієнта не знайдено.");
    return;
  }

  document
    .querySelector(".patientFileModalOverlay")
    ?.remove();

  const isEdit = Boolean(existingFile);

  const fileData = normalizePatientFile(
    existingFile || {
      category: "xray",
      title: "",
      date: todayISO(),
      note: "",
      url: "",
      name: "",
      size: 0,
      mime: "",
    }
  );

  const modal = document.createElement("div");
  modal.className = "patientFileModalOverlay";

  modal.innerHTML = `
    <div class="patientFileModal">
      <button
        class="patientFileModalClose"
        type="button"
        aria-label="Закрити"
      >
        ×
      </button>

      <div class="patientFileModalHead">
        <div class="patientFileModalIcon">
          📁
        </div>

        <div>
          <h2>
            ${
              isEdit
                ? "Редагувати файл"
                : "Додати файл пацієнта"
            }
          </h2>

          <p>
            ${escapeHtml(pet.name || "Пацієнт")}
            · медичний архів
          </p>
        </div>
      </div>

      <form id="patientFileModalForm">
        <div class="patientFileModalGrid">
          <label class="patientFileModalField">
            <span>Категорія *</span>

            <select
              id="patientFileCategory"
              required
            >
              ${Object.entries(PATIENT_FILE_CATEGORIES)
                .filter(([key]) => key !== "all")
                .map(
                  ([key, meta]) => `
                    <option
                      value="${escapeHtml(key)}"
                      ${
                        fileData.category === key
                          ? "selected"
                          : ""
                      }
                    >
                      ${meta.icon} ${escapeHtml(meta.label)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>

          <label class="patientFileModalField">
            <span>Дата дослідження</span>

            <input
              id="patientFileDate"
              type="date"
              value="${escapeHtml(
                fileData.date || todayISO()
              )}"
            >
          </label>

          <label class="patientFileModalField patientFileModalWide">
            <span>Назва *</span>

            <input
              id="patientFileTitle"
              type="text"
              maxlength="160"
              required
              value="${escapeHtml(
                fileData.title || ""
              )}"
              placeholder="Наприклад: Грудна клітка, 2 проєкції"
            >
          </label>

          <label class="patientFileModalField patientFileModalWide">
            <span>Коментар</span>

            <textarea
              id="patientFileNote"
              rows="4"
              maxlength="600"
              placeholder="Опис дослідження або важливі примітки"
            >${escapeHtml(fileData.note || "")}</textarea>
          </label>
        </div>

        <div class="patientFileUploadZone">
          <input
            id="patientFileUploadInput"
            type="file"
            accept="image/*,video/*,.pdf,.doc,.docx"
            hidden
          >

          <div
            class="patientFileUploadPreview"
            id="patientFileUploadPreview"
          >
            ${renderPatientFileModalPreview(fileData)}
          </div>

          <div class="patientFileUploadInfo">
            <h3>
              ${
                isEdit && fileData.url
                  ? "Поточний файл"
                  : "Оберіть файл"
              }
            </h3>

            <p>
              JPG, PNG, WEBP, MP4, PDF, DOC або DOCX.
              Максимальний розмір — 20 МБ.
            </p>

            <button
              class="patientFileUploadChoose"
              id="btnChoosePatientFile"
              type="button"
            >
              ${
                isEdit && fileData.url
                  ? "Замінити файл"
                  : "Обрати файл"
              }
            </button>
          </div>
        </div>

        <div class="patientFileModalActions">
          <button
            class="patientFileModalCancel"
            id="btnCancelPatientFile"
            type="button"
          >
            Скасувати
          </button>

          <button
            class="patientFileModalSave"
            id="btnSavePatientFile"
            type="submit"
          >
            ${
              isEdit
                ? "Зберегти зміни"
                : "Додати файл"
            }
          </button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  const form =
    modal.querySelector("#patientFileModalForm");

  const fileInput =
    modal.querySelector("#patientFileUploadInput");

  const preview =
    modal.querySelector("#patientFileUploadPreview");

  let selectedFile = null;
  let uploadedFileData = null;

  const close = () => {
    modal.remove();
  };

  modal
    .querySelector(".patientFileModalClose")
    ?.addEventListener("click", close);

  modal
    .querySelector("#btnCancelPatientFile")
    ?.addEventListener("click", close);

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      close();
    }
  });

  modal
    .querySelector("#btnChoosePatientFile")
    ?.addEventListener("click", () => {
      fileInput?.click();
    });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];

    if (!file) return;

    if (file.size > 20 * 1024 * 1024) {
      alert("Файл завеликий. Максимум 20 МБ.");
      fileInput.value = "";
      return;
    }

    selectedFile = file;
    uploadedFileData = null;

    if (preview) {
      preview.innerHTML =
        renderSelectedPatientFilePreview(file);
    }

    const titleInput =
      modal.querySelector("#patientFileTitle");

    if (
      titleInput &&
      !String(titleInput.value || "").trim()
    ) {
      titleInput.value =
        removePatientFileExtension(file.name);
    }
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const category =
      modal
        .querySelector("#patientFileCategory")
        ?.value || "other";

    const date =
      modal
        .querySelector("#patientFileDate")
        ?.value || todayISO();

    const title =
      modal
        .querySelector("#patientFileTitle")
        ?.value?.trim() || "";

    const note =
      modal
        .querySelector("#patientFileNote")
        ?.value?.trim() || "";

    if (!title) {
      alert("Вкажіть назву файлу.");
      return;
    }

    if (!isEdit && !selectedFile) {
      alert("Оберіть файл для завантаження.");
      return;
    }

    const saveButton =
      modal.querySelector("#btnSavePatientFile");

    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = selectedFile
        ? "Завантаження…"
        : "Збереження…";
    }

    try {
      if (selectedFile) {
        uploadedFileData =
          await uploadPatientFile(selectedFile);
      }

      const petId = String(pet.id);
      const files = getPatientFiles(petId);

      const savedUrl =
        uploadedFileData?.url ||
        uploadedFileData?.path ||
        uploadedFileData?.href ||
        existingFile?.url ||
        "";

      const savedName =
        uploadedFileData?.name ||
        uploadedFileData?.original_name ||
        selectedFile?.name ||
        existingFile?.name ||
        title;

      const savedSize =
        selectedFile?.size ||
        uploadedFileData?.size ||
        existingFile?.size ||
        0;

      const savedMime =
        selectedFile?.type ||
        uploadedFileData?.mime ||
        uploadedFileData?.type ||
        existingFile?.mime ||
        "";

      if (isEdit) {
        const next = files.map((file) => {
          if (
            String(file.id) !==
            String(existingFile.id)
          ) {
            return file;
          }

          return {
            ...file,

            category,
            type:
              PATIENT_FILE_CATEGORIES[category]
                ?.label || "Інше",

            title,
            name: savedName,
            url: savedUrl,
            size: savedSize,
            mime: savedMime,
            note,
            date,

            updated_at:
              new Date().toISOString(),
          };
        });

        setPatientFiles(petId, next);
      } else {
        const nextFile = {
          id:
            "pfile_" +
            Date.now().toString(36) +
            "_" +
            Math.random()
              .toString(16)
              .slice(2),

          category,

          type:
            PATIENT_FILE_CATEGORIES[category]
              ?.label || "Інше",

          title,
          name: savedName,
          url: savedUrl,
          size: savedSize,
          mime: savedMime,
          note,
          date,

          created_by:
            state.me?.display_name ||
            sessionStorage.getItem(
              "pug_active_display_name"
            ) ||
            "",

          created_at:
            new Date().toISOString(),
        };

        setPatientFiles(
          petId,
          [nextFile, ...files]
        );
      }

      close();
      renderPatientFilesTab(pet);
    } catch (error) {
      console.error(
        "save patient file failed:",
        error
      );

      alert(
        "Не вдалося зберегти файл: " +
        (error?.message || error)
      );
    } finally {
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = isEdit
          ? "Зберегти зміни"
          : "Додати файл";
      }
    }
  });

  modal
    .querySelector("#patientFileTitle")
    ?.focus();
}

function renderPatientFileModalPreview(file) {
  const rawUrl =
    file?.url ||
    file?.path ||
    file?.href ||
    "";

  const url = rawUrl
    ? new URL(
        rawUrl,
        window.location.origin
      ).toString()
    : "";

  const mime =
    String(file?.mime || "").toLowerCase();

  if (
    url &&
    (
      mime.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif)$/i.test(url)
    )
  ) {
    return `
      <img
        src="${escapeHtml(url)}"
        alt=""
      >
    `;
  }

  if (
    url &&
    (
      mime.startsWith("video/") ||
      /\.(mp4|mov|webm)$/i.test(url)
    )
  ) {
    return `
      <video
        src="${escapeHtml(url)}"
        muted
        controls
        preload="metadata"
      ></video>
    `;
  }

  if (url) {
    return `
      <div class="patientFileUploadDocument">
        📄
        <span>
          ${escapeHtml(
            file?.name || "Документ"
          )}
        </span>
      </div>
    `;
  }

  return `
    <div class="patientFileUploadEmpty">
      <span>＋</span>
      <small>Файл ще не вибрано</small>
    </div>
  `;
}

function renderSelectedPatientFilePreview(file) {
  if (!file) {
    return renderPatientFileModalPreview(null);
  }

  const tempUrl =
    URL.createObjectURL(file);

  if (
    String(file.type || "")
      .startsWith("image/")
  ) {
    return `
      <img
        src="${escapeHtml(tempUrl)}"
        alt="${escapeHtml(file.name || "")}"
      >
    `;
  }

  if (
    String(file.type || "")
      .startsWith("video/")
  ) {
    return `
      <video
        src="${escapeHtml(tempUrl)}"
        muted
        controls
      ></video>
    `;
  }

  return `
    <div class="patientFileUploadDocument">
      📄
      <span>
        ${escapeHtml(file.name || "Документ")}
      </span>
    </div>
  `;
}

function removePatientFileExtension(filename) {
  return String(filename || "")
    .replace(/\.[^/.]+$/, "")
    .trim();
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

  "Т4": [
    "T4",
  ],

  "ТТГ": [
    "TSH",
  ],

  "Загальний аналіз сечі": [
    "UA_SG",
    "UA_PH",
    "UA_PRO",
    "UA_GLU",
    "UA_KET",
    "UA_BIL",
    "UA_BLOOD",
    "UA_WBC",
    "UA_RBC",
  ],

  "Коагулограма": [
    "PT",
    "APTT",
    "INR",
    "FIB",
  ],

  "Електроліти": [
    "NA",
    "K",
    "CL",
    "CA",
    "PHOS",
    "MG",
  ],
};
Object.assign(LAB_LABELS, {
  T4: "Тироксин загальний (Т4)",
  TSH: "Тиреотропний гормон (ТТГ)",

  UA_SG: "Відносна щільність",
  UA_PH: "pH",
  UA_PRO: "Білок",
  UA_GLU: "Глюкоза",
  UA_KET: "Кетони",
  UA_BIL: "Білірубін",
  UA_BLOOD: "Кров / гемоглобін",
  UA_WBC: "Лейкоцити",
  UA_RBC: "Еритроцити",

  PT: "Протромбіновий час",
  APTT: "АЧТЧ",
  INR: "МНВ",
  FIB: "Фібриноген",

  NA: "Натрій",
  K: "Калій",
  CL: "Хлор",
  CA: "Кальцій",
  PHOS: "Фосфор",
  MG: "Магній",
});

const LAB_TYPE_META = {
  "Біохімія": {
    short: "БХ",
    icon: "⚗️",
    description: "Печінка, нирки, білки та глюкоза",
  },

  "ЗАК": {
    short: "ЗАК",
    icon: "🩸",
    description: "Клітини крові та лейкоформула",
  },

  "Т4": {
    short: "Т4",
    icon: "🦋",
    description: "Функція щитоподібної залози",
  },

  "ТТГ": {
    short: "ТТГ",
    icon: "◉",
    description: "Тиреотропний гормон",
  },

  "Загальний аналіз сечі": {
    short: "Сеча",
    icon: "💧",
    description: "Фізико-хімічні показники сечі",
  },

  "Коагулограма": {
    short: "Коаг.",
    icon: "🧬",
    description: "Система згортання крові",
  },

  "Електроліти": {
    short: "Електроліти",
    icon: "⚡",
    description: "Натрій, калій, хлор та мінерали",
  },
};

const LAB_DEFAULT_UNITS = {
  T4: "нмоль/л",
  TSH: "нг/мл",

  UA_SG: "",
  UA_PH: "",
  UA_PRO: "г/л",
  UA_GLU: "ммоль/л",
  UA_KET: "ммоль/л",
  UA_BIL: "мкмоль/л",
  UA_BLOOD: "ер./мкл",
  UA_WBC: "кл./п.з.",
  UA_RBC: "кл./п.з.",

  PT: "с",
  APTT: "с",
  INR: "",
  FIB: "г/л",

  NA: "ммоль/л",
  K: "ммоль/л",
  CL: "ммоль/л",
  CA: "ммоль/л",
  PHOS: "ммоль/л",
  MG: "ммоль/л",
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

    if (!json.ok) {
      throw new Error(json.error || "Cannot load staff");
    }

    const items =
      Array.isArray(json.items)
        ? json.items
        : Array.isArray(json.data)
        ? json.data
        : [];

    // <<< ВОТ ЭТОГО НЕ ХВАТАЛО
    state.staff = items;

    return items;

  } catch (e) {
    console.error("loadStaffApi failed:", e);

    state.staff = [];

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

async function loadStaffDashboardApi(staffId) {
  try {
    const res = await fetch(`/api/staff/${encodeURIComponent(staffId)}/dashboard`, {
      credentials: "include",
      headers: { Accept: "application/json", ...getOrgHeaders() },
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok || !json) throw new Error("dashboard failed");

    return json.data || json;
  } catch (e) {
    console.warn("loadStaffDashboardApi error:", e);

    return {
      visits_this_month: 0,
      closed_checks: 0,
      revenue: 0,
      avg_check: 0,
      rating_avg: 0,
      rating: 0,
      revenue_growth_percent: 0,
      visits_growth_percent: 0,
      checks_growth_percent: 0,
      avg_check_growth_percent: 0,
      last_visits: [],
      revenue_chart: [],
      visits_chart: [],
      penalties: {
        late: 0,
        absences: 0,
        warnings: 0,
        bonuses_amount: 0,
        penalties_amount: 0
      }
    };
  }
}
// ==========================================================================
// Doc.PUG CRM Mini — app.js (ИНТЕРАКТИВНЫЙ КАЛЕНДАРЬ, СМЕНЫ И DRAG-AND-DROP)
// Часть 6 (Строки 3501 — 4000)
// ==========================================================================

async function renderCalendarTab() {
  const page = document.querySelector('.page[data-page="calendar"]');
  if (!page) return;

  if (calendarMode === "schedule") {
    calendarMode = "day";
  }

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

    $("[data-cal-mode='day']")?.addEventListener("click", async () => {
      calendarMode = "day";
      await renderCalendarTab();
    });

    $("[data-cal-mode='month']")?.addEventListener("click", async () => {
      calendarMode = "month";
      await renderCalendarTab();
    });

    $("[data-cal-mode='routes']")?.addEventListener("click", async () => {
      calendarMode = "routes";
      await renderCalendarTab();
    });

    $("#calPrevWeek")?.addEventListener("click", async () => {
      const d = new Date(weekDays[0]);
      d.setDate(d.getDate() - 7);
      window.__calendarDate = d.toISOString().slice(0, 10);
      await renderCalendarTab();
    });

    $("#calNextWeek")?.addEventListener("click", async () => {
      const d = new Date(weekDays[0]);
      d.setDate(d.getDate() + 7);
      window.__calendarDate = d.toISOString().slice(0, 10);
      await renderCalendarTab();
    });

    $$("[data-cal-event-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.dataset.calEventId;
        const ev = weekEvents.find((x) => String(x.id) === String(id));
        if (!ev) return;

        openCalendarEditModal(ev, ev.event_date || today, async () => {
          await renderCalendarTab();
        });
      });
    });

    return;
  }

  if (calendarMode === "month") {
    const base = new Date(today);
    const year = base.getFullYear();
    const month = base.getMonth();

    const monthStart = new Date(year, month, 1);

    const startDay = monthStart.getDay() || 7;
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - startDay + 1);

    const localISO = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };

    const monthDays = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return localISO(d);
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

    $("[data-cal-mode='day']")?.addEventListener("click", async () => {
      calendarMode = "day";
      await renderCalendarTab();
    });

    $("[data-cal-mode='week']")?.addEventListener("click", async () => {
      calendarMode = "week";
      await renderCalendarTab();
    });

    $("[data-cal-mode='routes']")?.addEventListener("click", async () => {
      calendarMode = "routes";
      await renderCalendarTab();
    });

    $("#calPrevMonth")?.addEventListener("click", async () => {
      const d = new Date(year, month - 1, 1, 12, 0, 0);
      window.__calendarDate = localISO(d);
      await renderCalendarTab();
    });

    $("#calNextMonth")?.addEventListener("click", async () => {
      const d = new Date(year, month + 1, 1, 12, 0, 0);
      window.__calendarDate = localISO(d);
      await renderCalendarTab();
    });

    const selectedMonthDates = new Set();

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

            ${selectedMonthDates.size > 1 ? `
              <div class="monthSelectedBox">
                <div class="monthBulkTitle">Виділено днів: ${selectedMonthDates.size}</div>

                <label class="monthBulkField">
                  <span>Лікар для виділених днів</span>
                  <select id="monthSelectedStaff">
                    ${staff.map((doc) => `
                      <option value="${escapeHtml(String(doc.id))}">
                        ${escapeHtml(doc.name || "Працівник")}
                      </option>
                    `).join("")}
                  </select>
                </label>

                <button class="primary monthBulkApply" id="monthApplySelectedDates" type="button">
                  Застосувати на виділені дні
                </button>
              </div>
            ` : ""}

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

        const selectedDays = $$(".monthBulkDay.active")
          .map((btn) => Number(btn.dataset.bulkDay));

        if (!staffId || !from || !to || !selectedDays.length) {
          alert("Оберіть лікаря, період і дні тижня.");
          return;
        }

        const start = new Date(from + "T12:00:00");
        const end = new Date(to + "T12:00:00");

        if (start > end) {
          alert("Дата 'від' не може бути пізніше дати 'до'.");
          return;
        }

        const dates = [];
        const cursor = new Date(start);

        while (cursor <= end) {
          const jsDay = cursor.getDay();
          const normalizedDay = jsDay === 0 ? 7 : jsDay;

          if (selectedDays.includes(normalizedDay)) {
            dates.push(localISO(cursor));
          }

          cursor.setDate(cursor.getDate() + 1);
        }

        if (!dates.length) {
          alert("У вибраному періоді немає таких днів.");
          return;
        }

        if (!confirm(`Застосувати графік для ${dates.length} днів?`)) return;

        for (const workDate of dates) {
          await saveStaffScheduleApi({
            work_date: workDate,
            staff_id: staffId,
            is_active: true,
          });
        }

        await renderCalendarTab();
      });

      $("#monthApplySelectedDates")?.addEventListener("click", async () => {
        const staffId = $("#monthSelectedStaff")?.value;

        if (!staffId || selectedMonthDates.size < 2) {
          alert("Виділи дні та обери лікаря.");
          return;
        }

        const dates = Array.from(selectedMonthDates).sort();

        if (!confirm(`Призначити лікаря на ${dates.length} днів?`)) return;

        for (const workDate of dates) {
          await saveStaffScheduleApi({
            work_date: workDate,
            staff_id: staffId,
            is_active: true,
          });
        }

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

        for (const doc of staff) {
          await saveStaffScheduleApi({
            work_date: date,
            staff_id: doc.id,
            is_active: activeStaffIds.has(String(doc.id)),
          });
        }

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

  const hours = [];
  for (let h = 7; h <= 24; h++) {
    hours.push(String(h).padStart(2, "0") + ":00");
  }

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
                  : isCoveredByLongEvent
                    ? ""
                    : `<div class="calEmptySlot" data-empty-slot="1" data-hour="${escapeHtml(hour)}" data-staff-id="${escapeHtml(String(doc.id))}">+ Запис</div>`
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
        </div>
      </div>

      <div class="calendarTop">
        <button class="ghost" id="calPrevDay" type="button">←</button>
        <div class="calendarDate">${escapeHtml(today)}</div>
        <button class="ghost" id="calNextDay" type="button">→</button>
      </div>

      <div class="calendarWorkArea">
  <div class="calendarMainArea">
    <div class="calTopScroll" id="calTopScroll">
      <div class="calTopScrollInner" id="calTopScrollInner"></div>
    </div>

    <div class="calendarDayGrid" id="calendarDayGrid">
          <div class="calTimeCol">
            <div class="calTimeHead">Час</div>
            ${hours.map((h) => `<div class="calTime">${escapeHtml(h)}</div>`).join("")}
          </div>

          <div class="calDoctorsGrid">
            ${staffHtml || `<div class="hint">Ветеринарів поки немає.</div>`}
          </div>
                </div>
      </div>

      <aside class="calStaffPanel">
          <div class="calStaffPanelHead">
            <div>
              <div class="calStaffPanelTitle">Ветеринари</div>
              <div class="calStaffPanelSub">Перетягни в слот</div>
            </div>
            <button class="miniBtn" id="btnAddStaffFromCalendar" type="button">+ Додати</button>
          </div>

          <div class="calStaffDragList">
            ${staffPaletteHtml || `<div class="hint">Немає співробітників.</div>`}
          </div>
        </aside>
      </div>
    </div>
  `;
  initCalendarTopScroll();

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

    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
    });
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

    slot.addEventListener("dragover", (e) => {
      e.preventDefault();
      slot.classList.add("calSlotDrop");
    });

    slot.addEventListener("dragleave", () => {
      slot.classList.remove("calSlotDrop");
    });

    slot.addEventListener("drop", async (e) => {
      e.preventDefault();
      slot.classList.remove("calSlotDrop");

      let data = null;

      try {
        data = JSON.parse(e.dataTransfer.getData("text/plain") || "{}");
      } catch {
        return;
      }

      const staffId = data.staff_id;
      if (!staffId) return;

      const hour = slot.dataset.hour;
      const title = (prompt(`Запис на ${hour}. Назва:`, "Новий прийом") || "").trim();
      if (!title) return;

      const durationRaw = prompt("Тривалість у хвилинах:", "60") || "60";
      const duration = Math.max(15, Number(durationRaw) || 60);
      const endTime = addMinutesToTime(hour, duration);
      const note = (prompt("Коментар:", "") || "").trim();

      const created = await createCalendarEventApi({
        title,
        event_date: today,
        start_time: hour,
        end_time: endTime,
        staff_id: staffId,
        note,
      });

      if (created) await renderCalendarTab();
    });
  });

  $("#btnAddStaffFromCalendar")?.addEventListener("click", async () => {
    alert("Додавання співробітників тепер знаходиться у розділі Команда.");
  });

  $("#calPrevDay")?.addEventListener("click", async () => {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    window.__calendarDate = d.toISOString().slice(0, 10);
    await renderCalendarTab();
  });

  $("#calNextDay")?.addEventListener("click", async () => {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    window.__calendarDate = d.toISOString().slice(0, 10);
    await renderCalendarTab();
  });

  $$("[data-del-calendar-event]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const id = btn.dataset.delCalendarEvent;
      if (!id) return;

      if (!confirm("Видалити запис з календаря?")) return;

      const ok = await deleteCalendarEventApi(id);
      if (ok) await renderCalendarTab();
    });
  });

  $$("[data-edit-calendar-event]").forEach((card) => {
    card.addEventListener("click", async (e) => {
      if (e.target.closest("[data-del-calendar-event]")) return;

      const id = card.dataset.editCalendarEvent;
      if (!id) return;

      const ev = todayEvents.find((x) => String(x.id) === String(id));
      if (!ev) return alert("Запис не знайдено");

      openCalendarEditModal(ev, today, async () => {
        await renderCalendarTab();
      });
    });
  });

  $$("[data-cal-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      calendarMode = btn.dataset.calMode;
      await renderCalendarTab();
    });
  });
  function initCalendarTopScroll() {
  const topScroll = document.getElementById("calTopScroll");
  const topInner = document.getElementById("calTopScrollInner");
  const grid = document.getElementById("calendarDayGrid");

  if (!topScroll || !topInner || !grid) return;

  requestAnimationFrame(() => {
    topInner.style.width = `${grid.scrollWidth}px`;

    topScroll.onscroll = () => {
      grid.scrollLeft = topScroll.scrollLeft;
    };

    grid.onscroll = () => {
      topScroll.scrollLeft = grid.scrollLeft;
    };
  });
}
}

// ==========================================================================
// Doc.PUG CRM Mini — app.js (ПЕРСОНАЛ, МОДАЛКИ КАЛЕНДАРЯ И КАРТОЧКИ АНАЛИЗОВ)
// Часть 5
// ==========================================================================

async function openStaffProfileModal(doc) {

  const staffColor = doc.color || "#7C5CFF";

  const staffName = doc.name || "Працівник";

  const staffLetter = staffName.trim().charAt(0).toUpperCase() || "?";

  const roleLabel =

    doc.role === "assistant" ? "Асистент" :

    doc.role === "admin" ? "Адміністратор" :

    "Ветеринарний лікар";

  // ====== ЗАГРУЖАЕМ DASHBOARD ======

  const dashboard = await loadStaffDashboardApi(doc.id);

  const demoRevenue = Number(dashboard.revenue || 0);

  const demoVisits = Number(dashboard.visits_this_month || 0);

  const demoChecks = Number(dashboard.closed_checks || 0);

  const demoAvgCheck = Number(dashboard.avg_check || 0);

  const revenueGrowth = Number(dashboard.revenue_growth_percent || 0);

  const visitsGrowth = Number(dashboard.visits_growth_percent || 0);

  const checksGrowth = Number(dashboard.checks_growth_percent || 0);

  const avgCheckGrowth = Number(dashboard.avg_check_growth_percent || 0);

  // ====== ДОБАВИТЬ ВОТ СЮДА ======

  const lastVisits = Array.isArray(dashboard.last_visits)

    ? dashboard.last_visits

    : [];

  const hasLastVisits = lastVisits.length > 0;

const hasRating = Number(dashboard.rating_count || 0) > 0;

const skills = Array.isArray(dashboard.skills)
  ? dashboard.skills
  : [];

const achievements = Array.isArray(dashboard.achievements)
  ? dashboard.achievements
  : [];

const xp = Number(dashboard.xp || 0);
const level = Number(dashboard.level || 1);
const nextLevelXp = Number(dashboard.next_level_xp || 100);
const xpPercent = nextLevelXp > 0
  ? Math.min(100, Math.round((xp / nextLevelXp) * 100))
  : 0;

// ====== ПОТОМ СОЗДАЕМ MODAL ======

const modal = document.createElement("div");
modal.className = "staffProfileOverlay";

  modal.innerHTML = `
    <div class="staffProfileModal staffProfilePro" style="--staff-color:${escapeHtml(staffColor)};">
      <button class="staffProfileClose" type="button">×</button>

      <aside class="staffProfileSidebar">
        <div class="staffProfileSideTop">
          ${
            doc.avatar
              ? `<img class="staffProfileAvatarImg" src="${escapeHtml(doc.avatar)}" alt="${escapeHtml(staffName)}">`
              : `<div class="staffProfileAvatarLetter">${escapeHtml(staffLetter)}</div>`
          }

          <div class="staffProfileSideName">${escapeHtml(staffName)}</div>
          <div class="staffProfileSideRole">${escapeHtml(roleLabel)}</div>
          <div class="staffProfileSideStatus">На зміні</div>
        </div>

        <nav class="staffProfileNav">
          <button class="active" type="button">▦ Огляд</button>
         <button type="button">🩺 Прийоми</button>
          <button type="button">💰 Фінанси</button>
          
          <button type="button">📈 Графіки</button>
          <button type="button">⚖ Штрафи та бонуси</button>
          <button type="button">🎓 Навички</button>
          <button type="button">📄 Документи</button>
          <button type="button">⚙ Налаштування</button>
        </nav>

        <div class="staffProfileContactCard">
          <h4>Контакти</h4>
          <div>📞 ${escapeHtml(doc.phone || "Не вказано")}</div>
          <div>✉ Email не вказано</div>
          <div>👥 Працює з —</div>
          <div>ID #STF-${escapeHtml(String(doc.id || "0000")).padStart(4, "0")}</div>
        </div>
      </aside>

      <main class="staffProfileMain">
        <header class="staffProfileHeaderPro">
          <div>
            <div class="staffProfileBreadcrumb">Команда / Профіль співробітника</div>
            <h2>${escapeHtml(staffName)}</h2>
            <div class="staffProfileSubtitle">${escapeHtml(roleLabel)} · ${escapeHtml(doc.specialization || "Напрями не вказані")}</div>
          </div>

          <button class="ghost staffProfileEditInside" type="button" data-edit-staff-from-profile="${escapeHtml(String(doc.id))}">
            ✏️ Редагувати
          </button>
        </header>
<section class="staffInsightCard">
  <div class="staffInsightIcon">✨</div>
  <div>
    <div class="staffInsightTitle">Що варто знати сьогодні</div>
    <div class="staffInsightText">
      ${escapeHtml(staffName)} працює стабільно: виручка змінилась на <b>${revenueGrowth}%</b>, кількість візитів — на <b>${visitsGrowth}%</b>.
      Скарг не зафіксовано. До плану місяця залишилось <b>13 570 грн</b>.
    </div>
  </div>
</section>

        <section class="staffProfileKpis">
          <div class="staffKpiCard">
            <div class="staffKpiIcon">📅</div>
            <div>
              <span>Візити цього місяця</span>
              <strong>${demoVisits}</strong>
              <small>↑ ${visitsGrowth}% до минулого місяця</small>
            </div>
          </div>

          <div class="staffKpiCard">
            <div class="staffKpiIcon">✅</div>
            <div>
              <span>Закрито чеків</span>
              <strong>${demoChecks}</strong>
              <small>↑ ${checksGrowth}% до минулого місяця</small>
            </div>
          </div>

          <div class="staffKpiCard">
            <div class="staffKpiIcon">💳</div>
            <div>
              <span>Виручка</span>
              <strong>${demoRevenue.toLocaleString("uk-UA")} грн</strong>
              <small>↑ ${revenueGrowth}% до минулого місяця</small>
            </div>
          </div>

          <div class="staffKpiCard">
            <div class="staffKpiIcon">📊</div>
            <div>
              <span>Середній чек</span>
              <strong>${demoAvgCheck.toLocaleString("uk-UA")} грн</strong>
              <small>↑ ${avgCheckGrowth}% до минулого місяця</small>
            </div>
          </div>
        </section>

        <section class="staffProfileDashboardGrid">
          <div class="staffPanel staffChartPanel">
            <div class="staffPanelHead">
              <h3>Виручка</h3>
              <span>грн</span>
            </div>
            <div class="staffFakeLineChart">
              <span style="height:35%"></span>
              <span style="height:48%"></span>
              <span style="height:62%"></span>
              <span style="height:76%"></span>
              <span style="height:80%"></span>
              <span style="height:92%"></span>
            </div>
            <div class="staffChartLabels">
              <span>Січ</span><span>Лют</span><span>Бер</span><span>Кві</span><span>Тра</span><span>Чер</span>
            </div>
          </div>

          <div class="staffPanel staffChartPanel">
            <div class="staffPanelHead">
              <h3>Кількість візитів</h3>
              <span>візити</span>
            </div>
            <div class="staffFakeBarChart">
              <span style="height:62%"></span>
              <span style="height:58%"></span>
              <span style="height:68%"></span>
              <span style="height:86%"></span>
              <span style="height:78%"></span>
              <span style="height:82%"></span>
            </div>
            <div class="staffChartLabels">
              <span>Січ</span><span>Лют</span><span>Бер</span><span>Кві</span><span>Тра</span><span>Чер</span>
            </div>
          </div>

          <div class="staffPanel staffCareerPanel">
  <div class="staffPanelHead">
    <h3>🏆 Карʼєра</h3>
    <span>Level ${level}</span>
  </div>

  <div class="staffLevelBox">
    <div class="staffLevelTop">
      <strong>Рівень ${level}</strong>
      <span>${xp} / ${nextLevelXp} XP</span>
    </div>

    <div class="staffXpBar">
      <div style="width:${xpPercent}%"></div>
    </div>

    <p>До наступного рівня залишилось ${Math.max(0, nextLevelXp - xp)} XP</p>
  </div>

  ${
    achievements.length
      ? `
        <div class="staffAchievementList">
          ${achievements.map((a) => `
            <div class="staffAchievementItem">
              <div>${escapeHtml(a.icon || "🏅")}</div>
              <div>
                <b>${escapeHtml(a.title || "Досягнення")}</b>
                <span>${escapeHtml(a.description || "")}</span>
              </div>
            </div>
          `).join("")}
        </div>
      `
      : `
        <div class="staffEmptyState">
          <div class="staffEmptyIcon">🏅</div>
          <b>Досягнень ще немає</b>
          <span>Коли співробітник буде проводити прийоми, отримувати оцінки та виконувати цілі — тут зʼявляться його досягнення.</span>
        </div>
      `
  }
</div>

          <div class="staffPanel staffRatingPanel">
  <h3>⭐ Рейтинг та оцінки</h3>

  ${
    hasRating
      ? `
        <div class="staffRatingBig">${Number(dashboard.rating_avg || 0).toFixed(1)} <span>★★★★★</span></div>
        <p>на основі ${Number(dashboard.rating_count || 0)} оцінок</p>
      `
      : `
        <div class="staffEmptyState">
          <div class="staffEmptyIcon">⭐</div>
          <b>Оцінок ще немає</b>
          <span>Після завершення прийому адміністратор зможе поставити оцінку лікарю.</span>
        </div>
      `
  }
</div>

          <div class="staffPanel staffCallsPanel">
  <h3>Останні прийоми</h3>

  ${
    hasLastVisits
      ? lastVisits.map((v) => `
        <button class="staffVisitRow" type="button" data-open-visit-id="${escapeHtml(String(v.id || ""))}">
          <div>
            <b>${escapeHtml(v.date || "—")}</b>
            <span>${escapeHtml(v.status || "Прийом")}</span>
          </div>

          <div>
            <strong>${escapeHtml(v.patient_name || "Пацієнт")}</strong>
            <span>${escapeHtml(v.dx || v.note || "Без опису")}</span>
          </div>

          <div>
            <b>${Number(v.total || 0).toLocaleString("uk-UA")} грн</b>
            <span class="done">Відкрити →</span>
          </div>
        </button>
      `).join("")
      : `
        <div class="staffEmptyState">
          <div class="staffEmptyIcon">🩺</div>
          <b>Прийомів ще немає</b>
          <span>Коли прийоми будуть прив’язані до цього лікаря, вони з’являться тут автоматично.</span>
        </div>
      `
  }
</div>

          <div class="staffPanel">
            <h3>Фінансова інформація</h3>
            <div class="staffFinanceRows">
              <div><span>Ставка</span><b>${escapeHtml(String(doc.shift_rate || 0))} грн / зміна</b></div>
              <div><span>Відсоток</span><b>${escapeHtml(String(doc.percent_rate || 0))}%</b></div>
              <div><span>Виплачено цього місяця</span><b>0 грн</b></div>
              <div><span>Бонуси цього місяця</span><b>0 грн</b></div>
              <div><span>Штрафи цього місяця</span><b>0 грн</b></div>
            </div>
          </div>

          <div class="staffPanel">
            <h3>Штрафи та бонуси</h3>
            <div class="staffFinanceRows">
              <div><span>Запізнення</span><b>0</b></div>
              <div><span>Прогули</span><b>0</b></div>
              <div><span>Попередження</span><b>0</b></div>
              <div><span>Бонуси</span><b>0 грн</b></div>
              <div><span>Штрафи</span><b>0 грн</b></div>
            </div>
          </div>

         <div class="staffPanel staffSkillsPanel">
  <h3>Навички та сертифікації</h3>

  ${
    skills.length
      ? `
        <div class="staffSkillList">
          ${skills.map((s) => `<span>${escapeHtml(s.name || s)}</span>`).join("")}
          <button type="button">+ Додати навичку</button>
        </div>
      `
      : `
        <div class="staffEmptyState">
          <div class="staffEmptyIcon">🎓</div>
          <b>Навички ще не додані</b>
          <span>Додамо реальні навички, сертифікати та спеціалізації співробітника.</span>
        </div>
      `
  }
</div>

          <div class="staffPanel">
            <h3>Нотатка</h3>
            <div class="hint">${escapeHtml(doc.note || "Нотатка не додана.")}</div>
          </div>
        </section>
      </main>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector(".staffProfileClose")?.addEventListener("click", () => modal.remove());

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector("[data-edit-staff-from-profile]")?.addEventListener("click", () => {
    modal.remove();
    openEditStaffModal(doc);
  });
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
  const speciesName = speciesKey === "cat" ? "кіт" : "собака";

  const labs = getLabsByPetId(pet.id)
    .slice()
    .sort((a, b) => {
      return String(b.date || "").localeCompare(String(a.date || ""));
    });

  box.innerHTML = `
    <div class="patientInfoBox premiumLabsPage">

      <section class="premiumLabsHero">
        <div class="premiumLabsHeroText">
          <div class="premiumLabsKicker">
            ЛАБОРАТОРНА ДІАГНОСТИКА
          </div>

          <h2>Аналізи пацієнта</h2>

          <p>
            Створюйте лабораторні дослідження, контролюйте відхилення
            та формуйте історію показників пацієнта.
          </p>

          <div class="premiumLabsSpecies">
            <span>Норми пацієнта:</span>
            <strong>${escapeHtml(speciesName)}</strong>
          </div>
        </div>

        <div class="premiumLabsHeroIcon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="34"
            height="34"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9 3h6"></path>
            <path d="M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3"></path>
            <path d="M7.5 15h9"></path>
          </svg>
        </div>
      </section>

      <section class="premiumLabTypes">
        ${Object.entries(LAB_TYPE_META)
          .map(([type, meta]) => `
            <button
              class="premiumLabTypeButton"
              type="button"
              data-create-lab-type="${escapeHtml(type)}"
            >
              <span class="premiumLabTypeIcon">
                ${meta.icon}
              </span>

              <span class="premiumLabTypeText">
                <strong>${escapeHtml(meta.short)}</strong>
                <small>${escapeHtml(meta.description)}</small>
              </span>

              <span class="premiumLabTypePlus">
                +
              </span>
            </button>
          `)
          .join("")}
      </section>

      <section class="premiumLabsHistory">
        <div class="premiumLabsHistoryHead">
          <div>
            <h3>Історія досліджень</h3>
            <p>
              ${labs.length
                ? `Збережено досліджень: ${labs.length}`
                : "Досліджень поки немає"}
            </p>
          </div>
        </div>

        <div id="labsList" class="labsList premiumLabsList">
          ${
            labs.length
              ? labs
                  .map((lab) => renderLabCard(lab, speciesKey))
                  .join("")
              : `
                <div class="premiumLabsEmpty">
                  <div class="premiumLabsEmptyIcon">🧪</div>
                  <h3>Аналізів поки немає</h3>
                  <p>Оберіть потрібний тип дослідження вище.</p>
                </div>
              `
          }
        </div>
      </section>
    </div>
  `;

  box
    .querySelectorAll("[data-create-lab-type]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const type = button.dataset.createLabType;
        if (!type) return;

        openLabModal(pet, {
          type,
        });
      });
    });

  $("#labsList")?.addEventListener("click", async (event) => {
    const deleteButton = event.target.closest("[data-del-lab]");

    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();

      const id = deleteButton.dataset.delLab;
      if (!id) return;

      const lab = loadLabs().find(
        (item) => String(item.id) === String(id)
      );

      openDeleteModal(
        `
          <b>${escapeHtml(lab?.type || "Аналіз")}</b>
          <br><br>
          Результати дослідження будуть видалені назавжди.
          <br>
          Цю дію неможливо скасувати.
        `,
        async () => {
          const next = loadLabs().filter(
            (item) => String(item.id) !== String(id)
          );

          saveLabs(next);
          renderLabsTab(pet);
        }
      );

      return;
    }

    const editButton = event.target.closest("[data-edit-lab]");

    if (editButton) {
      event.preventDefault();
      event.stopPropagation();

      const id = editButton.dataset.editLab;
      if (!id) return;

      const lab = loadLabs().find(
        (item) => String(item.id) === String(id)
      );

      if (!lab) {
        alert("Аналіз не знайдено.");
        return;
      }

      openLabModal(pet, lab);
      return;
    }

    const pdfButton = event.target.closest("[data-pdf-lab]");

if (pdfButton) {
  event.preventDefault();
  event.stopPropagation();

  const id = pdfButton.dataset.pdfLab;
  if (!id) return;

  const lab = loadLabs().find(
    (item) => String(item.id) === String(id)
  );

  if (!lab) {
    alert("Аналіз не знайдено.");
    return;
  }

  await downloadLabPdf(pet, lab);
  return;
}
  });
}


// ==========================================================================
// Doc.PUG CRM Mini — app.js (РЕДАКТИРОВАНИЕ ЛАБ, РЕНДЕРИНГ PDF И СЕЛЕКТОРЫ ПРИЕМА)
// Часть 7
// ==========================================================================

function getLabReference(pet, lab, key) {
  const storedRef = lab?.refs?.[key];

  if (storedRef) {
    return {
      min: storedRef.min ?? "",
      max: storedRef.max ?? "",
      unit: storedRef.unit ?? "",
    };
  }

  const speciesKey = getPetSpeciesKey(pet);
  const defaultRef = LAB_REF?.[speciesKey]?.[key];

  if (Array.isArray(defaultRef)) {
    return {
      min: defaultRef[0] ?? "",
      max: defaultRef[1] ?? "",
      unit: defaultRef[2] ?? "",
    };
  }

  return {
    min: "",
    max: "",
    unit: LAB_DEFAULT_UNITS[key] || "",
  };
}

function closeLabModal() {
  const modal = document.getElementById("premiumLabModal");
  if (!modal) return;

  modal.classList.remove("open");
  document.body.classList.remove("premiumLabModalOpen");

  setTimeout(() => {
    modal.remove();
  }, 180);
}

function openLabModal(pet, labData = {}) {
  document.getElementById("premiumLabModal")?.remove();

  const isEditMode = Boolean(labData?.id);
  const selectedType =
    labData?.type && LAB_GROUPS[labData.type]
      ? labData.type
      : "Біохімія";

  const keys = LAB_GROUPS[selectedType] || [];
  const values = labData?.values || {};

  const modal = document.createElement("div");
  modal.id = "premiumLabModal";
  modal.className = "premiumLabModalOverlay";

  modal.innerHTML = `
    <div
      class="premiumLabModalBackdrop"
      data-close-lab-modal
    ></div>

    <section
      class="premiumLabModal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="premiumLabModalTitle"
    >
      <header class="premiumLabModalHeader">
        <div class="premiumLabModalHeaderMain">
          <div class="premiumLabModalIcon">
            ${LAB_TYPE_META[selectedType]?.icon || "🧪"}
          </div>

          <div>
            <div class="premiumLabModalKicker">
              ЛАБОРАТОРНЕ ДОСЛІДЖЕННЯ
            </div>

            <h2 id="premiumLabModalTitle">
              ${
                isEditMode
                  ? "Редагувати аналіз"
                  : "Новий аналіз"
              }
            </h2>

            <p>
              ${escapeHtml(selectedType)}
              · ${escapeHtml(pet.name || "Пацієнт")}
            </p>
          </div>
        </div>

        <button
          class="premiumLabModalClose"
          type="button"
          data-close-lab-modal
          aria-label="Закрити"
        >
          ×
        </button>
      </header>

      <div class="premiumLabModalScroll">
        <section class="premiumLabMetaSection">
          <label class="premiumLabField">
            <span>Тип дослідження</span>

            <select
              id="premiumLabType"
              ${isEditMode ? "disabled" : ""}
            >
              ${Object.keys(LAB_GROUPS)
                .map((type) => `
                  <option
                    value="${escapeHtml(type)}"
                    ${type === selectedType ? "selected" : ""}
                  >
                    ${escapeHtml(type)}
                  </option>
                `)
                .join("")}
            </select>
          </label>

          <label class="premiumLabField">
            <span>Дата дослідження</span>

            <input
              id="premiumLabDate"
              type="date"
              value="${escapeHtml(labData?.date || todayISO())}"
            >
          </label>

          <label class="premiumLabField">
            <span>Лабораторія</span>

            <input
              id="premiumLabLaboratory"
              type="text"
              maxlength="150"
              value="${escapeHtml(labData?.laboratory || "")}"
              placeholder="Наприклад: IDEXX, BioSoft..."
            >
          </label>
        </section>

        <section class="premiumLabResultsSection">
          <div class="premiumLabSectionHead">
            <div>
              <h3>Результати</h3>
              <p>
                Вкажіть значення та референс лабораторії.
              </p>
            </div>

            <span>
              ${keys.length} показників
            </span>
          </div>

          <div class="premiumLabResultsGrid">
            ${keys
              .map((key) => {
                const ref = getLabReference(pet, labData, key);
                const value = values[key] ?? "";

                return `
                  <article
                    class="premiumLabResultCard"
                    data-lab-result-key="${escapeHtml(key)}"
                  >
                    <div class="premiumLabResultTop">
                      <div>
                        <strong>
                          ${escapeHtml(LAB_LABELS[key] || key)}
                        </strong>

                        <small>
                          ${escapeHtml(key)}
                        </small>
                      </div>

                      <div
                        class="premiumLabLiveStatus"
                        data-lab-live-status
                      >
                        —
                      </div>
                    </div>

                    <label class="premiumLabValueField">
                      <span>Результат</span>

                      <div>
                        <input
                          type="number"
                          inputmode="decimal"
                          step="any"
                          data-lab-value
                          value="${escapeHtml(value)}"
                          placeholder="—"
                        >

                        <input
                          type="text"
                          data-lab-unit
                          value="${escapeHtml(ref.unit)}"
                          placeholder="од."
                        >
                      </div>
                    </label>

                    <div class="premiumLabReferenceGrid">
                      <label>
                        <span>Мін.</span>
                        <input
                          type="number"
                          inputmode="decimal"
                          step="any"
                          data-lab-min
                          value="${escapeHtml(ref.min)}"
                          placeholder="—"
                        >
                      </label>

                      <label>
                        <span>Макс.</span>
                        <input
                          type="number"
                          inputmode="decimal"
                          step="any"
                          data-lab-max
                          value="${escapeHtml(ref.max)}"
                          placeholder="—"
                        >
                      </label>
                    </div>
                  </article>
                `;
              })
              .join("")}
          </div>
        </section>

        <label class="premiumLabCommentField">
          <span>Коментар лікаря</span>

          <textarea
            id="premiumLabComment"
            rows="4"
            maxlength="2000"
            placeholder="Клінічна інтерпретація, умови забору або додаткова інформація..."
          >${escapeHtml(labData?.comment || "")}</textarea>
        </label>
      </div>

      <footer class="premiumLabModalFooter">
        <button
          class="premiumLabCancel"
          type="button"
          data-close-lab-modal
        >
          Скасувати
        </button>

        <button
          class="premiumLabSave"
          id="premiumLabSave"
          type="button"
        >
          ${
            isEditMode
              ? "Зберегти зміни"
              : "Створити аналіз"
          }
        </button>
      </footer>
    </section>
  `;

  document.body.appendChild(modal);
  document.body.classList.add("premiumLabModalOpen");

  requestAnimationFrame(() => {
    modal.classList.add("open");
  });

  const updateLiveStatus = (card) => {
    const valueRaw =
      card.querySelector("[data-lab-value]")?.value ?? "";

    const minRaw =
      card.querySelector("[data-lab-min]")?.value ?? "";

    const maxRaw =
      card.querySelector("[data-lab-max]")?.value ?? "";

    const statusElement =
      card.querySelector("[data-lab-live-status]");

    card.classList.remove(
      "is-normal",
      "is-low",
      "is-high",
      "is-empty"
    );

    if (
      String(valueRaw).trim() === "" ||
      String(minRaw).trim() === "" ||
      String(maxRaw).trim() === ""
    ) {
      card.classList.add("is-empty");

      if (statusElement) {
        statusElement.textContent = "—";
      }

      return;
    }

    const value = Number(valueRaw);
    const min = Number(minRaw);
    const max = Number(maxRaw);

    const status = getLabStatus(value, min, max);

    card.classList.add(`is-${status}`);

    if (statusElement) {
      statusElement.textContent =
        status === "normal"
          ? "Норма"
          : status === "high"
            ? "Вище"
            : status === "low"
              ? "Нижче"
              : "—";
    }
  };

  modal
    .querySelectorAll("[data-lab-result-key]")
    .forEach((card) => {
      card
        .querySelectorAll("input")
        .forEach((input) => {
          input.addEventListener("input", () => {
            updateLiveStatus(card);
          });
        });

      updateLiveStatus(card);
    });

  modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-lab-modal]")) {
      closeLabModal();
    }
  });

  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeLabModal();
    }
  });

  modal
    .querySelector("#premiumLabType")
    ?.addEventListener("change", (event) => {
      const nextType = event.target.value;
      closeLabModal();

      setTimeout(() => {
        openLabModal(pet, {
          type: nextType,
          date:
            modal.querySelector("#premiumLabDate")?.value ||
            todayISO(),
        });
      }, 190);
    });

  modal
    .querySelector("#premiumLabSave")
    ?.addEventListener("click", () => {
      const type =
        modal.querySelector("#premiumLabType")?.value ||
        selectedType;

      const date =
        modal.querySelector("#premiumLabDate")?.value ||
        todayISO();

      const laboratory =
        modal
          .querySelector("#premiumLabLaboratory")
          ?.value?.trim() || "";

      const comment =
        modal
          .querySelector("#premiumLabComment")
          ?.value?.trim() || "";

      const nextValues = {};
      const nextRefs = {};

      modal
        .querySelectorAll("[data-lab-result-key]")
        .forEach((card) => {
          const key = card.dataset.labResultKey;
          if (!key) return;

          const valueRaw =
            card.querySelector("[data-lab-value]")?.value ?? "";

          const minRaw =
            card.querySelector("[data-lab-min]")?.value ?? "";

          const maxRaw =
            card.querySelector("[data-lab-max]")?.value ?? "";

          const unit =
            card
              .querySelector("[data-lab-unit]")
              ?.value?.trim() || "";

          if (String(valueRaw).trim() !== "") {
            const value = Number(valueRaw);

            if (Number.isFinite(value)) {
              nextValues[key] = value;
            }
          }

          nextRefs[key] = {
            min:
              String(minRaw).trim() === ""
                ? ""
                : Number(minRaw),

            max:
              String(maxRaw).trim() === ""
                ? ""
                : Number(maxRaw),

            unit,
          };
        });

      if (!Object.keys(nextValues).length) {
        alert("Вкажіть хоча б один результат.");
        return;
      }

      const labs = loadLabs();

      if (isEditMode) {
        const index = labs.findIndex(
          (item) => String(item.id) === String(labData.id)
        );

        if (index < 0) {
          alert("Аналіз не знайдено.");
          return;
        }

        labs[index] = {
          ...labs[index],
          type,
          date,
          laboratory,
          comment,
          values: nextValues,
          refs: nextRefs,
          updated_at: new Date().toISOString(),
        };
      } else {
        labs.unshift({
          id:
            "lab_" +
            Date.now().toString(36) +
            "_" +
            Math.random().toString(16).slice(2),

          pet_id: String(pet.id),
          type,
          date,
          laboratory,
          comment,
          values: nextValues,
          refs: nextRefs,
          created_at: new Date().toISOString(),
        });
      }

      saveLabs(labs);
      closeLabModal();
      renderLabsTab(pet);
    });
}
function normalizeLabPdfNumber(value) {
  if (value === null || value === undefined || value === "") return "—";

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return String(value);
  }

  return number.toLocaleString("uk-UA", {
    maximumFractionDigits: 2,
  });
}

function sanitizeLabPdfFilename(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function resolveLabPdfReference(pet, lab, key) {
  const customReference =
    lab?.refs?.[key] ||
    lab?.references?.[key] ||
    null;

  if (customReference) {
    return {
      min:
        customReference.min !== undefined
          ? customReference.min
          : customReference[0],

      max:
        customReference.max !== undefined
          ? customReference.max
          : customReference[1],

      unit:
        customReference.unit !== undefined
          ? customReference.unit
          : customReference[2] || "",
    };
  }

  const speciesKey = getPetSpeciesKey(pet);
  const defaultReference = LAB_REF?.[speciesKey]?.[key];

  if (Array.isArray(defaultReference)) {
    return {
      min: defaultReference[0],
      max: defaultReference[1],
      unit: defaultReference[2] || "",
    };
  }

  return {
    min: "",
    max: "",
    unit:
      LAB_DEFAULT_UNITS?.[key] ||
      LAB_UNITS?.[key] ||
      "",
  };
}

function getLabPdfStatus(value, min, max) {
  const numericValue = Number(value);
  const numericMin = Number(min);
  const numericMax = Number(max);

  if (
    !Number.isFinite(numericValue) ||
    !Number.isFinite(numericMin) ||
    !Number.isFinite(numericMax)
  ) {
    return "unknown";
  }

  if (numericValue < numericMin) return "low";
  if (numericValue > numericMax) return "high";

  return "normal";
}

function getLabPdfStatusMeta(status) {
  const statuses = {
    normal: {
      label: "У межах норми",
      shortLabel: "НОРМА",
      symbol: "✓",
      color: "#147D4A",
      background: "#E8F7EF",
      border: "#B9E6CD",
    },

    high: {
      label: "Вище норми",
      shortLabel: "ВИЩЕ",
      symbol: "↑",
      color: "#B42318",
      background: "#FEECEB",
      border: "#F7C5C1",
    },

    low: {
      label: "Нижче норми",
      shortLabel: "НИЖЧЕ",
      symbol: "↓",
      color: "#175CD3",
      background: "#EAF2FF",
      border: "#BDD4FF",
    },

    unknown: {
      label: "Без оцінки",
      shortLabel: "БЕЗ ОЦІНКИ",
      symbol: "—",
      color: "#5F6673",
      background: "#F2F4F7",
      border: "#DDE1E7",
    },
  };

  return statuses[status] || statuses.unknown;
}

function buildLabPdfDocument(
  pet,
  lab,
  clinicProfile = {}
) {
  const clinic = {
    ...DEFAULT_CLINIC_PROFILE,
    ...(clinicProfile || {}),
  };

  const clinicName =
    clinic.name ||
    "Ветеринарна клініка";

  const clinicSubtitle =
    clinic.subtitle ||
    "Ветеринарна клініка";

  const clinicLogo =
    clinic.logo_url || "";

  const clinicPhone =
    clinic.phone || "";

  const clinicAddress =
    clinic.address || "";

  const clinicWebsite =
    clinic.website || "";

  const clinicAccent =
    clinic.document_accent_color ||
    "#9346E8";

  const clinicFooter =
    clinic.document_footer ||
    "Коли важливо — ми поруч.";

  const clinicSignature =
    clinic.doctor_signature_url || "";

  const clinicStamp =
    clinic.clinic_stamp_url || "";

  const speciesKey = getPetSpeciesKey(pet);

  const speciesLabel =
    speciesKey === "cat"
      ? "Кіт"
      : speciesKey === "dog"
        ? "Собака"
        : "Тварина";

  const values = lab?.values || {};

  const preferredKeys =
    LAB_GROUPS?.[lab?.type] ||
    Object.keys(values);

  const keys = preferredKeys.filter((key) => {
    const value = values[key];

    return (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    );
  });

  const metrics = keys.map((key) => {
    const reference = resolveLabPdfReference(pet, lab, key);
    const value = values[key];

    const status = getLabPdfStatus(
      value,
      reference.min,
      reference.max
    );

    return {
      key,
      label: LAB_LABELS?.[key] || key,
      value,
      min: reference.min,
      max: reference.max,
      unit: reference.unit || "",
      status,
      statusMeta: getLabPdfStatusMeta(status),
    };
  });

  const normalCount = metrics.filter(
    (item) => item.status === "normal"
  ).length;

  const highCount = metrics.filter(
    (item) => item.status === "high"
  ).length;

  const lowCount = metrics.filter(
    (item) => item.status === "low"
  ).length;

  const unknownCount = metrics.filter(
    (item) => item.status === "unknown"
  ).length;

  const abnormalCount = highCount + lowCount;

  const summaryTitle = abnormalCount
    ? `Є відхилення: ${abnormalCount}`
    : "Усі оцінені показники в нормі";

  const summaryText = abnormalCount
    ? "Зверніть увагу на показники, виділені червоним або синім кольором. Остаточну інтерпретацію результатів проводить ветеринарний лікар."
    : "За вказаними референтними значеннями відхилень не виявлено. Результат необхідно оцінювати разом із клінічним станом тварини.";

  const summaryColor = abnormalCount
    ? "#B42318"
    : "#147D4A";

  const summaryBackground = abnormalCount
    ? "#FFF1F0"
    : "#ECFDF3";

  const summaryBorder = abnormalCount
    ? "#F7C5C1"
    : "#B7E5C9";

  const rowsHtml = metrics
    .map((metric, index) => {
      const referenceAvailable =
        metric.min !== "" &&
        metric.max !== "" &&
        metric.min !== undefined &&
        metric.max !== undefined;

      const referenceText = referenceAvailable
        ? `${normalizeLabPdfNumber(metric.min)}–${normalizeLabPdfNumber(metric.max)}`
        : "Не вказано";

      const unitText = metric.unit
        ? ` ${escapeHtml(metric.unit)}`
        : "";

      const resultCellBackground =
        metric.status === "normal"
          ? "#F1FBF5"
          : metric.status === "high"
            ? "#FFF2F0"
            : metric.status === "low"
              ? "#EFF5FF"
              : "#F7F8FA";

      return `
        <tr style="
          page-break-inside: avoid;
          break-inside: avoid;
          background: ${index % 2 === 0 ? "#FFFFFF" : "#FAFAFC"};
        ">
          <td style="
            width: 34%;
            padding: 11px 12px;
            border-bottom: 1px solid #E9EBF0;
            vertical-align: middle;
          ">
            <div style="
              color: #161A22;
              font-size: 12px;
              font-weight: 800;
              line-height: 1.3;
            ">
              ${escapeHtml(metric.label)}
            </div>

            <div style="
              margin-top: 3px;
              color: #9298A4;
              font-size: 8px;
              font-weight: 700;
              letter-spacing: .08em;
            ">
              ${escapeHtml(metric.key)}
            </div>
          </td>

          <td style="
            width: 19%;
            padding: 11px 12px;
            border-bottom: 1px solid #E9EBF0;
            vertical-align: middle;
            background: ${resultCellBackground};
          ">
            <div style="
              color: ${metric.statusMeta.color};
              font-size: 15px;
              font-weight: 900;
              line-height: 1.15;
            ">
              ${escapeHtml(normalizeLabPdfNumber(metric.value))}
            </div>

            <div style="
              margin-top: 2px;
              color: #777E8C;
              font-size: 8px;
            ">
              ${unitText || "—"}
            </div>
          </td>

          <td style="
            width: 24%;
            padding: 11px 12px;
            border-bottom: 1px solid #E9EBF0;
            vertical-align: middle;
          ">
            <div style="
              color: #394150;
              font-size: 10px;
              font-weight: 750;
            ">
              ${escapeHtml(referenceText)}${unitText}
            </div>
          </td>

          <td style="
            width: 23%;
            padding: 11px 12px;
            border-bottom: 1px solid #E9EBF0;
            vertical-align: middle;
          ">
            <div style="
              display: inline-flex;
              align-items: center;
              gap: 5px;
              padding: 6px 9px;
              color: ${metric.statusMeta.color};
              background: ${metric.statusMeta.background};
              border: 1px solid ${metric.statusMeta.border};
              border-radius: 999px;
              font-size: 8px;
              font-weight: 900;
              white-space: nowrap;
              letter-spacing: .03em;
            ">
              <span style="font-size: 11px;">
                ${metric.statusMeta.symbol}
              </span>

              ${metric.statusMeta.shortLabel}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  const commentHtml =
    lab?.comment && String(lab.comment).trim()
      ? `
        <section style="
          margin-top: 18px;
          padding: 14px 16px;
          background: #F7F3FC;
          border: 1px solid #E8DDF5;
          border-left: 4px solid #8C43D6;
          border-radius: 12px;
          page-break-inside: avoid;
        ">
          <div style="
            margin-bottom: 6px;
            color: #7136AD;
            font-size: 8px;
            font-weight: 900;
            letter-spacing: .1em;
            text-transform: uppercase;
          ">
            Коментар ветеринарного лікаря
          </div>

          <div style="
            color: #333846;
            font-size: 11px;
            line-height: 1.55;
            white-space: pre-wrap;
          ">
            ${escapeHtml(lab.comment)}
          </div>
        </section>
      `
      : "";

  const documentNode = document.createElement("div");

  documentNode.className = "docPugLabPdfDocument";

  documentNode.style.cssText = `
    width: 794px;
    min-height: 1123px;
    padding: 38px 42px 30px;
    box-sizing: border-box;
    color: #171A21;
    background: #FFFFFF;
    font-family: Arial, Helvetica, sans-serif;
  `;

documentNode.innerHTML = `
  <header style="
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
    padding-bottom: 22px;
    border-bottom: 2px solid ${escapeHtml(clinicAccent)};
  ">
    <div style="
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    ">
      ${
        clinicLogo
          ? `
            <img
              src="${escapeHtml(clinicLogo)}"
              alt="${escapeHtml(clinicName)}"
              crossorigin="anonymous"
              style="
                display: block;
                width: 58px;
                height: 58px;
                flex: 0 0 58px;
                object-fit: contain;
              "
            >
          `
          : `
            <div style="
              display: flex;
              width: 52px;
              height: 52px;
              flex: 0 0 52px;
              align-items: center;
              justify-content: center;
              border-radius: 12px;
              background: ${escapeHtml(clinicAccent)};
              box-shadow: 0 8px 18px rgba(70, 30, 110, 0.18);
              color: #FFFFFF;
              font-size: 23px;
              font-weight: 900;
            ">
              ${escapeHtml(
                clinicName.trim().charAt(0).toUpperCase() || "К"
              )}
            </div>
          `
      }

      <div style="min-width: 0;">
        <div style="
          max-width: 280px;
          overflow: hidden;
          color: ${escapeHtml(clinicAccent)};
          font-size: 23px;
          font-weight: 900;
          line-height: 1.05;
          letter-spacing: -.03em;
          text-overflow: ellipsis;
          white-space: nowrap;
        ">
          ${escapeHtml(clinicName)}
        </div>

        <div style="
          margin-top: 5px;
          color: #697080;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: .07em;
          text-transform: uppercase;
        ">
          ${escapeHtml(clinicSubtitle)}
        </div>
      </div>
    </div>

    <div style="text-align: right;">
      <div style="
        color: #242833;
        font-size: 16px;
        font-weight: 900;
      ">
        Результати лабораторного дослідження
      </div>

      <div style="
        margin-top: 5px;
        color: #777E8C;
        font-size: 10px;
      ">
        ${escapeHtml(lab?.type || "Аналіз")}
      </div>
    </div>
  </header>

  ${
    clinicPhone || clinicAddress || clinicWebsite
      ? `
        <div style="
          display: flex;
          flex-wrap: wrap;
          gap: 6px 16px;
          margin-top: 10px;
          color: #777E8C;
          font-size: 8px;
          line-height: 1.45;
        ">
          ${
            clinicPhone
              ? `
                <span>
                  ${escapeHtml(clinicPhone)}
                </span>
              `
              : ""
          }

          ${
            clinicAddress
              ? `
                <span>
                  ${escapeHtml(clinicAddress)}
                </span>
              `
              : ""
          }

          ${
            clinicWebsite
              ? `
                <span>
                  ${escapeHtml(clinicWebsite)}
                </span>
              `
              : ""
          }
        </div>
      `
      : ""
  }

  <section style="
    display: grid;
    grid-template-columns: 1.25fr 1fr 1fr;
    gap: 10px;
    margin-top: 20px;
  ">
    <div style="
      padding: 13px 14px;
      background: #F7F5FA;
      border: 1px solid #EBE6F1;
      border-radius: 12px;
    ">
      <div style="
        color: #8D94A1;
        font-size: 8px;
        font-weight: 850;
        letter-spacing: .08em;
        text-transform: uppercase;
      ">
        Пацієнт
      </div>

      <div style="
        margin-top: 5px;
        color: #1D212B;
        font-size: 15px;
        font-weight: 900;
      ">
        ${escapeHtml(pet?.name || "—")}
      </div>

      <div style="
        margin-top: 3px;
        color: #697080;
        font-size: 9px;
      ">
        ${escapeHtml(speciesLabel)}
        ${
          pet?.breed
            ? ` • ${escapeHtml(pet.breed)}`
            : ""
        }
      </div>
    </div>

    <div style="
      padding: 13px 14px;
      background: #F7F5FA;
      border: 1px solid #EBE6F1;
      border-radius: 12px;
    ">
      <div style="
        color: #8D94A1;
        font-size: 8px;
        font-weight: 850;
        letter-spacing: .08em;
        text-transform: uppercase;
      ">
        Дата дослідження
      </div>

      <div style="
        margin-top: 7px;
        color: #1D212B;
        font-size: 12px;
        font-weight: 850;
      ">
        ${escapeHtml(
          typeof formatLabCardDate === "function"
            ? formatLabCardDate(lab?.date)
            : lab?.date || "—"
        )}
      </div>
    </div>

    <div style="
      padding: 13px 14px;
      background: #F7F5FA;
      border: 1px solid #EBE6F1;
      border-radius: 12px;
    ">
      <div style="
        color: #8D94A1;
        font-size: 8px;
        font-weight: 850;
        letter-spacing: .08em;
        text-transform: uppercase;
      ">
        Лабораторія
      </div>

      <div style="
        margin-top: 7px;
        color: #1D212B;
        font-size: 12px;
        font-weight: 850;
      ">
        ${escapeHtml(lab?.laboratory || "Не вказано")}
      </div>
    </div>
  </section>

  <section style="
    margin-top: 16px;
    padding: 14px 16px;
    background: ${summaryBackground};
    border: 1px solid ${summaryBorder};
    border-radius: 12px;
    page-break-inside: avoid;
  ">
    <div style="
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
    ">
      <div>
        <div style="
          color: ${summaryColor};
          font-size: 12px;
          font-weight: 900;
        ">
          ${escapeHtml(summaryTitle)}
        </div>

        <div style="
          max-width: 480px;
          margin-top: 5px;
          color: #555D6C;
          font-size: 9px;
          line-height: 1.5;
        ">
          ${escapeHtml(summaryText)}
        </div>
      </div>

      <div style="
        display: flex;
        gap: 7px;
        flex-wrap: wrap;
        justify-content: flex-end;
      ">
        <div style="
          padding: 6px 8px;
          color: #147D4A;
          background: #FFFFFF;
          border: 1px solid #B9E6CD;
          border-radius: 8px;
          font-size: 8px;
          font-weight: 900;
        ">
          ✓ Норма: ${normalCount}
        </div>

        <div style="
          padding: 6px 8px;
          color: #B42318;
          background: #FFFFFF;
          border: 1px solid #F7C5C1;
          border-radius: 8px;
          font-size: 8px;
          font-weight: 900;
        ">
          ↑ Вище: ${highCount}
        </div>

        <div style="
          padding: 6px 8px;
          color: #175CD3;
          background: #FFFFFF;
          border: 1px solid #BDD4FF;
          border-radius: 8px;
          font-size: 8px;
          font-weight: 900;
        ">
          ↓ Нижче: ${lowCount}
        </div>

        ${
          unknownCount
            ? `
              <div style="
                padding: 6px 8px;
                color: #5F6673;
                background: #FFFFFF;
                border: 1px solid #DDE1E7;
                border-radius: 8px;
                font-size: 8px;
                font-weight: 900;
              ">
                — Без оцінки: ${unknownCount}
              </div>
            `
            : ""
        }
      </div>
    </div>
  </section>

  <section style="
    margin-top: 18px;
    overflow: hidden;
    border: 1px solid #E2E5EA;
    border-radius: 13px;
  ">
    <table style="
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    ">
      <thead>
        <tr style="background: #292333;">
          <th style="
            width: 34%;
            padding: 10px 12px;
            color: #FFFFFF;
            font-size: 8px;
            font-weight: 850;
            text-align: left;
            letter-spacing: .07em;
            text-transform: uppercase;
          ">
            Показник
          </th>

          <th style="
            width: 19%;
            padding: 10px 12px;
            color: #FFFFFF;
            font-size: 8px;
            font-weight: 850;
            text-align: left;
            letter-spacing: .07em;
            text-transform: uppercase;
          ">
            Результат
          </th>

          <th style="
            width: 24%;
            padding: 10px 12px;
            color: #FFFFFF;
            font-size: 8px;
            font-weight: 850;
            text-align: left;
            letter-spacing: .07em;
            text-transform: uppercase;
          ">
            Референс
          </th>

          <th style="
            width: 23%;
            padding: 10px 12px;
            color: #FFFFFF;
            font-size: 8px;
            font-weight: 850;
            text-align: left;
            letter-spacing: .07em;
            text-transform: uppercase;
          ">
            Оцінка
          </th>
        </tr>
      </thead>

      <tbody>
        ${
          rowsHtml ||
          `
            <tr>
              <td colspan="4" style="
                padding: 30px;
                color: #767D8B;
                font-size: 11px;
                text-align: center;
              ">
                Результати не внесені
              </td>
            </tr>
          `
        }
      </tbody>
    </table>
  </section>

  ${commentHtml}

  <section style="
    margin-top: 18px;
    padding: 12px 14px;
    background: #FAFAFC;
    border: 1px solid #EBEDF1;
    border-radius: 10px;
    page-break-inside: avoid;
  ">
    <div style="
      color: #747B88;
      font-size: 8px;
      line-height: 1.55;
    ">
      <b style="color: #454B57;">
        Важливо:
      </b>

      референтні значення можуть відрізнятися залежно від лабораторії,
      обладнання, віку та фізіологічного стану тварини. Цей документ не є
      самостійним діагнозом. Результати повинен інтерпретувати ветеринарний лікар.
    </div>
  </section>

  ${
    clinicSignature || clinicStamp
      ? `
        <section style="
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 28px;
          margin-top: 24px;
          page-break-inside: avoid;
        ">
          <div style="
            display: flex;
            min-height: 70px;
            flex-direction: column;
            align-items: center;
            justify-content: flex-end;
            padding-bottom: 7px;
            border-bottom: 1px solid #CCD0D7;
          ">
            ${
              clinicSignature
                ? `
                  <img
                    src="${escapeHtml(clinicSignature)}"
                    alt="Підпис лікаря"
                    crossorigin="anonymous"
                    style="
                      display: block;
                      max-width: 150px;
                      max-height: 60px;
                      object-fit: contain;
                    "
                  >
                `
                : ""
            }

            <span style="
              margin-top: 5px;
              color: #8B929F;
              font-size: 8px;
            ">
              Підпис лікаря
            </span>
          </div>

          <div style="
            display: flex;
            min-height: 70px;
            flex-direction: column;
            align-items: center;
            justify-content: flex-end;
            padding-bottom: 7px;
            border-bottom: 1px solid #CCD0D7;
          ">
            ${
              clinicStamp
                ? `
                  <img
                    src="${escapeHtml(clinicStamp)}"
                    alt="Печатка клініки"
                    crossorigin="anonymous"
                    style="
                      display: block;
                      max-width: 120px;
                      max-height: 70px;
                      object-fit: contain;
                    "
                  >
                `
                : ""
            }

            <span style="
              margin-top: 5px;
              color: #8B929F;
              font-size: 8px;
            ">
              Печатка клініки
            </span>
          </div>
        </section>
      `
      : ""
  }

  <footer style="
    display: flex;
    justify-content: space-between;
    gap: 20px;
    margin-top: 22px;
    padding-top: 14px;
    border-top: 1px solid #E1E4E9;
    color: #8B929F;
    font-size: 8px;
  ">
    <span>
      ${escapeHtml(clinicName)}
      ${
        clinicFooter
          ? ` • ${escapeHtml(clinicFooter)}`
          : ""
      }
    </span>

    <span>
      Сформовано:
      ${escapeHtml(
        new Date().toLocaleString("uk-UA")
      )}
    </span>
  </footer>
`;

  return documentNode;
}

async function downloadLabPdf(pet, labOrId) {
  if (typeof window.html2pdf === "undefined") {
    alert("Модуль формування PDF не підключений.");
    return;
  }

  const lab =
    labOrId && typeof labOrId === "object"
      ? labOrId
      : loadLabs().find(
          (item) => String(item.id) === String(labOrId)
        );

  if (!lab) {
    alert("Аналіз не знайдено.");
    return;
  }
  const clinicProfile =
  state.clinicProfile ||
  await loadClinicProfileApi();

  const renderHost = document.createElement("div");

renderHost.id = "labPdfRenderHost";

renderHost.style.cssText = `
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;

  width: 794px !important;
  min-width: 794px !important;
  max-width: 794px !important;

  min-height: 1123px !important;

  margin: 0 !important;
  padding: 0 !important;

  transform: none !important;
  translate: none !important;
  scale: 1 !important;
  zoom: 1 !important;

  overflow: visible !important;

  z-index: 2147483647;
  opacity: 1;
  pointer-events: none;
  background: #FFFFFF;
`;

  const pdfDocument = buildLabPdfDocument(
  pet,
  lab,
  clinicProfile
);
  renderHost.appendChild(pdfDocument);
  document.body.appendChild(renderHost);

  const filename = [
    "DocPUG",
    sanitizeLabPdfFilename(lab.type || "analysis"),
    sanitizeLabPdfFilename(pet?.name || "patient"),
    sanitizeLabPdfFilename(lab.date || todayISO()),
  ].join("_") + ".pdf";

  try {
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });

    await document.fonts?.ready;

    const worker = window
  .html2pdf()
  .set({
    margin: [0, 0, 0, 0],

    filename,

    image: {
      type: "jpeg",
      quality: 0.98,
    },

    html2canvas: {
      scale: 2,
      useCORS: true,
      allowTaint: false,
      backgroundColor: "#FFFFFF",
      logging: false,

      scrollX: 0,
      scrollY: 0,

      x: 0,
      y: 0,

      width: 794,
      windowWidth: 794,

      onclone: (clonedDocument) => {
        const host = clonedDocument.getElementById("labPdfRenderHost");

        const documentElement = clonedDocument.querySelector(
          ".docPugLabPdfDocument"
        );

        if (host) {
          host.style.position = "absolute";
          host.style.top = "0";
          host.style.left = "0";

          host.style.width = "794px";
          host.style.minWidth = "794px";
          host.style.maxWidth = "794px";

          host.style.margin = "0";
          host.style.padding = "0";

          host.style.transform = "none";
          host.style.zoom = "1";
        }

        if (documentElement) {
          documentElement.style.width = "794px";
          documentElement.style.minWidth = "794px";
          documentElement.style.maxWidth = "794px";

          documentElement.style.margin = "0";
          documentElement.style.transform = "none";
          documentElement.style.zoom = "1";
          documentElement.style.boxSizing = "border-box";
        }
      },
    },

    jsPDF: {
      unit: "mm",
      format: "a4",
      orientation: "portrait",
      compress: true,
    },

    pagebreak: {
      mode: ["css", "legacy"],
      avoid: [
        "tr",
        ".labPdfSummary",
        ".labPdfComment",
      ],
    },
  })
  .from(pdfDocument);


    await worker.save();
  } catch (error) {
    console.error("downloadLabPdf failed:", error);

    alert(
      "Не вдалося сформувати PDF: " +
      (error?.message || error)
    );
  } finally {
    renderHost.remove();
  }
}

function formatLabCardDate(dateStr) {
  if (!dateStr) return "—";
  const parts = String(dateStr).split("-");
  if (parts.length === 3) {
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  return dateStr;
}

function formatLabCardValue(value) {
  if (value === null || value === undefined || value === "") return "—";

  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);

  return num.toLocaleString("uk-UA", {
    maximumFractionDigits: 2,
  });
}

function renderLabCard(lab, speciesKey) {
  const typeMeta = LAB_TYPE_META?.[lab.type] || {
    short: lab.type || "Аналіз",
    icon: "🧪",
    description: "",
  };

  const values = lab?.values || {};
  const refs = lab?.refs || {};

  const resolveRef = (key) => {
    const saved = refs[key];
    if (saved) {
      return {
        min: saved.min ?? "",
        max: saved.max ?? "",
        unit: saved.unit ?? "",
      };
    }

    const fallback = LAB_REF?.[speciesKey]?.[key];
    if (Array.isArray(fallback)) {
      return {
        min: fallback[0] ?? "",
        max: fallback[1] ?? "",
        unit: fallback[2] ?? "",
      };
    }

    return {
      min: "",
      max: "",
      unit: LAB_DEFAULT_UNITS?.[key] || "",
    };
  };

  const metricPriority = {
    high: 0,
    low: 0,
    normal: 1,
    empty: 2,
    unknown: 2,
  };

  const metrics = Object.entries(values)
    .map(([key, rawValue]) => {
      const ref = resolveRef(key);

      const value = Number(rawValue);
      const min = Number(ref.min);
      const max = Number(ref.max);

      let status = "unknown";

      if (
        Number.isFinite(value) &&
        Number.isFinite(min) &&
        Number.isFinite(max)
      ) {
        status = getLabStatus(value, min, max);
      }

      return {
        key,
        label: LAB_LABELS?.[key] || key,
        code: key,
        value: rawValue,
        valueText: formatLabCardValue(rawValue),
        unit: ref.unit || "",
        min: ref.min,
        max: ref.max,
        refText:
          ref.min !== "" && ref.max !== ""
            ? `${formatLabCardValue(ref.min)}–${formatLabCardValue(ref.max)} ${ref.unit || ""}`.trim()
            : "Референс не вказаний",
        status,
        statusText:
          status === "high"
            ? "Вище норми"
            : status === "low"
              ? "Нижче норми"
              : status === "normal"
                ? "Норма"
                : "Без оцінки",
      };
    })
    .sort((a, b) => {
      const pA = metricPriority[a.status] ?? 9;
      const pB = metricPriority[b.status] ?? 9;
      if (pA !== pB) return pA - pB;
      return a.label.localeCompare(b.label, "uk");
    });

  const countHigh = metrics.filter((m) => m.status === "high").length;
  const countLow = metrics.filter((m) => m.status === "low").length;
  const countNormal = metrics.filter((m) => m.status === "normal").length;

  return `
    <article class="labHistoryCard">
      <div class="labHistoryCardAccent"></div>

      <div class="labHistoryHeader">
        <div class="labHistoryMeta">
          <div class="labHistoryIcon">
            ${typeMeta.icon || "🧪"}
          </div>

          <div class="labHistoryText">
            <div class="labHistoryKicker">
              ЛАБОРАТОРНЕ ДОСЛІДЖЕННЯ
            </div>

            <h3 class="labHistoryTitle">
              ${escapeHtml(lab.type || "Аналіз")}
            </h3>

            <div class="labHistorySubtitle">
              <span>📅 ${escapeHtml(formatLabCardDate(lab.date))}</span>
              ${
                lab.laboratory
                  ? `<span>🏥 ${escapeHtml(lab.laboratory)}</span>`
                  : ""
              }
            </div>
          </div>
        </div>

        <div class="labHistoryActions">
          <button
            class="iconBtn labActionBtn"
            type="button"
            title="Редагувати"
            data-edit-lab="${escapeHtml(String(lab.id))}"
          >
            ✏️
          </button>

          <button
            class="iconBtn labActionBtn"
            type="button"
            title="PDF"
            data-pdf-lab="${escapeHtml(String(lab.id))}"
          >
            📄
          </button>

          <button
            class="iconBtn labActionBtn labActionBtnDanger"
            type="button"
            title="Видалити"
            data-del-lab="${escapeHtml(String(lab.id))}"
          >
            🗑
          </button>
        </div>
      </div>

      <div class="labHistoryStats">
        <div class="labHistoryStat">
          <span>Показників</span>
          <strong>${metrics.length}</strong>
        </div>

        <div class="labHistoryStat labHistoryStatOk">
          <span>Норма</span>
          <strong>${countNormal}</strong>
        </div>

        <div class="labHistoryStat labHistoryStatHigh">
          <span>Вище</span>
          <strong>${countHigh}</strong>
        </div>

        <div class="labHistoryStat labHistoryStatLow">
          <span>Нижче</span>
          <strong>${countLow}</strong>
        </div>
      </div>

      <div class="labMetricsGrid">
        ${metrics
          .map(
            (metric) => `
              <div class="labMetricCard is-${metric.status}">
                <div class="labMetricHeader">
                  <div class="labMetricNames">
                    <div class="labMetricLabel">
                      ${escapeHtml(metric.label)}
                    </div>
                    <div class="labMetricCode">
                      ${escapeHtml(metric.code)}
                    </div>
                  </div>

                  <div class="labMetricStatus labMetricStatus-${metric.status}">
                    ${escapeHtml(metric.statusText)}
                  </div>
                </div>

                <div class="labMetricMain">
                  <div class="labMetricValue">
                    ${escapeHtml(metric.valueText)}
                  </div>

                  ${
                    metric.unit
                      ? `<div class="labMetricUnit">${escapeHtml(metric.unit)}</div>`
                      : ""
                  }
                </div>

                <div class="labMetricRef">
                  Референс: ${escapeHtml(metric.refText)}
                </div>
              </div>
            `
          )
          .join("")}
      </div>

      ${
        lab.comment && String(lab.comment).trim()
          ? `
            <div class="labHistoryComment">
              <div class="labHistoryCommentLabel">Коментар лікаря</div>
              <div class="labHistoryCommentText">
                ${escapeHtml(lab.comment).replace(/\n/g, "<br>")}
              </div>
            </div>
          `
          : ""
      }
    </article>
  `;
}

function formatVisitDatePremium(value) {
  const raw = String(value || "").trim();

  if (!raw) return "Дата не вказана";

  const parts = raw.slice(0, 10).split("-");

  if (parts.length !== 3) return raw;

  const [year, month, day] = parts;

  const monthNames = [
    "січня",
    "лютого",
    "березня",
    "квітня",
    "травня",
    "червня",
    "липня",
    "серпня",
    "вересня",
    "жовтня",
    "листопада",
    "грудня",
  ];

  const monthIndex = Number(month) - 1;
  const monthName = monthNames[monthIndex];

  if (!monthName) return raw;

  return `${Number(day)} ${monthName} ${year}`;
}

function formatVisitTextPremium(value, fallback = "Не вказано") {
  const text = String(value || "").trim();

  if (!text) return fallback;

  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return escapeHtml(text);
  }

  return `
    <ul class="premiumVisitList">
      ${lines
        .map((line) => {
          const clean = line.replace(/^[-•*]\s*/, "");
          return `<li>${escapeHtml(clean)}</li>`;
        })
        .join("")}
    </ul>
  `;
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

if (!cardEl) {
  console.warn("У шаблоні немає .visit-card-el");
  return;
}

cardEl.dataset.openVisit = String(v.id);

const dateEl = clone.querySelector(".v-date");
const dxEl = clone.querySelector(".v-dx");
const priceEl = clone.querySelector(".v-price-badge");
const complaintEl = clone.querySelector(".v-complaint");
const rxContainer = clone.querySelector(".v-rx-container");
const rxEl = clone.querySelector(".v-rx");
const deleteButton = clone.querySelector(".v-del-btn");

if (dateEl) {
  dateEl.textContent = formatVisitDatePremium(v.date);
}

if (dxEl) {
  dxEl.textContent = dx;
}

if (priceEl) {
  priceEl.textContent =
    grandTotal > 0
      ? `${grandTotal.toLocaleString("uk-UA")} ₴`
      : "Без оплати";
}

if (complaintEl) {
  complaintEl.innerHTML = formatVisitTextPremium(
    complaint,
    "Скарги не вказані"
  );
}

if (v.rx && v.rx.trim()) {
  if (rxContainer) {
    rxContainer.style.display = "block";
  }

  if (rxEl) {
    rxEl.innerHTML = formatVisitTextPremium(
      v.rx,
      "Лікування не вказано"
    );
  }
}

if (deleteButton) {
  deleteButton.dataset.delVisit = String(v.id);
}

    // Добавляем премиальные hover-эффекты динамически через JS (чтобы не забивать стили)

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
  e.preventDefault();
  e.stopPropagation();

  const visitId = delBtn.dataset.delVisit;
  if (!visitId) return;

  const visit = visits.find(
    (item) => String(item.id) === String(visitId)
  );

  const visitDate = visit?.date || "без дати";

  openDeleteModal(
    `
      <b>Візит від ${escapeHtml(visitDate)}</b>
      <br><br>
      Візит буде видалено назавжди разом із медичними даними та чеком.
      <br>
      Цю дію неможливо скасувати.
    `,
    async () => {
      const ok = await deleteVisitApi(visitId);

      if (!ok) {
        alert("Не вдалося видалити візит.");
        return;
      }

      state.visits = (state.visits || []).filter(
        (item) => String(item.id) !== String(visitId)
      );

      state.visitsById.delete(String(visitId));

      await renderVisits(petId);

      if (state.selectedPet) {
        await renderPatientTab("visits", state.selectedPet);
      }
    }
  );

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

        const dx = String(
  document.getElementById("visitMedDx")?.value || ""
).trim();

const complaint = String(
  document.getElementById("visitMedComplaint")?.value || ""
).trim();

const rx = String(
  document.getElementById("visitMedRx")?.value || ""
).trim();

const recommendation = String(
  document.getElementById("visitClientRecommendation")?.value || ""
).trim();

const weightValue =
  document.getElementById("visitWeightDisplay")?.value;

const weightKg =
  weightValue === "" || weightValue == null
    ? null
    : Number(weightValue);

const services = Array.isArray(current.services)
  ? current.services
  : [];

const stock = Array.isArray(current.stock)
  ? current.stock
  : [];

const payload = {
  pet_id: current.pet_id,
  date: current.date,

  weight_kg:
    Number.isFinite(weightKg)
      ? weightKg
      : current.weight_kg,

  note: buildVisitNote(
    dx,
    complaint
  ),

  rx: buildVisitRx(
    rx,
    recommendation
  ),

  services,
  services_json: services,

  stock,
  stock_json: stock,
};

const btn =
  document.getElementById("visitMedSave");

const hint =
  document.getElementById("visitMedSaveHint");

if (btn) {
  btn.textContent = "Збереження…";
}

const updated =
  await updateVisitApi(vid, payload);

if (!updated) {
  if (btn) {
    btn.textContent = "💾 Зберегти";
  }

  return alert(
    "Не вдалося зберегти медичну частину"
  );
}

const merged = {
  ...current,
  ...updated,

  note: payload.note,
  rx: payload.rx,
  weight_kg: payload.weight_kg,

  services,
  services_json: services,

  stock,
  stock_json: stock,
};

state.visitsById.set(
  String(vid),
  merged
);

if (
  String(state.selectedVisitId) ===
  String(vid)
) {
  state.selectedVisit = merged;
}

setDischarge(vid, {
  complaint,
  dx,
  rx,
  recommendation,
});

if (btn) {
  btn.textContent = "✅ Збережено";
}

if (hint) {
  hint.textContent =
    "Медична частина збережена.";
}

if (
  typeof renderDischargeA4 === "function"
) {
  renderDischargeA4(vid);
}

setTimeout(() => {
  if (btn) {
    btn.textContent = "💾 Зберегти";
  }

  if (hint) {
    hint.textContent =
      "Можна редагувати прямо тут. Після змін натисни “Зберегти”.";
  }
}, 1200);

return;
}

// Добавление услуги в чек
if (e.target.closest("#visitSvcAdd")) {
  e.preventDefault();
  e.stopPropagation();

  const vid = state.selectedVisitId;
  if (!vid) return;

  const serviceId =
    document.getElementById(
      "visitSvcSelect"
    )?.value || "";

  const qty = Math.max(
    1,
    Number(
      document.getElementById(
        "visitSvcQty"
      )?.value || 1
    )
  );

  if (!serviceId) return;

  console.log(
    "[visit-ui] add service",
    {
      vid,
      serviceId,
      qty,
    }
  );

  const ok =
    await addServiceLineToVisit(
      vid,
      serviceId,
      qty
    );

  if (!ok) {
    return alert(
      "Не вдалося додати послугу"
    );
  }

  const visit =
    getVisitByIdSync(vid) ||
    await fetchVisitById(vid);

  if (!visit) return;

  renderVisitPage(
    visit,
    state.selectedPet
  );

  if (
    typeof renderDischargeA4 === "function"
  ) {
    renderDischargeA4(vid);
  }

  return;
}

// Удаление услуги из чека
const svcDel =
  e.target.closest("[data-svc-del]");

if (svcDel) {
  e.preventDefault();
  e.stopPropagation();

  const index =
    Number(svcDel.dataset.svcDel);

  if (!Number.isFinite(index)) {
    return;
  }

  const vid = state.selectedVisitId;
  if (!vid) return;

  console.log(
    "[visit-ui] del service",
    {
      vid,
      index,
    }
  );

  const ok =
    await removeServiceLineFromVisit(
      vid,
      index
    );

  if (!ok) {
    return alert(
      "Не вдалося прибрати послугу"
    );
  }

  const fresh =
    getVisitByIdSync(vid);

  if (fresh) {
    renderVisitPage(
      fresh,
      state.selectedPet
    );

    if (
      typeof renderDischargeA4 ===
      "function"
    ) {
      renderDischargeA4(vid);
    }
  }

  return;
}

// Добавление препарата со склада
if (e.target.closest("#visitStkAdd")) {
  e.preventDefault();
  e.stopPropagation();

  const vid = state.selectedVisitId;
  if (!vid) return;

  const stockId =
    document.getElementById(
      "visitStkSelect"
    )?.value || "";

  const qty = Math.max(
    1,
    Number(
      document.getElementById(
        "visitStkQty"
      )?.value || 1
    )
  );

  if (!stockId) return;

  console.log(
    "[visit-ui] add stock",
    {
      vid,
      stockId,
      qty,
    }
  );

  const ok =
    await addStockLineToVisit(
      vid,
      stockId,
      qty
    );

  if (!ok) {
    return alert(
      "Не вдалося додати препарат"
    );
  }

  const fresh =
    getVisitByIdSync(vid);

  if (fresh) {
    renderVisitPage(
      fresh,
      state.selectedPet
    );

    if (
      typeof renderDischargeA4 ===
      "function"
    ) {
      renderDischargeA4(vid);
    }
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

  const summaryPatientName =
  document.getElementById("visitSummaryPatientName");

if (summaryPatientName) {
  summaryPatientName.textContent =
    pet?.name || "Пацієнт";
}

const summaryPatientMeta =
  document.getElementById("visitSummaryPatientMeta");

if (summaryPatientMeta) {
  const parts = [];

  if (pet?.species) {
    parts.push(pet.species);
  }

  if (pet?.breed) {
    parts.push(pet.breed);
  }

  summaryPatientMeta.textContent =
    parts.length
      ? parts.join(" • ")
      : "Дані пацієнта";
}

const weightInput =
  document.getElementById("visitWeightDisplay");

if (weightInput) {
  weightInput.value =
    visit?.weight_kg ?? "";
}

  // 2. Безпечний розбір комбінованої нотатки (note) на Діагноз та Скарги
  const noteText = String(visit.note || "").trim();
  const parsed = parseVisitNote(noteText);
  
  const dxInput = document.getElementById("visitMedDx");
  if (dxInput) dxInput.value = parsed.dx || "";

  const complaintTextarea = document.getElementById("visitMedComplaint");
  if (complaintTextarea) complaintTextarea.value = parsed.complaint || "";

  const parsedRx = parseVisitRx(
  String(visit.rx || "")
);

const rxTextarea =
  document.getElementById("visitMedRx");

if (rxTextarea) {
  rxTextarea.value = parsedRx.rx;
}

const recommendationTextarea =
  document.getElementById(
    "visitClientRecommendation"
  );

if (recommendationTextarea) {
  recommendationTextarea.value =
    parsedRx.recommendation;
}

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
  const svcContainer =
  document.getElementById(
    "visitSvcListContainer"
  );

if (svcContainer) {
  svcContainer.innerHTML =
    expandedServices.length
      ? expandedServices
          .map((item, index) => {
            const quantity =
              Number(item.qty || 0);

            const price =
              Number(item.price || 0);

            const lineTotal =
              Number(item.lineTotal || 0);

            return `
              <article class="visitLine">
                <div class="visitLineMain">
                  <strong>
                    ${escapeHtml(
                      item.name || "Послуга"
                    )}
                  </strong>

                  <span>
                    ${quantity}
                    ×
                    ${price.toLocaleString("uk-UA")} ₴
                  </span>
                </div>

                <div class="visitLineActions">
                  <div class="visitLineTotal">
                    ${lineTotal.toLocaleString("uk-UA")} ₴
                  </div>

                  <button
                    class="visitLineDelete"
                    type="button"
                    title="Видалити послугу"
                    data-svc-del="${index}"
                  >
                    ✕
                  </button>
                </div>
              </article>
            `;
          })
          .join("")
      : `
        <div class="visitLinesEmpty">
          Послуг ще немає. Знайдіть потрібну послугу та додайте її до візиту.
        </div>
      `;
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
  const stkContainer =
  document.getElementById(
    "visitStkListContainer"
  );

if (stkContainer) {
  stkContainer.innerHTML =
    expandedStock.length
      ? expandedStock
          .map((item, index) => {
            const quantity =
              Number(item.qty || 0);

            const price =
              Number(item.price || 0);

            const lineTotal =
              Number(item.lineTotal || 0);

            return `
              <article class="visitLine">
                <div class="visitLineMain">
                  <strong>
                    ${escapeHtml(
                      item.name || "Препарат"
                    )}
                  </strong>

                  <span>
                    ${quantity}
                    ×
                    ${price.toLocaleString("uk-UA")} ₴
                  </span>
                </div>

                <div class="visitLineActions">
                  <div class="visitLineTotal">
                    ${lineTotal.toLocaleString("uk-UA")} ₴
                  </div>

                  <button
                    class="visitLineDelete"
                    type="button"
                    title="Видалити препарат"
                    data-stk-del="${index}"
                  >
                    ✕
                  </button>
                </div>
              </article>
            `;
          })
          .join("")
      : `
        <div class="visitLinesEmpty">
          Препаратів ще немає. Знайдіть позицію на складі та додайте її до візиту.
        </div>
      `;
}

  // 5. Виводимо загальну фінансову суму
  const grandTotal =
  servicesTotal + stockTotal;

const money = (value) => {
  return (
    Number(value || 0)
      .toLocaleString("uk-UA") +
    " ₴"
  );
};

const totalDisplay =
  document.getElementById(
    "visitGrandTotal"
  );

if (totalDisplay) {
  totalDisplay.textContent =
    money(grandTotal);
}

const servicesSubtotal =
  document.getElementById(
    "visitServicesSubtotal"
  );

if (servicesSubtotal) {
  servicesSubtotal.textContent =
    money(servicesTotal);
}

const stockSubtotal =
  document.getElementById(
    "visitStockSubtotal"
  );

if (stockSubtotal) {
  stockSubtotal.textContent =
    money(stockTotal);
}

const summaryServices =
  document.getElementById(
    "visitSummaryServices"
  );

if (summaryServices) {
  summaryServices.textContent =
    money(servicesTotal);
}

const summaryStock =
  document.getElementById(
    "visitSummaryStock"
  );

if (summaryStock) {
  summaryStock.textContent =
    money(stockTotal);
}

  // Відновлюємо оригінальні обробники подій кнопок та пошуку (initVisitUI)
  if (typeof initVisitUI === "function") {
    initVisitUI();
  }

  // Навешуємо відкриття PDF виписки на кнопку
  // === СТИЛЬНАЯ ПРЕМИУМ-ВЫПИСКА ДЛЯ КЛИЕНТА ===
  const btnPdf =
  document.getElementById(
    "btnPrintVisitPdf"
  );

if (btnPdf) {
  btnPdf.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const visitId =
      visit?.id ||
      visit?._id ||
      state.selectedVisitId ||
      "";

    if (!visitId) {
      alert(
        "Не вдалося визначити візит для друку."
      );
      return;
    }

    const originalText =
      btnPdf.textContent;

    btnPdf.disabled = true;
    btnPdf.textContent =
      "Підготовка документа…";

    try {
      // Сохраняем актуальные значения медицинской формы
      // перед созданием выписки
    // Берём актуальный текст прямо из медицинской части визита
const complaint = String(
  document.getElementById(
    "visitMedComplaint"
  )?.value || ""
).trim();

const dx = String(
  document.getElementById(
    "visitMedDx"
  )?.value || ""
).trim();

const rx = String(
  document.getElementById(
    "visitMedRx"
  )?.value || ""
).trim();

const recommendation = String(
  document.getElementById(
    "visitClientRecommendation"
  )?.value || ""
).trim();

const follow = String(
  document.getElementById(
    "visitFollowUp"
  )?.value || ""
).trim();

setDischarge(visitId, {
  complaint,
  dx,
  rx,
  recommendation,
  recs: recommendation,
  follow,
});

const currentVisit =
  getVisitByIdSync(visitId);

const weightValue =
  document.getElementById(
    "visitWeightDisplay"
  )?.value;

const weightKg =
  weightValue === "" ||
  weightValue == null
    ? null
    : Number(weightValue);

if (
  currentVisit &&
  Number.isFinite(weightKg)
) {
  currentVisit.weight_kg = weightKg;

  state.visitsById.set(
    String(visitId),
    currentVisit
  );
}
await downloadA4Pdf(
  visitId
);

return;

if (!printWindow) {
  throw new Error(
    "Браузер заблокував вікно друку"
  );
}

const documentHtml =
  printDocument.innerHTML;

const styles = Array.from(
  document.querySelectorAll(
    'link[rel="stylesheet"], style'
  )
)
  .map((node) => node.outerHTML)
  .join("\n");

printWindow.document.open();

printWindow.document.write(`
  <!DOCTYPE html>
  <html lang="uk">
    <head>
      <meta charset="UTF-8">

      <meta
        name="viewport"
        content="width=device-width, initial-scale=1"
      >

      <title>
        Виписка з амбулаторного прийому
      </title>

      ${styles}

      <style>
        @page {
          size: A4 portrait;
          margin: 12mm 12mm 14mm;
        }

        html,
        body {
          width: auto !important;
          min-width: 0 !important;
          height: auto !important;
          margin: 0 !important;
          padding: 0 !important;
          background: #ffffff !important;
          overflow: visible !important;
        }

        body {
          font-family:
            Inter,
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            sans-serif;
          color: #172033;
        }

        #disA4 {
          display: block !important;
          position: static !important;
          width: 100% !important;
          max-width: none !important;
          min-width: 0 !important;
          height: auto !important;
          min-height: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: visible !important;
          transform: none !important;
        }

        .premiumDischargeDocument {
          display: block !important;
          width: 100% !important;
          max-width: none !important;
          min-width: 0 !important;
          height: auto !important;
          min-height: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          overflow: visible !important;
          transform: none !important;
          box-sizing: border-box !important;
        }

        .dischargeHeader,
        .dischargePeopleGrid,
        .dischargeInfoCard,
        .dischargeMedicalSection,
        .dischargeFinanceHeader,
        .dischargeTotals,
        .dischargeSignatureSection,
        .dischargeFooter {
          break-inside: avoid;
          page-break-inside: avoid;
        }

        .dischargeFinanceSection {
          overflow: visible !important;
          break-inside: auto;
          page-break-inside: auto;
        }

        .dischargeFinanceTable {
          width: 100% !important;
          min-width: 0 !important;
          table-layout: fixed !important;
          border-collapse: collapse !important;
        }

        .dischargeFinanceTable thead {
          display: table-header-group;
        }

        .dischargeFinanceTable tbody {
          display: table-row-group;
        }

        .dischargeFinanceTable tr,
        .dischargeFinanceTable td,
        .dischargeFinanceTable th {
          break-inside: avoid;
          page-break-inside: avoid;
        }

        @media print {
          html,
          body {
            width: auto !important;
            height: auto !important;
          }
        }
      </style>
    </head>

    <body>
      <main id="disA4">
        ${documentHtml}
      </main>

      <script>
        window.addEventListener(
          "load",
          async () => {
            const images = Array.from(
              document.images
            );

            await Promise.all(
              images.map((image) => {
                if (image.complete) {
                  return Promise.resolve();
                }

                return new Promise(
                  (resolve) => {
                    image.onload = resolve;
                    image.onerror = resolve;

                    setTimeout(
                      resolve,
                      3000
                    );
                  }
                );
              })
            );

            setTimeout(() => {
              window.print();
            }, 250);
          }
        );
      <\/script>
    </body>
  </html>
`);

printWindow.document.close();
    } catch (error) {
      console.error(
        "Помилка друку виписки:",
        error
      );

      document.body.classList.remove(
        "docpug-printing"
      );

      alert(
        "Не вдалося підготувати виписку до друку: " +
        (
          error?.message ||
          error
        )
      );
    } finally {
      btnPdf.disabled = false;
      btnPdf.textContent =
        originalText;
    }
  };
}

const completeButton =
  document.getElementById(
    "visitCompleteButton"
  );

if (completeButton) {
  completeButton.disabled = true;

  completeButton.title =
    "Статус завершення підключимо після додавання поля status у базу";

  completeButton.style.opacity =
    "0.45";

  completeButton.style.cursor =
    "not-allowed";
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
function parseVisitRx(value) {
  const text = String(value || "").trim();

  const marker =
    "\n\nРекомендації власнику:\n";

  const markerIndex =
    text.indexOf(marker);

  if (markerIndex === -1) {
    return {
      rx: text,
      recommendation: "",
    };
  }

  return {
    rx: text
      .slice(0, markerIndex)
      .replace(/^Лікування:\s*/i, "")
      .trim(),

    recommendation: text
      .slice(markerIndex + marker.length)
      .trim(),
  };
}


function buildVisitRx(
  rx,
  recommendation
) {
  const treatment =
    String(rx || "").trim();

  const clientRecommendation =
    String(recommendation || "").trim();

  if (!clientRecommendation) {
    return treatment;
  }

  return [
    treatment
      ? `Лікування:\n${treatment}`
      : "Лікування:\n—",

    `Рекомендації власнику:\n${clientRecommendation}`,
  ].join("\n\n");
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
  let a4 = document.getElementById("disA4");

  if (!a4) {
    a4 = document.createElement("div");
    a4.id = "disA4";
    a4.className = "visitDischargePrintHost";
    document.body.appendChild(a4);
  }

  a4.innerHTML = "";

  let v = getVisitByIdSync(visitId);
  if (!v) {
    v = await fetchVisitById(visitId);
    if (v?.id) cacheVisits([v]);
  }

  if (!v) {
    a4.innerHTML = `<div class="hint">Візит не знайдено</div>`;
    return;
  }

  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients();

  const pet =
    (patients || []).find((p) => String(p.id) === String(v.pet_id)) || null;

  const owner = pet?.owner_id ? getOwnerById(pet.owner_id) : null;

  const dis = getDischarge(visitId) || {};
  const parsed = parseVisitNote(v.note || "");
  const parsedRx = parseRxCombined(v.rx || "");

  const complaint = String(dis.complaint ?? parsed.complaint ?? "").trim();
  const dx = String(dis.dx ?? parsed.dx ?? "").trim();
  const rx = String(dis.rx ?? parsedRx.rx ?? v.rx ?? "").trim();
  const recs = String(dis.recs ?? dis.recommendation ?? parsedRx.recs ?? "").trim();
  const follow = String(dis.follow ?? parsedRx.follow ?? "").trim();

  let org =
  state.clinicProfile ||
  null;

if (
  !org &&
  typeof loadClinicProfileApi === "function"
) {
  org =
    await loadClinicProfileApi();
}

org = org || {};

  const clinicName =
    org.name ||
    sessionStorage.getItem("pug_active_clinic_name") ||
    "Doc.PUG";

  const clinicSubtitle =
    org.subtitle ||
    "Ветеринарна клініка";

  const clinicPhone = org.phone || "";
  const clinicAddress = org.address || "";
  const clinicWebsite = org.website || "";
  const clinicLogo =
  org.logo_url ||
  state.clinicProfile?.logo_url ||
  "";
  const clinicFooter =
    org.document_footer ||
    "Коли важливо — ми поруч.";

  let visitDoctor = null;

if (
  v.staff_id &&
  typeof loadStaffApi === "function"
) {
  const staffList =
    await loadStaffApi();

  visitDoctor =
    (staffList || []).find((staff) => {
      return (
        String(staff.id) ===
        String(v.staff_id)
      );
    }) || null;
}

const doctorName =
  visitDoctor?.name ||
  "Ветеринарний лікар";

  const doctorSignature = org.doctor_signature_url || "";
  const clinicStamp = org.clinic_stamp_url || "";

  const accent =
    typeof org.document_accent_color === "string" &&
    org.document_accent_color.trim()
      ? org.document_accent_color.trim()
      : "#9346E8";

  const visitNumber = String(v.id || "").slice(0, 8).toUpperCase();

  const expandedServices = expandServiceLines(v) || [];
  const expandedStock = expandStockLines(v) || [];

  const serviceTotal = Number(calcServicesTotal(v) || 0);
  const stockTotal = Number(calcStockTotal(v) || 0);
  const grandTotal = serviceTotal + stockTotal;

  const financeRows = [
    ...expandedServices.map((x) => ({
      name: x.name || "—",
      type: "Послуга",
      qty: x.qty || 1,
      price: x.price || 0,
      total: x.lineTotal || 0,
    })),
    ...expandedStock.map((x) => ({
      name: x.name || "—",
      type: "Препарат",
      qty: x.qty || 1,
      price: x.price || 0,
      total: x.lineTotal || 0,
    })),
  ];

  const financeRowsHtml = financeRows.length
    ? financeRows
        .map(
          (x) => `
            <tr>
              <td>${escapeHtml(String(x.name))}</td>
              <td>${escapeHtml(String(x.type))}</td>
              <td>${escapeHtml(String(x.qty))}</td>
              <td>${escapeHtml(String(x.price))} ₴</td>
              <td>${escapeHtml(String(x.total))} ₴</td>
            </tr>
          `
        )
        .join("")
    : `
      <tr>
        <td colspan="5" class="disModernEmpty">Фінансова частина не заповнена</td>
      </tr>
    `;

  const clinicContacts = [
    clinicPhone,
    clinicAddress,
    clinicWebsite
  ].filter(Boolean).join(" • ");

  a4.innerHTML = `
    <div class="disModernDoc" style="--disAccent:${escapeHtml(accent)};">
      <div class="disModernHead">
        <div class="disModernBrand">
          ${
            clinicLogo
              ? `
                <div class="disModernLogoBox">
                  <img src="${escapeHtml(clinicLogo)}" alt="logo" class="disModernLogoImg">
                </div>
              `
              : `
                <div class="disModernLogoFallback">
                  ${escapeHtml((clinicName || "D").charAt(0))}
                </div>
              `
          }

          <div class="disModernBrandText">
            <div class="disModernClinicName">${escapeHtml(clinicName)}</div>
            <div class="disModernClinicSubtitle">${escapeHtml(clinicSubtitle)}</div>
            <div class="disModernClinicContacts">${escapeHtml(clinicContacts || "—")}</div>
          </div>
        </div>

        <div class="disModernHeadRight">
          <div class="disModernDocType">Виписка з амбулаторного прийому</div>
          <div class="disModernDocMeta">№ ${escapeHtml(visitNumber || "—")}</div>
          <div class="disModernDocMeta">Дата візиту: ${escapeHtml(String(v.date || "—"))}</div>
        </div>
      </div>

      <div class="disModernAccentLine"></div>

      <div class="disModernInfoGrid">
        <div class="disModernCard">
          <div class="disModernCardTitle">Пацієнт</div>
          <div class="disModernCardMain">${escapeHtml(pet?.name || "—")}</div>

          <div class="disModernInfoRows">
            <div class="disModernInfoRow">
              <span>Вид</span>
              <b>${escapeHtml(pet?.species || "—")}</b>
            </div>
            <div class="disModernInfoRow">
              <span>Порода</span>
              <b>${escapeHtml(pet?.breed || "—")}</b>
            </div>
            <div class="disModernInfoRow">
              <span>Вік</span>
              <b>${escapeHtml(pet?.age || pet?.birth_date || "—")}</b>
            </div>
            <div class="disModernInfoRow">
              <span>Вага</span>
              <b>${escapeHtml(String(v.weight_kg || pet?.weight_kg || pet?.weight || "—"))} ${v.weight_kg || pet?.weight_kg || pet?.weight ? "кг" : ""}</b>
            </div>
          </div>
        </div>

        <div class="disModernCard">
          <div class="disModernCardTitle">Власник</div>
          <div class="disModernCardMain">${escapeHtml(owner?.name || "—")}</div>

          <div class="disModernInfoRows">
            <div class="disModernInfoRow">
              <span>Телефон</span>
              <b>${escapeHtml(owner?.phone || "—")}</b>
            </div>
            <div class="disModernInfoRow">
              <span>Адреса / примітка</span>
              <b>${escapeHtml(owner?.address || owner?.note || "—")}</b>
            </div>
          </div>
        </div>
      </div>

      <div class="disModernSection">
        <div class="disModernSectionTitle">Скарги та анамнез</div>
        <div class="disModernText">${escapeHtml(complaint || "—")}</div>
      </div>

      <div class="disModernSection">
        <div class="disModernSectionTitle">Встановлений діагноз</div>
        <div class="disModernText">${escapeHtml(dx || "—")}</div>
      </div>

      <div class="disModernSection">
        <div class="disModernSectionTitle">Призначення лікаря</div>
        <div class="disModernText disModernTextSoft">${escapeHtml(rx || "—")}</div>
      </div>

      <div class="disModernSection">
        <div class="disModernSectionTitle">Рекомендації для власника</div>
        <div class="disModernText">${escapeHtml(recs || "—")}</div>
      </div>

      <div class="disModernSection">
        <div class="disModernSectionTitle">Контроль / повторний огляд</div>
        <div class="disModernText">${escapeHtml(follow || "—")}</div>
      </div>

      <div class="disModernSection disModernFinanceSection">
        <div class="disModernFinanceHead">
          <div>
            <div class="disModernSectionTitle">Надані послуги та використані матеріали</div>
            <div class="disModernSectionSub">Фінансова деталізація прийому</div>
          </div>

          <div class="disModernGrandTotalBadge">
            ${escapeHtml(String(grandTotal))} ₴
          </div>
        </div>

        <div class="disModernTableWrap">
          <table class="disModernTable">
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
              ${financeRowsHtml}
            </tbody>
          </table>
        </div>

        <div class="disModernFinanceSummary">
          <div class="disModernFinanceMini">
            <span>Послуги</span>
            <b>${escapeHtml(String(serviceTotal))} ₴</b>
          </div>
          <div class="disModernFinanceMini">
            <span>Препарати</span>
            <b>${escapeHtml(String(stockTotal))} ₴</b>
          </div>
          <div class="disModernFinanceMini disModernFinanceMiniTotal">
            <span>Разом до сплати</span>
            <b>${escapeHtml(String(grandTotal))} ₴</b>
          </div>
        </div>
      </div>

      <div class="disModernSignGrid">
        <div class="disModernSignBox">
          <div class="disModernSignTitle">Лікар</div>
          ${
            doctorSignature
              ? `<img src="${escapeHtml(doctorSignature)}" alt="Підпис лікаря" class="disModernSignImg">`
              : `<div class="disModernSignLine"></div>`
          }
          <div class="disModernSignName">${escapeHtml(doctorName)}</div>
        </div>

        <div class="disModernSignBox">
          <div class="disModernSignTitle">Печатка клініки</div>
          ${
            clinicStamp
              ? `<img src="${escapeHtml(clinicStamp)}" alt="Печатка клініки" class="disModernStampImg">`
              : `<div class="disModernSignLine"></div>`
          }
          <div class="disModernSignName">${escapeHtml(clinicName)}</div>
        </div>
      </div>

      <div class="disModernFooter">
        <span>${escapeHtml(clinicFooter)}</span>
        <span>${escapeHtml(clinicName)}</span>
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
  document.body.classList.add("medcardModalIsOpen");
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
      <td class="ownerActionsCell">
  <button
    class="iconBtn ownerActionBtn ownerEditBtn"
    type="button"
    title="Редагувати власника"
    aria-label="Редагувати власника"
    data-edit-owner="${escapeHtml(owner.id)}"
  >
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"></path>
    </svg>
  </button>

  <button
    class="iconBtn ownerActionBtn ownerDeleteBtn"
    type="button"
    title="Видалити власника"
    aria-label="Видалити власника"
    data-del="${escapeHtml(owner.id)}"
  >
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="M19 6l-1 14H6L5 6"></path>
      <path d="M10 11v5"></path>
      <path d="M14 11v5"></path>
    </svg>
  </button>
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

    // ==========================
    // Додати власника
    // ==========================
    const addBtn = e.target.closest(
      "#btnAddOwner, [data-action='add-owner'], [data-action='addOwner'], .btnAddOwner"
    );

    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();
      openOwnerModal();
      return;
    }

    // ==========================
    // Редагувати власника
    // (працює і в таблиці, і в Hero)
    // ==========================
    const editBtn = e.target.closest("[data-edit-owner]");

    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();

      const id = editBtn.dataset.editOwner;
      if (!id) return;

      const owner = (state.owners || []).find(
        (o) => String(o.id) === String(id)
      );

      if (!owner) return;

      openOwnerModal(owner);
      return;
    }

    // ==========================
    // Далі працюємо тільки всередині списку
    // ==========================
    const ownersList =
      e.target.closest("#owners-table-body") ||
      e.target.closest("#ownersList") ||
      e.target.closest(".data-table-container");

    if (!ownersList) return;

    // ==========================
    // Видалити власника
    // ==========================
    const delBtn = e.target.closest("[data-del]");

    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();

      const id = delBtn.dataset.del;
      if (!id) return;

      const owner = (state.owners || []).find(
        (o) => String(o.id) === String(id)
      );

      const ownerName = owner?.name || "цього власника";

      openDeleteModal(
        `<b>${escapeHtml(ownerName)}</b><br><br>Цю дію неможливо скасувати.`,
        async () => {
          const ok = await deleteOwner(id);

          if (!ok) {
            alert("Не вдалося видалити");
            return;
          }

          await loadOwners();
        }
      );

      return;
    }

    // ==========================================================
    // НИЖЕ НИЧЕГО НЕ ВСТАВЛЯЙ.
    // Оставь весь свой существующий код:
    // const row = ...
    // const openBtn = ...
    // openOwner(...)
    // и т.д.
    // ==========================================================


if (delBtn) {
  e.preventDefault();
  e.stopPropagation();

  const id = delBtn.dataset.del;
  if (!id) return;

  const owner = (state.owners || []).find(
    (o) => String(o.id) === String(id)
  );

  const ownerName = owner?.name || "цього власника";

  openDeleteModal(
    `<b>${escapeHtml(ownerName)}</b><br><br>Цю дію неможливо скасувати.`,
    async () => {
      const ok = await deleteOwner(id);

      if (!ok) {
        alert("Не вдалося видалити");
        return;
      }

      await loadOwners();
    }
  );

  return;
}

const openZone = e.target.closest("[data-open-owner]");

if (openZone) {
  e.preventDefault();
  e.stopPropagation();

  const ownerId = openZone.dataset.openOwner;

  if (ownerId) {
    openOwner(ownerId);
  }
}
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#btnBackOwners")) {
      setHash("owners");
    }
  });
}
// ==========================================================================
// Doc.PUG CRM Mini — app.js (СПЕЦИФИКАЦИИ, МОДАЛЬНЫЕ ОКНА И ОБРАБОТЧИКИ ПРОФИЛЕЙ)
// Часть 9
// ==========================================================================

// =========================
// OWNER UI — Управление карточкой владельца
// =========================
// =========================================================
// DOC.PUG — Модальне вікно додавання пацієнта
// =========================================================
// =========================================================
// DOC.PUG — Довідник порід для форми пацієнта
// =========================================================

const DOG_BREEDS = [
  "Німецька вівчарка",
  "Східноєвропейська вівчарка",
  "Лабрадор-ретривер",
  "Золотистий ретривер",
  "Ротвейлер",
  "Доберман",
  "Кавказька вівчарка",
  "Середньоазійська вівчарка (алабай)",
  "Сибірський хаскі",
  "Аляскинський маламут",
  "Бернський зенненхунд",
  "Німецький дог",
  "Боксер",
  "Різеншнауцер",
  "Кане-корсо",
  "Московська сторожова",
  "Російський чорний тер’єр",
  "Леонбергер",
  "Ньюфаундленд",
  "Бордоський дог",

  "Бордер-колі",
  "Австралійська вівчарка (ауссі)",
  "Далматин",
  "Англійський бульдог",
  "Американський стаффордширський тер’єр",
  "Стаффордширський бультер’єр",
  "Бігль",
  "Англійський кокер-спанієль",
  "Англійський спрингер-спанієль",
  "Шетландська вівчарка (шелті)",
  "Західносибірська лайка",
  "Російсько-європейська лайка",
  "Російський гончак",
  "Угорська вижла",
  "Веймаранер",
  "Курцхаар",
  "Дратхаар",
  "Чехословацький вовчак",
  "Басенджі",
  "Шарпей",
  "Акіта-іну",
  "Сіба-іну",

  "Йоркширський тер’єр",
  "Чихуахуа",
  "Російський той",
  "Такса стандартна",
  "Такса мініатюрна",
  "Мопс",
  "Французький бульдог",
  "Німецький шпіц (померанський)",
  "Ши-тцу",
  "Мальтезе",
  "Пекінес",
  "Джек-рассел-тер’єр",
  "Вест-хайленд-вайт-тер’єр",
  "Цвергшнауцер",
  "Папільйон",
  "Той-пудель",
  "Карликовий пудель",
  "Великий пудель",
  "Бішон-фрізе",
  "Бассет-гаунд",
  "Кавалер-кінг-чарльз-спанієль",
  "Італійський левретка",

  "Англійський сетер",
  "Ірландський сетер",
  "Шотландський сетер (гордон)",
  "Пойнтер",
  "Ірландський вовкодав",
  "Російський псовий хорт",
  "Віпет",
  "Грейгаунд",
  "Афганський хорт",
  "Салюкі",
  "Бассет-фов-де-бретань",
  "Гладкошерстий фокстер’єр",
  "Жорсткошерстий фокстер’єр",
  "Бультер’єр",
  "Американський бульдог",
  "Аргентинський дог",
  "Бразильська філа",
  "Тоса-іну",

  "Піренейський гірський собака",
  "Тибетський мастиф",
  "Англійський мастиф",
  "Бульмастиф",
  "Сенбернар",
  "Піренейський мастиф",
  "Іспанський мастиф",
  "Анатолійська вівчарка (кангал)",
  "Бельгійська вівчарка малінуа",
  "Бельгійська вівчарка тервюрен",
  "Голландська вівчарка",
  "Колі довгошерста",
  "Колі короткошерста",

  "Американський кокер-спанієль",
  "Ірландський тер’єр",
  "Ердельтер’єр",
  "Керн-тер’єр",
  "Метис / безпородний"
];

const CAT_BREEDS = [
  "Британська короткошерста",
  "Британська довгошерста",
  "Шотландська висловуха",
  "Шотландська прямовуха",
  "Хайленд-фолд",
  "Хайленд-страйт",
  "Мейн-кун",
  "Російська блакитна",
  "Сибірська",
  "Невська маскарадна",
  "Перська",
  "Гімалайська (колор-пойнт)",
  "Перська шиншила",
  "Екзотична короткошерста",

  "Канадський сфінкс",
  "Донський сфінкс",
  "Петерболд",
  "Український левкой",
  "Абіссинська",
  "Корніш-рекс",
  "Девон-рекс",
  "Селкірк-рекс короткошерстий",
  "Селкірк-рекс довгошерстий",
  "Німецький рекс",
  "Ла-перм",
  "Уральський рекс",

  "Сомалійська",
  "Бенгальська",
  "Регдол",
  "Рагамафін",
  "Норвезька лісова",
  "Сіамська",
  "Тайська",
  "Орієнтальна короткошерста",
  "Орієнтальна довгошерста",
  "Бурманська",
  "Бурміла",
  "Тонкінська",

  "Манчкін короткошерстий",
  "Манчкін довгошерстий",
  "Наполеон (мінует)",
  "Турецька ангора",
  "Турецький ван",
  "Єгипетська мау",
  "Американська короткошерста",
  "Американська жорсткошерста",
  "Американський керл короткошерстий",
  "Американський керл довгошерстий",
  "Оцикет",
  "Балінезійська",
  "Яванез",
  "Японський бобтейл короткошерстий",
  "Японський бобтейл довгошерстий",
  "Курильський бобтейл короткошерстий",
  "Курильський бобтейл довгошерстий",
  "Карельський бобтейл",
  "Меконгський бобтейл",
  "Піксибоб короткошерстий",
  "Піксибоб довгошерстий",

  "Той-боб",
  "Шартрез",
  "Азійська таббі",
  "Азійська димчаста",
  "Азійська однотонна",
  "Бомбейська",
  "Гавана браун",
  "Корат",
  "Сингапура",
  "Серенгеті",
  "Саванна",
  "Каракет",

  "Чаузі",
  "Чіто (Cheetoh)",
  "Менкс",
  "Кімрик",
  "Нібелунг",
  "Тіффані",
  "Скукум",
  "Кінкалоу",
  "Лікой",
  "Ельф",
  "Двельф",
  "Бамбіно",
  "Мінскін",
  "Йоркська шоколадна",
  "Хайлендер",
  "Австралійський міст",
  "Європейська короткошерста",
  "Сококе",
  "Тойгер",
  "Сноу-шу",
  "Кіпрська кішка (Афродіта)",
  "Аравійська мау",
  "Охос азулес",
  "Каліфорнійська плямиста",
  "Хайленд-лінкс",
  "Американський бобтейл короткошерстий",
  "Американський бобтейл довгошерстий",
  "Китайська Лі Хуа",
  "Метис / безпородна"
];

function openAddPetModal(ownerId, petToEdit = null) {
  const isEditMode = Boolean(petToEdit?.id);
  const editingPetId = isEditMode ? String(petToEdit.id) : null;

  if (!ownerId) {
    alert("Спочатку обери власника");
    return;
  }

  // дальше твой текущий код

  document.querySelector("#addPetModalOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "addPetModalOverlay";
  overlay.className = "addPetModalOverlay";

  overlay.innerHTML = `
  <div
    class="addPetModal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="addPetModalTitle"
  >
    <div class="addPetModalGlow addPetModalGlowOne"></div>
    <div class="addPetModalGlow addPetModalGlowTwo"></div>

    <div class="addPetModalHeader">
      <div>
       <div class="addPetModalKicker">
  ${isEditMode ? "РЕДАГУВАННЯ ПАЦІЄНТА" : "НОВИЙ ПАЦІЄНТ"}
</div>

<h2 id="addPetModalTitle">
  ${isEditMode ? "Редагувати тварину" : "Додати тварину"}
</h2>

<p>
  ${
    isEditMode
      ? "Оновіть дані пацієнта та збережіть зміни."
      : "Створіть картку пацієнта. Дані можна буде змінити пізніше."
  }
</p>
      </div>

      <button
        class="addPetModalClose"
        id="addPetModalClose"
        type="button"
        aria-label="Закрити"
      >
        ×
      </button>
    </div>

    <form id="addPetModalForm" class="addPetModalForm" novalidate>
      <div class="addPetModalGrid">

        <label class="addPetField addPetFieldFull">
          <span class="addPetLabel">
            Кличка
            <b>*</b>
          </span>

          <div class="addPetInputWrap">
            <span class="addPetInputIcon">✦</span>

            <input
              id="addPetName"
              class="addPetInput addPetInputWithIcon"
              type="text"
              maxlength="80"
              autocomplete="off"
              placeholder="Наприклад: Жужа"
            >
          </div>
        </label>

        <div class="addPetField addPetFieldFull">
          <span class="addPetLabel">
            Вид пацієнта
            <b>*</b>
          </span>

          <div class="addPetSpeciesSelector">

            <button
              class="addPetSpeciesButton"
              type="button"
              data-add-pet-species="cat"
            >
              <span class="addPetSpeciesEmoji">🐈</span>

              <span class="addPetSpeciesInfo">
                <strong>Кіт</strong>
                <small>Кішка або кіт</small>
              </span>

              <span class="addPetSpeciesCheck">✓</span>
            </button>

            <button
              class="addPetSpeciesButton"
              type="button"
              data-add-pet-species="dog"
            >
              <span class="addPetSpeciesEmoji">🐕</span>

              <span class="addPetSpeciesInfo">
                <strong>Пес</strong>
                <small>Собака</small>
              </span>

              <span class="addPetSpeciesCheck">✓</span>
            </button>

            <button
              class="addPetSpeciesButton addPetSpeciesButtonOther"
              type="button"
              data-add-pet-species="other"
            >
              <span class="addPetSpeciesEmoji">🐾</span>

              <span class="addPetSpeciesInfo">
                <strong>Інші види</strong>
                <small>Птахи, гризуни та інші</small>
              </span>

              <span class="addPetSpeciesCheck">✓</span>
            </button>

          </div>

          <input
            id="addPetSpecies"
            type="hidden"
            value=""
          >
        </div>

        <div
          class="addPetField addPetFieldFull addPetBreedField"
          id="addPetBreedField"
        >
          <span
            class="addPetLabel"
            id="addPetBreedLabel"
          >
            Порода
            <small>необов’язково</small>
          </span>

          <div class="addPetBreedCombobox">

            <div class="addPetInputWrap">
              <span class="addPetInputIcon">⌕</span>

              <input
                id="addPetBreed"
                class="addPetInput addPetInputWithIcon"
                type="text"
                maxlength="100"
                autocomplete="off"
                placeholder="Спочатку оберіть вид пацієнта"
                disabled
              >

              <button
                class="addPetBreedClear"
                id="addPetBreedClear"
                type="button"
                aria-label="Очистити поле"
              >
                ×
              </button>
            </div>

            <div
              class="addPetBreedDropdown"
              id="addPetBreedDropdown"
            ></div>

          </div>

          <div
            class="addPetBreedHint"
            id="addPetBreedHint"
          >
            Після вибору виду тут з’явиться список порід.
          </div>
        </div>

        <label class="addPetField">
          <span class="addPetLabel">
            Вік
            <small>необов’язково</small>
          </span>

          <input
            id="addPetAge"
            class="addPetInput"
            type="text"
            maxlength="40"
            autocomplete="off"
            placeholder="Наприклад: 4 роки"
          >
        </label>

        <label class="addPetField">
          <span class="addPetLabel">
            Вага
            <small>необов’язково</small>
          </span>

          <div class="addPetWeightWrap">
            <input
              id="addPetWeight"
              class="addPetInput"
              type="number"
              min="0"
              max="300"
              step="0.01"
              inputmode="decimal"
              placeholder="5.2"
            >

            <span>кг</span>
          </div>
        </label>

        <label class="addPetField addPetFieldFull">
          <span class="addPetLabel">
            Нотатки
            <small>необов’язково</small>
          </span>

          <textarea
            id="addPetNotes"
            class="addPetTextarea"
            maxlength="500"
            placeholder="Алергії, особливості поведінки або інша важлива інформація..."
          ></textarea>

          <div class="addPetNotesCounter">
            <span id="addPetNotesCount">0</span>/500
          </div>
        </label>

      </div>

      <div
        id="addPetModalError"
        class="addPetModalError"
      ></div>

      <div class="addPetModalActions">

        <button
          class="addPetCancelButton"
          id="addPetCancelButton"
          type="button"
        >
          Скасувати
        </button>

        <button
          class="addPetSubmitButton"
          id="addPetSubmitButton"
          type="submit"
        >
          <span class="addPetSubmitPlus">
  ${isEditMode ? "✓" : "＋"}
</span>

<span>
  ${isEditMode ? "Зберегти зміни" : "Додати тварину"}
</span>
        </button>

      </div>
    </form>
  </div>
`;

  document.body.appendChild(overlay);
  document.body.classList.add("addPetModalOpened");

  const form = overlay.querySelector("#addPetModalForm");
  const nameInput = overlay.querySelector("#addPetName");
  const speciesInput = overlay.querySelector("#addPetSpecies");
  const breedInput = overlay.querySelector("#addPetBreed");
  const breedField = overlay.querySelector("#addPetBreedField");
const breedLabel = overlay.querySelector("#addPetBreedLabel");
const breedDropdown = overlay.querySelector("#addPetBreedDropdown");
const breedHint = overlay.querySelector("#addPetBreedHint");
const breedClear = overlay.querySelector("#addPetBreedClear");

let activeBreedList = [];
let selectedBreed = "";
  const ageInput = overlay.querySelector("#addPetAge");
  const weightInput = overlay.querySelector("#addPetWeight");
  const notesInput = overlay.querySelector("#addPetNotes");
  const notesCount = overlay.querySelector("#addPetNotesCount");
  const errorBox = overlay.querySelector("#addPetModalError");
  const submitButton = overlay.querySelector("#addPetSubmitButton");
  const normalizeStoredSpecies = (value) => {
    const raw = String(value || "").trim().toLowerCase();

    if (
      raw === "cat" ||
      raw === "кіт" ||
      raw === "кот" ||
      raw === "кішка" ||
      raw === "кошка"
    ) {
      return "cat";
    }

    if (
      raw === "dog" ||
      raw === "пес" ||
      raw === "собака"
    ) {
      return "dog";
    }

    return raw ? "other" : "";
  };


  let isSaving = false;

  const closeModal = () => {
    if (isSaving) return;

    overlay.classList.remove("is-open");
    document.body.classList.remove("addPetModalOpened");
    document.removeEventListener("keydown", handleKeydown);

    setTimeout(() => {
      overlay.remove();
    }, 220);
  };

  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      closeModal();
    }
  };

  const clearError = () => {
    errorBox.textContent = "";

    overlay.querySelectorAll(".is-error").forEach((element) => {
      element.classList.remove("is-error");
    });
  };

  const showError = (message) => {
    errorBox.textContent = message;
  };

const normalizeBreedSearch = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll("’", "'")
    .replaceAll("`", "'");
};

const closeBreedDropdown = () => {
  breedDropdown.classList.remove("is-open");
  breedDropdown.innerHTML = "";
};

const renderBreedDropdown = () => {
  if (!activeBreedList.length) {
    closeBreedDropdown();
    return;
  }

  const query = normalizeBreedSearch(breedInput.value);

  const filtered = activeBreedList
    .filter((breed) => {
      if (!query) return true;

      return normalizeBreedSearch(breed).includes(query);
    })
    .slice(0, 12);

  breedDropdown.innerHTML = filtered.length
    ? filtered.map((breed) => `
        <button
          class="addPetBreedOption ${
            selectedBreed === breed ? "is-selected" : ""
          }"
          type="button"
          data-select-breed="${escapeHtml(breed)}"
        >
          <span class="addPetBreedOptionIcon">🐾</span>

          <span>${escapeHtml(breed)}</span>

          ${
            selectedBreed === breed
              ? `<b>✓</b>`
              : ""
          }
        </button>
      `).join("")
    : `
        <div class="addPetBreedEmpty">
          <span>Породу не знайдено</span>
          <small>Назву можна залишити введеною вручну.</small>
        </div>
      `;

  breedDropdown.classList.add("is-open");
};

const configureBreedField = (species) => {
  selectedBreed = "";
  breedInput.value = "";
  closeBreedDropdown();

  breedField.classList.remove("is-other-species");

  if (species === "dog") {
    activeBreedList = DOG_BREEDS;

    breedInput.disabled = false;
    breedInput.placeholder = "Почніть вводити породу собаки";

    breedLabel.innerHTML = `
      Порода собаки
      <small>необов’язково</small>
    `;

    breedHint.textContent =
      "Введіть кілька літер або відкрийте список популярних порід.";

    return;
  }

  if (species === "cat") {
    activeBreedList = CAT_BREEDS;

    breedInput.disabled = false;
    breedInput.placeholder = "Почніть вводити породу кота";

    breedLabel.innerHTML = `
      Порода кота
      <small>необов’язково</small>
    `;

    breedHint.textContent =
      "Введіть кілька літер або відкрийте список порід котів.";

    return;
  }

  if (species === "other") {
    activeBreedList = [];

    breedInput.disabled = false;
    breedInput.placeholder = "Наприклад: корела, шиншила, кролик";

    breedLabel.innerHTML = `
      Вид тварини
      <small>необов’язково</small>
    `;

    breedHint.textContent =
      "Вкажіть вид тварини вручну.";

    breedField.classList.add("is-other-species");
    return;
  }

  activeBreedList = [];

  breedInput.disabled = true;
  breedInput.placeholder = "Спочатку оберіть вид пацієнта";

  breedLabel.innerHTML = `
    Порода
    <small>необов’язково</small>
  `;

  breedHint.textContent =
    "Після вибору виду тут з’явиться список порід.";
};
if (isEditMode) {
  const currentSpecies = normalizeStoredSpecies(petToEdit.species);

  nameInput.value = String(petToEdit.name || "");
  ageInput.value = String(petToEdit.age || "");
  weightInput.value = String(petToEdit.weight_kg || "");
  notesInput.value = String(petToEdit.notes || "");

  notesCount.textContent = String(notesInput.value.length);

  speciesInput.value = currentSpecies;

  const currentSpeciesButton = overlay.querySelector(
    `[data-add-pet-species="${currentSpecies}"]`
  );

  currentSpeciesButton?.classList.add("is-active");

  configureBreedField(currentSpecies);

  breedInput.value = String(petToEdit.breed || "");
  selectedBreed = String(petToEdit.breed || "");
}
 overlay
  .querySelectorAll("[data-add-pet-species]")
  .forEach((button) => {
    button.addEventListener("click", () => {
      overlay
        .querySelectorAll("[data-add-pet-species]")
        .forEach((item) => item.classList.remove("is-active"));

      button.classList.add("is-active");

      const species = button.dataset.addPetSpecies || "";
      speciesInput.value = species;

      configureBreedField(species);
      clearError();

      setTimeout(() => {
        breedInput.focus();
      }, 120);
    });
  });

  breedInput.addEventListener("focus", () => {
  if (!breedInput.disabled && activeBreedList.length) {
    renderBreedDropdown();
  }
});

breedInput.addEventListener("input", () => {
  selectedBreed = "";

  if (activeBreedList.length) {
    renderBreedDropdown();
  }
});

breedInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeBreedDropdown();
  }

  if (event.key === "Enter" && breedDropdown.classList.contains("is-open")) {
    const firstOption = breedDropdown.querySelector("[data-select-breed]");

    if (firstOption) {
      event.preventDefault();
      firstOption.click();
    }
  }
});

breedDropdown.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

breedDropdown.addEventListener("click", (event) => {
  const option = event.target.closest("[data-select-breed]");
  if (!option) return;

  const breed = option.dataset.selectBreed || "";

  selectedBreed = breed;
  breedInput.value = breed;

  closeBreedDropdown();
  clearError();
});

breedClear.addEventListener("click", () => {
  selectedBreed = "";
  breedInput.value = "";

  closeBreedDropdown();
  breedInput.focus();

  if (activeBreedList.length) {
    renderBreedDropdown();
  }
});

document.addEventListener("mousedown", (event) => {
  if (!event.target.closest(".addPetBreedCombobox")) {
    closeBreedDropdown();
  }
});

  notesInput.addEventListener("input", () => {
    notesCount.textContent = String(notesInput.value.length);
  });

  overlay
    .querySelector("#addPetModalClose")
    ?.addEventListener("click", closeModal);

  overlay
    .querySelector("#addPetCancelButton")
    ?.addEventListener("click", closeModal);

  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) {
      closeModal();
    }
  });

  document.addEventListener("keydown", handleKeydown);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (isSaving) return;

    clearError();

    const name = nameInput.value.trim();
    const species = speciesInput.value.trim();
    const breed = breedInput.value.trim();
    const age = ageInput.value.trim();
    const weightRaw = weightInput.value.trim();
    const notes = notesInput.value.trim();

    if (!name) {
      nameInput.classList.add("is-error");
      showError("Вкажіть кличку тварини.");
      nameInput.focus();
      return;
    }

    if (!species) {
      overlay
        .querySelector(".addPetSpeciesSelector")
        ?.classList.add("is-error");

      showError("Оберіть вид пацієнта.");
      return;
    }

    if (weightRaw) {
      const weightNumber = Number(weightRaw.replace(",", "."));

      if (
        !Number.isFinite(weightNumber) ||
        weightNumber <= 0 ||
        weightNumber > 300
      ) {
        weightInput.classList.add("is-error");
        showError("Перевірте вагу тварини.");
        weightInput.focus();
        return;
      }
    }

    isSaving = true;
    submitButton.disabled = true;

    const originalButtonHtml = submitButton.innerHTML;

    submitButton.innerHTML = `
      <span class="addPetLoader"></span>
      <span>Створюємо...</span>
    `;

        const payload = {
      owner_id: ownerId,
      name,
      species,
      breed,
      age,
      weight_kg: weightRaw,
      notes,
    };

    const savedPet = isEditMode
      ? await updatePatientApi(editingPetId, payload)
      : await createPatientApi(payload);

    if (!savedPet) {
      isSaving = false;
      submitButton.disabled = false;
      submitButton.innerHTML = originalButtonHtml;

      showError(
        isEditMode
          ? "Не вдалося зберегти зміни."
          : "Не вдалося створити пацієнта."
      );

      return;
    }

    await loadPatientsApi();

    if (
      isEditMode &&
      String(state.selectedPetId || "") === String(editingPetId)
    ) {
      const refreshedPet = (state.patients || []).find(
        (pet) => String(pet.id) === String(editingPetId)
      );

      if (refreshedPet) {
        state.selectedPet = refreshedPet;
      }
    }

    isSaving = false;
    overlay.classList.remove("is-open");
    document.body.classList.remove("addPetModalOpened");
    document.removeEventListener("keydown", handleKeydown);
    overlay.remove();

        if (state.route === "patients") {
      await renderPatientsTab();
    }

    if (
      state.route === "patient" &&
      String(state.selectedPetId || "") === String(editingPetId)
    ) {
      const refreshedPet = (state.patients || []).find(
        (pet) => String(pet.id) === String(editingPetId)
      );

      if (refreshedPet) {
        state.selectedPet = refreshedPet;
        await renderPatientCard(refreshedPet);
      }
    }

    if (
      state.route === "owner" &&
      state.selectedOwnerId
    ) {
      await renderOwnerPage(state.selectedOwnerId);
    }
  });

  requestAnimationFrame(() => {
    overlay.classList.add("is-open");

    setTimeout(() => {
      nameInput.focus();
    }, 180);
  });
}


function initOwnerUI() {
  // Добавление животного владельцу
  $("#btnAddPet")?.addEventListener("click", () => {
    const ownerId = state.selectedOwnerId;

    if (!ownerId) {
      alert("Спочатку обери власника");
      return;
    }

    openAddPetModal(ownerId);
  });

  // Клик по списку животных (Удаление / Открытие)
  $("#petsList")?.addEventListener("click", async (e) => {
  const delBtn = e.target.closest("[data-del-pet]");
  if (delBtn) {
    e.preventDefault();
    e.stopPropagation();

    const petId = delBtn.dataset.delPet;
    if (!petId) return;

    const pet = (state.patients || []).find(
      (p) => String(p.id) === String(petId)
    );

    const petName = pet?.name || "цього пацієнта";

    openDeleteModal(
      `<b>${escapeHtml(petName)}</b><br><br>Цю дію неможливо скасувати.`,
      async () => {

        const ok = await deletePatientApi(petId);

        if (!ok) {
          alert("Не вдалося видалити пацієнта.");
          return;
        }

        await loadPatientsApi();

        if (state.selectedPetId === petId) {
          state.selectedPetId = null;
          state.selectedPet = null;
        }

        if (state.selectedOwnerId) {
          renderOwnerPage(state.selectedOwnerId);
        }
      }
    );

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
  modal.style.display = "none";

  delete modal.dataset.visitId;
  delete modal.dataset.openSource;
  delete modal.dataset.patientId;

  state.selectedPet = null;
  state.selectedPetId = null;

  const patientSelect =
    $("#visitPatientSelect");

  if (patientSelect) {
    patientSelect.value = "";
  }

  const patientSearch =
    $("#visitPatientSearch");

  if (patientSearch) {
    patientSearch.value = "";
  }

  const patientResults =
    $("#visitPatientResults");

  if (patientResults) {
    patientResults.innerHTML = "";
  }

  const modalSub =
    $("#visitModalSub");

  if (modalSub) {
    modalSub.textContent =
      "Оберіть пацієнта";
  }

  const patientBlock =
    $("#visitPatientBlock");

  if (patientBlock) {
    patientBlock.style.display = "block";
  }

  const newPatientBox =
    $("#visitNewPatientBox");

  if (newPatientBox) {
    newPatientBox.style.display = "none";
  }

  [
    "#visitNewOwnerName",
    "#visitNewOwnerPhone",
    "#visitNewOwnerNote",
    "#visitNewPetName",
    "#visitNewPetSpecies",
    "#visitNewPetBreed",
    "#visitNewPetAge",
    "#visitNewPetWeight",
  ].forEach((selector) => {
    const element = $(selector);

    if (!element) return;

    if (element.tagName === "SELECT") {
      element.selectedIndex = 0;
    } else {
      element.value = "";
    }
  });

  document.body.classList.remove(
    "medcardModalIsOpen"
  );
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
  const s = String(value || "")
    .toLowerCase()
    .trim();

  if (
    s === "dog" ||
    s.includes("пес") ||
    s.includes("соб") ||
    s.includes("dog")
  ) {
    return "dog";
  }

  if (
    s === "cat" ||
    s.includes("кот") ||
    s.includes("кіт") ||
    s.includes("cat")
  ) {
    return "cat";
  }

  return "dog";
}

function speciesLabel(value) {
  const key = normalizeSpecies(value);

  if (key === "cat") {
    return "кіт";
  }

  return "пес";
}

function askSpecies(current = "dog") {
  const cur = normalizeSpecies(current);

  const raw = prompt(
    "Вид пацієнта:\n1 — пес\n2 — кіт",
    cur === "cat" ? "2" : "1"
  );

  if (raw === null) {
    return null;
  }

  const value = String(raw)
    .trim()
    .toLowerCase();

  if (
    value === "2" ||
    value === "cat" ||
    value.includes("кот") ||
    value.includes("кіт")
  ) {
    return "cat";
  }

  return "dog";
}

function getPetSpeciesKey(pet) {
  return normalizeSpecies(pet?.species);
}

// =========================
// Вспомогательные функции модального окна визитов
// =========================
function openVisitModalForCreate(pet = null) {
  const modal = $("#visitModal");

  if (!modal) {
    alert("Не знайдено #visitModal в HTML");
    return;
  }

  delete modal.dataset.visitId;

  const openedFromPatient = Boolean(
    pet?.id || pet?._id
  );

  const petId =
    pet?.id ||
    pet?._id ||
    null;

  modal.dataset.openSource =
    openedFromPatient
      ? "patient"
      : "calendar";

  modal.dataset.patientId =
    petId
      ? String(petId)
      : "";

  // Базовые поля нового визита
  const dateInput = $("#visitDate");
  const noteInput = $("#visitNote");
  const dxInput = $("#visitDx");
  const weightInput = $("#visitWeight");
  const rxInput = $("#visitRx");
  const startTimeInput = $("#visitStartTime");
  const durationInput = $("#visitDuration");

  if (dateInput) {
    dateInput.value = todayISO();
  }

  if (noteInput) {
    noteInput.value = "";
  }

  if (dxInput) {
    dxInput.value = "";
  }

  if (weightInput) {
    weightInput.value =
      pet?.weight_kg ||
      pet?.weight ||
      "";
  }

  if (rxInput) {
    rxInput.value = "";
  }

  if (startTimeInput && !startTimeInput.value) {
    startTimeInput.value = "10:00";
  }

  if (durationInput && !durationInput.value) {
    durationInput.value = "60";
  }

  // Пациент
  const patientSelect =
    $("#visitPatientSelect");

  const patientSearch =
    $("#visitPatientSearch");

  const patientResults =
    $("#visitPatientResults");

  const modalSub =
    $("#visitModalSub");

  const patientBlock =
    $("#visitPatientBlock");

  if (openedFromPatient) {
    state.selectedPet = pet;
    state.selectedPetId =
      String(petId);

    if (patientSelect) {
      patientSelect.value =
        String(petId);
    }

    if (patientSearch) {
      patientSearch.value =
        pet?.name || "";
    }

    if (patientResults) {
      patientResults.innerHTML = "";
    }

    if (modalSub) {
      modalSub.textContent =
        `Пацієнт: ${pet?.name || "—"}`;
    }

    if (patientBlock) {
      patientBlock.style.display = "none";
    }
  } else {
    state.selectedPet = null;
    state.selectedPetId = null;

    if (patientSelect) {
      patientSelect.value = "";
    }

    if (patientSearch) {
      patientSearch.value = "";
    }

    if (patientResults) {
      patientResults.innerHTML = "";
    }

    if (modalSub) {
      modalSub.textContent =
        "Оберіть пацієнта";
    }

    if (patientBlock) {
      patientBlock.style.display = "block";
    }
  }

  // Быстрое создание пациента
  const quickBox =
    $("#visitNewPatientBox");

  if (quickBox) {
    quickBox.style.display = "none";
  }

  const btnCreatePatientFromVisit =
    $("#btnCreatePatientFromVisit");

  if (btnCreatePatientFromVisit) {
    btnCreatePatientFromVisit.onclick = () => {
      const box =
        $("#visitNewPatientBox");

      if (!box) {
        return;
      }

      box.style.display =
        box.style.display === "none" ||
        !box.style.display
          ? "block"
          : "none";
    };
  }

  // Ветеринар
  const staffSelect =
    $("#visitStaff");

  const fillStaffSelect = (staffList) => {
    if (!staffSelect) {
      return;
    }

    const safeStaffList =
      Array.isArray(staffList)
        ? staffList
        : [];

    staffSelect.innerHTML = `
      <option value="">
        Оберіть ветеринара
      </option>

      ${safeStaffList
        .map((doctor) => {
          return `
            <option value="${escapeHtml(
              String(doctor.id)
            )}">
              ${escapeHtml(
                doctor.name ||
                "Працівник"
              )}
            </option>
          `;
        })
        .join("")}
    `;
  };

  const fillStaffFallback = () => {
    if (!staffSelect) {
      return;
    }

    staffSelect.innerHTML = `
      <option value="">
        Оберіть ветеринара
      </option>

      <option
        value="default_doc"
        selected
      >
        Черговий лікар 🩺
      </option>
    `;
  };

  if (
    typeof loadStaffApi === "function"
  ) {
    loadStaffApi()
      .then((staff) => {
        const staffList =
          Array.isArray(staff) &&
          staff.length
            ? staff
            : [
                {
                  id: "default_doc",
                  name: "Черговий лікар 🩺",
                },
              ];

        fillStaffSelect(staffList);
      })
      .catch((error) => {
        console.warn(
          "Бэкенд недоступен, ставим дефолтного врача:",
          error
        );

        fillStaffFallback();
      });
  } else {
    fillStaffFallback();
  }

  // Закрытие модального окна
  const closeThisVisitModal = () => {
    document.removeEventListener(
      "keydown",
      handleEscClose
    );

    closeVisitModal();
  };

  const handleEscClose = (event) => {
    if (event.key === "Escape") {
      closeThisVisitModal();
    }
  };

  // На случай повторного открытия удаляем
  // старый обработчик ESC этой модалки
  if (
    window.__visitModalEscHandler
  ) {
    document.removeEventListener(
      "keydown",
      window.__visitModalEscHandler
    );
  }

  window.__visitModalEscHandler =
    handleEscClose;

  document.addEventListener(
    "keydown",
    handleEscClose
  );

  const allCloseElements =
    modal.querySelectorAll(
      [
        ".close",
        ".btn-close",
        "[data-close]",
        ".cancel-btn",
        "#btnCancelVisit",
        ".pugVisitClose",
      ].join(", ")
    );

  allCloseElements.forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();

      closeThisVisitModal();
    };
  });

  // Закрытие по клику на затемнение,
  // но не по клику внутри формы
  modal.onclick = (event) => {
    if (event.target === modal) {
      closeThisVisitModal();
      return;
    }

    const closeTarget =
      event.target.closest(
        [
          ".close-modal",
          ".pugVisitClose",
          "[data-close]",
          "#btnCancelVisit",
        ].join(", ")
      );

    if (closeTarget) {
      event.preventDefault();
      event.stopPropagation();

      closeThisVisitModal();
    }
  };

  // После сохранения не накапливаем
  // повторные submit-обработчики
  const openedPetId =
    petId
      ? String(petId)
      : null;

  const form =
    modal.querySelector("form");

  if (form) {
    form.onsubmit = () => {
      setTimeout(() => {
        closeThisVisitModal();

        if (
          openedPetId &&
          typeof renderVisits === "function"
        ) {
          renderVisits(openedPetId);
        }
      }, 250);
    };
  }

  // Открытие модального окна
  modal.style.cssText = "";
  modal.style.display = "flex";

  modal.classList.add("open");

  modal.setAttribute(
    "aria-hidden",
    "false"
  );

  document.body.classList.add(
    "medcardModalIsOpen"
  );
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
  staff_id: staffId,
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

      const savedPetId = pet.id;

closeVisitModal();

if (savedPetId) await renderVisits(savedPetId);
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

    const savedPetId = pet.id;

closeVisitModal();

if (savedPetId) await renderVisits(savedPetId);
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
  const id = String(petId || "");
  if (!id) return;

  const patients =
    Array.isArray(state.patients) && state.patients.length
      ? state.patients
      : loadPatients();

  const pet = patients.find(
    (item) => String(item.id) === id
  );

  if (!pet) {
    alert("Пацієнта не знайдено.");
    return;
  }

  const petName = pet.name || "Без імені";

  openDeleteModal(
    `
      <b>${escapeHtml(petName)}</b>
      <br><br>
      Пацієнта буде видалено назавжди разом із його карткою.
      <br>
      Цю дію неможливо скасувати.
    `,
    async () => {
      const ok = await deletePatientApi(id);

      if (!ok) {
        alert("Не вдалося видалити пацієнта.");
        return;
      }

      await loadPatientsApi();

      if (String(state.selectedPetId || "") === id) {
        state.selectedPetId = null;
        state.selectedPet = null;
        state.selectedVisitId = null;
      }

      if (state.route === "patients") {
        renderPatientsTab();
      }

      if (state.selectedOwnerId) {
        renderOwnerPage(state.selectedOwnerId);
      }

      if (state.route === "visits") {
        renderVisitsTab();
      }
    }
  );
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
function fillMedcardDoctorsSelect(selectedDoctor = "") {
  const select = document.getElementById("medDoctor");
  if (!select) return;

  const staff = Array.isArray(state.staff)
    ? state.staff
    : [];

  const doctors = staff.filter((item) => {
    if (item.is_active === false) return false;

    return item.role === "vet";
  });

  select.innerHTML = `
    <option value="">Оберіть лікаря</option>

    ${doctors
      .map((doctor) => {
        const name = String(doctor.name || "").trim();
        if (!name) return "";

        const specialization = String(
          doctor.specialization || ""
        ).trim();

        const label = specialization
          ? `${name} — ${specialization}`
          : name;

        return `
          <option
            value="${escapeHtml(name)}"
            ${
              String(selectedDoctor || "") === name
                ? "selected"
                : ""
            }
          >
            ${escapeHtml(label)}
          </option>
        `;
      })
      .join("")}
  `;
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

  if (modal) {
    return modal;
  }

  modal = document.createElement("div");
  modal.id = "medcardModal";
  modal.className = "medcardModalOverlay";
  modal.setAttribute("aria-hidden", "true");

  modal.innerHTML = `
    <div
      class="medcardModalBackdrop"
      data-close-medcard-modal
    ></div>

    <section
      class="medcardModalWindow"
      role="dialog"
      aria-modal="true"
      aria-labelledby="medcardModalTitle"
    >
      <div class="medcardModalGlow medcardModalGlowOne"></div>
      <div class="medcardModalGlow medcardModalGlowTwo"></div>

      <header class="medcardModalHeader">
        <div class="medcardModalHeaderMain">
          <div class="medcardModalIcon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="25"
              height="25"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 3h6"></path>
              <path d="M10 3v3"></path>
              <path d="M14 3v3"></path>
              <rect x="5" y="6" width="14" height="15" rx="3"></rect>
              <path d="M9 11h6"></path>
              <path d="M12 8v6"></path>
              <path d="M8 17h8"></path>
            </svg>
          </div>

          <div>
            <div class="medcardModalKicker">
              МЕДИЧНИЙ ЩОДЕННИК
            </div>

            <h2 id="medcardModalTitle">
              Нова запись веткартки
            </h2>

            <p>
              Зафіксуйте стан пацієнта, показники, проведене лікування
              та подальший план спостереження.
            </p>
          </div>
        </div>

        <button
          class="medcardModalClose"
          type="button"
          data-close-medcard-modal
          aria-label="Закрити"
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M6 6l12 12"></path>
            <path d="M18 6 6 18"></path>
          </svg>
        </button>
      </header>

      <div class="medcardModalScroll">

        <!-- 1. Дата та показники -->

        <section class="medcardFormSection">
          <div class="medcardSectionHeader">
            <div class="medcardSectionIcon">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="3" y="5" width="18" height="16" rx="3"></rect>
                <path d="M8 3v4"></path>
                <path d="M16 3v4"></path>
                <path d="M3 10h18"></path>
              </svg>
            </div>

            <div>
              <h3>Час спостереження та показники</h3>
              <p>Основні фізіологічні параметри пацієнта.</p>
            </div>
          </div>

          <div class="medcardVitalsGrid">
            <label class="medcardField">
              <span class="medcardFieldLabel">
                Дата
                <b>*</b>
              </span>

              <input
                class="medcardInput"
                id="medEntryDate"
                type="date"
              >
            </label>

            <label class="medcardField">
              <span class="medcardFieldLabel">
                Час
              </span>

              <input
                class="medcardInput"
                id="medEntryTime"
                type="time"
              >
            </label>

            <label class="medcardField">
              <span class="medcardFieldLabel">
                Вага
                <small>кг</small>
              </span>

              <div class="medcardInputUnit">
                <input
                  class="medcardInput"
                  id="medWeight"
                  type="number"
                  min="0"
                  max="500"
                  step="0.01"
                  inputmode="decimal"
                  placeholder="12.4"
                >
                <span>кг</span>
              </div>
            </label>

            <label class="medcardField">
              <span class="medcardFieldLabel">
                Температура
                <small>°C</small>
              </span>

              <div class="medcardInputUnit">
                <input
                  class="medcardInput"
                  id="medTemp"
                  type="number"
                  min="25"
                  max="45"
                  step="0.1"
                  inputmode="decimal"
                  placeholder="38.7"
                >
                <span>°C</span>
              </div>
            </label>

            <label class="medcardField medcardFieldWide">
              <span class="medcardFieldLabel">
                Пульс / серцевий ритм
              </span>

              <input
                class="medcardInput"
                id="medPulse"
                type="text"
                maxlength="100"
                placeholder="Наприклад: 120/хв, ритмічний"
              >
            </label>
          </div>
        </section>

        <!-- 2. Поточний стан -->

        <section class="medcardFormSection">
          <div class="medcardSectionHeader">
            <div class="medcardSectionIcon">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3 12h4l2-6 4 12 2-6h6"></path>
              </svg>
            </div>

            <div>
              <h3>Поточний стан</h3>
              <p>Швидка оцінка основних систем організму.</p>
            </div>
          </div>

          <div class="medcardStateGrid">
            <label class="medcardField">
              <span class="medcardFieldLabel">Слизові / ясна</span>
              <input
                class="medcardInput"
                id="medMucosa"
                type="text"
                maxlength="100"
                placeholder="Рожеві, бліді, ціанотичні..."
              >
            </label>

            <label class="medcardField">
              <span class="medcardFieldLabel">Апетит</span>
              <input
                class="medcardInput"
                id="medAppetite"
                type="text"
                maxlength="100"
                placeholder="Добрий, знижений, відсутній..."
              >
            </label>

            <label class="medcardField">
              <span class="medcardFieldLabel">Вода / спрага</span>
              <input
                class="medcardInput"
                id="medWater"
                type="text"
                maxlength="100"
                placeholder="П’є, не п’є, полідипсія..."
              >
            </label>

            <label class="medcardField">
              <span class="medcardFieldLabel">Сечовипускання</span>
              <input
                class="medcardInput"
                id="medUrine"
                type="text"
                maxlength="100"
                placeholder="Норма, часте, відсутнє..."
              >
            </label>

            <label class="medcardField">
              <span class="medcardFieldLabel">Кал</span>
              <input
                class="medcardInput"
                id="medStool"
                type="text"
                maxlength="100"
                placeholder="Норма, діарея, запор..."
              >
            </label>

            <label class="medcardField">
              <span class="medcardFieldLabel">Дихання</span>
              <input
                class="medcardInput"
                id="medBreathing"
                type="text"
                maxlength="100"
                placeholder="Норма, тахіпное, утруднене..."
              >
            </label>
          </div>

          <label class="medcardField medcardConditionField">
            <span class="medcardFieldLabel">Загальний стан</span>

            <textarea
              class="medcardTextarea"
              id="medCondition"
              rows="4"
              maxlength="2000"
              placeholder="Свідомість, положення тіла, активність, біль, загальне самопочуття пацієнта..."
            ></textarea>
          </label>
        </section>

        <!-- 3. Лікування -->

        <section class="medcardFormSection medcardTreatmentSection">
          <div class="medcardSectionHeader">
            <div class="medcardSectionIcon">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M10.5 20.5 20 11"></path>
                <path d="m14 5 5 5"></path>
                <path d="M4.5 16.5 13 8"></path>
                <path d="m3 21 4-1-3-3-1 4Z"></path>
              </svg>
            </div>

            <div>
              <h3>Лікування та спостереження</h3>
              <p>Що зроблено зараз і як змінився стан пацієнта.</p>
            </div>
          </div>

          <div class="medcardTextGrid">
            <label class="medcardField">
              <span class="medcardFieldLabel">
                Проведено / призначено
              </span>

              <textarea
                class="medcardTextarea medcardTextareaLarge"
                id="medTreatment"
                rows="7"
                maxlength="4000"
                placeholder="Препарати, дозування, інфузії, маніпуляції, процедури..."
              ></textarea>
            </label>

            <label class="medcardField">
              <span class="medcardFieldLabel">
                Динаміка
              </span>

              <textarea
                class="medcardTextarea medcardTextareaLarge"
                id="medDynamics"
                rows="7"
                maxlength="3000"
                placeholder="Що змінилося після лікування або за період спостереження..."
              ></textarea>
            </label>
          </div>
        </section>

        <!-- 4. План -->

        <section class="medcardFormSection">
          <div class="medcardSectionHeader">
            <div class="medcardSectionIcon">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M9 11l3 3L22 4"></path>
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
              </svg>
            </div>

            <div>
              <h3>Подальший план</h3>
              <p>Контроль, наступні процедури та відповідальний лікар.</p>
            </div>
          </div>

          <div class="medcardPlanGrid">
            <label class="medcardField">
              <span class="medcardFieldLabel">
                План / контроль
              </span>

              <textarea
                class="medcardTextarea"
                id="medPlan"
                rows="5"
                maxlength="3000"
                placeholder="Повторний огляд, контроль показників, аналізи, зміна терапії..."
              ></textarea>
            </label>

            <div class="medcardPlanSide">
              <label class="medcardField">
  <span class="medcardFieldLabel">
    Лікар
  </span>

  <select
    class="medcardInput medcardSelect"
    id="medDoctor"
  >
    <option value="">Оберіть лікаря</option>
  </select>
</label>

              <label class="medcardField">
                <span class="medcardFieldLabel">
                  Додаткова нотатка
                </span>

                <textarea
                  class="medcardTextarea"
                  id="medNote"
                  rows="3"
                  maxlength="2000"
                  placeholder="Будь-які додаткові деталі..."
                ></textarea>
              </label>
            </div>
          </div>
        </section>
      </div>

      <footer class="medcardModalFooter">
        <div class="medcardModalFooterHint">
          Запис буде додано до хронології стану пацієнта.
        </div>

        <div class="medcardModalActions">
          <button
            class="medcardCancelButton"
            type="button"
            data-close-medcard-modal
          >
            Скасувати
          </button>

          <button
            class="medcardSaveButton"
            id="medcardSaveBtn"
            type="button"
          >
            <svg
              viewBox="0 0 24 24"
              width="17"
              height="17"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"></path>
              <path d="M17 21v-8H7v8"></path>
              <path d="M7 3v5h8"></path>
            </svg>

            <span>Зберегти запис</span>
          </button>
        </div>
      </footer>
    </section>
  `;

  document.body.appendChild(modal);

  modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-medcard-modal]")) {
      closeMedcardModal();
    }
  });

  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
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

  document.body.classList.remove("medcardModalIsOpen");

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
  // ==========================================
// ДОБАВЛЕНИЕ НОВОЙ ЗАПИСИ
// ==========================================

$("#btnAddMedcardEntry")?.addEventListener("click", async () => {
  const modal = ensureMedcardModal();

  if (!Array.isArray(state.staff) || !state.staff.length) {
    await loadStaffApi();
  }

  modal.dataset.patientId = String(pet.id);
  delete modal.dataset.entryId;

  const title = document.getElementById("medcardModalTitle");
  if (title) title.textContent = "Новий запис веткартки";

  medcardFormSet({});
  fillMedcardDoctorsSelect("");

  modal.style.cssText = "";
modal.style.display = "flex";

modal.classList.add("open");
modal.setAttribute("aria-hidden", "false");

document.body.classList.add(
  "medcardModalIsOpen"
);

console.log(
  "[calendar] modal opened",
  {
    selectedPet: state.selectedPet,
    selectedPetId: state.selectedPetId,
    hiddenPatientId:
      $("#visitPatientSelect")?.value || "",
  }
);

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


// ==========================================
// РЕДАКТИРОВАНИЕ И УДАЛЕНИЕ
// ==========================================

listElement.onclick = async (e) => {

  const del = e.target.closest("[data-del-medcard]");

  if (del) {
    const id = del.dataset.delMedcard;
    if (!id) return;

    if (!confirm("Видалити запис веткартки?")) return;

    const ok = await deleteMedcardApi(id);

    if (ok) {
      await renderMedcardTab(pet);
    }

    return;
  }

  const edit = e.target.closest("[data-edit-medcard]");

  if (edit) {
    const id = edit.dataset.editMedcard;
    if (!id) return;

    const current = items.find(x => String(x.id) === String(id));

    if (!current) {
      alert("Запис не знайдено");
      return;
    }

    if (!Array.isArray(state.staff) || !state.staff.length) {
      await loadStaffApi();
    }

    const modal = ensureMedcardModal();

    modal.dataset.patientId = String(pet.id);
    modal.dataset.entryId = String(id);

    const title = document.getElementById("medcardModalTitle");
    if (title) title.textContent = "Редагування запису веткартки";

    medcardFormSet(current);
    fillMedcardDoctorsSelect(current.doctor || "");

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("medcardModalIsOpen");

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

const DEFAULT_CLINIC_PROFILE = {
  id: "",
  name: "Ветеринарна клініка",
  subtitle: "Ветеринарна клініка",
  logo_url: "",
  phone: "",
  address: "",
  website: "",
  document_accent_color: "#9346E8",
  doctor_signature_url: "",
  clinic_stamp_url: "",
  document_footer: "Коли важливо — ми поруч.",
};

function getClinicProfile() {
  return {
    ...DEFAULT_CLINIC_PROFILE,
    ...(state.clinicProfile || {}),
  };
}

async function loadClinicProfileApi() {
  try {
    const response = await fetch(
      "/api/organization/profile",
      {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...getOrgHeaders(),
        },
      }
    );

    const text = await response.text();

    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok || !json?.ok) {
      throw new Error(
        json?.error ||
        `Помилка завантаження профілю клініки HTTP ${response.status}`
      );
    }

    const profile = {
      ...DEFAULT_CLINIC_PROFILE,
      ...(json.data || {}),
    };

    state.clinicProfile = profile;

    return profile;
  } catch (error) {
    console.error("loadClinicProfileApi failed:", error);

    state.clinicProfile = {
      ...DEFAULT_CLINIC_PROFILE,
      name:
        state.me?.clinic_name ||
        sessionStorage.getItem("pug_active_clinic_name") ||
        DEFAULT_CLINIC_PROFILE.name,
    };

    return state.clinicProfile;
  }
}

async function saveClinicProfileApi(payload = {}) {
  try {
    const response = await fetch(
      "/api/organization/profile",
      {
        method: "PUT",
        credentials: "include",

        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...getOrgHeaders(),
        },

        body: JSON.stringify(payload),
      }
    );

    const text = await response.text();

    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok || !json?.ok) {
      throw new Error(
        json?.error ||
        `Помилка збереження профілю клініки HTTP ${response.status}`
      );
    }

    state.clinicProfile = {
      ...DEFAULT_CLINIC_PROFILE,
      ...(json.data || {}),
    };

    if (state.me) {
      state.me.clinic_name =
        state.clinicProfile.name ||
        state.me.clinic_name;
    }

    sessionStorage.setItem(
      "pug_active_clinic_name",
      state.clinicProfile.name ||
      "Клініка"
    );

    return state.clinicProfile;
  } catch (error) {
    console.error("saveClinicProfileApi failed:", error);

    alert(
      "Не вдалося зберегти налаштування клініки: " +
      (error?.message || error)
    );

    return null;
  }
}

async function uploadClinicBrandFile(file) {
  if (!file) {
    throw new Error("Файл не вибрано");
  }

  const allowedTypes = [
    "image/png",
    "image/jpeg",
    "image/webp",
  ];

  if (!allowedTypes.includes(file.type)) {
    throw new Error(
      "Дозволені лише PNG, JPG або WEBP"
    );
  }

  if (file.size > 5 * 1024 * 1024) {
    throw new Error(
      "Максимальний розмір файлу — 5 МБ"
    );
  }

  const formData = new FormData();
  formData.append("files", file);

  const response = await fetch("/api/upload", {
    method: "POST",
    credentials: "include",
    headers: {
      ...getOrgHeaders(),
    },
    body: formData,
  });

  const text = await response.text();

  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok || !json?.ok) {
    throw new Error(
      json?.error ||
      `Помилка завантаження HTTP ${response.status}`
    );
  }

  const uploaded =
    json.files?.[0] ||
    json.data?.[0] ||
    json.data ||
    null;

  if (!uploaded) {
    throw new Error(
      "Сервер не повернув завантажений файл"
    );
  }

  const rawUrl =
    uploaded.url ||
    uploaded.path ||
    uploaded.href ||
    uploaded.file_url ||
    "";

  if (!rawUrl) {
    throw new Error(
      "Сервер не повернув адресу файлу"
    );
  }

  return new URL(
    rawUrl,
    window.location.origin
  ).toString();
}

function isClinicOwner() {
  const role =
    state.me?.role ||
    sessionStorage.getItem("pug_active_role") ||
    "staff";

  return role === "owner";
}

async function initSettingsUI() {
  const page = document.querySelector(
    '.page[data-page="settings"]'
  );

  if (!page) return;

  const ownerMode = isClinicOwner();

  page.innerHTML = `
    <div class="clinicSettingsPage">
      <section class="clinicSettingsHero">
        <div>
          <div class="clinicSettingsKicker">
            НАЛАШТУВАННЯ СИСТЕМИ
          </div>

          <h1>Налаштування</h1>

          <p>
            ${
              ownerMode
                ? "Керуйте брендингом клініки, документами та особистими налаштуваннями."
                : "Налаштуйте мову та зовнішній вигляд свого робочого простору."
            }
          </p>
        </div>

        <div class="clinicSettingsUser">
          <span>
            ${escapeHtml(
              state.me?.display_name ||
              sessionStorage.getItem("pug_active_display_name") ||
              "Користувач"
            )}
          </span>

          <strong>
            ${
              ownerMode
                ? "Власник клініки"
                : escapeHtml(
                    state.me?.role ||
                    sessionStorage.getItem("pug_active_role") ||
                    "Працівник"
                  )
            }
          </strong>
        </div>
      </section>

      ${
        ownerMode
          ? `
            <section
              class="clinicSettingsPanel clinicOwnerSettings"
              id="clinicOwnerSettings"
            >
              <div class="clinicSettingsPanelHead">
                <div>
                  <div class="clinicSettingsPanelIcon">🏥</div>

                  <div>
                    <h2>Моя клініка</h2>
                    <p>
                      Дані, які використовуються у виписках,
                      аналізах, рахунках та інших документах.
                    </p>
                  </div>
                </div>

                <span class="clinicOwnerBadge">
                  Тільки власник
                </span>
              </div>

              <div
                class="clinicSettingsLoading"
                id="clinicSettingsLoading"
              >
                Завантаження профілю клініки…
              </div>

              <div
                class="clinicSettingsContent"
                id="clinicSettingsContent"
                hidden
              ></div>
            </section>
          `
          : ""
      }

      <section class="clinicSettingsPanel">
        <div class="clinicSettingsPanelHead">
          <div>
            <div class="clinicSettingsPanelIcon">👤</div>

            <div>
              <h2>Особисті налаштування</h2>
              <p>
                Ці параметри застосовуються лише для вашого браузера.
              </p>
            </div>
          </div>
        </div>

        <div class="clinicPersonalGrid">
          <div class="clinicPersonalBlock">
            <h3>Мова інтерфейсу</h3>

            <select
              class="clinicSettingsInput"
              id="systemLanguageSelect"
            >
              <option value="uk">Українська</option>
              <option value="en">English</option>
              <option value="pl">Polski</option>
            </select>
          </div>

          <div class="clinicPersonalBlock">
            <h3>Тема системи</h3>

            <div class="clinicThemeGrid">
              ${[
                ["purple", "Фіолетова", "#9346E8"],
                ["black", "Чорна", "#24242A"],
                ["white", "Світла", "#F4F6FA"],
                ["blue", "Синя", "#1687FF"],
                ["green", "Зелена", "#10B981"],
              ]
                .map(
                  ([value, label, color]) => `
                    <button
                      class="clinicThemeChoice"
                      type="button"
                      data-theme-set="${escapeHtml(value)}"
                    >
                      <span style="background:${escapeHtml(color)}"></span>
                      <strong>${escapeHtml(label)}</strong>
                    </button>
                  `
                )
                .join("")}
            </div>
          </div>
        </div>

        <div class="clinicSettingsLogoutRow">
          <div>
            <strong>Поточний користувач</strong>
            <span>
              ${escapeHtml(
                state.me?.username ||
                sessionStorage.getItem("pug_active_username") ||
                "—"
              )}
            </span>
          </div>

          <button
            class="clinicLogoutButton"
            id="btnClinicLogout"
            type="button"
          >
            Вийти з акаунта
          </button>
        </div>
      </section>
    </div>
  `;

  bindPersonalSettingsUI(page);

  if (ownerMode) {
    const profile = await loadClinicProfileApi();
    renderClinicProfileSettings(page, profile);
  }
}
function bindPersonalSettingsUI(page) {
  const savedTheme = LS.get(
    "docpug_clinic_theme",
    "purple"
  );

  page
    .querySelectorAll("[data-theme-set]")
    .forEach((button) => {
      const theme = button.dataset.themeSet;

      button.classList.toggle(
        "active",
        theme === savedTheme
      );

      button.addEventListener("click", () => {
        document.body.dataset.theme = theme;

        LS.set(
          "docpug_clinic_theme",
          theme
        );

        page
          .querySelectorAll("[data-theme-set]")
          .forEach((item) => {
            item.classList.remove("active");
          });

        button.classList.add("active");
      });
    });

  const languageSelect =
    page.querySelector("#systemLanguageSelect");

  if (languageSelect) {
    languageSelect.value = LS.get(
      "docpug_clinic_lang",
      "uk"
    );

    languageSelect.addEventListener(
      "change",
      () => {
        LS.set(
          "docpug_clinic_lang",
          languageSelect.value
        );
      }
    );
  }

  page
    .querySelector("#btnClinicLogout")
    ?.addEventListener("click", () => {
      if (!confirm("Вийти з акаунта?")) return;

      [
        "pug_active_org_id",
        "pug_active_username",
        "pug_active_display_name",
        "pug_active_role",
        "pug_active_clinic_name",
      ].forEach((key) => {
        sessionStorage.removeItem(key);
      });

      state.me = null;
      state.clinicProfile = null;

      window.location.reload();
    });
}

function renderClinicProfileSettings(page, profile) {
  const loading =
    page.querySelector("#clinicSettingsLoading");

  const root =
    page.querySelector("#clinicSettingsContent");

  if (!root) return;

  if (loading) {
    loading.remove();
  }

  root.hidden = false;

  const clinic = {
    ...DEFAULT_CLINIC_PROFILE,
    ...(profile || {}),
  };

  root.innerHTML = `
    <div class="clinicProfileLayout">
      <form
        class="clinicProfileForm"
        id="clinicProfileForm"
      >
        <div class="clinicSettingsFormGrid">
          <label class="clinicSettingsField">
            <span>Назва клініки *</span>

            <input
              class="clinicSettingsInput"
              id="clinicProfileName"
              type="text"
              maxlength="120"
              required
              value="${escapeHtml(clinic.name || "")}"
              placeholder="Наприклад: Animal Clinic"
            >
          </label>

          <label class="clinicSettingsField">
            <span>Підпис під назвою</span>

            <input
              class="clinicSettingsInput"
              id="clinicProfileSubtitle"
              type="text"
              maxlength="160"
              value="${escapeHtml(
                clinic.subtitle || ""
              )}"
              placeholder="Ветеринарна клініка"
            >
          </label>

          <label class="clinicSettingsField">
            <span>Телефон</span>

            <input
              class="clinicSettingsInput"
              id="clinicProfilePhone"
              type="tel"
              maxlength="80"
              value="${escapeHtml(clinic.phone || "")}"
              placeholder="+380..."
            >
          </label>

          <label class="clinicSettingsField">
            <span>Сайт або Instagram</span>

            <input
              class="clinicSettingsInput"
              id="clinicProfileWebsite"
              type="text"
              maxlength="200"
              value="${escapeHtml(
                clinic.website || ""
              )}"
              placeholder="instagram.com/clinic"
            >
          </label>

          <label class="clinicSettingsField clinicSettingsFieldWide">
            <span>Адреса</span>

            <input
              class="clinicSettingsInput"
              id="clinicProfileAddress"
              type="text"
              maxlength="250"
              value="${escapeHtml(
                clinic.address || ""
              )}"
              placeholder="Місто, вулиця, номер будинку"
            >
          </label>

          <label class="clinicSettingsField">
            <span>Акцентний колір документів</span>

            <div class="clinicColorField">
              <input
                id="clinicProfileAccentColor"
                type="color"
                value="${escapeHtml(
                  clinic.document_accent_color ||
                  "#9346E8"
                )}"
              >

              <input
                class="clinicSettingsInput"
                id="clinicProfileAccentText"
                type="text"
                maxlength="7"
                value="${escapeHtml(
                  clinic.document_accent_color ||
                  "#9346E8"
                )}"
              >
            </div>
          </label>

          <label class="clinicSettingsField">
            <span>Підпис у нижній частині документа</span>

            <input
              class="clinicSettingsInput"
              id="clinicProfileFooter"
              type="text"
              maxlength="200"
              value="${escapeHtml(
                clinic.document_footer || ""
              )}"
              placeholder="Коли важливо — ми поруч."
            >
          </label>
        </div>

        <div class="clinicBrandUploads">
          ${renderClinicBrandUpload({
            type: "logo",
            title: "Логотип клініки",
            description:
              "Використовується у виписках, аналізах та рахунках.",
            value: clinic.logo_url,
            accept:
              "image/png,image/jpeg,image/webp",
          })}

          ${renderClinicBrandUpload({
            type: "signature",
            title: "Підпис лікаря",
            description:
              "Бажано PNG з прозорим фоном.",
            value: clinic.doctor_signature_url,
            accept:
              "image/png,image/jpeg,image/webp",
          })}

          ${renderClinicBrandUpload({
            type: "stamp",
            title: "Печатка клініки",
            description:
              "Бажано PNG з прозорим фоном.",
            value: clinic.clinic_stamp_url,
            accept:
              "image/png,image/jpeg,image/webp",
          })}
        </div>

        <div class="clinicProfileActions">
          <div
            class="clinicProfileSaveStatus"
            id="clinicProfileSaveStatus"
          ></div>

          <button
            class="clinicProfileSaveButton"
            id="btnSaveClinicProfile"
            type="submit"
          >
            Зберегти зміни
          </button>
        </div>
      </form>

      <aside class="clinicDocumentPreview">
        <div class="clinicPreviewKicker">
          ПРЕДПЕРЕГЛЯД ДОКУМЕНТА
        </div>

        <div
          class="clinicPreviewPaper"
          id="clinicPreviewPaper"
        ></div>
      </aside>
    </div>
  `;

  bindClinicProfileSettings(page, clinic);
  updateClinicDocumentPreview(page);
}

function renderClinicBrandUpload({
  type,
  title,
  description,
  value,
  accept,
}) {
  return `
    <div
      class="clinicBrandUpload"
      data-brand-upload="${escapeHtml(type)}"
    >
      <div
        class="clinicBrandPreview"
        data-brand-preview="${escapeHtml(type)}"
      >
        ${
          value
            ? `
              <img
                src="${escapeHtml(value)}"
                alt="${escapeHtml(title)}"
              >
            `
            : `
              <span>＋</span>
            `
        }
      </div>

      <div class="clinicBrandUploadText">
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(description)}</p>

        <div class="clinicBrandUploadActions">
          <label class="clinicBrandUploadButton">
            Завантажити

            <input
              type="file"
              hidden
              accept="${escapeHtml(accept)}"
              data-brand-file="${escapeHtml(type)}"
            >
          </label>

          <button
            class="clinicBrandRemoveButton"
            type="button"
            data-brand-remove="${escapeHtml(type)}"
          >
            Видалити
          </button>
        </div>
      </div>

      <input
        type="hidden"
        data-brand-url="${escapeHtml(type)}"
        value="${escapeHtml(value || "")}"
      >
    </div>
  `;
}

function bindClinicProfileSettings(page, clinic) {
  const form =
    page.querySelector("#clinicProfileForm");

  if (!form) return;

  const colorPicker =
    page.querySelector(
      "#clinicProfileAccentColor"
    );

  const colorText =
    page.querySelector(
      "#clinicProfileAccentText"
    );

  colorPicker?.addEventListener("input", () => {
    if (colorText) {
      colorText.value =
        colorPicker.value.toUpperCase();
    }

    updateClinicDocumentPreview(page);
  });

  colorText?.addEventListener("input", () => {
    const value =
      String(colorText.value || "")
        .trim()
        .toUpperCase();

    if (/^#[0-9A-F]{6}$/.test(value)) {
      if (colorPicker) {
        colorPicker.value = value;
      }

      updateClinicDocumentPreview(page);
    }
  });

  form
    .querySelectorAll(
      "input:not([type='file']):not([type='hidden'])"
    )
    .forEach((input) => {
      input.addEventListener(
        "input",
        () => updateClinicDocumentPreview(page)
      );
    });

  form
    .querySelectorAll("[data-brand-file]")
    .forEach((input) => {
      input.addEventListener(
        "change",
        async () => {
          const type =
            input.dataset.brandFile;

          const file =
            input.files?.[0];

          if (!type || !file) return;

          const uploadBlock =
            input.closest(".clinicBrandUpload");

          uploadBlock?.classList.add(
            "uploading"
          );

          try {
            const url =
              await uploadClinicBrandFile(file);

            const hidden =
              page.querySelector(
                `[data-brand-url="${type}"]`
              );

            if (hidden) {
              hidden.value = url;
            }

            const preview =
              page.querySelector(
                `[data-brand-preview="${type}"]`
              );

            if (preview) {
              preview.innerHTML = `
                <img
                  src="${escapeHtml(url)}"
                  alt=""
                >
              `;
            }

            updateClinicDocumentPreview(page);
          } catch (error) {
            alert(
              "Не вдалося завантажити файл: " +
              (error?.message || error)
            );
          } finally {
            uploadBlock?.classList.remove(
              "uploading"
            );

            input.value = "";
          }
        }
      );
    });

  form
    .querySelectorAll("[data-brand-remove]")
    .forEach((button) => {
      button.addEventListener(
        "click",
        () => {
          const type =
            button.dataset.brandRemove;

          const hidden =
            page.querySelector(
              `[data-brand-url="${type}"]`
            );

          if (hidden) {
            hidden.value = "";
          }

          const preview =
            page.querySelector(
              `[data-brand-preview="${type}"]`
            );

          if (preview) {
            preview.innerHTML = "<span>＋</span>";
          }

          updateClinicDocumentPreview(page);
        }
      );
    });

  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const saveButton =
        page.querySelector(
          "#btnSaveClinicProfile"
        );

      const status =
        page.querySelector(
          "#clinicProfileSaveStatus"
        );

      const payload = {
        name:
          page
            .querySelector("#clinicProfileName")
            ?.value?.trim() || "",

        subtitle:
          page
            .querySelector(
              "#clinicProfileSubtitle"
            )
            ?.value?.trim() || "",

        phone:
          page
            .querySelector(
              "#clinicProfilePhone"
            )
            ?.value?.trim() || "",

        address:
          page
            .querySelector(
              "#clinicProfileAddress"
            )
            ?.value?.trim() || "",

        website:
          page
            .querySelector(
              "#clinicProfileWebsite"
            )
            ?.value?.trim() || "",

        document_accent_color:
          page
            .querySelector(
              "#clinicProfileAccentText"
            )
            ?.value?.trim()
            .toUpperCase() || "#9346E8",

        document_footer:
          page
            .querySelector(
              "#clinicProfileFooter"
            )
            ?.value?.trim() || "",

        logo_url:
          page
            .querySelector(
              '[data-brand-url="logo"]'
            )
            ?.value || "",

        doctor_signature_url:
          page
            .querySelector(
              '[data-brand-url="signature"]'
            )
            ?.value || "",

        clinic_stamp_url:
          page
            .querySelector(
              '[data-brand-url="stamp"]'
            )
            ?.value || "",
      };

      if (!payload.name) {
        alert("Вкажіть назву клініки.");
        return;
      }

      saveButton.disabled = true;
      saveButton.textContent = "Збереження…";

      if (status) {
        status.textContent = "";
        status.className =
          "clinicProfileSaveStatus";
      }

      const saved =
        await saveClinicProfileApi(payload);

      saveButton.disabled = false;
      saveButton.textContent =
        "Зберегти зміни";

      if (!saved) return;

      if (status) {
        status.textContent =
          "Зміни успішно збережені";

        status.classList.add("success");
      }

      const clinicTitle =
        document.getElementById(
          "clinicNameTitle"
        ) ||
        document.querySelector(
          ".clinic-title"
        );

      if (clinicTitle) {
        clinicTitle.textContent =
          saved.name;
      }

      updateClinicDocumentPreview(page);
    }
  );
}

function updateClinicDocumentPreview(page) {
  const preview =
    page.querySelector("#clinicPreviewPaper");

  if (!preview) return;

  const name =
    page
      .querySelector("#clinicProfileName")
      ?.value?.trim() ||
    "Ветеринарна клініка";

  const subtitle =
    page
      .querySelector("#clinicProfileSubtitle")
      ?.value?.trim() ||
    "Ветеринарна клініка";

  const phone =
    page
      .querySelector("#clinicProfilePhone")
      ?.value?.trim() || "";

  const address =
    page
      .querySelector("#clinicProfileAddress")
      ?.value?.trim() || "";

  const website =
    page
      .querySelector("#clinicProfileWebsite")
      ?.value?.trim() || "";

  const color =
    page
      .querySelector("#clinicProfileAccentText")
      ?.value?.trim() ||
    "#9346E8";

  const footer =
    page
      .querySelector("#clinicProfileFooter")
      ?.value?.trim() || "";

  const logo =
    page
      .querySelector('[data-brand-url="logo"]')
      ?.value || "";

  const signature =
    page
      .querySelector(
        '[data-brand-url="signature"]'
      )
      ?.value || "";

  const stamp =
    page
      .querySelector(
        '[data-brand-url="stamp"]'
      )
      ?.value || "";

  preview.style.setProperty(
    "--document-accent",
    color
  );

  preview.innerHTML = `
    <div class="clinicPreviewHeader">
      <div class="clinicPreviewBrand">
        ${
          logo
            ? `
              <img
                src="${escapeHtml(logo)}"
                alt=""
              >
            `
            : `
              <div class="clinicPreviewLogoFallback">
                ${escapeHtml(
                  name.charAt(0).toUpperCase()
                )}
              </div>
            `
        }

        <div>
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(subtitle)}</span>
        </div>
      </div>

      <div class="clinicPreviewDocTitle">
        Результати дослідження
      </div>
    </div>

    <div class="clinicPreviewLine"></div>

    <div class="clinicPreviewContacts">
      ${phone ? `<span>${escapeHtml(phone)}</span>` : ""}
      ${address ? `<span>${escapeHtml(address)}</span>` : ""}
      ${website ? `<span>${escapeHtml(website)}</span>` : ""}
    </div>

    <div class="clinicPreviewPatient">
      <div>
        <span>Пацієнт</span>
        <strong>Мойша</strong>
      </div>

      <div>
        <span>Дата</span>
        <strong>${escapeHtml(todayISO())}</strong>
      </div>
    </div>

    <div class="clinicPreviewTable">
      <div class="head">
        <span>Показник</span>
        <span>Результат</span>
        <span>Статус</span>
      </div>

      <div>
        <span>Глюкоза</span>
        <strong>5.2 ммоль/л</strong>
        <b>Норма</b>
      </div>

      <div>
        <span>Креатинін</span>
        <strong>132 мкмоль/л</strong>
        <b class="high">Вище</b>
      </div>
    </div>

    <div class="clinicPreviewSignatures">
      <div>
        ${
          signature
            ? `<img src="${escapeHtml(signature)}" alt="">`
            : `<span>Підпис лікаря</span>`
        }
      </div>

      <div>
        ${
          stamp
            ? `<img src="${escapeHtml(stamp)}" alt="">`
            : `<span>Печатка</span>`
        }
      </div>
    </div>

    <div class="clinicPreviewFooter">
      <span>${escapeHtml(footer)}</span>
      <small>Powered by Doc.PUG CRM</small>
    </div>
  `;
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
const cachedUsername = sessionStorage.getItem("pug_active_username");
const cachedDisplayName = sessionStorage.getItem(
  "pug_active_display_name"
);
const cachedRole = sessionStorage.getItem("pug_active_role");
const cachedClinicName = sessionStorage.getItem(
  "pug_active_clinic_name"
);

if (cachedOrg && cachedUsername) {
  state.me = {
    org_id: cachedOrg,
    username: cachedUsername,
    display_name: cachedDisplayName || cachedUsername,
    role: cachedRole || "staff",
    clinic_name: cachedClinicName || "Клініка",
  };

  if (authOverlay) {
    authOverlay.style.display = "none";
  }
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

        // Сохраняем данные активного пользователя и клиники
sessionStorage.setItem(
  "pug_active_org_id",
  String(json.data.org_id || "")
);

sessionStorage.setItem(
  "pug_active_username",
  String(json.data.username || username || "")
);

sessionStorage.setItem(
  "pug_active_display_name",
  String(
    json.data.display_name ||
    json.data.username ||
    username ||
    "Користувач"
  )
);

sessionStorage.setItem(
  "pug_active_role",
  String(json.data.role || "staff")
);

sessionStorage.setItem(
  "pug_active_clinic_name",
  String(json.data.clinic_name || "Клініка")
);

state.me = {
  org_id: json.data.org_id,
  username: json.data.username || username,
  display_name:
    json.data.display_name ||
    json.data.username ||
    username ||
    "Користувач",
  role: json.data.role || "staff",
  clinic_name: json.data.clinic_name || "Клініка",
};

console.log(
  "Успішний вхід:",
  state.me.display_name,
  state.me.role,
  state.me.clinic_name
);

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

  // Календарь всегда создаёт новый визит без заранее выбранного пациента
  state.selectedPet = null;
  state.selectedPetId = null;

  modal.dataset.openSource = "calendar";
  modal.dataset.patientId = "";

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

const visitModalSub = $("#visitModalSub");

if (visitModalSub) {
  visitModalSub.textContent = "Оберіть пацієнта";
}

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
  document.body.classList.add("medcardModalIsOpen");
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

state.selectedPet =
  patient || null;

state.selectedPetId =
  patient?.id || null;

$("#visitPatientSearch").value =
  patient
    ? `${patient.name || "Пацієнт"} · ${patient.owner_name || ""}`
    : id;

const modalSub =
  $("#visitModalSub");

if (modalSub) {
  modalSub.textContent =
    patient
      ? `Пацієнт: ${patient.name || "—"}`
      : "Оберіть пацієнта";
}

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
    const headers = {};

    const orgId = LS?.get?.("docpug_org_id");
    if (orgId) headers["X-Org-ID"] = orgId;

    const res = await fetch(
      `/api/staff-schedule-range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers }
    );

    const json = await res.json();

    if (!json.ok) {
      throw new Error(json.error || "range load failed");
    }

    return json.data || [];
  } catch (e) {
    console.error("loadStaffScheduleRangeApi failed:", e);
    return [];
  }
}
async function loadStaffRatingApi() {
  try {
    const res = await fetch("/api/staff/rating");
    const json = await res.json();

    if (!json.ok) {
      console.warn("Rating load error:", json.error);
      return { season_key: "—", rows: [] };
    }

    return json.data || { season_key: "—", rows: [] };
  } catch (e) {
    console.error(e);
    return { season_key: "—", rows: [] };
  }
}
document.addEventListener("click", async (e) => {
  const openBtn = e.target.closest("#btnCreatePatientFromVisit");
  const cancelBtn = e.target.closest("#visitNewPatientCancel");
  const createBtn = e.target.closest("#visitNewPatientCreate");

  if (!openBtn && !cancelBtn && !createBtn) return;

  e.preventDefault();

  const box = document.querySelector("#visitNewPatientBox");

  if (!box) return alert("Блок швидкого створення пацієнта не знайдено");

  if (openBtn) {
    box.style.display = "block";

    const select = document.querySelector("#visitPatientSelect");
    const search = document.querySelector("#visitPatientSearch");
    const results = document.querySelector("#visitPatientResults");

    if (select) select.value = "";
    if (search) search.value = "";
    if (results) results.innerHTML = "";

    state.selectedPet = null;
    state.selectedPetId = null;

    document.querySelector("#visitNewOwnerName")?.focus();
    return;
  }

  if (cancelBtn) {
    box.style.display = "none";
    return;
  }

  if (createBtn) {
    const ownerName = (document.querySelector("#visitNewOwnerName")?.value || "").trim();
    const ownerPhone = (document.querySelector("#visitNewOwnerPhone")?.value || "").trim();
    const ownerNote = (document.querySelector("#visitNewOwnerNote")?.value || "").trim();

    const petName = (document.querySelector("#visitNewPetName")?.value || "").trim();
    const species = (document.querySelector("#visitNewPetSpecies")?.value || "").trim();
    const breed = (document.querySelector("#visitNewPetBreed")?.value || "").trim();
    const age = (document.querySelector("#visitNewPetAge")?.value || "").trim();
    const weight = (document.querySelector("#visitNewPetWeight")?.value || "").trim();

    if (!ownerName) return alert("Вкажи ПІБ власника");
    if (!ownerPhone) return alert("Вкажи телефон власника");
    if (!petName) return alert("Вкажи кличку пацієнта");
    if (!species) return alert("Оберіть вид пацієнта");

    const oldText = createBtn.textContent;
    createBtn.disabled = true;
    createBtn.textContent = "Створюємо...";

    try {
      const owner = await createOwner(ownerName, ownerPhone, ownerNote);
      if (!owner?.id) throw new Error("Не вдалося створити власника");

      const pet = await createPatientApi({
  owner_id: owner.id,
  ownerId: owner.id,
  owner: owner.id,

  name: petName,
  species,
  breed,
  age,
  weight_kg: weight,
  notes: "",
});

      if (!pet?.id) throw new Error("Не вдалося створити пацієнта");

      state.selectedPet = pet;
      state.selectedPetId = pet.id;

      const hidden = document.querySelector("#visitPatientSelect");
      const search = document.querySelector("#visitPatientSearch");
      const sub = document.querySelector("#visitModalSub");

      if (hidden) hidden.value = pet.id;
      if (search) search.value = `${pet.name} — ${owner.name}`;
      if (sub) sub.textContent = `Пацієнт: ${pet.name}`;

      window.__visitPatientList = await loadPatientsApi();

      box.style.display = "none";

      alert(`Пацієнта ${pet.name} створено і обрано для візиту`);
    } catch (err) {
      console.error(err);
      alert("Помилка створення пацієнта: " + (err?.message || err));
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = oldText;
    }
  }
});
function openOwnerModal(owner = null) {
  const modal = $("#ownerModal");
  if (!modal) return alert("Не знайдено #ownerModal");

  const isEdit = !!owner?.id;

  $("#ownerModalId").value = isEdit ? owner.id : "";
  $("#ownerModalName").value = owner?.name || "";
  $("#ownerModalPhone").value = owner?.phone || "";
  $("#ownerModalNote").value = owner?.note || "";

  $("#ownerModalTitle").textContent = isEdit ? "Редагування власника" : "Новий власник";
  $("#ownerModalSub").textContent = isEdit
    ? "Оновлення контактних даних власника"
    : "Створення картки власника тварини";

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  modal.style.display = "flex";

  setTimeout(() => $("#ownerModalName")?.focus(), 50);
}

function closeOwnerModal() {
  const modal = $("#ownerModal");
  if (!modal) return;

  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  modal.style.display = "none";
}

$("#ownerModalClose")?.addEventListener("click", closeOwnerModal);
$("#ownerModalCancel")?.addEventListener("click", closeOwnerModal);

$("#ownerModalSave")?.addEventListener("click", async () => {
  const id = ($("#ownerModalId")?.value || "").trim();
  const name = ($("#ownerModalName")?.value || "").trim();
  const phone = ($("#ownerModalPhone")?.value || "").trim();
  const note = ($("#ownerModalNote")?.value || "").trim();

  if (!name) return alert("Вкажи ПІБ власника");

  const btn = $("#ownerModalSave");
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = id ? "Оновлюємо..." : "Створюємо...";

  try {
    let saved = null;

    if (id) {
      saved = await updateOwner(id, { name, phone, note });
    } else {
      saved = await createOwner(name, phone, note);
    }

    if (!saved) return;

    closeOwnerModal();
    await loadOwners();

    if (id && state.selectedOwnerId && String(state.selectedOwnerId) === String(id)) {
      renderOwnerPage(id);
    }
  } catch (e) {
    console.error(e);
    alert("Помилка збереження власника: " + (e?.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});
document.addEventListener("click", async (e) => {
  const cancelBtn = e.target.closest("#deleteCancel");
  const confirmBtn = e.target.closest("#deleteConfirm");

  if (!cancelBtn && !confirmBtn) return;

  e.preventDefault();
  e.stopPropagation();

  if (cancelBtn) {
    closeDeleteModal();
    return;
  }

  if (confirmBtn) {
    if (typeof deleteCallback === "function") {
      await deleteCallback();
    }

    closeDeleteModal();
  }
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("#btnBackPatient");
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();

  const ownerId =
    state.selectedPet?.owner_id ||
    state.selectedOwnerId;

  if (!ownerId) {
    console.warn("Не вдалося визначити власника пацієнта.");
    setHash("patients");
    return;
  }

  openOwner(String(ownerId));
});