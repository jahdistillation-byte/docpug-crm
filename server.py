import os
import uuid
import hmac
import hashlib
import secrets
import re
import json
import html
import mimetypes
import time
from urllib.parse import parse_qsl
from urllib.request import Request, urlopen

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
            flush=True,
        )

    error_text = str(
        error or ""
    ).lower()

    transient_error = any(
        marker in error_text
        for marker in (
            "resource temporarily unavailable",
            "errno 11",
            "temporarily unavailable",

            "connection reset",
            "connection aborted",
            "connection refused",
            "connection terminated",
            "connectionterminated",

            "network is unreachable",
            "server disconnected",

            "http2",
            "last_stream_id",
            "error_code:1",

            "try again",
            "timed out",
            "timeout",
        )
    )

    if (
        transient_error
        and user_id
        and org_id
    ):
        fallback_user = {
            "id":
                str(user_id),

            "org_id":
                str(org_id),

            "staff_id":
                session.get(
                    "staff_id"
                ),

            "username":
                str(
                    session.get(
                        "username"
                    )
                    or ""
                ),

            "display_name":
                str(
                    session.get(
                        "display_name"
                    )
                    or session.get(
                        "username"
                    )
                    or "Користувач"
                ),

            "role":
                str(
                    session.get(
                        "role"
                    )
                    or "vet"
                ),

            "is_active":
                True,

            "must_change_password":
                bool(
                    session.get(
                        "must_change_password"
                    )
                ),
        }

        print(
            "⚠️ Using signed session fallback "
            "after temporary Supabase error",
            flush=True,
        )

        g.current_user = fallback_user

        return fallback_user

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


def is_platform_admin(user=None):
    """
    Закрытый доступ владельца платформы.
    Список логинов хранится только в переменных окружения сервера.
    """
    current_user = user or get_current_user()

    if not current_user:
        return False

    current_username = str(
        current_user.get("username") or ""
    ).strip().lower()

    configured_usernames = [
        item.strip().lower()
        for item in str(
            os.getenv(
                "PLATFORM_ADMIN_USERNAMES",
                "",
            )
        ).split(",")
        if item.strip()
    ]

    return bool(
        current_username
        and any(
            hmac.compare_digest(
                current_username,
                allowed_username,
            )
            for allowed_username in configured_usernames
        )
    )


def platform_admin_required():
    user, auth_error = auth_required()

    if auth_error:
        return None, auth_error

    if not is_platform_admin(user):
        return None, fail(
            "Platform administrator access required",
            403,
        )

    return user, None


def generate_temporary_password(length=14):
    """Генерирует читаемый одноразовый пароль без неоднозначных символов."""
    safe_lower = "abcdefghjkmnpqrstuvwxyz"
    safe_upper = "ABCDEFGHJKMNPQRSTUVWXYZ"
    safe_digits = "23456789"
    safe_symbols = "-_"
    alphabet = (
        safe_lower
        + safe_upper
        + safe_digits
        + safe_symbols
    )

    password_chars = [
        secrets.choice(safe_lower),
        secrets.choice(safe_upper),
        secrets.choice(safe_digits),
        secrets.choice(safe_symbols),
    ]

    password_chars.extend(
        secrets.choice(alphabet)
        for _ in range(
            max(12, int(length))
            - len(password_chars)
        )
    )

    secrets.SystemRandom().shuffle(
        password_chars
    )

    return "".join(password_chars)

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

# =====================================================
# AUDIT EVENTS
# =====================================================

def write_audit_event(
    *,
    action,
    entity_type,
    entity_id=None,
    entity_label=None,
    summary=None,
    before_data=None,
    after_data=None,
    metadata=None,
):
    """
    Записывает действие пользователя
    в единый журнал событий клиники.

    Ошибка журнала не должна ломать
    основную бизнес-операцию.
    """

    try:
        current_org = (
            get_current_org_id()
        )

        current_user = (
            get_current_user()
        )

        if not current_org:
            print(
                "⚠️ Audit skipped: "
                "organization not selected",
                flush=True,
            )

            return None

        clean_action = str(
            action or ""
        ).strip()

        clean_entity_type = str(
            entity_type or ""
        ).strip()

        if not clean_action:
            print(
                "⚠️ Audit skipped: "
                "action is empty",
                flush=True,
            )

            return None

        if not clean_entity_type:
            print(
                "⚠️ Audit skipped: "
                "entity_type is empty",
                flush=True,
            )

            return None

        forwarded_for = str(
            request.headers.get(
                "X-Forwarded-For"
            )
            or ""
        ).strip()

        ip_address = (
            forwarded_for
            .split(",")[0]
            .strip()
            if forwarded_for
            else str(
                request.remote_addr
                or ""
            ).strip()
        )

        actor_name = (
            current_user.get(
                "display_name"
            )
            or current_user.get(
                "username"
            )
            or "Користувач"
            if current_user
            else "Система"
        )

        actor_role = (
            normalize_role(
                current_user.get(
                    "role"
                )
            )
            if current_user
            else "system"
        )

        payload = {
            "org_id":
                str(current_org),

            "actor_user_id":
                (
                    str(
                        current_user.get(
                            "id"
                        )
                    )
                    if current_user
                    and current_user.get(
                        "id"
                    )
                    else None
                ),

            "actor_staff_id":
                (
                    str(
                        current_user.get(
                            "staff_id"
                        )
                    )
                    if current_user
                    and current_user.get(
                        "staff_id"
                    )
                    else None
                ),

            "actor_name":
                str(actor_name),

            "actor_role":
                str(actor_role),

            "action":
                clean_action,

            "entity_type":
                clean_entity_type,

            "entity_id":
                (
                    str(entity_id)
                    if entity_id
                    is not None
                    else None
                ),

            "entity_label":
                (
                    str(
                        entity_label
                    ).strip()
                    if entity_label
                    else None
                ),

            "summary":
                (
                    str(
                        summary
                    ).strip()
                    if summary
                    else None
                ),

            "before_data":
                (
                    before_data
                    if isinstance(
                        before_data,
                        (
                            dict,
                            list,
                        )
                    )
                    else None
                ),

            "after_data":
                (
                    after_data
                    if isinstance(
                        after_data,
                        (
                            dict,
                            list,
                        )
                    )
                    else None
                ),

            "metadata":
                (
                    metadata
                    if isinstance(
                        metadata,
                        (
                            dict,
                            list,
                        )
                    )
                    else None
                ),

            "ip_address":
                ip_address
                or None,

            "user_agent":
                (
                    str(
                        request.headers.get(
                            "User-Agent"
                        )
                        or ""
                    )[:500]
                    or None
                ),

            "created_at":
                (
                    datetime
                    .now(timezone.utc)
                    .isoformat()
                ),
        }

        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "audit_events"
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
            else None
        )

        print(
            "🧾 Audit event:",
            {
                "action":
                    clean_action,

                "entity_type":
                    clean_entity_type,

                "entity_id":
                    entity_id,

                "actor":
                    actor_name,
            },
            flush=True,
        )

        return row

    except Exception as error:
        print(
            "⚠️ write_audit_event failed:",
            {
                "action":
                    action,

                "entity_type":
                    entity_type,

                "entity_id":
                    entity_id,

                "error":
                    repr(error),
            },
            flush=True,
        )

        return None


def visit_medical_audit_snapshot(
    visit
):
    """
    Converts the compact visit storage fields into a stable,
    human-readable snapshot for the audit log.
    """

    source = (
        visit
        if isinstance(visit, dict)
        else {}
    )

    note = str(
        source.get("note")
        or ""
    ).strip()

    diagnosis = str(
        source.get("dx")
        or ""
    ).strip()

    complaints = ""

    diagnosis_match = re.search(
        r"\u0414\u0456\u0430\u0433\u043d\u043e\u0437:\s*(.*?)(?:\n|$)",
        note,
        flags=re.IGNORECASE,
    )

    if diagnosis_match:
        diagnosis = (
            diagnosis_match
            .group(1)
            .strip()
        )

    complaints_match = re.search(
        r"\u0421\u043a\u0430\u0440\u0433\u0438/\u0430\u043d\u0430\u043c\u043d\u0435\u0437:\s*([\s\S]*)",
        note,
        flags=re.IGNORECASE,
    )

    if complaints_match:
        complaints = (
            complaints_match
            .group(1)
            .strip()
        )
    elif not diagnosis_match:
        complaints = note

    treatment_text = str(
        source.get("rx")
        or ""
    ).strip()

    treatment = treatment_text
    recommendations = ""
    follow_up = ""

    recommendation_markers = [
        "\n\n\u0420\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0430\u0446\u0456\u0457 \u0432\u043b\u0430\u0441\u043d\u0438\u043a\u0443:\n",
        "\n\n\u0420\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0430\u0446\u0456\u0457:\n",
    ]

    recommendation_index = -1
    recommendation_marker = ""

    for marker in recommendation_markers:
        marker_index = (
            treatment_text.find(marker)
        )

        if (
            marker_index >= 0
            and (
                recommendation_index < 0
                or marker_index
                < recommendation_index
            )
        ):
            recommendation_index = (
                marker_index
            )
            recommendation_marker = marker

    if recommendation_index >= 0:
        treatment = (
            treatment_text[
                :recommendation_index
            ]
            .strip()
        )

        recommendations = (
            treatment_text[
                recommendation_index
                + len(
                    recommendation_marker
                ):
            ]
            .strip()
        )

    follow_marker = (
        "\n\n\u041a\u043e\u043d\u0442\u0440\u043e\u043b\u044c / "
        "\u043f\u0440\u0438 \u043f\u043e\u0433\u0456\u0440\u0448\u0435\u043d\u043d\u0456:\n"
    )

    follow_index = (
        recommendations.find(
            follow_marker
        )
    )

    if follow_index >= 0:
        follow_up = (
            recommendations[
                follow_index
                + len(follow_marker):
            ]
            .strip()
        )

        recommendations = (
            recommendations[
                :follow_index
            ]
            .strip()
        )

    treatment = re.sub(
        r"^\u041b\u0456\u043a\u0443\u0432\u0430\u043d\u043d\u044f:\s*",
        "",
        treatment,
        flags=re.IGNORECASE,
    ).strip()

    if treatment == "\u2014":
        treatment = ""

    weight_value = source.get(
        "weight_kg"
    )

    if weight_value in (
        "",
        None,
    ):
        weight_kg = None
    else:
        try:
            weight_kg = float(
                weight_value
            )

            if weight_kg.is_integer():
                weight_kg = int(
                    weight_kg
                )

        except (
            TypeError,
            ValueError,
        ):
            weight_kg = str(
                weight_value
            ).strip()

    return {
        "diagnosis": diagnosis,
        "complaints": complaints,
        "treatment": treatment,
        "recommendations": recommendations,
        "follow_up": follow_up,
        "weight_kg": weight_kg,
    }


