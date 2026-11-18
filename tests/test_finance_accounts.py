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
ACCOUNT_ID = "22222222-2222-4222-8222-222222222222"


class FakeResult:
    def __init__(self, data=None):
        self.data = data


class FinanceAccountsRpc:
    def __init__(self, client, name, arguments):
        self.client = client
        self.name = name
        self.arguments = arguments

    def execute(self):
        self.client.rpc_name = self.name
        self.client.rpc_arguments = self.arguments
        self.data = {
            "currency": "UAH",
            "total_balance": 100,
            "accounts": [],
        }
        return self


class FinanceTransactionsQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, field, value):
        self.filters.append(
            (field, value)
        )
        return self

    def gte(self, *_args, **_kwargs):
        return self

    def lt(self, *_args, **_kwargs):
        return self

    def or_(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def range(self, *_args, **_kwargs):
        return self

    def execute(self):
        self.client.transaction_filters = (
            list(self.filters)
        )
        return FakeResult([])


class FinanceAccountsSupabase:
    def __init__(self):
        self.rpc_name = None
        self.rpc_arguments = None
        self.transaction_filters = []

    def rpc(self, name, arguments):
        return FinanceAccountsRpc(
            self,
            name,
            arguments,
        )

    def table(self, table_name):
        if table_name not in {"finance_transactions", "finance_transaction_branch_scope"}:
            raise AssertionError(
                f"Unexpected table: {table_name}"
            )

        self.transaction_table = table_name
        return FinanceTransactionsQuery(self)


class FinanceAccountsApiTests(unittest.TestCase):
    def setUp(self):
        self.client = (
            server.app.test_client()
        )
        self.fake = (
            FinanceAccountsSupabase()
        )
        self.user_patch = patch.object(
            server,
            "get_current_user",
            return_value={
                "id":
                    "user-1",
                "org_id":
                    ORG_ID,
                "role":
                    "owner",
                "is_active":
                    True,
            },
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

        self.user_patch.start()
        self.org_patch.start()
        self.supabase_patch.start()

    def tearDown(self):
        self.supabase_patch.stop()
        self.org_patch.stop()
        self.user_patch.stop()

    def test_accounts_are_scoped_to_session_org(self):
        response = self.client.get(
            "/api/finance/accounts"
        )

        self.assertEqual(
            response.status_code,
            200,
        )
        self.assertEqual(
            self.fake.rpc_name,
            "get_financial_account_balances",
        )
        self.assertEqual(
            self.fake.rpc_arguments,
            {
                "p_org_id":
                    ORG_ID,
            },
        )

    def test_branch_filters_accounts_reports_and_journal(self):
        branch = {"id": ACCOUNT_ID, "is_primary": False}
        with patch.object(server, "workspace_request_branch", return_value=branch) as resolve:
            for path, rpc in (
                ("accounts", "get_financial_account_balances_by_branch"),
                ("overview", "get_finance_overview_currency_by_branch"),
                ("expenses/overview", "get_finance_expenses_overview_currency_by_branch"),
            ):
                with self.subTest(path=path):
                    response = self.client.get(f"/api/finance/{path}?branch_id={ACCOUNT_ID}")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(self.fake.rpc_name, rpc)
                    self.assertEqual(self.fake.rpc_arguments["p_org_id"], ORG_ID)
                    self.assertEqual(self.fake.rpc_arguments["p_branch_id"], ACCOUNT_ID)

            response = self.client.get(f"/api/finance/transactions?branch_id={ACCOUNT_ID}")
            self.assertEqual(response.status_code, 200)
            resolve.assert_called_with(ORG_ID, ACCOUNT_ID)

        self.assertEqual(self.fake.transaction_table, "finance_transaction_branch_scope")
        self.assertIn(("org_id", ORG_ID), self.fake.transaction_filters)
        self.assertIn(("effective_branch_id", ACCOUNT_ID), self.fake.transaction_filters)

    def test_invalid_branch_does_not_fall_back_to_organization_totals(self):
        for path in ("accounts", "overview", "expenses/overview", "client-balances", "transactions"):
            with self.subTest(path=path):
                response = self.client.get(f"/api/finance/{path}?branch_id=invalid")
                self.assertEqual(response.status_code, 400)
        self.assertIsNone(self.fake.rpc_name)

    def test_transaction_journal_filters_by_account(self):
        response = self.client.get(
            "/api/finance/transactions"
            f"?financial_account_id={ACCOUNT_ID}"
        )

        self.assertEqual(
            response.status_code,
            200,
        )
        self.assertIn(
            (
                "org_id",
                ORG_ID,
            ),
            self.fake.transaction_filters,
        )
        self.assertIn(
            (
                "financial_account_id",
                ACCOUNT_ID,
            ),
            self.fake.transaction_filters,
        )

    def test_transaction_journal_rejects_invalid_account(self):
        response = self.client.get(
            "/api/finance/transactions"
            "?financial_account_id=not-a-uuid"
        )

        self.assertEqual(
            response.status_code,
            400,
        )


if __name__ == "__main__":
    unittest.main()
