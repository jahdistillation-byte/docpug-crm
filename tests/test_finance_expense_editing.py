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
TRANSACTION_ID = "33333333-3333-4333-8333-333333333333"


class EditExpenseRpc:
    def __init__(self, client, name, arguments):
        self.client = client
        self.name = name
        self.arguments = arguments

    def execute(self):
        self.client.rpc_name = self.name
        self.client.rpc_arguments = self.arguments
        self.data = {
            "transaction": {
                "id": TRANSACTION_ID,
                "transaction_type": "expense",
                "amount": 1250,
                "category": "Оренда",
            },
            "previous_amount": 1000,
        }
        return self


class EditExpenseSupabase:
    def __init__(self):
        self.rpc_name = None
        self.rpc_arguments = None

    def rpc(self, name, arguments):
        return EditExpenseRpc(
            self,
            name,
            arguments,
        )


class FinanceExpenseEditingTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.fake = EditExpenseSupabase()
        self.user_patch = patch.object(
            server,
            "get_current_user",
            return_value={
                "id": USER_ID,
                "org_id": ORG_ID,
                "role": "owner",
                "is_active": True,
            },
        )
        self.org_patch = patch.object(
            server,
            "get_current_org_id",
            return_value=ORG_ID,
        )
        self.supabase_patch = patch.object(
            server,
            "supabase",
            self.fake,
        )

        self.user_patch.start()
        self.org_patch.start()
        self.supabase_patch.start()

    def tearDown(self):
        self.supabase_patch.stop()
        self.org_patch.stop()
        self.user_patch.stop()

    def test_edit_expense_uses_scoped_atomic_rpc(self):
        response = self.client.patch(
            (
                "/api/finance/transactions/"
                f"{TRANSACTION_ID}/expense"
            ),
            json={
                "amount": 1250,
                "category": "Оренда",
                "payment_method": "transfer",
                "occurred_at": "2026-07-28T19:30",
                "counterparty": "Орендодавець",
                "description": "Оренда за липень",
                "document_url": "https://example.com/receipt",
            },
        )

        self.assertEqual(
            response.status_code,
            200,
        )
        self.assertEqual(
            self.fake.rpc_name,
            "edit_manual_expense",
        )

        arguments = (
            self.fake.rpc_arguments
        )

        self.assertEqual(
            arguments["p_org_id"],
            ORG_ID,
        )
        self.assertEqual(
            arguments["p_transaction_id"],
            TRANSACTION_ID,
        )
        self.assertEqual(
            arguments["p_user_id"],
            USER_ID,
        )
        self.assertEqual(
            arguments["p_amount"],
            1250,
        )
        self.assertEqual(
            arguments["p_category"],
            "Оренда",
        )
        self.assertEqual(
            arguments["p_payment_method"],
            "transfer",
        )
        self.assertTrue(
            arguments["p_occurred_at"]
                .endswith("+00:00")
        )

    def test_edit_expense_rejects_invalid_amount(self):
        response = self.client.patch(
            (
                "/api/finance/transactions/"
                f"{TRANSACTION_ID}/expense"
            ),
            json={
                "amount": 0,
                "category": "Оренда",
                "payment_method": "cash",
                "occurred_at": "2026-07-28T19:30",
            },
        )

        self.assertEqual(
            response.status_code,
            400,
        )
        self.assertIsNone(
            self.fake.rpc_name
        )


if __name__ == "__main__":
    unittest.main()
