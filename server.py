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

# Чтобы корректно работало за nginx/proxy (если нужно)
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

def clean_payload(d: dict) -> dict:
    """Удаляем пустые строки и None, чтобы не ломать insert/update."""
    d = d or {}
    out = {}
    for k, v in d.items():
        if v is None:
            continue
        if isinstance(v, str) and v.strip() == "":
            continue
        out[k] = v
    return out

def allowed_file(filename: str) -> bool:
    if not filename or "." not in filename:
        return False
    ext = filename.rsplit(".", 1)[1].lower()
    return ext in ALLOWED_EXT

def insert_with_optional_fallback(table: str, payload: dict, optional_fields=None):
    """
    Иногда PostgREST/Supabase кидает PGRST204 если колонки нет.
    Тогда вставляем без optional полей.
    """
    optional_fields = optional_fields or []
    payload = clean_payload(payload)

    try:
        return supabase.table(table).insert(payload).execute()
    except Exception as e:
        msg = str(e)
        if "PGRST204" in msg:
            fallback = {k: v for k, v in payload.items() if k not in optional_fields}
            return supabase.table(table).insert(fallback).execute()
        raise

def update_with_optional_fallback(table: str, row_id: str, payload: dict, optional_fields=None):
    optional_fields = optional_fields or []
    payload = clean_payload(payload)

    # Без payload смысла нет
    if not payload:
        return None

    try:
        return supabase.table(table).update(payload).eq("id", row_id).execute()
    except Exception as e:
        msg = str(e)
        if "PGRST204" in msg:
            fallback = {k: v for k, v in payload.items() if k not in optional_fields}
            return supabase.table(table).update(fallback).eq("id", row_id).execute()
        raise

def safe_int(x, default=0):
    try:
        return int(x)
    except Exception:
        return default

def file_url(stored_name: str) -> str:
    # Отдаём через наш сервер: /uploads/<stored_name>
    return f"/uploads/{stored_name}"

# =========================
# TELEGRAM AUTH (optional)
# =========================
def verify_tg_init_data(init_data: str):
    """
    Возвращает dict user из Telegram WebApp initData, если подпись валидная.
    Если токена нет/данных нет — None.
    """
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
    # Блокируем случайный доступ в api/uploads
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

    # Удаляем owner (если есть FK в БД — лучше настроить cascade или запрещать)
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
    pet_id = request.args.get("pet_id")

    q = supabase.table("visits").select("*").eq("org_id", ORG_ID)
    if pet_id:
        q = q.eq("pet_id", pet_id)

    res = q.execute()
    rows = res.data or []

    # 🔴 КРИТИЧЕСКИ ВАЖНО
    for r in rows:
        r["services"] = []
        r["stock"] = []

    return ok(rows)

@app.post("/api/visits")
def api_create_visit():
    d = request.get_json() or {}

    if not d.get("pet_id"):
        return fail("pet_id required", 400)

    payload = {
        "org_id": ORG_ID,
        "pet_id": d["pet_id"],
        "date": d.get("date"),
        "note": d.get("note"),
        "dx": d.get("dx"),
        "rx": d.get("rx"),
        "weight_kg": d.get("weight_kg"),
    }

    res = insert_with_optional_fallback("visits", payload)

    row = res.data[0]
    row["services"] = []
    row["stock"] = []

    return ok(row)

@app.put("/api/visits/<visit_id>")
def api_update_visit(visit_id):
    if not visit_id:
        return fail("visit_id required", 400)

    d = request.get_json(silent=True) or {}

    payload = {
        # org_id НЕ меняем
        "date": d.get("date"),
        "note": d.get("note"),
        "rx": d.get("rx"),
        "weight_kg": d.get("weight_kg"),
    }

    # ✅ если прислали — обновляем (иначе не трогаем)
    if "services" in d:
        payload["services"] = d.get("services")
    if "stock" in d:
        payload["stock"] = d.get("stock")

    res = update_with_optional_fallback("visits", visit_id, payload, optional_fields=["services", "stock"])
    if res is None:
        return ok(True)

    row = (res.data[0] if getattr(res, "data", None) else None) or {"id": visit_id, **clean_payload(payload)}
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
    # ожидаем multipart/form-data с files[]
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

        # size
        try:
            size = os.path.getsize(path)
        except Exception:
            size = 0

        # mime
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

    # ВАЖНО: твой фронт ждёт { ok:true, files:[...] }
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

    # защитимся от ../
    stored_name = os.path.basename(stored_name)
    path = os.path.join(UPLOAD_DIR, stored_name)

    if not os.path.exists(path):
        # не ошибка: уже удалён
        return ok(True)

    try:
        os.remove(path)
    except Exception as e:
        return fail(f"Cannot delete file: {e}", 500)

    return ok(True)

# =========================
# RUN (если локально)
# =========================
if __name__ == "__main__":
    # локально:
    # export ORG_ID=...
    # export SUPABASE_URL=...
    # export SUPABASE_SERVICE_KEY=...
    # export TELEGRAM_BOT_TOKEN=... (optional)
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")), debug=True)