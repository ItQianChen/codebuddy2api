"""Representative catalog probes, retry backoff, diff marking and the manual full scan."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch

import converter
from app import model_policy, perf_metrics
from app.catalog_probe import AggregateCatalog, valid_row
from app.control_store import ControlStore
from app.credits import CreditLedger, ModelCatalogCache


def model(*names):
    return [{"id": name, "supportsToolCall": True, "credits": "x1 credits"} for name in names]


class AggregateCatalogTests(unittest.TestCase):
    def test_round_trip_persists_and_rejects_invalid_rows(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        store = ControlStore(root / "control.sqlite3")
        self.addCleanup(store.close)
        aggregate = AggregateCatalog(ttl=3600, store=store.state)
        aggregate.success("cn-cli", source="fingerprint-a", generation=3, models=["glm-5.3", "hy3"])
        reloaded = AggregateCatalog(ttl=3600, store=store.state)
        row = reloaded.row("cn-cli")
        self.assertEqual(row["source"], "fingerprint-a")
        self.assertEqual(row["source_generation"], 3)
        self.assertEqual(row["models"], ["glm-5.3", "hy3"])
        self.assertFalse(reloaded.due("cn-cli"))
        with self.assertRaises(ValueError):
            store.state.put("catalog_probe", {"version": 1, "profiles": {"cn-cli": {"source": 1}}})
        self.assertEqual(len(AggregateCatalog(ttl=3600, store=store.state).profiles()), 1)
        self.assertFalse(valid_row({"source": "a", "fetched_at": 1, "retry_at": 2, "status": "ok",
                                    "models": ["x"], "secret": "y"}))

    def test_failure_backs_off_then_recovers(self):
        aggregate = AggregateCatalog(ttl=3600, clock=lambda: 1000.0)
        aggregate.failure("cn-cli", source="fingerprint-a")
        self.assertFalse(aggregate.due("cn-cli"))
        row = aggregate.row("cn-cli")
        self.assertEqual(row["status"], "error")
        self.assertGreater(row["retry_at"], 1000.0)
        aggregate.failure("cn-cli", source="fingerprint-a")
        self.assertGreater(aggregate.row("cn-cli")["retry_at"], row["retry_at"])  # Exponential backoff.
        aggregate.success("cn-cli", source="fingerprint-a", generation=1, models=["hy3"])
        self.assertEqual(aggregate.row("cn-cli")["failures"], 0)
        self.assertTrue(aggregate.due("cn-cli", now=1000.0 + 3601))

    def test_choose_prefers_the_current_source_then_the_stalest_account(self):
        aggregate = AggregateCatalog(ttl=100, clock=lambda: 1000.0)
        accounts = [{"account_key": "a"}, {"account_key": "b"}, {"account_key": "c"}]
        ages = {"a": 500.0, "b": 1000.0, "c": None}
        age_of = lambda candidate: ages[candidate["account_key"]]
        aggregate.success("cn-cli", source="a", generation=1, models=["hy3"])
        aggregate._data["profiles"]["cn-cli"]["retry_at"] = 0.0
        self.assertEqual(aggregate.choose("cn-cli", accounts, age_of=age_of)["account_key"], "a")
        ages["a"] = 10.0  # The source just refreshed; rotation moves to the stalest account.
        self.assertEqual(aggregate.choose("cn-cli", accounts, age_of=age_of)["account_key"], "c")
        ages["c"] = 10.0
        self.assertEqual(aggregate.choose("cn-cli", accounts, age_of=age_of)["account_key"], "b")
        ages["b"] = 10.0
        self.assertIsNone(aggregate.choose("cn-cli", accounts, age_of=age_of))


class CatalogProbeTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, {"CODEBUDDY_AUTH_DIR": temporary}))
        self.enterContext(patch.object(perf_metrics, "_COUNTERS", {}))
        self.root = Path(temporary)
        self.calls = []

    def build(self, count=2, profile="cn-cli"):
        paths = []
        for index in range(count):
            path = self.root / f"account-{index}.info"
            path.write_text(json.dumps({"account": {"uid": f"probe-{index}"}, "auth": {
                "accessToken": f"token-{index}", "domain": "www.codebuddy.cn",
                "expiresAt": (time.time() + 3600) * 1000}}), encoding="utf-8")
            paths.append(path)
        pool = converter.CredentialPool(paths)
        ledger = CreditLedger(self.root / "ledger.json")
        pool.set_ledger(ledger)
        for entry in pool.entries():
            ledger.bind_identity(entry["id"], entry["account_key"])
            ledger.update_credits(entry["id"], {"credits": 100, "intl": False, "segments": []})
        cache = ModelCatalogCache(self.root / "catalog.json", ttl=60)
        aggregate = AggregateCatalog(ttl=3600)
        self.enterContext(patch.dict(converter.CONFIG, {
            "cred_pool": pool, "ledger": ledger, "model_cache": cache, "aggregate_catalog": aggregate,
            "catalog_probe_mode": "representative", "account_catalogs": {}, "catalog_index": None,
            "model_catalogs": {}, "model_guard": True, "log_path": None, "control_store": None}))
        return pool, ledger, cache, aggregate

    def refs(self, pool):
        result = {}
        for entry in pool.entries():
            cm = entry["cm"]
            with cm._lock:
                headers = cm.get_headers()
                result[entry["id"]] = (entry, cm._generation, headers, entry["profile"])
        return result

    def scopes(self, *names):
        def fetch(_token, **_kwargs):
            self.calls.append(names)
            return {"picker": model(*names), "account": model(*names)}
        return fetch

    def test_representative_probe_runs_once_per_profile_and_marks_differences(self):
        pool, ledger, cache, aggregate = self.build(3)
        entries = pool.entries()
        stale = {item["id"] for item in model("hy3")}
        cache.put(converter.catalog_cache_key("cn-cli", entries[1]["account_key"]), model("hy3"), serves=model("hy3"))
        with patch.object(converter.credits_mod, "fetch_model_scopes", side_effect=self.scopes("hy3", "glm-5.3")):
            converter._sync_model_catalogs(pool, ledger, self.refs(pool), set())
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(stale < {item["id"] for item in model("hy3", "glm-5.3")})
        fresh = [entry for entry in pool.entries() if not entry.get("catalog_dirty")]
        self.assertEqual(len(fresh), 1)  # Only the representative stored a new catalog.
        self.assertTrue(pool.entry_by_id(entries[1]["id"])["catalog_dirty"])
        self.assertFalse(aggregate.due("cn-cli"))
        self.assertEqual(aggregate.row("cn-cli")["models"], ["glm-5.3", "hy3"])
        with patch.object(converter.credits_mod, "fetch_model_scopes", side_effect=self.scopes("hy3")):
            converter._sync_model_catalogs(pool, ledger, self.refs(pool), set())
            self.assertEqual(len(self.calls), 1)  # The TTL suppresses another fetch.

    def test_probe_failure_keeps_other_catalogs_and_backs_off(self):
        pool, ledger, cache, aggregate = self.build(2)
        entries = pool.entries()
        cache.put(converter.catalog_cache_key("cn-cli", entries[0]["account_key"]), model("hy3"), serves=model("hy3"))
        failed = set()
        with patch.object(converter.credits_mod, "fetch_model_scopes", side_effect=RuntimeError("synthetic upstream")):
            converter._sync_model_catalogs(pool, ledger, self.refs(pool), failed)
        self.assertTrue(failed)
        self.assertLessEqual({"source", "status", "failures", "retry_at"}, set(aggregate.row("cn-cli")))
        self.assertEqual(aggregate.row("cn-cli")["status"], "error")
        self.assertFalse(aggregate.due("cn-cli"))
        kept = {item["id"] for item in cache.models(converter.catalog_cache_key("cn-cli", entries[0]["account_key"]))}
        self.assertEqual(kept, {"hy3"})  # The previous catalog survives a failed probe.

    def test_account_mode_still_refreshes_every_account(self):
        pool, ledger, cache, _ = self.build(2)
        self.enterContext(patch.dict(converter.CONFIG, {"catalog_probe_mode": "account"}))
        with patch.object(converter.credits_mod, "fetch_model_scopes", side_effect=self.scopes("hy3")):
            converter._sync_model_catalogs(pool, ledger, self.refs(pool), set())
        self.assertEqual(len(self.calls), 2)

    def test_manual_scan_refreshes_every_account_and_reports_differences(self):
        pool, _, cache, aggregate = self.build(3)
        entries = pool.entries()
        cache.put(converter.catalog_cache_key("cn-cli", entries[0]["account_key"]), model("hy3"), serves=model("hy3"))
        with patch.object(converter.credits_mod, "fetch_model_scopes", side_effect=self.scopes("hy3", "glm-5.3")):
            started = converter.start_catalog_scan()
            self.assertEqual(started["status"], "running")
            for _ in range(200):
                view = converter.catalog_scan_view()
                if view["status"] != "running":
                    break
                time.sleep(0.01)
        self.assertEqual(view["status"], "completed")
        self.assertEqual((view["total"], view["completed"], view["success"], view["failed"]), (3, 3, 3, 0))
        self.assertEqual(view["differences"], 1)  # Only the pre-seeded account changed.
        self.assertEqual(len(view["accounts"]), 3)
        self.assertEqual(aggregate.row("cn-cli")["status"], "ok")
        self.assertNotIn("token", json.dumps(view))

    def test_manual_scan_keeps_a_failed_accounts_previous_catalog(self):
        pool, _, cache, _ = self.build(3)
        entries = pool.entries()
        failed_key = converter.catalog_cache_key("cn-cli", entries[0]["account_key"])
        cache.put(failed_key, model("hy3"), serves=model("hy3"))

        def flaky(token, **_kwargs):
            if token == "token-0":
                raise RuntimeError("synthetic upstream")
            self.calls.append(token)
            return {"picker": model("glm-5.3"), "account": model("glm-5.3")}

        with patch.object(converter.credits_mod, "fetch_model_scopes", side_effect=flaky):
            converter.start_catalog_scan()
            for _ in range(200):
                view = converter.catalog_scan_view()
                if view["status"] != "running":
                    break
                time.sleep(0.01)
        self.assertEqual(view["status"], "completed")
        self.assertEqual((view["success"], view["failed"]), (2, 1))
        self.assertEqual([row["status"] for row in view["accounts"]].count("failed"), 1)
        # The failed account keeps its previous catalog instead of going empty.
        self.assertEqual({item["id"] for item in cache.models(failed_key)}, {"hy3"})
        self.assertEqual(set(self.calls), {"token-1", "token-2"})

    def test_manual_scan_reports_an_already_running_scan(self):
        pool, _, cache, _ = self.build(1)
        blocker = {}

        def slow_fetch(*args, **kwargs):
            blocker["started"] = True
            time.sleep(0.05)
            return {"picker": model("hy3"), "account": model("hy3")}
        with patch.object(converter.credits_mod, "fetch_model_scopes", side_effect=slow_fetch):
            first = converter.start_catalog_scan()
            second = converter.start_catalog_scan()
            for _ in range(200):
                if converter.catalog_scan_view()["status"] != "running":
                    break
                time.sleep(0.01)
        self.assertEqual(first["status"], "running")
        self.assertEqual(second["status"], "running")
        self.assertTrue(blocker.get("started"))

    def test_scan_reports_unavailable_catalog_without_credential_material(self):
        pool, _, cache, _ = self.build(1)
        with patch.dict(converter.CONFIG, {"model_cache": None}):
            with self.assertRaises(converter.HTTPException) as raised:
                converter.start_catalog_scan()
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main(verbosity=2)
