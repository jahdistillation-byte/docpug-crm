import os
import uuid
import hmac
import hashlib
import json
import mimetypes
import time
from urllib.parse import parse_qsl

from datetime import (
    datetime,
    timezone,
    timedelta,
)
from zoneinfo import ZoneInfo
from flask import (
    Flask,
    request,
    send_from_directory,
    jsonify,
    session,
    g,
)
from werkzeug.utils import secure_filename
from werkzeug.security import (
    generate_password_hash,
    check_password_hash,
)
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

SESSION_SECRET_KEY = os.getenv(
    "SESSION_SECRET_KEY"
)

if not SESSION_SECRET_KEY:
    raise RuntimeError(
        "Missing ENV var: SESSION_SECRET_KEY"
    )

app.config.update(
    SECRET_KEY=SESSION_SECRET_KEY,

    SESSION_COOKIE_NAME=(
        "docpug_session"
    ),

    SESSION_COOKIE_HTTPONLY=True,

    SESSION_COOKIE_SECURE=True,

    SESSION_COOKIE_SAMESITE="Lax",

    PERMANENT_SESSION_LIFETIME=(
        timedelta(hours=12)
    ),
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXT = {"pdf", "png", "jpg", "jpeg", "webp", "gif", "heic", "dcm"}

# =========================
# ДИНАМИЧЕСКИЙ ORG_ID (ИЗОЛЯЦИЯ КЛИНИК)
# =========================
def get_current_org_id():
    """
    Возвращает организацию только
    из защищённой серверной сессии.
    """

    org_id = session.get("org_id")

    if not org_id:
        return None

    return str(org_id).strip()


def get_current_user():
    """
    Возвращает текущего активного пользователя
    только по защищённой серверной сессии.

    Результат кэшируется в рамках одного HTTP-запроса,
    чтобы несколько проверок доступа не создавали
    повторные запросы к Supabase.
    """

    if getattr(
        g,
        "current_user_loaded",
        False,
    ):
        return getattr(
            g,
            "current_user",
            None,
        )

    g.current_user_loaded = True
    g.current_user = None

    try:
        user_id = session.get(
            "user_id"
        )

        org_id = session.get(
            "org_id"
        )

        if not user_id or not org_id:
            return None

        result = execute_with_retry(
            lambda: (
                supabase
                .table("clinic_users")
                .select(
                    "id, username, org_id, staff_id, "
                    "role, display_name, is_active, "
                    "must_change_password"
                )
                .eq(
                    "id",
                    str(user_id),
                )
                .eq(
                    "org_id",
                    str(org_id),
                )
                .limit(1)
            ),
            attempts=3,
            delay=0.25,
        )

        if not result.data:
            session.clear()
            return None

        user = result.data[0]

        if (
            user.get("is_active")
            is False
        ):
            session.clear()
            return None

        g.current_user = user

        return user

    except Exception as error:
        print(
            "⚠️ get_current_user failed:",
            repr(error),
        )

        g.current_user = None

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

# =====================================================
# ROLE-BASED ACCESS CONTROL
# =====================================================

CRM_ROLES = {
    "owner",
    "admin",
    "vet",
    "assistant",
}


def normalize_role(value):
    role = str(value or "").strip().lower()

    if role not in CRM_ROLES:
        return "vet"

    return role


def get_current_role():
    user = get_current_user()

    if not user:
        return None

    return normalize_role(
        user.get("role")
    )


def auth_required():
    """
    Проверяет наличие активной серверной сессии.
    """

    user = get_current_user()

    if not user:
        return None, fail(
            "Unauthorized",
            401,
        )

    return user, None


def roles_required(*allowed_roles):
    """
    Проверяет, что пользователь имеет одну
    из разрешённых ролей.
    """

    user, auth_error = auth_required()

    if auth_error:
        return None, auth_error

    role = normalize_role(
        user.get("role")
    )

    allowed = {
        normalize_role(item)
        for item in allowed_roles
    }

    if role not in allowed:
        return None, fail(
            "Access denied",
            403,
        )

    return user, None


def owner_or_admin_required():
    return roles_required(
        "owner",
        "admin",
    )


def self_or_manager_required(
    staff_id,
):
    """
    Owner/admin могут работать с любым профилем.
    Vet/assistant — только со своим staff_id.
    """

    user, auth_error = auth_required()

    if auth_error:
        return None, auth_error

    role = normalize_role(
        user.get("role")
    )

    if role in {
        "owner",
        "admin",
    }:
        return user, None

    current_staff_id = str(
        user.get("staff_id") or ""
    ).strip()

    requested_staff_id = str(
        staff_id or ""
    ).strip()

    if (
        not current_staff_id
        or current_staff_id
        != requested_staff_id
    ):
        return None, fail(
            "You can access only your own staff profile",
            403,
        )

    return user, None


def calendar_event_for_current_org(
    event_id,
):
    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return None

    result = execute_with_retry(
        lambda: (
            supabase
            .table("calendar_events")
            .select("*")
            .eq(
                "org_id",
                current_org,
            )
            .eq(
                "id",
                str(event_id),
            )
            .limit(1)
        ),
        attempts=3,
        delay=0.25,
    )

    if not result.data:
        return None

    return result.data[0]


def can_manage_calendar_staff(
    user,
    staff_id,
):
    """
    Owner/admin/assistant управляют календарём клиники.
    Vet управляет только своими записями.
    """

    role = normalize_role(
        user.get("role")
    )

    if role in {
        "owner",
        "admin",
        "assistant",
    }:
        return True

    current_staff_id = str(
        user.get("staff_id") or ""
    ).strip()

    target_staff_id = str(
        staff_id or ""
    ).strip()

    return bool(
        current_staff_id
        and current_staff_id
        == target_staff_id
    )
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

def execute_with_retry(query_factory, attempts=3, delay=0.25):
    """
    Повторяет временно неудавшийся запрос к Supabase.

    query_factory — функция, которая каждый раз создаёт новый query,
    потому что повторно использовать уже выполненный builder небезопасно.
    """
    last_error = None

    for attempt in range(attempts):
        try:
            return query_factory().execute()

        except Exception as e:
            last_error = e
            message = str(e).lower()

            transient_error = any(
                marker in message
                for marker in (
                    "resource temporarily unavailable",
                    "errno 11",
                    "temporarily unavailable",
                    "connection reset",
                    "connection aborted",
                    "connection refused",
                    "timed out",
                    "timeout",
                    "server disconnected",
                )
            )

            if not transient_error or attempt == attempts - 1:
                raise

            time.sleep(delay * (attempt + 1))

    raise last_error

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

def verify_tg_init_data(init_data: str):
    """
    Verifies Telegram Web App init data using HMAC-SHA256.
    Returns parsed user data or None if verification fails.
    """
    if not init_data or not TELEGRAM_BOT_TOKEN:
        return None

    try:
        # Parse init_data query string
        data_dict = dict(parse_qsl(init_data))
        
        # Extract and remove hash for verification
        hash_value = data_dict.pop("hash", "")
        if not hash_value:
            return None

        # Create data check string
        data_check_string = "\n".join(
            f"{k}={v}" for k, v in sorted(data_dict.items())
        )

        # Compute HMAC-SHA256
        secret_key = hmac.new(
            b"WebAppData",
            TELEGRAM_BOT_TOKEN.encode(),
            hashlib.sha256
        ).digest()

        computed_hash = hmac.new(
            secret_key,
            data_check_string.encode(),
            hashlib.sha256
        ).hexdigest()

        # Verify hash matches
        if computed_hash != hash_value:
            return None

        # Parse and return user data
        user_data = data_dict.get("user")
        if user_data:
            return json.loads(user_data)

        return None

    except Exception as e:
        print("⚠️ verify_tg_init_data failed:", repr(e))
        return None


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
            stock_by_visit.setdefault(
    vid,
    []
).append({
    "id": r.get("id"),

    "stockId": (
        r.get("stock_id")
        or r.get("stockId")
    ),

    "qty": (
        r.get("qty")
        or 1
    ),

    "priceSnap": (
        r.get("price_snap")
        or r.get("priceSnap")
    ),

    "nameSnap": (
        r.get("name_snap")
        or r.get("nameSnap")
    ),

    "inventorySynced": (
        r.get("inventory_synced")
        is True
    ),

    "inventory_synced": (
        r.get("inventory_synced")
        is True
    ),
})
            
    except Exception:
        pass

    return services_by_visit, stock_by_visit


def save_visit_lines(visit_id: str, d: dict):
    services = _as_list(_pick_services_from_payload(d))
    stock = _as_list(_pick_stock_from_payload(d))
    current_org = get_current_org_id()

    if not current_org:
        raise RuntimeError("Organization not selected")

    # =====================================================
    # УДАЛЯЕМ СТАРЫЕ УСЛУГИ
    # =====================================================

    try:
        execute_with_retry(
            lambda: (
                supabase
                .table("visit_services")
                .delete()
                .eq("org_id", current_org)
                .eq("visit_id", visit_id)
            )
        )

    except Exception as e:
        message = str(e).lower()

        if (
            "42703" not in message
            and "org_id does not exist" not in message
            and "column visit_services.org_id does not exist" not in message
        ):
            raise

        execute_with_retry(
            lambda: (
                supabase
                .table("visit_services")
                .delete()
                .eq("visit_id", visit_id)
            )
        )

    # =====================================================
    # УДАЛЯЕМ СТАРЫЕ ПРЕПАРАТЫ
    # =====================================================

    try:
        execute_with_retry(
            lambda: (
                supabase
                .table("visit_stock")
                .delete()
                .eq("org_id", current_org)
                .eq("visit_id", visit_id)
            )
        )

    except Exception as e:
        message = str(e).lower()

        if (
            "42703" not in message
            and "org_id does not exist" not in message
            and "column visit_stock.org_id does not exist" not in message
        ):
            raise

        execute_with_retry(
            lambda: (
                supabase
                .table("visit_stock")
                .delete()
                .eq("visit_id", visit_id)
            )
        )

    # =====================================================
    # СОХРАНЯЕМ УСЛУГИ
    # =====================================================

    service_rows = []

    for item in services:
        if not isinstance(item, dict):
            continue

        service_id = (
            item.get("serviceId")
            or item.get("service_id")
        )

        if not service_id:
            continue

        service_rows.append({
    "visit_id": visit_id,
    "service_id": service_id,
    "qty": item.get("qty") or 1,
    "price_snap": (
        item.get("priceSnap")
        if item.get("priceSnap") is not None
        else item.get("price_snap")
    ),
    "name_snap": (
        item.get("nameSnap")
        or item.get("name_snap")
    ),
})

    if service_rows:
        execute_with_retry(
            lambda: (
                supabase
                .table("visit_services")
                .insert(clean_payload(service_rows))
            )
        )

    # =====================================================
    # СОХРАНЯЕМ ПРЕПАРАТЫ
    # =====================================================

    stock_rows = []

    for item in stock:
        if not isinstance(item, dict):
            continue

        stock_id = (
            item.get("stockId")
            or item.get("stock_id")
        )

        if not stock_id:
            continue

        stock_rows.append({
    "visit_id": visit_id,

    "stock_id": stock_id,

    "qty": (
        item.get("qty")
        or item.get("quantity")
        or 1
    ),

    "price_snap": (
        item.get("priceSnap")
        if item.get("priceSnap")
        is not None
        else item.get("price_snap")
    ),

    "name_snap": (
        item.get("nameSnap")
        or item.get("name_snap")
    ),

    "inventory_synced": (
        item.get("inventorySynced")
        is True
        or item.get("inventory_synced")
        is True
    ),
})

    if stock_rows:
        execute_with_retry(
            lambda: (
                supabase
                .table("visit_stock")
                .insert(clean_payload(stock_rows))
            )
        )

@app.before_request
def protect_api_routes():
    """
    Все API, кроме входа и проверки сессии,
    требуют активную серверную сессию.
    """

    path = str(
        request.path or ""
    )

    if not path.startswith("/api/"):
        return None

    public_api_paths = {
        "/api/login",
        "/api/session",
        "/api/logout",
        "/api/me",
    }

    if path in public_api_paths:
        return None

    user = get_current_user()

    if not user:
        return fail(
            "Unauthorized",
            401,
        )

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


@app.get("/<path:path>")
def static_any(path):
    if path.startswith("api/") or path.startswith("uploads/"):
        return fail("Not found", 404)
    return send_from_directory(BASE_DIR, path)

# =========================
# API: ORGANIZATION PROFILE
# =========================

CLINIC_PROFILE_FIELDS = [
    "id",
    "name",
    "theme",
    "subtitle",
    "logo_url",
    "phone",
    "address",
    "website",
    "document_accent_color",
    "doctor_signature_url",
    "clinic_stamp_url",
    "document_footer",
    "updated_at",
]

CLINIC_THEMES = {
    "purple",
    "black",
    "white",
    "blue",
    "green",
}


@app.get("/api/organization/profile")
def api_get_organization_profile():
    """
    Получить профиль текущей клиники.

    Чтение доступно всем сотрудникам текущей организации,
    потому что профиль нужен для формирования документов.
    """
    try:
        current_org = get_current_org_id()

        if not current_org:
            return fail("Organization not selected", 400)

        res = execute_with_retry(
    lambda: (
        supabase
        .table("orgs")
        .select(
            ", ".join(
                CLINIC_PROFILE_FIELDS
            )
        )
        .eq(
            "id",
            current_org,
        )
        .limit(1)
    ),
    attempts=3,
    delay=0.25,
)

        if not res.data:
            return fail("Organization not found", 404)

        profile = res.data[0]

        profile["name"] = (
            profile.get("name")
            or "Ветеринарна клініка"
        )

        profile["subtitle"] = (
            profile.get("subtitle")
            or "Ветеринарна клініка"
        )

        profile["document_accent_color"] = (
            profile.get("document_accent_color")
            or "#9346E8"
        )

        profile["document_footer"] = (
            profile.get("document_footer")
            or "Коли важливо — ми поруч."
        )

        return ok(profile)

    except Exception as e:
        print(
            "❌ /api/organization/profile GET error:",
            repr(e)
        )

        return fail(
            f"Cannot load organization profile: {e}",
            500
        )


@app.put("/api/organization/profile")
def api_update_organization_profile():
    """
    Изменить профиль клиники может только владелец.
    """
    try:
        current_user, auth_error = owner_required()

        if auth_error:
            return auth_error

        current_org = get_current_org_id()

        if not current_org:
            return fail("Organization not selected", 400)

        data = request.get_json(silent=True) or {}

        allowed_fields = [
            "name",
            "subtitle",
            "logo_url",
            "phone",
            "address",
            "website",
            "document_accent_color",
            "doctor_signature_url",
            "clinic_stamp_url",
            "document_footer",
        ]

        payload = {
            key: data.get(key)
            for key in allowed_fields
            if key in data
        }

        # Текстовые поля очищаем от лишних пробелов.
        for key, value in list(payload.items()):
            if isinstance(value, str):
                payload[key] = value.strip()

        clinic_name = payload.get("name")

        if clinic_name is not None and not clinic_name:
            return fail("Clinic name required", 400)

        accent_color = payload.get(
            "document_accent_color"
        )

        if accent_color:
            accent_color = accent_color.upper()

            if (
                len(accent_color) != 7
                or not accent_color.startswith("#")
            ):
                return fail(
                    "Invalid document accent color",
                    400
                )

            try:
                int(accent_color[1:], 16)
            except ValueError:
                return fail(
                    "Invalid document accent color",
                    400
                )

            payload["document_accent_color"] = (
                accent_color
            )

        if not payload:
            return fail("Nothing to update", 400)

        payload["updated_at"] = (
            datetime.now(timezone.utc).isoformat()
        )

        res = (
            supabase.table("orgs")
            .update(payload)
            .eq("id", current_org)
            .execute()
        )

        if not res.data:
            return fail("Organization not found", 404)

        return ok(res.data[0])

    except Exception as e:
        print(
            "❌ /api/organization/profile PUT error:",
            repr(e)
        )

        return fail(
            f"Cannot update organization profile: {e}",
            500
        )


@app.put("/api/organization/theme")
def api_update_organization_theme():
    """Save the visual theme for the current clinic."""
    try:
        _current_user, auth_error = owner_required()

        if auth_error:
            return auth_error

        current_org = get_current_org_id()

        if not current_org:
            return fail("Organization not selected", 400)

        data = request.get_json(silent=True) or {}
        theme = str(data.get("theme") or "").strip().lower()

        if theme not in CLINIC_THEMES:
            return fail("Invalid clinic theme", 400)

        result = (
            supabase
            .table("orgs")
            .update({
                "theme": theme,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            .eq("id", current_org)
            .execute()
        )

        if not result.data:
            return fail("Organization not found", 404)

        return ok({"theme": theme})

    except Exception as error:
        print(
            "❌ /api/organization/theme PUT error:",
            repr(error),
        )

        return fail("Cannot update clinic theme", 500)
# =========================
# API: SERVER SESSION
# =========================

@app.get("/api/session")
def api_get_session():
    """
    Проверяет защищённую серверную сессию
    и возвращает данные текущего пользователя.
    """

    try:
        user = get_current_user()

        if not user:
            session.clear()

            return jsonify({
                "ok": False,
                "authenticated": False,
                "error": "Unauthorized",
            }), 401

        org_id = user.get("org_id")
        clinic_name = "Клініка"
        theme = "purple"

        if org_id:
            try:
                org_result = (
                    supabase
                    .table("orgs")
                    .select("name, theme")
                    .eq("id", str(org_id))
                    .limit(1)
                    .execute()
                )

                if org_result.data:
                    clinic_name = (
                        org_result.data[0].get("name")
                        or clinic_name
                    )
                    theme = (
                        org_result.data[0].get("theme")
                        or theme
                    )

            except Exception as org_error:
                print(
                    "⚠️ /api/session clinic load failed:",
                    repr(org_error),
                )

        return jsonify({
            "ok": True,
            "authenticated": True,
            "data": {
                "user_id": user.get("id"),

                "org_id": org_id,

                "staff_id": user.get("staff_id"),

                "username": (
                    user.get("username")
                    or ""
                ),

                "display_name": (
                    user.get("display_name")
                    or user.get("username")
                    or "Користувач"
                ),

                "role": (
                    user.get("role")
                    or "vet"
                ),

                "clinic_name": clinic_name,

                "theme": theme,

                "must_change_password": bool(
                    user.get(
                        "must_change_password"
                    )
                ),
            },
        })

    except Exception as error:
        print(
            "❌ /api/session error:",
            repr(error),
        )

        return jsonify({
            "ok": False,
            "authenticated": False,
            "error": "Помилка перевірки сесії",
        }), 500
@app.post("/api/change-password")
def api_change_password():
    """
    Меняет пароль текущего авторизованного пользователя.
    После успешной смены снимает флаг обязательной смены.
    """

    user = get_current_user()

    if not user:
        return jsonify({
            "ok": False,
            "error": "Сесію завершено. Увійдіть повторно.",
        }), 401

    data = request.get_json(silent=True) or {}

    current_password = str(
        data.get("current_password") or ""
    )

    new_password = str(
        data.get("new_password") or ""
    )

    confirm_password = str(
        data.get("confirm_password") or ""
    )

    if not current_password:
        return jsonify({
            "ok": False,
            "error": "Введіть поточний пароль.",
        }), 400

    if len(new_password) < 8:
        return jsonify({
            "ok": False,
            "error": (
                "Новий пароль повинен містити "
                "щонайменше 8 символів."
            ),
        }), 400

    if new_password != confirm_password:
        return jsonify({
            "ok": False,
            "error": "Нові паролі не збігаються.",
        }), 400

    if current_password == new_password:
        return jsonify({
            "ok": False,
            "error": (
                "Новий пароль повинен "
                "відрізнятися від поточного."
            ),
        }), 400

    try:
        user_id = str(user.get("id"))
        org_id = str(user.get("org_id"))

        result = (
            supabase
            .table("clinic_users")
            .select(
                "id, password_hash, is_active"
            )
            .eq("id", user_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute()
        )

        if not result.data:
            session.clear()

            return jsonify({
                "ok": False,
                "error": "Користувача не знайдено.",
            }), 404

        account = result.data[0]

        if account.get("is_active") is False:
            session.clear()

            return jsonify({
                "ok": False,
                "error": "Обліковий запис вимкнений.",
            }), 403

        stored_hash = str(
            account.get("password_hash") or ""
        ).strip()

        if not stored_hash:
            return jsonify({
                "ok": False,
                "error": "Поточний пароль не налаштований.",
            }), 400

        try:
            current_password_valid = (
                check_password_hash(
                    stored_hash,
                    current_password,
                )
            )
        except Exception as hash_error:
            print(
                "⚠️ change password hash check failed:",
                repr(hash_error),
            )

            current_password_valid = False

        if not current_password_valid:
            return jsonify({
                "ok": False,
                "error": "Поточний пароль введено неправильно.",
            }), 401

        new_password_hash = (
            generate_password_hash(
                new_password
            )
        )

        now_iso = (
            datetime
            .now(timezone.utc)
            .isoformat()
        )

        update_result = (
            supabase
            .table("clinic_users")
            .update({
                "password_hash": new_password_hash,
                "must_change_password": False,
                "updated_at": now_iso,
            })
            .eq("id", user_id)
            .eq("org_id", org_id)
            .execute()
        )

        if not update_result.data:
            return jsonify({
                "ok": False,
                "error": "Не вдалося оновити пароль.",
            }), 500

        session["must_change_password"] = False
        session.modified = True

        return jsonify({
            "ok": True,
            "data": {
                "must_change_password": False,
            },
        })

    except Exception as error:
        print(
            "❌ /api/change-password error:",
            repr(error),
        )

        return jsonify({
            "ok": False,
            "error": "Не вдалося змінити пароль.",
        }), 500

@app.post("/api/logout")
def api_logout():
    """
    Завершает текущую серверную сессию.
    Flask самостоятельно удалит session-cookie
    после session.clear().
    """

    session.clear()

    return jsonify({
        "ok": True,
        "authenticated": False,
    })
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
        res_org = supabase.table("orgs").select("name, theme").eq("id", current_org).execute()
        if res_org.data:
            clinic_name = res_org.data[0].get("name", clinic_name)
            theme = res_org.data[0].get("theme") or theme
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
# STOCK API
# =========================

def stock_number(value, default=0):
    try:
        return max(
            0,
            float(
                value
                if value is not None
                else default
            )
        )
    except (
        TypeError,
        ValueError,
    ):
        return float(default)


def serialize_stock_item(row):
    if not row:
        return None

    return {
        "id": str(row.get("id") or ""),
        "name": row.get("name") or "Позиція",

        "group": (
            row.get("group_id")
            or "other"
        ),

        "category": (
            row.get("category")
            or "Інше"
        ),

        "form": (
            row.get("dosage_form")
            or "Інше"
        ),

        "route": (
            row.get("administration_route")
            or "Не застосовується"
        ),

        "species": (
            row.get("target_species")
            or "Універсальний"
        ),

        "unit": row.get("unit") or "шт",

        "price": stock_number(
            row.get("price")
        ),

        "cost": stock_number(
            row.get("purchase_price")
        ),

        "qty": stock_number(
            row.get("qty")
        ),

        "min_qty": stock_number(
            row.get("minimum_qty"),
            5
        ),

        "active": (
            row.get("active")
            is not False
        ),

        "created_at": row.get(
            "created_at"
        ),

        "updated_at": row.get(
            "updated_at"
        ),
    }


@app.get("/api/stock")
def api_get_stock():
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    try:
        result = (
            supabase
            .table("stock")
            .select("*")
            .eq("org_id", current_org)
            .order("name")
            .execute()
        )

        items = [
            serialize_stock_item(row)
            for row in (
                result.data or []
            )
        ]

        return ok(items)

    except Exception as error:
        print(
            "❌ GET /api/stock:",
            repr(error)
        )

        return fail(
            "Не вдалося завантажити склад.",
            500
        )


@app.post("/api/stock")
def api_create_stock_item():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    name = str(
        data.get("name") or ""
    ).strip()

    if not name:
        return fail(
            "Вкажіть назву позиції.",
            400
        )

    current_org = get_current_org_id()

    payload = {
        "org_id": current_org,
        "name": name,

        "group_id": (
            str(
                data.get("group")
                or data.get("group_id")
                or "other"
            )
        ),

        "category": (
            str(
                data.get("category")
                or "Інше"
            )
        ),

        "dosage_form": (
            str(
                data.get("form")
                or data.get("dosage_form")
                or "Інше"
            )
        ),

        "administration_route": (
            str(
                data.get("route")
                or data.get(
                    "administration_route"
                )
                or "Не застосовується"
            )
        ),

        "target_species": (
            str(
                data.get("species")
                or data.get(
                    "target_species"
                )
                or "Універсальний"
            )
        ),

        "unit": str(
            data.get("unit") or "шт"
        ),

        "price": stock_number(
            data.get("price")
        ),

        "purchase_price": stock_number(
            data.get("cost")
            if data.get("cost") is not None
            else data.get(
                "purchase_price"
            )
        ),

        "qty": stock_number(
            data.get("qty")
        ),

        "minimum_qty": stock_number(
            data.get("min_qty")
            if data.get("min_qty")
            is not None
            else data.get(
                "minimum_qty"
            ),
            5
        ),

        "active": (
            data.get("active")
            is not False
        ),

        "updated_at": (
            datetime
            .now(timezone.utc)
            .isoformat()
        ),
    }

    try:
        result = (
            supabase
            .table("stock")
            .insert(payload)
            .execute()
        )

        row = (
            result.data[0]
            if result.data
            else payload
        )

        return ok(
            serialize_stock_item(row)
        )

    except Exception as error:
        print(
            "❌ POST /api/stock:",
            repr(error)
        )

        return fail(
            "Не вдалося додати позицію.",
            500
        )


@app.put("/api/stock/<stock_id>")
def api_update_stock_item(stock_id):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    if not stock_id:
        return fail(
            "stock_id required",
            400
        )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    field_map = {
        "name": "name",
        "group": "group_id",
        "group_id": "group_id",
        "category": "category",
        "form": "dosage_form",
        "dosage_form": "dosage_form",
        "route": "administration_route",
        "administration_route":
            "administration_route",
        "species": "target_species",
        "target_species":
            "target_species",
        "unit": "unit",
        "price": "price",
        "cost": "purchase_price",
        "purchase_price":
            "purchase_price",
        "qty": "qty",
        "min_qty": "minimum_qty",
        "minimum_qty":
            "minimum_qty",
        "active": "active",
    }

    numeric_fields = {
        "price",
        "purchase_price",
        "qty",
        "minimum_qty",
    }

    payload = {}

    for source_field, db_field in (
        field_map.items()
    ):
        if source_field not in data:
            continue

        value = data.get(
            source_field
        )

        if db_field in numeric_fields:
            value = stock_number(value)

        elif db_field == "active":
            value = value is not False

        elif value is not None:
            value = str(value).strip()

        payload[db_field] = value

    if "name" in payload:
        if not payload["name"]:
            return fail(
                "Вкажіть назву позиції.",
                400
            )

    if not payload:
        return fail(
            "Немає змін для збереження.",
            400
        )

    payload["updated_at"] = (
        datetime
        .now(timezone.utc)
        .isoformat()
    )

    current_org = get_current_org_id()

    try:
        result = (
            supabase
            .table("stock")
            .update(payload)
            .eq("org_id", current_org)
            .eq("id", stock_id)
            .execute()
        )

        if not result.data:
            return fail(
                "Позицію не знайдено.",
                404
            )

        return ok(
            serialize_stock_item(
                result.data[0]
            )
        )

    except Exception as error:
        print(
            "❌ PUT /api/stock:",
            repr(error)
        )

        return fail(
            "Не вдалося оновити позицію.",
            500
        )


@app.delete("/api/stock/<stock_id>")
def api_delete_stock_item(stock_id):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    if not stock_id:
        return fail(
            "stock_id required",
            400
        )

    current_org = get_current_org_id()

    try:
        result = (
            supabase
            .table("stock")
            .delete()
            .eq("org_id", current_org)
            .eq("id", stock_id)
            .execute()
        )

        if not result.data:
            return fail(
                "Позицію не знайдено.",
                404
            )

        return ok(True)

    except Exception as error:
        print(
            "❌ DELETE /api/stock:",
            repr(error)
        )

        return fail(
            "Не вдалося видалити позицію.",
            500
        )


@app.post("/api/stock/<stock_id>/adjust")
def api_adjust_stock_item(stock_id):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    movement_type = str(
        data.get("movement_type")
        or data.get("mode")
        or ""
    ).strip().lower()

    if movement_type not in {
        "income",
        "writeoff",
    }:
        return fail(
            "Невірний тип руху.",
            400
        )

    quantity = stock_number(
        data.get("quantity")
        if data.get("quantity")
        is not None
        else data.get("qty")
    )

    if quantity <= 0:
        return fail(
            "Кількість повинна бути більшою за нуль.",
            400
        )

    current_org = get_current_org_id()

    try:
        item_result = (
            supabase
            .table("stock")
            .select("*")
            .eq("org_id", current_org)
            .eq("id", stock_id)
            .limit(1)
            .execute()
        )

        if not item_result.data:
            return fail(
                "Позицію не знайдено.",
                404
            )

        item = item_result.data[0]

        quantity_before = stock_number(
            item.get("qty")
        )

        if (
            movement_type == "writeoff"
            and quantity > quantity_before
        ):
            return fail(
                "Недостатньо товару на складі.",
                409
            )

        if movement_type == "income":
            quantity_after = (
                quantity_before + quantity
            )
        else:
            quantity_after = (
                quantity_before - quantity
            )

        now_iso = (
            datetime
            .now(timezone.utc)
            .isoformat()
        )

        update_result = (
            supabase
            .table("stock")
            .update({
                "qty": quantity_after,
                "updated_at": now_iso,
            })
            .eq("org_id", current_org)
            .eq("id", stock_id)
            .execute()
        )

        if not update_result.data:
            return fail(
                "Не вдалося оновити залишок.",
                500
            )

        try:
            (
                supabase
                .table("stock_movements")
                .insert({
                    "org_id": current_org,
                    "stock_id": stock_id,
                    "created_by": (
                        user.get("id")
                    ),
                    "movement_type":
                        movement_type,
                    "quantity": quantity,
                    "quantity_before":
                        quantity_before,
                    "quantity_after":
                        quantity_after,
                    "unit_cost":
                        stock_number(
                            item.get(
                                "purchase_price"
                            )
                        ),
                    "name_snap":
                        item.get("name"),
                    "comment": str(
                        data.get("comment")
                        or ""
                    ).strip(),
                })
                .execute()
            )

        except Exception:
            (
                supabase
                .table("stock")
                .update({
                    "qty": quantity_before,
                    "updated_at": now_iso,
                })
                .eq("org_id", current_org)
                .eq("id", stock_id)
                .execute()
            )

            raise

        return ok(
            serialize_stock_item(
                update_result.data[0]
            )
        )

    except Exception as error:
        print(
            "❌ POST /api/stock adjust:",
            repr(error)
        )

        return fail(
            "Не вдалося змінити залишок.",
            500
        )

@app.post("/api/visits/<visit_id>/stock")
def api_add_stock_to_visit(
    visit_id
):
    user, auth_error = (
        auth_required()
    )

    if auth_error:
        return auth_error

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    stock_id = str(
        data.get("stock_id")
        or data.get("stockId")
        or ""
    ).strip()

    quantity = stock_number(
        data.get("quantity")
        if data.get("quantity")
        is not None
        else data.get("qty")
    )

    if not stock_id:
        return fail(
            "Оберіть препарат.",
            400
        )

    if quantity <= 0:
        return fail(
            "Кількість повинна бути більшою за нуль.",
            400
        )

    current_org = (
        get_current_org_id()
    )

    line_id = None
    quantity_before = None
    quantity_after = None
    stock_was_updated = False

    try:
        visit_result = (
            supabase
            .table("visits")
            .select("id")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                visit_id
            )
            .limit(1)
            .execute()
        )

        if not visit_result.data:
            return fail(
                "Візит не знайдено.",
                404
            )

        stock_result = (
            supabase
            .table("stock")
            .select("*")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                stock_id
            )
            .limit(1)
            .execute()
        )

        if not stock_result.data:
            return fail(
                "Позицію складу не знайдено.",
                404
            )

        stock_item = (
            stock_result.data[0]
        )

        if (
            stock_item.get("active")
            is False
        ):
            return fail(
                "Ця позиція неактивна.",
                409
            )

        quantity_before = (
            stock_number(
                stock_item.get("qty")
            )
        )

        if quantity > quantity_before:
            return fail(
                (
                    "Недостатньо препарату. "
                    f"На складі: "
                    f"{quantity_before} "
                    f"{stock_item.get('unit') or 'шт'}."
                ),
                409
            )

        quantity_after = (
            quantity_before
            - quantity
        )

        price_snap = stock_number(
            data.get("price_snap")
            if data.get("price_snap")
            is not None
            else stock_item.get("price")
        )

        name_snap = str(
            stock_item.get("name")
            or "Позиція"
        ).strip()

        line_result = (
            supabase
            .table("visit_stock")
            .insert({
                "visit_id": visit_id,
                "stock_id": stock_id,
                "qty": quantity,
                "price_snap": price_snap,
                "name_snap": name_snap,
                "inventory_synced": True,
            })
            .execute()
        )

        if not line_result.data:
            return fail(
                "Не вдалося додати препарат у візит.",
                500
            )

        line_row = (
            line_result.data[0]
        )

        line_id = line_row.get("id")

        now_iso = (
            datetime
            .now(timezone.utc)
            .isoformat()
        )

        update_result = (
            supabase
            .table("stock")
            .update({
                "qty": quantity_after,
                "updated_at": now_iso,
            })
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                stock_id
            )
            .eq(
                "qty",
                quantity_before
            )
            .execute()
        )

        if not update_result.data:
            if line_id:
                (
                    supabase
                    .table("visit_stock")
                    .delete()
                    .eq(
                        "id",
                        line_id
                    )
                    .execute()
                )

            return fail(
                (
                    "Залишок змінився. "
                    "Оновіть сторінку та повторіть."
                ),
                409
            )

        stock_was_updated = True

        try:
            (
                supabase
                .table("stock_movements")
                .insert({
                    "org_id": current_org,
                    "stock_id": stock_id,
                    "visit_id": visit_id,
                    "created_by": (
                        user.get("id")
                    ),
                    "movement_type":
    "writeoff",
                    "quantity": quantity,
                    "quantity_before":
                        quantity_before,
                    "quantity_after":
                        quantity_after,
                    "unit_cost":
                        stock_number(
                            stock_item.get(
                                "purchase_price"
                            )
                        ),
                    "name_snap":
                        name_snap,
                    "comment":
                        "Списано у візит",
                })
                .execute()
            )

        except Exception:
            if stock_was_updated:
                (
                    supabase
                    .table("stock")
                    .update({
                        "qty":
                            quantity_before,
                        "updated_at":
                            now_iso,
                    })
                    .eq(
                        "org_id",
                        current_org
                    )
                    .eq(
                        "id",
                        stock_id
                    )
                    .eq(
                        "qty",
                        quantity_after
                    )
                    .execute()
                )

            if line_id:
                (
                    supabase
                    .table("visit_stock")
                    .delete()
                    .eq(
                        "id",
                        line_id
                    )
                    .execute()
                )

            raise

        return ok({
    "line": {
        "id": line_id,

        "stockId": stock_id,
        "stock_id": stock_id,

        "qty": quantity,
        "quantity": quantity,

        "priceSnap": price_snap,
        "price_snap": price_snap,

        "nameSnap": name_snap,
        "name_snap": name_snap,

        "unitSnap": (
            stock_item.get("unit")
            or "шт"
        ),

        "inventorySynced": True,
        "inventory_synced": True,
    },

    "stock": (
        serialize_stock_item(
            update_result.data[0]
        )
    ),
})

    except Exception as error:
        print(
            "❌ Add stock to visit:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося списати препарат у візит.",
            500
        )
    
@app.delete(
    "/api/visits/<visit_id>/stock/<line_id>"
)
def api_remove_stock_from_visit(
    visit_id,
    line_id,
):
    user, auth_error = (
        auth_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    line_row = None
    line_deleted = False
    stock_updated = False

    quantity_before = None
    quantity_after = None
    stock_id = None
    now_iso = None

    try:
        visit_result = (
            supabase
            .table("visits")
            .select("id")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                visit_id
            )
            .limit(1)
            .execute()
        )

        if not visit_result.data:
            return fail(
                "Візит не знайдено.",
                404
            )

        line_result = (
            supabase
            .table("visit_stock")
            .select("*")
            .eq(
                "visit_id",
                visit_id
            )
            .eq(
                "id",
                line_id
            )
            .limit(1)
            .execute()
        )

        if not line_result.data:
            return fail(
                "Препарат у візиті не знайдено.",
                404
            )

        line_row = (
            line_result.data[0]
        )

        inventory_synced = (
            line_row.get(
                "inventory_synced"
            )
            is True
        )

        # Стара строка не списывала склад.
        # Просто удаляем её без возврата.
        if not inventory_synced:
            delete_result = (
                supabase
                .table("visit_stock")
                .delete()
                .eq(
                    "visit_id",
                    visit_id
                )
                .eq(
                    "id",
                    line_id
                )
                .execute()
            )

            if not delete_result.data:
                return fail(
                    "Не вдалося видалити препарат.",
                    500
                )

            return ok({
                "restored": False,
                "stock": None,
            })

        stock_id = str(
            line_row.get("stock_id")
            or ""
        ).strip()

        quantity = stock_number(
            line_row.get("qty")
        )

        if (
            not stock_id
            or quantity <= 0
        ):
            return fail(
                "Некоректний рядок препарату.",
                409
            )

        stock_result = (
            supabase
            .table("stock")
            .select("*")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                stock_id
            )
            .limit(1)
            .execute()
        )

        if not stock_result.data:
            return fail(
                "Позицію складу не знайдено.",
                404
            )

        stock_item = (
            stock_result.data[0]
        )

        quantity_before = (
            stock_number(
                stock_item.get("qty")
            )
        )

        quantity_after = (
            quantity_before
            + quantity
        )

        now_iso = (
            datetime
            .now(timezone.utc)
            .isoformat()
        )

        delete_result = (
            supabase
            .table("visit_stock")
            .delete()
            .eq(
                "visit_id",
                visit_id
            )
            .eq(
                "id",
                line_id
            )
            .execute()
        )

        if not delete_result.data:
            return fail(
                "Не вдалося видалити препарат.",
                500
            )

        line_deleted = True

        update_result = (
            supabase
            .table("stock")
            .update({
                "qty": quantity_after,
                "updated_at": now_iso,
            })
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                stock_id
            )
            .eq(
                "qty",
                quantity_before
            )
            .execute()
        )

        if not update_result.data:
            raise RuntimeError(
                "Stock quantity changed"
            )

        stock_updated = True

        (
            supabase
            .table("stock_movements")
            .insert({
                "org_id": current_org,
                "stock_id": stock_id,
                "visit_id": visit_id,
                "created_by": (
                    user.get("id")
                ),
                "movement_type":
                    "income",
                "quantity": quantity,
                "quantity_before":
                    quantity_before,
                "quantity_after":
                    quantity_after,
                "unit_cost":
                    stock_number(
                        stock_item.get(
                            "purchase_price"
                        )
                    ),
                "name_snap": (
                    line_row.get(
                        "name_snap"
                    )
                    or stock_item.get(
                        "name"
                    )
                ),
                "comment":
                    "Повернено після видалення з візиту",
            })
            .execute()
        )

        return ok({
            "restored": True,

            "stock":
                serialize_stock_item(
                    update_result.data[0]
                ),
        })

    except Exception as error:
        # Если возврат сорвался,
        # возвращаем состояние обратно.
        if (
            stock_updated
            and stock_id
            and quantity_before
            is not None
        ):
            try:
                (
                    supabase
                    .table("stock")
                    .update({
                        "qty":
                            quantity_before,
                        "updated_at":
                            now_iso,
                    })
                    .eq(
                        "org_id",
                        current_org
                    )
                    .eq(
                        "id",
                        stock_id
                    )
                    .eq(
                        "qty",
                        quantity_after
                    )
                    .execute()
                )
            except Exception:
                pass

        if (
            line_deleted
            and line_row
        ):
            try:
                (
                    supabase
                    .table("visit_stock")
                    .insert(
                        line_row
                    )
                    .execute()
                )
            except Exception:
                pass

        print(
            "❌ Remove stock from visit:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося повернути препарат на склад.",
            500
        )    
    
