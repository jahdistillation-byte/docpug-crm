import os
import unittest
from unittest.mock import patch


os.environ.setdefault(
    "SUPABASE_URL",
    "https://example.supabase.co",
)
os.environ.setdefault(
    "SUPABASE_SERVICE_KEY",
    "test-service-key",
)
os.environ.setdefault(
    "SESSION_SECRET_KEY",
    "test-session-secret",
)

import server


ORG_ID = "11111111-1111-4111-8111-111111111111"
USER_ID = "22222222-2222-4222-8222-222222222222"
VISIT_ID = "33333333-3333-4333-8333-333333333333"
INTENT_ID = "44444444-4444-4444-8444-444444444444"


class FakeResult:
    def __init__(self, data=None):
        self.data = data if data is not None else []


class FakeQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.operation = "select"
        self.payload = None
        self.filters = {}

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self.filters[key] = value
        return self

    def limit(self, _value):
        return self

    def insert(self, payload):
        self.operation = "insert"
        self.payload = dict(payload)
        return self

    def update(self, payload):
        self.operation = "update"
        self.payload = dict(payload)
        return self

    def execute(self):
        if self.table_name != "payment_intents":
            return FakeResult([])

        if self.operation == "select":
            matches = [
                row for row in self.client.intents
                if all(
                    row.get(key) == value
                    for key, value in self.filters.items()
                )
            ]
            return FakeResult(matches)

        if self.operation == "insert":
            row = {
                "id": INTENT_ID,
                "created_at": "2026-11-02T18:00:00+00:00",
                "updated_at": "2026-11-02T18:00:00+00:00",
                **self.payload,
            }
            self.client.intents.append(row)
            return FakeResult([row])

        if self.operation == "update":
            for row in self.client.intents:
                if all(
                    row.get(key) == value
                    for key, value in self.filters.items()
                ):
                    row.update(self.payload)
                    return FakeResult([row])

        return FakeResult([])


class FakeRpc:
    def __init__(self, client, name, arguments):
        self.client = client
        self.name = name
        self.arguments = arguments

    def execute(self):
        self.client.rpc_calls.append(
            (self.name, self.arguments)
        )
        return FakeResult({
            "transaction_id": "transaction-1",
            "remaining": "0.00",
            "financial_status": "paid",
        })


class FakeSupabase:
    def __init__(self, intents=None):
        self.intents = list(intents or [])
        self.rpc_calls = []

    def table(self, table_name):
        return FakeQuery(self, table_name)

    def rpc(self, name, arguments):
        return FakeRpc(self, name, arguments)


class MonobankPaymentTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.owner = {
            "id": USER_ID,
            "org_id": ORG_ID,
            "role": "owner",
            "is_active": True,
        }

    def auth_patches(self, fake):
        return (
            patch.object(
                server,
                "get_current_user",
                return_value=self.owner,
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value=ORG_ID,
            ),
            patch.object(
                server,
                "supabase",
                fake,
            ),
            patch.object(
                server,
                "load_monobank_connection_credentials",
                return_value=(
                    {"id": "connection-1"},
                    "clinic-test-token",
                ),
            ),
        )

    def test_create_invoice_uses_minor_units_without_recording_payment(self):
        fake = FakeSupabase()
        bank_calls = []

        def bank_request(method, path, **kwargs):
            bank_calls.append((method, path, kwargs))
            return {
                "invoiceId": "mono-invoice-1",
                "pageUrl": "https://pay.example/invoice-1",
            }

        patches = self.auth_patches(fake) + (
            patch.object(
                server,
                "load_visit_payment_balance",
                return_value={
                    "currency": "UAH",
                    "remaining": server.Decimal("2150.00"),
                },
            ),
            patch.object(
                server,
                "monobank_api_request",
                side_effect=bank_request,
            ),
        )

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            response = self.client.post(
                f"/api/visits/{VISIT_ID}/monobank/invoices",
                json={
                    "amount": "2150.00",
                    "idempotency_key": "request-1",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            bank_calls[0][2]["payload"]["amount"],
            215000,
        )
        self.assertEqual(
            bank_calls[0][2]["token"],
            "clinic-test-token",
        )
        self.assertEqual(fake.rpc_calls, [])
        self.assertEqual(
            fake.intents[0]["status"],
            "created",
        )
        self.assertEqual(
            fake.intents[0]["provider_connection_id"],
            "connection-1",
        )
        self.assertTrue(
            response.get_json()["data"]["qr_data_url"]
            .startswith("data:image/png;base64,")
        )

    def test_connect_integration_validates_and_never_returns_token(self):
        fake = FakeSupabase()
        connection = {
            "id": "connection-1",
            "provider": "monobank",
            "status": "connected",
            "credentials_hint": "••••oken",
            "merchant_id": "merchant-1",
            "merchant_name": "ВусаХвіст",
            "merchant_edrpou": "12345678",
        }

        with (
            patch.object(
                server,
                "get_current_user",
                return_value=self.owner,
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value=ORG_ID,
            ),
            patch.object(server, "supabase", fake),
            patch.object(
                server,
                "monobank_api_request",
                return_value={
                    "merchantId": "merchant-1",
                    "merchantName": "ВусаХвіст",
                    "edrpou": "12345678",
                },
            ) as bank_request,
            patch.object(
                server,
                "load_payment_provider_connection",
                return_value=connection,
            ),
            patch.object(server, "write_audit_event"),
        ):
            response = self.client.post(
                "/api/finance/payment-integrations/monobank",
                json={"token": "clinic-token-with-safe-length-1234"},
            )

        self.assertEqual(response.status_code, 200)
        bank_request.assert_called_once_with(
            "GET",
            "/api/merchant/details",
            token="clinic-token-with-safe-length-1234",
        )
        payload = response.get_json()["data"]
        self.assertTrue(payload["connected"])
        self.assertNotIn("token", payload)
        self.assertNotIn(
            "clinic-token-with-safe-length-1234",
            response.get_data(as_text=True),
        )

    def test_success_status_records_payment_once(self):
        fake = FakeSupabase([{
            "id": INTENT_ID,
            "org_id": ORG_ID,
            "visit_id": VISIT_ID,
            "created_by": USER_ID,
            "provider": "monobank",
            "status": "created",
            "amount": "2150.00",
            "currency": "UAH",
            "provider_invoice_id": "mono-invoice-1",
            "page_url": "https://pay.example/invoice-1",
            "idempotency_key": "request-1",
            "finance_transaction_id": None,
        }])

        patches = self.auth_patches(fake) + (
            patch.object(
                server,
                "monobank_api_request",
                return_value={
                    "invoiceId": "mono-invoice-1",
                    "status": "success",
                    "amount": 215000,
                    "ccy": 980,
                },
            ),
            patch.object(
                server,
                "find_monobank_finance_transaction",
                return_value=None,
            ),
            patch.object(
                server,
                "write_audit_event",
            ),
        )

        with (
            patches[0], patches[1], patches[2], patches[3],
            patches[4], patches[5], patches[6]
        ):
            response = self.client.get(
                f"/api/visits/{VISIT_ID}/monobank/invoices/{INTENT_ID}/status"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(fake.rpc_calls), 1)
        self.assertEqual(
            fake.rpc_calls[0][1]["p_amount"],
            "2150.00",
        )
        self.assertEqual(
            fake.rpc_calls[0][1]["p_idempotency_key"],
            "monobank:mono-invoice-1",
        )
        self.assertEqual(
            response.get_json()["data"]["status"],
            "success",
        )

    def test_success_with_wrong_amount_is_not_recorded(self):
        fake = FakeSupabase([{
            "id": INTENT_ID,
            "org_id": ORG_ID,
            "visit_id": VISIT_ID,
            "provider": "monobank",
            "status": "created",
            "amount": "2150.00",
            "currency": "UAH",
            "provider_invoice_id": "mono-invoice-1",
            "page_url": "https://pay.example/invoice-1",
            "idempotency_key": "request-1",
            "finance_transaction_id": None,
        }])

        patches = self.auth_patches(fake) + (
            patch.object(
                server,
                "monobank_api_request",
                return_value={
                    "status": "success",
                    "amount": 100,
                    "ccy": 980,
                },
            ),
        )

        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            response = self.client.get(
                f"/api/visits/{VISIT_ID}/monobank/invoices/{INTENT_ID}/status"
            )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(fake.rpc_calls, [])


if __name__ == "__main__":
    unittest.main()
