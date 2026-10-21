"""The dashboard sync payloads, on temp folders. No network."""

import json
import tempfile
import unittest
from pathlib import Path

from scout import sync


class Push(unittest.TestCase):
    def test_payload_carries_first_seen_and_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            d, c = Path(tmp) / "data", Path(tmp) / "config"
            d.mkdir(); c.mkdir()
            (d / "matches.json").write_text(json.dumps({"generated_at": "2026-10-14T23:00:00+00:00", "counts": {"kept": 1},
                                                        "matches": [{"key": "a", "company": "Acme", "score": 70}]}))
            (d / "seen.json").write_text(json.dumps({"a": {"at": "2026-10-14T22:00:00+00:00", "via": "instant"}}))
            (d / "tracker.json").write_text(json.dumps({"a": {"state": "Prepped", "updated": "2026-10-14"}}))
            (c / "targets.yaml").write_text("tier1: {}\n")
            payload = sync.build_push_payload(d, c)
            self.assertEqual(payload["matches"][0]["first_seen"], "2026-10-14T22:00:00+00:00")
            self.assertNotIn("tracker", payload, "the cron must never send back the tracker it pulled")
            self.assertEqual(payload["config_text"]["targets"], "tier1: {}\n")
            self.assertEqual(payload["config_text"]["scoring"], "")
            self.assertEqual(payload["total_matches"], 1, "falls back to the rows sent when the file has no total")

    def test_payload_carries_the_real_total(self):
        with tempfile.TemporaryDirectory() as tmp:
            d, c = Path(tmp) / "data", Path(tmp) / "config"
            d.mkdir(); c.mkdir()
            (d / "matches.json").write_text(json.dumps({"total_matches": 1197,
                                                        "matches": [{"key": f"k{i}", "company": "Acme"} for i in range(300)]}))
            payload = sync.build_push_payload(d, c)
            self.assertEqual(payload["total_matches"], 1197)
            self.assertEqual(len(payload["matches"]), 300)

    def test_the_dashboard_counts_from_the_total(self):
        worker = (Path(__file__).parent.parent / "worker" / "src" / "index.js").read_text()
        self.assertIn("total_matches: Number.isInteger(body.total_matches)", worker, "ingest keeps the total")
        self.assertIn('id="open-count">${openCount.toLocaleString("en-US")}', worker, "the big number is the real count")
        self.assertIn("showing the top ${data.matches.length}", worker)


class Pull(unittest.TestCase):
    def test_writes_tracker_queue_passed(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            summary = sync.apply_pull({"tracker": {"a": {"state": "Applied"}}, "queue": [{"key": "b"}], "passed": {"c": "2026-10-14"}}, d)
            self.assertEqual(summary, {"tracker": 1, "kept_local": 0, "queue": 1, "passed": 1})
            self.assertEqual(json.loads((d / "queue.json").read_text())[0]["key"], "b")


class PullKeepsMacChanges(unittest.TestCase):
    """pull used to replace data/tracker.json, so a /prep or scout.tracker set change not pushed yet was lost."""

    def pull(self, local, remote):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "tracker.json").write_text(json.dumps(local))
            summary = sync.apply_pull({"tracker": remote, "queue": [], "passed": {}}, d)
            return json.loads((d / "tracker.json").read_text()), summary

    def test_a_newer_local_row_survives_an_older_dashboard_copy(self):
        local = {"a": {"state": "Prepped", "updated": "2026-10-21", "history": [{"state": "Found"}, {"state": "Prepped"}]}}
        remote = {"a": {"state": "Found", "updated": "2026-10-19", "history": [{"state": "Found"}]}}
        tracker, summary = self.pull(local, remote)
        self.assertEqual(tracker["a"]["state"], "Prepped")
        self.assertEqual(summary["kept_local"], 1)

    def test_a_newer_phone_change_wins(self):
        local = {"a": {"state": "Prepped", "updated": "2026-10-19", "history": [{"state": "Prepped"}]}}
        remote = {"a": {"state": "Applied", "updated": "2026-10-21", "history": [{"state": "Prepped"}, {"state": "Applied"}]}}
        self.assertEqual(self.pull(local, remote)[0]["a"]["state"], "Applied")

    def test_same_day_the_longer_history_wins(self):
        # The X on the dashboard stamps a full timestamp and appends to the history.
        local = {"a": {"state": "Prepped", "updated": "2026-10-21", "history": [{"state": "Prepped"}]}}
        remote = {"a": {"state": "Passed", "updated": "2026-10-21T14:02:00Z", "history": [{"state": "Prepped"}, {"state": "Passed"}]}}
        self.assertEqual(self.pull(local, remote)[0]["a"]["state"], "Passed")

    def test_rows_only_on_the_mac_are_kept_and_dashboard_rows_added(self):
        tracker, _ = self.pull({"mac": {"state": "Prepped", "updated": "2026-10-21"}}, {"phone": {"state": "Applied", "updated": "2026-10-20"}})
        self.assertEqual(sorted(tracker), ["mac", "phone"])