# =====================================================
# FINANCE API
# =====================================================

def finance_number(
    value,
    default=0
):
    try:
        return round(
            float(
                value
                if value is not None
                else default
            ),
            2
        )
    except (
        TypeError,
        ValueError,
    ):
        return round(
            float(default),
            2
        )


def serialize_finance_transaction(
    row
):
    if not row:
        return None

    return {
        "id": str(
            row.get("id")
            or ""
        ),

        "visit_id": (
            str(row.get("visit_id"))
            if row.get("visit_id")
            else None
        ),

        "cash_shift_id": (
            str(
                row.get(
                    "cash_shift_id"
                )
            )
            if row.get(
                "cash_shift_id"
            )
            else None
        ),

        "created_by": (
            str(
                row.get("created_by")
            )
            if row.get("created_by")
            else None
        ),

        "transaction_type":
            row.get(
                "transaction_type"
            ),

        "payment_method":
            row.get(
                "payment_method"
            ),

        "status":
            row.get("status"),

        "source":
            row.get("source"),

        "category":
            row.get("category"),

        "amount":
            finance_number(
                row.get("amount")
            ),

        "currency":
            row.get("currency")
            or "UAH",

        "description":
            row.get("description")
            or "",

        "external_provider":
            row.get(
                "external_provider"
            ),

        "external_reference":
            row.get(
                "external_reference"
            ),

        "occurred_at":
            row.get("occurred_at"),

        "created_at":
            row.get("created_at"),
    }


