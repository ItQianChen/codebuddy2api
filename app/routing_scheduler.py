"""Revision-keyed credential shards for request-side selection."""
from __future__ import annotations

import time

from . import perf_metrics

MODES = ("legacy", "shadow", "indexed")
MISMATCH_LIMIT = 20


class RoutingScheduler:
    """Serve the statically eligible entries per model; dynamic health stays per request.

    ``legacy`` evaluates every credential on every request, ``indexed`` reuses a shard built
    for the current revision set, and ``shadow`` does both while returning the legacy answer.
    """

    __slots__ = ("_shards", "mismatches")

    def __init__(self):
        self._shards: dict[tuple, tuple] = {}
        self.mismatches: list[dict] = []

    @staticmethod
    def mode(config) -> str:
        """Resolve the configured mode, falling back to the safe indexed path."""
        value = config.get("routing_scheduler", "indexed")
        return value if value in MODES else "indexed"

    def clear(self):
        self._shards.clear()

    def candidates(self, *, mode, revisions, model, region, entries, evaluate):
        """Return statically eligible entries for one model and region."""
        if mode == "legacy":
            return [entry for entry in entries if evaluate(entry)]  # No shard is built.
        key = (model, region, *revisions)
        shard = self._shards.get(key)
        if shard is None:
            shard = tuple(entry for entry in entries if evaluate(entry))
            # Keep only the current revision set; a moved revision never reuses stale entries.
            self._shards = {key: shard}
            perf_metrics.inc("shard_builds")
            perf_metrics.inc("shard_size_rebuilt", len(shard))
        else:
            perf_metrics.inc("shard_hits")
        if mode == "shadow":
            legacy = [entry for entry in entries if evaluate(entry)]
            if legacy != list(shard):
                self.record(model, region, legacy, shard)
            return legacy
        return list(shard)

    def record(self, model, region, legacy, indexed):
        """Retain a bounded, credential-free description of one shadow mismatch."""
        perf_metrics.inc("scheduler_mismatches")
        self.mismatches.append({
            "at": time.time(), "model": model, "region": region,
            "legacy": [entry["id"] for entry in legacy],
            "indexed": [entry["id"] for entry in indexed]})
        del self.mismatches[:-MISMATCH_LIMIT]

    def report(self) -> dict:
        """Describe the active shard set without exposing tokens."""
        return {"shards": [
                    {"model": key[0], "region": key[1], "size": len(value)}
                    for key, value in self._shards.items()],
                "mismatches": list(self.mismatches)}
