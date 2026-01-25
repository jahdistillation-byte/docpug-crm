import os
import time
import uuid

from flask import Flask, request, send_from_directory, jsonify
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge
from dotenv import load_dotenv
from supabase import create_client

# 1️⃣ СНАЧАЛА грузим .env
load_dotenv()

# 2️⃣ ТОЛЬКО ПОТОМ создаём Supabase
supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_KEY")

)

ORG_ID = "c31b3658-0126-4486-94b4-7d5bee453af5"


print("SUPABASE_URL =", os.getenv("SUPABASE_URL"))
print(
    "SUPABASE_SERVICE_KEY starts =",
    (os.getenv("SUPABASE_SERVICE_KEY") or "")[:12]
)

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Ограничение размера (25MB на запрос)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024

ALLOWED_EXT = {
    "pdf", "png", "jpg", "jpeg", "webp", "gif",
    "heic", "dcm"
}

def allowed_file(filename: str) -> bool:
    if not filename or "." not in filename:
        return False
    ext = filename.rsplit(".", 1)[1].lower()
    return ext in ALLOWED_EXT

# ✅ чтобы при превышении размера не отдавался HTML, а нормальный JSON
@app.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(e):
    return jsonify({
        "ok": False,
        "error": "Файл(и) занадто великі. Ліміт 25MB на запит."
    }), 413

@app.get("/")
def root():
    return send_from_directory(BASE_DIR, "index.html")

# ✅ отдаём статику проекта (app.js, style.css и т.д.)
# и НЕ перехватываем /api/* и /uploads/*
@app.get("/<path:path>")
def static_files(path):
    if path.startswith("api/") or path.startswith("uploads/"):
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_from_directory(BASE_DIR, path)

@app.get("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename, as_attachment=False)

@app.post("/api/upload")
def upload():
    """
    multipart/form-data
    поддерживаем:
      - files: много файлов
      - file: один файл (на всякий)
    """
    # ✅ берем files если есть, иначе file
    files = []
    if "files" in request.files:
        files = request.files.getlist("files")
    elif "file" in request.files:
        files = [request.files.get("file")]
    else:
        return jsonify({"ok": False, "error": "Поле файлів не знайдено. Очікую 'files' або 'file'."}), 400

    saved = []
    errors = []

    for f in files:
        if not f or not f.filename:
            continue

        original_name = f.filename
        safe_name = secure_filename(original_name)

        if not allowed_file(safe_name):
            errors.append({
                "name": original_name,
                "error": "Тип файлу не дозволений"
            })
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
            # если что-то сломалось — не роняем весь запрос
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except:
                pass
            errors.append({
                "name": original_name,
                "error": str(ex)
            })

    # ✅ если вообще ничего не сохранилось — вернём 400 + список ошибок
    if not saved and errors:
        return jsonify({"ok": False, "error": "Не вдалося зберегти файли", "errors": errors}), 400

    return jsonify({"ok": True, "files": saved, "errors": errors})

@app.post("/api/delete_upload")
def delete_upload():
    """
    JSON: { stored_name: "...." }
    """
    data = request.get_json(silent=True) or {}
    stored = data.get("stored_name")
    if not stored:
        return jsonify({"ok": False, "error": "stored_name required"}), 400

    # защита от попыток ../
    stored = os.path.basename(stored)
    path = os.path.join(UPLOAD_DIR, stored)

    if os.path.isfile(path):
        os.remove(path)
        return jsonify({"ok": True})

    return jsonify({"ok": False, "error": "not found"}), 404

@app.get("/api/me")
def me():
    return jsonify({"me": {"name": "Doc.PUG", "tg_user_id": "demo"}})

@app.get("/api/test_org")
def test_org():
    res = supabase.table("orgs").select("*").eq("id", ORG_ID).execute()
    return {
        "ok": True,
        "data": res.data
    }

@app.get("/api/owners")
def get_owners():
    res = (
        supabase
        .table("owners")
        .select("*")
        .eq("org_id", ORG_ID)
        .order("created_at", desc=True)
        .execute()
    )
    return {"ok": True, "data": res.data}


@app.post("/api/owners")
def create_owner():
    data = request.get_json(force=True)

    name = (data.get("name") or "").strip()
    phone = (data.get("phone") or "").strip()

    if not name:
        return {"ok": False, "error": "Імʼя обовʼязкове"}, 400

    res = (
        supabase
        .table("owners")
        .insert({
            "org_id": ORG_ID,
            "name": name,
            "phone": phone
        })
        .execute()
    )

    return {"ok": True, "data": res.data[0]}