@app.get(
    "/api/visits/<visit_id>/finance"
)
def api_get_visit_finance(
    visit_id
):
    user, auth_error = (
    owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    try:
        visit_result = (
            supabase
            .table("visits")
            .select("*")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                visit_id
            )
            .limit(1)
            .execute()
        )

        if not visit_result.data:
            return fail(
                "Візит не знайдено.",
                404
            )

        visit = (
            visit_result.data[0]
        )

        services_result = (
            supabase
            .table("visit_services")
            .select(
                "qty,price_snap"
            )
            .eq(
                "visit_id",
                visit_id
            )
            .execute()
        )

        stock_result = (
            supabase
            .table("visit_stock")
            .select(
                "qty,price_snap"
            )
            .eq(
                "visit_id",
                visit_id
            )
            .execute()
        )

        transactions_result = (
            supabase
            .table(
                "finance_transactions"
            )
            .select("*")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "visit_id",
                visit_id
            )
            .order(
                "occurred_at",
                desc=True
            )
            .execute()
        )

        service_total = sum(
            finance_number(
                row.get("qty")
            )
            * finance_number(
                row.get("price_snap")
            )
            for row in (
                services_result.data
                or []
            )
        )

        stock_total = sum(
            finance_number(
                row.get("qty")
            )
            * finance_number(
                row.get("price_snap")
            )
            for row in (
                stock_result.data
                or []
            )
        )

        subtotal = (
            service_total
            + stock_total
        )

        discount = max(
            0,
            finance_number(
                visit.get(
                    "discount_amount"
                )
            )
        )

        total = max(
            0,
            subtotal - discount
        )

        transactions = (
            transactions_result.data
            or []
        )

        paid = 0

        for row in transactions:
            if (
                row.get("status")
                != "completed"
            ):
                continue

            amount = finance_number(
                row.get("amount")
            )

            if (
                row.get(
                    "transaction_type"
                )
                == "payment"
            ):
                paid += amount

            elif (
                row.get(
                    "transaction_type"
                )
                == "refund"
            ):
                paid -= amount

        paid = max(
            0,
            finance_number(paid)
        )

        remaining = max(
            0,
            finance_number(
                total - paid
            )
        )

        stored_status = str(
            visit.get(
                "financial_status"
            )
            or ""
        )

        if stored_status in {
            "refunded",
            "cancelled",
        }:
            financial_status = (
                stored_status
            )

        elif total > 0 and remaining <= 0:
            financial_status = (
                "paid"
            )

        elif paid > 0:
            financial_status = (
                "partial"
            )

        else:
            financial_status = (
                "unpaid"
            )

        return ok({
            "visit_id":
                visit_id,

            "service_total":
                finance_number(
                    service_total
                ),

            "stock_total":
                finance_number(
                    stock_total
                ),

            "subtotal":
                finance_number(
                    subtotal
                ),

            "discount":
                finance_number(
                    discount
                ),

            "total":
                finance_number(
                    total
                ),

            "paid":
                finance_number(
                    paid
                ),

            "remaining":
                finance_number(
                    remaining
                ),

            "financial_status":
                financial_status,

            "transactions": [
                serialize_finance_transaction(
                    row
                )
                for row in transactions
            ],
        })

    except Exception as error:
        print(
            "❌ GET visit finance:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити фінанси візиту.",
            500
        )


@app.post(
    "/api/visits/<visit_id>/payments"
)
def api_create_visit_payment(
    visit_id
):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    amount = finance_number(
        data.get("amount")
    )

    payment_method = str(
        data.get(
            "payment_method"
        )
        or data.get("method")
        or ""
    ).strip().lower()

    allowed_methods = {
        "cash",
        "card",
        "transfer",
        "terminal",
        "other",
    }

    if amount <= 0:
        return fail(
            "Вкажіть суму оплати.",
            400
        )

    if (
        payment_method
        not in allowed_methods
    ):
        return fail(
            "Оберіть спосіб оплати.",
            400
        )

    current_org = (
        get_current_org_id()
    )

    idempotency_key = str(
        data.get(
            "idempotency_key"
        )
        or uuid.uuid4()
    ).strip()

    try:
        result = (
            supabase
            .rpc(
                "register_visit_payment",
                {
                    "p_org_id":
                        current_org,

                    "p_visit_id":
                        visit_id,

                    "p_user_id":
                        user.get("id"),

                    "p_amount":
                        amount,

                    "p_method":
                        payment_method,

                    "p_idempotency_key":
                        idempotency_key,
                },
            )
            .execute()
        )

        response_data = (
            result.data
            if result.data
            is not None
            else {}
        )

        if (
            isinstance(
                response_data,
                list
            )
            and response_data
        ):
            response_data = (
                response_data[0]
            )

        return ok(
            response_data
        )

    except Exception as error:
        error_text = str(
            error
        )

        print(
            "❌ POST visit payment:",
            repr(error),
            flush=True,
        )

        lowered_error = (
            error_text.lower()
        )

        if (
            "already paid"
            in lowered_error
            or "exceeds remaining"
            in lowered_error
            or "already processed"
            in lowered_error
        ):
            return fail(
                error_text,
                409
            )

        if (
            "total is zero"
            in lowered_error
            or "amount must"
            in lowered_error
            or "invalid payment"
            in lowered_error
        ):
            return fail(
                error_text,
                400
            )

        if (
            "visit not found"
            in lowered_error
        ):
            return fail(
                "Візит не знайдено.",
                404
            )

        return fail(
            "Не вдалося провести оплату.",
            500
        )  

@app.get(
    "/api/finance/overview"
)
def api_finance_overview():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400
        )

    try:
        kyiv_today = (
            datetime.now(
                ZoneInfo(
                    "Europe/Kyiv"
                )
            )
            .date()
        )

        default_date_from = (
            kyiv_today.replace(
                day=1
            )
        )

        raw_date_from = str(
            request.args.get(
                "date_from"
            )
            or default_date_from
        ).strip()

        raw_date_to = str(
            request.args.get(
                "date_to"
            )
            or kyiv_today
        ).strip()

        try:
            date_from = (
                datetime.strptime(
                    raw_date_from,
                    "%Y-%m-%d"
                )
                .date()
            )

            date_to = (
                datetime.strptime(
                    raw_date_to,
                    "%Y-%m-%d"
                )
                .date()
            )

        except ValueError:
            return fail(
                "Invalid date format. Use YYYY-MM-DD.",
                400
            )

        if date_from > date_to:
            return fail(
                "date_from cannot be later than date_to.",
                400
            )

        if (
            date_to - date_from
        ).days > 366:
            return fail(
                "Finance period cannot exceed 366 days.",
                400
            )

        result = (
            supabase
            .rpc(
                "get_finance_overview",
                {
                    "p_org_id":
                        current_org,

                    "p_date_from":
                        date_from.isoformat(),

                    "p_date_to":
                        date_to.isoformat(),
                }
            )
            .execute()
        )

        overview = (
            result.data
            if result.data
            is not None
            else {}
        )

        if (
            isinstance(
                overview,
                list
            )
            and overview
        ):
            overview = (
                overview[0]
            )

        return ok(
            overview
        )

    except Exception as error:
        print(
            "❌ GET finance overview:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити фінансову аналітику.",
            500
        )      
    
@app.post(
    "/api/finance/transactions"
)
def api_finance_transaction_create():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    transaction_type = str(
        data.get(
            "transaction_type"
        )
        or ""
    ).strip().lower()

    allowed_types = {
        "expense":
            "Витрата",

        "deposit":
            "Внесення",

        "withdrawal":
            "Вилучення",
    }

    if (
        transaction_type
        not in allowed_types
    ):
        return fail(
            (
                "Дозволено створювати лише "
                "витрату, внесення або вилучення."
            ),
            400,
        )

    payment_method = str(
        data.get(
            "payment_method"
        )
        or "cash"
    ).strip().lower()

    allowed_methods = {
        "cash",
        "card",
        "terminal",
        "transfer",
        "other",
    }

    if (
        payment_method
        not in allowed_methods
    ):
        return fail(
            "Невірний спосіб оплати.",
            400,
        )

    try:
        amount = round(
            float(
                data.get(
                    "amount"
                )
            ),
            2,
        )

    except (
        TypeError,
        ValueError,
    ):
        return fail(
            "Вкажіть коректну суму.",
            400,
        )

    if (
        amount != amount
        or amount in {
            float("inf"),
            float("-inf"),
        }
        or amount <= 0
    ):
        return fail(
            "Сума повинна бути більшою за нуль.",
            400,
        )

    if amount > 1_000_000_000:
        return fail(
            "Сума операції перевищує допустиме значення.",
            400,
        )

    category = str(
        data.get(
            "category"
        )
        or ""
    ).strip()

    if (
        transaction_type
        == "expense"
        and not category
    ):
        return fail(
            "Оберіть категорію витрати.",
            400,
        )

    if not category:
        category = {
            "deposit":
                "Внесення в касу",

            "withdrawal":
                "Вилучення з каси",
        }.get(
            transaction_type,
            allowed_types[
                transaction_type
            ],
        )

    description = str(
        data.get(
            "description"
        )
        or ""
    ).strip()

    counterparty = str(
        data.get(
            "counterparty"
        )
        or ""
    ).strip()

    document_url = str(
        data.get(
            "document_url"
        )
        or ""
    ).strip()

    if len(category) > 150:
        return fail(
            "Назва категорії надто довга.",
            400,
        )

    if len(description) > 2000:
        return fail(
            "Опис надто довгий.",
            400,
        )

    if len(counterparty) > 300:
        return fail(
            "Назва контрагента надто довга.",
            400,
        )

    if len(document_url) > 2000:
        return fail(
            "Посилання на документ надто довге.",
            400,
        )

    metadata = (
        data.get(
            "metadata"
        )
        or {}
    )

    if not isinstance(
        metadata,
        dict,
    ):
        return fail(
            "metadata повинно бути об’єктом.",
            400,
        )

    idempotency_key = str(
        data.get(
            "idempotency_key"
        )
        or uuid.uuid4()
    ).strip()

    try:
        uuid.UUID(
            idempotency_key
        )

    except (
        ValueError,
        TypeError,
        AttributeError,
    ):
        return fail(
            "Некоректний ключ операції.",
            400,
        )

    raw_occurred_at = str(
        data.get(
            "occurred_at"
        )
        or ""
    ).strip()

    if raw_occurred_at:
        try:
            occurred_datetime = (
                datetime.fromisoformat(
                    raw_occurred_at.replace(
                        "Z",
                        "+00:00",
                    )
                )
            )

            if (
                occurred_datetime
                .tzinfo
                is None
            ):
                occurred_datetime = (
                    occurred_datetime
                    .replace(
                        tzinfo=ZoneInfo(
                            "Europe/Kyiv"
                        )
                    )
                )

            occurred_at = (
                occurred_datetime
                .astimezone(
                    timezone.utc
                )
                .isoformat()
            )

        except ValueError:
            return fail(
                "Некоректна дата операції.",
                400,
            )

    else:
        occurred_at = (
            datetime
            .now(
                timezone.utc
            )
            .isoformat()
        )

    try:
        existing_result = (
            supabase
            .table(
                "finance_transactions"
            )
            .select(
                "id, org_id, "
                "transaction_type, "
                "amount, currency, "
                "payment_method, "
                "category, description, "
                "counterparty, document_url, "
                "source, status, "
                "cash_shift_id, visit_id, "
                "created_by, occurred_at, "
                "created_at, metadata"
            )
            .eq(
                "org_id",
                current_org,
            )
            .eq(
                "external_provider",
                "pugcrm",
            )
            .eq(
                "external_reference",
                idempotency_key,
            )
            .limit(1)
            .execute()
        )

        if existing_result.data:
            return ok({
                "transaction":
                    existing_result
                    .data[0],

                "idempotent_replay":
                    True,
            })

        payload = {
            "org_id":
                current_org,

            "created_by":
                user.get("id"),

            "transaction_type":
                transaction_type,

            "amount":
                amount,

            "currency":
                "UAH",

            "payment_method":
                payment_method,

            "category":
                category,

            "description":
                (
                    description
                    or allowed_types[
                        transaction_type
                    ]
                ),

            "counterparty":
                counterparty
                or None,

            "document_url":
                document_url
                or None,

            "source":
                "manual",

            "status":
                "completed",

            "cash_shift_id":
                None,

            "visit_id":
                None,

            "external_provider":
                "pugcrm",

            "external_reference":
                idempotency_key,

            "occurred_at":
                occurred_at,

            "metadata": {
                **metadata,

                "created_via":
                    "finance_dashboard",
            },
        }

        insert_result = (
            supabase
            .table(
                "finance_transactions"
            )
            .insert(
                payload
            )
            .execute()
        )

        if not insert_result.data:
            raise RuntimeError(
                "Transaction was not returned after insert."
            )

        return jsonify({
            "ok": True,

            "data": {
                "transaction":
                    insert_result
                    .data[0],

                "idempotent_replay":
                    False,
            },
        }), 201

    except Exception as error:
        error_text = str(
            error
        ).lower()

        print(
            "❌ POST finance transaction:",
            repr(error),
            flush=True,
        )

        if (
            "duplicate"
            in error_text
            or "23505"
            in error_text
        ):
            try:
                duplicate_result = (
                    supabase
                    .table(
                        "finance_transactions"
                    )
                    .select("*")
                    .eq(
                        "org_id",
                        current_org,
                    )
                    .eq(
                        "external_provider",
                        "pugcrm",
                    )
                    .eq(
                        "external_reference",
                        idempotency_key,
                    )
                    .limit(1)
                    .execute()
                )

                if duplicate_result.data:
                    return ok({
                        "transaction":
                            duplicate_result
                            .data[0],

                        "idempotent_replay":
                            True,
                    })

            except Exception as duplicate_error:
                print(
                    "⚠️ finance duplicate lookup:",
                    repr(
                        duplicate_error
                    ),
                    flush=True,
                )

        return fail(
            "Не вдалося створити фінансову операцію.",
            500,
        )    
    
