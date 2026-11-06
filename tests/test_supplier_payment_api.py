import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service-key")
os.environ.setdefault("SESSION_SECRET_KEY", "test-session-secret")
import server

ORG="00000000-0000-4000-8000-000000000001"
USER="10000000-0000-4000-8000-000000000001"
PURCHASE="30000000-0000-4000-8000-000000000001"
ACCOUNT="20000000-0000-4000-8000-000000000001"
KEY="40000000-0000-4000-8000-000000000001"


class RpcError(Exception):
    def __init__(self, code, text):
        super().__init__(text)
        self.code=code


class RpcDatabase:
    def __init__(self):
        self.calls=[]
        self.error=None

    def rpc(self, name, arguments):
        self.calls.append((name,arguments))
        return self

    def execute(self):
        if self.error:
            raise self.error
        if self.calls[-1][0]=="get_stock_purchase_payment_state":
            return SimpleNamespace(data={"purchase":{"id":PURCHASE},"accounts":[],"payments":[]})
        return SimpleNamespace(data={"purchase_id":PURCHASE,"transaction_id":"tx","paid_amount":"25.10","idempotent_replay":False})


class SupplierPaymentApiTests(unittest.TestCase):
    def setUp(self):
        self.client=server.app.test_client()
        self.db=RpcDatabase()
        self.user={"id":USER,"org_id":ORG,"role":"owner","is_active":True}
        for name, value in [("supabase",self.db),("get_current_user",lambda:self.user),("get_current_org_id",lambda:ORG)]:
            p=patch.object(server,name,value);p.start();self.addCleanup(p.stop)
        self.payload={"financial_account_id":ACCOUNT,"amount":"25,10","expected_paid_amount":"0.00",
                      "expected_total_amount":"100.00","currency":"uah","idempotency_key":KEY,"note":" test "}

    def post(self, payload=None):
        return self.client.post(f"/api/finance/purchases/{PURCHASE}/payments",json=self.payload if payload is None else payload)

    def test_calls_single_atomic_rpc_with_canonical_money_and_session_tenant(self):
        response=self.post({**self.payload,"org_id":"attacker"})
        self.assertEqual(response.status_code,200)
        self.assertEqual(len(self.db.calls),1)
        name,args=self.db.calls[0]
        self.assertEqual(name,"pay_stock_purchase")
        self.assertEqual(args["p_org_id"],ORG)
        self.assertEqual(args["p_user_id"],USER)
        self.assertEqual(args["p_amount"],"25.10")
        self.assertEqual(args["p_currency"],"UAH")
        self.assertEqual(args["p_note"],"test")
        self.assertEqual(args["p_idempotency_key"],KEY)

    def test_rejects_invalid_values_before_database_call(self):
        cases=[{"amount":value} for value in [True,25.1,None,"1e2","NaN","-1","0","1.001","1000000001.00"]]
        cases += [{"expected_paid_amount":"-1"},{"expected_total_amount":100},{"financial_account_id":"bad"},
                  {"idempotency_key":""},{"note":"x"*501},{"currency":"XXX"}]
        for override in cases:
            with self.subTest(override=override):
                self.assertEqual(self.post({**self.payload,**override}).status_code,400)
        self.assertEqual(self.db.calls,[])

    def test_safe_conflict_missing_setup_and_unknown_errors(self):
        for sql_code,message,status,code in [
            ("40001","private stale detail",409,"PURCHASE_PAYMENT_STALE"),
            ("23505","private duplicate detail",409,"PAYMENT_KEY_CONFLICT"),
            ("PGRST202","private schema cache",503,"PAYMENT_SETUP_REQUIRED"),
            ("P0002","private missing",404,"PAYMENT_NOT_FOUND"),
            ("42501","private denied",403,"PAYMENT_FORBIDDEN"),
            ("XX000","private failure",500,"PAYMENT_UNCONFIRMED"),
        ]:
            self.db.error=RpcError(sql_code,message)
            response=self.post()
            self.assertEqual(response.status_code,status)
            self.assertEqual(response.get_json()["code"],code)
            self.assertNotIn("private",response.get_json()["error"])

    def test_payment_state_is_read_only_and_owner_scoped(self):
        response=self.client.get(f"/api/finance/purchases/{PURCHASE}/payment-state")
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.db.calls[0][0],"get_stock_purchase_payment_state")
        self.assertEqual(self.db.calls[0][1]["p_org_id"],ORG)

    def test_doctor_and_missing_session_cannot_register_payment(self):
        self.user["role"]="vet"
        self.assertEqual(self.post().status_code,403)
        self.assertEqual(self.client.get(f"/api/finance/purchases/{PURCHASE}/payment-state").status_code,403)
        with patch.object(server,"get_current_user",return_value=None):
            self.assertEqual(self.post().status_code,401)
        self.assertEqual(self.db.calls,[])


if __name__=="__main__":
    unittest.main()
