import os
import uuid
import hmac
import hashlib
import json
import mimetypes
from urllib.parse import parse_qsl

from flask import Flask, request, send_from_directory, jsonify
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge

from supabase import create_client

print("### RUNNING server.py ###")

# =========================
# ENV
# =========================
ORG_ID = os.getenv("ORG_ID")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

if not ORG_ID or not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError("Missing ENV vars: ORG_ID / SUPABASE_URL / SUPABASE_SERVICE_KEY")

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# =========================
# APP
# =========================
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25MB
app.config["PREFERRED_URL_SCHEME"] = "https"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXT = {"pdf", "png", "jpg", "jpeg", "webp", "gif", "heic", "dcm"}

# =========================
# HELPERS
# =========================
def ok(data=None):
    return jsonify({"ok": True, "data": data})

def fail(error, code=400):
    return jsonify({"ok": False, "error": error}), code

def clean_payload(d):
    """
    Удаляем пустые строки и None.
    Поддерживает dict и list[dict] (для batch insert/update).
    """
    if d is None:
        return d

    # list[dict]
    if isinstance(d, list):
        out_list = []
        for item in d:
            if isinstance(item, dict):
                out = {}
                for k, v in item.items():
                    if v is None:
                        continue
                    if isinstance(v, str) and v.strip() == "":
                        continue
                    out[k] = v
                out_list.append(out)
            else:
                out_list.append(item)
        return out_list

    # dict
    if isinstance(d, dict):
        out = {}
        for k, v in d.items():
            if v is None:
                continue
            if isinstance(v, str) and v.strip() == "":
                continue
            out[k] = v
        return out

    return d


def allowed_file(filename: str) -> bool:
    if not filename:
        return True  # ✅ разрешаем файлы без имени (Android / Telegram)

    if "." not in filename:
        return True  # ✅ разрешаем без расширения

    ext = filename.rsplit(".", 1)[1].lower()
    return ext in ALLOWED_EXT


def insert_with_optional_fallback(table: str, payload, optional_fields=None):
    """
    Иногда PostgREST/Supabase кидает PGRST204 если колонки нет.
    Тогда вставляем без optional полей.
    payload может быть dict или list[dict].
    """
    optional_fields = optional_fields or []
    payload = clean_payload(payload)

    try:
        return supabase.table(table).insert(payload).execute()
    except Exception as e:
        msg = str(e)
        if "PGRST204" in msg:
            # dict payload
            if isinstance(payload, dict):
                fallback = {k: v for k, v in payload.items() if k not in optional_fields}
                return supabase.table(table).insert(fallback).execute()

            # list[dict] payload
            if isinstance(payload, list):
                fallback_list = []
                for row in payload:
                    if isinstance(row, dict):
                        fallback_list.append({k: v for k, v in row.items() if k not in optional_fields})
                    else:
                        fallback_list.append(row)
                return supabase.table(table).insert(fallback_list).execute()

        raise
    
def update_with_optional_fallback(table: str, row_id: str, payload: dict, optional_fields=None):
    optional_fields = optional_fields or []
    payload = clean_payload(payload)

    if not payload:
        return None

    try:
        return supabase.table(table).update(payload).eq("org_id", ORG_ID).eq("id", row_id).execute()
    except Exception as e:
        msg = str(e)
        if "PGRST204" in msg:
            fallback = {k: v for k, v in payload.items() if k not in optional_fields}
            return supabase.table(table).update(fallback).eq("org_id", ORG_ID).eq("id", row_id).execute()
        raise

def safe_int(x, default=0):
    try:
        return int(x)
    except Exception:
        return default

def file_url(stored_name: str) -> str:
    return f"/uploads/{stored_name}"

def _as_list(x):
    if x is None:
        return []
    if isinstance(x, list):
        return x
    # если вдруг пришел один объект — оборачиваем в список
    if isinstance(x, dict):
        return [x]
    # всё остальное считаем мусором
    return []

def normalize_visit_row(r: dict) -> dict:
    """
    Ключевая штука:
    фронт ожидает services[] и stock[].
    В БД это может быть services/stock или services_json/stock_json.
    """
    r = r or {}

    # services
    services = r.get("services")
    if services is None:
        services = r.get("services_json")
    r["services"] = _as_list(services) or []

    # stock
    stock = r.get("stock")
    if stock is None:
        stock = r.get("stock_json")
    r["stock"] = _as_list(stock) or []

    return r

def _pick_services_from_payload(d: dict):
    return d.get("services") or d.get("services_json") or []