@app.get(
    "/api/finance/transactions"
)
def api_finance_transactions_list():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    allowed_types = {
        "payment",
        "refund",
        "expense",
        "deposit",
        "withdrawal",
    }

    allowed_methods = {
        "cash",
        "card",
        "terminal",
        "transfer",
        "other",
    }

    allowed_statuses = {
        "pending",
        "completed",
        "cancelled",
        "failed",
    }

    transaction_type = str(
        request.args.get(
            "transaction_type"
        )
        or ""
    ).strip().lower()

    payment_method = str(
        request.args.get(
            "payment_method"
        )
        or ""
    ).strip().lower()

    status = str(
        request.args.get(
            "status"
        )
        or ""
    ).strip().lower()

    raw_date_from = str(
        request.args.get(
            "date_from"
        )
        or ""
    ).strip()

    raw_date_to = str(
        request.args.get(
            "date_to"
        )
        or ""
    ).strip()

    raw_search = str(
        request.args.get(
            "search"
        )
        or ""
    ).strip()

    if (
        transaction_type
        and transaction_type
        not in allowed_types
    ):
        return fail(
            "Невірний тип фінансової операції.",
            400,
        )

    if (
        payment_method
        and payment_method
        not in allowed_methods
    ):
        return fail(
            "Невірний спосіб оплати.",
            400,
        )

    if (
        status
        and status
        not in allowed_statuses
    ):
        return fail(
            "Невірний статус операції.",
            400,
        )

    try:
        limit = int(
            request.args.get(
                "limit"
            )
            or 50
        )

        offset = int(
            request.args.get(
                "offset"
            )
            or 0
        )

    except ValueError:
        return fail(
            "Некоректні параметри пагінації.",
            400,
        )

    limit = min(
        max(
            limit,
            1,
        ),
        200,
    )

    offset = max(
        offset,
        0,
    )

    kyiv_zone = ZoneInfo(
        "Europe/Kyiv"
    )

    date_from = None
    date_to = None

    try:
        if raw_date_from:
            date_from = (
                datetime.strptime(
                    raw_date_from,
                    "%Y-%m-%d",
                )
                .date()
            )

        if raw_date_to:
            date_to = (
                datetime.strptime(
                    raw_date_to,
                    "%Y-%m-%d",
                )
                .date()
            )

    except ValueError:
        return fail(
            "Invalid date format. Use YYYY-MM-DD.",
            400,
        )

    if (
        date_from
        and date_to
        and date_from > date_to
    ):
        return fail(
            "date_from cannot be later than date_to.",
            400,
        )

    if (
        date_from
        and date_to
        and (
            date_to -
            date_from
        ).days > 366
    ):
        return fail(
            "Finance period cannot exceed 366 days.",
            400,
        )

    try:
        query = (
            supabase
            .table(
                "finance_transactions"
            )
            .select(
                "id, org_id, "
                "transaction_type, "
                "amount, currency, "
                "payment_method, "
                "category, description, "
                "counterparty, document_url, "
                "source, status, "
                "cash_shift_id, visit_id, "
                "created_by, occurred_at, "
                "created_at, updated_at, "
                "metadata"
            )
            .eq(
                "org_id",
                current_org,
            )
        )

        if transaction_type:
            query = query.eq(
                "transaction_type",
                transaction_type,
            )

        if payment_method:
            query = query.eq(
                "payment_method",
                payment_method,
            )

        if status:
            query = query.eq(
                "status",
                status,
            )

        if date_from:
            start_at = datetime(
                date_from.year,
                date_from.month,
                date_from.day,
                tzinfo=kyiv_zone,
            )

            query = query.gte(
                "occurred_at",
                start_at
                .astimezone(
                    timezone.utc
                )
                .isoformat(),
            )

        if date_to:
            next_date = (
                date_to +
                timedelta(
                    days=1
                )
            )

            end_at = datetime(
                next_date.year,
                next_date.month,
                next_date.day,
                tzinfo=kyiv_zone,
            )

            query = query.lt(
                "occurred_at",
                end_at
                .astimezone(
                    timezone.utc
                )
                .isoformat(),
            )

        if raw_search:
            safe_search = "".join(
                character
                for character
                in raw_search[:100]
                if (
                    character.isalnum()
                    or character
                    in {
                        " ",
                        "-",
                        "_",
                    }
                )
            ).strip()

            if safe_search:
                query = query.or_(
                    (
                        "category.ilike.%"
                        f"{safe_search}"
                        "%,"
                        "description.ilike.%"
                        f"{safe_search}"
                        "%,"
                        "counterparty.ilike.%"
                        f"{safe_search}"
                        "%"
                    )
                )

        result = (
            query
            .order(
                "occurred_at",
                desc=True,
            )
            .range(
                offset,
                offset + limit,
            )
            .execute()
        )

        rows = (
            result.data
            or []
        )

        has_more = (
            len(rows) >
            limit
        )

        items = rows[:limit]

        return ok({
            "items":
                items,

            "pagination": {
                "limit":
                    limit,

                "offset":
                    offset,

                "returned":
                    len(items),

                "has_more":
                    has_more,

                "next_offset":
                    (
                        offset +
                        len(items)
                        if has_more
                        else None
                    ),
            },
        })

    except Exception as error:
        print(
            "❌ GET finance transactions:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити фінансові операції.",
            500,
        )    
    
@app.get(
    "/api/finance/expenses/overview"
)
def api_finance_expenses_overview():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    kyiv_today = (
        datetime.now(
            ZoneInfo(
                "Europe/Kyiv"
            )
        )
        .date()
    )

    default_date_from = (
        kyiv_today.replace(
            day=1
        )
    )

    raw_date_from = str(
        request.args.get(
            "date_from"
        )
        or default_date_from
    ).strip()

    raw_date_to = str(
        request.args.get(
            "date_to"
        )
        or kyiv_today
    ).strip()

    try:
        date_from = (
            datetime.strptime(
                raw_date_from,
                "%Y-%m-%d",
            )
            .date()
        )

        date_to = (
            datetime.strptime(
                raw_date_to,
                "%Y-%m-%d",
            )
            .date()
        )

    except ValueError:
        return fail(
            "Invalid date format. Use YYYY-MM-DD.",
            400,
        )

    if date_from > date_to:
        return fail(
            "date_from cannot be later than date_to.",
            400,
        )

    if (
        date_to -
        date_from
    ).days > 366:
        return fail(
            "Finance period cannot exceed 366 days.",
            400,
        )

    try:
        result = (
            supabase
            .rpc(
                "get_finance_expenses_overview",
                {
                    "p_org_id":
                        current_org,

                    "p_date_from":
                        date_from.isoformat(),

                    "p_date_to":
                        date_to.isoformat(),
                }
            )
            .execute()
        )

        overview = (
            result.data
            if result.data
            is not None
            else {}
        )

        if (
            isinstance(
                overview,
                list
            )
            and overview
        ):
            overview = (
                overview[0]
            )

        if not isinstance(
            overview,
            dict,
        ):
            overview = {}

        return ok(
            overview
        )

    except Exception as error:
        print(
            "❌ GET finance expenses overview:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити аналітику витрат.",
            500,
        )    
    
@app.get(
    "/api/finance/suppliers"
)
def api_finance_suppliers_list():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    raw_search = str(
        request.args.get(
            "search"
        )
        or ""
    ).strip()

    include_inactive = str(
        request.args.get(
            "include_inactive"
        )
        or ""
    ).strip().lower() in {
        "1",
        "true",
        "yes",
    }

    safe_search = "".join(
        character
        for character
        in raw_search[:100]
        if (
            character.isalnum()
            or character in {
                " ",
                "-",
                "_",
                ".",
                "'",
                "’",
            }
        )
    ).strip()

    try:
        query = (
            supabase
            .table(
                "suppliers"
            )
            .select(
                "id, org_id, name, "
                "edrpou, contact_person, "
                "phone, email, address, "
                "note, active, "
                "created_by, created_at, "
                "updated_at"
            )
            .eq(
                "org_id",
                current_org,
            )
        )

        if not include_inactive:
            query = query.eq(
                "active",
                True,
            )

        if safe_search:
            query = query.ilike(
                "name",
                f"%{safe_search}%",
            )

        result = (
            query
            .order(
                "name"
            )
            .execute()
        )

        return ok(
            result.data or []
        )

    except Exception as error:
        print(
            "❌ GET finance suppliers:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити постачальників.",
            500,
        )


@app.post(
    "/api/finance/suppliers"
)
def api_finance_supplier_create():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    payload = (
        request.get_json(
            silent=True
        )
        or {}
    )

    name = str(
        payload.get("name")
        or ""
    ).strip()

    optional_fields = {
        "edrpou":
            30,

        "contact_person":
            150,

        "phone":
            50,

        "email":
            200,

        "address":
            500,

        "note":
            2000,
    }

    if not name:
        return fail(
            "Вкажіть назву постачальника.",
            400,
        )

    if len(name) > 200:
        return fail(
            "Назва постачальника надто довга.",
            400,
        )

    cleaned = {}

    for (
        field,
        max_length,
    ) in optional_fields.items():
        value = str(
            payload.get(field)
            or ""
        ).strip()

        if len(value) > max_length:
            return fail(
                f"Поле {field} надто довге.",
                400,
            )

        cleaned[field] = (
            value
            if value
            else None
        )

    email = (
        cleaned.get("email")
    )

    if (
        email
        and (
            "@" not in email
            or "." not in email
        )
    ):
        return fail(
            "Вкажіть коректний email.",
            400,
        )

    insert_payload = {
        "org_id":
            current_org,

        "name":
            name,

        "edrpou":
            cleaned.get(
                "edrpou"
            ),

        "contact_person":
            cleaned.get(
                "contact_person"
            ),

        "phone":
            cleaned.get(
                "phone"
            ),

        "email":
            cleaned.get(
                "email"
            ),

        "address":
            cleaned.get(
                "address"
            ),

        "note":
            cleaned.get(
                "note"
            ),

        "active":
            True,

        "created_by":
            user.get("id"),
    }

    try:
        result = (
            supabase
            .table(
                "suppliers"
            )
            .insert(
                insert_payload
            )
            .execute()
        )

        row = (
            result.data[0]
            if result.data
            else insert_payload
        )

        return (
            jsonify({
                "ok":
                    True,

                "data":
                    row,
            }),
            201,
        )

    except Exception as error:
        error_text = str(
            error
        ).lower()

        print(
            "❌ POST finance supplier:",
            repr(error),
            flush=True,
        )

        if (
            "23505" in error_text
            or "duplicate" in error_text
            or "unique" in error_text
        ):
            return fail(
                "Постачальник з такою назвою вже існує.",
                409,
            )

        return fail(
            "Не вдалося створити постачальника.",
            500,
        )


