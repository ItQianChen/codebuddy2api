"""Revision-keyed shards: caching, invalidation, and behavioural parity with the legacy scan."""
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
from app import perf_metrics
from app.credits import CreditLedger
from app.routing_scheduler import MISMATCH_LIMIT, RoutingScheduler

PROFILES = ("cn-cli", "cn-work", "intl-cli", "intl-work")
DOMAINS = {"cn-cli": "www.codebuddy.cn", "cn-work": "www.workbuddy.cn",
           "intl-cli": "www.codebuddy.ai", "intl-work": "www.workbuddy.ai"}
MODELS = {
    "cn-cli": ["glm-5.3-flash", "deepseek-v4-flash"],
    "cn-work": ["auto", "glm-5.3-flash"],
    "intl-cli": ["default-model", "glm-5.3-flash"],
    "intl-work": ["default-model", "glm-5.3-flash"],
}


class SchedulerUnitTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(perf_metrics, "_COUNTERS", {}))
        self.enterContext(patch.object(perf_metrics, "_TIMINGS", {}))
        self.entries = [{"id": f"/cred-{index}"} for index in range(4)]

    def test_legacy_never_reuses_a_shard(self):
        scheduler = RoutingScheduler()
        calls = []
        evaluate = lambda entry: calls.append(entry) or entry["id"] != "/cred-0"
        first = scheduler.candidates(mode="legacy", revisions=(1,), model="m", region=None,
                                     entries=self.entries, evaluate=evaluate)
        second = scheduler.candidates(mode="legacy", revisions=(1,), model="m", region=None,
                                      entries=self.entries, evaluate=evaluate)
        self.assertEqual([entry["id"] for entry in first], ["/cred-1", "/cred-2", "/cred-3"])
        self.assertEqual(first, second)
        self.assertEqual(len(calls), 8)
        self.assertEqual(scheduler.report()["shards"], [])

    def test_indexed_builds_once_per_revision_set(self):
        scheduler = RoutingScheduler()
        calls = []
        evaluate = lambda entry: calls.append(entry) or True
        for revision in ((1, 2, 3, 4), (1, 2, 3, 4), (1, 2, 3, 5)):
            scheduler.candidates(mode="indexed", revisions=revision, model="m", region=None,
                                 entries=self.entries, evaluate=evaluate)
        self.assertEqual(len(calls), 8)  # Two builds, then a reuse.
        self.assertEqual(perf_metrics.snapshot()["counters"]["shard_builds"], 2)
        self.assertEqual(perf_metrics.snapshot()["counters"]["shard_hits"], 1)

    def test_shadow_returns_legacy_and_records_mismatches(self):
        scheduler = RoutingScheduler()
        allowed = {"value": 0}
        evaluate = lambda entry: allowed["value"] == 0
        scheduler.candidates(mode="indexed", revisions=(1,), model="m", region=None,
                             entries=self.entries, evaluate=evaluate)
        allowed["value"] = 1  # The index now disagrees with a live scan.
        result = scheduler.candidates(mode="shadow", revisions=(1,), model="m", region=None,
                                      entries=self.entries, evaluate=evaluate)
        self.assertEqual(result, [])
        report = scheduler.report()
        self.assertEqual(report["mismatches"][0]["legacy"], [])
        self.assertEqual(len(report["mismatches"][0]["indexed"]), 4)
        self.assertEqual(perf_metrics.snapshot()["counters"]["scheduler_mismatches"], 1)
        for index in range(MISMATCH_LIMIT + 5):
            scheduler.record("m", None, [], self.entries)
        self.assertEqual(len(scheduler.report()["mismatches"]), MISMATCH_LIMIT)


class SchedulerPoolTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, {"CODEBUDDY_AUTH_DIR": temporary}))
        self.root = Path(temporary)

    def build(self, count, mode="indexed"):
        paths = []
        for index in range(count):
            profile = PROFILES[index % len(PROFILES)]
            path = self.root / f"account-{index}.info"
            path.write_text(json.dumps({"account": {"uid": f"shard-{index}"}, "auth": {
                "accessToken": f"token-{index}", "domain": DOMAINS[profile],
                "expiresAt": (time.time() + 3600) * 1000}}), encoding="utf-8")
            paths.append(path)
        pool = converter.CredentialPool(paths)
        ledger = CreditLedger(self.root / f"ledger-{mode}.json")
        pool.set_ledger(ledger)
        accounts = {}
        for index, entry in enumerate(pool.entries()):
            profile = entry["profile"]
            ledger.bind_identity(entry["id"], entry["account_key"])
            ledger.update_credits(entry["id"], {"credits": 100 + index, "intl": profile.startswith("intl"),
                                                "segments": [{"remaining": 100, "expires_at": time.time() + 60 + index}]})
            models = [{"id": name, "supportsToolCall": True,
                       "credits": "x0 credits" if name == "glm-5.3-flash" else "x1 credits"}
                      for name in MODELS[profile]]
            accounts[entry["account_key"]] = {"profile": profile, "models": models, "serves": models}
        converter._configured_cache.clear()
        converter.invalidate_model_table()
        self.enterContext(patch.dict(converter.CONFIG, {
            "cred_pool": pool, "ledger": ledger, "control_store": None, "model_cache": None,
            "account_catalogs": accounts, "catalog_index": converter._publish_catalog_index(accounts),
            "model_catalogs": {}, "model_guard": True, "log_path": None, "routing_scheduler": mode,
            "max_inflight_per_account": 0}))
        return pool, ledger

    def script(self, pool, ledger):
        """Deterministic routing script exercising sticky, cooldown, tried and capacity paths."""
        observed = []
        pick = lambda skey=None, **kw: (pool.pick(skey, "glm-5.3-flash", **kw) or None)
        for _ in range(6):
            manager = pick()
            observed.append(Path(manager.path).name)
        for _ in range(4):
            observed.append(Path(pick(skey="session").path).name)
        first = pool.entries()[0]
        pool.note_status(first["cm"], 429, model="glm-5.3-flash")
        observed.append(Path(pick().path).name)
        observed.append(Path(pick(tried=(first["cm"],)).path).name)
        pool.cooldown(pool.entries()[1]["cm"], reason="synthetic")
        observed.append(Path(pick().path).name)
        ledger.update_credits(pool.entries()[2]["id"], {"credits": 0, "intl": False, "segments": []})
        observed.append(Path(pick().path).name)
        with patch.dict(converter.CONFIG, {"max_inflight_per_account": 1}):
            retained = []
            while True:
                manager = pick(with_capacity=True) if not retained else None
                if manager is None:
                    break
                retained.append(Path(manager.path).name)
            observed.extend(retained)
            try:
                pick(with_capacity=True)
            except converter.HTTPException as error:
                observed.append(str(error.status_code))
        return observed

    def test_modes_choose_the_same_credentials(self):
        results = {}
        for mode in ("legacy", "indexed", "shadow"):
            with patch.object(perf_metrics, "_COUNTERS", {}):
                pool, ledger = self.build(12, mode)
                results[mode] = self.script(pool, ledger)
                self.assertEqual(pool._scheduler.report()["mismatches"], [], mode)
        self.assertEqual(results["legacy"], results["indexed"])
        self.assertEqual(results["legacy"], results["shadow"])
        self.assertGreater(len(results["legacy"]), 10)

    def test_second_pick_reuses_the_shard_without_rechecking_eligibility(self):
        pool, _ = self.build(8)
        pool.pick("session", "glm-5.3-flash")
        with patch.object(converter.CredentialPool, "_eligible", wraps=pool._eligible) as eligible:
            pool.pick("session", "glm-5.3-flash")
            self.assertEqual(eligible.call_count, 0)
        self.assertEqual(perf_metrics.snapshot()["counters"]["shard_hits"], 1)

    def test_credential_reload_invalidates_the_shard(self):
        pool, _ = self.build(4)
        pool.pick("session", "glm-5.3-flash")
        revision = pool._shard_revisions()
        pool.reload([Path(entry["id"]) for entry in pool.entries()], reset=False)
        self.assertNotEqual(pool._shard_revisions(), revision)
        with patch.object(converter.CredentialPool, "_eligible", wraps=pool._eligible) as eligible:
            pool.pick("session", "glm-5.3-flash")
            self.assertGreater(eligible.call_count, 0)

    def test_balance_change_invalidates_the_shard(self):
        pool, ledger = self.build(4)
        pool.pick("session", "glm-5.3-flash")
        revision = pool._shard_revisions()
        ledger.update_credits(pool.entries()[0]["id"], {"credits": 0, "intl": False, "segments": []})
        self.assertNotEqual(pool._shard_revisions(), revision)


if __name__ == "__main__":
    unittest.main(verbosity=2)
