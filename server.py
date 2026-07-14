import os
import uuid
import hmac
import hashlib
import json
import mimetypes
from urllib.parse import parse_qsl

from datetime import datetime, timezone
from flask import Flask, request, send_from_directory, jsonify
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge

from supabase import create_client

print("### RUNNING server.py ###")

# =========================
# ENVы
# =========================
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError("Missing ENV vars: SUPABASE_URL / SUPABASE_SERVICE_KEY")

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
print("SUPABASE STORAGE READY")

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
# ДИНАМИЧЕСКИЙ ORG_ID (ИЗОЛЯЦИЯ КЛИНИК)
# =========================
def get_current_org_id():
    """Динамически извлекает ID организации из заголовков запроса фронтенда."""
    org_id = request.headers.get("X-Org-ID")
    if org_id:
        return org_id.strip()
    return os.getenv("ORG_ID")


def get_current_user():
    """
    Возвращает текущего пользователя клиники по данным входа.

    Временная схема:
    фронтенд передает X-Clinic-Username.
    Позже заменим это на защищенную серверную сессию.
    """
    username = (request.headers.get("X-Clinic-Username") or "").strip()

    if not username:
        return None

    try:
        current_org = get_current_org_id()

        res = (
            supabase.table("clinic_users")
            .select("username, org_id, role, display_name, is_active")
            .eq("org_id", current_org)
            .eq("username", username)
            .limit(1)
            .execute()
        )

        if not res.data:
            return None

        user = res.data[0]

        if user.get("is_active") is False:
            return None

        return user

    except Exception as e:
        print("⚠️ get_current_user failed:", repr(e))
        return None


def owner_required():
    """
    Проверяет, что текущий пользователь — владелец клиники.
    Возвращает пользователя или готовый ответ с ошибкой.
    """
    user = get_current_user()

    if not user:
        return None, fail("Unauthorized", 401)

    if user.get("role") != "owner":
        return None, fail("Owner access required", 403)

    return user, None