@app.put(
    "/api/finance/suppliers/<supplier_id>"
)
def api_finance_supplier_update(
    supplier_id
):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    supplier_id = str(
        supplier_id or ""
    ).strip()

    if not supplier_id:
        return fail(
            "supplier_id required",
            400,
        )

    payload = (
        request.get_json(
            silent=True
        )
        or {}
    )

    allowed_fields = {
        "name",
        "edrpou",
        "contact_person",
        "phone",
        "email",
        "address",
        "note",
        "active",
    }

    update_payload = {}

    for field in allowed_fields:
        if field not in payload:
            continue

        if field == "active":
            update_payload[field] = bool(
                payload.get(field)
            )

            continue

        value = str(
            payload.get(field)
            or ""
        ).strip()

        update_payload[field] = (
            value
            if value
            else None
        )

    if not update_payload:
        return fail(
            "Немає даних для оновлення.",
            400,
        )

    if "name" in update_payload:
        name = (
            update_payload.get(
                "name"
            )
            or ""
        )

        if not name:
            return fail(
                "Назва постачальника не може бути порожньою.",
                400,
            )

        if len(name) > 200:
            return fail(
                "Назва постачальника надто довга.",
                400,
            )

    validation_limits = {
        "edrpou":
            30,

        "contact_person":
            150,

        "phone":
            50,

        "email":
            200,

        "address":
            500,

        "note":
            2000,
    }

    for (
        field,
        max_length,
    ) in validation_limits.items():
        value = (
            update_payload.get(
                field
            )
        )

        if (
            value
            and len(value) >
            max_length
        ):
            return fail(
                f"Поле {field} надто довге.",
                400,
            )

    email = (
        update_payload.get(
            "email"
        )
    )

    if (
        email
        and (
            "@" not in email
            or "." not in email
        )
    ):
        return fail(
            "Вкажіть коректний email.",
            400,
        )

    try:
        result = (
            supabase
            .table(
                "suppliers"
            )
            .update(
                update_payload
            )
            .eq(
                "org_id",
                current_org,
            )
            .eq(
                "id",
                supplier_id,
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Постачальника не знайдено.",
                404,
            )

        return ok(
            result.data[0]
        )

    except Exception as error:
        error_text = str(
            error
        ).lower()

        print(
            "❌ PUT finance supplier:",
            repr(error),
            flush=True,
        )

        if (
            "23505" in error_text
            or "duplicate" in error_text
            or "unique" in error_text
        ):
            return fail(
                "Постачальник з такою назвою вже існує.",
                409,
            )

        return fail(
            "Не вдалося оновити постачальника.",
            500,
        )


@app.delete(
    "/api/finance/suppliers/<supplier_id>"
)
def api_finance_supplier_deactivate(
    supplier_id
):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    supplier_id = str(
        supplier_id or ""
    ).strip()

    if not supplier_id:
        return fail(
            "supplier_id required",
            400,
        )

    try:
        result = (
            supabase
            .table(
                "suppliers"
            )
            .update({
                "active":
                    False,
            })
            .eq(
                "org_id",
                current_org,
            )
            .eq(
                "id",
                supplier_id,
            )
            .eq(
                "active",
                True,
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Активного постачальника не знайдено.",
                404,
            )

        return ok({
            "supplier_id":
                supplier_id,

            "active":
                False,
        })

    except Exception as error:
        print(
            "❌ DELETE finance supplier:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося вимкнути постачальника.",
            500,
        )

@app.get(
    "/api/finance/purchases"
)
def api_finance_purchases_list():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    allowed_statuses = {
        "draft",
        "ordered",
        "partially_received",
        "received",
        "cancelled",
    }

    allowed_payment_statuses = {
        "unpaid",
        "partial",
        "paid",
    }

    status = str(
        request.args.get(
            "status"
        )
        or ""
    ).strip().lower()

    payment_status = str(
        request.args.get(
            "payment_status"
        )
        or ""
    ).strip().lower()

    supplier_id = str(
        request.args.get(
            "supplier_id"
        )
        or ""
    ).strip()

    raw_date_from = str(
        request.args.get(
            "date_from"
        )
        or ""
    ).strip()

    raw_date_to = str(
        request.args.get(
            "date_to"
        )
        or ""
    ).strip()

    if (
        status
        and status not in
        allowed_statuses
    ):
        return fail(
            "Некоректний статус закупівлі.",
            400,
        )

    if (
        payment_status
        and payment_status not in
        allowed_payment_statuses
    ):
        return fail(
            "Некоректний статус оплати.",
            400,
        )

    if supplier_id:
        try:
            uuid.UUID(
                supplier_id
            )
        except ValueError:
            return fail(
                "Некоректний ID постачальника.",
                400,
            )

    date_from = None
    date_to = None

    if raw_date_from:
        try:
            date_from = (
                datetime.strptime(
                    raw_date_from,
                    "%Y-%m-%d",
                )
                .date()
            )
        except ValueError:
            return fail(
                "Некоректна початкова дата.",
                400,
            )

    if raw_date_to:
        try:
            date_to = (
                datetime.strptime(
                    raw_date_to,
                    "%Y-%m-%d",
                )
                .date()
            )
        except ValueError:
            return fail(
                "Некоректна кінцева дата.",
                400,
            )

    if (
        date_from
        and date_to
        and date_from > date_to
    ):
        return fail(
            "Початкова дата не може бути пізніше кінцевої.",
            400,
        )

    try:
        limit = int(
            request.args.get(
                "limit"
            )
            or 20
        )

        offset = int(
            request.args.get(
                "offset"
            )
            or 0
        )
    except ValueError:
        return fail(
            "Некоректна пагінація.",
            400,
        )

    limit = max(
        1,
        min(
            limit,
            100,
        ),
    )

    offset = max(
        0,
        offset,
    )

    try:
        query = (
            supabase
            .table(
                "stock_purchases"
            )
            .select(
                "id, org_id, supplier_id, "
                "purchase_number, invoice_number, "
                "status, payment_status, "
                "order_date, expected_date, "
                "received_at, subtotal, "
                "discount_amount, total_amount, "
                "paid_amount, currency, "
                "document_url, note, "
                "created_by, received_by, "
                "created_at, updated_at"
            )
            .eq(
                "org_id",
                current_org,
            )
        )

        if status:
            query = query.eq(
                "status",
                status,
            )

        if payment_status:
            query = query.eq(
                "payment_status",
                payment_status,
            )

        if supplier_id:
            query = query.eq(
                "supplier_id",
                supplier_id,
            )

        if date_from:
            query = query.gte(
                "order_date",
                date_from.isoformat(),
            )

        if date_to:
            query = query.lte(
                "order_date",
                date_to.isoformat(),
            )

        purchases_result = (
            query
            .order(
                "order_date",
                desc=True,
            )
            .order(
                "created_at",
                desc=True,
            )
            .range(
                offset,
                offset + limit,
            )
            .execute()
        )

        raw_purchases = (
            purchases_result.data
            or []
        )

        has_more = (
            len(raw_purchases)
            > limit
        )

        purchases = (
            raw_purchases[:limit]
        )

        if not purchases:
            return ok({
                "items": [],
                "pagination": {
                    "limit":
                        limit,

                    "offset":
                        offset,

                    "returned":
                        0,

                    "has_more":
                        False,

                    "next_offset":
                        None,
                },
            })

        purchase_ids = [
            str(
                purchase.get(
                    "id"
                )
            )
            for purchase in purchases
            if purchase.get(
                "id"
            )
        ]

        supplier_ids = list({
            str(
                purchase.get(
                    "supplier_id"
                )
            )
            for purchase in purchases
            if purchase.get(
                "supplier_id"
            )
        })

        suppliers_by_id = {}

        if supplier_ids:
            suppliers_result = (
                supabase
                .table(
                    "suppliers"
                )
                .select(
                    "id, name, edrpou, "
                    "contact_person, phone, "
                    "email, address, active"
                )
                .eq(
                    "org_id",
                    current_org,
                )
                .in_(
                    "id",
                    supplier_ids,
                )
                .execute()
            )

            suppliers_by_id = {
                str(
                    supplier.get(
                        "id"
                    )
                ):
                    supplier

                for supplier in (
                    suppliers_result.data
                    or []
                )
            }

        items_by_purchase = {
            purchase_id: []
            for purchase_id
            in purchase_ids
        }

        if purchase_ids:
            items_result = (
                supabase
                .table(
                    "stock_purchase_items"
                )
                .select(
                    "id, purchase_id, stock_id, "
                    "name_snap, unit_snap, "
                    "ordered_qty, received_qty, "
                    "purchase_price, line_total, "
                    "note, created_at, updated_at"
                )
                .in_(
                    "purchase_id",
                    purchase_ids,
                )
                .order(
                    "created_at"
                )
                .execute()
            )

            for item in (
                items_result.data
                or []
            ):
                item_purchase_id = str(
                    item.get(
                        "purchase_id"
                    )
                    or ""
                )

                if (
                    item_purchase_id
                    in items_by_purchase
                ):
                    items_by_purchase[
                        item_purchase_id
                    ].append(
                        item
                    )

        response_items = []

        for purchase in purchases:
            purchase_id = str(
                purchase.get(
                    "id"
                )
                or ""
            )

            purchase_supplier_id = str(
                purchase.get(
                    "supplier_id"
                )
                or ""
            )

            purchase_items = (
                items_by_purchase.get(
                    purchase_id,
                    [],
                )
            )

            ordered_units = sum(
                float(
                    item.get(
                        "ordered_qty"
                    )
                    or 0
                )
                for item in
                purchase_items
            )

            received_units = sum(
                float(
                    item.get(
                        "received_qty"
                    )
                    or 0
                )
                for item in
                purchase_items
            )

            total_amount = float(
                purchase.get(
                    "total_amount"
                )
                or 0
            )

            paid_amount = float(
                purchase.get(
                    "paid_amount"
                )
                or 0
            )

            response_items.append({
                **purchase,

                "supplier":
                    suppliers_by_id.get(
                        purchase_supplier_id
                    ),

                "items":
                    purchase_items,

                "items_count":
                    len(
                        purchase_items
                    ),

                "ordered_units":
                    ordered_units,

                "received_units":
                    received_units,

                "remaining_amount":
                    max(
                        0,
                        round(
                            total_amount -
                            paid_amount,
                            2,
                        ),
                    ),
            })

        return ok({
            "items":
                response_items,

            "pagination": {
                "limit":
                    limit,

                "offset":
                    offset,

                "returned":
                    len(
                        response_items
                    ),

                "has_more":
                    has_more,

                "next_offset":
                    (
                        offset + limit
                        if has_more
                        else None
                    ),
            },
        })

    except Exception as error:
        print(
            "❌ GET finance purchases:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити закупівлі.",
            500,
        )

@app.post(
    "/api/finance/purchases"
)
def api_finance_purchase_create():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    payload = (
        request.get_json(
            silent=True
        )
        or {}
    )

    if not isinstance(
        payload,
        dict,
    ):
        return fail(
            "Некоректне тіло запиту.",
            400,
        )

    supplier_id = str(
        payload.get(
            "supplier_id"
        )
        or ""
    ).strip()

    if not supplier_id:
        return fail(
            "Оберіть постачальника.",
            400,
        )

    try:
        uuid.UUID(
            supplier_id
        )
    except ValueError:
        return fail(
            "Некоректний ID постачальника.",
            400,
        )

    kyiv_today = (
        datetime.now(
            ZoneInfo(
                "Europe/Kyiv"
            )
        )
        .date()
    )

    raw_order_date = str(
        payload.get(
            "order_date"
        )
        or kyiv_today.isoformat()
    ).strip()

    raw_expected_date = str(
        payload.get(
            "expected_date"
        )
        or ""
    ).strip()

    try:
        order_date = (
            datetime.strptime(
                raw_order_date,
                "%Y-%m-%d",
            )
            .date()
        )
    except ValueError:
        return fail(
            "Некоректна дата замовлення.",
            400,
        )

    expected_date = None

    if raw_expected_date:
        try:
            expected_date = (
                datetime.strptime(
                    raw_expected_date,
                    "%Y-%m-%d",
                )
                .date()
            )
        except ValueError:
            return fail(
                "Некоректна очікувана дата.",
                400,
            )

        if (
            expected_date <
            order_date
        ):
            return fail(
                "Очікувана дата не може бути раніше дати замовлення.",
                400,
            )

    currency = str(
        payload.get(
            "currency"
        )
        or "UAH"
    ).strip().upper()

    if currency not in {
        "UAH",
        "USD",
        "EUR",
        "PLN",
    }:
        return fail(
            "Непідтримувана валюта.",
            400,
        )

    try:
        discount_amount = float(
            str(
                payload.get(
                    "discount_amount"
                )
                or 0
            )
            .replace(
                ",",
                ".",
            )
        )
    except (
        TypeError,
        ValueError,
    ):
        return fail(
            "Некоректна сума знижки.",
            400,
        )

    if (
        discount_amount < 0
        or discount_amount > 100000000
    ):
        return fail(
            "Некоректна сума знижки.",
            400,
        )

    invoice_number = str(
        payload.get(
            "invoice_number"
        )
        or ""
    ).strip()[:150]

    document_url = str(
        payload.get(
            "document_url"
        )
        or ""
    ).strip()[:1000]

    if (
        document_url
        and not document_url.startswith(
            (
                "https://",
                "http://",
            )
        )
    ):
        return fail(
            "Посилання на документ повинно починатися з http:// або https://.",
            400,
        )

    note = str(
        payload.get(
            "note"
        )
        or ""
    ).strip()[:2000]

    raw_items = payload.get(
        "items"
    )

    if not isinstance(
        raw_items,
        list,
    ):
        return fail(
            "Позиції закупівлі повинні бути списком.",
            400,
        )

    if not raw_items:
        return fail(
            "Додайте хоча б одну позицію закупівлі.",
            400,
        )

    if len(
        raw_items
    ) > 100:
        return fail(
            "В одній закупівлі може бути не більше 100 позицій.",
            400,
        )

    clean_items = []

    for index, raw_item in enumerate(
        raw_items,
        start=1,
    ):
        if not isinstance(
            raw_item,
            dict,
        ):
            return fail(
                f"Некоректна позиція №{index}.",
                400,
            )

        stock_id = str(
            raw_item.get(
                "stock_id"
            )
            or ""
        ).strip()

        if stock_id:
            try:
                uuid.UUID(
                    stock_id
                )
            except ValueError:
                return fail(
                    f"Некоректний товар у позиції №{index}.",
                    400,
                )

        name_snap = str(
            raw_item.get(
                "name_snap"
            )
            or ""
        ).strip()[:250]

        unit_snap = str(
            raw_item.get(
                "unit_snap"
            )
            or "шт"
        ).strip()[:50]

        if (
            not stock_id
            and not name_snap
        ):
            return fail(
                f"Вкажіть назву товару в позиції №{index}.",
                400,
            )

        try:
            ordered_qty = float(
                str(
                    raw_item.get(
                        "ordered_qty"
                    )
                    or 0
                )
                .replace(
                    ",",
                    ".",
                )
            )

            purchase_price = float(
                str(
                    raw_item.get(
                        "purchase_price"
                    )
                    or 0
                )
                .replace(
                    ",",
                    ".",
                )
            )

        except (
            TypeError,
            ValueError,
        ):
            return fail(
                f"Некоректна кількість або ціна в позиції №{index}.",
                400,
            )

        if (
            ordered_qty <= 0
            or ordered_qty > 100000000
        ):
            return fail(
                f"Кількість у позиції №{index} повинна бути більшою за нуль.",
                400,
            )

        if (
            purchase_price < 0
            or purchase_price > 100000000
        ):
            return fail(
                f"Некоректна закупівельна ціна в позиції №{index}.",
                400,
            )

        clean_items.append({
            "stock_id":
                stock_id or None,

            "name_snap":
                name_snap or None,

            "unit_snap":
                unit_snap or "шт",

            "ordered_qty":
                ordered_qty,

            "purchase_price":
                purchase_price,

            "note":
                str(
                    raw_item.get(
                        "note"
                    )
                    or ""
                ).strip()[:500]
                or None,
        })

    try:
        result = (
            supabase
            .rpc(
                "create_stock_purchase",
                {
                    "p_org_id":
                        current_org,

                    "p_supplier_id":
                        supplier_id,

                    "p_user_id":
                        user.get(
                            "id"
                        ),

                    "p_order_date":
                        order_date.isoformat(),

                    "p_expected_date":
                        (
                            expected_date.isoformat()
                            if expected_date
                            else None
                        ),

                    "p_invoice_number":
                        invoice_number
                        or None,

                    "p_discount_amount":
                        discount_amount,

                    "p_currency":
                        currency,

                    "p_document_url":
                        document_url
                        or None,

                    "p_note":
                        note
                        or None,

                    "p_items":
                        clean_items,
                },
            )
            .execute()
        )

        purchase = (
            result.data
            if result.data
            is not None
            else {}
        )

        if (
            isinstance(
                purchase,
                list,
            )
            and purchase
        ):
            purchase = (
                purchase[0]
            )

        return (
            ok(
                purchase
            ),
            201,
        )

    except Exception as error:
        error_text = str(
            error
        )

        print(
            "❌ POST finance purchase:",
            repr(error),
            flush=True,
        )

        known_validation_errors = (
            "Supplier not found",
            "Supplier is inactive",
            "Purchase must contain",
            "Invalid purchase item",
            "Stock item not found",
            "Discount cannot exceed",
            "Expected date",
            "Unsupported currency",
        )

        if any(
            message.lower()
            in error_text.lower()
            for message
            in known_validation_errors
        ):
            return fail(
                error_text,
                400,
            )

        return fail(
            "Не вдалося створити закупівлю.",
            500,
        )
        
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
    user, auth_error = owner_or_admin_required()

    if auth_error:
        return auth_error

    try:
        payload = request.get_json(silent=True) or {}

        name = str(payload.get("name") or "").strip()

        if not name:
            return jsonify({
                "ok": False,
                "error": "Вкажіть назву послуги."
            }), 400

        try:
            price = float(payload.get("price") or 0)
        except (TypeError, ValueError):
            return jsonify({
                "ok": False,
                "error": "Вкажіть коректну вартість послуги."
            }), 400

        if price < 0:
            return jsonify({
                "ok": False,
                "error": "Вартість не може бути від’ємною."
            }), 400

        current_org = get_current_org_id()

        service_data = {
            "org_id": current_org,
            "name": name,
            "price": price,
            "active": bool(payload.get("active", True)),
        }

        res = (
            supabase.table("services")
            .insert(service_data)
            .execute()
        )

        return jsonify({
            "ok": True,
            "data": res.data or []
        }), 201

    except Exception as e:
        print("❌ /api/services POST error:", repr(e))

        return jsonify({
            "ok": False,
            "error": "Не вдалося створити послугу."
        }), 500

@app.put("/api/services")
def api_services_update():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    try:
        # существующий код
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
@app.delete("/api/services")
def api_services_delete():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    try:
        # существующий код
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
    try:
        current_org = (
            get_current_org_id()
        )

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        result = execute_with_retry(
            lambda: (
                supabase
                .table("owners")
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .order("name")
            ),
            attempts=3,
            delay=0.25,
        )

        return ok(
            result.data or []
        )

    except Exception as error:
        print(
            "❌ GET /api/owners error:",
            repr(error),
        )

        return fail(
            f"Cannot load owners: {error}",
            500,
        )


@app.post("/api/owners")
def api_create_owner():
    _user, auth_error = auth_required()

    if auth_error:
        return auth_error

    try:
        current_org = get_current_org_id()

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        data = request.get_json(
            silent=True
        ) or {}

        name = str(
            data.get("name") or ""
        ).strip()

        if not name:
            return fail(
                "Вкажіть ПІБ власника",
                400,
            )

        payload = {
            "org_id": current_org,
            "name": name,
            "phone": str(
                data.get("phone") or ""
            ).strip() or None,
            "note": str(
                data.get("note") or ""
            ).strip() or None,
        }

        result = (
            supabase
            .table("owners")
            .insert(payload)
            .execute()
        )

        if not result.data:
            return fail(
                "Не вдалося створити власника",
                500,
            )

        return ok(result.data[0])

    except Exception as error:
        print(
            "❌ POST /api/owners error:",
            repr(error),
        )

        return fail(
            f"Cannot create owner: {error}",
            500,
        )
@app.delete("/api/owners/<owner_id>")
def api_delete_owner(owner_id):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    owner_id = str(
        owner_id or ""
    ).strip()

    if not owner_id:
        return fail(
            "owner_id required",
            400,
        )

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    try:
        owner_result = (
            supabase
            .table("owners")
            .select("id, name")
            .eq(
                "org_id",
                current_org,
            )
            .eq(
                "id",
                owner_id,
            )
            .limit(1)
            .execute()
        )

        if not owner_result.data:
            return fail(
                "Власника не знайдено.",
                404,
            )

        patients_result = (
            supabase
            .table("patients")
            .select("id")
            .eq(
                "org_id",
                current_org,
            )
            .eq(
                "owner_id",
                owner_id,
            )
            .limit(1)
            .execute()
        )

        if patients_result.data:
            return fail(
                (
                    "Неможливо видалити власника, "
                    "поки до нього прив’язані пацієнти."
                ),
                409,
            )

        delete_result = (
            supabase
            .table("owners")
            .delete()
            .eq(
                "org_id",
                current_org,
            )
            .eq(
                "id",
                owner_id,
            )
            .execute()
        )

        if not delete_result.data:
            return fail(
                "Власника не знайдено.",
                404,
            )

        return ok({
            "id": owner_id,
            "deleted": True,
        })

    except Exception as error:
        print(
            "❌ DELETE /api/owners:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося видалити власника.",
            500,
        )
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
            .eq("is_active", True)
            .order("name")
            .execute()
        )
        return ok(res.data or [])
    except Exception as e:
        return fail(str(e), 500)


@app.post("/api/specializations")
def api_create_specialization():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    try:
        # существующий код
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
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    try:
        # существующий код
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
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    try:
        # существующий код
        if not spec_id:
            return fail("spec_id required", 400)

        current_org = get_current_org_id()
        supabase.table("specializations").update({
            "is_active": False
        }).eq("org_id", current_org).eq("id", spec_id).execute()
        return ok(True)
    except Exception as e:
        return fail(str(e), 500)


def validate_staff_specialization_ids(
    raw_ids,
    org_id,
):
    if raw_ids is None:
        return []

    if not isinstance(raw_ids, list):
        raise ValueError(
            "Напрями мають бути списком"
        )

    clean_ids = []

    for raw_id in raw_ids:
        item_id = str(
            raw_id or ""
        ).strip()

        if not item_id:
            continue

        try:
            item_id = str(
                uuid.UUID(item_id)
            )
        except (ValueError, TypeError):
            raise ValueError(
                "Некоректний ID напряму"
            )

        if item_id not in clean_ids:
            clean_ids.append(item_id)

    if not clean_ids:
        return []

    result = (
        supabase
        .table("specializations")
        .select("id")
        .eq("org_id", org_id)
        .eq("is_active", True)
        .in_("id", clean_ids)
        .execute()
    )

    allowed_ids = {
        str(item.get("id"))
        for item in (result.data or [])
        if item.get("id")
    }

    if any(
        item_id not in allowed_ids
        for item_id in clean_ids
    ):
        raise ValueError(
            "Один або кілька напрямів недоступні для цієї клініки"
        )

    return clean_ids


@app.get("/api/staff")
def api_staff():
    try:
        user, auth_error = (
            auth_required()
        )

        if auth_error:
            return auth_error

        current_org = get_current_org_id()

        query = (
    supabase
    .table("staff")
    .select("*")
    .eq("org_id", current_org)
    .eq("is_active", True)
)

        role = normalize_role(
            user.get("role")
        )

        if role not in {
            "owner",
            "admin",
        }:
            staff_id = str(
                user.get("staff_id")
                or ""
            ).strip()

            if not staff_id:
                return ok([])

            query = query.eq(
                "id",
                staff_id,
            )

        result = (
            query
            .order("name")
            .execute()
        )

        rows = result.data or []

        specializations_result = (
            supabase
            .table("specializations")
            .select("id,name,color")
            .eq("org_id", current_org)
            .eq("is_active", True)
            .order("name")
            .execute()
        )

        specializations_by_id = {
            str(item.get("id")): item
            for item in (
                specializations_result.data
                or []
            )
            if item.get("id")
        }

        for row in rows:
            ids = row.get(
                "specialization_ids"
            )

            if not isinstance(ids, list):
                ids = []

            clean_ids = []
            linked = []

            for item in ids:
                item_id = str(
                    item or ""
                ).strip()

                specialization = (
                    specializations_by_id.get(
                        item_id
                    )
                )

                if (
                    not item_id
                    or not specialization
                    or item_id in clean_ids
                ):
                    continue

                clean_ids.append(item_id)
                linked.append(specialization)

            row["specialization_ids"] = (
                clean_ids
            )
            row["specializations"] = linked

        return ok(rows)

    except Exception as error:
        print(
            "❌ /api/staff GET:",
            repr(error),
        )

        return fail(
            "Cannot load staff",
            500,
        )

@app.post("/api/staff")
def api_create_staff():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    d = request.get_json(silent=True) or {}

    name = (
        d.get("name") or ""
    ).strip()

    if not name:
        return fail(
            "name required",
            400,
        )

    current_org = (
        get_current_org_id()
    )

    try:
        specialization_ids = (
            validate_staff_specialization_ids(
                d.get(
                    "specialization_ids",
                    [],
                ),
                current_org,
            )
        )
    except ValueError as error:
        return fail(str(error), 400)

    payload = {
        "org_id": current_org,
        "name": name,
        "role": d.get("role") or "vet",
        "avatar": d.get("avatar"),
        "color": d.get("color") or "#7C5CFF",
        "phone": d.get("phone"),
        "specialization": d.get("specialization"),
        "specialization_ids": specialization_ids,
        "shift_rate": d.get("shift_rate") or 0,
        "percent_rate": d.get("percent_rate") or 0,
        "bonus_rate": d.get("bonus_rate") or 0,
        "note": d.get("note"),
        "is_active": True,
    }

    res = (
        supabase
        .table("staff")
        .insert(payload)
        .execute()
    )

    row = (
        res.data[0]
        if getattr(res, "data", None)
        else payload
    )

    return ok(row)

@app.put("/api/staff/<staff_id>")
def api_update_staff(staff_id):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    if not staff_id:
        return fail(
            "staff_id required",
            400,
        )

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

    current_org = (
        get_current_org_id()
    )

    if "specialization_ids" in d:
        try:
            payload["specialization_ids"] = (
                validate_staff_specialization_ids(
                    d.get(
                        "specialization_ids"
                    ),
                    current_org,
                )
            )
        except ValueError as error:
            return fail(str(error), 400)

    payload = {
        key: value
        for key, value in payload.items()
        if value is not None
    }

    res = (
        supabase
        .table("staff")
        .update(payload)
        .eq("org_id", current_org)
        .eq("id", staff_id)
        .execute()
    )

    row = (
        res.data[0]
        if getattr(res, "data", None)
        else payload
    )

    return ok(row)

@app.delete("/api/staff/<staff_id>")
def api_deactivate_staff(staff_id):
    user, auth_error = owner_or_admin_required()

    if auth_error:
        return auth_error

    target_staff_id = str(staff_id or "").strip()

    if not target_staff_id:
        return fail("staff_id required", 400)

    current_staff_id = str(
        user.get("staff_id") or ""
    ).strip()

    if (
        current_staff_id
        and current_staff_id == target_staff_id
    ):
        return fail(
            "Не можна звільнити власний профіль",
            409,
        )

    current_org = str(
        get_current_org_id() or ""
    ).strip()

    try:
        target_result = (
            supabase
            .table("staff")
            .select("id,name,role,is_active")
            .eq("org_id", current_org)
            .eq("id", target_staff_id)
            .limit(1)
            .execute()
        )

        if not target_result.data:
            return fail(
                "Співробітника не знайдено",
                404,
            )

        target = target_result.data[0]

        if target.get("is_active") is False:
            return ok({
                "id": target_staff_id,
                "is_active": False,
            })

        # Блокуємо обліковий запис, але не видаляємо історію.
        (
            supabase
            .table("clinic_users")
            .update({
                "is_active": False,
            })
            .eq("org_id", current_org)
            .eq("staff_id", target_staff_id)
            .execute()
        )

        result = (
            supabase
            .table("staff")
            .update({
                "is_active": False,
            })
            .eq("org_id", current_org)
            .eq("id", target_staff_id)
            .execute()
        )

        row = (
            result.data[0]
            if result.data
            else {
                "id": target_staff_id,
                "is_active": False,
            }
        )

        return ok(row)

    except Exception as error:
        print(
            "❌ /api/staff DELETE:",
            repr(error),
        )

        return fail(
            "Не вдалося звільнити співробітника",
            500,
        )
@app.get("/api/staff/<staff_id>/dashboard")
def api_staff_dashboard(staff_id):
    user, auth_error = (
        self_or_manager_required(
            staff_id
        )
    )

    if auth_error:
        return auth_error

    try:
        current_org = (
            get_current_org_id()
        )

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        role = normalize_role(
            user.get("role")
        )

        visits_res = execute_with_retry(
            lambda: (
                supabase
                .table("visits")
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "staff_id",
                    staff_id,
                )
            ),
            attempts=3,
            delay=0.25,
        )

        visits = (
            visits_res.data or []
        )

        now = datetime.now(
            timezone.utc
        )

        current_month = (
            now.strftime("%Y-%m")
        )

        prev_month_num = (
            now.month - 1
        )

        prev_year = now.year

        if prev_month_num == 0:
            prev_month_num = 12
            prev_year -= 1

        prev_month = (
            f"{prev_year}-"
            f"{prev_month_num:02d}"
        )

        current_visits = [
            visit
            for visit in visits
            if str(
                visit.get("date") or ""
            ).startswith(
                current_month
            )
        ]

        prev_visits = [
            visit
            for visit in visits
            if str(
                visit.get("date") or ""
            ).startswith(
                prev_month
            )
        ]

        def calc_visit_total(
            visit_id
        ):
            total = 0

            try:
                services_res = (
                    execute_with_retry(
                        lambda: (
                            supabase
                            .table(
                                "visit_services"
                            )
                            .select("*")
                            .eq(
                                "visit_id",
                                visit_id,
                            )
                        ),
                        attempts=3,
                        delay=0.25,
                    )
                )

                for service in (
                    services_res.data
                    or []
                ):
                    qty = (
                        service.get("qty")
                        or 1
                    )

                    price = (
                        service.get(
                            "price_snap"
                        )
                        or 0
                    )

                    try:
                        total += (
                            float(qty)
                            * float(price)
                        )
                    except Exception:
                        pass

            except Exception:
                pass

            try:
                stock_res = (
                    execute_with_retry(
                        lambda: (
                            supabase
                            .table(
                                "visit_stock"
                            )
                            .select("*")
                            .eq(
                                "visit_id",
                                visit_id,
                            )
                        ),
                        attempts=3,
                        delay=0.25,
                    )
                )

                for stock_item in (
                    stock_res.data
                    or []
                ):
                    qty = (
                        stock_item.get(
                            "qty"
                        )
                        or 1
                    )

                    price = (
                        stock_item.get(
                            "price_snap"
                        )
                        or 0
                    )

                    try:
                        total += (
                            float(qty)
                            * float(price)
                        )
                    except Exception:
                        pass

            except Exception:
                pass

            return total

        current_revenue = sum(
            calc_visit_total(
                visit.get("id")
            )
            for visit in current_visits
            if visit.get("id")
        )

        prev_revenue = sum(
            calc_visit_total(
                visit.get("id")
            )
            for visit in prev_visits
            if visit.get("id")
        )

        visits_this_month = len(
            current_visits
        )

        closed_checks = len([
            visit
            for visit in current_visits
            if visit.get("id")
        ])

        avg_check = (
            round(
                current_revenue
                / closed_checks
            )
            if closed_checks
            else 0
        )

        def growth(
            current,
            previous,
        ):
            try:
                current = float(
                    current or 0
                )

                previous = float(
                    previous or 0
                )

                if previous <= 0:
                    return 0

                return round(
                    (
                        (
                            current
                            - previous
                        )
                        / previous
                    )
                    * 100
                )

            except Exception:
                return 0

        visits_growth = growth(
            len(current_visits),
            len(prev_visits),
        )

        checks_growth = growth(
            len(current_visits),
            len(prev_visits),
        )

        revenue_growth = growth(
            current_revenue,
            prev_revenue,
        )

        prev_avg = (
            round(
                prev_revenue
                / len(prev_visits)
            )
            if prev_visits
            else 0
        )

        avg_check_growth = growth(
            avg_check,
            prev_avg,
        )

        last_visits = sorted(
            visits,
            key=lambda item: str(
                item.get("date") or ""
            ),
            reverse=True,
        )[:5]

        normalized_last_visits = []

        for visit in last_visits:
            total = (
                calc_visit_total(
                    visit.get("id")
                )
                if visit.get("id")
                else 0
            )

            patient_name = (
                "Пацієнт"
            )

            try:
                pet_id = (
                    visit.get("pet_id")
                )

                if pet_id:
                    pet_res = (
                        execute_with_retry(
                            lambda: (
                                supabase
                                .table(
                                    "patients"
                                )
                                .select(
                                    "name, species, breed"
                                )
                                .eq(
                                    "org_id",
                                    current_org,
                                )
                                .eq(
                                    "id",
                                    pet_id,
                                )
                                .limit(1)
                            ),
                            attempts=3,
                            delay=0.25,
                        )
                    )

                    if pet_res.data:
                        patient_name = (
                            pet_res.data[0]
                            .get("name")
                            or "Пацієнт"
                        )

            except Exception:
                pass

            visit_data = {
                "id":
                    visit.get("id"),

                "date":
                    visit.get("date"),

                "patient_name":
                    patient_name,

                "note":
                    visit.get("note")
                    or "",

                "dx":
                    visit.get("dx")
                    or "",

                "rx":
                    visit.get("rx")
                    or "",

                "status":
                    "Завершено",
            }

            if role == "owner":
                visit_data["total"] = (
                    round(total)
                )

            normalized_last_visits.append(
                visit_data
            )

        response_data = {
            "visits_this_month":
                visits_this_month,

            "closed_checks":
                closed_checks,

            "visits_growth_percent":
                visits_growth,

            "last_visits":
                normalized_last_visits,

            "visits_chart":
                [],
        }

        if role == "owner":
            response_data.update({
                "revenue":
                    round(
                        current_revenue
                    ),

                "avg_check":
                    avg_check,

                "revenue_growth_percent":
                    revenue_growth,

                "checks_growth_percent":
                    checks_growth,

                "avg_check_growth_percent":
                    avg_check_growth,

                "revenue_chart":
                    [],

                "penalties": {
                    "late": 0,
                    "absences": 0,
                    "warnings": 0,
                    "bonuses_amount": 0,
                    "penalties_amount": 0,
                },
            })

        return ok(
            response_data
        )

    except Exception as error:
        print(
            "❌ /api/staff/<staff_id>/dashboard error:",
            repr(error),
        )

        return fail(
            "Cannot load staff dashboard",
            500,
        )

