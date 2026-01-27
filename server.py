import os
import time
import uuid

from flask import Flask, request, send_from_directory, jsonify
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge
from supabase import create_client


# =========================
# ENV
# =========================
ORG_ID = os.getenv("ORG_ID")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not ORG_ID:
    raise RuntimeError("ORG_ID is missing (set it in Render Environment)")
if not SUPABASE_URL:
    raise RuntimeError("SUPABASE_URL is missing (set it in Render Environment)")
if not SUPABASE_SERVICE_KEY:
    raise RuntimeError("SUPABASE_SERVICE_KEY is missing (set it in Render Environment)")

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

print("SUPABASE_URL =", SUPABASE_URL)
print("ORG_ID =", ORG_ID)


# =========================
# APP
# =========================
app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# 25MB per request
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024

ALLOWED_EXT = {
    "pdf", "png", "jpg", "jpeg", "webp", "gif",
    "heic", "dcm"
}


# =========================
# HELPERS
# =========================
def allowed_file(filename: str) -> bool:
    if not filename or "." not in filename:
        return False
    ext = filename.rsplit(".", 1)[1].lower()
    return ext in ALLOWED_EXT


def clean_payload(d: dict) -> dict:
    """Remove empty strings / None."""
    out = {}
    for k, v in (d or {}).items():
        if v is None:
            continue
        if isinstance(v, str) and v.strip() == "":
            continue
        out[k] = v
    return out


def insert_with_optional_fallback(table: str, payload: dict, optional_fields=None):
    """
    Insert payload. If PostgREST says "Could not find column ..." (PGRST204),
    retry removing optional fields (e.g. note/notes).
    """
    optional_fields = optional_fields or []
    payload = clean_payload(payload)

    try:
        return supabase.table(table).insert(payload).execute()
    except Exception as e:
        msg = str(e)

        # Typical: PGRST204 + "Could not find the 'note' column..."
        if "PGRST204" in msg or "Could not find the" in msg:
            fallback = dict(payload)
            changed = False
            for f in optional_fields:
                if f in fallback:
                    fallback.pop(f, None)
                    changed = True
            if changed:
                return supabase.table(table).insert(fallback).execute()

        raise


# =========================
# ERRORS
# =========================
@app.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(e):
    return jsonify({
        "ok": False,
        "error": "Файл(и) занадто великі. Ліміт 25MB на запит."
    }), 413


# =========================
# STATIC
# =========================
@app.get("/")
def root():
    return send_from_directory(BASE_DIR, "index.html")


# отдаём статику проекта (app.js, style.css и т.д.)
# и НЕ перехватываем /api/* и /uploads/*
@app.get("/<path:path>")
def static_files(path):
    if path.startswith("api/") or path.startswith("uploads/"):
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_from_directory(BASE_DIR, path)