# =========================
# STATIC UPLOADS
# =========================
@app.get("/uploads/<path:filename>")
def uploaded_file(filename):
    filename = os.path.basename(filename)
    return send_from_directory(UPLOAD_DIR, filename)

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
        for item  in d:
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

    current_org = get_current_org_id()
    try:
        return supabase.table(table).update(payload).eq("org_id", current_org).eq("id", row_id).execute()
    except Exception as e:
        msg = str(e)
        if "PGRST204" in msg:
            fallback = {k: v for k, v in payload.items() if k not in optional_fields}
            return supabase.table(table).update(fallback).eq("org_id", current_org).eq("id", row_id).execute()
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

    current_org = get_current_org_id()

    # =====================
    # services
    # =====================
    try:
        q = supabase.table("visit_services").select("*").in_("visit_id", visit_ids)

        # пробуем с org_id, еслиционной колонки нет — упадет и мы повторим без org_id
        try:
            q = q.eq("org_id", current_org)
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
            q = q.eq("org_id", current_org)
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
    current_org = get_current_org_id()

    # =====================
    # delete old services
    # =====================
    try:
        supabase.table("visit_services").delete() \
            .eq("org_id", current_org) \
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
            .eq("org_id", current_org) \
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

            snap_price = x.get("priceSnap") or x.get("price_snap")
            snap_name = x.get("nameSnap") or x.get("name_snap")

            rows.append({
                "org_id": current_org,          
                "visit_id": visit_id,
                "service_id": service_id,  
                "qty": qty,
                "price_snap": snap_price,  
                "name_snap": snap_name,
            })

        insert_with_optional_fallback(
            "visit_services",
            rows,
            optional_fields=["org_id", "price_snap", "name_snap"]
        )

    # =====================
    # insert new stock
    # =====================
    if isinstance(stock, list) and stock:
        rows = []

        for x in stock:
            rows.append({
                "org_id": current_org,
                "visit_id": visit_id,
                "stock_id": x.get("stockId") or x.get("stock_id"),
                "qty": x.get("qty") or 1,
                "price_snap": x.get("priceSnap") or x.get("price_snap"),
                "name_snap": x.get("nameSnap") or x.get("name_snap"),
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
    theme = "purple"
    clinic_name = "Doc.PUG Clinic"
    current_org = get_current_org_id()
    
    try:
        res_org = supabase.table("orgs").select("name").eq("id", current_org).execute()
        if res_org.data:
            clinic_name = res_org.data[0].get("name", clinic_name)
    except Exception as e:
        print("⚠️ Не удалось подтянуть тему организации из БД:", repr(e))

    if not user:
        return jsonify({
            "me": {
                "name": "Гість", 
                "mode": "browser",
                "clinic_name": clinic_name,
                "theme": theme
            }
        })

    return jsonify({
        "me": {
            "name": user.get("first_name"),
            "tg_user_id": str(user.get("id")),
            "username": user.get("username"),
            "mode": "telegram",
            "clinic_name": clinic_name,
            "theme": theme
        }
    })

# =========================
# SERVICES API
# =========================
@app.get("/api/services")
def api_services_list():
    try:
        current_org = get_current_org_id()
        res = (
            supabase.table("services")
            .select("id, name, price, active")
            .eq("org_id", current_org)
            .order("name")
            .execute()
        )
        return jsonify({"ok": True, "data": res.data or []})
    except Exception as e:
        print("❌ /api/services GET error:", repr(e))
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/services")
def api_services_create():
    try:
        payload = request.get_json(silent=True) or {}
        name = (payload.get("name") or "").strip()
        price = payload.get("price") or 0
        active = payload.get("active", True)

        if not name:
            return jsonify({"ok": False, "error": "name required"}), 400

        current_org = get_current_org_id()
        res = (
            supabase.table("services")
            .insert({
                "org_id": current_org,
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

        current_org = get_current_org_id()
        res = (
            supabase.table("services")
            .update(patch)
            .eq("org_id", current_org)
            .eq("id", svc_id)
            .execute()
        )
        return jsonify({"ok": True, "data": res.data or []})
    except Exception as e:
        print("❌ /api/services PUT error:", repr(e))
        return jsonify({"ok": False, "error": str(e)}), 500


@app.delete("/api/services")
def api_services_delete():
    try:
        payload = request.get_json(silent=True) or {}
        svc_id = (request.args.get("id") or payload.get("id") or "").strip()
        if not svc_id:
            return jsonify({"ok": False, "error": "id required"}), 400

        current_org = get_current_org_id()
        (
            supabase.table("services")
            .delete()
            .eq("org_id", current_org)
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
    current_org = get_current_org_id()
    res = supabase.table("owners").select("*").eq("org_id", current_org).execute()
    return ok(res.data or [])

@app.post("/api/owners")
def api_create_owner():
    d = request.get_json(silent=True) or {}
    name = (d.get("name") or "").strip()
    if not name:
        return fail("name required", 400)

    current_org = get_current_org_id()
    payload = {
        "org_id": current_org,
        "name": name,
        "phone": d.get("phone"),
        "note": d.get("note"),
    }

    res = insert_with_optional_fallback("owners", payload, optional_fields=["note"])
    row = (res.data[0] if getattr(res, "data", None) else None) or payload
    return ok(row)

@app.put("/api/owners/<owner_id>")
def api_update_owner(owner_id):
    if not owner_id:
        return fail("owner_id required", 400)

    current_org = get_current_org_id()
    data = request.get_json(silent=True) or {}

    payload = {
        "name": str(data.get("name") or "").strip(),
        "phone": str(data.get("phone") or "").strip(),
        "note": str(data.get("note") or "").strip(),
    }

    if not payload["name"]:
        return fail("name required", 400)

    res = (
        supabase.table("owners")
        .update(payload)
        .eq("org_id", current_org)
        .eq("id", owner_id)
        .execute()
    )

    if not res.data:
        return fail("owner not found", 404)

    return ok(res.data[0])

@app.delete("/api/owners/<owner_id>")
def api_delete_owner(owner_id):
    if not owner_id:
        return fail("owner_id required", 400)

    current_org = get_current_org_id()

    # 1. Находим всех пациентов владельца
    pets_res = (
        supabase.table("patients")
        .select("id")
        .eq("org_id", current_org)
        .eq("owner_id", owner_id)
        .execute()
    )

    pet_ids = [p["id"] for p in (pets_res.data or [])]

    # 2. Удаляем календарные события владельца
    supabase.table("calendar_events") \
        .delete() \
        .eq("org_id", current_org) \
        .eq("owner_id", owner_id) \
        .execute()

    # 3. Удаляем визиты пациентов
    for pet_id in pet_ids:
        supabase.table("visits") \
            .delete() \
            .eq("org_id", current_org) \
            .eq("pet_id", pet_id) \
            .execute()

    # 4. Удаляем пациентов владельца
    supabase.table("patients") \
        .delete() \
        .eq("org_id", current_org) \
        .eq("owner_id", owner_id) \
        .execute()

    # 5. Удаляем владельца
    supabase.table("owners") \
        .delete() \
        .eq("org_id", current_org) \
        .eq("id", owner_id) \
        .execute()

    return ok(True)

# =========================
# API: SPECIALIZATIONS
# =========================
@app.get("/api/specializations")
def api_get_specializations():
    try:
        current_org = get_current_org_id()
        res = (
            supabase.table("specializations")
            .select("*")
            .eq("org_id", current_org)
            .order("name")
            .execute()
        )
        return ok(res.data or [])
    except Exception as e:
        return fail(str(e), 500)


@app.post("/api/specializations")
def api_create_specialization():
    try:
        d = request.get_json(silent=True) or {}
        name = (d.get("name") or "").strip()
        if not name:
            return fail("name required", 400)

        current_org = get_current_org_id()
        payload = {
            "org_id": current_org,
            "name": name,
            "color": d.get("color") or "#7C5CFF",
            "is_active": True,
        }

        res = supabase.table("specializations").insert(payload).execute()
        row = res.data[0] if getattr(res, "data", None) else payload
        return ok(row)
    except Exception as e:
        return fail(str(e), 500)


@app.put("/api/specializations/<spec_id>")
def api_update_specialization(spec_id):
    try:
        if not spec_id:
            return fail("spec_id required", 400)

        d = request.get_json(silent=True) or {}
        payload = {
            "name": d.get("name"),
            "color": d.get("color"),
            "is_active": d.get("is_active"),
        }
        payload = {k: v for k, v in payload.items() if v not in ("", None)}

        current_org = get_current_org_id()
        res = (
            supabase.table("specializations")
            .update(payload)
            .eq("org_id", current_org)
            .eq("id", spec_id)
            .execute()
        )

        row = res.data[0] if getattr(res, "data", None) else payload
        return ok(row)
    except Exception as e:
        return fail(str(e), 500)


@app.delete("/api/specializations/<spec_id>")
def api_delete_specialization(spec_id):
    try:
        if not spec_id:
            return fail("spec_id required", 400)

        current_org = get_current_org_id()
        supabase.table("specializations").update({
            "is_active": False
        }).eq("org_id", current_org).eq("id", spec_id).execute()
        return ok(True)
    except Exception as e:
        return fail(str(e), 500)
    

@app.get("/api/staff")
def api_staff():
    try:
        current_org = get_current_org_id()
        res = (
            supabase.table("staff")
            .select("*")
            .eq("org_id", current_org)
            .order("name")
            .execute()
        )
        return ok(res.data or [])
    except Exception as e:
        return fail(str(e))

@app.post("/api/staff")
def api_create_staff():
    d = request.get_json(silent=True) or {}
    name = (d.get("name") or "").strip()
    if not name:
        return fail("name required", 400)

    current_org = get_current_org_id()
    payload = {
        "org_id": current_org,
        "name": name,
        "role": d.get("role") or "vet",
        "avatar": d.get("avatar"),
        "color": d.get("color") or "#7C5CFF",
        "phone": d.get("phone"),
        "shift_rate": d.get("shift_rate") or 0,
        "percent_rate": d.get("percent_rate") or 0,
        "bonus_rate": d.get("bonus_rate") or 0,
        "note": d.get("note"),
        "is_active": True,
    }

    res = supabase.table("staff").insert(payload).execute()
    row = res.data[0] if getattr(res, "data", None) else payload
    return ok(row)

@app.put("/api/staff/<staff_id>")
def api_update_staff(staff_id):
    if not staff_id:
        return fail("staff_id required", 400)

    d = request.get_json(silent=True) or {}
    payload = {
        "name": d.get("name"),
        "role": d.get("role"),
        "avatar": d.get("avatar"),
        "color": d.get("color"),
        "phone": d.get("phone"),
        "specialization": d.get("specialization"),
        "shift_rate": d.get("shift_rate"),
        "percent_rate": d.get("percent_rate"),
        "bonus_rate": d.get("bonus_rate"),
        "note": d.get("note"),
        "is_active": d.get("is_active"),
        "skills": d.get("skills"),
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    current_org = get_current_org_id()
    res = (
        supabase.table("staff")
        .update(payload)
        .eq("org_id", current_org)
        .eq("id", staff_id)
        .execute()
    )
    row = res.data[0] if getattr(res, "data", None) else payload
    return ok(row)
@app.get("/api/staff/<staff_id>/dashboard")
def api_staff_dashboard(staff_id):
    try:
        current_org = get_current_org_id()

        visits_res = (
            supabase.table("visits")
            .select("*")
            .eq("org_id", current_org)
            .eq("staff_id", staff_id)
            .execute()
        )

        visits = visits_res.data or []

        now = datetime.now(timezone.utc)
        current_month = now.strftime("%Y-%m")
        prev_month_num = now.month - 1
        prev_year = now.year

        if prev_month_num == 0:
            prev_month_num = 12
            prev_year -= 1

        prev_month = f"{prev_year}-{prev_month_num:02d}"

        current_visits = [
            v for v in visits
            if str(v.get("date") or "").startswith(current_month)
        ]

        prev_visits = [
            v for v in visits
            if str(v.get("date") or "").startswith(prev_month)
        ]

        def calc_visit_total(visit_id):
            total = 0

            try:
                services_res = (
                    supabase.table("visit_services")
                    .select("*")
                    .eq("visit_id", visit_id)
                    .execute()
                )

                for s in services_res.data or []:
                    qty = s.get("qty") or 1
                    price = s.get("price_snap") or 0
                    try:
                        total += float(qty) * float(price)
                    except Exception:
                        pass
            except Exception:
                pass

            try:
                stock_res = (
                    supabase.table("visit_stock")
                    .select("*")
                    .eq("visit_id", visit_id)
                    .execute()
                )

                for st in stock_res.data or []:
                    qty = st.get("qty") or 1
                    price = st.get("price_snap") or 0
                    try:
                        total += float(qty) * float(price)
                    except Exception:
                        pass
            except Exception:
                pass

            return total

        current_revenue = sum(calc_visit_total(v.get("id")) for v in current_visits if v.get("id"))
        prev_revenue = sum(calc_visit_total(v.get("id")) for v in prev_visits if v.get("id"))

        visits_this_month = len(current_visits)
        closed_checks = len([v for v in current_visits if v.get("id")])

        avg_check = round(current_revenue / closed_checks) if closed_checks else 0

        def growth(current, previous):
            try:
                current = float(current or 0)
                previous = float(previous or 0)
                if previous <= 0:
                    return 0
                return round(((current - previous) / previous) * 100)
            except Exception:
                return 0

        visits_growth = growth(len(current_visits), len(prev_visits))
        checks_growth = growth(len(current_visits), len(prev_visits))
        revenue_growth = growth(current_revenue, prev_revenue)

        prev_avg = round(prev_revenue / len(prev_visits)) if prev_visits else 0
        avg_check_growth = growth(avg_check, prev_avg)

        last_visits = sorted(
            visits,
            key=lambda x: str(x.get("date") or ""),
            reverse=True
        )[:5]

        normalized_last_visits = []

        for v in last_visits:
            total = calc_visit_total(v.get("id")) if v.get("id") else 0

            patient_name = "Пацієнт"
            try:
                pet_id = v.get("pet_id")
                if pet_id:
                    pet_res = (
                        supabase.table("patients")
                        .select("name, species, breed")
                        .eq("org_id", current_org)
                        .eq("id", pet_id)
                        .execute()
                    )
                    if pet_res.data:
                        patient_name = pet_res.data[0].get("name") or "Пацієнт"
            except Exception:
                pass

            normalized_last_visits.append({
                "id": v.get("id"),
                "date": v.get("date"),
                "patient_name": patient_name,
                "note": v.get("note") or "",
                "dx": v.get("dx") or "",
                "rx": v.get("rx") or "",
                "total": round(total),
                "status": "Завершено"
            })

        return ok({
            "visits_this_month": visits_this_month,
            "closed_checks": closed_checks,
            "revenue": round(current_revenue),
            "avg_check": avg_check,
            "revenue_growth_percent": revenue_growth,
            "visits_growth_percent": visits_growth,
            "checks_growth_percent": checks_growth,
            "avg_check_growth_percent": avg_check_growth,
            "last_visits": normalized_last_visits,
            "revenue_chart": [],
            "visits_chart": [],
            "penalties": {
                "late": 0,
                "absences": 0,
                "warnings": 0,
                "bonuses_amount": 0,
                "penalties_amount": 0
            }
        })

    except Exception as e:
        print("❌ /api/staff/<staff_id>/dashboard error:", repr(e))
        return fail(str(e), 500)

@app.get("/api/staff/<staff_id>/adjustments")
def api_get_staff_adjustments(staff_id):
    try:
        current_org = get_current_org_id()
        month = request.args.get("month") or datetime.now(timezone.utc).strftime("%Y-%m")

        date_from = f"{month}-01"
        y, m = month.split("-")
        y = int(y)
        m = int(m)
        if m == 12:
            date_to = f"{y + 1}-01-01"
        else:
            date_to = f"{y}-{m + 1:02d}-01"

        res = (
            supabase.table("staff_finance_adjustments")
            .select("*")
            .eq("org_id", current_org)
            .eq("staff_id", staff_id)
            .gte("adjustment_date", date_from)
            .lt("adjustment_date", date_to)
            .order("created_at", desc=True)
            .execute()
        )

        return ok(res.data or [])

    except Exception as e:
        return fail(str(e), 500)


@app.post("/api/staff/<staff_id>/adjustments")
def api_create_staff_adjustment(staff_id):
    try:
        current_org = get_current_org_id()
        d = request.get_json(silent=True) or {}

        adj_type = d.get("type")
        amount = int(d.get("amount") or 0)
        reason = (d.get("reason") or "").strip()

        if adj_type not in ("bonus", "penalty"):
            return fail("type must be bonus or penalty", 400)

        if amount <= 0:
            return fail("amount must be positive", 400)

        payload = {
            "org_id": current_org,
            "staff_id": staff_id,
            "type": adj_type,
            "amount": amount,
            "reason": reason,
            "adjustment_date": d.get("adjustment_date") or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        }

        res = supabase.table("staff_finance_adjustments").insert(payload).execute()
        row = res.data[0] if getattr(res, "data", None) else payload
        return ok(row)

    except Exception as e:
        return fail(str(e), 500)


@app.delete("/api/staff/adjustments/<adjustment_id>")
def api_delete_staff_adjustment(adjustment_id):
    try:
        current_org = get_current_org_id()

        supabase.table("staff_finance_adjustments") \
            .delete() \
            .eq("org_id", current_org) \
            .eq("id", adjustment_id) \
            .execute()

        return ok(True)

    except Exception as e:
        return fail(str(e), 500)

def get_current_season_key():
    now = datetime.now(timezone.utc)
    quarter = ((now.month - 1) // 3) + 1
    return f"{now.year}-Q{quarter}"


def calc_rating_visit_total(visit):
    total = 0

    if not visit:
        return 0

    visit_id = visit.get("id")

    # 1) Считаем услуги/склад, если они лежат прямо в visits
    for arr_key in ["services", "services_json"]:
        items = visit.get(arr_key) or []
        if isinstance(items, list):
            for x in items:
                try:
                    qty = float(x.get("qty") or 1)
                    price = float(
                        x.get("priceSnap")
                        or x.get("price_snap")
                        or x.get("price")
                        or 0
                    )
                    total += qty * price
                except Exception:
                    pass

    for arr_key in ["stock", "stock_json"]:
        items = visit.get(arr_key) or []
        if isinstance(items, list):
            for x in items:
                try:
                    qty = float(x.get("qty") or 1)
                    price = float(
                        x.get("priceSnap")
                        or x.get("price_snap")
                        or x.get("price")
                        or 0
                    )
                    total += qty * price
                except Exception:
                    pass

    # 2) Если в самом визите суммы нет — пробуем visit_services / visit_stock
    if total > 0 or not visit_id:
        return round(total)

    try:
        services_res = (
            supabase.table("visit_services")
            .select("*")
            .eq("visit_id", visit_id)
            .execute()
        )

        for s in services_res.data or []:
            qty = float(s.get("qty") or 1)
            price = float(s.get("price_snap") or 0)
            total += qty * price
    except Exception:
        pass

    try:
        stock_res = (
            supabase.table("visit_stock")
            .select("*")
            .eq("visit_id", visit_id)
            .execute()
        )

        for st in stock_res.data or []:
            qty = float(st.get("qty") or 1)
            price = float(st.get("price_snap") or 0)
            total += qty * price
    except Exception:
        pass

    return round(total)


@app.post("/api/staff/rating/rebuild")
def api_rebuild_staff_rating():
    try:
        current_org = get_current_org_id()
        season_key = get_current_season_key()

        staff_res = (
            supabase.table("staff")
            .select("*")
            .eq("org_id", current_org)
            .execute()
        )
        staff_list = staff_res.data or []

        visits_res = (
            supabase.table("visits")
            .select("*")
            .eq("org_id", current_org)
            .execute()
        )
        visits = visits_res.data or []

        visit_ids = [v.get("id") for v in visits if v.get("id")]
        services_by_visit, stock_by_visit = load_visit_lines(visit_ids)

        # подтягиваем справочник услуг
        services_res = (
            supabase.table("services")
            .select("*")
            .eq("org_id", current_org)
            .execute()
        )
        services_map = {
            str(s.get("id")): s
            for s in (services_res.data or [])
            if s.get("id")
        }

        # подтягиваем справочник склада
        stock_res = (
            supabase.table("stock")
            .select("*")
            .eq("org_id", current_org)
            .execute()
        )
        stock_map = {
            str(s.get("id")): s
            for s in (stock_res.data or [])
            if s.get("id")
        }

        def calc_rating_total(v):
            visit_id = v.get("id")
            total = 0

            for s in services_by_visit.get(visit_id, []):
                try:
                    qty = float(s.get("qty") or 1)

                    service_id = str(
                        s.get("serviceId")
                        or s.get("service_id")
                        or ""
                    )

                    service_row = services_map.get(service_id) or {}

                    price = float(
                        s.get("priceSnap")
                        or s.get("price_snap")
                        or s.get("price")
                        or service_row.get("price")
                        or 0
                    )

                    total += qty * price
                except Exception:
                    pass

            for st in stock_by_visit.get(visit_id, []):
                try:
                    qty = float(st.get("qty") or 1)

                    stock_id = str(
                        st.get("stockId")
                        or st.get("stock_id")
                        or ""
                    )

                    stock_row = stock_map.get(stock_id) or {}

                    price = float(
                        st.get("priceSnap")
                        or st.get("price_snap")
                        or st.get("price")
                        or stock_row.get("price")
                        or 0
                    )

                    total += qty * price
                except Exception:
                    pass

            return round(total)

        rows = []

        for staff in staff_list:
            staff_id = str(staff.get("id"))

            staff_visits = [
                v for v in visits
                if str(v.get("staff_id") or v.get("doctor_id") or v.get("vet_id") or "") == staff_id
            ]

            visits_count = len(staff_visits)
            revenue = round(sum(calc_rating_total(v) for v in staff_visits))
            avg_check = round(revenue / visits_count) if visits_count else 0
            xp = visits_count * 10

            score = round(
                visits_count * 25 +
                revenue * 0.01 +
                avg_check * 0.05 +
                xp
            )

            rows.append({
                "org_id": current_org,
                "season_key": season_key,
                "staff_id": staff_id,
                "staff_name": staff.get("name") or "Працівник",
                "avatar": staff.get("avatar") or "",
                "score": score,
                "visits_count": visits_count,
                "revenue": revenue,
                "avg_check": avg_check,
                "xp": xp,
                "rank": 0,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })

        rows.sort(key=lambda x: x["score"], reverse=True)

        for i, row in enumerate(rows, start=1):
            row["rank"] = i

        for row in rows:
            supabase.table("staff_rating_snapshots").upsert(
                row,
                on_conflict="org_id,season_key,staff_id"
            ).execute()

        return ok({
            "season_key": season_key,
            "rows": rows,
        })

    except Exception as e:
        print("❌ /api/staff/rating/rebuild error:", repr(e))
        return fail(str(e), 500)

@app.get("/api/staff/rating")
def api_get_staff_rating():
    try:
        current_org = get_current_org_id()
        season_key = request.args.get("season") or get_current_season_key()

        res = (
            supabase.table("staff_rating_snapshots")
            .select("*")
            .eq("org_id", current_org)
            .eq("season_key", season_key)
            .order("rank")
            .execute()
        )

        return ok({
            "season_key": season_key,
            "rows": res.data or [],
        })

    except Exception as e:
        print("❌ /api/staff/rating error:", repr(e))
        return fail(str(e), 500)

def rebuild_staff_rating_silent():
    try:
        with app.test_request_context(
            headers={
                "X-Org-ID": get_current_org_id()
            }
        ):
            res = api_rebuild_staff_rating()
            return res
    except Exception as e:
        print("⚠️ rating silent rebuild failed:", repr(e))
        return None
    
# API: CALENDAR
# =========================
@app.get("/api/calendar")
def api_calendar():
    try:
        current_org = get_current_org_id()
        res = (
            supabase.table("calendar_events")
            .select("*")
            .eq("org_id", current_org)
            .order("event_date")
            .order("start_time")
            .execute()
        )
        return ok(res.data or [])
    except Exception as e:
        return fail(str(e))
    
@app.post("/api/calendar")
def api_create_calendar_event():
    d = request.get_json(silent=True) or {}

    title = (d.get("title") or "").strip()
    event_date = (d.get("event_date") or "").strip()
    start_time = (d.get("start_time") or "").strip()
    end_time = (d.get("end_time") or "").strip()
    staff_id = d.get("staff_id")

    if not title or not event_date or not start_time or not end_time or not staff_id:
        return fail("missing required fields", 400)

    current_org = get_current_org_id()
    existing = (
        supabase.table("calendar_events")
        .select("*")
        .eq("org_id", current_org)
        .eq("staff_id", staff_id)
        .eq("event_date", event_date)
        .execute()
    )

    for ev in existing.data or []:
        ev_start = str(ev.get("start_time") or "")[:5]
        ev_end = str(ev.get("end_time") or "")[:5]
        if start_time < ev_end and end_time > ev_start:
            return fail("time slot busy", 409)

    payload = {
        "org_id": current_org,
        "event_type": d.get("event_type") or "appointment",
        "title": title,
        "event_date": event_date,
        "start_time": start_time,
        "end_time": end_time,
        "staff_id": staff_id,
        "patient_id": d.get("patient_id"),
        "owner_id": d.get("owner_id"),
        "visit_id": d.get("visit_id"),
        "location": d.get("location"),
        "status": d.get("status") or "planned",
        "note": d.get("note"),
    }
    res = supabase.table("calendar_events").insert(payload).execute()
    row = res.data[0] if getattr(res, "data", None) else payload
    return ok(row)

@app.delete("/api/calendar/<event_id>")
def api_delete_calendar_event(event_id):
    if not event_id:
        return fail("event_id required", 400)

    current_org = get_current_org_id()
    supabase.table("calendar_events").delete().eq("org_id", current_org).eq("id", event_id).execute()
    return ok(True)

@app.put("/api/calendar/<event_id>")
def api_update_calendar_event(event_id):
    if not event_id:
        return fail("event_id required", 400)

    d = request.get_json(silent=True) or {}
    payload = {
        "title": d.get("title"),
        "event_date": d.get("event_date"),
        "start_time": d.get("start_time"),
        "end_time": d.get("end_time"),
        "staff_id": d.get("staff_id"),
        "location": d.get("location"),
        "status": d.get("status"),
        "note": d.get("note"),
    }
    payload = {k: v for k, v in payload.items() if v not in ("", None)}
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()

    current_org = get_current_org_id()
    res = (
        supabase.table("calendar_events")
        .update(payload)
        .eq("org_id", current_org)
        .eq("id", event_id)
        .execute()
    )
    row = res.data[0] if getattr(res, "data", None) else payload
    return ok(row)

def rebuild_staff_rating_silent():
    try:
        return api_rebuild_staff_rating()
    except Exception as e:
        print("⚠️ rating silent rebuild failed:", repr(e))
        return None

# =========================
# API: STAFF SCHEDULE
# =========================
@app.get("/api/staff-schedule")
def api_get_staff_schedule():
    work_date = request.args.get("date")
    current_org = get_current_org_id()
    try:
        q = supabase.table("staff_schedule").select("*").eq("org_id", current_org)
        if work_date:
            q = q.eq("work_date", work_date)
        res = q.order("work_date").execute()
        return ok(res.data or [])
    except Exception as e:
        return fail(str(e))

@app.get("/api/staff-schedule-range")
def api_get_staff_schedule_range():
    current_org = get_current_org_id()

    date_from = request.args.get("from")
    date_to = request.args.get("to")

    if not date_from or not date_to:
        return fail("from and to required", 400)

    try:
        res = (
            supabase.table("staff_schedule")
            .select("*")
            .eq("org_id", current_org)
            .gte("work_date", date_from)
            .lte("work_date", date_to)
            .order("work_date")
            .execute()
        )

        return ok(res.data or [])

    except Exception as e:
        return fail(str(e))   

@app.post("/api/staff-schedule")
def api_upsert_staff_schedule():
    d = request.get_json(silent=True) or {}
    work_date = d.get("work_date")
    staff_id = d.get("staff_id")
    if not work_date or not staff_id:
        return fail("work_date and staff_id required", 400)

    current_org = get_current_org_id()
    payload = {
        "org_id": current_org,
        "work_date": work_date,
        "staff_id": staff_id,
        "is_active": d.get("is_active", True),
        "start_time": d.get("start_time") or "09:00",
        "end_time": d.get("end_time") or "18:00",
    }
    try:
        res = (
            supabase.table("staff_schedule")
            .upsert(payload, on_conflict="work_date,staff_id")
            .execute()
        )
        row = res.data[0] if getattr(res, "data", None) else payload
        return ok(row)
    except Exception as e:
        return fail(str(e))
    
    

@app.delete("/api/staff-schedule")
def api_delete_staff_schedule():
    d = request.get_json(silent=True) or {}
    work_date = d.get("work_date")
    staff_id = d.get("staff_id")    
    if not work_date or not staff_id:
        return fail("work_date and staff_id required", 400)

    current_org = get_current_org_id()
    try:
        supabase.table("staff_schedule").delete().eq("org_id", current_org).eq("work_date", work_date).eq("staff_id", staff_id).execute()
        return ok(True)
    except Exception as e:
        return fail(str(e))


# =========================
# API: PATIENTS
# =========================
@app.get("/api/patients")
def api_get_patients():
    try:
        owner_id = request.args.get("owner_id")
        current_org = get_current_org_id()

        q = supabase.table("patients").select("*").eq("org_id", current_org)

        if owner_id:
            q = q.eq("owner_id", owner_id)

        res = q.execute()
        return ok(res.data or [])

    except Exception as e:
        print("❌ /api/patients GET error:", repr(e))
        return fail("Не вдалося завантажити пацієнтів. Спробуйте ще раз.", 500)

@app.post("/api/patients")
def api_create_patient():
    d = request.get_json(silent=True) or {}
    owner_id = (d.get("owner_id") or "").strip()
    name = (d.get("name") or "").strip()
    if not owner_id or not name:
        return fail("owner_id & name required", 400)

    current_org = get_current_org_id()
    payload = {
        "org_id": current_org,
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
    current_org = get_current_org_id()
    supabase.table("patients").delete().eq("org_id", current_org).eq("id", pet_id).execute()
    return ok(True)

# =========================
# API: VISITS
# =========================
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

    current_org = get_current_org_id()
    q = supabase.table("visits").select("*").eq("org_id", current_org)

    if visit_id:
        q = q.eq("id", visit_id)
    if pet_id:
        q = q.eq("pet_id", pet_id)

    res = q.execute()
    rows = res.data or []

    ids = [r.get("id") for r in rows if r.get("id")]
    services_by_visit, stock_by_visit = load_visit_lines(ids)

    for r in rows:
        vid = r.get("id")
        r["services"] = services_by_visit.get(vid, [])
        r["stock"] = stock_by_visit.get(vid, [])

    return ok(rows)


@app.put("/api/visits")
def api_update_visit_query():
    visit_id = (request.args.get("id") or "").strip()
    if not visit_id:
        return fail("id required", 400)

    d = request.get_json(silent=True) or {}

    payload = {
        "staff_id": d.get("staff_id"),
        "date": d.get("date"),
        "note": d.get("note"),
        "dx": d.get("dx"),
        "rx": d.get("rx"),
        "weight_kg": d.get("weight_kg"),
    }

    res = update_with_optional_fallback("visits", visit_id, payload)

    try:
        save_visit_lines(visit_id, d)
    except Exception as e:
        return fail(f"save_visit_lines failed: {e}", 500)

    try:
        rebuild_staff_rating_silent()
    except Exception as e:
        print("⚠️ rating rebuild after update visit failed:", repr(e))

    current_org = get_current_org_id()

    if res is not None and getattr(res, "data", None):
        base = res.data[0]
    else:
        get_res = (
            supabase.table("visits")
            .select("*")
            .eq("org_id", current_org)
            .eq("id", visit_id)
            .execute()
        )
        base = get_res.data[0] if get_res.data else {"id": visit_id, **clean_payload(payload)}

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

    current_org = get_current_org_id()

    payload = {
        "org_id": current_org,
        "pet_id": pet_id,
        "staff_id": d.get("staff_id"),
        "date": d.get("date"),
        "note": d.get("note"),
        "dx": d.get("dx"),
        "rx": d.get("rx"),
        "weight_kg": d.get("weight_kg"),
    }

    res = insert_with_optional_fallback("visits", payload)
    row = (res.data[0] if getattr(res, "data", None) and res.data else None)

    if not row:
        row = {"id": str(uuid.uuid4()), **payload}

    visit_id = row["id"]

    try:
        save_visit_lines(visit_id, d)
    except Exception as e:
        return fail(f"save_visit_lines failed: {e}", 500)

    try:
        rebuild_staff_rating_silent()
    except Exception as e:
        print("⚠️ rating rebuild after create visit failed:", repr(e))

    services_map, stock_map = load_visit_lines([visit_id])
    row["services"] = services_map.get(visit_id, [])
    row["stock"] = stock_map.get(visit_id, [])

    return ok(row)


@app.delete("/api/visits/<visit_id>")
def api_delete_visit(visit_id):
    if not visit_id:
        return fail("visit_id required", 400)

    current_org = get_current_org_id()

    try:
        supabase.table("calendar_events").delete().eq("org_id", current_org).eq("visit_id", visit_id).execute()

        try:
            supabase.table("visit_services").delete().eq("org_id", current_org).eq("visit_id", visit_id).execute()
        except Exception:
            pass

        try:
            supabase.table("visit_stock").delete().eq("org_id", current_org).eq("visit_id", visit_id).execute()
        except Exception:
            pass

        supabase.table("visits").delete().eq("org_id", current_org).eq("id", visit_id).execute()

        try:
            rebuild_staff_rating_silent()
        except Exception as e:
            print("⚠️ rating rebuild after delete visit failed:", repr(e))

        return ok(True)

    except Exception as e:
        return fail(str(e), 500)

# =========================
# API: UPLOAD FILES
# =========================
@app.post("/api/upload")
def api_upload():
    if "files" not in request.files:
        return fail("No files[] provided", 400)
    files = request.files.getlist("files")
    if not files:
        return fail("Empty files[]", 400)
    saved = []
    current_org = get_current_org_id()
    for f in files:
        if not f or not f.filename:
            continue
        original_name = f.filename
        safe_name = secure_filename(original_name)
        if not allowed_file(safe_name):
            return fail(f"File type not allowed: {original_name}", 400)
        ext = safe_name.rsplit(".", 1)[1].lower()
        stored_name = f"{uuid.uuid4().hex}.{ext}"
        storage_path = f"{current_org}/patients/{stored_name}"
        file_bytes = f.read()
        mime = mimetypes.guess_type(safe_name)[0] or f.mimetype or "application/octet-stream"
        try:
            supabase.storage.from_("patient-files").upload(
                storage_path,
                file_bytes,
                {"content-type": mime, "upsert": "false"}
            )
            public_url = supabase.storage.from_("patient-files").get_public_url(storage_path)
        except Exception as e:
            return fail(f"Supabase upload failed: {e}", 500)
        saved.append({
            "stored_name": stored_name,
            "storage_path": storage_path,
            "url": public_url,
            "name": original_name,
            "size": len(file_bytes),
            "type": mime,
        })
    if not saved:
        return fail("No valid files saved", 400)
    return jsonify({"ok": True, "files": saved})

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
# API: PATIENT MEDCARD
# =========================
@app.get("/api/patients/<patient_id>/medcard")
def api_get_patient_medcard(patient_id):
    try:
        current_org = get_current_org_id()
        res = (
            supabase
            .table("patient_medcard_entries")
            .select("*")
            .eq("org_id", current_org)
            .eq("patient_id", patient_id)
            .order("entry_date", desc=True)
            .order("entry_time", desc=True)
            .execute()
        )
        return jsonify({"ok": True, "items": res.data or []})
    except Exception as e:
        return fail(f"Cannot load medcard: {e}", 500)

@app.post("/api/patients/<patient_id>/medcard")
def api_create_patient_medcard(patient_id):
    d = request.get_json(silent=True) or {}
    current_org = get_current_org_id()
    payload = {
        "org_id": current_org,
        "patient_id": patient_id,
        "entry_date": d.get("entry_date"),
        "entry_time": d.get("entry_time"),
        "weight_kg": d.get("weight_kg"),
        "temperature": d.get("temperature"),
        "appetite": d.get("appetite"),
        "water": d.get("water"),
        "urine": d.get("urine"),
        "stool": d.get("stool"),
        "mucosa": d.get("mucosa"),
        "breathing": d.get("breathing"),
        "pulse": d.get("pulse"),
        "condition": d.get("condition"),
        "treatment": d.get("treatment"),
        "dynamics": d.get("dynamics"),
        "plan": d.get("plan"),
        "doctor": d.get("doctor"),
        "note": d.get("note"),
    }
    payload = {k: v for k, v in payload.items() if v not in ("", None)}
    try:
        res = (
            supabase
            .table("patient_medcard_entries")
            .insert(payload)
            .execute()
        )
        item = res.data[0] if res.data else None
        return jsonify({"ok": True, "item": item})
    except Exception as e:
        return fail(f"Cannot create medcard entry: {e}", 500)

@app.put("/api/medcard/<entry_id>")
def api_update_medcard_entry(entry_id):
    d = request.get_json(silent=True) or {}
    allowed = [
        "entry_date", "entry_time", "weight_kg", "temperature", "appetite",
        "water", "urine", "stool", "mucosa", "breathing", "pulse",
        "condition", "treatment", "dynamics", "plan", "doctor", "note"
    ]
    payload = {k: d.get(k) for k in allowed if k in d}
    payload["updated_at"] = "now()"
    payload = {k: v for k, v in payload.items() if v not in ("", None)}
    current_org = get_current_org_id()
    try:
        res = (
            supabase
            .table("patient_medcard_entries")
            .update(payload)
            .eq("org_id", current_org)
            .eq("id", entry_id)
            .execute()
        )
        item = res.data[0] if res.data else None
        return jsonify({"ok": True, "item": item})
    except Exception as e:
        return fail(f"Cannot update medcard entry: {e}", 500)

@app.delete("/api/medcard/<entry_id>")
def api_delete_medcard_entry(entry_id):
    try:
        current_org = get_current_org_id()
        (
            supabase
            .table("patient_medcard_entries")
            .delete()
            .eq("org_id", current_org)
            .eq("id", entry_id)
            .execute()
        )
        return jsonify({"ok": True})
    except Exception as e:
        return fail(f"Cannot delete medcard entry: {e}", 500)

# =========================
# LOGIN
# =========================
@app.post("/api/login")
def api_clinic_login():
    d = request.get_json(silent=True) or {}
    username = (d.get("username") or "").strip()
    password = (d.get("password") or "").strip()
    if not username or not password:
        return jsonify({"ok": False, "error": "Введіть логін та пароль"}), 400
    try:
        res = supabase.table("clinic_users").select("org_id, password_plain").eq("username", username).execute()
        if not res.data:
            return jsonify({"ok": False, "error": "Невірний логін або пароль"}), 401
        user_data = res.data[0]
        if user_data["password_plain"] != password:
            return jsonify({"ok": False, "error": "Невірний логін або пароль"}), 401
        org_id = user_data["org_id"]
        theme = "purple"
        try:
            res_org = supabase.table("orgs").select("name").eq("id", org_id).execute()
            clinic_name = res_org.data[0]["name"] if res_org.data else "Клініка"
        except Exception:
            clinic_name = "Клініка"
        return jsonify({
            "ok": True,
            "data": {
                "org_id": org_id,
                "clinic_name": clinic_name,
                "theme": theme,
                "username": username
            }
        })
    except Exception as e:
        return jsonify({"ok": False, "error": f"Ошибка сервера: {str(e)}"}), 500
    
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")), debug=False)