@app.get(
    "/api/staff/<staff_id>/adjustments"
)
def api_get_staff_adjustments(
    staff_id,
):
    user, auth_error = (
        owner_required()
    )

    if auth_error:
        return auth_error

    try:
        current_org = (
            get_current_org_id()
        )

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        staff_id = str(
            staff_id or ""
        ).strip()

        if not staff_id:
            return fail(
                "staff_id required",
                400,
            )

        month = str(
            request.args.get("month")
            or datetime
                .now(timezone.utc)
                .strftime("%Y-%m")
        ).strip()

        try:
            year_text, month_text = (
                month.split("-")
            )

            year = int(
                year_text
            )

            month_number = int(
                month_text
            )

            if (
                month_number < 1
                or month_number > 12
            ):
                raise ValueError()

        except Exception:
            return fail(
                "Invalid month format. Use YYYY-MM",
                400,
            )

        date_from = (
            f"{year:04d}-"
            f"{month_number:02d}-01"
        )

        if month_number == 12:
            next_year = (
                year + 1
            )

            next_month = 1
        else:
            next_year = year

            next_month = (
                month_number + 1
            )

        date_to = (
            f"{next_year:04d}-"
            f"{next_month:02d}-01"
        )

        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "staff_finance_adjustments"
                )
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "staff_id",
                    staff_id,
                )
                .gte(
                    "adjustment_date",
                    date_from,
                )
                .lt(
                    "adjustment_date",
                    date_to,
                )
                .order(
                    "created_at",
                    desc=True,
                )
            ),
            attempts=3,
            delay=0.25,
        )

        return ok(
            result.data or []
        )

    except Exception as error:
        print(
            "❌ GET staff adjustments:",
            repr(error),
        )

        return fail(
            "Cannot load staff adjustments",
            500,
        )


@app.post(
    "/api/staff/<staff_id>/adjustments"
)
def api_create_staff_adjustment(
    staff_id,
):
    user, auth_error = (
        owner_required()
    )

    if auth_error:
        return auth_error

    try:
        current_org = (
            get_current_org_id()
        )

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        staff_id = str(
            staff_id or ""
        ).strip()

        if not staff_id:
            return fail(
                "staff_id required",
                400,
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        adjustment_type = str(
            data.get("type")
            or ""
        ).strip().lower()

        reason = str(
            data.get("reason")
            or ""
        ).strip()

        try:
            amount = int(
                data.get("amount")
                or 0
            )
        except (
            TypeError,
            ValueError,
        ):
            return fail(
                "amount must be a number",
                400,
            )

        if adjustment_type not in {
            "bonus",
            "penalty",
        }:
            return fail(
                "type must be bonus or penalty",
                400,
            )

        if amount <= 0:
            return fail(
                "amount must be positive",
                400,
            )

        adjustment_date = str(
            data.get(
                "adjustment_date"
            )
            or datetime
                .now(timezone.utc)
                .strftime("%Y-%m-%d")
        ).strip()

        try:
            datetime.strptime(
                adjustment_date,
                "%Y-%m-%d",
            )
        except ValueError:
            return fail(
                "Invalid adjustment_date. Use YYYY-MM-DD",
                400,
            )

        staff_result = (
            execute_with_retry(
                lambda: (
                    supabase
                    .table("staff")
                    .select("id")
                    .eq(
                        "org_id",
                        current_org,
                    )
                    .eq(
                        "id",
                        staff_id,
                    )
                    .limit(1)
                ),
                attempts=3,
                delay=0.25,
            )
        )

        if not staff_result.data:
            return fail(
                "Staff member not found",
                404,
            )

        payload = {
            "org_id":
                current_org,

            "staff_id":
                staff_id,

            "type":
                adjustment_type,

            "amount":
                amount,

            "reason":
                reason or None,

            "adjustment_date":
                adjustment_date,
        }

        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "staff_finance_adjustments"
                )
                .insert(
                    clean_payload(
                        payload
                    )
                )
            ),
            attempts=3,
            delay=0.25,
        )

        row = (
            result.data[0]
            if result.data
            else payload
        )

        return ok(row)

    except Exception as error:
        print(
            "❌ CREATE staff adjustment:",
            repr(error),
        )

        return fail(
            "Cannot create staff adjustment",
            500,
        )


@app.delete("/api/staff/adjustments/<adjustment_id>")
def api_delete_staff_adjustment(
    adjustment_id,
):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    try:
        current_org = (
            get_current_org_id()
        )

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
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error    
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


    
# API: CALENDAR
# =========================
@app.get("/api/calendar")
def api_calendar():
    try:
        current_org = (
            get_current_org_id()
        )

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        result = execute_with_retry(
            lambda: (
                supabase
                .table("calendar_events")
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .order("event_date")
                .order("start_time")
            ),
            attempts=3,
            delay=0.25,
        )

        return ok(
            result.data or []
        )

    except Exception as error:
        print(
            "❌ GET /api/calendar error:",
            repr(error),
        )

        return fail(
            f"Cannot load calendar: {error}",
            500,
        )
    
@app.post("/api/calendar")
def api_create_calendar_event():
    user, auth_error = (
        auth_required()
    )

    if auth_error:
        return auth_error

    d = request.get_json(
        silent=True
    ) or {}

    title = (
        d.get("title") or ""
    ).strip()

    event_date = (
        d.get("event_date") or ""
    ).strip()

    start_time = (
        d.get("start_time") or ""
    ).strip()

    end_time = (
        d.get("end_time") or ""
    ).strip()

    staff_id = d.get(
        "staff_id"
    )

    if not can_manage_calendar_staff(
        user,
        staff_id,
    ):
        return fail(
            "You can create calendar events only for yourself",
            403,
        ) 

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

@app.delete(
    "/api/calendar/<event_id>"
)
def api_delete_calendar_event(
    event_id,
):
    user, auth_error = (
        auth_required()
    )

    if auth_error:
        return auth_error

    if not event_id:
        return fail(
            "event_id required",
            400,
        )

    event = (
        calendar_event_for_current_org(
            event_id
        )
    )

    if not event:
        return fail(
            "Calendar event not found",
            404,
        )

    if not can_manage_calendar_staff(
        user,
        event.get("staff_id"),
    ):
        return fail(
            "You cannot delete this calendar event",
            403,
        )

    current_org = (
        get_current_org_id()
    )

    (
        supabase
        .table("calendar_events")
        .delete()
        .eq(
            "org_id",
            current_org,
        )
        .eq(
            "id",
            event_id,
        )
        .execute()
    )

    return ok(True)

@app.put("/api/calendar/<event_id>")
def api_update_calendar_event(event_id):
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    if not event_id:
        return fail(
            "event_id required",
            400,
        )

    current_event = (
        calendar_event_for_current_org(
            event_id
        )
    )

    if not current_event:
        return fail(
            "Calendar event not found",
            404,
        )

    if not can_manage_calendar_staff(
        user,
        current_event.get("staff_id"),
    ):
        return fail(
            "You cannot update this calendar event",
            403,
        )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    payload = {
        "title": data.get("title"),
        "event_date": data.get(
            "event_date"
        ),
        "start_time": data.get(
            "start_time"
        ),
        "end_time": data.get(
            "end_time"
        ),
        "staff_id": data.get(
            "staff_id"
        ),
        "location": data.get(
            "location"
        ),
        "status": data.get(
            "status"
        ),
        "note": data.get(
            "note"
        ),
    }

    payload = {
        key: value
        for key, value in payload.items()
        if value not in ("", None)
    }

    target_staff_id = (
        payload.get("staff_id")
        or current_event.get(
            "staff_id"
        )
    )

    if not can_manage_calendar_staff(
        user,
        target_staff_id,
    ):
        return fail(
            "You cannot move this event to another employee",
            403,
        )

    payload["updated_at"] = (
        datetime
        .now(timezone.utc)
        .isoformat()
    )

    current_org = (
        get_current_org_id()
    )

    result = (
        supabase
        .table("calendar_events")
        .update(payload)
        .eq(
            "org_id",
            current_org,
        )
        .eq(
            "id",
            event_id,
        )
        .execute()
    )

    if not result.data:
        return fail(
            "Calendar event not found",
            404,
        )

    return ok(
        result.data[0]
    )


# =========================
# API: STAFF SCHEDULE
# =========================
@app.get("/api/staff-schedule")
def api_get_staff_schedule():
    try:
        current_org = (
            get_current_org_id()
        )

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        work_date = str(
            request.args.get("date")
            or ""
        ).strip()

        def build_query():
            query = (
                supabase
                .table("staff_schedule")
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
            )

            if work_date:
                query = query.eq(
                    "work_date",
                    work_date,
                )

            return query.order(
                "work_date"
            )

        result = execute_with_retry(
            build_query,
            attempts=3,
            delay=0.25,
        )

        return ok(
            result.data or []
        )

    except Exception as error:
        print(
            "❌ GET /api/staff-schedule error:",
            repr(error),
        )

        return fail(
            f"Cannot load staff schedule: {error}",
            500,
        )

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
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error    
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
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error    
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
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    try:
        owner_id = request.args.get(
            "owner_id"
        )

        current_org = (
            get_current_org_id()
        )

        query = (
            supabase
            .table("patients")
            .select("*")
            .eq("org_id", current_org)
        )

        if owner_id:
            query = query.eq(
                "owner_id",
                owner_id
            )

        result = query.execute()

        return ok(
            result.data or []
        )

    except Exception as error:
        print(
            "❌ GET /api/patients:",
            repr(error)
        )

        return fail(
            "Не вдалося завантажити пацієнтів.",
            500
        )


@app.post("/api/patients")
def api_create_patient():
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    owner_id = str(
        data.get("owner_id") or ""
    ).strip()

    name = str(
        data.get("name") or ""
    ).strip()

    if not owner_id or not name:
        return fail(
            "owner_id and name required",
            400
        )

    current_org = (
        get_current_org_id()
    )

    try:
        owner_result = (
            supabase
            .table("owners")
            .select("id")
            .eq("org_id", current_org)
            .eq("id", owner_id)
            .limit(1)
            .execute()
        )

        if not owner_result.data:
            return fail(
                "Власника не знайдено у цій клініці.",
                404
            )

        payload = {
            "org_id": current_org,
            "owner_id": owner_id,
            "name": name,
            "species": data.get("species"),
            "breed": data.get("breed"),
            "age": data.get("age"),
            "weight_kg": data.get(
                "weight_kg"
            ),
            "notes": (
                data.get("notes")
                or data.get("note")
            ),
        }

        result = (
            insert_with_optional_fallback(
                "patients",
                payload,
                optional_fields=["notes"]
            )
        )

        row = (
            result.data[0]
            if getattr(
                result,
                "data",
                None
            )
            else payload
        )

        return ok(row)

    except Exception as error:
        print(
            "❌ POST /api/patients:",
            repr(error)
        )

        return fail(
            "Не вдалося створити пацієнта.",
            500
        )


