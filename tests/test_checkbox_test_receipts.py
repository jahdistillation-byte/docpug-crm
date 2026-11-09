import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service-key")
os.environ.setdefault("SESSION_SECRET_KEY", "test-session-secret")

import server
from checkbox_client import CheckboxError, CheckboxTestClient, sale_payload


VISIT = "11111111-1111-4111-8111-111111111111"
REGISTER = "22222222-2222-4222-8222-222222222222"
PAYMENT = "33333333-3333-4333-8333-333333333333"
REFUND = "44444444-4444-4444-8444-444444444444"


class CheckboxTestReceipts(unittest.TestCase):
    def test_rejects_live_register_even_with_test_prefixed_key(self):
        client = CheckboxTestClient("test-example", "1234")
        with patch.object(client, "request", side_effect=[
            {"access_token": "token"}, {"id": REGISTER, "is_test": False}
        ]) as request:
            with self.assertRaisesRegex(CheckboxError, "тестова"):
                client.connect()
            self.assertEqual([call.args[:2] for call in request.call_args_list], [
                ("POST", "cashier/signinPinCode"), ("GET", "cash-registers/info")
            ])

    def test_requires_cashiers_shift_to_match_connected_register(self):
        client = CheckboxTestClient("test-example", "1234")
        client.register = {"id": REGISTER}
        with patch.object(client, "request", return_value={
            "status": "OPENED", "cash_register": {"id": "other"}
        }):
            with self.assertRaisesRegex(CheckboxError, "іншій касі"):
                client.change_shift("close")

    def test_fractional_quantities_discount_and_exact_amount(self):
        lines = [("service-1", {"name_snap": "Огляд", "price_snap": "50", "qty": "1"}),
                 ("stock-1", {"name_snap": "Матеріал", "price_snap": "25.50", "qty": "0.5"})]
        payload = sale_payload(lines, "60.75", "2.00", "card")
        self.assertEqual(payload["goods"][1]["quantity"], 500)
        self.assertEqual(payload["payments"], [{"type": "CASHLESS", "value": 6075}])
        self.assertEqual(payload["discounts"][0]["value"], 200)
        with self.assertRaises(CheckboxError):
            sale_payload(lines, "60.74", "2.00", "card")

    def test_return_uses_original_goods_and_cannot_partially_refund(self):
        sale = sale_payload([("1", {"name_snap": "Огляд", "price_snap": 50, "qty": 1})], 50, 0, "cash")
        receipts = [{"transaction_id": PAYMENT, "status": "DONE", "kind": "sell", "receipt_id": "sale",
                     "register_id": REGISTER, "payload": sale}]
        row = {"transaction_type": "refund", "currency": "UAH", "status": "completed",
               "amount": 50, "reverses_transaction_id": PAYMENT}
        kind, payload, register = server.checkbox_visit_payload("org", VISIT, row, [], receipts)
        self.assertEqual((kind, register, payload["related_receipt_id"]), ("return", REGISTER, "sale"))
        self.assertTrue(payload["goods"][0]["is_return"])
        self.assertNotIn("is_return", sale["goods"][0])
        with self.assertRaises(CheckboxError):
            server.checkbox_visit_payload("org", VISIT, {**row, "amount": 25}, [], receipts)

    def test_timeout_then_reconcile_same_receipt_without_second_post(self):
        row = {"id": PAYMENT, "transaction_type": "payment", "status": "completed", "amount": 50}
        payload = {"payments": [{"value": 5000}], "goods": []}
        stored = []
        db = MagicMock()
        query = db.table.return_value
        query.upsert.side_effect = lambda receipt, **kwargs: (
            stored.append({**receipt, "status": "PENDING"}) or SimpleNamespace(execute=lambda: None)
        )
        query.update.return_value.eq.return_value.eq.return_value.eq.return_value.execute.return_value = None
        provider = MagicMock()
        provider.register = {"id": REGISTER}
        provider.shift.return_value = {"status": "OPENED"}
        def provider_request(method, path, data=None, **kwargs):
            if method == "POST":
                self.assertEqual(data["id"], stored[0]["receipt_id"])
                raise CheckboxError("Немає підтвердження", 502)
            return {"id": stored[0]["receipt_id"], "status": "DONE", "type": "SELL",
                    "total_sum": 5000, "fiscal_code": "TEST-1"}
        provider.request.side_effect = provider_request
        with patch.multiple(server, supabase=db), \
             patch.object(server, "get_current_user", return_value={"id": "user", "org_id": "org", "role": "owner", "is_active": True}), \
             patch.object(server, "get_current_org_id", return_value="org"), \
             patch.object(server, "checkbox_visit_transactions", return_value=[row]), \
             patch.object(server, "checkbox_visit_receipts", side_effect=lambda *_: stored), \
             patch.object(server, "checkbox_visit_payload", return_value=("sell", payload, None)), \
             patch.object(server, "checkbox_connected_client", return_value=provider):
            client = server.app.test_client()
            url = f"/api/visits/{VISIT}/checkbox"
            self.assertEqual(client.post(url, json={"transaction_id": PAYMENT}).status_code, 502)
            result = client.post(url, json={"transaction_id": PAYMENT, "check_only": True})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json["data"]["status"], "DONE")
            self.assertEqual([call.args[0] for call in provider.request.call_args_list], ["POST", "GET"])
            self.assertEqual(query.upsert.call_count, 1)


if __name__ == "__main__":
    unittest.main()
