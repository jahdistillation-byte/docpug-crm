import os
import unittest
from copy import deepcopy
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
OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222"
PATIENT_ID = "33333333-3333-4333-8333-333333333333"
OTHER_PATIENT_ID = "44444444-4444-4444-8444-444444444444"
VISIT_ID = "55555555-5555-4555-8555-555555555555"
DIAGNOSIS_ID = "66666666-6666-4666-8666-666666666666"
USER_ID = "77777777-7777-4777-8777-777777777777"


class FakeResult:
    def __init__(self, data=None):
        self.data = data


class InMemoryQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.operation = "select"
        self.filters = []
        self.payload = None
        self.limit_count = None
        self.orders = []

    def select(self, *_args, **_kwargs):
        self.operation = "select"
        return self

    def insert(self, payload):
        self.operation = "insert"
        self.payload = deepcopy(payload)
        return self

    def update(self, payload):
        self.operation = "update"
        self.payload = deepcopy(payload)
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def limit(self, value):
        self.limit_count = value
        return self

    def order(self, field, desc=False, **_kwargs):
        self.orders.append((field, desc))
        return self

    def _matching_rows(self):
        rows = [
            deepcopy(row)
            for row in self.client.rows.get(
                self.table_name,
                [],
            )
        ]

        for field, value in self.filters:
            rows = [
                row
                for row in rows
                if row.get(field) == value
            ]

        for field, desc in reversed(self.orders):
            rows.sort(
                key=lambda row: str(
                    row.get(field) or ""
                ),
                reverse=desc,
            )

        if self.limit_count is not None:
            rows = rows[:self.limit_count]

        return rows

    def execute(self):
        self.client.calls.append({
            "table": self.table_name,
            "operation": self.operation,
            "filters": list(self.filters),
            "payload": deepcopy(self.payload),
        })

        if self.operation == "select":
            return FakeResult(
                self._matching_rows()
            )

        if self.operation == "insert":
            row = {
                "id": DIAGNOSIS_ID,
                "version": 1,
                **deepcopy(self.payload),
            }
            self.client.rows.setdefault(
                self.table_name,
                [],
            ).append(row)
            return FakeResult([deepcopy(row)])

        if self.operation == "update":
            table_rows = self.client.rows.get(
                self.table_name,
                [],
            )
            updated = []

            for row in table_rows:
                if not all(
                    row.get(field) == value
                    for field, value in self.filters
                ):
                    continue

                row.update(
                    deepcopy(self.payload)
                )
                row["version"] = int(
                    row.get("version") or 1
                ) + 1
                updated.append(deepcopy(row))

            return FakeResult(updated)

        raise AssertionError(
            f"Unsupported operation: {self.operation}"
        )


class InMemorySupabase:
    def __init__(self):
        self.rows = {
            "patients": [
                {
                    "id": PATIENT_ID,
                    "org_id": ORG_ID,
                    "name": "Жужа",
                },
                {
                    "id": OTHER_PATIENT_ID,
                    "org_id": OTHER_ORG_ID,
                    "name": "Чужий пацієнт",
                },
            ],
            "visits": [
                {
                    "id": VISIT_ID,
                    "org_id": ORG_ID,
                    "pet_id": PATIENT_ID,
                }
            ],
            "patient_diagnoses": [
                {
                    "id": DIAGNOSIS_ID,
                    "org_id": ORG_ID,
                    "patient_id": PATIENT_ID,
                    "diagnosis_name": "Атопічний дерматит",
                    "certainty": "confirmed",
                    "severity": "moderate",
                    "status": "active",
                    "version": 1,
                    "diagnosed_at": "2026-08-09T08:00:00+00:00",
                },
                {
                    "id": "resolved-diagnosis",
                    "org_id": ORG_ID,
                    "patient_id": PATIENT_ID,
                    "diagnosis_name": "Отит",
                    "certainty": "confirmed",
                    "status": "resolved",
                    "version": 3,
                    "diagnosed_at": "2026-07-01T08:00:00+00:00",
                },
            ],
            "patient_diagnosis_events": [
                {
                    "id": "event-1",
                    "org_id": ORG_ID,
                    "patient_id": PATIENT_ID,
                    "diagnosis_id": DIAGNOSIS_ID,
                    "event_type": "created",
                    "actor_id": USER_ID,
                    "occurred_at": "2026-08-09T08:00:00+00:00",
                }
            ],
        }
        self.calls = []

    def table(self, table_name):
        return InMemoryQuery(
            self,
            table_name,
        )


class PatientDiagnosesApiTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.fake = InMemorySupabase()
        self.user = {
            "id": USER_ID,
            "org_id": ORG_ID,
            "role": "vet",
            "is_active": True,
        }
        self.user_patch = patch.object(
            server,
            "get_current_user",
            return_value=self.user,
        )
        self.org_patch = patch.object(
            server,
            "get_current_org_id",
            return_value=ORG_ID,
        )
        self.supabase_patch = patch.object(
            server,
            "supabase",
            self.fake,
        )
        self.sleep_patch = patch.object(
            server.time,
            "sleep",
        )

        self.user_patch.start()
        self.org_patch.start()
        self.supabase_patch.start()
        self.sleep_patch.start()

    def tearDown(self):
        self.sleep_patch.stop()
        self.supabase_patch.stop()
        self.org_patch.stop()
        self.user_patch.stop()

    def test_active_list_is_scoped_to_org_patient_and_status(self):
        response = self.client.get(
            f"/api/patients/{PATIENT_ID}/diagnoses"
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["id"], DIAGNOSIS_ID)

        diagnosis_call = next(
            call
            for call in self.fake.calls
            if call["table"] == "patient_diagnoses"
        )
        self.assertIn(("org_id", ORG_ID), diagnosis_call["filters"])
        self.assertIn(("patient_id", PATIENT_ID), diagnosis_call["filters"])
        self.assertIn(("status", "active"), diagnosis_call["filters"])

    def test_history_includes_non_active_diagnoses(self):
        response = self.client.get(
            f"/api/patients/{PATIENT_ID}/diagnoses?scope=history"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            len(response.get_json()["data"]),
            2,
        )

    def test_cross_tenant_patient_is_not_visible(self):
        response = self.client.get(
            f"/api/patients/{OTHER_PATIENT_ID}/diagnoses"
        )

        self.assertEqual(response.status_code, 404)

    def test_vet_can_create_structured_diagnosis(self):
        response = self.client.post(
            f"/api/patients/{PATIENT_ID}/diagnoses",
            json={
                "diagnosis_name": "  Гастрит  ",
                "certainty": "provisional",
                "severity": "mild",
                "source_visit_id": VISIT_ID,
                "clinical_note": "  Потребує контролю  ",
            },
        )

        self.assertEqual(response.status_code, 200)
        row = response.get_json()["data"]
        self.assertEqual(row["diagnosis_name"], "Гастрит")
        self.assertEqual(row["status"], "active")
        self.assertEqual(row["org_id"], ORG_ID)
        self.assertEqual(row["created_by"], USER_ID)

    def test_assistant_cannot_create_diagnosis(self):
        self.user["role"] = "assistant"

        response = self.client.post(
            f"/api/patients/{PATIENT_ID}/diagnoses",
            json={
                "diagnosis_name": "Гастрит",
            },
        )

        self.assertEqual(response.status_code, 403)

    def test_source_visit_must_belong_to_patient(self):
        response = self.client.post(
            f"/api/patients/{PATIENT_ID}/diagnoses",
            json={
                "diagnosis_name": "Гастрит",
                "source_visit_id": "other-visit",
            },
        )

        self.assertEqual(response.status_code, 400)

    def test_update_uses_optimistic_version_and_org_scope(self):
        response = self.client.put(
            f"/api/patient-diagnoses/{DIAGNOSIS_ID}",
            json={
                "version": 1,
                "severity": "severe",
            },
        )

        self.assertEqual(response.status_code, 200)
        row = response.get_json()["data"]
        self.assertEqual(row["severity"], "severe")
        self.assertEqual(row["version"], 2)

        update_call = next(
            call
            for call in self.fake.calls
            if call["operation"] == "update"
        )
        self.assertIn(("org_id", ORG_ID), update_call["filters"])
        self.assertIn(("id", DIAGNOSIS_ID), update_call["filters"])
        self.assertIn(("version", 1), update_call["filters"])
        self.assertEqual(update_call["payload"]["updated_by"], USER_ID)

    def test_stale_update_returns_conflict(self):
        response = self.client.put(
            f"/api/patient-diagnoses/{DIAGNOSIS_ID}",
            json={
                "version": 99,
                "severity": "severe",
            },
        )

        self.assertEqual(response.status_code, 409)

    def test_entered_in_error_requires_reason(self):
        response = self.client.put(
            f"/api/patient-diagnoses/{DIAGNOSIS_ID}",
            json={
                "version": 1,
                "status": "entered_in_error",
            },
        )

        self.assertEqual(response.status_code, 400)

    def test_invalid_status_transition_is_rejected(self):
        self.fake.rows["patient_diagnoses"][0]["status"] = "resolved"

        response = self.client.put(
            f"/api/patient-diagnoses/{DIAGNOSIS_ID}",
            json={
                "version": 1,
                "status": "remission",
            },
        )

        self.assertEqual(response.status_code, 400)

    def test_erroneous_diagnosis_cannot_be_edited(self):
        self.fake.rows["patient_diagnoses"][0][
            "status"
        ] = "entered_in_error"

        response = self.client.put(
            f"/api/patient-diagnoses/{DIAGNOSIS_ID}",
            json={
                "version": 1,
                "clinical_note": "rewrite",
            },
        )

        self.assertEqual(response.status_code, 400)

    def test_event_history_is_scoped_to_diagnosis_and_org(self):
        response = self.client.get(
            f"/api/patient-diagnoses/{DIAGNOSIS_ID}/events"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["data"][0]["id"],
            "event-1",
        )
        event_call = next(
            call
            for call in self.fake.calls
            if call["table"] == "patient_diagnosis_events"
        )
        self.assertIn(("org_id", ORG_ID), event_call["filters"])
        self.assertIn(("diagnosis_id", DIAGNOSIS_ID), event_call["filters"])


if __name__ == "__main__":
    unittest.main()
