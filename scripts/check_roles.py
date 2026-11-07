"""Role-policy regression checks; no database writes or model calls."""
import unittest
from unittest.mock import patch

from fastapi import HTTPException, Response
from starlette.requests import Request

from app import auth, main


class RolePolicyTests(unittest.TestCase):
    def test_demo_lists_only_supported_roles(self):
        rows = [{"role": role} for role in (*auth.ACTIVE_ROLES, "head", "dir", "comp")]
        with patch.object(auth, "DEMO", True), patch.object(main, "all_", return_value=rows):
            self.assertEqual(main.demo_users()["users"], rows[:4])

    def test_removed_roles_cannot_start_session(self):
        for role in ("head", "dir", "comp"):
            with patch.object(auth, "create_session") as create:
                with self.assertRaises(HTTPException) as error:
                    main._start(Response(), {"id": 1, "role": role})
                self.assertEqual(error.exception.status_code, 403)
                create.assert_not_called()

    def test_old_sessions_are_rejected(self):
        request = Request({"type": "http", "headers": [(b"cookie", b"cqa_session=test")]})
        for role in ("head", "dir", "comp"):
            with patch.object(auth, "one", return_value={"role": role, "active": True, "expired": False}), patch.object(auth, "run") as run:
                with self.assertRaises(HTTPException) as error:
                    auth.current_user(request)
                self.assertEqual(error.exception.status_code, 401)
                self.assertIn("DELETE FROM sessions", run.call_args.args[0])

    def test_removed_roles_cannot_be_assigned(self):
        for role in ("head", "dir", "comp"):
            with patch.object(main, "one", return_value={"role": "op", "active": True, "team": "A"}), patch.object(main, "run") as run:
                with self.assertRaises(HTTPException):
                    main.user_upd(2, {"role": role}, {"id": 1})
                with self.assertRaises(HTTPException):
                    main.user_add({"role": role, "name": "Test", "login": "test"}, {"id": 1})
                run.assert_not_called()

    def test_quality_actions_belong_to_qa(self):
        for path in ("/api/violations/{did}", "/api/checklists/{cid}/publish"):
            route = next(r for r in main.app.routes if r.path == path and r.dependant.dependencies)
            dep = route.dependant.dependencies[0].call
            self.assertEqual(dep({"role": "qa"}), {"role": "qa"})
            for role in ("op", "lead"):
                with self.assertRaises(HTTPException):
                    dep({"role": role})

    def test_team_scope_is_preserved(self):
        self.assertEqual(main.vis({"role": "lead", "team": "A"}), ("d.team=%s", ["A"]))
        self.assertEqual(main.vis({"role": "op", "name": "Test"}), ("d.operator=%s", ["Test"]))


if __name__ == "__main__":
    unittest.main()
