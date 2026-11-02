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
STOCK_ID = "22222222-2222-4222-8222-222222222222"


class StockInsightsQuery:
    def __init__(
        self,
        table_name,
    ):
        self.table_name = table_name

    def select(self, *_args):
        return self

    def eq(self, *_args):
        return self

    def gte(self, *_args):
        return self

    def order(self, *_args):
        return self

    def execute(self):
        if self.table_name == "stock":
            self.data = [
                {
                    "id": STOCK_ID,
                    "org_id": ORG_ID,
                    "name": "Вакцина",
                    "unit": "фл",
                    "qty": 10,
                    "minimum_qty": 2,
                    "purchase_price": 100,
                    "expiry_date": "2026-09-01",
                    "batch_number": "LOT-42",
                    "active": True,
                }
            ]
        else:
            self.data = [
                {
                    "stock_id": STOCK_ID,
                    "quantity": 12,
                },
                {
                    "stock_id": STOCK_ID,
                    "quantity": 18,
                },
            ]

        return self


class StockInsightsSupabase:
    def table(self, table_name):
        return StockInsightsQuery(
            table_name
        )


class StockMutationQuery:
    def __init__(
        self,
        client,
        table_name,
    ):
        self.client = client
        self.table_name = table_name
        self.operation = "select"
        self.payload = None

    def select(self, *_args):
        self.operation = "select"
        return self

    def update(self, payload):
        self.operation = "update"
        self.payload = dict(payload)
        self.client.updated_payloads.append(
            self.payload
        )
        return self

    def eq(self, *_args):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        if self.table_name != "stock":
            self.data = []
            return self

        if self.operation == "select":
            self.data = [
                dict(self.client.stock_item)
            ]
            return self

        if self.client.conflict_on_update:
            self.data = []
            return self

        updated = {
            **self.client.stock_item,
            **(self.payload or {}),
        }
        self.data = [updated]
        return self


class StockMutationSupabase:
    def __init__(
        self,
        *,
        conflict_on_update=False,
    ):
        self.conflict_on_update = (
            conflict_on_update
        )
        self.updated_payloads = []
        self.stock_item = {
            "id": STOCK_ID,
            "org_id": ORG_ID,
            "name": "Вакцина",
            "unit": "фл",
            "qty": 10,
            "price": 250,
            "purchase_price": 100,
            "minimum_qty": 2,
            "active": True,
        }

    def table(self, table_name):
        return StockMutationQuery(
            self,
            table_name,
        )


class StockDeleteConflictQuery:
    def delete(self):
        return self

    def eq(self, *_args):
        return self

    def execute(self):
        raise RuntimeError(
            "23503 foreign key violation"
        )


class StockDeleteConflictSupabase:
    def table(self, _table_name):
        return StockDeleteConflictQuery()


class StockPugInsightsTests(
    unittest.TestCase
):
    def setUp(self):
        self.client = (
            server.app.test_client()
        )
        self.user_patch = patch.object(
            server,
            "get_current_user",
            return_value={
                "id": "user-1",
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

        self.user_patch.start()
        self.org_patch.start()

    def tearDown(self):
        self.org_patch.stop()
        self.user_patch.stop()

    def test_stock_list_contains_deterministic_usage_forecast(
        self,
    ):
        with patch.object(
            server,
            "supabase",
            StockInsightsSupabase(),
        ):
            response = self.client.get(
                "/api/stock"
            )

        self.assertEqual(
            response.status_code,
            200,
        )

        item = (
            response
            .get_json()["data"][0]
        )

        self.assertEqual(
            item["usage_30d"],
            30,
        )
        self.assertEqual(
            item["avg_daily_usage"],
            1,
        )
        self.assertEqual(
            item["estimated_days_left"],
            10,
        )
        self.assertEqual(
            item["expiry_date"],
            "2026-09-01",
        )
        self.assertEqual(
            item["batch_number"],
            "LOT-42",
        )

    def test_stock_create_rejects_invalid_expiry_date(
        self,
    ):
        response = self.client.post(
            "/api/stock",
            json={
                "name": "Вакцина",
                "expiry_date":
                    "not-a-date",
            },
        )

        self.assertEqual(
            response.status_code,
            400,
        )
        self.assertEqual(
            response.get_json()[
                "error"
            ],
            "Невірна дата придатності.",
        )

    def test_stock_update_does_not_override_balance_directly(
        self,
    ):
        fake_supabase = (
            StockMutationSupabase()
        )

        with patch.object(
            server,
            "supabase",
            fake_supabase,
        ):
            response = self.client.put(
                f"/api/stock/{STOCK_ID}",
                json={
                    "name": "Вакцина А",
                    "qty": 999,
                },
            )

        self.assertEqual(
            response.status_code,
            200,
        )
        self.assertEqual(
            fake_supabase
            .updated_payloads[0]["name"],
            "Вакцина А",
        )
        self.assertNotIn(
            "qty",
            fake_supabase
            .updated_payloads[0],
        )

    def test_stock_adjust_detects_concurrent_balance_change(
        self,
    ):
        fake_supabase = (
            StockMutationSupabase(
                conflict_on_update=True,
            )
        )

        with patch.object(
            server,
            "supabase",
            fake_supabase,
        ):
            response = self.client.post(
                (
                    f"/api/stock/{STOCK_ID}"
                    "/adjust"
                ),
                json={
                    "movement_type":
                        "writeoff",
                    "quantity": 3,
                },
            )

        self.assertEqual(
            response.status_code,
            409,
        )
        self.assertIn(
            "Залишок уже змінився",
            response.get_json()["error"],
        )

    def test_purchase_requires_existing_stock_item(
        self,
    ):
        response = self.client.post(
            "/api/finance/purchases",
            json={
                "supplier_id": (
                    "33333333-3333-4333-"
                    "8333-333333333333"
                ),
                "items": [{
                    "name_snap": "Новий товар",
                    "unit_snap": "шт",
                    "ordered_qty": 1,
                    "purchase_price": 100,
                }],
            },
        )

        self.assertEqual(
            response.status_code,
            400,
        )
        self.assertIn(
            "Спочатку додайте товар до складу",
            response.get_json()["error"],
        )

    def test_used_stock_item_returns_clear_delete_conflict(
        self,
    ):
        with patch.object(
            server,
            "supabase",
            StockDeleteConflictSupabase(),
        ):
            response = self.client.delete(
                f"/api/stock/{STOCK_ID}"
            )

        self.assertEqual(
            response.status_code,
            409,
        )
        self.assertIn(
            "Вимкніть її перемикачем",
            response.get_json()["error"],
        )


if __name__ == "__main__":
    unittest.main()
