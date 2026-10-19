#!/usr/bin/env python3
"""Test the growth automation admin surface: per-account switches, batch, live task list."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import tempfile
import unittest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from types import SimpleNamespace
from unittest.mock import Mock

from app.admin_api import install_admin
from app.control_store import ControlStore


class GrowthAdminTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.store = ControlStore(self.root / "control.sqlite3")
        self.addCleanup(self.store.close)
        audit = Mock()
        audit.storage.return_value = {"db_bytes": 0}
        audit.list_records.return_value = {"items": [], "next_cursor": None, "has_more": False}
        audit.dashboard.return_value = {"summary": {}, "series": [], "models": [], "profiles": []}
        audit.clear.side_effect = lambda scope: {"scope": scope, "cleared": True}
        self.credentials = [{"account_key": "acct", "name": "cn.info", "profile": "cn-work", "enabled": True}]
        self.gateway = SimpleNamespace(
            admin_credential_inventory=Mock(side_effect=lambda: self.credentials),
            admin_set_credential_enabled=Mock(), admin_set_auto_checkin=Mock(),
            admin_set_auto_travel=Mock(), admin_set_auto_daily_chat=Mock(),
            admin_set_auto_growth=Mock(side_effect=lambda identity, value: self.store.set_auto_growth(identity, value)),
            admin_set_growth_auto=Mock(side_effect=lambda identity, mapping: self.store.set_growth_auto(identity, mapping)),
            admin_growth_tasks=Mock(side_effect=self.growth_tasks),
            admin_apply_settings=Mock(), admin_delete_guard=Mock(),
            managed_auth_dir=Mock(return_value=self.root), _store_credential=Mock(),
            catalog_status=Mock(return_value={}), start_catalog_scan=Mock(return_value={}),
            catalog_scan_view=Mock(return_value={}), _credential_identity=Mock(return_value="acct"),
            _save_oauth_credential=Mock(return_value=self.root / "cn.info"), _OAUTH=Mock())
        self.config = {"api_key": "synthetic-key", "control_store": self.store, "max_images": 16,
                       "session_path": self.root / "admin-sessions.json", "audit_store": audit}
        app = FastAPI()
        install_admin(app, self.config, self.gateway)
        self.client = TestClient(app)
        self.headers = {"Authorization": "Bearer synthetic-key"}

    def growth_tasks(self, identity):
        if identity != "acct":
            raise HTTPException(404, "凭证不存在")
        return {"supported": True, "auto_growth": True, "growth_auto": {"chat_5": True},
                "tasks": [{"task_code": "chat_5", "current": 5, "target": 5, "claimable": True,
                           "claimed": False, "locked": False, "group": "behavior",
                           "credit": 100, "energy": 0, "title": "对话活跃", "description": "",
                           "accept_status": "accepted"}]}

    def test_patch_auto_growth_roundtrip(self):
        response = self.client.patch("/admin/credentials/acct", headers=self.headers, json={"auto_growth": False})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(self.store.snapshot()["credentials"]["acct"]["auto_growth"])

    def test_patch_growth_auto_mapping(self):
        response = self.client.patch("/admin/credentials/acct", headers=self.headers,
                                     json={"growth_auto": {"chat_5": True}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.store.snapshot()["credentials"]["acct"]["growth_auto"], {"chat_5": True})
        bad = self.client.patch("/admin/credentials/acct", headers=self.headers,
                                json={"growth_auto": {"unknown_code": True}})
        self.assertEqual(bad.status_code, 400, bad.text)

    def test_patch_rejects_mixed_or_invalid_payloads(self):
        for payload in ({"auto_growth": "yes"}, {"growth_auto": "x"}, {"auto_growth": True, "enabled": True},
                        {"growth_auto": {"chat_5": "true"}}):
            with self.subTest(payload=payload):
                response = self.client.patch("/admin/credentials/acct", headers=self.headers, json=payload)
                self.assertEqual(response.status_code, 400, response.text)

    def test_growth_tasks_list(self):
        response = self.client.get("/admin/credentials/acct/growth-tasks", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["supported"])
        self.assertEqual([task["task_code"] for task in body["tasks"]], ["chat_5"])
        missing = self.client.get("/admin/credentials/other/growth-tasks", headers=self.headers)
        self.assertEqual(missing.status_code, 404, missing.text)

    def test_growth_batch_sets_switches(self):
        self.store.set_growth_auto("acct", {"expert_5": True})
        self.credentials.append({"account_key": "acct2", "name": "cn2.info", "profile": "cn-work", "enabled": True})
        response = self.client.post("/admin/credentials/growth-batch", headers=self.headers,
                                    json={"ids": ["acct", "acct2"], "task_codes": ["chat_5"],
                                          "enabled": False})
        self.assertEqual(response.status_code, 200, response.text)
        state = self.store.snapshot()["credentials"]
        # 批量合并：只改列出的任务，未列出的开关保持原值。
        self.assertEqual(state["acct"]["growth_auto"], {"expert_5": True, "chat_5": False})
        self.assertEqual(state["acct2"]["growth_auto"], {"chat_5": False})

    def test_growth_batch_master_switch(self):
        response = self.client.post("/admin/credentials/growth-batch", headers=self.headers,
                                    json={"ids": ["acct"], "task_codes": [], "enabled": False})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(self.store.snapshot()["credentials"]["acct"]["auto_growth"])

    def test_growth_batch_rejects_unknown_account_and_payload(self):
        missing = self.client.post("/admin/credentials/growth-batch", headers=self.headers,
                                   json={"ids": ["ghost"], "task_codes": ["chat_5"], "enabled": True})
        self.assertEqual(missing.status_code, 404, missing.text)
        bad = self.client.post("/admin/credentials/growth-batch", headers=self.headers,
                               json={"ids": "acct", "task_codes": [], "enabled": True})
        self.assertEqual(bad.status_code, 400, bad.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
