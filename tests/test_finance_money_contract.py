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
IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444"


class PaymentRpc:
    def __init__(self, client, name, arguments):
        self.client = client
        self.name = name
        self.arguments = arguments

    def execute(self):
        self.client.rpc_name = self.name
        self.client.rpc_arguments = self.arguments
        self.data = {
            "idempotent_replay": True,
            "transaction_id": "payment-1",
        }
        return self


class PaymentSupabase:
    def __init__(self):
        self.rpc_name = None
        self.rpc_arguments = None

    def rpc(self, name, arguments):
        return PaymentRpc(
            self,
            name,
            arguments,
        )


class FinanceMoneyContractTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.fake = PaymentSupabase()
        self.patches = (
            patch.object(
                server,
                "get_current_user",
                return_value={
                    "id": USER_ID,
                    "org_id": ORG_ID,
                    "role": "owner",
                    "is_active": True,
                },
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value=ORG_ID,
            ),
            patch.object(
                server,
                "supabase",
                self.fake,
            ),
        )

        for active_patch in self.patches:
            active_patch.start()

    def tearDown(self):
        for active_patch in reversed(self.patches):
            active_patch.stop()

    def test_payment_sends_canonical_decimal_string_to_rpc(self):
        response = self.client.post(
            f"/api/visits/{VISIT_ID}/payments",
            json={
                "amount": "10,5",
                "payment_method": "cash",
                "idempotency_key": IDEMPOTENCY_KEY,
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.fake.rpc_name,
            "register_visit_payment",
        )
        self.assertEqual(
            self.fake.rpc_arguments["p_amount"],
            "10.50",
        )

    def test_payment_rejects_json_float(self):
        response = self.client.post(
            f"/api/visits/{VISIT_ID}/payments",
            json={
                "amount": 10.5,
                "payment_method": "cash",
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIsNone(self.fake.rpc_name)

    def test_parser_rejects_more_than_two_decimal_places(self):
        with self.assertRaises(ValueError):
            server.parse_finance_amount("10.005")

    def test_paid_visit_line_cannot_be_removed_below_net_payment(self):
        result = server.evaluate_visit_line_removal(
            {"discount_amount": "0.00"},
            [
                {
                    "qty": "1.00",
                    "price_snap": "100.00",
                },
            ],
            [
                {
                    "qty": "1.00",
                    "price_snap": "50.00",
                },
            ],
            [
                {
                    "transaction_type": "payment",
                    "status": "completed",
                    "amount": "100.00",
                },
            ],
            "60.00",
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(
            result["refund_required"],
            "10.00",
        )

    def test_refund_allows_line_removal_when_balance_is_covered(self):
        result = server.evaluate_visit_line_removal(
            {"discount_amount": "0.00"},
            [
                {
                    "qty": "1.00",
                    "price_snap": "100.00",
                },
            ],
            [
                {
                    "qty": "1.00",
                    "price_snap": "50.00",
                },
            ],
            [
                {
                    "transaction_type": "payment",
                    "status": "completed",
                    "amount": "100.00",
                },
                {
                    "transaction_type": "refund",
                    "status": "completed",
                    "amount": "20.00",
                },
            ],
            "60.00",
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(
            result["refund_required"],
            "0.00",
        )


if __name__ == "__main__":
    unittest.main()
