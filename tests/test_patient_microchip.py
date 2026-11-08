import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch
os.environ.setdefault('SUPABASE_URL', 'https://example.supabase.co')
os.environ.setdefault('SUPABASE_SERVICE_KEY', 'test-service-key')
os.environ.setdefault('SESSION_SECRET_KEY', 'test-session-secret')
import server

class Query:
    def __init__(self):
        self.payload = None
        self.filters = []
    def table(self, *_args): return self
    def select(self, *_args): return self
    def eq(self, *args): self.filters.append(args); return self
    def limit(self, *_args): return self
    def update(self, payload): self.payload = payload; return self
    def execute(self): return SimpleNamespace(data=[{'id': 'patient-1', **(self.payload or {})}])

class MicrochipTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        auth = patch.object(server, 'get_current_user', return_value={'id':'u1','org_id':'org-1','role':'vet','is_active':True})
        auth.start()
        self.addCleanup(auth.stop)
    def post(self, value=None):
        captured = {}
        def insert(table, payload, **kwargs):
            captured.update(payload)
            self.assertNotIn('microchip_number', kwargs.get('optional_fields', []))
            return SimpleNamespace(data=[{'id': 'patient-1', **payload}])
        with patch.object(server, 'auth_required', return_value=({'id':'u1'},None)), patch.object(server,'get_current_org_id',return_value='org-1'), patch.object(server,'supabase',Query()), patch.object(server,'insert_with_optional_fallback',side_effect=insert):
            response = self.client.post('/api/patients',json={'owner_id':'o1','name':'Test','microchip_number':value})
        return response,captured
    def test_create_preserves_leading_zeroes(self):
        response,payload=self.post(' 000123456789012 ')
        self.assertEqual(response.status_code,200)
        self.assertEqual(payload['microchip_number'],'000123456789012')
        self.assertEqual(payload['org_id'],'org-1')
    def test_create_without_chip_is_optional(self):
        for value in [None,'','   ']:
            response,payload=self.post(value)
            self.assertEqual(response.status_code,200)
            self.assertNotIn('microchip_number',payload)
    def test_invalid_chip_rejected_before_write(self):
        for value in ['x'*65,123456,{}]:
            response,payload=self.post(value)
            self.assertEqual(response.status_code,400)
            self.assertEqual(payload,{})
    def test_edit_clear_and_omission_are_distinct(self):
        for data, expected in [({'microchip_number':' 0000123 '},'0000123'),({'microchip_number':''},None),({'microchip_number':None},None),({'name':'Changed'},'omitted')]:
            query=Query()
            with patch.object(server,'auth_required',return_value=({'id':'u1'},None)),patch.object(server,'get_current_org_id',return_value='org-1'),patch.object(server,'supabase',query):
                response=self.client.put('/api/patients/patient-1',json=data)
            self.assertEqual(response.status_code,200)
            if expected=='omitted': self.assertNotIn('microchip_number',query.payload)
            else: self.assertEqual(query.payload['microchip_number'],expected)
            self.assertIn(('org_id','org-1'),query.filters)
            self.assertIn(('id','patient-1'),query.filters)

if __name__=='__main__': unittest.main()