class RefreshMatches(unittest.TestCase):
    def run_refresh(self, local, remote):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            if local is not None:
                (d / "matches.json").write_text(json.dumps(local))
            asked = []
            note = sync.refresh_matches(d, repo="someone/scout", fetch=lambda url: asked.append(url) or json.dumps(remote).encode())
            return note, json.loads((d / "matches.json").read_text()), asked

    def test_a_newer_cron_copy_replaces_a_stale_one(self):
        note, matches, asked = self.run_refresh({"generated_at": "2026-10-15T00:00:00+00:00", "matches": []},
                                                {"generated_at": "2026-10-21T02:00:00+00:00", "matches": [{"key": "x"}]})
        self.assertEqual(matches["matches"], [{"key": "x"}])
        self.assertIn("refreshed", note)
        self.assertEqual(asked, ["https://raw.githubusercontent.com/someone/scout/data/matches.json"])

    def test_an_older_or_broken_copy_never_replaces_the_local_one(self):
        local = {"generated_at": "2026-10-21T02:00:00+00:00", "matches": [{"key": "keep"}]}
        for remote in ({"generated_at": "2026-10-20T00:00:00+00:00", "matches": []}, {"oops": True}):
            note, matches, _ = self.run_refresh(local, remote)
            self.assertEqual(matches["matches"], [{"key": "keep"}], note)

    def test_a_failed_fetch_is_a_note_not_a_crash(self):
        def boom(url):
            raise OSError("offline")
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIn("not refreshed", sync.refresh_matches(Path(tmp), repo="x/y", fetch=boom))


class Settings(unittest.TestCase):
    def test_missing_settings_mean_skip(self):
        import os
        saved = {k: os.environ.pop(k, None) for k in ("SCOUT_URL", "SCOUT_INGEST_SECRET")}
        try:
            if not sync.ENV_FILE.exists():
                self.assertIsNone(sync.settings())
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v


class TrackerOnly(unittest.TestCase):
    def test_sends_only_the_tracker_to_its_own_route(self):
        from unittest import mock
        calls = []
        with mock.patch.object(sync, "settings", return_value=("https://dash.example", "s")), \
             mock.patch.object(sync, "_load", return_value={"k": {"state": "Prepped", "updated": "2026-10-16"}}), \
             mock.patch.object(sync, "_call", side_effect=lambda url, secret, method="GET", body=None: calls.append((url, body)) or {"tracker": 1}), \
             mock.patch("sys.argv", ["scout.sync", "push", "--tracker-only"]):
            self.assertEqual(sync.main(), 0)
        self.assertEqual(calls, [("https://dash.example/api/ingest-tracker", {"tracker": {"k": {"state": "Prepped", "updated": "2026-10-16"}}})])


if __name__ == "__main__":
    unittest.main()
