import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch


os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service-key")
os.environ.setdefault("SESSION_SECRET_KEY", "test-session-secret")

import server


class DeliveryQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.operation = "select"
        self.payload = None
        self.filters = []

    def select(self, *_args, **_kwargs):
        return self

    def insert(self, payload):
        self.operation = "insert"
        self.payload = payload
        return self

    def update(self, payload):
        self.operation = "update"
        self.payload = payload
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def limit(self, _value):
        return self

    def execute(self):
        self.client.operations.append({
            "table": self.table_name,
            "operation": self.operation,
            "payload": self.payload,
            "filters": list(self.filters),
        })

        if self.operation == "insert":
            return SimpleNamespace(data=[{"id": "delivery-1"}])

        return SimpleNamespace(data=[])


class DeliverySupabase:
    def __init__(self):
        self.operations = []

    def table(self, table_name):
        return DeliveryQuery(self, table_name)


class OwnerDailyReportDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def test_missing_chat_id_is_rejected_without_telegram_call(self):
        with (
            patch.object(
                server,
                "owner_required",
                return_value=({"role": "owner"}, None),
            ),
            patch.object(
                server,
                "get_current_user",
                return_value={
                    "id": "user-1",
                    "org_id": "org-1",
                    "role": "owner",
                    "is_active": True,
                },
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value="org-1",
            ),
            patch.object(
                server,
                "get_report_settings",
                return_value={"telegram_chat_id": ""},
            ),
            patch.object(server, "send_telegram_report") as send_mock,
        ):
            response = self.client.post(
                "/api/reports/daily/send",
                json={"date": "2026-08-02"},
            )

        self.assertEqual(response.status_code, 409)
        send_mock.assert_not_called()

    def test_already_sent_report_is_not_sent_again(self):
        with (
            patch.object(
                server,
                "owner_required",
                return_value=({"role": "owner"}, None),
            ),
            patch.object(
                server,
                "get_current_user",
                return_value={
                    "id": "user-1",
                    "org_id": "org-1",
                    "role": "owner",
                    "is_active": True,
                },
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value="org-1",
            ),
            patch.object(
                server,
                "get_report_settings",
                return_value={"telegram_chat_id": "123456789"},
            ),
            patch.object(
                server,
                "report_rows",
                return_value=[{
                    "id": "delivery-1",
                    "status": "sent",
                    "attempt_count": 1,
                    "telegram_message_id": "42",
                }],
            ),
            patch.object(server, "send_telegram_report") as send_mock,
        ):
            response = self.client.post(
                "/api/reports/daily/send",
                json={"date": "2026-08-02"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["data"]["already_sent"])
        send_mock.assert_not_called()

    def test_manual_send_creates_sent_delivery(self):
        fake_supabase = DeliverySupabase()

        with (
            patch.object(
                server,
                "owner_required",
                return_value=({"role": "owner"}, None),
            ),
            patch.object(
                server,
                "get_current_user",
                return_value={
                    "id": "user-1",
                    "org_id": "org-1",
                    "role": "owner",
                    "is_active": True,
                },
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value="org-1",
            ),
            patch.object(
                server,
                "get_report_settings",
                return_value={"telegram_chat_id": "123456789"},
            ),
            patch.object(server, "report_rows", return_value=[]),
            patch.object(server, "find_report_sent_audit", return_value=None),
            patch.object(
                server,
                "build_owner_daily_report",
                return_value={"telegram_message": "report"},
            ),
            patch.object(
                server,
                "send_telegram_report",
                return_value={"message_id": 42},
            ),
            patch.object(server, "write_audit_event"),
            patch.object(server, "supabase", fake_supabase),
        ):
            response = self.client.post(
                "/api/reports/daily/send",
                json={"date": "2026-08-02"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["data"]["already_sent"])

        inserts = [
            item
            for item in fake_supabase.operations
            if item["operation"] == "insert"
        ]
        updates = [
            item
            for item in fake_supabase.operations
            if item["operation"] == "update"
        ]

        self.assertEqual(inserts[0]["payload"]["status"], "processing")
        self.assertEqual(updates[-1]["payload"]["status"], "sent")
        self.assertEqual(
            updates[-1]["payload"]["telegram_message_id"],
            "42",
        )


if __name__ == "__main__":
    unittest.main()
