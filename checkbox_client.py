"""Test-only Checkbox transport and receipt arithmetic."""
import json
import uuid
from decimal import Decimal, ROUND_HALF_UP
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_open = build_opener(_NoRedirect()).open


class CheckboxError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


class CheckboxTestClient:
    def __init__(self, license_key, pin_code):
        if not license_key.lower().startswith("test") or len(license_key) > 128:
            raise CheckboxError("Для навчального режиму потрібен відповідний ліцензійний ключ Checkbox.", 400)
        if not pin_code.isascii() or not pin_code.isdigit() or len(pin_code) > 32:
            raise CheckboxError("Вкажіть PIN касира Checkbox.", 400)
        self.license_key = license_key
        self.pin_code = pin_code
        self.token = None
        self.register = None

    def request(self, method, path, payload=None, *, missing=False, pdf=False):
        headers = {
            "Accept": "application/pdf" if pdf else "application/json",
            "X-Client-Name": "PUG CRM",
            "X-Client-Version": "1.0",
            "X-License-Key": self.license_key,
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode()
        req = Request("https://api.checkbox.in.ua/api/v1/" + path, data, headers, method=method)
        try:
            with _open(req, timeout=8) as response:
                if pdf:
                    body = response.read(5_000_001)
                    if len(body) > 5_000_000 or not body.startswith(b"%PDF-"):
                        raise CheckboxError("Checkbox не повернув PDF чека.", 502)
                    return body
                result = json.load(response)
                if result is None and missing:
                    return None
                if not isinstance(result, dict):
                    raise ValueError("Expected a JSON object")
                return result
        except HTTPError as error:
            if error.code == 404 and missing:
                return None
            if error.code in (401, 403):
                messages = {
                    "cash-registers/info": "Checkbox відхилив перевірку ліцензії каси.",
                    "cashier/signinPinCode": "Checkbox відхилив вхід касира. Перевірте ключ ліцензії та PIN.",
                }
                raise CheckboxError(messages.get(path, "Checkbox відхилив доступ до цієї операції.")) from None
            if error.code < 500:
                raise CheckboxError("Checkbox відхилив операцію. Перевірте касу та стан зміни.") from None
            raise CheckboxError("Checkbox тимчасово недоступний. Перевірте статус перед повтором.", 502) from None
        except (URLError, TimeoutError, ValueError):
            raise CheckboxError("Немає підтвердження від Checkbox. Перевірте статус і повторіть.", 502) from None

    def connect(self):
        data = self.request("POST", "cashier/signinPinCode", {"pin_code": self.pin_code})
        self.token = data.get("access_token")
        if not self.token:
            raise CheckboxError("Checkbox не підтвердив вхід касира.", 502)
        register = self.request("GET", "cash-registers/info")
        if register.get("is_test") is not True or not register.get("id"):
            raise CheckboxError("Checkbox не підтвердив, що ця каса тестова.")
        self.register = register
        return register

    def shift(self):
        shift = self.request("GET", "cashier/shift", missing=True)
        if shift and shift.get("status") != "CLOSED":
            register_id = str((shift.get("cash_register") or {}).get("id") or "")
            if register_id != str(self.register["id"]):
                raise CheckboxError("У касира відкрита зміна на іншій касі.")
        return shift

    def change_shift(self, action):
        shift = self.shift()
        state = shift.get("status") if shift else None
        if action == "open" and state in (None, "CLOSED"):
            shift = self.request("POST", "shifts", {"id": str(uuid.uuid4())})
        elif action == "close" and state == "OPENED":
            shift = self.request("POST", "shifts/close", {})
        return shift


def integer_units(value, scale, message):
    amount = Decimal(str(value)) * scale
    if not amount.is_finite() or amount != amount.to_integral_value() or amount < 0:
        raise CheckboxError(message)
    return int(amount)


def sale_payload(lines, amount, discount, method):
    if method not in {"cash", "card", "terminal"}:
        raise CheckboxError("Чек доступний для оплати готівкою або карткою.")
    goods = []
    total = 0
    for code, row in lines:
        name = str(row.get("name_snap") or "").strip()
        price = integer_units(row["price_snap"], 100, "Ціна позиції має бути в копійках.")
        qty = integer_units(row["qty"], 1000, "Кількість позиції має не більше трьох знаків після коми.")
        if not name or not qty:
            raise CheckboxError("У позиції чека бракує назви або кількості.")
        goods.append({"good": {"code": code, "name": name, "price": price}, "quantity": qty})
        total += int((Decimal(price * qty) / 1000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    paid = integer_units(amount, 100, "Сума оплати має бути в копійках.")
    discount = integer_units(discount or 0, 100, "Знижка має бути в копійках.")
    if not goods or not paid or total - discount != paid:
        raise CheckboxError("Для чека потрібна повна оплата, що збігається із сумою позицій візиту.")
    payload = {
        "goods": goods,
        "payments": [{"type": "CASH" if method == "cash" else "CASHLESS", "value": paid}],
        "rounding": False,
    }
    if discount:
        payload["discounts"] = [{"type": "DISCOUNT", "mode": "VALUE", "value": discount}]
    return payload
