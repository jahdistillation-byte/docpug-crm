import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service-key")
os.environ.setdefault("SESSION_SECRET_KEY", "test-session-secret")
import server

ORG="00000000-0000-4000-8000-000000000001"
USER="00000000-0000-4000-8000-000000000002"
HOSP="00000000-0000-4000-8000-000000000003"
TASK="00000000-0000-4000-8000-000000000004"
KEY="00000000-0000-4000-8000-000000000005"

class Db:
    def __init__(self):
        self.calls=[]
        self.error=None
    def rpc(self,name,args):
        self.calls.append((name,args))
        return self
    def execute(self):
        if self.error:
            raise self.error
        return SimpleNamespace(data={"total":"0.00","items":[],"charges":[]} if self.calls[-1][0]=="get_hospital_billing_state" else {"task":{"id":TASK,"status":"planned"}})

class HospitalBillingApiTests(unittest.TestCase):
    def setUp(self):
        self.db=Db();self.user={"id":USER,"org_id":ORG,"role":"vet","is_active":True}
        self.client=server.app.test_client()
        for name,value in [('supabase',self.db),('get_current_user',lambda:self.user),('get_current_org_id',lambda:ORG)]:
            p=patch.object(server,name,value);p.start();self.addCleanup(p.stop)

    def test_creation_uses_one_rpc_and_only_session_actor(self):
        payload={"idempotency_key":KEY,"org_id":"foreign","p_user_id":"foreign","title":"Test","items":[],"currency":"UAH"}
        response=self.client.post(f'/api/hospitalizations/{HOSP}/tasks',json=payload)
        self.assertEqual(response.status_code,200)
        self.assertEqual(len(self.db.calls),1)
        name,args=self.db.calls[0];self.assertEqual(name,'hospital_task_command')
        self.assertEqual(args['p_org_id'],ORG);self.assertEqual(args['p_user_id'],USER)
        self.assertEqual(args['p_hospitalization_id'],HOSP);self.assertEqual(args['p_request_key'],KEY)
        self.assertNotIn('org_id',args['p_payload'])

    def test_complete_and_cancel_are_atomic_commands(self):
        response=self.client.post(f'/api/hospital-tasks/{TASK}/complete',json={"idempotency_key":KEY,"actual_items":[],"completed_at":"fake"})
        self.assertEqual(response.status_code,200);self.assertEqual(self.db.calls[-1][1]['p_action'],'complete')
        self.assertNotIn('completed_at',self.db.calls[-1][1]['p_payload'])
        response=self.client.delete(f'/api/hospital-tasks/{TASK}',json={"idempotency_key":KEY})
        self.assertEqual(response.status_code,200);self.assertEqual(self.db.calls[-1][1]['p_action'],'cancel')

    def test_invalid_identifiers_never_call_database(self):
        for payload in [None,[],{}, {'idempotency_key':'bad'}]:
            response=self.client.post(f'/api/hospitalizations/{HOSP}/tasks',json=payload)
            self.assertEqual(response.status_code,400)
        self.assertEqual(self.db.calls,[])

    def test_bill_is_scoped_read_and_requires_session(self):
        self.assertEqual(self.client.get(f'/api/hospitalizations/{HOSP}/billing').status_code,200)
        self.assertEqual(self.db.calls[-1],('get_hospital_billing_state',{'p_org_id':ORG,'p_user_id':USER,'p_hospitalization_id':HOSP}))
        self.user=None
        self.assertEqual(self.client.get(f'/api/hospitalizations/{HOSP}/billing').status_code,401)
        self.assertEqual(self.client.post(f'/api/hospitalizations/{HOSP}/tasks',json={'idempotency_key':KEY}).status_code,401)

    def test_safe_errors_and_no_raw_database_details(self):
        for sql,status in [('PGRST202',503),('42501',403),('40001',409),('55000',409),('23505',409),('P0002',404),('22023',400),('22P02',400),('XX000',500)]:
            error=RuntimeError('private database details');error.code=sql;self.db.error=error
            response=self.client.post(f'/api/hospitalizations/{HOSP}/tasks',json={'idempotency_key':KEY})
            self.assertEqual(response.status_code,status)
            self.assertNotIn('private',response.get_json()['error'])

if __name__=='__main__':
    unittest.main()
