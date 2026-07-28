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


class PatientsQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def execute(self):
        self.client.attempts += 1

        if self.client.attempts == 1:
            raise RuntimeError(
                "Resource temporarily unavailable"
            )

        self.client.filters = list(
            self.filters
        )
        self.data = [
            {
                "id": "patient-1",
                "org_id": "org-1",
                "owner_id": "owner-1",
                "name": "Жужа",
            }
        ]
        return self


class PatientsSupabase:
    def __init__(self):
        self.attempts = 0
        self.table_names = []
        self.filters = []

    def table(self, table_name):
        self.table_names.append(
            table_name
        )
        return PatientsQuery(self)


class PatientsApiTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def test_transient_supabase_failure_is_retried(self):
        fake = PatientsSupabase()

        with (
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
                "supabase",
                fake,
            ),
            patch.object(
                server.time,
                "sleep",
            ),
        ):
            response = self.client.get(
                "/api/patients?owner_id=owner-1"
            )

        self.assertEqual(
            response.status_code,
            200,
        )
        self.assertEqual(
            fake.attempts,
            2,
        )
        self.assertEqual(
            fake.table_names,
            ["patients", "patients"],
        )
        self.assertIn(
            ("org_id", "org-1"),
            fake.filters,
        )
        self.assertIn(
            ("owner_id", "owner-1"),
            fake.filters,
        )
        self.assertEqual(
            response.get_json()["data"][0]["name"],
            "Жужа",
        )


if __name__ == "__main__":
    unittest.main()