@app.delete("/api/patients/<pet_id>")
def api_delete_patient(pet_id):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    if not pet_id:
        return fail(
            "pet_id required",
            400
        )

    current_org = (
        get_current_org_id()
    )

    try:
        result = (
            supabase
            .table("patients")
            .delete()
            .eq("org_id", current_org)
            .eq("id", pet_id)
            .execute()
        )

        if not result.data:
            return fail(
                "Пацієнта не знайдено.",
                404
            )

        return ok(True)

    except Exception as error:
        print(
            "❌ DELETE /api/patients:",
            repr(error)
        )

        return fail(
            "Не вдалося видалити пацієнта.",
            500
        )
# =========================
# API: HOSPITALIZATIONS
# =========================

HOSPITAL_ALLOWED_STATUSES = {
    "stable",
    "observation",
    "critical",
}


def enrich_hospitalizations(rows):
    """
    Подтягивает к госпитализациям данные пациента,
    владельца и лечащего врача.
    """

    rows = rows or []

    if not rows:
        return []

    current_org = get_current_org_id()

    patient_ids = list({
        str(row.get("patient_id"))
        for row in rows
        if row.get("patient_id")
    })

    doctor_ids = list({
        str(row.get("doctor_id"))
        for row in rows
        if row.get("doctor_id")
    })

    patients_map = {}
    owners_map = {}
    staff_map = {}

    # =====================
    # Пациенты
    # =====================

    if patient_ids:
        patients_res = (
            supabase
            .table("patients")
            .select("*")
            .eq("org_id", current_org)
            .in_("id", patient_ids)
            .execute()
        )

        patients = patients_res.data or []

        patients_map = {
            str(patient.get("id")): patient
            for patient in patients
            if patient.get("id")
        }

        owner_ids = list({
            str(patient.get("owner_id"))
            for patient in patients
            if patient.get("owner_id")
        })

        # =====================
        # Владельцы
        # =====================

        if owner_ids:
            owners_res = (
                supabase
                .table("owners")
                .select("*")
                .eq("org_id", current_org)
                .in_("id", owner_ids)
                .execute()
            )

            owners_map = {
                str(owner.get("id")): owner
                for owner in (owners_res.data or [])
                if owner.get("id")
            }

    # =====================
    # Врачи
    # =====================

    if doctor_ids:
        staff_res = (
            supabase
            .table("staff")
            .select("*")
            .eq("org_id", current_org)
            .in_("id", doctor_ids)
            .execute()
        )

        staff_map = {
            str(staff.get("id")): staff
            for staff in (staff_res.data or [])
            if staff.get("id")
        }

    enriched = []

    for row in rows:
        item = dict(row)

        patient = patients_map.get(
            str(item.get("patient_id"))
        ) or {}

        owner = owners_map.get(
            str(patient.get("owner_id"))
        ) or {}

        doctor = staff_map.get(
            str(item.get("doctor_id"))
        ) or {}

        item["patient"] = patient
        item["owner"] = owner
        item["doctor"] = doctor

        item["patient_name"] = (
            patient.get("name")
            or "Пацієнт"
        )

        item["patient_species"] = (
            patient.get("species")
            or ""
        )

        item["patient_breed"] = (
            patient.get("breed")
            or ""
        )

        item["owner_name"] = (
            owner.get("name")
            or "Власник не вказаний"
        )

        item["owner_phone"] = (
            owner.get("phone")
            or ""
        )

        item["doctor_name"] = (
            doctor.get("name")
            or "Лікар не вказаний"
        )

        enriched.append(item)

    return enriched


@app.get("/api/hospitalizations")
def api_get_hospitalizations():
    try:
        current_org = get_current_org_id()

        if not current_org:
            return fail(
                "Organization not selected",
                400
            )

        active_raw = request.args.get(
            "active"
        )

        patient_id = (
            request.args.get("patient_id")
            or ""
        ).strip()

        hospitalization_id = (
            request.args.get("id")
            or ""
        ).strip()

        query = (
            supabase
            .table("hospitalizations")
            .select("*")
            .eq("org_id", current_org)
        )

        if active_raw is not None:
            active_value = (
                str(active_raw).lower()
                in ("1", "true", "yes")
            )

            query = query.eq(
                "is_active",
                active_value
            )

        if patient_id:
            query = query.eq(
                "patient_id",
                patient_id
            )

        if hospitalization_id:
            query = query.eq(
                "id",
                hospitalization_id
            )

        result = (
            query
            .order(
                "admitted_at",
                desc=True
            )
            .execute()
        )

        rows = enrich_hospitalizations(
            result.data or []
        )

        return ok(rows)

    except Exception as error:
        print(
            "❌ /api/hospitalizations GET error:",
            repr(error)
        )

        return fail(
            f"Cannot load hospitalizations: {error}",
            500
        )


@app.post("/api/hospitalizations")
def api_create_hospitalization():
    try:
        current_org = get_current_org_id()

        if not current_org:
            return fail(
                "Organization not selected",
                400
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        patient_id = str(
            data.get("patient_id")
            or ""
        ).strip()

        doctor_id = str(
            data.get("doctor_id")
            or ""
        ).strip()

        status = str(
            data.get("status")
            or "observation"
        ).strip()

        if not patient_id:
            return fail(
                "patient_id required",
                400
            )

        if status not in HOSPITAL_ALLOWED_STATUSES:
            return fail(
                "Invalid hospitalization status",
                400
            )

        # Проверяем, что пациент принадлежит
        # текущей клинике.

        patient_res = (
            supabase
            .table("patients")
            .select("id")
            .eq("org_id", current_org)
            .eq("id", patient_id)
            .limit(1)
            .execute()
        )

        if not patient_res.data:
            return fail(
                "Patient not found",
                404
            )

        # Проверяем, что пациент ещё
        # не находится в стационаре.

        existing_res = (
            supabase
            .table("hospitalizations")
            .select("id")
            .eq("org_id", current_org)
            .eq("patient_id", patient_id)
            .eq("is_active", True)
            .limit(1)
            .execute()
        )

        if existing_res.data:
            return fail(
                "Patient is already hospitalized",
                409
            )

        payload = {
            "org_id": current_org,
            "patient_id": patient_id,
            "doctor_id": doctor_id or None,
            "status": status,
            "room": (
                str(
                    data.get("room")
                    or ""
                ).strip()
                or None
            ),
            "diagnosis": (
                str(
                    data.get("diagnosis")
                    or ""
                ).strip()
                or None
            ),
            "notes": (
                str(
                    data.get("notes")
                    or ""
                ).strip()
                or None
            ),
            "admitted_at": (
                data.get("admitted_at")
                or datetime.now(
                    timezone.utc
                ).isoformat()
            ),
            "planned_discharge_at": (
                data.get(
                    "planned_discharge_at"
                )
                or None
            ),
            "is_active": True,
            "updated_at": datetime.now(
                timezone.utc
            ).isoformat(),
        }

        result = (
            supabase
            .table("hospitalizations")
            .insert(
                clean_payload(payload)
            )
            .execute()
        )

        row = (
            result.data[0]
            if result.data
            else payload
        )

        enriched = enrich_hospitalizations(
            [row]
        )

        return ok(
            enriched[0]
            if enriched
            else row
        )

    except Exception as error:
        print(
            "❌ /api/hospitalizations POST error:",
            repr(error)
        )

        return fail(
            f"Cannot create hospitalization: {error}",
            500
        )


@app.put("/api/hospitalizations/<hospitalization_id>")
def api_update_hospitalization(
    hospitalization_id
):
    try:
        current_org = get_current_org_id()

        if not hospitalization_id:
            return fail(
                "hospitalization_id required",
                400
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        allowed_fields = [
            "doctor_id",
            "status",
            "room",
            "diagnosis",
            "notes",
            "planned_discharge_at",
        ]

        payload = {
            field: data.get(field)
            for field in allowed_fields
            if field in data
        }

        if "status" in payload:
            status = str(
                payload.get("status")
                or ""
            ).strip()

            if status not in HOSPITAL_ALLOWED_STATUSES:
                return fail(
                    "Invalid hospitalization status",
                    400
                )

            payload["status"] = status

        for field in [
            "room",
            "diagnosis",
            "notes",
            "doctor_id",
        ]:
            if field in payload:
                value = payload.get(field)

                if isinstance(value, str):
                    value = value.strip()

                payload[field] = (
                    value
                    if value not in ("", None)
                    else None
                )

        if not payload:
            return fail(
                "Nothing to update",
                400
            )

        payload["updated_at"] = (
            datetime.now(
                timezone.utc
            ).isoformat()
        )

        result = (
            supabase
            .table("hospitalizations")
            .update(payload)
            .eq("org_id", current_org)
            .eq("id", hospitalization_id)
            .execute()
        )

        if not result.data:
            return fail(
                "Hospitalization not found",
                404
            )

        enriched = enrich_hospitalizations(
            [result.data[0]]
        )

        return ok(
            enriched[0]
            if enriched
            else result.data[0]
        )

    except Exception as error:
        print(
            "❌ /api/hospitalizations PUT error:",
            repr(error)
        )

        return fail(
            f"Cannot update hospitalization: {error}",
            500
        )


@app.post("/api/hospitalizations/<hospitalization_id>/discharge")
def api_discharge_hospitalization(
    hospitalization_id
):
    try:
        current_user = (
            get_current_user()
        )

        if not current_user:
            return fail(
                "Authentication required",
                401
            )

        current_role = str(
            current_user.get("role")
            or ""
        ).lower()

        if current_role == "assistant":
            return fail(
                "Assistant cannot discharge hospitalized patients",
                403
            )

        current_org = (
            get_current_org_id()
        )

        if not hospitalization_id:
            return fail(
                "hospitalization_id required",
                400
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        discharged_at = (
            data.get("discharged_at")
            or datetime.now(
                timezone.utc
            ).isoformat()
        )

        payload = {
            "is_active": False,
            "discharged_at":
                discharged_at,
            "updated_at":
                datetime.now(
                    timezone.utc
                ).isoformat(),
        }

        if "notes" in data:
            payload["notes"] = (
                str(
                    data.get("notes")
                    or ""
                ).strip()
                or None
            )

        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "hospitalizations"
                )
                .update(payload)
                .eq(
                    "org_id",
                    current_org
                )
                .eq(
                    "id",
                    hospitalization_id
                )
                .eq(
                    "is_active",
                    True
                )
            ),
            attempts=3,
            delay=0.25,
        )

        if not result.data:
            return fail(
                "Active hospitalization not found",
                404
            )

        enriched = (
            enrich_hospitalizations(
                [result.data[0]]
            )
        )

        return ok(
            enriched[0]
            if enriched
            else result.data[0]
        )

    except Exception as error:
        print(
            "❌ hospitalization discharge error:",
            repr(error)
        )

        return fail(
            f"Cannot discharge hospitalization: {error}",
            500
        )
    
    # =========================
# API: HOSPITAL TASKS
# =========================

HOSPITAL_TASK_TYPES = {
    "medication",
    "infusion",
    "feeding",
    "measurement",
    "procedure",
    "examination",
    "other",
}

HOSPITAL_TASK_STATUSES = {
    "planned",
    "completed",
    "cancelled",
    "overdue",
}


def enrich_hospital_tasks(rows):
    rows = rows or []

    if not rows:
        return []

    current_org = get_current_org_id()

    staff_ids = list({
        str(row.get("completed_by"))
        for row in rows
        if row.get("completed_by")
    })

    staff_map = {}

    if staff_ids:
        staff_res = (
            supabase
            .table("staff")
            .select("id, name, role, color")
            .eq("org_id", current_org)
            .in_("id", staff_ids)
            .execute()
        )

        staff_map = {
            str(item.get("id")): item
            for item in (staff_res.data or [])
            if item.get("id")
        }

    enriched = []

    for row in rows:
        item = dict(row)

        completed_by = staff_map.get(
            str(item.get("completed_by"))
        ) or {}

        item["completed_by_name"] = (
            completed_by.get("name")
            or ""
        )

        item["completed_by_staff"] = (
            completed_by
        )

        enriched.append(item)

    return enriched


@app.get(
    "/api/hospitalizations/"
    "<hospitalization_id>/tasks"
)
def api_get_hospital_tasks(
    hospitalization_id
):
    try:
        current_org = (
            get_current_org_id()
        )

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        hospitalization_id = str(
            hospitalization_id or ""
        ).strip()

        if not hospitalization_id:
            return fail(
                "hospitalization_id required",
                400,
            )

        status = str(
            request.args.get(
                "status"
            ) or ""
        ).strip()

        date_from = str(
            request.args.get(
                "from"
            ) or ""
        ).strip()

        date_to = str(
            request.args.get(
                "to"
            ) or ""
        ).strip()

        def build_query():
            query = (
                supabase
                .table(
                    "hospital_tasks"
                )
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "hospitalization_id",
                    hospitalization_id,
                )
            )

            if status:
                query = query.eq(
                    "status",
                    status,
                )

            if date_from:
                query = query.gte(
                    "scheduled_at",
                    date_from,
                )

            if date_to:
                query = query.lte(
                    "scheduled_at",
                    date_to,
                )

            return query.order(
                "scheduled_at"
            )

        result = execute_with_retry(
            build_query,
            attempts=3,
            delay=0.35,
        )

        rows = result.data or []

        try:
            rows = (
                enrich_hospital_tasks(
                    rows
                )
            )
        except Exception as enrich_error:
            print(
                "⚠️ enrich hospital "
                "tasks error:",
                repr(enrich_error),
            )

        return ok(rows)

    except Exception as error:
        print(
            "❌ GET hospital tasks "
            "error:",
            repr(error),
        )

        return fail(
            "Cannot load hospital "
            f"tasks: {error}",
            500,
        )