def _pick_stock_from_payload(d: dict):
    return d.get("stock") or d.get("stock_json") or []

def load_visit_lines(visit_ids):
    services_by_visit = {vid: [] for vid in visit_ids}
    stock_by_visit = {vid: [] for vid in visit_ids}

    if not visit_ids:
        return services_by_visit, stock_by_visit

    # =====================
    # services
    # =====================
    try:
        q = supabase.table("visit_services").select("*").in_("visit_id", visit_ids)

        # пробуем с org_id, если колонки нет — упадет и мы повторим без org_id
        try:
            q = q.eq("org_id", ORG_ID)
            res = q.execute()
        except Exception:
            res = supabase.table("visit_services").select("*").in_("visit_id", visit_ids).execute()

        for r in (res.data or []):
            vid = r.get("visit_id")
            if not vid:
                continue
            services_by_visit.setdefault(vid, []).append({
                "serviceId": r.get("service_id") or r.get("serviceId"),
                "qty": r.get("qty") or 1,
                "priceSnap": r.get("price_snap") or r.get("priceSnap"),
                "nameSnap": r.get("name_snap") or r.get("nameSnap"),
            })
    except Exception:
        pass

    # =====================
    # stock
    # =====================
    try:
        q = supabase.table("visit_stock").select("*").in_("visit_id", visit_ids)

        try:
            q = q.eq("org_id", ORG_ID)
            res = q.execute()
        except Exception:
            res = supabase.table("visit_stock").select("*").in_("visit_id", visit_ids).execute()

        for r in (res.data or []):
            vid = r.get("visit_id")
            if not vid:
                continue
            stock_by_visit.setdefault(vid, []).append({
                "stockId": r.get("stock_id") or r.get("stockId"),
                "qty": r.get("qty") or 1,
                "priceSnap": r.get("price_snap") or r.get("priceSnap"),
                "nameSnap": r.get("name_snap") or r.get("nameSnap"),
            })
    except Exception:
        pass

    return services_by_visit, stock_by_visit


def save_visit_lines(visit_id: str, d: dict):
    services = _pick_services_from_payload(d)
    stock = _pick_stock_from_payload(d)

    # =====================
    # delete old services
    # =====================
    try:
        supabase.table("visit_services").delete() \
            .eq("org_id", ORG_ID) \
            .eq("visit_id", visit_id) \
            .execute()
    except Exception:
        supabase.table("visit_services").delete() \
            .eq("visit_id", visit_id) \
            .execute()

    # =====================
    # delete old stock
    # =====================
    try:
        supabase.table("visit_stock").delete() \
            .eq("org_id", ORG_ID) \
            .eq("visit_id", visit_id) \
            .execute()
    except Exception:
        supabase.table("visit_stock").delete() \
            .eq("visit_id", visit_id) \
            .execute()

    # =====================
    # insert new services WITH SNAPSHOT (FROM PAYLOAD)
    # =====================
    if isinstance(services, list) and services:
        rows = []

        for x in services:
            service_id = x.get("serviceId") or x.get("service_id")
            qty = x.get("qty") or 1

            # ✅ берём снапшот из того, что прислал фронт
            # поддержим оба варианта ключей
            snap_price = x.get("priceSnap")
            if snap_price is None:
                snap_price = x.get("price_snap")

            snap_name = x.get("nameSnap")
            if snap_name is None:
                snap_name = x.get("name_snap")

            rows.append({
                "org_id": ORG_ID,          # станет optional (если колонки нет — вырежется)
                "visit_id": visit_id,
                "service_id": service_id,  # важно: это строка svc_... и это ОК
                "qty": qty,
                "price_snap": snap_price,  # важно: теперь не 0, если фронт прислал
                "name_snap": snap_name,
            })

        insert_with_optional_fallback(
            "visit_services",
            rows,
            optional_fields=["org_id", "price_snap", "name_snap"]
        )

    # (stock часть у тебя ниже — оставь как есть)

    # =====================
    # insert new stock
    # =====================
    if isinstance(stock, list) and stock:
        rows = []

        for x in stock:
            rows.append({
                "org_id": ORG_ID,
                "visit_id": visit_id,
                "stock_id": x.get("stockId") or x.get("stock_id"),
                "qty": x.get("qty") or 1,
                "price_snap": x.get("priceSnap"),
                "name_snap": x.get("nameSnap"),
            })

        insert_with_optional_fallback(
            "visit_stock",
            rows,
            optional_fields=["org_id", "price_snap", "name_snap"]
        )



