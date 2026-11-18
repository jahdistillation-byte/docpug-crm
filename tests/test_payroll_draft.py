"""Payroll draft calculation uses local fixtures and never posts payouts."""
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service-key")
os.environ.setdefault("SESSION_SECRET_KEY", "test-session-secret")
import server


class PayrollDraftTests(unittest.TestCase):
    def calculate(self, transactions, shifts=None):
        staff = [
            {"id": "vet", "name": "Doctor", "branch_ids": ["left", "main"], "shift_rate": 1000, "percent_rate": 10},
            {"id": "other", "name": "Other", "branch_ids": ["main"], "shift_rate": 999, "percent_rate": 50},
        ]
        visits = [{"id": "visit", "staff_id": "vet", "branch_id": "left", "currency": "UAH",
                   "date": "2026-11-01", "discount_amount": 20}]
        return server.calculate_payroll_draft(
            staff, shifts or [], visits, transactions,
            [{"visit_id": "visit", "qty": 1, "price_snap": 100}],
            [{"visit_id": "visit", "qty": 1, "price_snap": 100}],
            "left", "2026-11-01", "2026-11-18",
        )

    def entry(self, amount, kind="payment", day="2026-11-02", **extra):
        return {"visit_id": "visit", "currency": "UAH", "status": "completed",
                "transaction_type": kind, "amount": amount, "occurred_at": day + "T10:00:00Z", **extra}

    def test_partial_payment_discounts_materials_and_refunds(self):
        result = self.calculate([self.entry(90), self.entry(18, "refund")])
        self.assertEqual(result["items"][0]["commission_base"], "36.00")
        self.assertEqual(result["items"][0]["commission"], "3.60")
        self.assertEqual(len(result["items"]), 1)

    def test_prior_period_payment_and_current_refund(self):
        result = self.calculate([self.entry(180, day="2026-10-30"), self.entry(18, "refund")])
        self.assertEqual(result["items"][0]["commission_base"], "-9.00")
        self.assertEqual(result["total"], "-0.90")

    def test_unpaid_cancelled_foreign_and_overpaid(self):
        self.assertEqual(self.calculate([])["items"][0]["commission"], "0.00")
        result = self.calculate([
            self.entry(999), self.entry(100, status="cancelled"),
            self.entry(100, currency="EUR"), self.entry(100, visit_id="foreign"),
        ])
        self.assertEqual(result["items"][0]["commission_base"], "90.00")

    def test_shifts_are_branch_scoped_and_date_deduplicated(self):
        shifts = [
            {"staff_id": "vet", "branch_id": branch, "work_date": day, "is_active": active}
            for branch, day, active in [
                ("left", "2026-11-02", True), ("left", "2026-11-02", True),
                ("main", "2026-11-03", True), ("left", "2026-11-19", True),
                ("left", "2026-11-04", False),
            ]
        ]
        result = self.calculate([], shifts)
        self.assertEqual(result["items"][0]["shift_count"], 1)
        self.assertEqual(result["total"], "1000.00")

    def test_endpoint_requires_owner(self):
        with patch.object(server, "get_current_user", return_value={
            "id": "admin", "role": "admin", "org_id": "clinic", "is_active": True,
        }):
            self.assertEqual(server.app.test_client().get("/api/finance/payroll").status_code, 403)
