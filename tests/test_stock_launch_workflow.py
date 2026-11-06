"""Stock workflow checks with an in-memory database; no hosted data is used."""
import os
import unittest
from copy import deepcopy
from unittest.mock import patch
from types import SimpleNamespace

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service-key")
os.environ.setdefault("SESSION_SECRET_KEY", "test-session-secret")
import server


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.operation, self.payload = [], "select", None
        self.start, self.end, self.orders = 0, None, []

    def select(self, *_args):
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def limit(self, count):
        self.end = count
        return self

    def range(self, start, end):
        self.start, self.end = start, end + 1
        return self

    def order(self, field, desc=False):
        self.orders.append((field, desc))
        return self

    def insert(self, payload):
        self.operation, self.payload = "insert", deepcopy(payload)
        return self

    def update(self, payload):
        self.operation, self.payload = "update", deepcopy(payload)
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def execute(self):
        rows = self.db.rows[self.table]
        selected = [r for r in rows if all(r.get(k) == v for k, v in self.filters)]
        if self.operation == "insert":
            if self.table == "stock_movements" and self.db.fail_movement:
                raise RuntimeError("simulated movement failure")
            row = {"id": str(self.db.sequence), "created_at": "2026-11-06T10:00:00Z", **self.payload}
            self.db.sequence += 1
            rows.append(row)
            selected = [row]
        elif self.operation == "update":
            for row in selected:
                row.update(self.payload)
        elif self.operation == "delete":
            for row in selected:
                rows.remove(row)
        for field, desc in reversed(self.orders):
            selected = sorted(selected, key=lambda r: str(r.get(field) or ""), reverse=desc)
        return SimpleNamespace(data=deepcopy(selected[self.start:self.end]))


class Database:
    def __init__(self):
        self.sequence, self.fail_movement = 10, False
        self.rows = {
            "stock": [{"id": "item", "org_id": "clinic", "name": "Test", "qty": 10.0, "price": 12, "purchase_price": 5, "unit": "мл", "active": True}],
            "stock_movements": [], "visit_stock": [],
            "visits": [{"id": "visit", "org_id": "clinic", "currency": "UAH"}],
            "orgs": [{"id": "clinic", "currency": "UAH"}],
        }

    def table(self, name):
        return Query(self, name)


