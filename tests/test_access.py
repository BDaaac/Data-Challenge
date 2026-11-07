import unittest
from unittest.mock import patch
from fastapi import HTTPException
from app import main

class AccessTests(unittest.TestCase):
    def test_operator_cannot_open_unpublished_dialog(self):
        for status in ("new", "evaluating", "review", "error"):
            with self.subTest(status=status), patch.object(main, "one", return_value={"wf_status":status}):
                with self.assertRaises(HTTPException) as error:
                    main.visible_dialog({"role":"op","name":"test"}, "test")
                self.assertEqual(error.exception.status_code,404)

    def test_published_dialog_is_visible(self):
        with patch.object(main,"one",return_value={"wf_status":"published"}):
            self.assertEqual(main.visible_dialog({"role":"op","name":"test"},"test")["wf_status"],"published")

    def test_string_false_is_not_approval(self):
        with patch.object(main,"one",return_value={"status":"open"}):
            with self.assertRaises(HTTPException) as error:
                main.decide.__wrapped__(1,{"decisions":{"c1":"false"}},{"id":1,"role":"qa"})
            self.assertEqual(error.exception.status_code,422)
