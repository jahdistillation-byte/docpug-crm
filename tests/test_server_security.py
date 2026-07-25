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


class FailingRpcClient:
    def __init__(self, message):
        self.message = message

    def rpc(self, *_args, **_kwargs):
        return self

    def execute(self):
        raise RuntimeError(
            self.message
        )


class StaffListClient:
    def __init__(self, rows):
        self.data = rows

    def table(self, _name):
        return self

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        return self


class StaticAssetSecurityTests(unittest.TestCase):
    def setUp(self):
        self.client = (
            server.app.test_client()
        )

    def test_only_public_assets_are_served(self):
        allowed_paths = (
            "/",
            "/index.html",
            "/app.js",
            "/style.css",
            "/ach.js",
            "/manifest.json",
        )

        for path in allowed_paths:
            with self.subTest(path=path):
                response = self.client.get(
                    path
                )
                self.assertEqual(
                    response.status_code,
                    200,
                )
                response.close()

    def test_sensitive_project_files_are_not_served(self):
        blocked_paths = (
            "/.env",
            "/%2eenv",
            "/server.py",
            "/.git/config",
            "/.git%2Fconfig",
            "/app.js/../.env",
        )

        for path in blocked_paths:
            with self.subTest(path=path):
                response = self.client.get(
                    path
                )
                self.assertEqual(
                    response.status_code,
                    404,
                )
                response.close()


class StaffCompensationSecurityTests(unittest.TestCase):
    def setUp(self):
        self.client = (
            server.app.test_client()
        )

    def test_non_owner_staff_payload_hides_compensation_fields(self):
        staff_row = {
            "id": "staff-1",
            "name": "Doctor",
            "shift_rate": 1000,
            "percent_rate": 10,
            "bonus_rate": 5,
            "visit_percent": 7,
            "salary_private_note": "secret",
            "payroll_data": {"amount": 1},
            "finance_adjustments": [],
        }

        for role in (
            "admin",
            "vet",
            "assistant",
        ):
            with self.subTest(role=role):
                result = (
                    server
                    .serialize_staff_for_role(
                        staff_row,
                        role,
                    )
                )

                self.assertEqual(
                    result["name"],
                    "Doctor",
                )

                for field in staff_row:
                    if field in {
                        "id",
                        "name",
                    }:
                        continue

                    self.assertNotIn(
                        field,
                        result,
                    )

    def test_owner_staff_payload_keeps_compensation_fields(self):
        staff_row = {
            "id": "staff-1",
            "shift_rate": 1000,
            "visit_percent": 7,
        }

        self.assertEqual(
            server.serialize_staff_for_role(
                staff_row,
                "owner",
            ),
            staff_row,
        )

    def test_admin_staff_endpoint_omits_compensation_fields(self):
        admin = {
            "id": "admin-1",
            "org_id": "org-1",
            "role": "admin",
            "is_active": True,
        }

        with (
            patch.object(
                server,
                "get_current_user",
                return_value=admin,
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value="org-1",
            ),
            patch.object(
                server,
                "supabase",
                StaffListClient([{
                    "id": "staff-1",
                    "name": "Doctor",
                    "shift_rate": 1000,
                    "percent_rate": 10,
                    "payroll_data": {
                        "amount": 1000,
                    },
                    "finance_adjustments": [],
                }]),
            ),
        ):
            response = self.client.get(
                "/api/staff"
            )

        self.assertEqual(
            response.status_code,
            200,
        )

        row = response.get_json()[
            "data"
        ][0]

        self.assertEqual(
            row,
            {
                "id": "staff-1",
                "name": "Doctor",
            },
        )

    @patch.object(
        server,
        "get_current_user",
        return_value={
            "id": "admin-1",
            "org_id": "org-1",
            "role": "admin",
            "is_active": True,
        },
    )
    def test_admin_cannot_create_compensation_fields(
        self,
        _get_current_user,
    ):
        response = self.client.post(
            "/api/staff",
            json={
                "name": "Doctor",
                "percent_rate": 10,
            },
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    @patch.object(
        server,
        "get_current_user",
        return_value={
            "id": "admin-1",
            "org_id": "org-1",
            "role": "admin",
            "is_active": True,
        },
    )
    def test_admin_cannot_update_compensation_fields(
        self,
        _get_current_user,
    ):
        response = self.client.put(
            "/api/staff/staff-1",
            json={
                "shift_rate": 1000,
            },
        )

        self.assertEqual(
            response.status_code,
            403,
        )

    @patch.object(
        server,
        "get_current_user",
        return_value={
            "id": "admin-1",
            "org_id": "org-1",
            "role": "admin",
            "is_active": True,
        },
    )
    def test_admin_cannot_delete_staff_adjustments(
        self,
        _get_current_user,
    ):
        response = self.client.delete(
            "/api/staff/adjustments/adjustment-1"
        )

        self.assertEqual(
            response.status_code,
            403,
        )


class FinanceErrorSecurityTests(unittest.TestCase):
    def setUp(self):
        self.client = (
            server.app.test_client()
        )
        self.owner = {
            "id": "owner-1",
            "org_id": "org-1",
            "role": "owner",
            "is_active": True,
        }

    def test_visit_payment_does_not_return_database_error(self):
        database_error = (
            "already paid: secret database details"
        )

        with (
            patch.object(
                server,
                "get_current_user",
                return_value=self.owner,
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value="org-1",
            ),
            patch.object(
                server,
                "supabase",
                FailingRpcClient(
                    database_error
                ),
            ),
        ):
            response = self.client.post(
                "/api/visits/visit-1/payments",
                json={
                    "amount": "100.00",
                    "payment_method": "cash",
                },
            )

        self.assertEqual(
            response.status_code,
            409,
        )
        self.assertEqual(
            response.get_json()["error"],
            "Візит уже повністю оплачено.",
        )
        self.assertNotIn(
            "secret database details",
            response.get_data(
                as_text=True
            ),
        )

    def test_purchase_does_not_return_database_error(self):
        database_error = (
            "Stock item not found: secret database details"
        )

        with (
            patch.object(
                server,
                "get_current_user",
                return_value=self.owner,
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value="org-1",
            ),
            patch.object(
                server,
                "supabase",
                FailingRpcClient(
                    database_error
                ),
            ),
        ):
            response = self.client.post(
                "/api/finance/purchases",
                json={
                    "supplier_id": (
                        "11111111-1111-4111-"
                        "8111-111111111111"
                    ),
                    "items": [{
                        "stock_id": (
                            "22222222-2222-4222-"
                            "8222-222222222222"
                        ),
                        "ordered_qty": "1.00",
                        "purchase_price": "100.00",
                    }],
                },
            )

        self.assertEqual(
            response.status_code,
            400,
        )
        self.assertEqual(
            response.get_json()["error"],
            "Один із товарів не знайдено на складі.",
        )
        self.assertNotIn(
            "secret database details",
            response.get_data(
                as_text=True
            ),
        )


if __name__ == "__main__":
    unittest.main()
