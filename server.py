import os
import time
import uuid
import hmac
import hashlib
import json
from urllib.parse import parse_qsl

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
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

if not ORG_ID or not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError("Missing ENV vars")

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# =========================
# APP
# =========================
app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024

ALLOWED_EXT = {"pdf","png","jpg","jpeg","webp","gif","heic","dcm"}

# =========================
# HELPERS
# =========================
def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT

def clean_payload(d: dict) -> dict:
    return {k:v for k,v in (d or {}).items() if v not in ("", None)}

def insert_with_optional_fallback(table, payload, optional_fields=None):
    optional_fields = optional_fields or []
    payload = clean_payload(payload)
    try:
        return supabase.table(table).insert(payload).execute()
    except Exception as e:
        msg = str(e)
        if "PGRST204" in msg:
            fallback = {k:v for k,v in payload.items() if k not in optional_fields}
            return supabase.table(table).insert(fallback).execute()
        raise

# =========================
# TELEGRAM AUTH
# =========================
def verify_tg_init_data(init_data: str):
    if not init_data or not TELEGRAM_BOT_TOKEN:
        return None

    data = dict(parse_qsl(init_data))
    hash_recv = data.pop("hash", None)
    if not hash_recv:
        return None

    check_str = "\n".join(f"{k}={v}" for k,v in sorted(data.items()))
    secret = hmac.new(
        b"WebAppData",
        TELEGRAM_BOT_TOKEN.encode(),
        hashlib.sha256
    ).digest()

    hash_calc = hmac.new(secret, check_str.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(hash_calc, hash_recv):
        return None

    try:
        return json.loads(data.get("user","{}"))
    except:
        return None

# =========================
# ERRORS
# =========================
@app.errorhandler(RequestEntityTooLarge)
def too_large(e):
    return jsonify({"ok":False,"error":"Max 25MB"}), 413

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
        return {"ok":False},404
    return send_from_directory(BASE_DIR, path)

# =========================
# API: ME
# =========================
@app.get("/api/me")
def me():
    init_data = (
        request.headers.get("X-Tg-Init-Data")
        or request.args.get("initData")
        or ""
    )
    user = verify_tg_init_data(init_data)
    if not user:
        return {"me":{"name":"Guest","mode":"browser"}}

    return {
        "me":{
            "name": user.get("first_name"),
            "tg_user_id": str(user.get("id")),
            "username": user.get("username"),
            "mode":"telegram"
        }
    }

# =========================
# API: OWNERS
# =========================
@app.get("/api/owners")
def owners():
    res = supabase.table("owners").select("*").eq("org_id",ORG_ID).execute()
    return {"ok":True,"data":res.data or []}

@app.post("/api/owners")
def create_owner():
    d = request.get_json() or {}
    if not d.get("name"):
        return {"ok":False,"error":"name required"},400

    res = insert_with_optional_fallback(
        "owners",
        {
            "org_id":ORG_ID,
            "name":d["name"],
            "phone":d.get("phone"),
            "note":d.get("note")
        },
        optional_fields=["note"]
    )
    return {"ok":True,"data":res.data[0]}

# =========================
# API: PATIENTS
# =========================
@app.get("/api/patients")
def patients():
    owner_id = request.args.get("owner_id")
    q = supabase.table("patients").select("*").eq("org_id",ORG_ID)
    if owner_id:
        q = q.eq("owner_id", owner_id)
    res = q.execute()
    return {"ok":True,"data":res.data or []}

@app.post("/api/patients")
def create_patient():
    d = request.get_json() or {}
    if not d.get("owner_id") or not d.get("name"):
        return {"ok":False,"error":"owner_id & name required"},400

    res = insert_with_optional_fallback(
        "patients",
        {
            "org_id":ORG_ID,
            "owner_id":d["owner_id"],
            "name":d["name"],
            "species":d.get("species"),
            "breed":d.get("breed"),
            "age":d.get("age"),
            "weight_kg":d.get("weight_kg"),
            "notes":d.get("notes") or d.get("note")
        },
        optional_fields=["notes"]
    )
    return {"ok":True,"data":res.data[0]}