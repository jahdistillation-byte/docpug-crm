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


class TransientReadQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.filters = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        self.client.attempts += 1

        if self.client.attempts < 3:
            raise OSError(
                11,
                "Resource temporarily unavailable",
            )

        self.client.table_name = self.table_name
        self.client.filters = list(self.filters)
        self.data = []
        return self


class TransientReadSupabase:
    def __init__(self):
        self.attempts = 0
        self.table_name = None
        self.filters = []

    def table(self, table_name):
        return TransientReadQuery(
            self,
            table_name,
        )


class TransientReadRetryTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def request_with_transient_client(self, path):
        fake = TransientReadSupabase()

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
            ) as sleep_mock,
        ):
            response = self.client.get(path)

        return response, fake, sleep_mock

    def test_visits_read_recovers_after_errno_11(self):
        response, fake, sleep_mock = (
            self.request_with_transient_client(
                "/api/visits?pet_id=pet-1"
            )
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fake.attempts, 3)
        self.assertEqual(fake.table_name, "visits")
        self.assertIn(
            ("pet_id", "pet-1"),
            fake.filters,
        )
        self.assertEqual(
            sleep_mock.call_count,
            2,
        )

    def test_hospitalization_read_recovers_after_errno_11(self):
        response, fake, sleep_mock = (
            self.request_with_transient_client(
                "/api/hospitalizations"
                "?patient_id=pet-1"
            )
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fake.attempts, 3)
        self.assertEqual(
            fake.table_name,
            "hospitalizations",
        )
        self.assertIn(
            ("patient_id", "pet-1"),
            fake.filters,
        )
        self.assertEqual(
            sleep_mock.call_count,
            2,
        )


if __name__ == "__main__":
    unittest.main()
