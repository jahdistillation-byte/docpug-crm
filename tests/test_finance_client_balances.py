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


class FakeResult:
    def __init__(self, data=None):
        self.data = data


class FinanceBalanceQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.filters = []
        self.in_filters = []
        self.range_bounds = None
        self.order_field = None
        self.order_desc = False

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def in_(self, field, values):
        self.in_filters.append(
            (field, {str(value) for value in values})
        )
        return self

    def order(self, field, desc=False, **_kwargs):
        self.order_field = field
        self.order_desc = bool(desc)
        return self

    def range(self, start, end):
        self.range_bounds = (start, end)
        return self

    def execute(self):
        rows = [
            dict(row)
            for row in self.client.rows.get(
                self.table_name,
                [],
            )
        ]

        for field, value in self.filters:
            rows = [
                row
                for row in rows
                if str(row.get(field)) == str(value)
            ]

        for field, values in self.in_filters:
            rows = [
                row
                for row in rows
                if str(row.get(field)) in values
            ]

        if self.order_field:
            rows.sort(
                key=lambda row: str(
                    row.get(self.order_field)
                    or ""
                ),
                reverse=self.order_desc,
            )

        if self.range_bounds:
            start, end = self.range_bounds
            rows = rows[start:end + 1]

        return FakeResult(rows)


class FinanceBalanceSupabase:
    def __init__(self, rows):
        self.rows = rows

    def table(self, table_name):
        return FinanceBalanceQuery(
            self,
            table_name,
        )


class FinanceClientBalanceTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.owner = {
            "id": USER_ID,
            "org_id": ORG_ID,
            "role": "owner",
            "is_active": True,
        }

    def test_balances_follow_visit_lines_and_completed_payments(self):
        fake = FinanceBalanceSupabase({
            "owners": [
                {
                    "id": "owner-1",
                    "org_id": ORG_ID,
                    "name": "Валерій",
                    "phone": "+380991112233",
                },
            ],
            "patients": [
                {
                    "id": "patient-1",
                    "org_id": ORG_ID,
                    "owner_id": "owner-1",
                    "name": "Жужа",
                    "species": "dog",
                },
            ],
            "visits": [
                {
                    "id": "visit-1",
                    "org_id": ORG_ID,
                    "pet_id": "patient-1",
                    "date": "2026-07-28",
                    "dx": "Контроль",
                    "discount_amount": 0,
                },
                {
                    "id": "visit-2",
                    "org_id": ORG_ID,
                    "pet_id": "patient-1",
                    "date": "2026-07-27",
                    "dx": "Огляд",
                    "discount_amount": 0,
                },
            ],
            "visit_services": [
                {
                    "visit_id": "visit-1",
                    "org_id": ORG_ID,
                    "qty": 2,
                    "price_snap": 100,
                },
                {
                    "visit_id": "visit-2",
                    "org_id": ORG_ID,
                    "qty": 1,
                    "price_snap": 200,
                },
            ],
            "visit_stock": [
                {
                    "visit_id": "visit-1",
                    "org_id": ORG_ID,
                    "qty": 1,
                    "price_snap": 50,
                },
            ],
            "finance_transactions": [
                {
                    "org_id": ORG_ID,
                    "visit_id": "visit-1",
                    "transaction_type": "payment",
                    "status": "completed",
                    "amount": 100,
                },
                {
                    "org_id": ORG_ID,
                    "visit_id": "visit-1",
                    "transaction_type": "payment",
                    "status": "failed",
                    "amount": 1000,
                },
                {
                    "org_id": ORG_ID,
                    "visit_id": "visit-2",
                    "transaction_type": "payment",
                    "status": "completed",
                    "amount": 200,
                },
            ],
        })

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
            patch.object(
                server,
                "supabase",
                fake,
            ),
        ):
            response = self.client.get(
                "/api/finance/client-balances"
            )

        self.assertEqual(
            response.status_code,
            200,
        )

        payload = response.get_json()["data"]
        summary = payload["summary"]
        client = payload["items"][0]

        self.assertEqual(summary["billed"], 450)
        self.assertEqual(summary["paid"], 300)
        self.assertEqual(summary["outstanding"], 150)
        self.assertEqual(summary["debt_clients_count"], 1)
        self.assertEqual(summary["debt_visits_count"], 1)
        self.assertEqual(summary["collection_rate"], 66.7)

        self.assertEqual(client["owner_name"], "Валерій")
        self.assertEqual(client["remaining"], 150)
        self.assertEqual(client["status"], "debt")
        self.assertEqual(
            client["visits"][0]["financial_status"],
            "partial",
        )
        self.assertEqual(
            client["visits"][1]["financial_status"],
            "paid",
        )


if __name__ == "__main__":
    unittest.main()