@app.get("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename, as_attachment=False)


# =========================
# API: FILES
# =========================
@app.post("/api/upload")
def upload():
    """
    multipart/form-data
    поддерживаем:
      - files: много файлов
      - file: один файл (на всякий)
    """
    files = []
    if "files" in request.files:
        files = request.files.getlist("files")
    elif "file" in request.files:
        files = [request.files.get("file")]
    else:
        return jsonify({
            "ok": False,
            "error": "Поле файлів не знайдено. Очікую 'files' або 'file'."
        }), 400

    saved = []
    errors = []

    for f in files:
        if not f or not f.filename:
            continue

        original_name = f.filename
        safe_name = secure_filename(original_name)

        if not allowed_file(safe_name):
            errors.append({"name": original_name, "error": "Тип файлу не дозволений"})
            continue

        ext = safe_name.rsplit(".", 1)[1].lower()
        unique = f"{int(time.time())}_{uuid.uuid4().hex}.{ext}"
        path = os.path.join(UPLOAD_DIR, unique)

        try:
            f.save(path)
            size = os.path.getsize(path)

            saved.append({
                "name": original_name,
                "stored_name": unique,
                "url": f"/uploads/{unique}",
                "size": size,
                "type": f.mimetype or ""
            })
        except Exception as ex:
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except Exception:
                pass
            errors.append({"name": original_name, "error": str(ex)})

    if not saved and errors:
        return jsonify({"ok": False, "error": "Не вдалося зберегти файли", "errors": errors}), 400

    return jsonify({"ok": True, "files": saved, "errors": errors})


@app.post("/api/delete_upload")
def delete_upload():
    data = request.get_json(silent=True) or {}
    stored = data.get("stored_name")
    if not stored:
        return jsonify({"ok": False, "error": "stored_name required"}), 400

    stored = os.path.basename(stored)  # защита от ../
    path = os.path.join(UPLOAD_DIR, stored)

    if os.path.isfile(path):
        os.remove(path)
        return jsonify({"ok": True})

    return jsonify({"ok": False, "error": "not found"}), 404


# =========================
# API: BASIC
# =========================
@app.get("/api/me")
def me():
    return jsonify({"me": {"name": "Doc.PUG", "tg_user_id": "demo"}})


@app.get("/api/test_org")
def test_org():
    res = supabase.table("orgs").select("*").eq("id", ORG_ID).execute()
    return {"ok": True, "data": res.data or []}


# =========================
# API: OWNERS
# =========================
@app.get("/api/owners")
def get_owners():
    try:
        res = (
            supabase
            .table("owners")
            .select("*")
            .eq("org_id", ORG_ID)
            .order("created_at", desc=True)
            .execute()
        )
        return {"ok": True, "data": res.data or []}
    except Exception as e:
        print("get_owners error:", e)
        return {"ok": False, "error": "Server error while loading owners"}, 500


@app.post("/api/owners")
def create_owner():
    data = request.get_json(silent=True) or {}

    name = (data.get("name") or "").strip()
    phone = (data.get("phone") or "").strip()
    note = (data.get("note") or "").strip()

    if not name:
        return {"ok": False, "error": "Імʼя обовʼязкове"}, 400

    payload = {
        "org_id": ORG_ID,
        "name": name,
        "phone": phone,
        # note — может не существовать как колонка
        "note": note,
    }

    try:
        res = insert_with_optional_fallback("owners", payload, optional_fields=["note"])
        row = res.data[0] if res.data else None
        return {"ok": True, "data": row}
    except Exception as e:
        print("create_owner error:", e)
        return {"ok": False, "error": "Server error while creating owner"}, 500


@app.delete("/api/owners/<owner_id>")
def delete_owner(owner_id):
    if not owner_id:
        return {"ok": False, "error": "owner_id required"}, 400

    try:
        res = (
            supabase
            .table("owners")
            .delete()
            .eq("org_id", ORG_ID)
            .eq("id", owner_id)
            .execute()
        )
        return {"ok": True, "data": res.data or []}
    except Exception as e:
        print("delete_owner error:", e)
        return {"ok": False, "error": "Server error while deleting owner"}, 500


# =========================
# API: PATIENTS
# =========================
@app.get("/api/patients")
def get_patients():
    """
    - если есть owner_id -> пациенты владельца
    - если нет -> все пациенты org
    """
    owner_id = (request.args.get("owner_id") or "").strip()

    q = (
        supabase
        .table("patients")
        .select("*")
        .eq("org_id", ORG_ID)
        .order("created_at", desc=True)
    )
    if owner_id:
        q = q.eq("owner_id", owner_id)

    try:
        res = q.execute()
        return {"ok": True, "data": res.data or []}
    except Exception as e:
        print("get_patients error:", e)
        return {"ok": False, "error": "Server error while loading patients"}, 500


@app.post("/api/patients")
def create_patient():
    data = request.get_json(silent=True) or {}

    owner_id = data.get("owner_id")
    name = (data.get("name") or "").strip()
    species = (data.get("species") or "").strip()
    breed = (data.get("breed") or "").strip()
    age = data.get("age")
    weight_kg = data.get("weight_kg")

    # ✅ принимаем и note, и notes — но пишем в notes
    notes = (data.get("notes") or data.get("note") or "").strip()

    if not owner_id:
        return {"ok": False, "error": "owner_id required"}, 400
    if not name:
        return {"ok": False, "error": "Імʼя пацієнта обовʼязкове"}, 400

    payload = {
        "org_id": ORG_ID,
        "owner_id": owner_id,
        "name": name,
        "species": species,
        "breed": breed,
        "age": age,
        "weight_kg": weight_kg,
        "notes": notes,  # ✅ ключевой фикс
    }

    try:
        # если в таблице patients нет колонки notes — не упадём, вставим без неё
        res = insert_with_optional_fallback("patients", payload, optional_fields=["notes"])
        row = res.data[0] if res.data else None
        return {"ok": True, "data": row}
    except Exception as e:
        print("create_patient error:", e)
        return {"ok": False, "error": "Server error while creating patient"}, 500