@app.post("/api/hospitalizations/<hospitalization_id>/tasks")
def api_create_hospital_task(
    hospitalization_id
):
    try:
        current_org = get_current_org_id()

        if not current_org:
            return fail(
                "Organization not selected",
                400
            )

        if not hospitalization_id:
            return fail(
                "hospitalization_id required",
                400
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        task_type = str(
            data.get("task_type")
            or "other"
        ).strip()

        title = str(
            data.get("title")
            or ""
        ).strip()

        scheduled_at = (
            data.get("scheduled_at")
            or ""
        )

        if task_type not in HOSPITAL_TASK_TYPES:
            return fail(
                "Invalid hospital task type",
                400
            )

        if not title:
            return fail(
                "title required",
                400
            )

        if not scheduled_at:
            return fail(
                "scheduled_at required",
                400
            )

        hospitalization_res = (
            supabase
            .table("hospitalizations")
            .select("id, is_active")
            .eq("org_id", current_org)
            .eq("id", hospitalization_id)
            .limit(1)
            .execute()
        )

        if not hospitalization_res.data:
            return fail(
                "Hospitalization not found",
                404
            )

        if (
            hospitalization_res.data[0]
            .get("is_active")
            is False
        ):
            return fail(
                "Hospitalization is already closed",
                409
            )

        current_user = get_current_user()

        payload = {
            "org_id": current_org,
            "hospitalization_id":
                hospitalization_id,
            "task_type": task_type,
            "title": title,
            "instructions": (
                str(
                    data.get("instructions")
                    or ""
                ).strip()
                or None
            ),
            "scheduled_at": scheduled_at,
            "status": "planned",
            "created_at": datetime.now(
                timezone.utc
            ).isoformat(),
            "updated_at": datetime.now(
                timezone.utc
            ).isoformat(),
        }

        if current_user:
            creator_name = (
                current_user.get(
                    "display_name"
                )
                or current_user.get(
                    "username"
                )
            )

            if creator_name:
                payload["completion_note"] = (
                    f"Створено: {creator_name}"
                )

        result = (
            supabase
            .table("hospital_tasks")
            .insert(
                clean_payload(payload)
            )
            .execute()
        )

        row = (
            result.data[0]
            if result.data
            else payload
        )

        return ok(row)

    except Exception as error:
        print(
            "❌ POST hospital task error:",
            repr(error)
        )

        return fail(
            f"Cannot create hospital task: {error}",
            500
        )


@app.put("/api/hospital-tasks/<task_id>")
def api_update_hospital_task(task_id):
    try:
        current_org = get_current_org_id()

        if not task_id:
            return fail(
                "task_id required",
                400
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        allowed_fields = [
            "task_type",
            "title",
            "instructions",
            "scheduled_at",
            "status",
            "completion_note",
        ]

        payload = {
            field: data.get(field)
            for field in allowed_fields
            if field in data
        }

        if "task_type" in payload:
            task_type = str(
                payload.get("task_type")
                or ""
            ).strip()

            if task_type not in HOSPITAL_TASK_TYPES:
                return fail(
                    "Invalid hospital task type",
                    400
                )

            payload["task_type"] = (
                task_type
            )

        if "status" in payload:
            status = str(
                payload.get("status")
                or ""
            ).strip()

            if status not in HOSPITAL_TASK_STATUSES:
                return fail(
                    "Invalid hospital task status",
                    400
                )

            payload["status"] = status

        for field in [
            "title",
            "instructions",
            "completion_note",
        ]:
            if field in payload:
                value = payload.get(field)

                if isinstance(value, str):
                    value = value.strip()

                payload[field] = (
                    value
                    if value not in ("", None)
                    else None
                )

        if not payload:
            return fail(
                "Nothing to update",
                400
            )

        payload["updated_at"] = (
            datetime.now(
                timezone.utc
            ).isoformat()
        )

        result = (
            supabase
            .table("hospital_tasks")
            .update(payload)
            .eq("org_id", current_org)
            .eq("id", task_id)
            .execute()
        )

        if not result.data:
            return fail(
                "Hospital task not found",
                404
            )

        return ok(result.data[0])

    except Exception as error:
        print(
            "❌ PUT hospital task error:",
            repr(error)
        )

        return fail(
            f"Cannot update hospital task: {error}",
            500
        )


@app.post("/api/hospital-tasks/<task_id>/complete")
def api_complete_hospital_task(task_id):
    try:
        current_org = get_current_org_id()

        if not task_id:
            return fail(
                "task_id required",
                400
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        completed_by = str(
            data.get("completed_by")
            or ""
        ).strip()

        payload = {
            "status": "completed",
            "completed_at": (
                data.get("completed_at")
                or datetime.now(
                    timezone.utc
                ).isoformat()
            ),
            "completion_note": (
                str(
                    data.get(
                        "completion_note"
                    )
                    or ""
                ).strip()
                or None
            ),
            "updated_at": datetime.now(
                timezone.utc
            ).isoformat(),
        }

        if completed_by:
            staff_res = (
                supabase
                .table("staff")
                .select("id")
                .eq("org_id", current_org)
                .eq("id", completed_by)
                .limit(1)
                .execute()
            )

            if not staff_res.data:
                return fail(
                    "Staff member not found",
                    404
                )

            payload["completed_by"] = (
                completed_by
            )

        result = (
            supabase
            .table("hospital_tasks")
            .update(
                clean_payload(payload)
            )
            .eq("org_id", current_org)
            .eq("id", task_id)
            .execute()
        )

        if not result.data:
            return fail(
                "Hospital task not found",
                404
            )

        enriched = enrich_hospital_tasks(
            [result.data[0]]
        )

        return ok(
            enriched[0]
            if enriched
            else result.data[0]
        )

    except Exception as error:
        print(
            "❌ COMPLETE hospital task error:",
            repr(error)
        )

        return fail(
            f"Cannot complete hospital task: {error}",
            500
        )


@app.delete("/api/hospital-tasks/<task_id>")
def api_delete_hospital_task(task_id):
    try:
        current_org = get_current_org_id()

        if not task_id:
            return fail(
                "task_id required",
                400
            )

        result = (
            supabase
            .table("hospital_tasks")
            .delete()
            .eq("org_id", current_org)
            .eq("id", task_id)
            .execute()
        )

        return ok(True)

    except Exception as error:
        print(
            "❌ DELETE hospital task error:",
            repr(error)
        )

        return fail(
            f"Cannot delete hospital task: {error}",
            500
        )
# =========================
# API: VISITS
# =========================
# =========================
# API: VISITS
# =========================
@app.get("/api/visits")
def api_get_visits():
    try:
        current_org = get_current_org_id()

        if not current_org:
            return fail(
                "Organization not selected",
                400
            )

        visit_id = str(
            request.args.get("id") or ""
        ).strip()

        pet_id = str(
            request.args.get("pet_id") or ""
        ).strip()

        if visit_id and len(visit_id) < 10:
            return fail(
                "invalid visit id",
                400
            )

        query = (
            supabase
            .table("visits")
            .select("*")
            .eq("org_id", current_org)
        )

        if visit_id:
            query = query.eq(
                "id",
                visit_id
            )

        if pet_id:
            query = query.eq(
                "pet_id",
                pet_id
            )

        result = query.execute()
        rows = result.data or []

        visit_ids = [
            row.get("id")
            for row in rows
            if row.get("id")
        ]

        services_by_visit = {}
        stock_by_visit = {}

        if visit_ids:
            try:
                (
                    services_by_visit,
                    stock_by_visit,
                ) = load_visit_lines(
                    visit_ids
                )

            except Exception as lines_error:
                print(
                    "⚠️ load_visit_lines error:",
                    repr(lines_error)
                )

                services_by_visit = {}
                stock_by_visit = {}

        for row in rows:
            current_visit_id = (
                row.get("id")
            )

            row["services"] = (
                services_by_visit.get(
                    current_visit_id,
                    []
                )
            )

            row["stock"] = (
                stock_by_visit.get(
                    current_visit_id,
                    []
                )
            )

        return ok(rows)

    except Exception as error:
        print(
            "❌ GET /api/visits error:",
            repr(error)
        )

        return fail(
            f"Cannot load visits: {error}",
            500
        )


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

    

    services_map, stock_map = load_visit_lines([visit_id])
    row["services"] = services_map.get(visit_id, [])
    row["stock"] = stock_map.get(visit_id, [])

    return ok(row)

@app.put("/api/visits")
def api_update_visit():
    try:
        current_org = (
            get_current_org_id()
        )

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        visit_id = str(
            request.args.get("id")
            or data.get("id")
            or ""
        ).strip()

        if not visit_id:
            return fail(
                "visit id required",
                400,
            )

        existing_result = execute_with_retry(
            lambda: (
                supabase
                .table("visits")
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "id",
                    visit_id,
                )
                .limit(1)
            ),
            attempts=3,
            delay=0.25,
        )

        if not existing_result.data:
            return fail(
                "Visit not found",
                404,
            )

        allowed_fields = [
            "pet_id",
            "staff_id",
            "date",
            "note",
            "dx",
            "rx",
            "weight_kg",
        ]

        payload = {
            field: data.get(field)
            for field in allowed_fields
            if field in data
        }

        payload = {
            key: value
            for key, value in payload.items()
            if value is not None
        }

        if payload:
            update_result = execute_with_retry(
                lambda: (
                    supabase
                    .table("visits")
                    .update(payload)
                    .eq(
                        "org_id",
                        current_org,
                    )
                    .eq(
                        "id",
                        visit_id,
                    )
                ),
                attempts=3,
                delay=0.25,
            )

            if not update_result.data:
                return fail(
                    "Visit not found",
                    404,
                )

            row = update_result.data[0]

        else:
            row = existing_result.data[0]

        if (
            "services" in data
            or "services_json" in data
            or "stock" in data
            or "stock_json" in data
        ):
            save_visit_lines(
                visit_id,
                data,
            )

        services_map, stock_map = (
            load_visit_lines([
                visit_id
            ])
        )

        row["services"] = (
            services_map.get(
                visit_id,
                []
            )
        )

        row["stock"] = (
            stock_map.get(
                visit_id,
                []
            )
        )

        return ok(row)

    except Exception as error:
        print(
            "❌ PUT /api/visits error:",
            repr(error),
        )

        return fail(
            f"Cannot update visit: {error}",
            500,
        )


@app.delete("/api/visits/<visit_id>")
def api_delete_visit(
    visit_id
):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    if not visit_id:
        return fail(
            "visit_id required",
            400
        )

    current_org = (
        get_current_org_id()
    )

    current_user_id = (
        user.get("id")
    )

    if not current_org:
        return fail(
            "Organization not selected",
            400
        )

    if not current_user_id:
        return fail(
            "User not found",
            401
        )

    try:
        result = (
            supabase
            .rpc(
                "delete_visit_with_stock_restore",
                {
                    "p_org_id":
                        current_org,

                    "p_visit_id":
                        visit_id,

                    "p_user_id":
                        current_user_id,
                },
            )
            .execute()
        )

        data = (
            result.data
            if result.data
            is not None
            else {
                "deleted": True,
                "restored_positions": 0,
                "restored_quantity": 0,
            }
        )

        if (
            isinstance(data, list)
            and data
        ):
            data = data[0]

        return ok(data)

    except Exception as error:
        print(
            "❌ Delete visit with stock restore:",
            repr(error),
            flush=True,
        )

        return fail(
            (
                "Не вдалося видалити візит "
                "та повернути препарати на склад."
            ),
            500
        )

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

# =====================================================
# STAFF CRM ACCOUNTS
# =====================================================

STAFF_ACCOUNT_ROLES = {
    "admin",
    "vet",
    "assistant",
}


def serialize_staff_account(row):
    if not row:
        return None

    return {
        "id": row.get("id"),
        "staff_id": row.get("staff_id"),
        "username": row.get("username"),
        "display_name": row.get("display_name"),
        "role": row.get("role"),
        "is_active": row.get("is_active") is not False,
        "must_change_password": bool(
            row.get("must_change_password")
        ),
        "last_login_at": row.get("last_login_at"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def get_staff_for_owner(
    org_id,
    staff_id,
):
    result = (
        supabase
        .table("staff")
        .select(
            "id, name, role, is_active"
        )
        .eq(
            "org_id",
            str(org_id),
        )
        .eq(
            "id",
            str(staff_id),
        )
        .limit(1)
        .execute()
    )

    if not result.data:
        return None

    return result.data[0]


@app.get(
    "/api/staff/<staff_id>/account"
)
def api_get_staff_account(
    staff_id,
):
    user, error_response = (
        owner_required()
    )

    if error_response:
        return error_response

    org_id = str(
        user.get("org_id")
    )

    try:
        staff_row = get_staff_for_owner(
            org_id,
            staff_id,
        )

        if not staff_row:
            return fail(
                "Співробітника не знайдено",
                404,
            )

        result = (
            supabase
            .table("clinic_users")
            .select(
                "id, staff_id, username, "
                "display_name, role, is_active, "
                "must_change_password, "
                "last_login_at, created_at, "
                "updated_at"
            )
            .eq(
                "org_id",
                org_id,
            )
            .eq(
                "staff_id",
                str(staff_id),
            )
            .limit(1)
            .execute()
        )

        account = (
            result.data[0]
            if result.data
            else None
        )

        return ok(
            serialize_staff_account(
                account
            )
        )

    except Exception as error:
        print(
            "❌ get staff account:",
            repr(error),
        )

        return fail(
            "Не вдалося завантажити акаунт",
            500,
        )


@app.post(
    "/api/staff/<staff_id>/account"
)
def api_create_staff_account(
    staff_id,
):
    user, error_response = (
        owner_required()
    )

    if error_response:
        return error_response

    org_id = str(
        user.get("org_id")
    )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    username = str(
        data.get("username")
        or ""
    ).strip()

    password = str(
        data.get("password")
        or ""
    )

    role = str(
        data.get("role")
        or "vet"
    ).strip().lower()

    if len(username) < 3:
        return fail(
            "Логін повинен містити мінімум 3 символи",
            400,
        )

    if " " in username:
        return fail(
            "Логін не повинен містити пробіли",
            400,
        )

    if len(password) < 8:
        return fail(
            "Тимчасовий пароль повинен містити мінімум 8 символів",
            400,
        )

    if role not in STAFF_ACCOUNT_ROLES:
        return fail(
            "Невірна роль доступу",
            400,
        )

    try:
        staff_row = get_staff_for_owner(
            org_id,
            staff_id,
        )

        if not staff_row:
            return fail(
                "Співробітника не знайдено",
                404,
            )

        existing_staff_account = (
            supabase
            .table("clinic_users")
            .select("id")
            .eq(
                "org_id",
                org_id,
            )
            .eq(
                "staff_id",
                str(staff_id),
            )
            .limit(1)
            .execute()
        )

        if existing_staff_account.data:
            return fail(
                "Для цього співробітника акаунт уже створено",
                409,
            )

        existing_username = (
            supabase
            .table("clinic_users")
            .select("id")
            .ilike(
                "username",
                username,
            )
            .limit(1)
            .execute()
        )

        if existing_username.data:
            return fail(
                "Цей логін уже використовується",
                409,
            )

        now_iso = (
            datetime
            .now(timezone.utc)
            .isoformat()
        )

        result = (
            supabase
            .table("clinic_users")
            .insert({
                "org_id": org_id,
                "staff_id": str(
                    staff_id
                ),
                "username": username,
                "display_name": (
                    staff_row.get("name")
                    or username
                ),
                "role": role,
                "password_hash":
                    generate_password_hash(
                        password
                    ),
                "is_active": True,
                "must_change_password":
                    True,
                "created_at": now_iso,
                "updated_at": now_iso,
            })
            .execute()
        )

        account = (
            result.data[0]
            if result.data
            else None
        )

        if not account:
            return fail(
                "Не вдалося створити акаунт",
                500,
            )

        return ok(
            serialize_staff_account(
                account
            )
        )

    except Exception as error:
        print(
            "❌ create staff account:",
            repr(error),
        )

        return fail(
            "Не вдалося створити акаунт",
            500,
        )


@app.put(
    "/api/staff/<staff_id>/account"
)
def api_update_staff_account(
    staff_id,
):
    user, error_response = (
        owner_required()
    )

    if error_response:
        return error_response

    org_id = str(
        user.get("org_id")
    )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    try:
        result = (
            supabase
            .table("clinic_users")
            .select(
                "id, username"
            )
            .eq(
                "org_id",
                org_id,
            )
            .eq(
                "staff_id",
                str(staff_id),
            )
            .limit(1)
            .execute()
        )

        if not result.data:
            return fail(
                "Акаунт співробітника не знайдено",
                404,
            )

        current_account = (
            result.data[0]
        )

        payload = {}

        if "username" in data:
            username = str(
                data.get("username")
                or ""
            ).strip()

            if len(username) < 3:
                return fail(
                    "Логін повинен містити мінімум 3 символи",
                    400,
                )

            if " " in username:
                return fail(
                    "Логін не повинен містити пробіли",
                    400,
                )

            duplicate_result = (
                supabase
                .table("clinic_users")
                .select(
                    "id, username"
                )
                .ilike(
                    "username",
                    username,
                )
                .limit(5)
                .execute()
            )

            duplicate_exists = any(
                str(row.get("id"))
                != str(
                    current_account.get("id")
                )
                for row in (
                    duplicate_result.data
                    or []
                )
            )

            if duplicate_exists:
                return fail(
                    "Цей логін уже використовується",
                    409,
                )

            payload["username"] = (
                username
            )

        if "role" in data:
            role = str(
                data.get("role")
                or ""
            ).strip().lower()

            if role not in (
                STAFF_ACCOUNT_ROLES
            ):
                return fail(
                    "Невірна роль доступу",
                    400,
                )

            payload["role"] = role

        if "is_active" in data:
            payload["is_active"] = bool(
                data.get("is_active")
            )

        if not payload:
            return fail(
                "Немає змін для збереження",
                400,
            )

        payload["updated_at"] = (
            datetime
            .now(timezone.utc)
            .isoformat()
        )

        update_result = (
            supabase
            .table("clinic_users")
            .update(payload)
            .eq(
                "org_id",
                org_id,
            )
            .eq(
                "staff_id",
                str(staff_id),
            )
            .execute()
        )

        account = (
            update_result.data[0]
            if update_result.data
            else None
        )

        return ok(
            serialize_staff_account(
                account
            )
        )

    except Exception as error:
        print(
            "❌ update staff account:",
            repr(error),
        )

        return fail(
            "Не вдалося оновити акаунт",
            500,
        )


@app.post(
    "/api/staff/<staff_id>/account/reset-password"
)
def api_reset_staff_password(
    staff_id,
):
    user, error_response = (
        owner_required()
    )

    if error_response:
        return error_response

    org_id = str(
        user.get("org_id")
    )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    password = str(
        data.get("password")
        or ""
    )

    if len(password) < 8:
        return fail(
            "Новий тимчасовий пароль повинен містити мінімум 8 символів",
            400,
        )

    try:
        existing_result = (
            supabase
            .table("clinic_users")
            .select("id")
            .eq(
                "org_id",
                org_id,
            )
            .eq(
                "staff_id",
                str(staff_id),
            )
            .limit(1)
            .execute()
        )

        if not existing_result.data:
            return fail(
                "Акаунт співробітника не знайдено",
                404,
            )

        now_iso = (
            datetime
            .now(timezone.utc)
            .isoformat()
        )

        update_result = (
            supabase
            .table("clinic_users")
            .update({
                "password_hash":
                    generate_password_hash(
                        password
                    ),
                "must_change_password":
                    True,
                "updated_at": now_iso,
            })
            .eq(
                "org_id",
                org_id,
            )
            .eq(
                "staff_id",
                str(staff_id),
            )
            .execute()
        )

        account = (
            update_result.data[0]
            if update_result.data
            else None
        )

        return ok(
            serialize_staff_account(
                account
            )
        )

    except Exception as error:
        print(
            "❌ reset staff password:",
            repr(error),
        )

        return fail(
            "Не вдалося скинути пароль",
            500,
        )
# =========================
# LOGIN
# =========================
@app.post("/api/login")
def api_clinic_login():
    data = request.get_json(silent=True) or {}

    username = str(
        data.get("username") or ""
    ).strip()

    password = str(
        data.get("password") or ""
    )

    if not username or not password:
        return jsonify({
            "ok": False,
            "error": "Введіть логін та пароль",
        }), 400

    try:
        result = (
            supabase
            .table("clinic_users")
            .select(
                "id, username, password_hash, "
                "org_id, staff_id, role, display_name, is_active, "
                "must_change_password"
            )
            .ilike("username", username)
            .limit(1)
            .execute()
        )

        if not result.data:
            return jsonify({
                "ok": False,
                "error": "Невірний логін або пароль",
            }), 401

        user_data = result.data[0]

        if user_data.get("is_active") is False:
            return jsonify({
                "ok": False,
                "error": "Обліковий запис вимкнений",
            }), 403

        stored_hash = str(
            user_data.get("password_hash") or ""
        ).strip()

        if not stored_hash:
            return jsonify({
                "ok": False,
                "error": "Пароль користувача не налаштований",
            }), 403

        try:
            password_valid = check_password_hash(
                stored_hash,
                password,
            )
        except Exception as hash_error:
            print(
                "⚠️ password hash check failed:",
                repr(hash_error),
            )

            password_valid = False

        if not password_valid:
            return jsonify({
                "ok": False,
                "error": "Невірний логін або пароль",
            }), 401

        now_iso = (
            datetime
            .now(timezone.utc)
            .isoformat()
        )

        (
            supabase
            .table("clinic_users")
            .update({
                "last_login_at": now_iso,
                "updated_at": now_iso,
            })
            .eq("id", user_data.get("id"))
            .execute()
        )

        org_id = user_data.get("org_id")

        if not org_id:
            return jsonify({
                "ok": False,
                "error": (
                    "Користувач не прив’язаний "
                    "до клініки"
                ),
            }), 400

        # =================================================
        # СОЗДАЁМ ЗАЩИЩЁННУЮ СЕРВЕРНУЮ СЕССИЮ
        # =================================================

        session.clear()
        session.permanent = True

        session["user_id"] = str(
            user_data.get("id")
        )

        session["org_id"] = str(
            org_id
        )

        session["staff_id"] = (
            str(user_data.get("staff_id"))
            if user_data.get("staff_id")
            else None
        )

        session["username"] = str(
            user_data.get("username") or ""
        )

        session["display_name"] = str(
            user_data.get("display_name")
            or user_data.get("username")
            or "Користувач"
        )

        session["role"] = str(
            user_data.get("role")
            or "vet"
        )

        session["must_change_password"] = bool(
            user_data.get(
                "must_change_password"
            )
        )

        clinic_name = "Клініка"
        theme = "purple"

        try:
            org_result = (
                supabase
                .table("orgs")
                .select("name, theme")
                .eq("id", org_id)
                .limit(1)
                .execute()
            )

            if org_result.data:
                clinic_name = (
                    org_result.data[0].get("name")
                    or clinic_name
                )
                theme = (
                    org_result.data[0].get("theme")
                    or theme
                )

        except Exception as org_error:
            print(
                "⚠️ clinic name load failed:",
                repr(org_error),
            )

        return jsonify({
            "ok": True,
            "data": {
                "user_id":
    user_data.get("id"),
                "org_id": org_id,

                "staff_id":
                    user_data.get("staff_id"),

                "username":
                    user_data.get("username"),

                "display_name": (
                    user_data.get("display_name")
                    or user_data.get("username")
                    or "Користувач"
                ),

                "role": (
                    user_data.get("role")
                    or "vet"
                ),

                "clinic_name":
                    clinic_name,

                "theme":
                    theme,

                "must_change_password": bool(
                    user_data.get(
                        "must_change_password"
                    )
                ),
            },
        })

    except Exception as error:
        print(
            "❌ /api/login error:",
            repr(error),
        )

        return jsonify({
            "ok": False,
            "error": "Помилка сервера авторизації",
        }), 500


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(
            os.environ.get(
                "PORT",
                8080,
            )
        ),
        debug=False,
    )
