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
IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444"


class RefundPaymentRpc:
    def __init__(
        self,
        client,
        name,
        arguments,
    ):
        self.client = client
        self.name = name
        self.arguments = arguments

    def execute(self):
        self.client.rpc_name = self.name
        self.client.rpc_arguments = self.arguments
        self.data = {
            "transaction": {
                "id": "refund-1",
                "transaction_type": "refund",
                "amount": 40,
            },
            "payment_id": TRANSACTION_ID,
            "refund_amount": 40,
            "refundable_after": 60,
            "paid_after": 60,
            "remaining": 40,
            "financial_status": "partial",
        }
        return self


class RefundPaymentSupabase:
    def __init__(self):
        self.rpc_name = None
        self.rpc_arguments = None

    def rpc(
        self,
        name,
        arguments,
    ):
        return RefundPaymentRpc(
            self,
            name,
            arguments,
        )


class FinancePaymentRefundTests(
    unittest.TestCase
):
    def setUp(self):
        self.client = (
            server.app.test_client()
        )
        self.fake = (
            RefundPaymentSupabase()
        )
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

    def test_refund_payment_uses_scoped_atomic_rpc(
        self,
    ):
        response = self.client.post(
            (
                "/api/finance/transactions/"
                f"{TRANSACTION_ID}/refund"
            ),
            json={
                "amount": 40,
                "reason": "Переплата клієнта",
                "idempotency_key":
                    IDEMPOTENCY_KEY,
            },
        )

        self.assertEqual(
            response.status_code,
            200,
        )
        self.assertEqual(
            self.fake.rpc_name,
            "refund_visit_payment",
        )
        self.assertEqual(
            self.fake.rpc_arguments,
            {
                "p_org_id": ORG_ID,
                "p_transaction_id":
                    TRANSACTION_ID,
                "p_user_id": USER_ID,
                "p_amount": 40.0,
                "p_reason":
                    "Переплата клієнта",
                "p_idempotency_key":
                    IDEMPOTENCY_KEY,
            },
        )

    def test_refund_payment_requires_reason(
        self,
    ):
        response = self.client.post(
            (
                "/api/finance/transactions/"
                f"{TRANSACTION_ID}/refund"
            ),
            json={
                "amount": 40,
                "reason": " ",
            },
        )

        self.assertEqual(
            response.status_code,
            400,
        )
        self.assertIsNone(
            self.fake.rpc_name
        )

    def test_refund_payment_rejects_invalid_amount(
        self,
    ):
        response = self.client.post(
            (
                "/api/finance/transactions/"
                f"{TRANSACTION_ID}/refund"
            ),
            json={
                "amount": 0,
                "reason": "Помилка",
            },
        )

        self.assertEqual(
            response.status_code,
            400,
        )
        self.assertIsNone(
            self.fake.rpc_name
        )

    def test_refund_payment_rejects_invalid_id(
        self,
    ):
        response = self.client.post(
            (
                "/api/finance/transactions/"
                "not-a-uuid/refund"
            ),
            json={
                "amount": 40,
                "reason": "Помилка",
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