@app.get("/api/audit-events")
def api_get_audit_events():
    user, auth_error = owner_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    if not current_org:
        return fail("Organization not selected", 400)

    action = str(
        request.args.get("action") or ""
    ).strip()

    actor_name = str(
        request.args.get("actor_name") or ""
    ).strip()

    date_from = str(
        request.args.get("date_from") or ""
    ).strip()

    date_to = str(
        request.args.get("date_to") or ""
    ).strip()

    try:
        limit = min(
            100,
            max(
                1,
                int(
                    request.args.get("limit")
                    or 50
                ),
            ),
        )

        offset = max(
            0,
            int(
                request.args.get("offset")
                or 0
            ),
        )

    except (TypeError, ValueError):
        return fail("Некоректна пагінація.", 400)

    def build_query():
        query = (
            supabase
            .table("audit_events")
            .select("*", count="exact")
            .eq("org_id", current_org)
        )

        if action:
            query = query.eq(
                "action",
                action,
            )

        if actor_name:
            query = query.ilike(
                "actor_name",
                f"%{actor_name}%",
            )

        if date_from:
            query = query.gte(
                "created_at",
                f"{date_from}T00:00:00+00:00",
            )

        if date_to:
            query = query.lte(
                "created_at",
                f"{date_to}T23:59:59.999999+00:00",
            )

        return (
            query
            .order("created_at", desc=True)
            .range(
                offset,
                offset + limit - 1,
            )
        )

    try:
        result = execute_with_retry(
            build_query,
            attempts=4,
            delay=0.3,
        )

        rows = result.data or []
        total = getattr(
            result,
            "count",
            None,
        )

        if total is None:
            total = offset + len(rows)

        return ok({
            "events": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
        })

    except Exception as error:
        print(
            "❌ GET /api/audit-events:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити журнал дій.",
            500,
        )


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
    "connection terminated",
    "connectionterminated",

    "network is unreachable",
    "name or service not known",
    "nodename nor servname provided",

    "server disconnected",

    "http2",
    "last_stream_id",
    "error_code:1",

    "try again",
    "timed out",
    "timeout",
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

    # =====================
    # services
    # =====================
    try:
        # visit_services is scoped through visit_id and has no org_id column in
        # the production schema. The previous probe intentionally queried that
        # missing column first, producing a noisy 400 on every finance refresh.
        res = execute_with_retry(
            lambda: (
                supabase
                .table("visit_services")
                .select("*")
                .in_("visit_id", visit_ids)
            ),
            attempts=4,
            delay=0.3,
        )

        for r in (res.data or []):
            vid = r.get("visit_id")
            if not vid:
                continue
            services_by_visit.setdefault(vid, []).append({
                "id": r.get("id"),
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
        # visit_stock follows the same visit-scoped schema as visit_services.
        res = execute_with_retry(
            lambda: (
                supabase
                .table("visit_stock")
                .select("*")
                .in_("visit_id", visit_ids)
            ),
            attempts=4,
            delay=0.3,
        )

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
        "/api/telegram/webhook",
        "/api/internal/reports/daily-dispatch",
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

def serialize_clinic_subscription(row):
    source = row if isinstance(row, dict) else {}
    stored_status = str(
        source.get("status") or "unconfigured"
    ).strip().lower()
    starts_on = source.get("access_starts_on")
    ends_on = source.get("access_ends_on")
    today = datetime.now(
        ZoneInfo("Europe/Kyiv")
    ).date()
    end_date = None

    if ends_on:
        try:
            end_date = datetime.strptime(
                str(ends_on),
                "%Y-%m-%d",
            ).date()
        except ValueError:
            end_date = None

    raw_days_remaining = (
        (end_date - today).days
        if end_date
        else None
    )

    if stored_status == "paused":
        display_status = "paused"
    elif not end_date:
        display_status = "unconfigured"
    elif raw_days_remaining <= 0:
        display_status = "expired"
    elif raw_days_remaining <= 7:
        display_status = "expiring"
    elif stored_status == "trial":
        display_status = "trial"
    else:
        display_status = "active"

    last_access_day = (
        (end_date - timedelta(days=1)).isoformat()
        if end_date
        else None
    )

    return {
        "org_id": source.get("org_id"),
        "plan_name": source.get("plan_name") or "ЗБТ",
        "stored_status": stored_status,
        "status": display_status,
        "access_starts_on": starts_on,
        "access_ends_on": ends_on,
        "last_access_day": last_access_day,
        "days_remaining": (
            max(0, raw_days_remaining)
            if raw_days_remaining is not None
            else None
        ),
        "monthly_price": source.get("monthly_price"),
        "currency": source.get("currency") or "UAH",
        "note": source.get("note"),
        "updated_at": source.get("updated_at"),
    }


@app.get("/api/subscription")
def api_get_current_subscription():
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    try:
        result = execute_with_retry(
            lambda: (
                supabase
                .table("clinic_subscriptions")
                .select("*")
                .eq("org_id", current_org)
                .limit(1)
            ),
            attempts=3,
            delay=0.25,
        )

        row = (
            result.data[0]
            if result.data
            else {"org_id": current_org}
        )

        return ok(
            serialize_clinic_subscription(row)
        )

    except Exception as error:
        print(
            "❌ /api/subscription GET error:",
            repr(error),
        )

        return fail(
            "Не вдалося завантажити дані підписки.",
            500,
        )

@app.get("/api/platform/clinics")
def api_list_platform_clinics():
    user, access_error = (
        platform_admin_required()
    )

    if access_error:
        return access_error

    try:
        org_result = execute_with_retry(
            lambda: (
                supabase
                .table("orgs")
                .select(
                    "id,name,subtitle,phone,address,website,"
                    "theme,created_at"
                )
                .order("created_at", desc=True)
                .limit(250)
            ),
            attempts=3,
            delay=0.25,
        )

        owner_result = execute_with_retry(
            lambda: (
                supabase
                .table("clinic_users")
                .select(
                    "id,org_id,username,display_name,is_active,"
                    "must_change_password,created_at"
                )
                .eq("role", "owner")
                .order("created_at", desc=False)
                .limit(1000)
            ),
            attempts=3,
            delay=0.25,
        )

        subscription_result = execute_with_retry(
            lambda: (
                supabase
                .table("clinic_subscriptions")
                .select("*")
                .limit(1000)
            ),
            attempts=3,
            delay=0.25,
        )

        owners_by_org = {}
        subscriptions_by_org = {
            str(item.get("org_id")): (
                serialize_clinic_subscription(item)
            )
            for item in (
                subscription_result.data or []
            )
            if item.get("org_id")
        }

        for owner in (owner_result.data or []):
            owner_org_id = str(
                owner.get("org_id") or ""
            ).strip()

            if (
                owner_org_id
                and owner_org_id
                not in owners_by_org
            ):
                owners_by_org[owner_org_id] = {
                    "id": owner.get("id"),
                    "username": owner.get("username"),
                    "display_name": owner.get("display_name"),
                    "is_active": owner.get("is_active") is not False,
                    "must_change_password": bool(
                        owner.get("must_change_password")
                    ),
                }

        clinics = []

        for org in (org_result.data or []):
            org_id = str(
                org.get("id") or ""
            ).strip()

            clinics.append({
                "id": org_id,
                "name": org.get("name"),
                "subtitle": org.get("subtitle"),
                "phone": org.get("phone"),
                "address": org.get("address"),
                "website": org.get("website"),
                "theme": org.get("theme") or "purple",
                "created_at": org.get("created_at"),
                "owner": owners_by_org.get(org_id),
                "subscription": subscriptions_by_org.get(
                    org_id,
                    serialize_clinic_subscription({
                        "org_id": org_id,
                    }),
                ),
            })

        return ok({
            "clinics": clinics,
            "total": len(clinics),
        })

    except Exception as error:
        print(
            "❌ /api/platform/clinics GET error:",
            repr(error),
        )

        return fail(
            "Cannot load platform clinics",
            500,
        )


@app.get(
    "/api/platform/clinics/<org_id>/subscription/history"
)
def api_get_platform_subscription_history(org_id):
    user, access_error = platform_admin_required()

    if access_error:
        return access_error

    try:
        clean_org_id = str(uuid.UUID(str(org_id)))
    except (ValueError, TypeError, AttributeError):
        return fail("Невірний ID клініки.", 400)

    try:
        result = execute_with_retry(
            lambda: (
                supabase
                .table("clinic_subscription_events")
                .select(
                    "id,action,amount,currency,period_starts_on,"
                    "period_ends_on,note,created_at"
                )
                .eq("org_id", clean_org_id)
                .order("created_at", desc=True)
                .limit(25)
            ),
            attempts=3,
            delay=0.25,
        )

        return ok({
            "events": result.data or [],
        })

    except Exception as error:
        print(
            "❌ subscription history error:",
            repr(error),
        )

        return fail(
            "Не вдалося завантажити історію підписки.",
            500,
        )


@app.post(
    "/api/platform/clinics/<org_id>/subscription"
)
def api_manage_platform_subscription(org_id):
    user, access_error = platform_admin_required()

    if access_error:
        return access_error

    try:
        clean_org_id = str(uuid.UUID(str(org_id)))
    except (ValueError, TypeError, AttributeError):
        return fail("Невірний ID клініки.", 400)

    data = request.get_json(silent=True) or {}
    action = str(data.get("action") or "").strip().lower()

    if action not in {
        "extend",
        "set_period",
        "pause",
        "resume",
    }:
        return fail("Невідома дія підписки.", 400)

    def optional_decimal(value, field_name):
        if value in (None, ""):
            return None

        try:
            number = float(value)
        except (ValueError, TypeError):
            raise ValueError(field_name)

        if number < 0 or number > 100000000:
            raise ValueError(field_name)

        return round(number, 2)

    try:
        months = int(data.get("months") or 1)
        monthly_price = optional_decimal(
            data.get("monthly_price"),
            "monthly_price",
        )
        amount = optional_decimal(
            data.get("amount"),
            "amount",
        )
    except (ValueError, TypeError):
        return fail(
            "Перевірте кількість місяців і суму.",
            400,
        )

    if months < 1 or months > 24:
        return fail("Можна додати від 1 до 24 місяців.", 400)

    starts_on = str(
        data.get("access_starts_on") or ""
    ).strip() or None
    ends_on = str(
        data.get("access_ends_on") or ""
    ).strip() or None

    if action == "set_period":
        try:
            start_date = datetime.strptime(
                starts_on,
                "%Y-%m-%d",
            ).date()
            end_date = datetime.strptime(
                ends_on,
                "%Y-%m-%d",
            ).date()
        except (ValueError, TypeError):
            return fail("Вкажіть коректний період.", 400)

        if end_date <= start_date:
            return fail(
                "Дата завершення має бути пізніше дати початку.",
                400,
            )

    note = str(data.get("note") or "").strip()[:500] or None

    try:
        result = execute_with_retry(
            lambda: (
                supabase.rpc(
                    "manage_clinic_subscription",
                    {
                        "p_org_id": clean_org_id,
                        "p_action": action,
                        "p_actor_user_id": user.get("id"),
                        "p_months": months,
                        "p_access_starts_on": starts_on,
                        "p_access_ends_on": ends_on,
                        "p_monthly_price": monthly_price,
                        "p_amount": amount,
                        "p_note": note,
                    },
                )
            ),
            attempts=2,
            delay=0.3,
        )

        subscription = serialize_clinic_subscription(
            result.data or {"org_id": clean_org_id}
        )

        audit_labels = {
            "extend": "Підписку продовжено",
            "set_period": "Період підписки змінено",
            "pause": "Підписку призупинено",
            "resume": "Підписку відновлено",
        }

        write_audit_event(
            action=f"subscription.{action}",
            entity_type="organization",
            entity_id=clean_org_id,
            entity_label="Підписка клініки",
            summary=audit_labels[action],
            after_data=subscription,
            metadata={
                "amount": amount,
                "months": months if action == "extend" else None,
            },
        )

        return ok(subscription)

    except Exception as error:
        message = str(error)

        if "CLINIC_NOT_FOUND" in message:
            return fail("Клініку не знайдено.", 404)

        print(
            "❌ manage subscription error:",
            repr(error),
        )

        return fail(
            "Не вдалося оновити підписку. Зміни не збережені.",
            500,
        )


@app.post("/api/platform/clinics")
def api_create_platform_clinic():
    user, access_error = (
        platform_admin_required()
    )

    if access_error:
        return access_error

    data = request.get_json(silent=True) or {}

    clinic_name = str(
        data.get("name") or ""
    ).strip()
    owner_name = str(
        data.get("owner_display_name") or ""
    ).strip()
    owner_username = str(
        data.get("owner_username") or ""
    ).strip().lower()
    theme = str(
        data.get("theme") or "purple"
    ).strip().lower()

    if not clinic_name or len(clinic_name) > 160:
        return fail(
            "Вкажіть назву клініки до 160 символів.",
            400,
        )

    if not owner_name or len(owner_name) > 160:
        return fail(
            "Вкажіть ім’я власника до 160 символів.",
            400,
        )

    if not re.fullmatch(
        r"[a-z0-9][a-z0-9._-]{2,79}",
        owner_username,
    ):
        return fail(
            "Логін: 3–80 латинських літер, цифр, крапок, дефісів або підкреслень.",
            400,
        )

    if theme not in CLINIC_THEMES:
        return fail(
            "Невідома тема клініки.",
            400,
        )

    temporary_password = (
        generate_temporary_password()
    )
    password_hash = generate_password_hash(
        temporary_password
    )

    rpc_payload = {
        "p_name": clinic_name,
        "p_subtitle": str(
            data.get("subtitle") or ""
        ).strip()[:240],
        "p_phone": str(
            data.get("phone") or ""
        ).strip()[:80],
        "p_address": str(
            data.get("address") or ""
        ).strip()[:300],
        "p_website": str(
            data.get("website") or ""
        ).strip()[:300],
        "p_theme": theme,
        "p_owner_username": owner_username,
        "p_owner_display_name": owner_name,
        "p_password_hash": password_hash,
    }

    try:
        result = execute_with_retry(
            lambda: (
                supabase
                .rpc(
                    "provision_clinic",
                    rpc_payload,
                )
            ),
            attempts=2,
            delay=0.3,
        )

        created = result.data or {}

        if not isinstance(created, dict):
            raise RuntimeError(
                "Unexpected provisioning response"
            )

        write_audit_event(
            action="organization.created",
            entity_type="organization",
            entity_id=created.get("org_id"),
            entity_label=clinic_name,
            summary="Створено нову клініку",
            after_data={
                "clinic_name": clinic_name,
                "owner_username": owner_username,
                "theme": theme,
            },
            metadata={
                "created_owner_user_id": created.get(
                    "owner_user_id"
                ),
                "financial_accounts_created": created.get(
                    "financial_accounts_created"
                ),
            },
        )

        return ok({
            **created,
            "temporary_password": temporary_password,
        })

    except Exception as error:
        message = str(error)

        if (
            "OWNER_USERNAME_EXISTS" in message
            or "clinic_users_username_key" in message
        ):
            return fail(
                "Цей логін уже зайнятий. Вкажіть інший.",
                409,
            )

        print(
            "❌ /api/platform/clinics POST error:",
            repr(error),
        )

        return fail(
            "Не вдалося створити клініку. Дані не були збережені.",
            500,
        )

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
    try:
        user_id = str(
            session.get(
                "user_id"
            )
            or ""
        ).strip()

        org_id = str(
            session.get(
                "org_id"
            )
            or ""
        ).strip()

        if (
            not user_id
            or not org_id
        ):
            session.clear()

            return jsonify({
                "ok": False,
                "authenticated": False,
                "error": "Unauthorized",
            }), 401

        username = str(
            session.get(
                "username"
            )
            or ""
        ).strip()

        display_name = str(
            session.get(
                "display_name"
            )
            or username
            or "Користувач"
        ).strip()

        role = str(
            session.get(
                "role"
            )
            or "vet"
        ).strip().lower()

        staff_id = (
            str(
                session.get(
                    "staff_id"
                )
            )
            if session.get(
                "staff_id"
            )
            else None
        )

        must_change_password = bool(
            session.get(
                "must_change_password"
            )
        )

        clinic_name = "Клініка"
        theme = "purple"

        try:
            org_result = (
                supabase
                .table("orgs")
                .select(
                    "name, theme"
                )
                .eq(
                    "id",
                    org_id
                )
                .limit(1)
                .execute()
            )

            if org_result.data:
                clinic_name = (
                    org_result.data[0]
                    .get("name")
                    or clinic_name
                )

                theme = (
                    org_result.data[0]
                    .get("theme")
                    or theme
                )

        except Exception as org_error:
            print(
                "⚠️ /api/session clinic load failed:",
                repr(org_error),
            )

        session_user = {
            "id":
                user_id,

            "username":
                username,

            "org_id":
                org_id,

            "staff_id":
                staff_id,

            "role":
                role,

            "display_name":
                display_name,
        }

        return jsonify({
            "ok": True,
            "authenticated": True,

            "data": {
                "user_id":
                    user_id,

                "org_id":
                    org_id,

                "staff_id":
                    staff_id,

                "username":
                    username,

                "display_name":
                    display_name,

                "role":
                    role,

                "clinic_name":
                    clinic_name,

                "theme":
                    theme,

                "must_change_password":
                    must_change_password,

                "is_platform_admin":
                    is_platform_admin(
                        session_user
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
            "error":
                "Помилка перевірки сесії",
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


def stock_optional_date(value):
    text = str(
        value or ""
    ).strip()

    if not text:
        return None

    try:
        return (
            datetime
            .strptime(
                text,
                "%Y-%m-%d",
            )
            .date()
            .isoformat()
        )
    except ValueError as error:
        raise ValueError(
            "Невірна дата придатності."
        ) from error


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

        "expiry_date": (
            str(row.get("expiry_date"))
            if row.get("expiry_date")
            else None
        ),

        "batch_number": (
            str(row.get("batch_number")).strip()
            if row.get("batch_number")
            else None
        ),

        "usage_30d": stock_number(
            row.get("usage_30d")
        ),

        "avg_daily_usage": stock_number(
            row.get("avg_daily_usage")
        ),

        "estimated_days_left": (
            round(
                float(
                    row.get(
                        "estimated_days_left"
                    )
                ),
                1,
            )
            if row.get(
                "estimated_days_left"
            ) is not None
            else None
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

        rows = list(
            result.data or []
        )

        usage_by_stock = {}

        try:
            usage_result = (
                supabase
                .table("stock_movements")
                .select(
                    "stock_id, quantity"
                )
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "movement_type",
                    "writeoff",
                )
                .gte(
                    "created_at",
                    (
                        datetime
                        .now(timezone.utc)
                        - timedelta(days=30)
                    ).isoformat(),
                )
                .execute()
            )

            for movement in (
                usage_result.data or []
            ):
                stock_id = str(
                    movement.get(
                        "stock_id"
                    )
                    or ""
                )

                if not stock_id:
                    continue

                usage_by_stock[
                    stock_id
                ] = (
                    usage_by_stock.get(
                        stock_id,
                        0,
                    )
                    + stock_number(
                        movement.get(
                            "quantity"
                        )
                    )
                )

        except Exception as usage_error:
            print(
                "⚠️ Stock usage metrics:",
                repr(usage_error),
            )

        for row in rows:
            stock_id = str(
                row.get("id") or ""
            )
            usage_30d = stock_number(
                usage_by_stock.get(
                    stock_id,
                    0,
                )
            )
            avg_daily_usage = (
                usage_30d / 30
                if usage_30d > 0
                else 0
            )
            quantity = stock_number(
                row.get("qty")
            )

            row["usage_30d"] = (
                usage_30d
            )
            row["avg_daily_usage"] = (
                avg_daily_usage
            )
            row[
                "estimated_days_left"
            ] = (
                quantity
                / avg_daily_usage
                if avg_daily_usage > 0
                else None
            )

        items = [
            serialize_stock_item(row)
            for row in rows
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

    try:
        expiry_date = (
            stock_optional_date(
                data.get("expiry_date")
            )
        )
    except ValueError as error:
        return fail(
            str(error),
            400,
        )

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

        "expiry_date": expiry_date,

        "batch_number": (
            str(
                data.get(
                    "batch_number"
                )
                or ""
            ).strip()
            or None
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
        "expiry_date": "expiry_date",
        "batch_number": "batch_number",
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

        elif db_field in {
            "batch_number",
        }:
            value = (
                str(value).strip()
                if value is not None
                else ""
            ) or None

        elif value is not None:
            value = str(value).strip()

        payload[db_field] = value

    if "expiry_date" in data:
        try:
            payload[
                "expiry_date"
            ] = stock_optional_date(
                data.get(
                    "expiry_date"
                )
            )
        except ValueError as error:
            return fail(
                str(error),
                400,
            )

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

@app.post("/api/visits/<visit_id>/services")
def api_add_service_to_visit(visit_id):
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()
    data = request.get_json(silent=True) or {}

    service_id = str(
        data.get("service_id")
        or data.get("serviceId")
        or ""
    ).strip()

    try:
        quantity = max(
            1,
            int(
                data.get("quantity")
                if data.get("quantity") is not None
                else data.get("qty") or 1
            ),
        )
    except (TypeError, ValueError):
        return fail("Некоректна кількість послуги.", 400)

    if not current_org:
        return fail("Organization not selected", 400)

    if not service_id:
        return fail("Оберіть послугу.", 400)

    try:
        visit_result = execute_with_retry(
            lambda: (
                supabase
                .table("visits")
                .select("id")
                .eq("org_id", current_org)
                .eq("id", visit_id)
                .limit(1)
            ),
            attempts=4,
            delay=0.3,
        )

        if not visit_result.data:
            return fail("Візит не знайдено.", 404)

        service_result = execute_with_retry(
            lambda: (
                supabase
                .table("services")
                .select("*")
                .eq("org_id", current_org)
                .eq("id", service_id)
                .limit(1)
            ),
            attempts=4,
            delay=0.3,
        )

        if not service_result.data:
            return fail("Послугу не знайдено.", 404)

        service = service_result.data[0]

        if service.get("active") is False:
            return fail("Ця послуга неактивна.", 409)

        price_snap = service.get("price") or 0
        name_snap = str(service.get("name") or "Послуга").strip()

        line_result = execute_with_retry(
            lambda: (
                supabase
                .table("visit_services")
                .insert({
                    "visit_id": visit_id,
                    "service_id": service_id,
                    "qty": quantity,
                    "price_snap": price_snap,
                    "name_snap": name_snap,
                })
            ),
            attempts=4,
            delay=0.3,
        )

        if not line_result.data:
            return fail("Не вдалося додати послугу у візит.", 500)

        line = line_result.data[0]

        write_audit_event(
            action="service.added",
            entity_type="visit_service",
            entity_id=line.get("id"),
            entity_label=name_snap,
            summary="Послугу додано до візиту",
            after_data={
                "line_id": line.get("id"),
                "visit_id": visit_id,
                "service_id": service_id,
                "qty": quantity,
                "price_snap": price_snap,
                "name_snap": name_snap,
            },
            metadata={
                "visit_id": visit_id,
                "service_id": service_id,
            },
        )

        return ok({
            "line": {
                "id": line.get("id"),
                "serviceId": service_id,
                "service_id": service_id,
                "qty": quantity,
                "quantity": quantity,
                "priceSnap": price_snap,
                "price_snap": price_snap,
                "nameSnap": name_snap,
                "name_snap": name_snap,
            },
        })

    except Exception as error:
        print(
            "❌ Add service to visit:",
            repr(error),
            flush=True,
        )

        return fail("Не вдалося додати послугу у візит.", 500)


@app.delete("/api/visits/<visit_id>/services/<line_id>")
def api_remove_service_from_visit(visit_id, line_id):
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    if not current_org:
        return fail("Organization not selected", 400)

    try:
        visit_result = execute_with_retry(
            lambda: (
                supabase
                .table("visits")
                .select("id")
                .eq("org_id", current_org)
                .eq("id", visit_id)
                .limit(1)
            ),
            attempts=4,
            delay=0.3,
        )

        if not visit_result.data:
            return fail("Візит не знайдено.", 404)

        line_result = execute_with_retry(
            lambda: (
                supabase
                .table("visit_services")
                .select("*")
                .eq("visit_id", visit_id)
                .eq("id", line_id)
                .limit(1)
            ),
            attempts=4,
            delay=0.3,
        )

        if not line_result.data:
            return fail("Послугу у візиті не знайдено.", 404)

        line = line_result.data[0]

        delete_result = execute_with_retry(
            lambda: (
                supabase
                .table("visit_services")
                .delete()
                .eq("visit_id", visit_id)
                .eq("id", line_id)
            ),
            attempts=4,
            delay=0.3,
        )

        if not delete_result.data:
            return fail("Не вдалося видалити послугу.", 500)

        write_audit_event(
            action="service.removed",
            entity_type="visit_service",
            entity_id=line_id,
            entity_label=(
                line.get("name_snap")
                or "Послуга"
            ),
            summary="Послугу видалено з візиту",
            before_data={
                "line_id": line_id,
                "visit_id": visit_id,
                "service_id": line.get("service_id"),
                "qty": line.get("qty"),
                "price_snap": line.get("price_snap"),
                "name_snap": line.get("name_snap"),
            },
            metadata={
                "visit_id": visit_id,
                "service_id": line.get("service_id"),
            },
        )

        return ok({"line_id": line_id})

    except Exception as error:
        print(
            "❌ Remove service from visit:",
            repr(error),
            flush=True,
        )

        return fail("Не вдалося видалити послугу.", 500)


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

        write_audit_event(
            action="stock.added",
            entity_type="visit_stock",
            entity_id=line_id,
            entity_label=name_snap,
            summary="Препарат списано у візит",
            before_data={
                "stock_qty": quantity_before,
            },
            after_data={
                "stock_qty": quantity_after,
                "line_id": line_id,
                "visit_id": visit_id,
                "stock_id": stock_id,
                "qty": quantity,
                "name_snap": name_snap,
            },
            metadata={
                "visit_id": visit_id,
                "stock_id": stock_id,
                "unit": stock_item.get("unit") or "шт",
            },
        )

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

            write_audit_event(
                action="stock.removed",
                entity_type="visit_stock",
                entity_id=line_id,
                entity_label=(
                    line_row.get("name_snap")
                    or "Препарат"
                ),
                summary="Препарат видалено з візиту",
                before_data={
                    "line_id": line_id,
                    "visit_id": visit_id,
                    "stock_id": line_row.get("stock_id"),
                    "qty": line_row.get("qty"),
                    "name_snap": line_row.get("name_snap"),
                    "inventory_synced": False,
                },
                metadata={
                    "visit_id": visit_id,
                    "stock_id": line_row.get("stock_id"),
                    "restored": False,
                },
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

        write_audit_event(
            action="stock.removed",
            entity_type="visit_stock",
            entity_id=line_id,
            entity_label=(
                line_row.get("name_snap")
                or stock_item.get("name")
                or "Препарат"
            ),
            summary="Препарат видалено з візиту та повернено на склад",
            before_data={
                "stock_qty": quantity_before,
                "line_id": line_id,
                "visit_id": visit_id,
                "stock_id": stock_id,
                "qty": quantity,
                "name_snap": line_row.get("name_snap"),
                "inventory_synced": True,
            },
            after_data={
                "stock_qty": quantity_after,
            },
            metadata={
                "visit_id": visit_id,
                "stock_id": stock_id,
                "restored": True,
                "unit": stock_item.get("unit") or "шт",
            },
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


def load_finance_org_rows(
    table_name,
    *,
    order_by=None,
    desc=False,
    page_size=1000,
):
    """
    Load a complete organization-scoped register without silently losing rows
    to PostgREST's default response limit.
    """
    current_org = (
        get_current_org_id()
    )

    rows = []
    offset = 0

    while True:
        def build_query(
            page_offset=offset
        ):
            query = (
                supabase
                .table(table_name)
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
            )

            if order_by:
                query = query.order(
                    order_by,
                    desc=desc,
                )

            return query.range(
                page_offset,
                page_offset
                + page_size
                - 1,
            )

        result = execute_with_retry(
            build_query,
            attempts=4,
            delay=0.3,
        )

        page = (
            result.data
            or []
        )

        rows.extend(page)

        if len(page) < page_size:
            break

        offset += page_size

    return rows


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


def finance_audit_snapshot(
    row
):
    source = (
        row
        if isinstance(row, dict)
        else {}
    )

    return {
        "transaction_type":
            source.get(
                "transaction_type"
            ),
        "amount": finance_number(
            source.get("amount")
        ),
        "currency": (
            source.get("currency")
            or "UAH"
        ),
        "payment_method":
            source.get(
                "payment_method"
            ),
        "status":
            source.get("status"),
        "category":
            source.get("category"),
        "counterparty":
            source.get(
                "counterparty"
            ),
        "description":
            source.get(
                "description"
            ),
        "document_url":
            source.get(
                "document_url"
            ),
        "occurred_at":
            source.get(
                "occurred_at"
            ),
        "visit_id":
            source.get("visit_id"),
    }


def load_finance_transaction_for_audit(
    transaction_id,
    current_org,
):
    """
    Best-effort read for before/after audit details.
    It must never block the financial operation.
    """

    try:
        result = (
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
                "id",
                transaction_id,
            )
            .limit(1)
            .execute()
        )

        return (
            result.data[0]
            if result.data
            else None
        )

    except Exception as error:
        print(
            "⚠️ Finance audit source load:",
            repr(error),
            flush=True,
        )

        return None


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
            execute_with_retry(
                lambda: (
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
                ),
                attempts=4,
                delay=0.3,
            )
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
            execute_with_retry(
                lambda: (
                    supabase
                    .table(
                        "visit_services"
                    )
                    .select(
                        "qty,price_snap"
                    )
                    .eq(
                        "visit_id",
                        visit_id
                    )
                ),
                attempts=4,
                delay=0.3,
            )
        )

        stock_result = (
            execute_with_retry(
                lambda: (
                    supabase
                    .table(
                        "visit_stock"
                    )
                    .select(
                        "qty,price_snap"
                    )
                    .eq(
                        "visit_id",
                        visit_id
                    )
                ),
                attempts=4,
                delay=0.3,
            )
        )

        transactions_result = (
            execute_with_retry(
                lambda: (
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
                ),
                attempts=4,
                delay=0.3,
            )
        )

        service_total = sum(
            finance_number(
                row.get("qty")
            )
            * finance_number(
                row.get(
                    "price_snap"
                )
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
                row.get(
                    "price_snap"
                )
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
            finance_number(
                paid
            )
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

        elif (
            total > 0
            and remaining <= 0
        ):
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

        response_payload = (
            response_data
            if isinstance(
                response_data,
                dict,
            )
            else {}
        )

        payment_transaction = (
            response_payload.get(
                "transaction"
            )
            if isinstance(
                response_payload.get(
                    "transaction"
                ),
                dict,
            )
            else {}
        )

        if not response_payload.get(
            "idempotent_replay"
        ):
            write_audit_event(
                action="payment.created",
                entity_type=
                    "finance_transaction",
                entity_id=(
                    payment_transaction.get(
                        "id"
                    )
                    or response_payload.get(
                        "transaction_id"
                    )
                ),
                entity_label=
                    "Оплата візиту",
                summary=(
                    f"Оплату {amount:g} UAH "
                    "проведено"
                ),
                after_data={
                    "visit_id": visit_id,
                    "amount": amount,
                    "currency": "UAH",
                    "payment_method":
                        payment_method,
                    "status": (
                        payment_transaction.get(
                            "status"
                        )
                        or "completed"
                    ),
                    "paid_after":
                        response_payload.get(
                            "paid_after"
                        ),
                    "remaining":
                        response_payload.get(
                            "remaining"
                        ),
                    "financial_status":
                        response_payload.get(
                            "financial_status"
                        ),
                },
                metadata={
                    "visit_id": visit_id,
                    "idempotency_key":
                        idempotency_key,
                },
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

# =====================================================
# OWNER DAILY REPORTS
# =====================================================

REPORT_TIMEZONE = ZoneInfo("Europe/Kyiv")


def report_number(value, default=0.0):
    try:
        return float(value if value is not None else default)
    except (TypeError, ValueError):
        return float(default)


def report_int(value, default=0):
    try:
        return int(value if value is not None else default)
    except (TypeError, ValueError):
        return int(default)


def report_date(value=None):
    raw_value = str(value or "").strip()

    if not raw_value:
        return datetime.now(REPORT_TIMEZONE).date()

    try:
        parsed = datetime.strptime(raw_value, "%Y-%m-%d").date()
    except ValueError as error:
        raise ValueError("Invalid date format. Use YYYY-MM-DD.") from error

    today = datetime.now(REPORT_TIMEZONE).date()

    if parsed > today:
        raise ValueError("Report date cannot be in the future.")

    if parsed < today - timedelta(days=366):
        raise ValueError("Report date is outside the available period.")

    return parsed


def report_utc_range(day):
    start_local = datetime.combine(
        day,
        datetime.min.time(),
        tzinfo=REPORT_TIMEZONE,
    )
    end_local = start_local + timedelta(days=1)

    return (
        start_local.astimezone(timezone.utc).isoformat(),
        end_local.astimezone(timezone.utc).isoformat(),
    )


def report_rows(query_factory):
    result = execute_with_retry(
        query_factory,
        attempts=4,
        delay=0.3,
    )

    return result.data if isinstance(result.data, list) else []


def report_finance_overview(org_id, day):
    result = execute_with_retry(
        lambda: supabase.rpc(
            "get_finance_overview",
            {
                "p_org_id": org_id,
                "p_date_from": day.isoformat(),
                "p_date_to": day.isoformat(),
            },
        ),
        attempts=4,
        delay=0.3,
    )

    data = result.data or {}

    if isinstance(data, list):
        data = data[0] if data else {}

    return data if isinstance(data, dict) else {}


def report_status_count(rows, *statuses):
    allowed = {
        str(status or "").strip().lower()
        for status in statuses
    }

    return sum(
        1
        for row in rows
        if str(row.get("status") or "").strip().lower() in allowed
    )


def build_owner_daily_report(org_id, day):
    day_iso = day.isoformat()
    previous_day = day - timedelta(days=1)
    previous_iso = previous_day.isoformat()
    start_utc, end_utc = report_utc_range(day)
    previous_start_utc, previous_end_utc = report_utc_range(previous_day)

    org_rows = report_rows(
        lambda: supabase.table("orgs")
        .select("id,name")
        .eq("id", org_id)
        .limit(1)
    )
    clinic_name = (
        str(org_rows[0].get("name") or "Клініка").strip()
        if org_rows
        else "Клініка"
    )

    visits = report_rows(
        lambda: supabase.table("visits")
        .select(
            "id,status,total_amount,paid_amount,financial_status,completed_at"
        )
        .eq("org_id", org_id)
        .eq("date", day_iso)
    )
    previous_visits = report_rows(
        lambda: supabase.table("visits")
        .select("id,status")
        .eq("org_id", org_id)
        .eq("date", previous_iso)
    )
    events = report_rows(
        lambda: supabase.table("calendar_events")
        .select("id,status,visit_id")
        .eq("org_id", org_id)
        .eq("event_date", day_iso)
    )
    previous_events = report_rows(
        lambda: supabase.table("calendar_events")
        .select("id,status")
        .eq("org_id", org_id)
        .eq("event_date", previous_iso)
    )
    new_owners = report_rows(
        lambda: supabase.table("owners")
        .select("id")
        .eq("org_id", org_id)
        .gte("created_at", start_utc)
        .lt("created_at", end_utc)
    )
    previous_owners = report_rows(
        lambda: supabase.table("owners")
        .select("id")
        .eq("org_id", org_id)
        .gte("created_at", previous_start_utc)
        .lt("created_at", previous_end_utc)
    )
    new_patients = report_rows(
        lambda: supabase.table("patients")
        .select("id")
        .eq("org_id", org_id)
        .gte("created_at", start_utc)
        .lt("created_at", end_utc)
    )
    previous_patients = report_rows(
        lambda: supabase.table("patients")
        .select("id")
        .eq("org_id", org_id)
        .gte("created_at", previous_start_utc)
        .lt("created_at", previous_end_utc)
    )

    finance = report_finance_overview(org_id, day)
    previous_finance = report_finance_overview(org_id, previous_day)
    finance_summary = finance.get("summary") or {}
    previous_finance_summary = previous_finance.get("summary") or {}

    visit_ids = [
        str(row.get("id"))
        for row in visits
        if row.get("id")
    ]
    service_lines = []

    if visit_ids:
        service_lines = report_rows(
            lambda: supabase.table("visit_services")
            .select("visit_id,name_snap,qty,price_snap")
            .in_("visit_id", visit_ids)
        )

    services_by_name = {}

    for line in service_lines:
        name = str(line.get("name_snap") or "Послуга").strip() or "Послуга"
        qty = max(report_number(line.get("qty")), 0)
        revenue = qty * max(report_number(line.get("price_snap")), 0)
        bucket = services_by_name.setdefault(
            name,
            {"name": name, "qty": 0.0, "revenue": 0.0},
        )
        bucket["qty"] += qty
        bucket["revenue"] += revenue

    top_services = sorted(
        services_by_name.values(),
        key=lambda item: (item["revenue"], item["qty"]),
        reverse=True,
    )[:5]

    for item in top_services:
        item["qty"] = round(item["qty"], 2)
        item["revenue"] = round(item["revenue"], 2)

    stock_rows = report_rows(
        lambda: supabase.table("stock")
        .select("id,name,unit,qty,minimum_qty,active")
        .eq("org_id", org_id)
        .eq("active", True)
    )
    low_stock = []

    for item in stock_rows:
        quantity = report_number(item.get("qty"))
        minimum = report_number(item.get("minimum_qty"))

        if minimum > 0 and quantity <= minimum:
            low_stock.append({
                "name": str(item.get("name") or "Препарат"),
                "qty": round(quantity, 2),
                "minimum_qty": round(minimum, 2),
                "unit": str(item.get("unit") or "шт"),
            })

    low_stock.sort(key=lambda item: (item["qty"] - item["minimum_qty"], item["name"]))

    stock_movements = report_rows(
        lambda: supabase.table("stock_movements")
        .select("movement_type,quantity,unit_cost,name_snap")
        .eq("org_id", org_id)
        .eq("movement_type", "writeoff")
        .gte("created_at", start_utc)
        .lt("created_at", end_utc)
    )
    writeoff_quantity = sum(
        abs(report_number(row.get("quantity")))
        for row in stock_movements
    )
    writeoff_cost = sum(
        abs(report_number(row.get("quantity")))
        * max(report_number(row.get("unit_cost")), 0)
        for row in stock_movements
    )

    hospitalizations = report_rows(
        lambda: supabase.table("hospitalizations")
        .select("id,status")
        .eq("org_id", org_id)
        .eq("is_active", True)
    )
    open_tasks = report_rows(
        lambda: supabase.table("hospital_tasks")
        .select("id,status,scheduled_at")
        .eq("org_id", org_id)
        .neq("status", "completed")
    )
    now_utc = datetime.now(timezone.utc)
    overdue_tasks = 0

    for task in open_tasks:
        raw_scheduled = str(task.get("scheduled_at") or "").strip()

        if not raw_scheduled:
            continue

        try:
            scheduled = datetime.fromisoformat(raw_scheduled.replace("Z", "+00:00"))
        except ValueError:
            continue

        if scheduled.astimezone(timezone.utc) < now_utc:
            overdue_tasks += 1

    scheduled_count = len(events)
    completed_count = report_status_count(visits, "completed")
    in_progress_count = report_status_count(visits, "in_progress")
    cancelled_count = report_status_count(events, "cancelled", "canceled")
    previous_completed = report_status_count(previous_visits, "completed")
    previous_scheduled = len(previous_events)

    payments = report_number(finance_summary.get("payments"))
    refunds = report_number(finance_summary.get("refunds"))
    expenses = report_number(finance_summary.get("expenses"))
    net_revenue = report_number(
        finance_summary.get("net_revenue"),
        payments - refunds,
    )
    result_amount = report_number(
        finance_summary.get("estimated_profit"),
        payments - refunds - expenses,
    )
    previous_revenue = report_number(
        previous_finance_summary.get("net_revenue"),
        report_number(previous_finance_summary.get("payments"))
        - report_number(previous_finance_summary.get("refunds")),
    )

    attention = []

    if low_stock:
        attention.append(f"{len(low_stock)} позицій складу нижче мінімуму")

    if overdue_tasks:
        attention.append(f"{overdue_tasks} прострочених завдань стаціонару")

    debt = report_number(finance_summary.get("outstanding"))

    if debt > 0:
        attention.append(f"Заборгованість клієнтів: {debt:.2f} грн")

    if not attention:
        attention.append("Критичних відхилень не виявлено")

    report = {
        "date": day_iso,
        "clinic_name": clinic_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "visits": {
            "scheduled": scheduled_count,
            "completed": completed_count,
            "in_progress": in_progress_count,
            "cancelled": cancelled_count,
            "completion_rate": round(
                completed_count / scheduled_count * 100,
                1,
            ) if scheduled_count else 0,
        },
        "clients": {
            "new_owners": len(new_owners),
            "new_patients": len(new_patients),
        },
        "finance": {
            "payments": round(payments, 2),
            "refunds": round(refunds, 2),
            "expenses": round(expenses, 2),
            "revenue": round(net_revenue, 2),
            "result": round(result_amount, 2),
            "average_check": round(
                report_number(finance_summary.get("average_check")),
                2,
            ),
            "outstanding": round(debt, 2),
        },
        "comparison": {
            "scheduled_delta": scheduled_count - previous_scheduled,
            "completed_delta": completed_count - previous_completed,
            "new_owners_delta": len(new_owners) - len(previous_owners),
            "new_patients_delta": len(new_patients) - len(previous_patients),
            "revenue_delta": round(net_revenue - previous_revenue, 2),
        },
        "services": {
            "top": top_services,
        },
        "stock": {
            "writeoffs_count": len(stock_movements),
            "writeoffs_qty": round(writeoff_quantity, 2),
            "writeoffs_cost": round(writeoff_cost, 2),
            "low_stock_count": len(low_stock),
            "low_stock": low_stock[:8],
        },
        "hospital": {
            "active": len(hospitalizations),
            "critical": report_status_count(hospitalizations, "critical"),
            "open_tasks": len(open_tasks),
            "overdue_tasks": overdue_tasks,
        },
        "attention": attention,
    }

    report["telegram_message"] = build_owner_report_telegram_message(report)

    return report


def report_money(value):
    amount = report_number(value)
    return f"{amount:,.2f}".replace(",", " ")


def build_owner_report_telegram_message(report):
    visits = report.get("visits") or {}
    clients = report.get("clients") or {}
    finance = report.get("finance") or {}
    stock = report.get("stock") or {}
    hospital = report.get("hospital") or {}
    services = report.get("services") or {}
    comparison = report.get("comparison") or {}
    safe_clinic = html.escape(str(report.get("clinic_name") or "Клініка"))
    safe_date = html.escape(str(report.get("date") or ""))

    lines = [
        f"<b>🐾 {safe_clinic} · підсумок дня</b>",
        f"<i>{safe_date}</i>",
        "",
        "<b>📅 Прийоми</b>",
        f"Заплановано: <b>{report_int(visits.get('scheduled'))}</b>",
        f"Завершено: <b>{report_int(visits.get('completed'))}</b> "
        f"({report_number(visits.get('completion_rate')):.1f}%)",
        f"У роботі: <b>{report_int(visits.get('in_progress'))}</b> · "
        f"скасовано: <b>{report_int(visits.get('cancelled'))}</b>",
        "",
        "<b>💰 Фінанси</b>",
        f"Надходження: <b>{report_money(finance.get('revenue'))} грн</b>",
        f"Витрати: <b>{report_money(finance.get('expenses'))} грн</b>",
        f"Результат: <b>{report_money(finance.get('result'))} грн</b>",
        f"Середній чек: {report_money(finance.get('average_check'))} грн",
        "",
        "<b>👥 Нові клієнти</b>",
        f"Власники: <b>{report_int(clients.get('new_owners'))}</b> · "
        f"пацієнти: <b>{report_int(clients.get('new_patients'))}</b>",
    ]

    top_services = services.get("top") or []

    if top_services:
        lines.extend(["", "<b>⭐ Топ послуг</b>"])

        for index, service in enumerate(top_services[:3], start=1):
            name = html.escape(str(service.get("name") or "Послуга"))
            lines.append(
                f"{index}. {name} — {report_number(service.get('qty')):g} шт."
            )

    lines.extend([
        "",
        "<b>📦 Склад і стаціонар</b>",
        f"Нижче мінімуму: <b>{report_int(stock.get('low_stock_count'))}</b>",
        f"Списань за день: <b>{report_int(stock.get('writeoffs_count'))}</b>",
        f"У стаціонарі: <b>{report_int(hospital.get('active'))}</b> · "
        f"прострочених задач: <b>{report_int(hospital.get('overdue_tasks'))}</b>",
        "",
        "<b>⚡ Порівняно з учора</b>",
        f"Завершених візитів: {report_int(comparison.get('completed_delta')):+d}",
        f"Надходження: {report_money(comparison.get('revenue_delta'))} грн",
        "",
        "<b>🔎 Потребує уваги</b>",
    ])

    for item in report.get("attention") or []:
        lines.append(f"• {html.escape(str(item))}")

    return "\n".join(lines)


def get_report_settings(org_id):
    rows = report_rows(
        lambda: supabase.table("clinic_report_settings")
        .select(
            "org_id,telegram_chat_id,daily_enabled,daily_time,timezone,updated_at"
        )
        .eq("org_id", org_id)
        .limit(1)
    )

    row = rows[0] if rows else {}

    return {
        "telegram_configured": bool(str(row.get("telegram_chat_id") or "").strip()),
        "telegram_chat_id": str(row.get("telegram_chat_id") or "").strip(),
        "daily_enabled": bool(row.get("daily_enabled")),
        "daily_time": str(row.get("daily_time") or "21:00")[:5],
        "timezone": str(row.get("timezone") or "Europe/Kyiv"),
        "updated_at": row.get("updated_at"),
    }


def send_telegram_report(chat_id, message):
    safe_chat_id = str(chat_id or "").strip()

    if not re.fullmatch(r"-?\d{5,20}", safe_chat_id):
        raise ValueError("Telegram chat ID is invalid.")

    return telegram_api_call("sendMessage", {
        "chat_id": safe_chat_id,
        "text": str(message or ""),
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    })


def telegram_api_call(method, payload=None):
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("Telegram bot is not configured on the server.")

    clean_method = str(method or "").strip()

    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]+", clean_method):
        raise ValueError("Telegram API method is invalid.")

    endpoint = (
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{clean_method}"
    )
    encoded_payload = json.dumps(payload or {}).encode("utf-8")
    telegram_request = Request(
        endpoint,
        data=encoded_payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urlopen(telegram_request, timeout=12) as response:
        response_data = json.loads(response.read().decode("utf-8"))

    if not response_data.get("ok"):
        raise RuntimeError("Telegram rejected the message.")

    return response_data.get("result") or {}


def telegram_id_keyboard():
    return {
        "keyboard": [[{
            "text": "🆔 Отримати ID",
        }]],
        "resize_keyboard": True,
        "is_persistent": True,
        "input_field_placeholder": "Натисніть кнопку, щоб отримати свій ID",
    }


def telegram_webhook_secret():
    source = (
        f"{TELEGRAM_BOT_TOKEN or ''}:"
        f"{SESSION_SECRET_KEY}:owner-report-webhook"
    )

    return hashlib.sha256(
        source.encode("utf-8")
    ).hexdigest()


def configure_owner_report_bot(public_base_url, chat_id=None):
    base_url = str(public_base_url or "").strip().rstrip("/")

    if not base_url.startswith("https://"):
        raise ValueError("Public HTTPS URL is required for Telegram webhook.")

    telegram_api_call("deleteMyCommands", {})
    telegram_api_call("setChatMenuButton", {
        "menu_button": {
            "type": "commands",
        },
    })
    telegram_api_call("setWebhook", {
        "url": f"{base_url}/api/telegram/webhook",
        "secret_token": telegram_webhook_secret(),
        "allowed_updates": ["message"],
        "drop_pending_updates": True,
    })

    safe_chat_id = str(chat_id or "").strip()

    if safe_chat_id:
        telegram_api_call("sendMessage", {
            "chat_id": safe_chat_id,
            "text": (
                "✅ Бота оновлено.\n\n"
                "Старе CRM-меню прибрано. "
                "Залишилася лише кнопка для отримання Telegram ID."
            ),
            "reply_markup": telegram_id_keyboard(),
        })

    bot = telegram_api_call("getMe", {})

    return {
        "configured": True,
        "username": bot.get("username"),
    }


def public_app_base_url():
    configured = str(
        os.getenv("PUBLIC_BASE_URL") or ""
    ).strip().rstrip("/")

    if configured:
        return configured

    forwarded_scheme = str(
        request.headers.get("X-Forwarded-Proto") or ""
    ).split(",", 1)[0].strip().lower()
    scheme = forwarded_scheme or request.scheme or "https"

    if request.host.endswith(".onrender.com"):
        scheme = "https"

    return f"{scheme}://{request.host}"


@app.get("/api/reports/daily")
def api_owner_daily_report():
    user, auth_error = owner_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    if not current_org:
        return fail("Organization not selected", 400)

    try:
        day = report_date(request.args.get("date"))
        report = build_owner_daily_report(current_org, day)
        settings = get_report_settings(current_org)
        report["telegram"] = {
            "configured": settings["telegram_configured"],
            "daily_enabled": settings["daily_enabled"],
            "daily_time": settings["daily_time"],
            "timezone": settings["timezone"],
        }

        return ok(report)

    except ValueError as error:
        return fail(str(error), 400)
    except Exception as error:
        print("❌ GET owner daily report:", repr(error), flush=True)
        return fail("Не вдалося сформувати звіт власника.", 500)


@app.get("/api/reports/settings")
def api_owner_report_settings():
    user, auth_error = owner_required()

    if auth_error:
        return auth_error

    try:
        settings = get_report_settings(get_current_org_id())
        settings["telegram_chat_id"] = (
            settings["telegram_chat_id"]
            if settings["telegram_configured"]
            else ""
        )
        settings["bot_configured"] = bool(TELEGRAM_BOT_TOKEN)
        return ok(settings)
    except Exception as error:
        print("❌ GET report settings:", repr(error), flush=True)
        return fail("Не вдалося завантажити налаштування звіту.", 500)


@app.put("/api/reports/settings")
def api_owner_report_settings_update():
    user, auth_error = owner_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()
    data = request.get_json(silent=True) or {}
    chat_id = str(data.get("telegram_chat_id") or "").strip()
    daily_enabled = bool(data.get("daily_enabled"))

    if chat_id and not re.fullmatch(r"-?\d{5,20}", chat_id):
        return fail("Telegram chat ID має містити лише цифри.", 400)

    now_iso = datetime.now(timezone.utc).isoformat()
    payload = {
        "org_id": current_org,
        "telegram_chat_id": chat_id or None,
        "daily_enabled": bool(
            daily_enabled and chat_id
        ),
        "daily_time": "21:00:00",
        "timezone": "Europe/Kyiv",
        "updated_at": now_iso,
        "updated_by": user.get("id"),
    }

    try:
        result = execute_with_retry(
            lambda: supabase.table("clinic_report_settings")
            .upsert(payload, on_conflict="org_id"),
            attempts=4,
            delay=0.3,
        )
        row = result.data[0] if result.data else payload

        return ok({
            "telegram_configured": bool(chat_id),
            "telegram_chat_id": chat_id,
            "daily_enabled": bool(
                row.get("daily_enabled")
            ),
            "daily_time": str(row.get("daily_time") or "21:00")[:5],
            "timezone": str(row.get("timezone") or "Europe/Kyiv"),
        })
    except Exception as error:
        print("❌ PUT report settings:", repr(error), flush=True)
        return fail("Не вдалося зберегти Telegram-налаштування.", 500)


@app.post("/api/reports/telegram/setup")
def api_owner_report_telegram_setup():
    user, auth_error = owner_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    try:
        settings = get_report_settings(current_org)
        configured = configure_owner_report_bot(
            public_app_base_url(),
            settings.get("telegram_chat_id"),
        )

        return ok(configured)

    except Exception as error:
        print("❌ POST Telegram bot setup:", repr(error), flush=True)
        return fail(
            "Не вдалося оновити Telegram-бота. Перевірте TELEGRAM_BOT_TOKEN.",
            502,
        )


@app.post("/api/telegram/webhook")
def api_telegram_webhook():
    received_secret = str(
        request.headers.get(
            "X-Telegram-Bot-Api-Secret-Token"
        ) or ""
    )

    if not hmac.compare_digest(
        received_secret,
        telegram_webhook_secret(),
    ):
        return fail("Unauthorized", 401)

    update = request.get_json(silent=True) or {}
    message = update.get("message") or {}
    chat = message.get("chat") or {}
    chat_id = str(chat.get("id") or "").strip()
    chat_type = str(chat.get("type") or "").strip().lower()
    text_value = str(message.get("text") or "").strip()
    normalized_text = text_value.lower().split("@", 1)[0]

    if not chat_id or chat_type != "private":
        return ok({"handled": False})

    wants_id = (
        normalized_text in {
            "/start",
            "/id",
            "🆔 отримати id",
            "отримати id",
        }
        or "отримати id" in normalized_text
    )

    try:
        if wants_id:
            response_text = (
                "<b>Ваш Telegram ID:</b>\n"
                f"<code>{html.escape(chat_id)}</code>\n\n"
                "Скопіюйте лише цифри та вставте їх "
                "у розділі «Фінанси → Звіт власника»."
            )
        else:
            response_text = (
                "Цей бот надсилає щоденні звіти клініки.\n\n"
                "Натисніть кнопку нижче, щоб отримати свій Telegram ID."
            )

        telegram_api_call("sendMessage", {
            "chat_id": chat_id,
            "text": response_text,
            "parse_mode": "HTML",
            "reply_markup": telegram_id_keyboard(),
        })

    except Exception as error:
        print("⚠️ Telegram webhook reply failed:", repr(error), flush=True)

    return ok({"handled": True})


def find_report_sent_audit(org_id, day_iso):
    try:
        rows = report_rows(
            lambda: supabase.table("audit_events")
            .select("action,metadata,created_at")
            .eq("org_id", org_id)
            .eq("entity_type", "daily_report")
            .eq("entity_id", day_iso)
            .limit(10)
        )
    except Exception as error:
        print(
            "⚠️ Report delivery audit lookup failed:",
            repr(error),
            flush=True,
        )
        return None

    return next(
        (
            row
            for row in rows
            if row.get("action") in {
                "report.telegram_sent",
                "report.telegram_auto_sent",
            }
        ),
        None,
    )


def backfill_report_delivery_from_audit(org_id, day_iso, audit_row):
    metadata = audit_row.get("metadata") or {}
    if not isinstance(metadata, dict):
        metadata = {}
    message_id = metadata.get("telegram_message_id")
    sent_at = (
        audit_row.get("created_at")
        or datetime.now(timezone.utc).isoformat()
    )

    try:
        result = supabase.table("clinic_report_deliveries").insert({
            "org_id": org_id,
            "report_date": day_iso,
            "channel": "telegram",
            "status": "sent",
            "attempt_count": 1,
            "telegram_message_id": (
                str(message_id)
                if message_id is not None
                else None
            ),
            "sent_at": sent_at,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).execute()

        return result.data[0] if result.data else None
    except Exception:
        try:
            rows = report_rows(
                lambda: supabase.table("clinic_report_deliveries")
                .select("id,status,telegram_message_id")
                .eq("org_id", org_id)
                .eq("report_date", day_iso)
                .eq("channel", "telegram")
                .limit(1)
            )
            return rows[0] if rows else None
        except Exception as error:
            print(
                "⚠️ Report delivery audit backfill failed:",
                repr(error),
                flush=True,
            )
            return None


@app.post("/api/reports/daily/send")
def api_owner_daily_report_send():
    user, auth_error = owner_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()
    data = request.get_json(silent=True) or {}

    try:
        day = report_date(data.get("date"))
        day_iso = day.isoformat()
        settings = get_report_settings(current_org)
        chat_id = settings.get("telegram_chat_id")

        if not chat_id:
            return fail("Спочатку вкажіть Telegram chat ID власника.", 409)

        delivery_rows = report_rows(
            lambda: supabase.table("clinic_report_deliveries")
            .select(
                "id,status,attempt_count,telegram_message_id,updated_at"
            )
            .eq("org_id", current_org)
            .eq("report_date", day_iso)
            .eq("channel", "telegram")
            .limit(1)
        )
        delivery = delivery_rows[0] if delivery_rows else None

        if not delivery:
            previous_audit = find_report_sent_audit(
                current_org,
                day_iso,
            )

            if previous_audit:
                delivery = backfill_report_delivery_from_audit(
                    current_org,
                    day_iso,
                    previous_audit,
                )

                return ok({
                    "sent": False,
                    "already_sent": True,
                    "report_date": day_iso,
                    "message_id": (
                        delivery.get("telegram_message_id")
                        if delivery
                        else None
                    ),
                })

        if delivery and delivery.get("status") == "sent":
            return ok({
                "sent": False,
                "already_sent": True,
                "report_date": day_iso,
                "message_id": delivery.get("telegram_message_id"),
            })

        if delivery and delivery.get("status") == "processing":
            raw_updated = str(delivery.get("updated_at") or "").strip()

            try:
                updated_at = datetime.fromisoformat(
                    raw_updated.replace("Z", "+00:00")
                )
            except ValueError:
                updated_at = None

            if (
                updated_at
                and datetime.now(timezone.utc) - updated_at
                < timedelta(minutes=15)
            ):
                return fail(
                    "Звіт уже відправляється. Зачекайте кілька секунд.",
                    409,
                )

        now_iso = datetime.now(timezone.utc).isoformat()
        delivery_id = ""

        if delivery:
            delivery_id = str(delivery.get("id") or "")
            next_attempt = min(
                max(report_int(delivery.get("attempt_count")) + 1, 1),
                3,
            )

            supabase.table("clinic_report_deliveries").update({
                "status": "processing",
                "attempt_count": next_attempt,
                "error_message": None,
                "updated_at": now_iso,
            }).eq("id", delivery_id).execute()
        else:
            try:
                delivery_result = supabase.table(
                    "clinic_report_deliveries"
                ).insert({
                    "org_id": current_org,
                    "report_date": day_iso,
                    "channel": "telegram",
                    "status": "processing",
                    "attempt_count": 1,
                    "updated_at": now_iso,
                }).execute()
                delivery_id = str(
                    delivery_result.data[0].get("id")
                    if delivery_result.data
                    else ""
                )
            except Exception:
                raced_rows = report_rows(
                    lambda: supabase.table("clinic_report_deliveries")
                    .select("id,status,telegram_message_id")
                    .eq("org_id", current_org)
                    .eq("report_date", day_iso)
                    .eq("channel", "telegram")
                    .limit(1)
                )
                raced_delivery = raced_rows[0] if raced_rows else None

                if raced_delivery and raced_delivery.get("status") == "sent":
                    return ok({
                        "sent": False,
                        "already_sent": True,
                        "report_date": day_iso,
                        "message_id": raced_delivery.get(
                            "telegram_message_id"
                        ),
                    })

                return fail(
                    "Звіт уже відправляється. Зачекайте кілька секунд.",
                    409,
                )

        if not delivery_id:
            return fail("Не вдалося підготувати відправлення звіту.", 500)

        try:
            report = build_owner_daily_report(current_org, day)
            telegram_result = send_telegram_report(
                chat_id,
                report["telegram_message"],
            )
        except Exception as telegram_error:
            supabase.table("clinic_report_deliveries").update({
                "status": "failed",
                "error_message": type(telegram_error).__name__,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", delivery_id).execute()
            raise

        message_id = telegram_result.get("message_id")

        supabase.table("clinic_report_deliveries").update({
            "status": "sent",
            "telegram_message_id": (
                str(message_id)
                if message_id is not None
                else None
            ),
            "error_message": None,
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", delivery_id).execute()

        write_audit_event(
            action="report.telegram_sent",
            entity_type="daily_report",
            entity_id=day_iso,
            entity_label=f"Звіт за {day_iso}",
            summary="Щоденний звіт відправлено власнику в Telegram",
            metadata={
                "report_date": day_iso,
                "telegram_message_id": message_id,
            },
        )

        return ok({
            "sent": True,
            "already_sent": False,
            "report_date": day_iso,
            "message_id": message_id,
        })

    except ValueError as error:
        return fail(str(error), 400)
    except Exception as error:
        print("❌ POST owner daily report send:", repr(error), flush=True)
        return fail(
            "Telegram не прийняв повідомлення. Перевірте chat ID та запустіть бота командою /start.",
            502,
        )


def report_dispatch_authorized():
    authorization = str(
        request.headers.get("Authorization") or ""
    ).strip()

    if not authorization.lower().startswith("bearer "):
        return False

    token = authorization[7:].strip()

    if len(token) < 32:
        return False

    token_hash = hashlib.sha256(
        token.encode("utf-8")
    ).hexdigest()

    try:
        rows = report_rows(
            lambda: supabase.table(
                "clinic_report_dispatch_auth"
            )
            .select("token_hash")
            .eq("singleton", True)
            .limit(1)
        )
    except Exception as error:
        print("⚠️ Report dispatcher auth failed:", repr(error), flush=True)
        return False

    stored_hash = str(
        rows[0].get("token_hash")
        if rows
        else ""
    ).strip()

    return bool(
        stored_hash
        and hmac.compare_digest(
            token_hash,
            stored_hash,
        )
    )


def write_automatic_report_audit(org_id, day, message_id):
    try:
        supabase.table("audit_events").insert({
            "org_id": org_id,
            "actor_name": "Автоматичний звіт",
            "actor_role": "system",
            "action": "report.telegram_auto_sent",
            "entity_type": "daily_report",
            "entity_id": day.isoformat(),
            "entity_label": f"Звіт за {day.isoformat()}",
            "summary": "Щоденний звіт автоматично відправлено в Telegram",
            "metadata": {
                "report_date": day.isoformat(),
                "telegram_message_id": message_id,
                "schedule": "21:00 Europe/Kyiv",
            },
        }).execute()
    except Exception as error:
        print("⚠️ Automatic report audit failed:", repr(error), flush=True)


@app.post("/api/internal/reports/daily-dispatch")
def api_internal_daily_report_dispatch():
    if not report_dispatch_authorized():
        return fail("Unauthorized", 401)

    now_kyiv = datetime.now(REPORT_TIMEZONE)

    if now_kyiv.hour != 21:
        return ok({
            "checked": True,
            "sent": 0,
            "skipped": "outside_delivery_hour",
            "local_time": now_kyiv.strftime("%H:%M"),
        })

    report_day = now_kyiv.date()
    sent_count = 0
    skipped_count = 0
    failed_count = 0

    try:
        settings_rows = report_rows(
            lambda: supabase.table("clinic_report_settings")
            .select(
                "org_id,telegram_chat_id,daily_enabled,daily_time,timezone"
            )
            .eq("daily_enabled", True)
        )

        for settings in settings_rows:
            org_id = str(settings.get("org_id") or "").strip()
            chat_id = str(settings.get("telegram_chat_id") or "").strip()

            if not org_id or not chat_id:
                skipped_count += 1
                continue

            existing_rows = report_rows(
                lambda org_id=org_id: supabase.table(
                    "clinic_report_deliveries"
                )
                .select("id,status,attempt_count,updated_at")
                .eq("org_id", org_id)
                .eq("report_date", report_day.isoformat())
                .eq("channel", "telegram")
                .limit(1)
            )
            existing = existing_rows[0] if existing_rows else None

            if not existing:
                previous_audit = find_report_sent_audit(
                    org_id,
                    report_day.isoformat(),
                )

                if previous_audit:
                    backfill_report_delivery_from_audit(
                        org_id,
                        report_day.isoformat(),
                        previous_audit,
                    )
                    skipped_count += 1
                    continue

            if existing and existing.get("status") == "sent":
                skipped_count += 1
                continue

            attempts = report_int(
                existing.get("attempt_count")
                if existing
                else 0
            )

            if existing and attempts >= 3:
                skipped_count += 1
                continue

            if existing and existing.get("status") == "processing":
                raw_updated = str(existing.get("updated_at") or "").strip()

                try:
                    updated_at = datetime.fromisoformat(
                        raw_updated.replace("Z", "+00:00")
                    )
                except ValueError:
                    updated_at = None

                if (
                    updated_at
                    and datetime.now(timezone.utc) - updated_at
                    < timedelta(minutes=15)
                ):
                    skipped_count += 1
                    continue

            now_iso = datetime.now(timezone.utc).isoformat()

            if existing:
                delivery_id = str(existing.get("id"))
                attempts += 1
                supabase.table("clinic_report_deliveries").update({
                    "status": "processing",
                    "attempt_count": attempts,
                    "error_message": None,
                    "updated_at": now_iso,
                }).eq("id", delivery_id).execute()
            else:
                delivery_result = supabase.table(
                    "clinic_report_deliveries"
                ).insert({
                    "org_id": org_id,
                    "report_date": report_day.isoformat(),
                    "channel": "telegram",
                    "status": "processing",
                    "attempt_count": 1,
                    "updated_at": now_iso,
                }).execute()
                delivery_id = str(
                    delivery_result.data[0].get("id")
                    if delivery_result.data
                    else ""
                )
                attempts = 1

            if not delivery_id:
                failed_count += 1
                continue

            try:
                report = build_owner_daily_report(
                    org_id,
                    report_day,
                )
                telegram_result = send_telegram_report(
                    chat_id,
                    report["telegram_message"],
                )
                message_id = telegram_result.get("message_id")

                supabase.table("clinic_report_deliveries").update({
                    "status": "sent",
                    "telegram_message_id": (
                        str(message_id)
                        if message_id is not None
                        else None
                    ),
                    "error_message": None,
                    "sent_at": datetime.now(timezone.utc).isoformat(),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", delivery_id).execute()

                write_automatic_report_audit(
                    org_id,
                    report_day,
                    message_id,
                )
                sent_count += 1

            except Exception as delivery_error:
                safe_error = type(delivery_error).__name__
                supabase.table("clinic_report_deliveries").update({
                    "status": "failed",
                    "error_message": safe_error,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", delivery_id).execute()
                failed_count += 1
                print(
                    "⚠️ Automatic report delivery failed:",
                    org_id,
                    safe_error,
                    flush=True,
                )

        return ok({
            "checked": True,
            "organizations": len(settings_rows),
            "sent": sent_count,
            "skipped": skipped_count,
            "failed": failed_count,
            "report_date": report_day.isoformat(),
        })

    except Exception as error:
        print("❌ Automatic report dispatcher failed:", repr(error), flush=True)
        return fail("Automatic report dispatch failed", 500)


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

        result = execute_with_retry(
            lambda: (
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
            ),
            attempts=4,
            delay=0.35,
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


@app.get(
    "/api/finance/client-balances"
)
def api_finance_client_balances():
    """
    Read-only client settlement register.

    The endpoint deliberately derives balances from the same visit lines and
    completed payments as the visit payment modal. This keeps the finance
    workspace useful without introducing a second accounting truth.
    """
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

    try:
        owners = (
            load_finance_org_rows(
                "owners",
                order_by="name",
            )
        )

        patients = (
            load_finance_org_rows(
                "patients"
            )
        )

        visits = (
            load_finance_org_rows(
                "visits",
                order_by="date",
                desc=True,
            )
        )

        owners_by_id = {
            str(owner.get("id")):
                owner
            for owner in owners
            if owner.get("id")
        }

        patients_by_id = {
            str(patient.get("id")):
                patient
            for patient in patients
            if patient.get("id")
        }

        visit_ids = [
            str(visit.get("id"))
            for visit in visits
            if visit.get("id")
        ]

        services_by_visit = {
            visit_id: []
            for visit_id in visit_ids
        }

        stock_by_visit = {
            visit_id: []
            for visit_id in visit_ids
        }

        transactions_by_visit = {
            visit_id: []
            for visit_id in visit_ids
        }

        # Keep the PostgREST URL and the in-filter reasonably small for clinics
        # with a long history.
        for chunk_start in range(
            0,
            len(visit_ids),
            150,
        ):
            visit_id_chunk = (
                visit_ids[
                    chunk_start:
                    chunk_start + 150
                ]
            )

            if not visit_id_chunk:
                continue

            (
                chunk_services,
                chunk_stock,
            ) = load_visit_lines(
                visit_id_chunk
            )

            services_by_visit.update(
                chunk_services
            )

            stock_by_visit.update(
                chunk_stock
            )

            transactions_result = (
                execute_with_retry(
                    lambda ids=visit_id_chunk: (
                        supabase
                        .table(
                            "finance_transactions"
                        )
                        .select(
                            "visit_id, "
                            "transaction_type, "
                            "status, amount, "
                            "occurred_at"
                        )
                        .eq(
                            "org_id",
                            current_org,
                        )
                        .in_(
                            "visit_id",
                            ids,
                        )
                    ),
                    attempts=3,
                    delay=0.25,
                )
            )

            for transaction in (
                transactions_result.data
                or []
            ):
                transaction_visit_id = str(
                    transaction.get(
                        "visit_id"
                    )
                    or ""
                )

                if not transaction_visit_id:
                    continue

                transactions_by_visit.setdefault(
                    transaction_visit_id,
                    [],
                ).append(
                    transaction
                )

        clients_by_owner = {}

        summary = {
            "billed": 0,
            "paid": 0,
            "outstanding": 0,
            "clients_count": 0,
            "debt_clients_count": 0,
            "debt_visits_count": 0,
            "collection_rate": 0,
        }

        for visit in visits:
            visit_id = str(
                visit.get("id")
                or ""
            )

            patient_id = str(
                visit.get("pet_id")
                or ""
            )

            patient = (
                patients_by_id.get(
                    patient_id
                )
            )

            if (
                not visit_id
                or not patient
            ):
                continue

            owner_id = str(
                patient.get("owner_id")
                or ""
            )

            owner = (
                owners_by_id.get(
                    owner_id
                )
                or {}
            )

            service_total = sum(
                finance_number(
                    line.get("qty")
                )
                * finance_number(
                    line.get(
                        "priceSnap"
                    )
                )
                for line in (
                    services_by_visit.get(
                        visit_id,
                        [],
                    )
                )
            )

            stock_total = sum(
                finance_number(
                    line.get("qty")
                )
                * finance_number(
                    line.get(
                        "priceSnap"
                    )
                )
                for line in (
                    stock_by_visit.get(
                        visit_id,
                        [],
                    )
                )
            )

            discount = max(
                0,
                finance_number(
                    visit.get(
                        "discount_amount"
                    )
                ),
            )

            total = max(
                0,
                finance_number(
                    service_total
                    + stock_total
                    - discount
                ),
            )

            paid = 0

            for transaction in (
                transactions_by_visit.get(
                    visit_id,
                    [],
                )
            ):
                if (
                    transaction.get("status")
                    != "completed"
                ):
                    continue

                amount = finance_number(
                    transaction.get("amount")
                )

                if (
                    transaction.get(
                        "transaction_type"
                    )
                    == "payment"
                ):
                    paid += amount

                elif (
                    transaction.get(
                        "transaction_type"
                    )
                    == "refund"
                ):
                    paid -= amount

            paid = max(
                0,
                finance_number(paid),
            )

            stored_status = str(
                visit.get(
                    "financial_status"
                )
                or ""
            ).lower()

            if stored_status in {
                "cancelled",
                "refunded",
            }:
                total = 0
                paid = 0

            remaining = max(
                0,
                finance_number(
                    total - paid
                ),
            )

            if total <= 0 and paid <= 0:
                continue

            if remaining <= 0:
                financial_status = "paid"
            elif paid > 0:
                financial_status = "partial"
            else:
                financial_status = "unpaid"

            owner_name = (
                owner.get("name")
                or "Власник не вказаний"
            )

            client = (
                clients_by_owner.setdefault(
                    owner_id
                    or f"unknown:{patient_id}",
                    {
                        "owner_id":
                            owner_id
                            or None,

                        "owner_name":
                            owner_name,

                        "phone":
                            owner.get("phone")
                            or "",

                        "billed": 0,
                        "paid": 0,
                        "remaining": 0,
                        "visits": [],
                    },
                )
            )

            client["billed"] += total
            client["paid"] += paid
            client["remaining"] += (
                remaining
            )

            client["visits"].append({
                "visit_id":
                    visit_id,

                "patient_id":
                    patient_id,

                "patient_name":
                    patient.get("name")
                    or "Пацієнт",

                "species":
                    patient.get("species")
                    or "",

                "date":
                    visit.get("date"),

                "diagnosis":
                    visit.get("dx")
                    or "",

                "total":
                    finance_number(total),

                "paid":
                    finance_number(paid),

                "remaining":
                    finance_number(
                        remaining
                    ),

                "financial_status":
                    financial_status,
            })

            summary["billed"] += total
            summary["paid"] += paid
            summary["outstanding"] += (
                remaining
            )

            if remaining > 0:
                summary[
                    "debt_visits_count"
                ] += 1

        clients = []

        for client in (
            clients_by_owner.values()
        ):
            client["billed"] = (
                finance_number(
                    client["billed"]
                )
            )

            client["paid"] = (
                finance_number(
                    client["paid"]
                )
            )

            client["remaining"] = (
                finance_number(
                    client["remaining"]
                )
            )

            client["status"] = (
                "debt"
                if client["remaining"] > 0
                else "paid"
            )

            client["visits"].sort(
                key=lambda item: str(
                    item.get("date")
                    or ""
                ),
                reverse=True,
            )

            clients.append(client)

        clients.sort(
            key=lambda client: (
                client.get("remaining", 0),
                client.get("billed", 0),
            ),
            reverse=True,
        )

        summary["clients_count"] = (
            len(clients)
        )

        summary["debt_clients_count"] = sum(
            1
            for client in clients
            if client.get("remaining", 0) > 0
        )

        summary["billed"] = (
            finance_number(
                summary["billed"]
            )
        )

        summary["paid"] = (
            finance_number(
                summary["paid"]
            )
        )

        summary["outstanding"] = (
            finance_number(
                summary["outstanding"]
            )
        )

        summary["collection_rate"] = (
            round(
                (
                    summary["paid"]
                    / summary["billed"]
                    * 100
                ),
                1,
            )
            if summary["billed"] > 0
            else 0
        )

        return ok({
            "summary": summary,
            "items": clients,
        })

    except Exception as error:
        print(
            "❌ GET finance client balances:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити розрахунки з клієнтами.",
            500,
        )


@app.get(
    "/api/finance/accounts"
)
def api_finance_accounts():
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

    try:
        result = execute_with_retry(
            lambda: (
                supabase
                .rpc(
                    "get_financial_account_balances",
                    {
                        "p_org_id":
                            current_org,
                    },
                )
            ),
            attempts=4,
            delay=0.35,
        )

        balances = (
            result.data
            if result.data
            is not None
            else {}
        )

        if (
            isinstance(
                balances,
                list,
            )
            and balances
        ):
            balances = (
                balances[0]
            )

        return ok(
            balances
        )

    except Exception as error:
        print(
            "❌ GET finance accounts:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити залишки на рахунках.",
            500,
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

        created_transaction = (
            insert_result.data[0]
        )

        audit_actions = {
            "expense":
                "expense.created",
            "deposit":
                "cash.deposit_created",
            "withdrawal":
                "cash.withdrawal_created",
        }

        write_audit_event(
            action=audit_actions[
                transaction_type
            ],
            entity_type=
                "finance_transaction",
            entity_id=
                created_transaction.get(
                    "id"
                ),
            entity_label=(
                category
                or allowed_types[
                    transaction_type
                ]
            ),
            summary=(
                f"{allowed_types[transaction_type]}: "
                f"{amount:g} UAH"
            ),
            after_data=(
                finance_audit_snapshot(
                    created_transaction
                )
            ),
            metadata={
                "idempotency_key":
                    idempotency_key,
                "created_via":
                    "finance_dashboard",
            },
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

    financial_account_id = str(
        request.args.get(
            "financial_account_id"
        )
        or ""
    ).strip()

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

    if financial_account_id:
        try:
            uuid.UUID(
                financial_account_id
            )

        except (
            ValueError,
            TypeError,
            AttributeError,
        ):
            return fail(
                "Некоректний фінансовий рахунок.",
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
        start_at = (
            datetime(
                date_from.year,
                date_from.month,
                date_from.day,
                tzinfo=kyiv_zone,
            )
            .astimezone(
                timezone.utc
            )
            .isoformat()
            if date_from
            else None
        )

        end_at = None

        if date_to:
            next_date = (
                date_to +
                timedelta(
                    days=1
                )
            )

            end_at = (
                datetime(
                    next_date.year,
                    next_date.month,
                    next_date.day,
                    tzinfo=kyiv_zone,
                )
                .astimezone(
                    timezone.utc
                )
                .isoformat()
            )

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

        def build_transactions_query():
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
                    "financial_account_id, "
                    "reverses_transaction_id, "
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

            if financial_account_id:
                query = query.eq(
                    "financial_account_id",
                    financial_account_id,
                )

            if status:
                query = query.eq(
                    "status",
                    status,
                )

            if start_at:
                query = query.gte(
                    "occurred_at",
                    start_at,
                )

            if end_at:
                query = query.lt(
                    "occurred_at",
                    end_at,
                )

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

            return (
                query
                .order(
                    "occurred_at",
                    desc=True,
                )
                .range(
                    offset,
                    offset + limit,
                )
            )

        result = execute_with_retry(
            build_transactions_query,
            attempts=4,
            delay=0.3,
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


@app.post(
    "/api/finance/transactions/<transaction_id>/cancel"
)
def api_finance_transaction_cancel(
    transaction_id
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

    try:
        uuid.UUID(
            str(transaction_id)
        )

    except (
        ValueError,
        TypeError,
        AttributeError,
    ):
        return fail(
            "Некоректний платіж.",
            400,
        )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    reason = str(
        data.get("reason")
        or ""
    ).strip()

    if len(reason) > 500:
        return fail(
            "Причина скасування надто довга.",
            400,
        )

    original_transaction = (
        load_finance_transaction_for_audit(
            transaction_id,
            current_org,
        )
    )

    try:
        result = (
            supabase
            .rpc(
                "cancel_visit_payment",
                {
                    "p_org_id":
                        current_org,

                    "p_transaction_id":
                        transaction_id,

                    "p_user_id":
                        user.get("id"),

                    "p_reason":
                        (
                            reason
                            or None
                        ),
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
                list,
            )
            and response_data
        ):
            response_data = (
                response_data[0]
            )

        response_payload = (
            response_data
            if isinstance(
                response_data,
                dict,
            )
            else {}
        )

        write_audit_event(
            action="payment.cancelled",
            entity_type=
                "finance_transaction",
            entity_id=transaction_id,
            entity_label=
                "Скасування оплати",
            summary=(
                "Оплату скасовано"
            ),
            before_data=(
                finance_audit_snapshot(
                    original_transaction
                )
                if original_transaction
                else {
                    "status":
                        "completed",
                }
            ),
            after_data={
                "status": "cancelled",
                "cancelled_amount":
                    response_payload.get(
                        "cancelled_amount"
                    ),
                "reason": reason or None,
                "paid_after":
                    response_payload.get(
                        "paid_after"
                    ),
                "remaining":
                    response_payload.get(
                        "remaining"
                    ),
                "financial_status":
                    response_payload.get(
                        "financial_status"
                    ),
            },
            metadata={
                "visit_id":
                    response_payload.get(
                        "visit_id"
                    )
                    or (
                        original_transaction
                        or {}
                    ).get("visit_id"),
            },
        )

        return ok(
            response_data
        )

    except Exception as error:
        error_text = str(
            error
        )

        lowered_error = (
            error_text.lower()
        )

        print(
            "❌ POST cancel visit payment:",
            repr(error),
            flush=True,
        )

        if (
            "not found"
            in lowered_error
        ):
            return fail(
                "Платіж не знайдено.",
                404,
            )

        if (
            "already cancelled"
            in lowered_error
            or "only completed"
            in lowered_error
            or "only visit payments"
            in lowered_error
        ):
            return fail(
                "Цей платіж вже не можна скасувати.",
                409,
            )

        return fail(
            "Не вдалося скасувати платіж.",
            500,
        )


@app.post(
    "/api/finance/transactions/<transaction_id>/refund"
)
def api_finance_transaction_refund(
    transaction_id
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

    try:
        uuid.UUID(
            str(transaction_id)
        )

    except (
        ValueError,
        TypeError,
        AttributeError,
    ):
        return fail(
            "Некоректний платіж.",
            400,
        )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    try:
        amount = round(
            float(
                data.get("amount")
            ),
            2,
        )

    except (
        TypeError,
        ValueError,
    ):
        return fail(
            "Вкажіть коректну суму повернення.",
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
            "Сума повернення повинна бути більшою за нуль.",
            400,
        )

    reason = str(
        data.get("reason")
        or ""
    ).strip()

    if not reason:
        return fail(
            "Вкажіть причину повернення.",
            400,
        )

    if len(reason) > 500:
        return fail(
            "Причина повернення надто довга.",
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
            "Некоректний ключ повернення.",
            400,
        )

    original_transaction = (
        load_finance_transaction_for_audit(
            transaction_id,
            current_org,
        )
    )

    try:
        result = (
            supabase
            .rpc(
                "refund_visit_payment",
                {
                    "p_org_id":
                        current_org,

                    "p_transaction_id":
                        transaction_id,

                    "p_user_id":
                        user.get("id"),

                    "p_amount":
                        amount,

                    "p_reason":
                        reason,

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
                list,
            )
            and response_data
        ):
            response_data = (
                response_data[0]
            )

        response_payload = (
            response_data
            if isinstance(
                response_data,
                dict,
            )
            else {}
        )

        refund_transaction = (
            response_payload.get(
                "transaction"
            )
            if isinstance(
                response_payload.get(
                    "transaction"
                ),
                dict,
            )
            else {}
        )

        if not response_payload.get(
            "idempotent_replay"
        ):
            write_audit_event(
                action="payment.refunded",
                entity_type=
                    "finance_transaction",
                entity_id=(
                    refund_transaction.get(
                        "id"
                    )
                    or transaction_id
                ),
                entity_label=
                    "Повернення оплати",
                summary=(
                    f"Повернено {amount:g} UAH"
                ),
                before_data=(
                    finance_audit_snapshot(
                        original_transaction
                    )
                    if original_transaction
                    else {
                        "payment_id":
                            transaction_id,
                    }
                ),
                after_data={
                    "refund_id":
                        refund_transaction.get(
                            "id"
                        ),
                    "refund_amount":
                        response_payload.get(
                            "refund_amount"
                        )
                        or amount,
                    "reason": reason,
                    "refunded_total":
                        response_payload.get(
                            "refunded_total"
                        ),
                    "refundable_after":
                        response_payload.get(
                            "refundable_after"
                        ),
                    "paid_after":
                        response_payload.get(
                            "paid_after"
                        ),
                    "remaining":
                        response_payload.get(
                            "remaining"
                        ),
                    "financial_status":
                        response_payload.get(
                            "financial_status"
                        ),
                },
                metadata={
                    "payment_id":
                        transaction_id,
                    "visit_id":
                        response_payload.get(
                            "visit_id"
                        )
                        or (
                            original_transaction
                            or {}
                        ).get("visit_id"),
                    "idempotency_key":
                        idempotency_key,
                },
            )

        return ok(
            response_data
        )

    except Exception as error:
        error_text = str(
            error
        )

        lowered_error = (
            error_text.lower()
        )

        print(
            "❌ POST refund visit payment:",
            repr(error),
            flush=True,
        )

        if (
            "not found"
            in lowered_error
        ):
            return fail(
                "Платіж не знайдено.",
                404,
            )

        if (
            "exceeds refundable"
            in lowered_error
            or "fully refunded"
            in lowered_error
        ):
            return fail(
                "Сума перевищує доступний залишок платежу.",
                409,
            )

        if (
            "only completed"
            in lowered_error
            or "only visit payments"
            in lowered_error
            or "cancelled payment"
            in lowered_error
        ):
            return fail(
                "Цей платіж вже не можна повернути.",
                409,
            )

        return fail(
            "Не вдалося оформити повернення.",
            500,
        )


@app.patch(
    "/api/finance/transactions/<transaction_id>/expense"
)
def api_finance_expense_update(
    transaction_id
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

    try:
        uuid.UUID(
            str(transaction_id)
        )

    except (
        ValueError,
        TypeError,
        AttributeError,
    ):
        return fail(
            "Некоректна витрата.",
            400,
        )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    try:
        amount = round(
            float(
                data.get("amount")
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
        or amount > 1_000_000_000
    ):
        return fail(
            "Вкажіть коректну суму.",
            400,
        )

    category = str(
        data.get("category")
        or ""
    ).strip()

    payment_method = str(
        data.get("payment_method")
        or ""
    ).strip().lower()

    counterparty = str(
        data.get("counterparty")
        or ""
    ).strip()

    description = str(
        data.get("description")
        or ""
    ).strip()

    document_url = str(
        data.get("document_url")
        or ""
    ).strip()

    if (
        not category
        or len(category) > 150
    ):
        return fail(
            "Оберіть коректну категорію витрати.",
            400,
        )

    if payment_method not in {
        "cash",
        "card",
        "terminal",
        "transfer",
        "other",
    }:
        return fail(
            "Оберіть спосіб оплати.",
            400,
        )

    if len(counterparty) > 300:
        return fail(
            "Назва контрагента надто довга.",
            400,
        )

    if len(description) > 2000:
        return fail(
            "Опис надто довгий.",
            400,
        )

    if len(document_url) > 2000:
        return fail(
            "Посилання на документ надто довге.",
            400,
        )

    raw_occurred_at = str(
        data.get("occurred_at")
        or ""
    ).strip()

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

    original_transaction = (
        load_finance_transaction_for_audit(
            transaction_id,
            current_org,
        )
    )

    try:
        result = (
            supabase
            .rpc(
                "edit_manual_expense",
                {
                    "p_org_id":
                        current_org,

                    "p_transaction_id":
                        transaction_id,

                    "p_user_id":
                        user.get("id"),

                    "p_amount":
                        amount,

                    "p_category":
                        category,

                    "p_payment_method":
                        payment_method,

                    "p_occurred_at":
                        occurred_at,

                    "p_counterparty":
                        (
                            counterparty
                            or None
                        ),

                    "p_description":
                        (
                            description
                            or None
                        ),

                    "p_document_url":
                        (
                            document_url
                            or None
                        ),
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
                list,
            )
            and response_data
        ):
            response_data = (
                response_data[0]
            )

        response_payload = (
            response_data
            if isinstance(
                response_data,
                dict,
            )
            else {}
        )

        updated_transaction = (
            response_payload.get(
                "transaction"
            )
            if isinstance(
                response_payload.get(
                    "transaction"
                ),
                dict,
            )
            else {
                "id": transaction_id,
                "transaction_type":
                    "expense",
                "amount": amount,
                "currency": "UAH",
                "payment_method":
                    payment_method,
                "status": "completed",
                "category": category,
                "counterparty":
                    counterparty or None,
                "description":
                    description or "Витрата",
                "document_url":
                    document_url or None,
                "occurred_at":
                    occurred_at,
            }
        )

        before_snapshot = (
            finance_audit_snapshot(
                original_transaction
            )
            if original_transaction
            else {
                "amount":
                    response_payload.get(
                        "previous_amount"
                    ),
                "payment_method":
                    response_payload.get(
                        "previous_payment_method"
                    ),
            }
        )

        after_snapshot = (
            finance_audit_snapshot(
                updated_transaction
            )
        )

        changed_fields = [
            field
            for field in after_snapshot
            if (
                field not in before_snapshot
                or before_snapshot.get(
                    field
                )
                != after_snapshot.get(
                    field
                )
            )
        ]

        if changed_fields:
            write_audit_event(
                action="expense.updated",
                entity_type=
                    "finance_transaction",
                entity_id=transaction_id,
                entity_label=(
                    updated_transaction.get(
                        "category"
                    )
                    or category
                    or "Витрата"
                ),
                summary=
                    "Витрату змінено",
                before_data={
                    field:
                        before_snapshot.get(
                            field
                        )
                    for field
                    in changed_fields
                    if field
                    in before_snapshot
                },
                after_data={
                    field:
                        after_snapshot.get(
                            field
                        )
                    for field
                    in changed_fields
                },
                metadata={
                    "changed_fields":
                        changed_fields,
                },
            )

        return ok(
            response_data
        )

    except Exception as error:
        error_text = str(
            error
        )

        lowered_error = (
            error_text.lower()
        )

        print(
            "❌ PATCH manual expense:",
            repr(error),
            flush=True,
        )

        if "not found" in lowered_error:
            return fail(
                "Витрату не знайдено.",
                404,
            )

        if (
            "only completed manual"
            in lowered_error
        ):
            return fail(
                (
                    "Цю витрату не можна редагувати вручну. "
                    "Змініть пов’язаний документ."
                ),
                409,
            )

        if (
            "invalid"
            in lowered_error
            or "too long"
            in lowered_error
        ):
            return fail(
                "Перевірте дані витрати.",
                400,
            )

        return fail(
            "Не вдалося зберегти зміни витрати.",
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
        result = execute_with_retry(
            lambda: (
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
            ),
            attempts=4,
            delay=0.35,
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
        
# =====================================================
# FINANCE: RECEIVE STOCK PURCHASE
# =====================================================

@app.post(
    "/api/finance/purchases/<purchase_id>/receive"
)
def api_receive_stock_purchase(
    purchase_id,
):
    """
    Принимает поставку по закупке.

    - увеличивает received_qty;
    - пополняет склад;
    - создаёт stock_movements;
    - обновляет статус закупки;
    - защищает от повторного запроса.
    """

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

    clean_purchase_id = str(
        purchase_id or ""
    ).strip()

    if not clean_purchase_id:
        return fail(
            "purchase_id required",
            400,
        )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    items = data.get(
        "items"
    )

    if (
        not isinstance(items, list)
        or not items
    ):
        return fail(
            "Додайте хоча б одну позицію приймання.",
            400,
        )

    clean_items = []

    for index, item in enumerate(
        items
    ):
        if not isinstance(
            item,
            dict,
        ):
            return fail(
                (
                    "Некоректна позиція "
                    f"№{index + 1}."
                ),
                400,
            )

        item_id = str(
            item.get("item_id")
            or item.get(
                "purchase_item_id"
            )
            or ""
        ).strip()

        try:
            quantity = float(
                item.get("quantity")
                if item.get("quantity")
                is not None
                else item.get("qty")
            )

        except (
            TypeError,
            ValueError,
        ):
            quantity = 0

        if not item_id:
            return fail(
                (
                    "Не вказано позицію "
                    f"№{index + 1}."
                ),
                400,
            )

        if quantity <= 0:
            return fail(
                (
                    "Кількість у позиції "
                    f"№{index + 1} "
                    "повинна бути більшою за нуль."
                ),
                400,
            )

        clean_items.append({
            "item_id": item_id,
            "quantity": quantity,
        })

    idempotency_key = str(
        data.get(
            "idempotency_key"
        )
        or ""
    ).strip()

    if not idempotency_key:
        return fail(
            "idempotency_key required",
            400,
        )

    note = str(
        data.get("note")
        or ""
    ).strip()

    try:
        rpc_result = (
            supabase
            .rpc(
                "receive_stock_purchase",
                {
                    "p_org_id":
                        current_org,

                    "p_purchase_id":
                        clean_purchase_id,

                    "p_user_id":
                        str(
                            user.get("id")
                        ),

                    "p_idempotency_key":
                        idempotency_key,

                    "p_items":
                        clean_items,

                    "p_note":
                        note or None,
                },
            )
            .execute()
        )

        rpc_data = (
            rpc_result.data
        )

        if isinstance(
            rpc_data,
            list,
        ):
            rpc_data = (
                rpc_data[0]
                if rpc_data
                else None
            )

        if not isinstance(
            rpc_data,
            dict,
        ):
            return fail(
                (
                    "Сервер не повернув "
                    "результат приймання."
                ),
                500,
            )

        purchase_result = (
            supabase
            .table(
                "stock_purchases"
            )
            .select(
                (
                    "*, "
                    "suppliers("
                    "id, name, phone, email"
                    "), "
                    "stock_purchase_items("
                    "*"
                    ")"
                )
            )
            .eq(
                "org_id",
                current_org,
            )
            .eq(
                "id",
                clean_purchase_id,
            )
            .limit(1)
            .execute()
        )

        purchase = (
            purchase_result.data[0]
            if purchase_result.data
            else None
        )

        return ok({
            "receipt":
                rpc_data,

            "purchase":
                purchase,
        })

    except Exception as error:
        print(
            "❌ RECEIVE PURCHASE:",
            repr(error),
            flush=True,
        )

        message = str(
            error
        )

        readable_errors = {
            "Purchase not found":
                "Закупівлю не знайдено.",

            "Cancelled purchase cannot be received":
                (
                    "Скасовану закупівлю "
                    "не можна прийняти."
                ),

            "Purchase is already fully received":
                (
                    "Закупівлю вже повністю "
                    "прийнято."
                ),

            "Receipt quantity must be greater than zero":
                (
                    "Кількість повинна бути "
                    "більшою за нуль."
                ),
        }

        for marker, readable in (
            readable_errors.items()
        ):
            if marker in message:
                return fail(
                    readable,
                    409,
                )

        if (
            "Remaining quantity"
            in message
            or "already fully received"
            in message
        ):
            return fail(
                (
                    "Вказана кількість перевищує "
                    "залишок до приймання."
                ),
                409,
            )

        if (
            "is not linked to stock"
            in message
        ):
            return fail(
                (
                    "Одна з позицій закупівлі "
                    "не прив’язана до складу."
                ),
                409,
            )

        return fail(
            (
                "Не вдалося прийняти "
                "поставку."
            ),
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

import re


def normalize_ua_phone(value):
    digits = re.sub(
        r"\D",
        "",
        str(value or ""),
    )

    if digits.startswith("0"):
        digits = "38" + digits

    if (
        len(digits) == 9
        and not digits.startswith("380")
    ):
        digits = "380" + digits

    if (
        len(digits) != 12
        or not digits.startswith("380")
    ):
        return None

    return (
        f"+{digits[:3]} "
        f"{digits[3:5]} "
        f"{digits[5:8]} "
        f"{digits[8:10]} "
        f"{digits[10:12]}"
    )
@app.post("/api/owners")
def api_create_owner():
    _user, auth_error = auth_required()

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

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        name = str(
            data.get("name")
            or ""
        ).strip()

        if not name:
            return fail(
                "Вкажіть ПІБ власника",
                400,
            )

        phone = normalize_ua_phone(
            data.get("phone")
        )

        if not phone:
            return fail(
                (
                    "Телефон повинен містити "
                    "рівно 12 цифр у форматі "
                    "+380 XX XXX XX XX"
                ),
                400,
            )

        existing_owner_result = (
            execute_with_retry(
                lambda: (
                    supabase
                    .table("owners")
                    .select(
                        (
                            "id, name, phone, "
                            "email, telegram, note"
                        )
                    )
                    .eq(
                        "org_id",
                        current_org,
                    )
                    .eq(
                        "phone",
                        phone,
                    )
                    .limit(1)
                ),
                attempts=3,
                delay=0.25,
            )
        )

        if existing_owner_result.data:
            existing_owner = (
                existing_owner_result
                .data[0]
            )

            return jsonify({
                "ok": False,
                "error":
                    "OWNER_PHONE_EXISTS",
                "message": (
                    "Власник із таким номером "
                    "вже є в базі."
                ),
                "data": {
                    "owner":
                        existing_owner,
                },
            }), 409

        email = str(
            data.get("email")
            or ""
        ).strip().lower()

        telegram = str(
            data.get("telegram")
            or ""
        ).strip()

        if email:
            email_pattern = (
                r"^[^\s@]+@[^\s@]+\.[^\s@]+$"
            )

            if not re.match(
                email_pattern,
                email,
            ):
                return fail(
                    (
                        "Вкажіть коректну "
                        "електронну адресу"
                    ),
                    400,
                )

        if telegram:
            telegram = telegram.replace(
                "https://t.me/",
                "",
            )

            telegram = telegram.replace(
                "http://t.me/",
                "",
            )

            telegram = (
                telegram.strip()
            )

            if telegram.startswith("@"):
                telegram = (
                    telegram[1:]
                )

            telegram = re.sub(
                r"[^a-zA-Z0-9_]",
                "",
                telegram,
            )

            if (
                len(telegram) < 5
                or len(telegram) > 32
            ):
                return fail(
                    (
                        "Telegram username "
                        "повинен містити від "
                        "5 до 32 символів"
                    ),
                    400,
                )

            telegram = (
                f"@{telegram}"
            )

        payload = {
            "org_id":
                current_org,

            "name":
                name,

            "phone":
                phone,

            "note":
                str(
                    data.get("note")
                    or ""
                ).strip()
                or None,

            "email":
                email
                or None,

            "telegram":
                telegram
                or None,
        }

        result = (
            supabase
            .table("owners")
            .insert(payload)
            .execute()
        )

        if not result.data:
            return fail(
                (
                    "Не вдалося створити "
                    "власника"
                ),
                500,
            )

        return ok(
            result.data[0]
        )

    except Exception as error:
        print(
            (
                "❌ POST "
                "/api/owners error:"
            ),
            repr(error),
        )

        return fail(
            (
                "Cannot create owner: "
                f"{error}"
            ),
            500,
        )


@app.put("/api/owners/<owner_id>")
def api_update_owner(owner_id):
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

        phone = normalize_ua_phone(
            data.get("phone")
        )

        if not phone:
            return fail(
                "Телефон повинен бути у форматі +380 XX XXX XX XX",
                400,
            )

        update_payload = {
            "name": name,
            "phone": phone,
            "note": str(
                data.get("note") or ""
            ).strip() or None,
        }

        result = (
            supabase
            .table("owners")
            .update(
                update_payload
            )
            .eq(
                "id",
                owner_id
            )
            .eq(
                "org_id",
                current_org
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Власника не знайдено",
                404,
            )

        return ok(
            result.data[0]
        )

    except Exception as e:
        print(
            "api_update_owner error:",
            e
        )

        return fail(
            str(e),
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

        staff_id = str(
            user.get("staff_id")
            or ""
        ).strip()

        if (
            role not in {
                "owner",
                "admin",
            }
            and not staff_id
        ):
            return ok([])

        def build_staff_query():
            query = (
                supabase
                .table("staff")
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "is_active",
                    True,
                )
            )

            if role not in {
                "owner",
                "admin",
            }:
                query = query.eq(
                    "id",
                    staff_id,
                )

            return query.order(
                "name"
            )

        result = execute_with_retry(
            build_staff_query,
            attempts=3,
            delay=0.25,
        )

        rows = (
            result.data
            or []
        )

        try:
            specializations_result = (
                execute_with_retry(
                    lambda: (
                        supabase
                        .table(
                            "specializations"
                        )
                        .select(
                            "id,name,color"
                        )
                        .eq(
                            "org_id",
                            current_org,
                        )
                        .eq(
                            "is_active",
                            True,
                        )
                        .order(
                            "name"
                        )
                    ),
                    attempts=3,
                    delay=0.25,
                )
            )

            specializations_rows = (
                specializations_result.data
                or []
            )

        except Exception as error:
            print(
                "⚠️ /api/staff specializations fallback:",
                repr(error),
            )

            specializations_rows = []

        specializations_by_id = {
            str(
                item.get("id")
            ): item
            for item in specializations_rows
            if item.get("id")
        }

        for row in rows:
            ids = row.get(
                "specialization_ids"
            )

            if not isinstance(
                ids,
                list,
            ):
                ids = []

            clean_ids = []
            linked = []

            for item in ids:
                item_id = str(
                    item or ""
                ).strip()

                if (
                    not item_id
                    or item_id in clean_ids
                ):
                    continue

                specialization = (
                    specializations_by_id.get(
                        item_id
                    )
                )

                if not specialization:
                    continue

                clean_ids.append(
                    item_id
                )

                linked.append(
                    specialization
                )

            row[
                "specialization_ids"
            ] = clean_ids

            row[
                "specializations"
            ] = linked

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
    "org_id":
        current_org,

    "name":
        name,

    "role":
        d.get("role")
        or "vet",

    "avatar":
        d.get("avatar"),

    "color":
        d.get("color")
        or "#7C5CFF",

    "phone":
        str(
            d.get("phone")
            or ""
        ).strip()
        or None,

    "specialization":
        d.get("specialization"),

    "shift_rate":
        d.get("shift_rate")
        or 0,

    "percent_rate":
        d.get("percent_rate")
        or 0,

    "bonus_rate":
        d.get("bonus_rate")
        or 0,

    "note":
        str(
            d.get("note")
            or ""
        ).strip()
        or None,

    "emergency_contact_name":
        str(
            d.get(
                "emergency_contact_name"
            )
            or ""
        ).strip()
        or None,

    "emergency_contact_phone":
        str(
            d.get(
                "emergency_contact_phone"
            )
            or ""
        ).strip()
        or None,

    "emergency_contact_relation":
        str(
            d.get(
                "emergency_contact_relation"
            )
            or ""
        ).strip()
        or None,

    "is_active":
        True,
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

    d = (
        request.get_json(
            silent=True
        )
        or {}
    )

    current_org = (
        get_current_org_id()
    )

    payload = {
        "name":
            d.get("name"),

        "role":
            d.get("role"),

        "avatar":
            d.get("avatar"),

        "color":
            d.get("color"),

        "phone":
            d.get("phone"),

        "specialization":
            d.get(
                "specialization"
            ),

        "shift_rate":
            d.get("shift_rate"),

        "percent_rate":
            d.get(
                "percent_rate"
            ),

        "bonus_rate":
            d.get("bonus_rate"),

        "note":
            d.get("note"),

        "is_active":
            d.get("is_active"),

        "skills":
            d.get("skills"),

        "emergency_contact_name":
            d.get(
                "emergency_contact_name"
            ),

        "emergency_contact_phone":
            d.get(
                "emergency_contact_phone"
            ),

        "emergency_contact_relation":
            d.get(
                "emergency_contact_relation"
            ),
    }

    if "specialization_ids" in d:
        try:
            payload[
                "specialization_ids"
            ] = (
                validate_staff_specialization_ids(
                    d.get(
                        "specialization_ids"
                    ),
                    current_org,
                )
            )
        except ValueError as error:
            return fail(
                str(error),
                400,
            )

    text_fields = [
        "name",
        "phone",
        "specialization",
        "note",
        "emergency_contact_name",
        "emergency_contact_phone",
        "emergency_contact_relation",
    ]

    for field in text_fields:
        if field not in d:
            continue

        value = payload.get(
            field
        )

        if isinstance(
            value,
            str,
        ):
            value = (
                value.strip()
            )

        payload[field] = (
            value
            if value != ""
            else None
        )

    payload = {
        key: value
        for key, value
        in payload.items()
        if (
            key in d
            or key ==
                "specialization_ids"
        )
    }

    if not payload:
        return fail(
            "Nothing to update",
            400,
        )

    res = (
        supabase
        .table("staff")
        .update(payload)
        .eq(
            "org_id",
            current_org
        )
        .eq(
            "id",
            staff_id
        )
        .execute()
    )

    row = (
        res.data[0]
        if getattr(
            res,
            "data",
            None,
        )
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

# =====================================================
# APPOINTMENT TEMPLATES
# =====================================================

DEFAULT_APPOINTMENT_TEMPLATES = [
    {
        "name": "Огляд",
        "duration_min": 45,
        "icon": "🩺",
        "color": "#3B82F6",
        "sort_order": 10,
    },
    {
        "name": "УЗД",
        "duration_min": 15,
        "icon": "📡",
        "color": "#06B6D4",
        "sort_order": 20,
    },
    {
        "name": "Маніпуляційний візит",
        "duration_min": 15,
        "icon": "💉",
        "color": "#10B981",
        "sort_order": 30,
    },
    {
        "name": "Кастрація",
        "duration_min": 60,
        "icon": "✂️",
        "color": "#F59E0B",
        "sort_order": 40,
    },
    {
        "name": "Базова хірургія",
        "duration_min": 120,
        "icon": "🏥",
        "color": "#EF4444",
        "sort_order": 50,
    },
]


def normalize_appointment_template_payload(
    data,
    *,
    partial=False,
):
    source = (
        data
        if isinstance(data, dict)
        else {}
    )

    payload = {}

    if (
        not partial
        or "name" in source
    ):
        name = str(
            source.get("name")
            or ""
        ).strip()

        if not name:
            raise ValueError(
                "Вкажіть назву шаблону."
            )

        if len(name) > 100:
            raise ValueError(
                "Назва шаблону занадто довга."
            )

        payload["name"] = name

    if (
        not partial
        or "duration_min" in source
    ):
        try:
            duration_min = int(
                source.get(
                    "duration_min"
                )
                or 30
            )
        except (
            TypeError,
            ValueError,
        ):
            raise ValueError(
                "Некоректна тривалість."
            )

        if (
            duration_min < 5
            or duration_min > 480
        ):
            raise ValueError(
                "Тривалість має бути від 5 до 480 хвилин."
            )

        payload[
            "duration_min"
        ] = duration_min

    if (
        not partial
        or "icon" in source
    ):
        icon = str(
            source.get("icon")
            or "📅"
        ).strip()[:12]

        payload["icon"] = (
            icon or "📅"
        )

    if (
        not partial
        or "color" in source
    ):
        color = str(
            source.get("color")
            or "#7C5CFF"
        ).strip().upper()

        if not re.fullmatch(
            r"#[0-9A-F]{6}",
            color,
        ):
            raise ValueError(
                "Некоректний колір."
            )

        payload["color"] = color

    if (
        not partial
        or "default_note" in source
    ):
        payload[
            "default_note"
        ] = (
            str(
                source.get(
                    "default_note"
                )
                or ""
            ).strip()[:500]
            or None
        )

    if "active" in source:
        payload["active"] = bool(
            source.get("active")
        )

    if (
        not partial
        or "sort_order" in source
    ):
        try:
            sort_order = int(
                source.get(
                    "sort_order"
                )
                or 100
            )
        except (
            TypeError,
            ValueError,
        ):
            sort_order = 100

        payload[
            "sort_order"
        ] = max(
            0,
            min(
                10000,
                sort_order,
            ),
        )

    return payload


def ensure_default_appointment_templates(
    current_org,
):
    result = execute_with_retry(
        lambda: (
            supabase
            .table(
                "appointment_templates"
            )
            .select(
                "id"
            )
            .eq(
                "org_id",
                current_org,
            )
            .limit(1)
        ),
        attempts=3,
        delay=0.25,
    )

    if result.data:
        return

    rows = [
        {
            **template,
            "org_id":
                current_org,
            "active":
                True,
        }
        for template
        in DEFAULT_APPOINTMENT_TEMPLATES
    ]

    execute_with_retry(
        lambda: (
            supabase
            .table(
                "appointment_templates"
            )
            .insert(rows)
        ),
        attempts=3,
        delay=0.25,
    )


@app.get(
    "/api/appointment-templates"
)
def api_get_appointment_templates():
    user, auth_error = (
        auth_required()
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

    try:
        ensure_default_appointment_templates(
            current_org
        )

        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "appointment_templates"
                )
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .order(
                    "sort_order"
                )
                .order(
                    "name"
                )
            ),
            attempts=4,
            delay=0.3,
        )

        return ok(
            result.data or []
        )

    except Exception as error:
        print(
            "❌ GET appointment templates:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити шаблони записів.",
            500,
        )


@app.post(
    "/api/appointment-templates"
)
def api_create_appointment_template():
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    try:
        payload = (
            normalize_appointment_template_payload(
                data
            )
        )

        payload["org_id"] = (
            current_org
        )

        payload["updated_at"] = (
            datetime
            .now(
                timezone.utc
            )
            .isoformat()
        )

        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "appointment_templates"
                )
                .insert(payload)
            ),
            attempts=3,
            delay=0.25,
        )

        if not result.data:
            return fail(
                "Не вдалося створити шаблон.",
                500,
            )

        return ok(
            result.data[0]
        )

    except ValueError as error:
        return fail(
            str(error),
            400,
        )

    except Exception as error:
        message = str(
            error
        ).lower()

        if (
            "duplicate" in message
            or "unique" in message
        ):
            return fail(
                "Шаблон з такою назвою вже існує.",
                409,
            )

        print(
            "❌ POST appointment template:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося створити шаблон.",
            500,
        )


@app.put(
    "/api/appointment-templates/<template_id>"
)
def api_update_appointment_template(
    template_id
):
    user, auth_error = (
        owner_or_admin_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    try:
        payload = (
            normalize_appointment_template_payload(
                data,
                partial=True,
            )
        )

        if not payload:
            return fail(
                "Немає змін для збереження.",
                400,
            )

        payload["updated_at"] = (
            datetime
            .now(
                timezone.utc
            )
            .isoformat()
        )

        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "appointment_templates"
                )
                .update(payload)
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "id",
                    template_id,
                )
            ),
            attempts=3,
            delay=0.25,
        )

        if not result.data:
            return fail(
                "Шаблон не знайдено.",
                404,
            )

        return ok(
            result.data[0]
        )

    except ValueError as error:
        return fail(
            str(error),
            400,
        )

    except Exception as error:
        print(
            "❌ PUT appointment template:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося оновити шаблон.",
            500,
        )


@app.delete(
    "/api/appointment-templates/<template_id>"
)
def api_delete_appointment_template(
    template_id
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
        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "appointment_templates"
                )
                .delete()
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "id",
                    template_id,
                )
            ),
            attempts=3,
            delay=0.25,
        )

        if not result.data:
            return fail(
                "Шаблон не знайдено.",
                404,
            )

        return ok(True)

    except Exception as error:
        print(
            "❌ DELETE appointment template:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося видалити шаблон.",
            500,
        )
    
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

    title = str(
        d.get("title") or ""
    ).strip()

    event_date = str(
        d.get("event_date") or ""
    ).strip()

    start_time = str(
        d.get("start_time") or ""
    ).strip()[:5]

    end_time = str(
        d.get("end_time") or ""
    ).strip()[:5]

    staff_id = d.get(
        "staff_id"
    )

    allow_overlap = bool(
        d.get("allow_overlap")
    )

    if not can_manage_calendar_staff(
        user,
        staff_id,
    ):
        return fail(
            "You can create calendar events only for yourself",
            403,
        )

    if (
        not title
        or not event_date
        or not start_time
        or not end_time
        or not staff_id
    ):
        return fail(
            "missing required fields",
            400,
        )

    if start_time >= end_time:
        return fail(
            "end_time must be later than start_time",
            400,
        )

    current_org = (
        get_current_org_id()
    )
    patient_id = str(
        d.get("patient_id")
        or ""
    ).strip()


    if patient_id:
        try:
            patient_result = (
                execute_with_retry(
                    lambda: (
                        supabase
                        .table(
                            "patients"
                        )
                        .select(
                            "id, name, "
                            "patient_status, "
                            "deceased_at"
                        )
                        .eq(
                            "org_id",
                            current_org,
                        )
                        .eq(
                            "id",
                            patient_id,
                        )
                        .limit(1)
                    ),
                    attempts=3,
                    delay=0.25,
                )
            )


            if (
                not patient_result.data
            ):
                return fail(
                    "Пацієнта не знайдено.",
                    404,
                )


            patient =
                patient_result.data[0]


            if (
                str(
                    patient.get(
                        "patient_status"
                    )
                    or "active"
                ).strip().lower()
                ==
                "deceased"
            ):
                return fail(
                    "Неможливо створити запис: "
                    "пацієнт позначений як померлий.",
                    409,
                )


        except Exception as error:
            print(
                "❌ CALENDAR PATIENT STATUS CHECK:",
                repr(error),
                flush=True,
            )

            return fail(
                "Не вдалося перевірити статус пацієнта.",
                500,
            )
    existing = (
        supabase
        .table("calendar_events")
        .select("*")
        .eq(
            "org_id",
            current_org,
        )
        .eq(
            "staff_id",
            staff_id,
        )
        .eq(
            "event_date",
            event_date,
        )
        .execute()
    )

    for ev in existing.data or []:
        ev_start = str(
            ev.get("start_time") or ""
        )[:5]

        ev_end = str(
            ev.get("end_time") or ""
        )[:5]

        is_overlap = (
            start_time < ev_end
            and end_time > ev_start
        )

        if (
            is_overlap
            and not allow_overlap
        ):
            return fail(
                "time slot busy",
                409,
            )

    payload = {
        "org_id":
            current_org,

        "event_type":
            d.get("event_type")
            or "appointment",

        "title":
            title,

        "event_date":
            event_date,

        "start_time":
            start_time,

        "end_time":
            end_time,

        "staff_id":
            staff_id,

        "patient_id":
            d.get("patient_id"),

        "owner_id":
            d.get("owner_id"),

        "visit_id":
            d.get("visit_id"),

        "location":
            d.get("location"),

        "status":
            d.get("status")
            or "planned",

        "note":
            d.get("note"),
    }

    result = (
        supabase
        .table("calendar_events")
        .insert(payload)
        .execute()
    )

    row = (
        result.data[0]
        if getattr(
            result,
            "data",
            None,
        )
        else payload
    )

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
    "title": data.get(
        "title"
    ),

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

    "patient_id": data.get(
        "patient_id"
    ),

    "owner_id": data.get(
        "owner_id"
    ),

    "visit_id": data.get(
        "visit_id"
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
    attempts=5,
    delay=0.35,
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
    try:
        current_org = (
            get_current_org_id()
        )

        if not current_org:
            return fail(
                "Organization not selected",
                400,
            )

        date_from = str(
            request.args.get("from")
            or ""
        ).strip()

        date_to = str(
            request.args.get("to")
            or ""
        ).strip()

        if (
            not date_from
            or not date_to
        ):
            return fail(
                "from and to required",
                400,
            )

        result = execute_with_retry(
            lambda: (
                supabase
                .table("staff_schedule")
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .gte(
                    "work_date",
                    date_from,
                )
                .lte(
                    "work_date",
                    date_to,
                )
                .order(
                    "work_date"
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
            "❌ GET /api/staff-schedule-range:",
            repr(error),
            flush=True,
        )

        return fail(
            "Cannot load staff schedule range",
            500,
        )

@app.post("/api/staff-schedule")
def api_upsert_staff_schedule():
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

    work_date = str(
        data.get("work_date")
        or ""
    ).strip()

    staff_id = str(
        data.get("staff_id")
        or ""
    ).strip()

    if (
        not work_date
        or not staff_id
    ):
        return fail(
            "work_date and staff_id required",
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
        datetime.strptime(
            work_date,
            "%Y-%m-%d",
        )
    except ValueError:
        return fail(
            "Invalid work_date",
            400,
        )

    start_time = str(
        data.get("start_time")
        or "09:00"
    ).strip()

    end_time = str(
        data.get("end_time")
        or "18:00"
    ).strip()

    try:
        datetime.strptime(
            start_time,
            "%H:%M",
        )

        datetime.strptime(
            end_time,
            "%H:%M",
        )

    except ValueError:
        return fail(
            "Invalid schedule time",
            400,
        )

    payload = {
        "org_id":
            current_org,

        "work_date":
            work_date,

        "staff_id":
            staff_id,

        "is_active":
            data.get(
                "is_active",
                True,
            )
            is not False,

        "start_time":
            start_time,

        "end_time":
            end_time,
    }

    try:
        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "staff_schedule"
                )
                .upsert(
                    payload,
                    on_conflict=(
                        "work_date,staff_id"
                    ),
                )
            ),
            attempts=5,
            delay=0.4,
        )

        row = (
            result.data[0]
            if getattr(
                result,
                "data",
                None,
            )
            else payload
        )

        return ok(row)

    except Exception as error:
        error_text = str(
            error or ""
        )

        error_lower = (
            error_text.lower()
        )

        print(
            "❌ POST /api/staff-schedule:",
            repr(error),
            flush=True,
        )

        temporary_error = any(
            marker in error_lower
            for marker in (
                "resource temporarily unavailable",
                "errno 11",
                "temporarily unavailable",
                "connection reset",
                "connection aborted",
                "connection refused",
                "network is unreachable",
                "try again",
                "timed out",
                "timeout",
                "server disconnected",
            )
        )

        if temporary_error:
            return fail(
                (
                    "Сервер тимчасово не відповідає. "
                    "Спробуйте ще раз."
                ),
                503,
            )

        return fail(
            "Не вдалося зберегти графік.",
            500,
        )
    
    

@app.delete("/api/staff-schedule")
def api_delete_staff_schedule():
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

    work_date = str(
        data.get("work_date")
        or ""
    ).strip()

    staff_id = str(
        data.get("staff_id")
        or ""
    ).strip()

    if (
        not work_date
        or not staff_id
    ):
        return fail(
            "work_date and staff_id required",
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
        execute_with_retry(
            lambda: (
                supabase
                .table(
                    "staff_schedule"
                )
                .delete()
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "work_date",
                    work_date,
                )
                .eq(
                    "staff_id",
                    staff_id,
                )
            ),
            attempts=5,
            delay=0.4,
        )

        return ok(True)

    except Exception as error:
        print(
            "❌ DELETE /api/staff-schedule:",
            repr(error),
            flush=True,
        )

        error_lower = str(
            error or ""
        ).lower()

        temporary_error = any(
            marker in error_lower
            for marker in (
                "resource temporarily unavailable",
                "errno 11",
                "temporarily unavailable",
                "connection reset",
                "connection aborted",
                "connection refused",
                "try again",
                "timed out",
                "timeout",
                "server disconnected",
            )
        )

        if temporary_error:
            return fail(
                (
                    "Сервер тимчасово не відповідає. "
                    "Спробуйте ще раз."
                ),
                503,
            )

        return fail(
            "Не вдалося видалити зміну.",
            500,
        )


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

        def build_query():
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

            return query

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


    # =====================================================
    # VACCINATION STATUSES
    # =====================================================

    allowed_vaccination_statuses = {
        "unknown",
        "vaccinated",
        "not_vaccinated",
    }


    rabies_status = str(
        data.get(
            "rabies_status"
        )
        or "unknown"
    ).strip().lower()


    general_vaccination_status = str(
        data.get(
            "general_vaccination_status"
        )
        or "unknown"
    ).strip().lower()


    if (
        rabies_status
        not in allowed_vaccination_statuses
    ):
        return fail(
            "Некоректний статус вакцинації від сказу.",
            400,
        )


    if (
        general_vaccination_status
        not in allowed_vaccination_statuses
    ):
        return fail(
            "Некоректний статус загальної вакцинації.",
            400,
        )


    try:
        owner_result = (
            supabase
            .table("owners")
            .select("id")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                owner_id
            )
            .limit(1)
            .execute()
        )

        if not owner_result.data:
            return fail(
                "Власника не знайдено у цій клініці.",
                404
            )


        payload = {
            "org_id":
                current_org,

            "owner_id":
                owner_id,

            "name":
                name,

            "species":
                (
                    str(
                        data.get("species")
                        or ""
                    ).strip()
                    or None
                ),

            "breed":
                (
                    str(
                        data.get("breed")
                        or ""
                    ).strip()
                    or None
                ),

            "age":
                (
                    str(
                        data.get("age")
                        or ""
                    ).strip()
                    or None
                ),

            "weight_kg":
                (
                    data.get(
                        "weight_kg"
                    )
                    if data.get(
                        "weight_kg"
                    ) not in (
                        "",
                        None,
                    )
                    else None
                ),

            "sex":
                (
                    str(
                        data.get("sex")
                        or ""
                    ).strip()
                    or None
                ),

            "neutered":
                (
                    data.get("neutered")
                    if isinstance(
                        data.get("neutered"),
                        bool,
                    )
                    else None
                ),


            # =================================================
            # NEW VACCINATION STATUS SYSTEM
            # =================================================

            "rabies_status":
                rabies_status,

            "general_vaccination_status":
                general_vaccination_status,


            # =================================================
            # LEGACY VACCINATION FIELDS
            # Пока оставляем для совместимости.
            # =================================================

            "vaccination_status":
                (
                    str(
                        data.get(
                            "vaccination_status"
                        )
                        or "unknown"
                    ).strip()
                ),

            "vaccination_date":
                (
                    str(
                        data.get(
                            "vaccination_date"
                        )
                        or ""
                    ).strip()
                    or None
                ),

            "vaccination_name":
                (
                    str(
                        data.get(
                            "vaccination_name"
                        )
                        or ""
                    ).strip()
                    or None
                ),

            "notes":
                (
                    str(
                        data.get("notes")
                        or data.get("note")
                        or ""
                    ).strip()
                    or None
                ),
        }


        result = (
            insert_with_optional_fallback(
                "patients",
                payload,
                optional_fields=[
                    "notes",
                    "sex",
                    "neutered",

                    "rabies_status",
                    "general_vaccination_status",

                    "vaccination_status",
                    "vaccination_date",
                    "vaccination_name",
                ]
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


        # =====================================================
        # LEGACY INITIAL VACCINATION MIGRATION
        #
        # Пока оставляем, чтобы старая форма регистрации
        # пациента продолжала работать до её замены.
        # =====================================================

        if (
            row
            and row.get("id")
            and payload.get(
                "vaccination_status"
            ) == "vaccinated"
            and payload.get(
                "vaccination_date"
            )
            and payload.get(
                "vaccination_name"
            )
        ):
            try:
                (
                    supabase
                    .table(
                        "patient_vaccinations"
                    )
                    .insert({
                        "org_id":
                            current_org,

                        "patient_id":
                            row.get("id"),

                        "vaccination_date":
                            payload.get(
                                "vaccination_date"
                            ),

                        "vaccine_name":
                            payload.get(
                                "vaccination_name"
                            ),

                        "vaccine_type":
                            None,

                        "coverage_tags":
                            [],

                        "batch_number":
                            None,

                        "next_vaccination_date":
                            None,

                        "source_visit_id":
                            None,

                        "note":
                            "Додано під час створення пацієнта",
                    })
                    .execute()
                )

            except Exception as vaccination_error:
                print(
                    "⚠️ INITIAL PATIENT VACCINATION:",
                    repr(
                        vaccination_error
                    ),
                    flush=True,
                )


        return ok(
            row
        )


    except Exception as error:
        print(
            "❌ POST /api/patients:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося створити пацієнта.",
            500
        )

@app.put("/api/patients")
@app.put("/api/patients/<pet_id>")
def api_update_patient(
    pet_id=None
):
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    pet_id = str(
    pet_id
    or request.args.get("id")
    or data.get("id")
    or ""
).strip()

    if not pet_id:
        return fail(
            "patient id required",
            400
        )

    current_org = (
        get_current_org_id()
    )

    allowed_fields = [
        "name",
        "species",
        "breed",
        "age",
        "weight_kg",
        "sex",
        "neutered",
        "vaccination_status",
        "vaccination_date",
        "vaccination_name",
        "notes",
    ]

    payload = {
        field: data.get(field)
        for field in allowed_fields
        if field in data
    }

    for field in [
        "name",
        "species",
        "breed",
        "age",
        "sex",
        "vaccination_status",
        "vaccination_date",
        "vaccination_name",
        "notes",
    ]:
        if field not in payload:
            continue

        value = payload.get(field)

        if isinstance(value, str):
            value = value.strip()

        payload[field] = (
            value
            if value not in (
                "",
                None,
            )
            else None
        )

    if "neutered" in payload:
        value = payload.get(
            "neutered"
        )

        payload["neutered"] = (
            value
            if isinstance(
                value,
                bool,
            )
            else None
        )

    if "weight_kg" in payload:
        value = payload.get(
            "weight_kg"
        )

        payload["weight_kg"] = (
            value
            if value not in (
                "",
                None,
            )
            else None
        )

    if (
        payload.get(
            "vaccination_status"
        )
        != "vaccinated"
    ):
        payload["vaccination_date"] = None
        payload["vaccination_name"] = None

    if not payload:
        return fail(
            "Nothing to update",
            400
        )

    try:
        result = (
            supabase
            .table("patients")
            .update(payload)
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                pet_id
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Пацієнта не знайдено.",
                404
            )

        return ok(
            result.data[0]
        )

    except Exception as error:
        print(
            "❌ PUT /api/patients:",
            repr(error)
        )

        return fail(
            "Не вдалося оновити пацієнта.",
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
# API: PATIENT WEIGHT HISTORY
# =========================
@app.get(
    "/api/patients/<patient_id>/vaccinations"
)
def api_get_patient_vaccinations(
    patient_id,
):
    user, auth_error = roles_required(
        "owner",
        "admin",
        "vet",
        "assistant",
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Організацію не визначено.",
            400,
        )

    try:
        result = execute_with_retry(
            lambda: (
                supabase
                .table(
                    "patient_vaccinations"
                )
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "patient_id",
                    patient_id,
                )
                .order(
                    "vaccination_date",
                    desc=True,
                )
            ),
            attempts=4,
            delay=0.25,
        )

        vaccinations = (
            result.data
            if (
                result
                and isinstance(
                    result.data,
                    list,
                )
            )
            else []
        )

        return ok(
            vaccinations
        )

    except Exception as error:
        print(
            "❌ GET patient vaccinations:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити вакцинації.",
            500,
        )

@app.post(
    "/api/patients/<patient_id>/vaccinations"
)
def api_create_patient_vaccination(
    patient_id,
):
    user, auth_error = roles_required(
        "owner",
        "admin",
        "vet",
    )

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    data = request.get_json(
        silent=True
    ) or {}

    vaccination_date = str(
        data.get("vaccination_date")
        or ""
    ).strip()

    vaccine_name = str(
        data.get("vaccine_name")
        or ""
    ).strip()

    vaccine_type = str(
        data.get("vaccine_type")
        or ""
    ).strip() or None

    batch_number = str(
        data.get("batch_number")
        or ""
    ).strip() or None

    next_vaccination_date = str(
        data.get("next_vaccination_date")
        or ""
    ).strip() or None

    source_visit_id = str(
        data.get("source_visit_id")
        or ""
    ).strip() or None

    note = str(
        data.get("note")
        or ""
    ).strip() or None


    raw_coverage_tags = (
        data.get("coverage_tags")
        or []
    )

    if not isinstance(
        raw_coverage_tags,
        list,
    ):
        return fail(
            "Некоректні теги вакцинації.",
            400,
        )


    allowed_coverage_tags = {
        "general",
        "rabies",
        "lepto",
        "respiratory",
        "felv",
        "lyme",
        "civ",
    }


    coverage_tags = []

    for item in raw_coverage_tags:
        tag = str(
            item or ""
        ).strip().lower()

        if (
            tag
            and tag
            in allowed_coverage_tags
            and tag
            not in coverage_tags
        ):
            coverage_tags.append(
                tag
            )


    if not vaccination_date:
        return fail(
            "Вкажіть дату вакцинації.",
            400,
        )

    if not vaccine_name:
        return fail(
            "Вкажіть назву вакцини.",
            400,
        )


    try:
        patient_result = (
            supabase
            .table("patients")
            .select("id")
            .eq("org_id", current_org)
            .eq("id", patient_id)
            .limit(1)
            .execute()
        )

        if not patient_result.data:
            return fail(
                "Пацієнта не знайдено.",
                404,
            )


        insert_data = {
            "org_id":
                current_org,

            "patient_id":
                patient_id,

            "vaccination_date":
                vaccination_date,

            "vaccine_name":
                vaccine_name,

            "vaccine_type":
                vaccine_type,

            "coverage_tags":
                coverage_tags,

            "batch_number":
                batch_number,

            "next_vaccination_date":
                next_vaccination_date,

            "source_visit_id":
                source_visit_id,

            "note":
                note,
        }


        result = (
            supabase
            .table(
                "patient_vaccinations"
            )
            .insert(
                insert_data
            )
            .execute()
        )


        if not result.data:
            return fail(
                "Не вдалося зберегти вакцинацію.",
                500,
            )


        return ok(
            result.data[0]
        )


    except Exception as error:
        print(
            "❌ POST patient vaccination:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося зберегти вакцинацію.",
            500,
        )
# =====================================================
# PATIENT VACCINATION STATUS SYNC
# =====================================================

def sync_patient_vaccination_statuses(
    patient_id,
):
    current_org = (
        get_current_org_id()
    )

    if (
        not current_org
        or not patient_id
    ):
        return


    try:
        vaccination_result = (
            supabase
            .table(
                "patient_vaccinations"
            )
            .select(
                "coverage_tags"
            )
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "patient_id",
                patient_id
            )
            .execute()
        )


        rows = (
            vaccination_result.data
            or []
        )


        has_rabies = False
        has_general = False


        for row in rows:
            tags = (
                row.get(
                    "coverage_tags"
                )
                or []
            )


            if not isinstance(
                tags,
                list,
            ):
                continue


            if (
                "rabies"
                in tags
            ):
                has_rabies = True


            if (
                "general"
                in tags
            ):
                has_general = True


        patient_result = (
            supabase
            .table(
                "patients"
            )
            .select(
                "id,"
                "rabies_status,"
                "general_vaccination_status"
            )
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                patient_id
            )
            .limit(1)
            .execute()
        )


        if not patient_result.data:
            return


        patient = (
            patient_result.data[0]
        )


        current_rabies_status = str(
            patient.get(
                "rabies_status"
            )
            or "unknown"
        ).strip().lower()


        current_general_status = str(
            patient.get(
                "general_vaccination_status"
            )
            or "unknown"
        ).strip().lower()


        if has_rabies:
            next_rabies_status = (
                "vaccinated"
            )
        elif (
            current_rabies_status
            == "vaccinated"
        ):
            next_rabies_status = (
                "unknown"
            )
        else:
            next_rabies_status = (
                current_rabies_status
            )


        if has_general:
            next_general_status = (
                "vaccinated"
            )
        elif (
            current_general_status
            == "vaccinated"
        ):
            next_general_status = (
                "unknown"
            )
        else:
            next_general_status = (
                current_general_status
            )


        (
            supabase
            .table(
                "patients"
            )
            .update({
                "rabies_status":
                    next_rabies_status,

                "general_vaccination_status":
                    next_general_status,
            })
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                patient_id
            )
            .execute()
        )


    except Exception as error:
        print(
            "⚠️ SYNC PATIENT VACCINATION STATUS:",
            repr(
                error
            ),
            flush=True,
        )


# =====================================================
# UPDATE PATIENT VACCINATION
# =====================================================

@app.put(
    "/api/patient-vaccinations/<vaccination_id>"
)
def api_update_patient_vaccination(
    vaccination_id,
):
    user, auth_error = roles_required(
        "owner",
        "admin",
        "vet",
    )

    if auth_error:
        return auth_error


    current_org = (
        get_current_org_id()
    )


    data = (
        request.get_json(
            silent=True
        )
        or {}
    )


    try:
        existing_result = (
            supabase
            .table(
                "patient_vaccinations"
            )
            .select("*")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                vaccination_id
            )
            .limit(1)
            .execute()
        )


        if not existing_result.data:
            return fail(
                "Вакцинацію не знайдено.",
                404,
            )


        existing = (
            existing_result.data[0]
        )


        patient_id = str(
            existing.get(
                "patient_id"
            )
            or ""
        ).strip()


        vaccination_date = str(
            data.get(
                "vaccination_date",
                existing.get(
                    "vaccination_date"
                ),
            )
            or ""
        ).strip()


        vaccine_name = str(
            data.get(
                "vaccine_name",
                existing.get(
                    "vaccine_name"
                ),
            )
            or ""
        ).strip()


        vaccine_type = str(
            data.get(
                "vaccine_type",
                existing.get(
                    "vaccine_type"
                ),
            )
            or ""
        ).strip() or None


        batch_number = str(
            data.get(
                "batch_number",
                existing.get(
                    "batch_number"
                ),
            )
            or ""
        ).strip() or None


        next_vaccination_date = str(
            data.get(
                "next_vaccination_date",
                existing.get(
                    "next_vaccination_date"
                ),
            )
            or ""
        ).strip() or None


        note = str(
            data.get(
                "note",
                existing.get(
                    "note"
                ),
            )
            or ""
        ).strip() or None


        raw_coverage_tags = (
            data.get(
                "coverage_tags",
                existing.get(
                    "coverage_tags"
                )
                or [],
            )
            or []
        )


        if not isinstance(
            raw_coverage_tags,
            list,
        ):
            return fail(
                "Некоректні теги вакцинації.",
                400,
            )


        allowed_coverage_tags = {
            "general",
            "rabies",
            "lepto",
            "respiratory",
            "felv",
            "lyme",
            "civ",
        }


        coverage_tags = []


        for item in raw_coverage_tags:
            tag = str(
                item or ""
            ).strip().lower()


            if (
                tag
                and tag
                in allowed_coverage_tags
                and tag
                not in coverage_tags
            ):
                coverage_tags.append(
                    tag
                )


        if not vaccination_date:
            return fail(
                "Вкажіть дату вакцинації.",
                400,
            )


        if not vaccine_name:
            return fail(
                "Вкажіть назву вакцини.",
                400,
            )


        update_data = {
            "vaccination_date":
                vaccination_date,

            "vaccine_name":
                vaccine_name,

            "vaccine_type":
                vaccine_type,

            "coverage_tags":
                coverage_tags,

            "batch_number":
                batch_number,

            "next_vaccination_date":
                next_vaccination_date,

            "note":
                note,
        }


        result = (
            supabase
            .table(
                "patient_vaccinations"
            )
            .update(
                update_data
            )
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                vaccination_id
            )
            .execute()
        )


        if not result.data:
            return fail(
                "Не вдалося оновити вакцинацію.",
                500,
            )


        sync_patient_vaccination_statuses(
            patient_id
        )


        return ok(
            result.data[0]
        )


    except Exception as error:
        print(
            "❌ PUT patient vaccination:",
            repr(
                error
            ),
            flush=True,
        )


        return fail(
            "Не вдалося оновити вакцинацію.",
            500,
        )


# =====================================================
# DELETE PATIENT VACCINATION
# =====================================================

@app.delete(
    "/api/patient-vaccinations/<vaccination_id>"
)
def api_delete_patient_vaccination(
    vaccination_id,
):
    user, auth_error = roles_required(
        "owner",
        "admin",
        "vet",
    )

    if auth_error:
        return auth_error


    current_org = (
        get_current_org_id()
    )


    try:
        existing_result = (
            supabase
            .table(
                "patient_vaccinations"
            )
            .select(
                "id,"
                "patient_id,"
                "vaccine_name"
            )
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                vaccination_id
            )
            .limit(1)
            .execute()
        )


        if not existing_result.data:
            return fail(
                "Вакцинацію не знайдено.",
                404,
            )


        existing = (
            existing_result.data[0]
        )


        patient_id = str(
            existing.get(
                "patient_id"
            )
            or ""
        ).strip()


        result = (
            supabase
            .table(
                "patient_vaccinations"
            )
            .delete()
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                vaccination_id
            )
            .execute()
        )


        if not result.data:
            return fail(
                "Не вдалося видалити вакцинацію.",
                500,
            )


        sync_patient_vaccination_statuses(
            patient_id
        )


        return ok(
            True
        )


    except Exception as error:
        print(
            "❌ DELETE patient vaccination:",
            repr(
                error
            ),
            flush=True,
        )


        return fail(
            "Не вдалося видалити вакцинацію.",
            500,
        )
           
@app.get(
    "/api/patients/<patient_id>/weights"
)
def api_get_patient_weights(
    patient_id,
):
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    if not current_org:
        return fail(
            "Організацію не визначено.",
            400,
        )

    try:
        patient_result = (
            execute_with_retry(
                lambda: (
                    supabase
                    .table(
                        "patients"
                    )
                    .select("id")
                    .eq(
                        "org_id",
                        current_org
                    )
                    .eq(
                        "id",
                        patient_id
                    )
                    .limit(1)
                ),
                attempts=4,
                delay=0.25,
            )
        )

        if not patient_result.data:
            return fail(
                "Пацієнта не знайдено.",
                404,
            )

        result = (
            execute_with_retry(
                lambda: (
                    supabase
                    .table(
                        "patient_weight_history"
                    )
                    .select("*")
                    .eq(
                        "org_id",
                        current_org
                    )
                    .eq(
                        "patient_id",
                        patient_id
                    )
                    .order(
                        "measured_at",
                        desc=True,
                    )
                ),
                attempts=4,
                delay=0.25,
            )
        )

        return ok(
            result.data or []
        )

    except Exception as error:
        print(
            "❌ GET patient weights:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити історію ваги.",
            500,
        )


@app.post(
    "/api/patients/<patient_id>/weights"
)
def api_create_patient_weight(
    patient_id,
):
    user, auth_error = roles_required(
        "owner",
        "admin",
        "vet",
    )

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    data = request.get_json(
        silent=True
    ) or {}

    try:
        weight_kg = float(
            data.get("weight_kg")
        )
    except (
        TypeError,
        ValueError,
    ):
        return fail(
            "Вкажіть коректну вагу.",
            400,
        )

    if (
        weight_kg <= 0
        or weight_kg > 500
    ):
        return fail(
            "Некоректна вага пацієнта.",
            400,
        )

    measured_at = str(
        data.get("measured_at")
        or ""
    ).strip()

    if not measured_at:
        measured_at = (
            datetime.now(
                timezone.utc
            ).isoformat()
        )

    source = str(
        data.get("source")
        or "manual"
    ).strip()

    source_visit_id = str(
        data.get("source_visit_id")
        or ""
    ).strip() or None

    note = str(
        data.get("note")
        or ""
    ).strip() or None

    try:
        patient_result = (
            supabase
            .table("patients")
            .select("id")
            .eq("org_id", current_org)
            .eq("id", patient_id)
            .limit(1)
            .execute()
        )

        if not patient_result.data:
            return fail(
                "Пацієнта не знайдено.",
                404,
            )

        payload = {
            "org_id":
                current_org,

            "patient_id":
                patient_id,

            "weight_kg":
                weight_kg,

            "measured_at":
                measured_at,

            "source":
                source,

            "source_visit_id":
                source_visit_id,

            "note":
                note,

            "created_by":
                user.get("id"),
        }

        result = (
            supabase
            .table(
                "patient_weight_history"
            )
            .insert(
                clean_payload(
                    payload
                )
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Не вдалося зберегти вагу.",
                500,
            )

        (
            supabase
            .table("patients")
            .update({
                "weight_kg":
                    weight_kg,
            })
            .eq("org_id", current_org)
            .eq("id", patient_id)
            .execute()
        )

        return ok(
            result.data[0]
        )

    except Exception as error:
        print(
            "❌ POST patient weight:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося зберегти вагу пацієнта.",
            500,
        )
# =========================
# API: PATIENT DIAGNOSES
# =========================

DIAGNOSIS_CERTAINTIES = {
    "provisional",
    "confirmed",
}

DIAGNOSIS_SEVERITIES = {
    "mild",
    "moderate",
    "severe",
    "critical",
}

DIAGNOSIS_STATUSES = {
    "active",
    "remission",
    "resolved",
    "entered_in_error",
}

DIAGNOSIS_STATUS_TRANSITIONS = {
    "active": {
        "remission",
        "resolved",
        "entered_in_error",
    },
    "remission": {
        "active",
        "resolved",
        "entered_in_error",
    },
    "resolved": {
        "active",
        "entered_in_error",
    },
    "entered_in_error": set(),
}


def normalize_diagnosis_text(
    value,
    *,
    max_length,
    required=False,
):
    if value is None:
        return None

    normalized = str(value).strip()

    if required and not normalized:
        raise ValueError(
            "diagnosis_name required"
        )

    if not normalized:
        return None

    if len(normalized) > max_length:
        raise ValueError(
            "Diagnosis field is too long"
        )

    return normalized


def load_patient_for_diagnosis(
    org_id,
    patient_id,
):
    result = execute_with_retry(
        lambda: (
            supabase
            .table("patients")
            .select("id, name")
            .eq("org_id", org_id)
            .eq("id", patient_id)
            .limit(1)
        ),
        attempts=3,
        delay=0.25,
    )

    if not result.data:
        return None

    return result.data[0]


def validate_diagnosis_source_visit(
    org_id,
    patient_id,
    visit_id,
):
    if not visit_id:
        return True

    result = execute_with_retry(
        lambda: (
            supabase
            .table("visits")
            .select("id")
            .eq("org_id", org_id)
            .eq("id", visit_id)
            .eq("pet_id", patient_id)
            .limit(1)
        ),
        attempts=3,
        delay=0.25,
    )

    return bool(result.data)

@app.put(
    "/api/patients/<patient_id>/status"
)
def api_update_patient_status(
    patient_id,
):
    user, auth_error = roles_required(
        "owner",
        "admin",
        "vet",
    )

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    data = request.get_json(
        silent=True
    ) or {}

    status = str(
        data.get("patient_status")
        or ""
    ).strip()

    deceased_at = str(
        data.get("deceased_at")
        or ""
    ).strip() or None

    if status not in [
        "active",
        "deceased",
        "archived",
    ]:
        return fail(
            "Некоректний статус пацієнта.",
            400,
        )

    if (
        status == "deceased"
        and not deceased_at
    ):
        return fail(
            "Вкажіть дату смерті.",
            400,
        )

    if (
        status != "deceased"
    ):
        deceased_at = None

    try:
        patient_result = (
            supabase
            .table("patients")
            .select("id")
            .eq("org_id", current_org)
            .eq("id", patient_id)
            .limit(1)
            .execute()
        )

        if not patient_result.data:
            return fail(
                "Пацієнта не знайдено.",
                404,
            )

        result = (
            supabase
            .table("patients")
            .update({
                "patient_status":
                    status,

                "deceased_at":
                    deceased_at,
            })
            .eq("org_id", current_org)
            .eq("id", patient_id)
            .execute()
        )

        if not result.data:
            return fail(
                "Не вдалося оновити статус пацієнта.",
                500,
            )

        return ok(
            result.data[0]
        )

    except Exception as error:
        print(
            "❌ PUT patient status:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося оновити статус пацієнта.",
            500,
        )
@app.get(
    "/api/patients/<patient_id>/diagnoses"
)
def api_get_patient_diagnoses(
    patient_id,
):
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()
    scope = str(
        request.args.get("scope")
        or "active"
    ).strip().lower()

    if scope not in {
        "active",
        "history",
    }:
        return fail(
            "Invalid diagnosis scope",
            400,
        )

    try:
        if not load_patient_for_diagnosis(
            current_org,
            patient_id,
        ):
            return fail(
                "Пацієнта не знайдено.",
                404,
            )

        def build_query():
            query = (
                supabase
                .table("patient_diagnoses")
                .select("*")
                .eq("org_id", current_org)
                .eq("patient_id", patient_id)
            )

            if scope == "active":
                query = query.eq(
                    "status",
                    "active",
                )

            return query.order(
                "diagnosed_at",
                desc=True,
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
            "❌ GET patient diagnoses:",
            repr(error),
        )

        return fail(
            "Не вдалося завантажити діагнози.",
            500,
        )


@app.post(
    "/api/patients/<patient_id>/diagnoses"
)
def api_create_patient_diagnosis(
    patient_id,
):
    user, auth_error = roles_required(
        "owner",
        "admin",
        "vet",
    )

    if auth_error:
        return auth_error

    data = request.get_json(
        silent=True
    ) or {}
    current_org = get_current_org_id()

    try:
        diagnosis_name = (
            normalize_diagnosis_text(
                data.get("diagnosis_name"),
                max_length=300,
                required=True,
            )
        )

        diagnosis_code = (
            normalize_diagnosis_text(
                data.get("diagnosis_code"),
                max_length=100,
            )
        )

        clinical_note = (
            normalize_diagnosis_text(
                data.get("clinical_note"),
                max_length=4000,
            )
        )

    except ValueError as error:
        return fail(
            str(error),
            400,
        )

    certainty = str(
        data.get("certainty")
        or "confirmed"
    ).strip().lower()
    severity_value = data.get(
        "severity"
    )
    severity = (
        str(severity_value).strip().lower()
        if severity_value not in (None, "")
        else None
    )
    source_visit_id = str(
        data.get("source_visit_id")
        or ""
    ).strip() or None

    if certainty not in DIAGNOSIS_CERTAINTIES:
        return fail(
            "Invalid diagnosis certainty",
            400,
        )

    if (
        severity is not None
        and severity not in DIAGNOSIS_SEVERITIES
    ):
        return fail(
            "Invalid diagnosis severity",
            400,
        )

    try:
        if not load_patient_for_diagnosis(
            current_org,
            patient_id,
        ):
            return fail(
                "Пацієнта не знайдено.",
                404,
            )

        if not validate_diagnosis_source_visit(
            current_org,
            patient_id,
            source_visit_id,
        ):
            return fail(
                "Візит не належить цьому пацієнту.",
                400,
            )

        payload = {
            "org_id": current_org,
            "patient_id": patient_id,
            "source_visit_id": (
                source_visit_id
            ),
            "diagnosis_code": (
                diagnosis_code
            ),
            "diagnosis_name": (
                diagnosis_name
            ),
            "clinical_note": (
                clinical_note
            ),
            "certainty": certainty,
            "severity": severity,
            "status": "active",
            "onset_at": (
                data.get("onset_at")
                or None
            ),
            "diagnosed_at": (
                data.get("diagnosed_at")
                or datetime.now(
                    timezone.utc
                ).isoformat()
            ),
            "created_by": user.get("id"),
            "updated_by": user.get("id"),
        }

        result = (
            supabase
            .table("patient_diagnoses")
            .insert(
                clean_payload(payload)
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Не вдалося створити діагноз.",
                500,
            )

        return ok(
            result.data[0]
        )

    except Exception as error:
     print(
        "❌ POST patient diagnosis:",
        repr(error),
        flush=True,
    )

    return fail(
        f"Не вдалося створити діагноз: {error}",
        500,
    )


@app.put(
    "/api/patient-diagnoses/<diagnosis_id>"
)
def api_update_patient_diagnosis(
    diagnosis_id,
):
    user, auth_error = roles_required(
        "owner",
        "admin",
        "vet",
    )

    if auth_error:
        return auth_error

    data = request.get_json(
        silent=True
    ) or {}
    current_org = get_current_org_id()

    try:
        expected_version = int(
            data.get("version")
        )
    except (TypeError, ValueError):
        return fail(
            "Diagnosis version required",
            400,
        )

    if expected_version < 1:
        return fail(
            "Invalid diagnosis version",
            400,
        )

    try:
        existing_result = (
            supabase
            .table("patient_diagnoses")
            .select("*")
            .eq("org_id", current_org)
            .eq("id", diagnosis_id)
            .limit(1)
            .execute()
        )

        if not existing_result.data:
            return fail(
                "Діагноз не знайдено.",
                404,
            )

        existing = existing_result.data[0]

        if (
            existing.get("status")
            == "entered_in_error"
        ):
            return fail(
                "Помилковий діагноз не можна змінювати.",
                400,
            )

        if int(
            existing.get("version")
            or 1
        ) != expected_version:
            return fail(
                "Діагноз уже змінено іншим користувачем.",
                409,
            )

        payload = {}

        if "diagnosis_name" in data:
            try:
                payload["diagnosis_name"] = (
                    normalize_diagnosis_text(
                        data.get(
                            "diagnosis_name"
                        ),
                        max_length=300,
                        required=True,
                    )
                )
            except ValueError as error:
                return fail(
                    str(error),
                    400,
                )

        for field, max_length in (
            ("diagnosis_code", 100),
            ("clinical_note", 4000),
        ):
            if field not in data:
                continue

            try:
                payload[field] = (
                    normalize_diagnosis_text(
                        data.get(field),
                        max_length=max_length,
                    )
                )
            except ValueError as error:
                return fail(
                    str(error),
                    400,
                )

        if "certainty" in data:
            certainty = str(
                data.get("certainty")
                or ""
            ).strip().lower()

            if certainty not in DIAGNOSIS_CERTAINTIES:
                return fail(
                    "Invalid diagnosis certainty",
                    400,
                )

            payload["certainty"] = certainty

        if "severity" in data:
            severity_value = data.get(
                "severity"
            )
            severity = (
                str(severity_value)
                .strip()
                .lower()
                if severity_value
                not in (None, "")
                else None
            )

            if (
                severity is not None
                and severity
                not in DIAGNOSIS_SEVERITIES
            ):
                return fail(
                    "Invalid diagnosis severity",
                    400,
                )

            payload["severity"] = severity

        for field in (
            "onset_at",
            "diagnosed_at",
        ):
            if field in data:
                payload[field] = (
                    data.get(field)
                    or None
                )

        if "status" in data:
            new_status = str(
                data.get("status")
                or ""
            ).strip().lower()
            old_status = str(
                existing.get("status")
                or "active"
            ).strip().lower()

            if new_status not in DIAGNOSIS_STATUSES:
                return fail(
                    "Invalid diagnosis status",
                    400,
                )

            if (
                new_status != old_status
                and new_status
                not in DIAGNOSIS_STATUS_TRANSITIONS.get(
                    old_status,
                    set(),
                )
            ):
                return fail(
                    "Invalid diagnosis status transition",
                    400,
                )

            status_reason = str(
                data.get("status_reason")
                or ""
            ).strip()

            if (
                new_status == "entered_in_error"
                and not status_reason
            ):
                return fail(
                    "Причина помилкового діагнозу обов'язкова.",
                    400,
                )

            if len(status_reason) > 1000:
                return fail(
                    "Diagnosis status reason is too long",
                    400,
                )

            payload["status"] = new_status
            payload["status_reason"] = (
                status_reason or None
            )

        if not payload:
            return fail(
                "Nothing to update",
                400,
            )

        payload["updated_by"] = (
            user.get("id")
        )

        update_result = (
            supabase
            .table("patient_diagnoses")
            .update(payload)
            .eq("org_id", current_org)
            .eq("id", diagnosis_id)
            .eq("version", expected_version)
            .execute()
        )

        if not update_result.data:
            return fail(
                "Діагноз уже змінено іншим користувачем.",
                409,
            )

        updated_diagnosis = (
            update_result.data[0]
        )

        if (
            "status" in data
            and new_status != old_status
        ):
            event_payload = {
                "org_id":
                    current_org,

                "patient_id":
                    existing.get(
                        "patient_id"
                    ),

                "diagnosis_id":
                    diagnosis_id,

                "event_type":
                    "status_changed",

                "from_status":
                    old_status,

                "to_status":
                    new_status,

                "reason":
                    status_reason
                    or None,

                "created_by":
                    user.get("id"),

                "occurred_at":
                    datetime.now(
                        timezone.utc
                    ).isoformat(),
            }

            supabase \
                .table(
                    "patient_diagnosis_events"
                ) \
                .insert(
                    clean_payload(
                        event_payload
                    )
                ) \
                .execute()

        return ok(
            updated_diagnosis
        )

    except Exception as error:
        print(
            "❌ PUT patient diagnosis:",
            repr(error),
        )

        return fail(
            "Не вдалося оновити діагноз.",
            500,
        )


@app.get(
    "/api/patient-diagnoses/<diagnosis_id>/events"
)
def api_get_patient_diagnosis_events(
    diagnosis_id,
):
    user, auth_error = auth_required()

    if auth_error:
        return auth_error

    current_org = get_current_org_id()

    try:
        diagnosis_result = (
            supabase
            .table("patient_diagnoses")
            .select("id")
            .eq("org_id", current_org)
            .eq("id", diagnosis_id)
            .limit(1)
            .execute()
        )

        if not diagnosis_result.data:
            return fail(
                "Діагноз не знайдено.",
                404,
            )

        events_result = (
            supabase
            .table("patient_diagnosis_events")
            .select("*")
            .eq("org_id", current_org)
            .eq("diagnosis_id", diagnosis_id)
            .order("occurred_at", desc=True)
            .execute()
        )

        return ok(
            events_result.data or []
        )

    except Exception as error:
        print(
            "❌ GET diagnosis events:",
            repr(error),
            flush=True,
        )

        print(
            "❌ GET diagnosis events details:",
            str(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити історію діагнозу.",
            500,
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
        patients_res = execute_with_retry(
            lambda: (
                supabase
                .table("patients")
                .select("*")
                .eq("org_id", current_org)
                .in_("id", patient_ids)
            ),
            attempts=4,
            delay=0.4,
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
            owners_res = execute_with_retry(
                lambda: (
                    supabase
                    .table("owners")
                    .select("*")
                    .eq("org_id", current_org)
                    .in_("id", owner_ids)
                ),
                attempts=4,
                delay=0.4,
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
        staff_res = execute_with_retry(
            lambda: (
                supabase
                .table("staff")
                .select("*")
                .eq("org_id", current_org)
                .in_("id", doctor_ids)
            ),
            attempts=4,
            delay=0.4,
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

        active_value = (
            str(active_raw).lower()
            in ("1", "true", "yes")
            if active_raw is not None
            else None
        )

        def build_hospitalizations_query():
            query = (
                supabase
                .table("hospitalizations")
                .select("*")
                .eq("org_id", current_org)
            )

            if active_value is not None:
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

            return query.order(
                "admitted_at",
                desc=True
            )

        result = execute_with_retry(
            build_hospitalizations_query,
            attempts=4,
            delay=0.4,
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
    # =====================================================
# API: VISIT TASKS
# =====================================================

VISIT_TASK_STATUSES = {
    "open",
    "completed",
}

VISIT_TASK_PRIORITIES = {
    "low",
    "normal",
    "high",
}
# =====================================================
# API: GLOBAL TASK CENTER
# =====================================================

TASK_KINDS = {
    "task",
    "reminder",
    "follow_up",
}

TASK_SOURCES = {
    "manual",
    "visit",
    "vaccination",
    "ai",
    "system",
}


@app.get("/api/tasks")
def api_get_tasks():
    user, auth_error = (
        auth_required()
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


        # ---------------------------------------------
        # FILTERS
        # ---------------------------------------------

        scope = str(
            request.args.get("scope")
            or "all"
        ).strip().lower()

        if scope not in {
            "all",
            "mine",
            "today",
            "overdue",
        }:
            scope = "all"


        status = str(
            request.args.get("status")
            or ""
        ).strip().lower()

        if (
            status not in
            VISIT_TASK_STATUSES
        ):
            status = ""


        task_kind = str(
            request.args.get("kind")
            or ""
        ).strip().lower()

        if (
            task_kind not in
            TASK_KINDS
        ):
            task_kind = ""


        patient_id = str(
            request.args.get("patient_id")
            or ""
        ).strip()


        requested_staff_id = str(
            request.args.get("staff_id")
            or ""
        ).strip()


        # Дату и время будет передавать frontend
        # в локальном времени клиники.
        today_value = str(
            request.args.get("date")
            or ""
        ).strip()

        now_time_value = str(
            request.args.get("time")
            or ""
        ).strip()


        if not today_value:
            today_value = (
                datetime.now(
                    timezone.utc
                )
                .date()
                .isoformat()
            )


        if not now_time_value:
            now_time_value = (
                datetime.now(
                    timezone.utc
                )
                .strftime("%H:%M")
            )


        try:
            datetime.strptime(
                today_value,
                "%Y-%m-%d",
            )
        except Exception:
            return fail(
                "Invalid date format.",
                400,
            )


        try:
            datetime.strptime(
                now_time_value,
                "%H:%M",
            )
        except Exception:
            return fail(
                "Invalid time format.",
                400,
            )


        # ---------------------------------------------
        # ROLE / ACCESS
        # ---------------------------------------------

        role = normalize_role(
            user.get("role")
        )

        current_staff_id = str(
            user.get("staff_id")
            or ""
        ).strip()


        # Врач видит только задачи,
        # назначенные ему.
        if role == "vet":
            requested_staff_id = (
                current_staff_id
            )


        # Мои задачи.
        if scope == "mine":
            requested_staff_id = (
                current_staff_id
            )

            if not requested_staff_id:
                return ok([])


        # ---------------------------------------------
        # DATABASE QUERY
        # ---------------------------------------------

        def build_query():
            query = (
                supabase
                .table("visit_tasks")
                .select("*")
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


            if task_kind:
                query = query.eq(
                    "task_kind",
                    task_kind,
                )


            if patient_id:
                query = query.eq(
                    "patient_id",
                    patient_id,
                )


            if requested_staff_id:
                query = query.eq(
                    "staff_id",
                    requested_staff_id,
                )


            return query.order(
                "created_at",
                desc=False,
            )


        result = (
            execute_with_retry(
                build_query,
                attempts=4,
                delay=0.25,
            )
        )


        rows = (
            result.data or []
        )


        # ---------------------------------------------
        # SCOPE FILTERING
        # ---------------------------------------------

        def task_is_overdue(task):
            if (
                task.get("status")
                == "completed"
            ):
                return False


            due_date = str(
                task.get("due_date")
                or ""
            ).strip()

            due_time = str(
                task.get("due_time")
                or ""
            ).strip()[:5]


            if not due_date:
                return False


            if due_date < today_value:
                return True


            if (
                due_date == today_value
                and due_time
                and due_time < now_time_value
            ):
                return True


            return False


        if scope == "today":
            rows = [
                task
                for task in rows
                if (
                    str(
                        task.get("due_date")
                        or ""
                    ).strip()
                    == today_value
                )
            ]


        elif scope == "overdue":
            rows = [
                task
                for task in rows
                if task_is_overdue(task)
            ]


        # ---------------------------------------------
        # ADD COMPUTED FLAGS
        # ---------------------------------------------

        prepared_rows = []

        for task in rows:
            item = dict(task)

            item["is_overdue"] = (
                task_is_overdue(task)
            )

            item["is_today"] = (
                str(
                    task.get("due_date")
                    or ""
                ).strip()
                == today_value
            )

            prepared_rows.append(
                item
            )


        # ---------------------------------------------
        # SORT
        # ---------------------------------------------

        prepared_rows.sort(
            key=lambda task: (
                # Выполненные вниз
                task.get("status")
                == "completed",

                # Просроченные вверх
                not task.get(
                    "is_overdue"
                ),

                # Сначала имеющие дату
                not bool(
                    task.get("due_date")
                ),

                str(
                    task.get("due_date")
                    or "9999-12-31"
                ),

                str(
                    task.get("due_time")
                    or "23:59"
                ),

                str(
                    task.get("created_at")
                    or ""
                ),
            )
        )


        return ok(
            prepared_rows
        )


    except Exception as error:
        print(
            "❌ GET global tasks:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося завантажити задачі.",
            500,
        )
# =====================================================
# CREATE GLOBAL TASK
# =====================================================

@app.post("/api/tasks")
def api_create_task():
    user, auth_error = (
        auth_required()
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


        data = (
            request.get_json(
                silent=True
            )
            or {}
        )


        # ---------------------------------------------
        # TITLE
        # ---------------------------------------------

        title = str(
            data.get("title")
            or ""
        ).strip()

        if not title:
            return fail(
                "Вкажіть текст задачі.",
                400,
            )

        if len(title) > 240:
            return fail(
                "Текст задачі занадто довгий.",
                400,
            )


        description = str(
            data.get("description")
            or ""
        ).strip()

        if len(description) > 4000:
            return fail(
                "Опис задачі занадто довгий.",
                400,
            )


        # ---------------------------------------------
        # TYPE / SOURCE
        # ---------------------------------------------

        task_kind = str(
            data.get("task_kind")
            or "task"
        ).strip().lower()

        if task_kind not in TASK_KINDS:
            return fail(
                "Некоректний тип задачі.",
                400,
            )


        source = str(
            data.get("source")
            or "manual"
        ).strip().lower()

        if source not in TASK_SOURCES:
            return fail(
                "Некоректне джерело задачі.",
                400,
            )


        # ---------------------------------------------
        # PRIORITY
        # ---------------------------------------------

        priority = str(
            data.get("priority")
            or "normal"
        ).strip().lower()

        if (
            priority not in
            VISIT_TASK_PRIORITIES
        ):
            priority = "normal"


        # ---------------------------------------------
        # DATE / TIME
        # ---------------------------------------------

        due_date = str(
            data.get("due_date")
            or ""
        ).strip()

        due_time = str(
            data.get("due_time")
            or ""
        ).strip()


        if due_date:
            try:
                datetime.strptime(
                    due_date,
                    "%Y-%m-%d",
                )
            except Exception:
                return fail(
                    "Некоректна дата задачі.",
                    400,
                )


        if due_time:
            try:
                datetime.strptime(
                    due_time[:5],
                    "%H:%M",
                )

                due_time = (
                    due_time[:5]
                )

            except Exception:
                return fail(
                    "Некоректний час задачі.",
                    400,
                )


        remind_at = str(
            data.get("remind_at")
            or ""
        ).strip()

        if remind_at:
            try:
                datetime.fromisoformat(
                    remind_at.replace(
                        "Z",
                        "+00:00",
                    )
                )
            except Exception:
                return fail(
                    "Некоректний час нагадування.",
                    400,
                )


        # ---------------------------------------------
        # RELATIONS
        # ---------------------------------------------

        patient_id = str(
            data.get("patient_id")
            or ""
        ).strip()

        staff_id = str(
            data.get("staff_id")
            or ""
        ).strip()

        visit_id = str(
            data.get("visit_id")
            or ""
        ).strip()

        source_entity_id = str(
            data.get("source_entity_id")
            or ""
        ).strip()


        # ---------------------------------------------
        # PATIENT CHECK
        # ---------------------------------------------

        if patient_id:
            patient_result = (
                execute_with_retry(
                    lambda: (
                        supabase
                        .table("patients")
                        .select("id")
                        .eq(
                            "org_id",
                            current_org,
                        )
                        .eq(
                            "id",
                            patient_id,
                        )
                        .limit(1)
                    ),
                    attempts=4,
                    delay=0.25,
                )
            )

            if not patient_result.data:
                return fail(
                    "Пацієнта не знайдено.",
                    404,
                )


        # ---------------------------------------------
        # VISIT CHECK
        # ---------------------------------------------

        if visit_id:
            visit_result = (
                execute_with_retry(
                    lambda: (
                        supabase
                        .table("visits")
                        .select(
                            "id,pet_id,staff_id"
                        )
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
                    attempts=4,
                    delay=0.25,
                )
            )

            if not visit_result.data:
                return fail(
                    "Візит не знайдено.",
                    404,
                )


        # ---------------------------------------------
        # STAFF ACCESS
        # ---------------------------------------------

        role = normalize_role(
            user.get("role")
        )

        current_staff_id = str(
            user.get("staff_id")
            or ""
        ).strip()


        # Ветеринар может назначить
        # глобальную задачу только себе.
        if role == "vet":
            if (
                staff_id
                and staff_id !=
                current_staff_id
            ):
                return fail(
                    (
                        "Ветеринар може "
                        "призначати задачі "
                        "лише собі."
                    ),
                    403,
                )

            staff_id = (
                current_staff_id
            )


        if staff_id:
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
                    attempts=4,
                    delay=0.25,
                )
            )

            if not staff_result.data:
                return fail(
                    "Співробітника не знайдено.",
                    404,
                )


        # ---------------------------------------------
        # SOURCE ENTITY UUID
        # ---------------------------------------------

        if source_entity_id:
            try:
                uuid.UUID(
                    source_entity_id
                )
            except Exception:
                return fail(
                    (
                        "Некоректний "
                        "source_entity_id."
                    ),
                    400,
                )


        # ---------------------------------------------
        # CREATE
        # ---------------------------------------------

        now_iso = (
            datetime
            .now(timezone.utc)
            .isoformat()
        )


        payload = {
            "org_id":
                current_org,

            "visit_id":
                visit_id or None,

            "patient_id":
                patient_id or None,

            "staff_id":
                staff_id or None,

            "title":
                title,

            "description":
                description or None,

            "task_kind":
                task_kind,

            "source":
                source,

            "priority":
                priority,

            "status":
                "open",

            "due_date":
                due_date or None,

            "due_time":
                due_time or None,

            "remind_at":
                remind_at or None,

            "source_entity_id":
                source_entity_id
                or None,

            "created_by":
                user.get("id")
                or None,

            "completed_at":
                None,

            "updated_at":
                now_iso,
        }


        result = (
            execute_with_retry(
                lambda: (
                    supabase
                    .table("visit_tasks")
                    .insert(payload)
                ),
                attempts=4,
                delay=0.25,
            )
        )


        if not result.data:
            return fail(
                "Не вдалося створити задачу.",
                500,
            )


        task = (
            result.data[0]
        )


        write_audit_event(
            action="create",
            entity_type="task",
            entity_id=task.get("id"),
            entity_label=title,
            summary=(
                "Створено задачу"
            ),
            after_data=task,
        )


        return ok(task)


    except Exception as error:
        print(
            "❌ POST global task:",
            repr(error),
            flush=True,
        )

        return fail(
            "Не вдалося створити задачу.",
            500,
        )
    
def get_visit_for_task(
    visit_id,
    current_org,
):
    visit_id = str(
        visit_id or ""
    ).strip()

    if not visit_id:
        return None

    result = (
        supabase
        .table("visits")
        .select(
            "id,pet_id,staff_id"
        )
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

    return (
        result.data[0]
        if result.data
        else None
    )


@app.get(
    "/api/visits/<visit_id>/tasks"
)
def api_get_visit_tasks(
    visit_id,
):
    user, auth_error = (
        auth_required()
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


        visit_result = (
            execute_with_retry(
                lambda: (
                    supabase
                    .table("visits")
                    .select(
                        "id,pet_id,staff_id"
                    )
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
                attempts=4,
                delay=0.25,
            )
        )


        visit = (
            visit_result.data[0]
            if visit_result.data
            else None
        )


        if not visit:
            return fail(
                "Візит не знайдено.",
                404,
            )


        status = str(
            request.args.get(
                "status"
            )
            or ""
        ).strip()


        def build_tasks_query():
            query = (
                supabase
                .table("visit_tasks")
                .select("*")
                .eq(
                    "org_id",
                    current_org,
                )
                .eq(
                    "visit_id",
                    visit_id,
                )
            )

            if (
                status in
                VISIT_TASK_STATUSES
            ):
                query = query.eq(
                    "status",
                    status,
                )

            return (
                query
                .order(
                    "created_at",
                    desc=False,
                )
            )


        result = (
            execute_with_retry(
                build_tasks_query,
                attempts=4,
                delay=0.25,
            )
        )


        rows = (
            result.data or []
        )


        rows.sort(
            key=lambda row: (
                row.get("status")
                == "completed",

                str(
                    row.get("due_date")
                    or "9999-12-31"
                ),

                str(
                    row.get("due_time")
                    or "23:59:59"
                ),

                str(
                    row.get("created_at")
                    or ""
                ),
            )
        )


        return ok(
            rows
        )


    except Exception as error:
        print(
            "❌ GET visit tasks:",
            repr(error),
            flush=True,
        )

        return fail(
            (
                "Не вдалося завантажити "
                "задачі візиту."
            ),
            500,
        )


@app.post(
    "/api/visits/<visit_id>/tasks"
)
def api_create_visit_task(
    visit_id,
):
    user, auth_error = (
        auth_required()
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
                400
            )

        visit = get_visit_for_task(
            visit_id,
            current_org,
        )

        if not visit:
            return fail(
                "Візит не знайдено.",
                404
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        title = str(
            data.get("title")
            or ""
        ).strip()

        if not title:
            return fail(
                "Вкажіть текст задачі.",
                400
            )

        if len(title) > 240:
            return fail(
                "Текст задачі занадто довгий.",
                400
            )

        due_date = str(
            data.get("due_date")
            or ""
        ).strip()

        due_time = str(
            data.get("due_time")
            or ""
        ).strip()

        priority = str(
            data.get("priority")
            or "normal"
        ).strip().lower()

        if (
            priority not in
            VISIT_TASK_PRIORITIES
        ):
            priority = "normal"

        staff_id = str(
            data.get("staff_id")
            or visit.get("staff_id")
            or user.get("staff_id")
            or ""
        ).strip()

        patient_id = str(
            data.get("patient_id")
            or visit.get("pet_id")
            or ""
        ).strip()

        if staff_id:
            staff_result = (
                supabase
                .table("staff")
                .select("id")
                .eq(
                    "org_id",
                    current_org
                )
                .eq(
                    "id",
                    staff_id
                )
                .limit(1)
                .execute()
            )

            if not staff_result.data:
                return fail(
                    "Співробітника не знайдено.",
                    404
                )

        payload = {
            "org_id":
                current_org,

            "visit_id":
                visit_id,

            "patient_id":
                patient_id
                or None,

            "staff_id":
                staff_id
                or None,

            "title":
                title,

            "due_date":
                due_date
                or None,

            "due_time":
                due_time
                or None,

            "status":
                "open",

            "priority":
                priority,

            "completed_at":
                None,

            "updated_at":
                datetime.now(
                    timezone.utc
                ).isoformat(),
        }

        result = (
            supabase
            .table("visit_tasks")
            .insert(
                payload
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Не вдалося створити задачу.",
                500
            )

        return ok(
            result.data[0]
        )

    except Exception as error:
        print(
            "❌ POST visit task:",
            repr(error)
        )

        return fail(
            "Не вдалося створити задачу візиту.",
            500
        )


@app.put(
    "/api/visit-tasks/<task_id>"
)
def api_update_visit_task(
    task_id,
):
    user, auth_error = (
        auth_required()
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
                400
            )

        data = (
            request.get_json(
                silent=True
            )
            or {}
        )

        existing_result = (
            supabase
            .table("visit_tasks")
            .select("*")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                task_id
            )
            .limit(1)
            .execute()
        )

        if not existing_result.data:
            return fail(
                "Задачу не знайдено.",
                404
            )

        existing = (
            existing_result.data[0]
        )

        payload = {}

        if "title" in data:
            title = str(
                data.get("title")
                or ""
            ).strip()

            if not title:
                return fail(
                    "Текст задачі не може бути порожнім.",
                    400
                )

            if len(title) > 240:
                return fail(
                    "Текст задачі занадто довгий.",
                    400
                )

            payload["title"] = (
                title
            )
        if "description" in data:
            description = str(
                data.get(
                    "description"
                )
                or ""
            ).strip()

            if (
                len(description) >
                4000
            ):
                return fail(
                    "Опис задачі занадто довгий.",
                    400
                )

            payload[
                "description"
            ] = (
                description
                or None
            )


        if "task_kind" in data:
            task_kind = str(
                data.get(
                    "task_kind"
                )
                or "task"
            ).strip().lower()

            if (
                task_kind not in
                TASK_KINDS
            ):
                return fail(
                    "Некоректний тип задачі.",
                    400
                )

            payload[
                "task_kind"
            ] = (
                task_kind
            )


        if "patient_id" in data:
            patient_id = str(
                data.get(
                    "patient_id"
                )
                or ""
            ).strip()

            if patient_id:
                patient_result = (
                    execute_with_retry(
                        lambda: (
                            supabase
                            .table(
                                "patients"
                            )
                            .select("id")
                            .eq(
                                "org_id",
                                current_org
                            )
                            .eq(
                                "id",
                                patient_id
                            )
                            .limit(1)
                        ),
                        attempts=4,
                        delay=0.25,
                    )
                )

                if (
                    not patient_result.data
                ):
                    return fail(
                        "Пацієнта не знайдено.",
                        404
                    )

            payload[
                "patient_id"
            ] = (
                patient_id
                or None
            )
        if "due_date" in data:
            payload["due_date"] = (
                str(
                    data.get(
                        "due_date"
                    )
                    or ""
                ).strip()
                or None
            )

        if "due_time" in data:
            payload["due_time"] = (
                str(
                    data.get(
                        "due_time"
                    )
                    or ""
                ).strip()
                or None
            )

        if "priority" in data:
            priority = str(
                data.get("priority")
                or "normal"
            ).strip().lower()

            if (
                priority not in
                VISIT_TASK_PRIORITIES
            ):
                return fail(
                    "Некоректний пріоритет задачі.",
                    400
                )

            payload["priority"] = (
                priority
            )

        if "staff_id" in data:
            staff_id = str(
                data.get("staff_id")
                or ""
            ).strip()

            if staff_id:
                staff_result = (
                    supabase
                    .table("staff")
                    .select("id")
                    .eq(
                        "org_id",
                        current_org
                    )
                    .eq(
                        "id",
                        staff_id
                    )
                    .limit(1)
                    .execute()
                )

                if not staff_result.data:
                    return fail(
                        "Співробітника не знайдено.",
                        404
                    )

            payload["staff_id"] = (
                staff_id
                or None
            )

        if "status" in data:
            status = str(
                data.get("status")
                or ""
            ).strip().lower()

            if (
                status not in
                VISIT_TASK_STATUSES
            ):
                return fail(
                    "Некоректний статус задачі.",
                    400
                )

            payload["status"] = (
                status
            )

            if status == "completed":
                payload["completed_at"] = (
                    datetime.now(
                        timezone.utc
                    ).isoformat()
                )
            else:
                payload["completed_at"] = (
                    None
                )

        if not payload:
            return ok(existing)

        payload["updated_at"] = (
            datetime.now(
                timezone.utc
            ).isoformat()
        )

        result = (
            supabase
            .table("visit_tasks")
            .update(payload)
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                task_id
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Задачу не знайдено.",
                404
            )

        return ok(
            result.data[0]
        )

    except Exception as error:
        print(
            "❌ PUT visit task:",
            repr(error)
        )

        return fail(
            "Не вдалося оновити задачу.",
            500
        )


@app.post(
    "/api/visit-tasks/<task_id>/complete"
)
def api_complete_visit_task(
    task_id,
):
    user, auth_error = (
        auth_required()
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
                400
            )

        result = (
            supabase
            .table("visit_tasks")
            .update({
                "status":
                    "completed",

                "completed_at":
                    datetime.now(
                        timezone.utc
                    ).isoformat(),

                "updated_at":
                    datetime.now(
                        timezone.utc
                    ).isoformat(),
            })
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                task_id
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Задачу не знайдено.",
                404
            )

        return ok(
            result.data[0]
        )

    except Exception as error:
        print(
            "❌ COMPLETE visit task:",
            repr(error)
        )

        return fail(
            "Не вдалося завершити задачу.",
            500
        )


@app.post(
    "/api/visit-tasks/<task_id>/reopen"
)
def api_reopen_visit_task(
    task_id,
):
    user, auth_error = (
        auth_required()
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
                400
            )

        result = (
            supabase
            .table("visit_tasks")
            .update({
                "status":
                    "open",

                "completed_at":
                    None,

                "updated_at":
                    datetime.now(
                        timezone.utc
                    ).isoformat(),
            })
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                task_id
            )
            .execute()
        )

        if not result.data:
            return fail(
                "Задачу не знайдено.",
                404
            )

        return ok(
            result.data[0]
        )

    except Exception as error:
        print(
            "❌ REOPEN visit task:",
            repr(error)
        )

        return fail(
            "Не вдалося повернути задачу.",
            500
        )


@app.delete(
    "/api/visit-tasks/<task_id>"
)
def api_delete_visit_task(
    task_id,
):
    user, auth_error = (
        auth_required()
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
                400
            )

        existing_result = (
            supabase
            .table("visit_tasks")
            .select("id")
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                task_id
            )
            .limit(1)
            .execute()
        )

        if not existing_result.data:
            return fail(
                "Задачу не знайдено.",
                404
            )

        (
            supabase
            .table("visit_tasks")
            .delete()
            .eq(
                "org_id",
                current_org
            )
            .eq(
                "id",
                task_id
            )
            .execute()
        )

        return ok(True)

    except Exception as error:
        print(
            "❌ DELETE visit task:",
            repr(error)
        )

        return fail(
            "Не вдалося видалити задачу.",
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

        def build_visits_query():
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

            return query

        result = execute_with_retry(
            build_visits_query,
            attempts=4,
            delay=0.4,
        )
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

    if (
        "services" in d
        or "services_json" in d
        or "stock" in d
        or "stock_json" in d
    ):
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

        existing_visit = (
            existing_result.data[0]
        )

        medical_before = (
            visit_medical_audit_snapshot(
                existing_visit
            )
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
            row = existing_visit

        medical_after = (
            visit_medical_audit_snapshot({
                **existing_visit,
                **row,
            })
        )

        changed_medical_fields = [
            field
            for field in medical_after
            if medical_before.get(field)
            != medical_after.get(field)
        ]

        if changed_medical_fields:
            patient_name = "\u041f\u0430цієнт"
            pet_id = (
                row.get("pet_id")
                or existing_visit.get(
                    "pet_id"
                )
            )

            if pet_id:
                try:
                    patient_result = (
                        execute_with_retry(
                            lambda: (
                                supabase
                                .table("patients")
                                .select("id, name")
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

                    if patient_result.data:
                        patient_name = (
                            patient_result
                            .data[0]
                            .get("name")
                            or patient_name
                        )

                except Exception as error:
                    print(
                        "\u26a0\ufe0f Visit medical audit patient load:",
                        repr(error),
                        flush=True,
                    )

            write_audit_event(
                action=
                    "visit.medical_updated",
                entity_type="visit",
                entity_id=visit_id,
                entity_label=(
                    f"\u0412ізит пацієнта "
                    f"{patient_name}"
                ),
                summary=(
                    "Медичні дані "
                    "візиту оновлено"
                ),
                before_data={
                    field:
                        medical_before.get(
                            field
                        )
                    for field
                    in changed_medical_fields
                },
                after_data={
                    field:
                        medical_after.get(
                            field
                        )
                    for field
                    in changed_medical_fields
                },
                metadata={
                    "patient_id": pet_id,
                    "patient_name": patient_name,
                    "visit_date": (
                        row.get("date")
                        or existing_visit.get(
                            "date"
                        )
                    ),
                    "changed_fields":
                        changed_medical_fields,
                },
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

@app.post(
    "/api/visits/<visit_id>/complete"
)
def api_complete_visit(
    visit_id
):
    user, auth_error = (
        auth_required()
    )

    if auth_error:
        return auth_error

    current_org = (
        get_current_org_id()
    )

    clean_visit_id = str(
        visit_id or ""
    ).strip()

    if not current_org:
        return fail(
            "Organization not selected",
            400,
        )

    if not clean_visit_id:
        return fail(
            "visit_id required",
            400,
        )

    try:
        existing_result = (
            execute_with_retry(
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
                        clean_visit_id,
                    )
                    .limit(1)
                ),
                attempts=4,
                delay=0.3,
            )
        )

        if not existing_result.data:
            return fail(
                "Візит не знайдено.",
                404,
            )

        existing_visit = (
            existing_result.data[0]
        )

        visit_already_completed = (
            bool(
                existing_visit.get(
                    "completed_at"
                )
            )
            or bool(
                existing_visit.get(
                    "closed_by"
                )
            )
            or str(
                existing_visit.get(
                    "status"
                )
                or ""
            )
                .strip()
                .lower()
            == "completed"
        )

        completed_at = (
            existing_visit.get(
                "completed_at"
            )
            or datetime
                .now(timezone.utc)
                .isoformat()
        )

        if visit_already_completed:
            updated_visit = {
                **existing_visit,

                "status":
                    "completed",

                "completed_at":
                    completed_at,

                "closed_by":
                    existing_visit.get(
                        "closed_by"
                    )
                    or user.get("id"),
            }

        else:
            update_payload = {
                "status":
                    "completed",

                "completed_at":
                    completed_at,

                "closed_by":
                    user.get("id"),

            }

            update_result = (
                execute_with_retry(
                    lambda: (
                        supabase
                        .table("visits")
                        .update(
                            update_payload
                        )
                        .eq(
                            "org_id",
                            current_org,
                        )
                        .eq(
                            "id",
                            clean_visit_id,
                        )
                    ),
                    attempts=4,
                    delay=0.3,
                )
            )

            if not update_result.data:
                return fail(
                    "Не вдалося завершити візит.",
                    500,
                )

            updated_visit = (
                update_result.data[0]
            )

        calendar_result = (
            execute_with_retry(
                lambda: (
                    supabase
                    .table(
                        "calendar_events"
                    )
                    .update({
                        "status":
                            "completed",

                        "updated_at":
                            completed_at,
                    })
                    .eq(
                        "org_id",
                        current_org,
                    )
                    .eq(
                        "visit_id",
                        clean_visit_id,
                    )
                ),
                attempts=4,
                delay=0.3,
            )
        )

        calendar_event = (
            calendar_result.data[0]
            if calendar_result.data
            else None
        )

        patient_name = (
            "Пацієнт"
        )

        pet_id = (
            updated_visit.get(
                "pet_id"
            )
        )

        if pet_id:
            try:
                patient_result = (
                    execute_with_retry(
                        lambda: (
                            supabase
                            .table("patients")
                            .select(
                                "id, name"
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
                        attempts=4,
                        delay=0.3,
                    )
                )

                if patient_result.data:
                    patient_name = (
                        patient_result
                        .data[0]
                        .get("name")
                        or patient_name
                    )

            except Exception as error:
                print(
                    "⚠️ Complete visit patient load:",
                    repr(error),
                    flush=True,
                )

        audit_recorded = False

        try:
            audit_result = execute_with_retry(
                lambda: (
                    supabase
                    .table("audit_events")
                    .select("id")
                    .eq("org_id", current_org)
                    .eq("action", "visit.completed")
                    .eq("entity_type", "visit")
                    .eq("entity_id", clean_visit_id)
                    .limit(1)
                ),
                attempts=3,
                delay=0.25,
            )

            audit_recorded = bool(
                audit_result.data
            )

        except Exception as error:
            print(
                "⚠️ Complete visit audit lookup:",
                repr(error),
                flush=True,
            )

        if not audit_recorded:
            audit_row = write_audit_event(
                action=
                    "visit.completed",

                entity_type=
                    "visit",

                entity_id=
                    clean_visit_id,

                entity_label=
                    (
                        f"Візит пацієнта "
                        f"{patient_name}"
                    ),

                summary=
                    "Візит завершено",

                before_data={
                    "status":
                        existing_visit.get(
                            "status"
                        ),

                    "completed_at":
                        existing_visit.get(
                            "completed_at"
                        ),

                    "closed_by":
                        existing_visit.get(
                            "closed_by"
                        ),
                },

                after_data={
                    "status":
                        updated_visit.get(
                            "status"
                        ),

                    "completed_at":
                        updated_visit.get(
                            "completed_at"
                        ),

                    "closed_by":
                        updated_visit.get(
                            "closed_by"
                        ),
                },

                metadata={
                    "patient_id":
                        pet_id,

                    "patient_name":
                        patient_name,

                    "visit_date":
                        updated_visit.get(
                            "date"
                        ),

                    "calendar_event_id":
                        (
                            calendar_event.get(
                                "id"
                            )
                            if calendar_event
                            else None
                        ),
                },
            )

            audit_recorded = bool(audit_row)

        services_map, stock_map = (
            load_visit_lines([
                clean_visit_id
            ])
        )

        updated_visit[
            "services"
        ] = (
            services_map.get(
                clean_visit_id,
                []
            )
        )

        updated_visit[
            "stock"
        ] = (
            stock_map.get(
                clean_visit_id,
                []
            )
        )

        updated_visit[
            "calendar_event"
        ] = calendar_event

        updated_visit[
            "audit_recorded"
        ] = audit_recorded

        return ok(
            updated_visit
        )

    except Exception as error:
        print(
            "❌ Complete visit:",
            {
                "visit_id":
                    clean_visit_id,

                "org_id":
                    current_org,

                "error":
                    repr(error),
            },
            flush=True,
        )

        return fail(
            "Не вдалося завершити візит.",
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
        error_text = str(error)

    error_details = getattr(
        error,
        "details",
        None,
    )

    error_message = getattr(
        error,
        "message",
        None,
    )

    error_code = getattr(
        error,
        "code",
        None,
    )

    print(
        "❌ Delete visit with stock restore",
        {
            "visit_id": visit_id,
            "org_id": current_org,
            "user_id": current_user_id,
            "error": repr(error),
            "message": error_message,
            "details": error_details,
            "code": error_code,
        },
        flush=True,
    )

    return jsonify({
        "ok": False,

        "error":
            (
                "Не вдалося видалити візит "
                "та повернути препарати на склад."
            ),

        "debug": {
            "message":
                error_message or
                error_text,

            "details":
                error_details,

            "code":
                error_code,
        },
    }), 500
        

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

                "is_platform_admin": (
                    is_platform_admin(
                        user_data
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
