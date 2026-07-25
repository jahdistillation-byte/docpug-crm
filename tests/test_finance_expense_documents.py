import os
import io
import unittest
import uuid
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
DOCUMENT_ID = "33333333-3333-4333-8333-333333333333"
ACCOUNT_ID = "44444444-4444-4444-8444-444444444444"
IDEMPOTENCY_KEY = "55555555-5555-4555-8555-555555555555"
TEMPLATE_ID = "66666666-6666-4666-8666-666666666666"
ATTACHMENT_ID = "77777777-7777-4777-8777-777777777777"


class FakeResult:
    def __init__(self, data=None):
        self.data = data


class FakeQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.operations = []

    def _record(self, operation, *arguments, **kwargs):
        self.operations.append(
            (operation, arguments, kwargs)
        )
        return self

    def select(self, *args, **kwargs):
        return self._record("select", *args, **kwargs)

    def eq(self, *args, **kwargs):
        return self._record("eq", *args, **kwargs)

    def gte(self, *args, **kwargs):
        return self._record("gte", *args, **kwargs)

    def lte(self, *args, **kwargs):
        return self._record("lte", *args, **kwargs)

    def or_(self, *args, **kwargs):
        return self._record("or_", *args, **kwargs)

    def is_(self, *args, **kwargs):
        return self._record("is_", *args, **kwargs)

    def order(self, *args, **kwargs):
        return self._record("order", *args, **kwargs)

    def range(self, *args, **kwargs):
        return self._record("range", *args, **kwargs)

    def limit(self, *args, **kwargs):
        return self._record("limit", *args, **kwargs)

    def insert(self, *args, **kwargs):
        return self._record("insert", *args, **kwargs)

    def update(self, *args, **kwargs):
        return self._record("update", *args, **kwargs)

    def delete(self, *args, **kwargs):
        return self._record("delete", *args, **kwargs)

    def execute(self):
        self.client.queries.append(self)
        response = self.client.table_results.get(
            self.table_name,
            [],
        )

        if isinstance(response, Exception):
            raise response

        if callable(response):
            response = response(self)

        return FakeResult(response)


class FakeRpcQuery:
    def __init__(self, client, name, arguments):
        self.client = client
        self.name = name
        self.arguments = arguments

    def execute(self):
        self.client.rpc_calls.append(
            (self.name, self.arguments)
        )
        response = self.client.rpc_results.get(
            self.name,
            {},
        )

        if isinstance(response, Exception):
            raise response

        if callable(response):
            response = response(
                self.arguments
            )

        return FakeResult(response)


class FakeSupabase:
    def __init__(
        self,
        *,
        table_results=None,
        rpc_results=None,
        storage=None,
    ):
        self.table_results = (
            table_results or {}
        )
        self.rpc_results = (
            rpc_results or {}
        )
        self.queries = []
        self.rpc_calls = []
        self.storage = (
            storage or FakeStorage()
        )

    def table(self, table_name):
        return FakeQuery(
            self,
            table_name,
        )

    def rpc(self, name, arguments):
        return FakeRpcQuery(
            self,
            name,
            arguments,
        )


class FakeStorageBucket:
    def __init__(self, storage, name):
        self.storage = storage
        self.name = name

    def upload(self, path, content, options):
        self.storage.uploads.append({
            "bucket": self.name,
            "path": path,
            "content": content,
            "options": options,
        })
        return {"path": path}

    def create_signed_url(self, path, expires_in):
        self.storage.signed_calls.append({
            "bucket": self.name,
            "path": path,
            "expires_in": expires_in,
        })
        return {
            "signedURL": (
                "https://signed.example/"
                + path
            ),
        }

    def remove(self, paths):
        self.storage.removals.append({
            "bucket": self.name,
            "paths": paths,
        })
        return {}


class FakeStorage:
    def __init__(self):
        self.uploads = []
        self.signed_calls = []
        self.removals = []

    def from_(self, name):
        return FakeStorageBucket(
            self,
            name,
        )


class ExpenseDocumentApiTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.owner = {
            "id": USER_ID,
            "org_id": ORG_ID,
            "role": "owner",
            "is_active": True,
        }

    def request_context(self, fake_supabase, user=None):
        return (
            patch.object(
                server,
                "get_current_user",
                return_value=(
                    user or self.owner
                ),
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value=ORG_ID,
            ),
            patch.object(
                server,
                "supabase",
                fake_supabase,
            ),
        )

    def valid_create_payload(self, **overrides):
        payload = {
            "idempotency_key": (
                IDEMPOTENCY_KEY
            ),
            "status": "planned",
            "amount": "123.40",
            "category": "Оренда",
            "expense_date": "2026-07-21",
        }
        payload.update(overrides)
        return payload

    def test_create_passes_decimal_string_and_session_org_to_rpc(self):
        fake = FakeSupabase(
            rpc_results={
                "create_expense_document": {
                    "document": {
                        "id": DOCUMENT_ID,
                        "amount": 123.4,
                    },
                    "idempotent_replay": False,
                },
            }
        )

        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents",
                json=self.valid_create_payload(),
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            fake.rpc_calls[0][0],
            "create_expense_document",
        )
        rpc_payload = fake.rpc_calls[0][1]
        self.assertEqual(
            rpc_payload["p_org_id"],
            ORG_ID,
        )
        self.assertEqual(
            rpc_payload["p_amount"],
            "123.40",
        )
        self.assertIsInstance(
            rpc_payload["p_amount"],
            str,
        )
        self.assertEqual(
            response.get_json()["data"]
            ["document"]["amount"],
            "123.40",
        )

    def test_create_replay_returns_http_200(self):
        fake = FakeSupabase(
            rpc_results={
                "create_expense_document": {
                    "document": {
                        "amount": "10.00",
                    },
                    "idempotent_replay": True,
                },
            }
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents",
                json=self.valid_create_payload(
                    amount="10.00"
                ),
            )

        self.assertEqual(response.status_code, 200)

    def test_money_input_rejects_unsafe_encodings(self):
        invalid_values = (
            12.34,
            12,
            "1e2",
            "NaN",
            "Infinity",
            "1.001",
            "0.00",
            "-1.00",
            "1,00",
            "1000000000.01",
        )

        for value in invalid_values:
            with self.subTest(value=value):
                fake = FakeSupabase()
                contexts = self.request_context(
                    fake
                )

                with (
                    contexts[0],
                    contexts[1],
                    contexts[2],
                ):
                    response = self.client.post(
                        "/api/finance/expense-documents",
                        json=self.valid_create_payload(
                            amount=value
                        ),
                    )

                self.assertEqual(
                    response.status_code,
                    400,
                )
                self.assertEqual(
                    fake.rpc_calls,
                    [],
                )

    def test_paid_create_requires_account_and_method(self):
        fake = FakeSupabase()
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents",
                json=self.valid_create_payload(
                    status="paid"
                ),
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(fake.rpc_calls, [])

    def test_reserved_accounting_categories_are_rejected(self):
        for category in (
            "Закупівля препаратів",
            "Зарплата",
            "payroll",
            "supplier payment",
        ):
            with self.subTest(category=category):
                fake = FakeSupabase()
                contexts = self.request_context(
                    fake
                )

                with (
                    contexts[0],
                    contexts[1],
                    contexts[2],
                ):
                    response = self.client.post(
                        "/api/finance/expense-documents",
                        json=self.valid_create_payload(
                            category=category
                        ),
                    )

                self.assertEqual(
                    response.status_code,
                    400,
                )
                self.assertEqual(
                    fake.rpc_calls,
                    [],
                )

    def test_marketing_counts_and_decimal_revenue_are_validated(self):
        fake = FakeSupabase()
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents",
                json=self.valid_create_payload(
                    category="Маркетинг",
                    marketing={
                        "leads": 2,
                        "new_clients": 3,
                        "revenue": "10.00",
                    },
                ),
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(fake.rpc_calls, [])

    def test_non_manager_cannot_access_expenses(self):
        fake = FakeSupabase()
        vet = {
            **self.owner,
            "role": "vet",
        }
        contexts = self.request_context(
            fake,
            user=vet,
        )

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.get(
                "/api/finance/expense-documents"
            )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(fake.queries, [])

    def test_list_scopes_table_and_overview_to_session_org(self):
        fake = FakeSupabase(
            table_results={
                "expense_documents": [{
                    "id": DOCUMENT_ID,
                    "amount": 12.5,
                    "marketing_revenue": 25,
                    "marketing_leads": 2,
                    "attachment_rows": [
                        {
                            "id": ATTACHMENT_ID,
                            "deleted_at": None,
                        },
                        {
                            "id": str(uuid.uuid4()),
                            "deleted_at": (
                                "2026-07-21T10:00:00Z"
                            ),
                        },
                    ],
                }],
            },
            rpc_results={
                "get_expense_documents_overview": {
                    "summary": {
                        "paid_amount": 12.5,
                        "documents_count": 1,
                    },
                    "marketing": {
                        "spend": 12.5,
                        "revenue": 25,
                        "cpl": 6.25,
                        "cac": None,
                        "roas": 2,
                    },
                },
            },
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.get(
                "/api/finance/expense-documents"
                "?date_from=2026-07-01"
                "&date_to=2026-07-31"
            )

        self.assertEqual(response.status_code, 200)
        document_query = fake.queries[0]
        self.assertIn(
            ("eq", ("org_id", ORG_ID), {}),
            document_query.operations,
        )
        self.assertEqual(
            fake.rpc_calls[0][1]["p_org_id"],
            ORG_ID,
        )
        data = response.get_json()["data"]
        self.assertEqual(
            data["items"][0]["amount"],
            "12.50",
        )
        self.assertEqual(
            data["items"][0]
            ["attachments_count"],
            1,
        )
        self.assertNotIn(
            "attachment_rows",
            data["items"][0],
        )
        self.assertEqual(
            data["summary"]["paid_amount"],
            "12.50",
        )
        self.assertEqual(
            data["marketing"]["roas"],
            "2.00",
        )

    def test_paid_document_rejects_financial_patch(self):
        fake = FakeSupabase(
            table_results={
                "expense_documents": [{
                    "id": DOCUMENT_ID,
                    "org_id": ORG_ID,
                    "status": "paid",
                    "category": "Оренда",
                    "expense_date": "2026-07-21",
                    "version": 1,
                }],
            }
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.patch(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID,
                json={
                    "version": 1,
                    "amount": "200.00",
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(fake.rpc_calls, [])

    def test_paid_document_allows_metadata_patch_via_rpc(self):
        fake = FakeSupabase(
            table_results={
                "expense_documents": [{
                    "id": DOCUMENT_ID,
                    "org_id": ORG_ID,
                    "status": "paid",
                    "category": "Маркетинг",
                    "expense_date": "2026-07-21",
                    "version": 2,
                }],
            },
            rpc_results={
                "update_expense_document": {
                    "document": {
                        "id": DOCUMENT_ID,
                        "amount": 100,
                        "description": "Updated",
                    },
                },
            },
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.patch(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID,
                json={
                    "version": 2,
                    "description": "Updated",
                    "marketing": {
                        "leads": 5,
                        "new_clients": 2,
                        "revenue": "300.00",
                    },
                },
            )

        self.assertEqual(response.status_code, 200)
        rpc_name, rpc_payload = fake.rpc_calls[0]
        self.assertEqual(
            rpc_name,
            "update_expense_document",
        )
        self.assertEqual(
            rpc_payload["p_patch"]
            ["description"],
            "Updated",
        )
        self.assertNotIn(
            "amount",
            rpc_payload["p_patch"],
        )
        self.assertNotIn(
            "marketing",
            rpc_payload["p_patch"],
        )
        self.assertEqual(
            rpc_payload["p_patch"]
            ["marketing_campaign"],
            None,
        )
        self.assertEqual(
            rpc_payload["p_patch"]
            ["marketing_leads"],
            5,
        )
        self.assertEqual(
            rpc_payload["p_patch"]
            ["marketing_new_clients"],
            2,
        )
        self.assertEqual(
            rpc_payload["p_patch"]
            ["marketing_revenue"],
            "300.00",
        )

    def test_patch_rejects_blank_document_number(self):
        fake = FakeSupabase(
            table_results={
                "expense_documents": [{
                    "id": DOCUMENT_ID,
                    "org_id": ORG_ID,
                    "status": "planned",
                    "category": "Оренда",
                    "expense_date": "2026-07-21",
                    "version": 1,
                }],
            }
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.patch(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID,
                json={
                    "version": 1,
                    "document_number": "   ",
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(fake.rpc_calls, [])

    def test_cancel_and_reverse_use_lifecycle_rpcs(self):
        scenarios = (
            (
                "cancel",
                "cancel_expense_document",
                {
                    "version": 1,
                    "reason": "Duplicate",
                },
            ),
            (
                "reverse",
                "reverse_expense_document",
                {
                    "version": 2,
                    "reason": "Refund",
                    "idempotency_key": (
                        IDEMPOTENCY_KEY
                    ),
                },
            ),
        )

        for suffix, rpc_name, payload in scenarios:
            with self.subTest(action=suffix):
                fake = FakeSupabase(
                    rpc_results={
                        rpc_name: {
                            "document": {
                                "id": DOCUMENT_ID,
                                "amount": 10,
                            },
                        },
                    }
                )
                contexts = self.request_context(
                    fake
                )

                with (
                    contexts[0],
                    contexts[1],
                    contexts[2],
                ):
                    response = self.client.post(
                        "/api/finance/expense-documents/"
                        + DOCUMENT_ID
                        + "/"
                        + suffix,
                        json=payload,
                    )

                self.assertEqual(
                    response.status_code,
                    200,
                )
                self.assertEqual(
                    fake.rpc_calls[0][0],
                    rpc_name,
                )
                self.assertEqual(
                    fake.rpc_calls[0][1]
                    ["p_org_id"],
                    ORG_ID,
                )

    def test_document_card_hides_private_storage_metadata(self):
        fake = FakeSupabase(
            table_results={
                "expense_documents": [{
                    "id": DOCUMENT_ID,
                    "org_id": ORG_ID,
                    "status": "paid",
                    "amount": 10,
                    "financial_account": {
                        "name": "Банківський рахунок",
                        "account_type": "bank",
                    },
                }],
                "finance_documents": [{
                    "id": ATTACHMENT_ID,
                    "expense_document_id": (
                        DOCUMENT_ID
                    ),
                    "storage_bucket": (
                        "finance-documents"
                    ),
                    "storage_path": "secret/path",
                    "checksum_sha256": "a" * 64,
                    "original_name": "invoice.pdf",
                    "mime_type": "application/pdf",
                    "size_bytes": 42,
                }],
                "finance_audit_log": [{
                    "action": "paid",
                    "entity_id": DOCUMENT_ID,
                }],
            }
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.get(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID
            )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()["data"]
        self.assertEqual(
            data["document"]["amount"],
            "10.00",
        )
        self.assertEqual(
            data["document"]
            ["financial_account"]["name"],
            "Банківський рахунок",
        )
        attachment = data["attachments"][0]
        self.assertNotIn("storage_path", attachment)
        self.assertNotIn("storage_bucket", attachment)
        self.assertNotIn(
            "checksum_sha256",
            attachment,
        )

    def test_pay_uses_atomic_rpc_with_idempotency_and_version(self):
        fake = FakeSupabase(
            rpc_results={
                "pay_expense_document": {
                    "document": {
                        "id": DOCUMENT_ID,
                        "amount": 50,
                        "status": "paid",
                    },
                    "idempotent_replay": False,
                },
            }
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID
                + "/pay",
                json={
                    "version": 3,
                    "idempotency_key": (
                        IDEMPOTENCY_KEY
                    ),
                    "payment_method": "cash",
                    "financial_account_id": (
                        ACCOUNT_ID
                    ),
                    "paid_date": "2026-07-21",
                },
            )

        self.assertEqual(response.status_code, 200)
        rpc_name, rpc_payload = (
            fake.rpc_calls[0]
        )
        self.assertEqual(
            rpc_name,
            "pay_expense_document",
        )
        self.assertEqual(
            rpc_payload["p_org_id"],
            ORG_ID,
        )
        self.assertEqual(
            rpc_payload["p_version"],
            3,
        )
        self.assertEqual(
            rpc_payload[
                "p_idempotency_key"
            ],
            IDEMPOTENCY_KEY,
        )

    def test_database_error_is_not_returned_to_client(self):
        fake = FakeSupabase(
            rpc_results={
                "create_expense_document": (
                    RuntimeError(
                        "secret database row details"
                    )
                ),
            }
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents",
                json=self.valid_create_payload(),
            )

        self.assertEqual(response.status_code, 500)
        self.assertNotIn(
            "secret database row details",
            response.get_data(as_text=True),
        )

    def test_legacy_manual_expense_cannot_bypass_documents(self):
        fake = FakeSupabase()
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/transactions",
                json={
                    "transaction_type": "expense",
                    "amount": "10.00",
                },
            )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(fake.queries, [])

    def test_recurring_template_create_uses_decimal_strings(self):
        fake = FakeSupabase(
            rpc_results={
                "create_recurring_expense_template": {
                    "template": {
                        "id": TEMPLATE_ID,
                        "amount": 75,
                    },
                },
            }
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/recurring-expense-templates",
                json={
                    "idempotency_key": (
                        IDEMPOTENCY_KEY
                    ),
                    "name": "Оренда",
                    "amount": "75.00",
                    "category": "Оренда",
                    "frequency": "quarterly",
                    "next_due_date": "2026-07-31",
                },
            )

        self.assertEqual(response.status_code, 201)
        rpc_name, rpc_payload = fake.rpc_calls[0]
        self.assertEqual(
            rpc_name,
            "create_recurring_expense_template",
        )
        template = rpc_payload["p_template"]
        self.assertEqual(template["amount"], "75.00")
        self.assertEqual(template["interval_months"], 3)
        self.assertEqual(template["day_of_month"], 31)
        self.assertEqual(
            response.get_json()["data"]
            ["template"]["amount"],
            "75.00",
        )

    def test_recurring_confirmation_creates_document_via_rpc(self):
        fake = FakeSupabase(
            rpc_results={
                "confirm_recurring_expense_template": {
                    "document": {
                        "amount": 20,
                        "status": "planned",
                    },
                },
            }
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/recurring-expense-templates/"
                + TEMPLATE_ID
                + "/confirm",
                json={
                    "idempotency_key": (
                        IDEMPOTENCY_KEY
                    ),
                    "expense_date": "2026-07-21",
                    "due_date": "2026-07-31",
                },
            )

        self.assertEqual(response.status_code, 200)
        rpc_name, rpc_payload = fake.rpc_calls[0]
        self.assertEqual(
            rpc_name,
            "confirm_recurring_expense_template",
        )
        self.assertEqual(
            rpc_payload["p_org_id"],
            ORG_ID,
        )

    def test_recurring_template_name_matches_database_limit(self):
        fake = FakeSupabase()
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/recurring-expense-templates",
                json={
                    "idempotency_key": (
                        IDEMPOTENCY_KEY
                    ),
                    "name": "A" * 151,
                    "amount": "75.00",
                    "category": "Оренда",
                    "frequency": "monthly",
                    "next_due_date": "2026-07-31",
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(fake.rpc_calls, [])

    def test_private_attachment_validates_magic_and_stores_metadata(self):
        storage = FakeStorage()
        fake = FakeSupabase(
            table_results={
                "expense_documents": [{
                    "id": DOCUMENT_ID,
                    "org_id": ORG_ID,
                    "status": "planned",
                }],
                "finance_documents": [{
                    "id": ATTACHMENT_ID,
                    "expense_document_id": (
                        DOCUMENT_ID
                    ),
                    "original_name": "invoice.pdf",
                    "mime_type": "application/pdf",
                    "size_bytes": 14,
                    "uploaded_by": USER_ID,
                }],
            },
            storage=storage,
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID
                + "/attachments",
                data={
                    "file": (
                        io.BytesIO(
                            b"%PDF-1.7\nbody"
                        ),
                        "invoice.pdf",
                        "application/pdf",
                    ),
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(storage.uploads), 1)
        upload = storage.uploads[0]
        self.assertEqual(
            upload["bucket"],
            "finance-documents",
        )
        self.assertTrue(
            upload["path"].startswith(
                f"{ORG_ID}/{DOCUMENT_ID}/"
            )
        )
        metadata_query = fake.queries[-1]
        insert_operations = [
            operation
            for operation
            in metadata_query.operations
            if operation[0] == "insert"
        ]
        metadata = insert_operations[0][1][0]
        self.assertEqual(
            metadata["checksum_sha256"],
            server.hashlib.sha256(
                b"%PDF-1.7\nbody"
            ).hexdigest(),
        )
        self.assertNotIn(
            "storage_path",
            response.get_json()["data"]
            ["attachment"],
        )

    def test_attachment_recovers_committed_metadata_after_lost_response(self):
        storage = FakeStorage()

        def finance_documents_result(query):
            insert_operations = [
                operation
                for operation in query.operations
                if operation[0] == "insert"
            ]

            if insert_operations:
                raise RuntimeError(
                    "insert response lost"
                )

            attachment_id = next(
                operation[1][1]
                for operation in query.operations
                if (
                    operation[0] == "eq"
                    and operation[1][0] == "id"
                )
            )

            return [{
                "id": attachment_id,
                "expense_document_id": (
                    DOCUMENT_ID
                ),
                "original_name": "invoice.pdf",
                "mime_type": "application/pdf",
                "size_bytes": 14,
                "uploaded_by": USER_ID,
            }]

        fake = FakeSupabase(
            table_results={
                "expense_documents": [{
                    "id": DOCUMENT_ID,
                    "org_id": ORG_ID,
                    "status": "planned",
                }],
                "finance_documents": (
                    finance_documents_result
                ),
            },
            storage=storage,
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID
                + "/attachments",
                data={
                    "file": (
                        io.BytesIO(
                            b"%PDF-1.7\nbody"
                        ),
                        "invoice.pdf",
                        "application/pdf",
                    ),
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(storage.removals, [])
        insert_query = fake.queries[1]
        inserted = next(
            operation[1][0]
            for operation
            in insert_query.operations
            if operation[0] == "insert"
        )
        self.assertEqual(
            response.get_json()["data"]
            ["attachment"]["id"],
            inserted["id"],
        )
        self.assertIn(
            inserted["id"],
            inserted["storage_path"],
        )

    def test_attachment_removes_object_only_after_confirmed_missing_metadata(self):
        storage = FakeStorage()

        def finance_documents_result(query):
            if any(
                operation[0] == "insert"
                for operation in query.operations
            ):
                raise RuntimeError(
                    "insert failed before commit"
                )

            return []

        fake = FakeSupabase(
            table_results={
                "expense_documents": [{
                    "id": DOCUMENT_ID,
                    "org_id": ORG_ID,
                    "status": "planned",
                }],
                "finance_documents": (
                    finance_documents_result
                ),
            },
            storage=storage,
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID
                + "/attachments",
                data={
                    "file": (
                        io.BytesIO(
                            b"%PDF-1.7\nbody"
                        ),
                        "invoice.pdf",
                        "application/pdf",
                    ),
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(len(storage.removals), 1)
        self.assertEqual(
            storage.removals[0]["paths"],
            [storage.uploads[0]["path"]],
        )

    def test_attachment_rejects_html_disguised_as_pdf(self):
        fake = FakeSupabase()
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID
                + "/attachments",
                data={
                    "file": (
                        io.BytesIO(b"<html>bad</html>"),
                        "invoice.pdf",
                        "application/pdf",
                    ),
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            fake.storage.uploads,
            [],
        )

    def test_attachment_download_is_org_and_document_scoped(self):
        storage_path = (
            f"{ORG_ID}/{DOCUMENT_ID}/file.pdf"
        )
        storage = FakeStorage()
        fake = FakeSupabase(
            table_results={
                "finance_documents": [{
                    "id": ATTACHMENT_ID,
                    "org_id": ORG_ID,
                    "expense_document_id": (
                        DOCUMENT_ID
                    ),
                    "storage_bucket": (
                        "finance-documents"
                    ),
                    "storage_path": storage_path,
                    "deleted_at": None,
                }],
            },
            storage=storage,
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.get(
                "/api/finance/expense-documents/"
                + DOCUMENT_ID
                + "/attachments/"
                + ATTACHMENT_ID
                + "/download"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["data"]
            ["expires_in"],
            300,
        )
        query = fake.queries[0]
        self.assertIn(
            ("eq", ("org_id", ORG_ID), {}),
            query.operations,
        )
        self.assertIn(
            (
                "eq",
                (
                    "expense_document_id",
                    DOCUMENT_ID,
                ),
                {},
            ),
            query.operations,
        )

    def test_visit_payment_requires_decimal_string(self):
        fake = FakeSupabase()
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.post(
                "/api/visits/"
                + DOCUMENT_ID
                + "/payments",
                json={
                    "amount": 10.0,
                    "payment_method": "cash",
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(fake.rpc_calls, [])

    def test_finance_overview_normalizes_zero_amounts(self):
        fake = FakeSupabase(
            rpc_results={
                "get_finance_overview": {
                    "total_expenses": 0,
                    "paid_total": 12.5,
                    "documents_count": 2,
                },
            }
        )
        contexts = self.request_context(fake)

        with contexts[0], contexts[1], contexts[2]:
            response = self.client.get(
                "/api/finance/overview"
                "?date_from=2026-07-01"
                "&date_to=2026-07-31"
            )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()["data"]
        self.assertEqual(
            data["total_expenses"],
            "0.00",
        )
        self.assertEqual(
            data["paid_total"],
            "12.50",
        )


class FinanceDecimalHelperTests(unittest.TestCase):
    def test_expense_rpc_errors_use_expected_http_semantics(self):
        scenarios = (
            (
                "only planned expense can be paid",
                409,
            ),
            (
                "only paid expense can be reversed",
                409,
            ),
            (
                "financial account not found or inactive",
                400,
            ),
            (
                "idempotency key belongs to another document",
                409,
            ),
        )

        with server.app.test_request_context():
            for message, expected_status in scenarios:
                with self.subTest(message=message):
                    _, status = (
                        server.expense_rpc_error_response(
                            RuntimeError(message),
                            "fallback",
                        )
                    )
                    self.assertEqual(
                        status,
                        expected_status,
                    )

    def test_finance_decimal_string_is_fixed_and_never_float(self):
        result = server.normalize_finance_response({
            "amount": 0.1,
            "paid_amount": "12.5",
            "cpl": 1,
            "leads": "3",
        })

        self.assertEqual(result["amount"], "0.10")
        self.assertEqual(
            result["paid_amount"],
            "12.50",
        )
        self.assertEqual(result["cpl"], "1.00")
        self.assertEqual(result["leads"], 3)

    def test_document_marketing_metrics_are_decimal_strings(self):
        result = server.serialize_expense_document({
            "id": DOCUMENT_ID,
            "category": "Маркетинг",
            "amount": "100.00",
            "marketing_leads": 4,
            "marketing_new_clients": 2,
            "marketing_revenue": "300.00",
        })

        marketing = result["marketing"]
        self.assertEqual(marketing["cpl"], "25.00")
        self.assertEqual(marketing["cac"], "50.00")
        self.assertEqual(marketing["roas"], "3.00")
        self.assertIsInstance(marketing["cpl"], str)
        self.assertIsInstance(marketing["cac"], str)
        self.assertIsInstance(marketing["roas"], str)

    def test_non_marketing_document_has_no_marketing_ratios(self):
        result = server.serialize_expense_document({
            "id": DOCUMENT_ID,
            "category": "Оренда",
            "amount": "100.00",
        })

        self.assertIsNone(result["marketing"]["cpl"])
        self.assertIsNone(result["marketing"]["cac"])
        self.assertIsNone(result["marketing"]["roas"])

    def test_float_finance_number_helper_is_removed(self):
        self.assertFalse(
            hasattr(server, "finance_number")
        )


if __name__ == "__main__":
    unittest.main()
