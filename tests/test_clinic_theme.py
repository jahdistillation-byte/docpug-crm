import os
import unittest
from unittest.mock import patch


os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service-key")
os.environ.setdefault("SESSION_SECRET_KEY", "test-session-secret")

import server


class ThemeQuery:
    def __init__(self, rows):
        self.data = rows
        self.updated = None
        self.filters = []

    def update(self, payload):
        self.updated = payload
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def execute(self):
        return self


class ThemeSupabase:
    def __init__(self, rows):
        self.query = ThemeQuery(rows)
        self.table_name = None

    def table(self, table_name):
        self.table_name = table_name
        return self.query


class ClinicThemeTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def test_owner_can_save_supported_theme(self):
        fake = ThemeSupabase([{"theme": "green"}])

        with (
            patch.object(
                server,
                "owner_required",
                return_value=({"role": "owner"}, None),
            ),
            patch.object(
                server,
                "get_current_user",
                return_value={"role": "owner", "org_id": "org-1"},
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value="org-1",
            ),
            patch.object(server, "supabase", fake),
        ):
            response = self.client.put(
                "/api/organization/theme",
                json={"theme": "green"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["data"],
            {"theme": "green"},
        )
        self.assertEqual(fake.table_name, "orgs")
        self.assertEqual(fake.query.updated["theme"], "green")
        self.assertIn(("id", "org-1"), fake.query.filters)

    def test_unknown_theme_is_rejected(self):
        fake = ThemeSupabase([])

        with (
            patch.object(
                server,
                "owner_required",
                return_value=({"role": "owner"}, None),
            ),
            patch.object(
                server,
                "get_current_user",
                return_value={"role": "owner", "org_id": "org-1"},
            ),
            patch.object(
                server,
                "get_current_org_id",
                return_value="org-1",
            ),
            patch.object(server, "supabase", fake),
        ):
            response = self.client.put(
                "/api/organization/theme",
                json={"theme": "rainbow"},
            )

        self.assertEqual(response.status_code, 400)
        self.assertIsNone(fake.query.updated)

    def test_non_owner_cannot_save_theme(self):
        with (
            patch.object(
                server,
                "get_current_user",
                return_value={"role": "admin", "org_id": "org-1"},
            ),
            patch.object(
                server,
                "owner_required",
                return_value=(
                    None,
                    ({"ok": False, "error": "Owner access required"}, 403),
                ),
            ),
        ):
            response = self.client.put(
                "/api/organization/theme",
                json={"theme": "blue"},
            )

        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
