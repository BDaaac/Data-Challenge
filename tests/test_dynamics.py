import unittest
import httpx
from app.dynamics import records

class DynamicsContract(unittest.TestCase):
    def config(self):
        return ("https://example.crm.dynamics.com","fq_dialogs",{"id":"fq_id"},{},{}, "test-only-not-a-real-credential")
    def test_retry_and_mapping(self):
        seen=[]
        def handle(req):
            seen.append(req)
            if len(seen)==1: return httpx.Response(429,headers={"Retry-After":"0"})
            return httpx.Response(200,json={"value":[{"fq_id":"example"}]})
        self.assertEqual(list(records(self.config(),httpx.MockTransport(handle),sleep=lambda _:None)),[{"id":"example"}])
        self.assertEqual(len(seen),2)
    def test_cross_origin_next_link_rejected_before_request(self):
        seen=[]
        def handle(req):
            seen.append(req)
            return httpx.Response(200,json={"value":[],"@odata.nextLink":"https://attacker.invalid/api/data/v9.2/x"})
        with self.assertRaises(ValueError):
            list(records(self.config(),httpx.MockTransport(handle)))
        self.assertEqual(len(seen),1)
    def test_http_failure_is_sanitized(self):
        with self.assertRaisesRegex(ValueError,"Dataverse HTTP 401"):
            list(records(self.config(),httpx.MockTransport(lambda _:httpx.Response(401,text="private"))))