class StockLaunchTests(unittest.TestCase):
    def setUp(self):
        self.db = Database()
        self.client = server.app.test_client()
        self.user = {"id": "owner", "org_id": "clinic", "role": "owner", "is_active": True}
        for name, value in [("supabase", self.db), ("get_current_user", lambda: self.user),
                            ("get_current_org_id", lambda: "clinic"), ("write_audit_event", lambda **kw: None),
                            ("check_visit_line_removal_finance", lambda *a: None)]:
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)

    def adjust(self, mode, quantity):
        return self.client.post("/api/stock/item/adjust", json={"mode": mode, "quantity": quantity})

    def test_receipt_visit_use_and_removal_preserve_balance_and_history(self):
        self.assertEqual(self.adjust("income", 2.5).status_code, 200)
        added = self.client.post("/api/visits/visit/stock", json={"stock_id": "item", "quantity": .3})
        self.assertEqual(added.status_code, 200, added.get_json())
        self.assertAlmostEqual(self.db.rows["stock"][0]["qty"], 12.2)
        line_id = added.get_json()["data"]["line"]["id"]
        removed = self.client.delete(f"/api/visits/visit/stock/{line_id}")
        self.assertEqual(removed.status_code, 200, removed.get_json())
        self.assertAlmostEqual(self.db.rows["stock"][0]["qty"], 12.5)
        self.assertEqual(self.client.delete(f"/api/visits/visit/stock/{line_id}").status_code, 404)
        self.assertAlmostEqual(self.db.rows["stock"][0]["qty"], 12.5)
        history = self.client.get("/api/stock/item/movements").get_json()["data"]
        self.assertEqual(len(history["items"]), 3)
        self.assertEqual(history["unit"], "мл")
        self.assertFalse(history["has_more"])

    def test_failed_movement_rolls_back_manual_and_visit_changes(self):
        self.db.fail_movement = True
        self.assertEqual(self.adjust("writeoff", 1).status_code, 500)
        self.assertEqual(self.db.rows["stock"][0]["qty"], 10)
        response = self.client.post("/api/visits/visit/stock", json={"stock_id": "item", "quantity": 1})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.db.rows["stock"][0]["qty"], 10)
        self.assertEqual(self.db.rows["visit_stock"], [])

    def test_fractional_use_leaves_no_phantom_stock(self):
        self.db.rows["stock"][0]["qty"] = .3
        for _ in range(3):
            response = self.client.post("/api/visits/visit/stock", json={"stock_id": "item", "quantity": .1})
            self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(self.db.rows["stock"][0]["qty"], 0)
        self.assertEqual(self.adjust("writeoff", .1).status_code, 409)
        for line in list(self.db.rows["visit_stock"]):
            self.assertEqual(self.client.delete(f'/api/visits/visit/stock/{line["id"]}').status_code, 200)
        self.assertEqual(self.db.rows["stock"][0]["qty"], .3)
        for _ in range(3):
            self.assertEqual(self.adjust("writeoff", .1).status_code, 200)
        self.assertEqual(self.db.rows["stock"][0]["qty"], 0)

    def test_invalid_quantities_never_mutate_inventory(self):
        for value in [True, False, None, "", "abc", "NaN", "Infinity", "1e999", -1, 0]:
            with self.subTest(value=value):
                self.assertEqual(self.adjust("income", value).status_code, 400)
                response = self.client.post("/api/visits/visit/stock", json={"stock_id": "item", "quantity": value})
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.db.rows["stock"][0]["qty"], 10)
        self.assertEqual(self.db.rows["stock_movements"], [])

    def test_insufficient_stock_and_foreign_visit_are_rejected(self):
        self.assertEqual(self.adjust("writeoff", 11).status_code, 409)
        response = self.client.post("/api/visits/foreign/stock", json={"stock_id": "item", "quantity": 1})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.db.rows["visit_stock"], [])

    def test_history_is_scoped_paginated_and_read_only(self):
        for i in range(55):
            self.db.rows["stock_movements"].append({"id": f"{i:03}", "created_at": "2026-11-06", "org_id": "clinic", "stock_id": "item", "movement_type": "income", "quantity": 1})
        self.db.rows["stock_movements"].append({"id": "secret", "org_id": "other", "stock_id": "item"})
        before = deepcopy(self.db.rows)
        page = self.client.get("/api/stock/item/movements").get_json()["data"]
        self.assertEqual(len(page["items"]), 50)
        self.assertTrue(page["has_more"])
        tail = self.client.get("/api/stock/item/movements?offset=50").get_json()["data"]
        self.assertEqual(len(tail["items"]), 5)
        self.assertFalse(tail["has_more"])
        self.assertEqual(self.client.get("/api/stock/foreign/movements").status_code, 404)
        self.assertEqual(self.client.get("/api/stock/item/movements?offset=-1").status_code, 400)
        self.assertEqual(self.db.rows, before)

    def test_session_and_manual_adjustment_permissions(self):
        self.user["role"] = "doctor"
        self.assertEqual(self.adjust("income", 1).status_code, 403)
        with patch.object(server, "get_current_user", return_value=None):
            self.assertEqual(self.client.get("/api/stock/item/movements").status_code, 401)

    def test_unit_cannot_reinterpret_existing_balances_or_history(self):
        response = self.client.put("/api/stock/item", json={"unit": "шт"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.db.rows["stock"][0]["unit"], "мл")
        self.db.rows["stock"][0]["qty"] = 0
        self.db.rows["stock_movements"].append({"id": "m", "org_id": "clinic", "stock_id": "item"})
        self.assertEqual(self.client.put("/api/stock/item", json={"unit": "шт"}).status_code, 409)
        self.assertEqual(self.client.put("/api/stock/item", json={"unit": "мл", "name": "Updated"}).status_code, 200)
        self.db.rows["stock_movements"] = []
        self.assertEqual(self.client.put("/api/stock/item", json={"unit": "шт"}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