# =========================
# TELEGRAM AUTH (optional)
# =========================
def verify_tg_init_data(init_data: str):
    if not init_data or not TELEGRAM_BOT_TOKEN:
        return None

    data = dict(parse_qsl(init_data))
    hash_recv = data.pop("hash", None)
    if not hash_recv:
        return None

    check_str = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))

    secret = hmac.new(
        b"WebAppData",
        TELEGRAM_BOT_TOKEN.encode(),
        hashlib.sha256
    ).digest()

    hash_calc = hmac.new(secret, check_str.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(hash_calc, hash_recv):
        return None

    try:
        return json.loads(data.get("user", "{}"))
    except Exception:
        return None

# =========================
# ERRORS
# =========================
@app.errorhandler(RequestEntityTooLarge)
def too_large(e):
    return fail("Max 25MB", 413)

# =========================
# STATIC
# =========================
@app.get("/")
def root():
    return send_from_directory(BASE_DIR, "index.html")

@app.get("/uploads/<path:f>")
def uploads(f):
    return send_from_directory(UPLOAD_DIR, f)

@app.get("/<path:path>")
def static_any(path):
    if path.startswith("api/") or path.startswith("uploads/"):
        return fail("Not found", 404)
    return send_from_directory(BASE_DIR, path)

# =========================
# API: ME
# =========================
@app.get("/api/me")
def api_me():
    init_data = (
        request.headers.get("X-Tg-Init-Data")
        or request.args.get("initData")
        or ""
    )

    user = verify_tg_init_data(init_data)
    if not user:
        return jsonify({"me": {"name": "Guest", "mode": "browser"}})

    return jsonify({
        "me": {
            "name": user.get("first_name"),
            "tg_user_id": str(user.get("id")),
            "username": user.get("username"),
            "mode": "telegram",
        }
    })
# =========================
# SERVICES API
# =========================

@app.get("/api/services")
def api_services_list():
    try:
        res = (
            supabase.table("services")
            .select("id, name, price, active")
            .eq("org_id", ORG_ID)
            .order("name")
            .execute()
        )
        return jsonify({"ok": True, "data": res.data or []})
    except Exception as e:
        print("❌ /api/services GET error:", repr(e))
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/services")
def api_services_create():
    """Create service. Payload is read from request.json (Flask does NOT pass args here)."""
    try:
        payload = request.get_json(silent=True) or {}

        name = (payload.get("name") or "").strip()
        price = payload.get("price") or 0
        active = payload.get("active", True)

        if not name:
            return jsonify({"ok": False, "error": "name required"}), 400

        res = (
            supabase.table("services")
            .insert({
                "org_id": ORG_ID,
                "name": name,
                "price": price,
                "active": bool(active),
            })
            .execute()
        )
        return jsonify({"ok": True, "data": res.data or []})
    except Exception as e:
        print("❌ /api/services POST error:", repr(e))
        return jsonify({"ok": False, "error": str(e)}), 500


@app.put("/api/services")
def api_services_update():
    """Update service.
    Supports:
      - /api/services?id=...  (query)
      - or payload {id: ...}
    """
    try:
        payload = request.get_json(silent=True) or {}
        svc_id = (request.args.get("id") or payload.get("id") or "").strip()
        if not svc_id:
            return jsonify({"ok": False, "error": "id required"}), 400

        patch = {}
        if "name" in payload:
            patch["name"] = (payload.get("name") or "").strip()
        if "price" in payload:
            patch["price"] = payload.get("price") or 0
        if "active" in payload:
            patch["active"] = bool(payload.get("active"))

        if not patch:
            return jsonify({"ok": False, "error": "nothing to update"}), 400

        res = (
            supabase.table("services")
            .update(patch)
            .eq("org_id", ORG_ID)
            .eq("id", svc_id)
            .execute()
        )
        return jsonify({"ok": True, "data": res.data or []})
    except Exception as e:
        print("❌ /api/services PUT error:", repr(e))
        return jsonify({"ok": False, "error": str(e)}), 500


@app.delete("/api/services")
def api_services_delete():
    """Delete service.
    Supports:
      - /api/services?id=... (query)
      - or payload {id: ...}
    """
    try:
        payload = request.get_json(silent=True) or {}
        svc_id = (request.args.get("id") or payload.get("id") or "").strip()
        if not svc_id:
            return jsonify({"ok": False, "error": "id required"}), 400

        (
            supabase.table("services")
            .delete()
            .eq("org_id", ORG_ID)
            .eq("id", svc_id)
            .execute()
        )
        return jsonify({"ok": True, "data": True})
    except Exception as e:
        print("❌ /api/services DELETE error:", repr(e))
        return jsonify({"ok": False, "error": str(e)}), 500
# =========================
# API: OWNERS
# =========================
@app.get("/api/owners")
def api_get_owners():
    res = supabase.table("owners").select("*").eq("org_id", ORG_ID).execute()
    return ok(res.data or [])

@app.post("/api/owners")
def api_create_owner():
    d = request.get_json(silent=True) or {}
    name = (d.get("name") or "").strip()
    if not name:
        return fail("name required", 400)

    payload = {
        "org_id": ORG_ID,
        "name": name,
        "phone": d.get("phone"),
        "note": d.get("note"),
    }

    res = insert_with_optional_fallback("owners", payload, optional_fields=["note"])
    row = (res.data[0] if getattr(res, "data", None) else None) or payload
    return ok(row)

@app.delete("/api/owners/<owner_id>")
def api_delete_owner(owner_id):
    if not owner_id:
        return fail("owner_id required", 400)
    supabase.table("owners").delete().eq("org_id", ORG_ID).eq("id", owner_id).execute()
    return ok(True)

# =========================
# API: PATIENTS
# =========================
@app.get("/api/patients")
def api_get_patients():
    owner_id = request.args.get("owner_id")
    q = supabase.table("patients").select("*").eq("org_id", ORG_ID)
    if owner_id:
        q = q.eq("owner_id", owner_id)
    res = q.execute()
    return ok(res.data or [])

@app.post("/api/patients")
def api_create_patient():
    d = request.get_json(silent=True) or {}

    owner_id = (d.get("owner_id") or "").strip()
    name = (d.get("name") or "").strip()
    if not owner_id or not name:
        return fail("owner_id & name required", 400)

    payload = {
        "org_id": ORG_ID,
        "owner_id": owner_id,
        "name": name,
        "species": d.get("species"),
        "breed": d.get("breed"),
        "age": d.get("age"),
        "weight_kg": d.get("weight_kg"),
        "notes": d.get("notes") or d.get("note"),
    }

    res = insert_with_optional_fallback("patients", payload, optional_fields=["notes"])
    row = (res.data[0] if getattr(res, "data", None) else None) or payload
    return ok(row)

@app.delete("/api/patients/<pet_id>")
def api_delete_patient(pet_id):
    if not pet_id:
        return fail("pet_id required", 400)
    supabase.table("patients").delete().eq("org_id", ORG_ID).eq("id", pet_id).execute()
    return ok(True)

# =========================
# API: VISITS
# =========================
@app.get("/api/visits")
def api_get_visits():
    visit_id = request.args.get("id")
    pet_id = request.args.get("pet_id")

    if visit_id:
        visit_id = visit_id.strip()
        if len(visit_id) < 10:
            return fail("invalid visit id", 400)

    q = supabase.table("visits").select("*").eq("org_id", ORG_ID)

    if visit_id:
        q = q.eq("id", visit_id)
    if pet_id:
        q = q.eq("pet_id", pet_id)

    res = q.execute()
    rows = res.data or []

    # подтягиваем линии из visit_services / visit_stock
    ids = [r.get("id") for r in rows if r.get("id")]
    services_by_visit, stock_by_visit = load_visit_lines(ids)

    for r in rows:
        vid = r.get("id")
        r["services"] = services_by_visit.get(vid, [])
        r["stock"] = stock_by_visit.get(vid, [])

    return ok(rows)

def build_services_payload(d: dict):
    """
    Сохраняем в то, что реально есть в БД.
    Если в БД нет колонки services, обычно есть services_json.
    Чтобы не гадать — пишем в обе, а fallback сам отрежет несуществующее.
    """
    out = {}

    if "services" in d:
        out["services"] = d.get("services")
        out["services_json"] = d.get("services")

    if "services_json" in d:
        out["services_json"] = d.get("services_json")
        out["services"] = d.get("services_json")

    if "stock" in d:
        out["stock"] = d.get("stock")
        out["stock_json"] = d.get("stock")

    if "stock_json" in d:
        out["stock_json"] = d.get("stock_json")
        out["stock"] = d.get("stock_json")

    return out

@app.put("/api/visits")
def api_update_visit_query():
    visit_id = (request.args.get("id") or "").strip()
    if not visit_id:
        return fail("id required", 400)

    d = request.get_json(silent=True) or {}

    # 1) обновляем базовые поля визита (то, что реально есть в таблице visits)
    payload = {
        "date": d.get("date"),
        "note": d.get("note"),
        "dx": d.get("dx"),
        "rx": d.get("rx"),
        "weight_kg": d.get("weight_kg"),
    }

    res = update_with_optional_fallback("visits", visit_id, payload)

    # 2) сохраняем услуги/склад в отдельных таблицах (visit_services / visit_stock)
    # важно: вызываем ВСЕГДА, даже если списки пустые — это позволит "очистить" услуги/склад
    try:
        save_visit_lines(visit_id, d)
    except Exception as e:
        return fail(f"save_visit_lines failed: {e}", 500)

    # 3) возвращаем свежие данные: visits + подтянутые lines
    base = None
    if res is not None and getattr(res, "data", None):
        base = res.data[0]
    else:
        # если update вернул пусто — просто перечитаем визит
        get_res = (
            supabase.table("visits")
            .select("*")
            .eq("org_id", ORG_ID)
            .eq("id", visit_id)
            .execute()
        )
        base = (get_res.data[0] if get_res.data else {"id": visit_id, **clean_payload(payload)})

    # подтягиваем услуги/склад из line-таблиц
    services_map, stock_map = load_visit_lines([visit_id])
    base["services"] = services_map.get(visit_id, [])
    base["stock"] = stock_map.get(visit_id, [])

    return ok(base)

@app.post("/api/visits")
def api_create_visit():
    d = request.get_json(silent=True) or {}

    pet_id = (d.get("pet_id") or "").strip()
    if not pet_id:
        return fail("pet_id required", 400)

    payload = {
        "org_id": ORG_ID,
        "pet_id": pet_id,
        "date": d.get("date"),
        "note": d.get("note"),
        "dx": d.get("dx"),
        "rx": d.get("rx"),
        "weight_kg": d.get("weight_kg"),
    }

    # 1) создаём визит
    res = insert_with_optional_fallback("visits", payload)
    row = (res.data[0] if getattr(res, "data", None) and res.data else None)

    # если вдруг вернулось пусто — всё равно создадим id локально (на всякий)
    if not row:
        row = {"id": str(uuid.uuid4()), **payload}

    visit_id = row["id"]

    # 2) если фронт прислал услуги/склад — сохраняем их в line-таблицы
    try:
        save_visit_lines(visit_id, d)
    except Exception as e:
        return fail(f"save_visit_lines failed: {e}", 500)

    # 3) возвращаем визит + lines (как фронт ожидает)
    services_map, stock_map = load_visit_lines([visit_id])
    row["services"] = services_map.get(visit_id, [])
    row["stock"] = stock_map.get(visit_id, [])

    return ok(row)

@app.delete("/api/visits/<visit_id>")
def api_delete_visit(visit_id):
    if not visit_id:
        return fail("visit_id required", 400)

    supabase.table("visits").delete().eq("org_id", ORG_ID).eq("id", visit_id).execute()
    return ok(True)

# =========================
# API: UPLOAD FILES (local uploads folder)
# =========================
@app.post("/api/upload")
def api_upload():
    if "files" not in request.files:
        return fail("No files[] provided", 400)

    files = request.files.getlist("files")
    if not files:
        return fail("Empty files[]", 400)

    saved = []

    for f in files:
        if not f or not f.filename:
            continue

        original_name = f.filename
        safe_name = secure_filename(original_name)

        if not allowed_file(safe_name):
            return fail(f"File type not allowed: {original_name}", 400)

        ext = safe_name.rsplit(".", 1)[1].lower()
        stored_name = f"{uuid.uuid4().hex}.{ext}"
        path = os.path.join(UPLOAD_DIR, stored_name)

        f.save(path)

        try:
            size = os.path.getsize(path)
        except Exception:
            size = 0

        mime = mimetypes.guess_type(path)[0] or f.mimetype or ""

        saved.append({
            "stored_name": stored_name,
            "url": file_url(stored_name),
            "name": original_name,
            "size": size,
            "type": mime,
        })

    if not saved:
        return fail("No valid files saved", 400)

    return jsonify({"ok": True, "files": saved})

# =========================
# API: DELETE UPLOAD (local)
# =========================
@app.post("/api/delete_upload")
def api_delete_upload():
    d = request.get_json(silent=True) or {}
    stored_name = (d.get("stored_name") or "").strip()
    if not stored_name:
        return fail("stored_name required", 400)

    stored_name = os.path.basename(stored_name)
    path = os.path.join(UPLOAD_DIR, stored_name)

    if not os.path.exists(path):
        return ok(True)

    try:
        os.remove(path)
    except Exception as e:
        return fail(f"Cannot delete file: {e}", 500)

    return ok(True)

# =========================
# RUN
# =========================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")), debug=True)