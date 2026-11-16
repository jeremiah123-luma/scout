"""The catch-up mode and the dry-run promise, end to end through scout/run.py. Nothing is sent. No network."""

import pathlib
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

from scout import alerts, eligibility, listings, notify, pages, run, scoring

FIXTURES = Path(__file__).parent / "fixtures"
W = scoring.load_weights()
NOW = datetime(2026, 10, 16, 20, 17, tzinfo=ZoneInfo("America/New_York")).timestamp()  # past 7:00 PM, so the digest runs too


def match(key, **over):
    m = {"key": key, "company": "Acme", "title": "Software Engineer Intern", "url": f"https://x.com/{key}",
         "urls": [f"https://x.com/{key}"], "locations": ["Newark, NJ"], "score": 70, "tier": 1,
         "early_career": "none", "role": "swe", "eligibility": "unknown", "eligibility_note": "",
         "date_posted": NOW - 86400 * 40}
    m.update(over)
    return m


def seeded(*keys):
    return {k: {"at": "2026-10-15T00:17:00+00:00", "via": "seeded", "company": "Acme", "title": "t", "score": 70,
                "urls": [f"https://x.com/{k}"]} for k in keys}


class FakeSender(run.Sender):
    def __init__(self, dry_run=False):
        super().__init__(topic="t", dry_run=dry_run)
        self.pushes = []

    def send(self, push):
        self.pushes.append(push)
        return True


class Catchup(unittest.TestCase):
    def go(self, matches, seen, dry_run=False):
        saved = []
        sender = FakeSender(dry_run)
        with mock.patch.object(run, "score_everything", return_value=(matches, W)), \
             mock.patch.object(run, "on_data_branch", return_value=True), \
             mock.patch.object(alerts, "load_seen", return_value=seen), \
             mock.patch.object(alerts, "save_seen", side_effect=lambda s: saved.append(dict(s))):
            run.mode_catchup(sender, NOW)
        return sender.pushes, saved

    def test_picks_seeded_big_tech_and_programs_that_are_still_open(self):
        matches = [
            match("ms", company="Microsoft", tier=1, score=59),
            match("prog", tier=3, score=50, early_career="strong"),
            match("t2", tier=2, score=40),
            match("plain", tier=3, score=80),                         # Tier 3, no program: not big tech
            match("gone", tier=1, eligibility="closed"),
            match("ruled", tier=1, eligibility="ineligible"),
            match("pushed", tier=1),                                  # already alerted the normal way
        ]
        seen = seeded("ms", "prog", "t2", "plain", "gone", "ruled", "dropped")   # "dropped" left the lists
        seen["pushed"] = {"at": "2026-10-15T01:17:00+00:00", "via": "instant", "urls": ["https://x.com/pushed"]}
        self.assertEqual([m["key"] for m in alerts.select_catchup(matches, seen)], ["ms", "prog", "t2"])

        pushes, saved = self.go(matches, seen)
        self.assertEqual(len(pushes), 1, "one digest, not one push per posting")
        self.assertIn("Microsoft", pushes[0]["message"])
        self.assertIn("https://x.com/prog", pushes[0]["message"])
        self.assertNotIn("x.com/plain", pushes[0]["message"])
        after = saved[-1]
        self.assertEqual({k for k, v in after.items() if v["via"] == "catchup"}, {"ms", "prog", "t2"})
        self.assertEqual(after["dropped"]["via"], "seeded")

    def test_a_real_send_off_the_data_branch_refuses(self):
        sender = FakeSender()
        with mock.patch.object(run, "on_data_branch", return_value=False), \
             mock.patch.object(run, "score_everything") as scored:
            run.mode_catchup(sender, NOW)
        self.assertEqual(sender.pushes, [])
        scored.assert_not_called()

    def test_size_cap_counts_bytes(self):
        rows = [match(f"k{i}", company="Zürich Zürich Zürich", tier=1) for i in range(60)]
        push, listed = notify.catchup_push(rows, NOW)
        self.assertLessEqual(len(push["message"].encode("utf-8")), 3800)
        self.assertLess(len(listed), 60)

    def test_never_repeats(self):
        matches = [match("ms"), match("prog", tier=3, early_career="strong")]
        seen = seeded("ms", "prog")
        self.go(matches, seen)
        pushes, _ = self.go(matches, seen)
        self.assertEqual(pushes[0]["title"], "Scout catch-up: nothing to catch up on")
        self.assertEqual(alerts.select_catchup(matches, seen), [])

    def test_a_long_list_spills_into_the_next_run_without_repeats(self):
        matches = [match(f"k{i:03d}", title=f"Software Engineer Intern, Team {i}") for i in range(80)]
        seen = seeded(*(m["key"] for m in matches))
        first, _ = self.go(matches, seen)
        self.assertLessEqual(len(first[0]["message"]), 3800, "must fit ntfy's message cut")
        self.assertIn("more qualify", first[0]["message"])
        listed_first = {k for k, v in seen.items() if v["via"] == "catchup"}
        self.assertTrue(0 < len(listed_first) < 80)
        second, _ = self.go(matches, seen)
        for key in listed_first:
            self.assertNotIn(f"https://x.com/{key}\n", second[0]["message"] + "\n")

    def test_dry_run_marks_nothing(self):
        seen = seeded("ms")
        pushes, saved = self.go([match("ms")], seen, dry_run=True)
        self.assertEqual(len(pushes), 1)
        self.assertEqual(saved, [])
        self.assertEqual(seen["ms"]["via"], "seeded")

    def test_cli_accepts_the_mode(self):
        with mock.patch("sys.argv", ["scout.run", "--mode", "catchup", "--dry-run"]), \
             mock.patch.object(run, "mode_catchup") as called, mock.patch.object(notify, "topic_from_env", return_value=None):
            self.assertEqual(run.main(), 0)
        called.assert_called_once()

    def test_workflow_input_mentions_catchup(self):
        workflow = (Path(__file__).parent.parent / ".github" / "workflows" / "scout.yml").read_text()
        self.assertIn("catchup", workflow)


class DryRunSavesNothing(unittest.TestCase):
    """--dry-run must leave data/ exactly as it was: no seen list, no matches, no eligibility cache, no page prints."""

    def test_watch_dry_run_writes_no_file(self):
        raw = {"simplify": listings.load_json(FIXTURES / "simplify.json"),
               "vanshb03": listings.load_json(FIXTURES / "vanshb03.json")}
        writes = []

        def record(name):
            def fake(self, *a, **k):
                writes.append((name, str(self)))
            return fake

        page_text = "Explore Program\n" + "\n".join(f"Line {i} about the program and who it is for." for i in range(40))
        with mock.patch.object(listings, "fetch_all", return_value=(raw, [])), \
             mock.patch.object(eligibility, "fetch_text", return_value="Open to students graduating in 2030."), \
             mock.patch.object(eligibility, "is_readable_board", return_value=True), \
             mock.patch.object(pages, "fetch_text", return_value=page_text), \
             mock.patch.object(pathlib.Path, "write_text", record("write_text")), \
             mock.patch.object(pathlib.Path, "write_bytes", record("write_bytes")), \
             mock.patch.object(pathlib.Path, "mkdir", record("mkdir")), \
             mock.patch.object(pathlib.Path, "unlink", record("unlink")):
            sender = FakeSender(dry_run=True)
            run.mode_watch(sender, NOW)
        self.assertEqual(writes, [])
        self.assertTrue(any(p["title"].startswith("Scout digest") for p in sender.pushes), "the digest still prints")


class PageChecksCanSkipSaving(unittest.TestCase):
    def test_no_prints_written_and_the_change_still_shows_next_time(self):
        import tempfile
        v1 = "\n".join(f"Line {i} about the Explore program and who it is for." for i in range(30))
        v2 = v1 + "\nApplications are now open. Apply by October 31."
        page = [{"name": "Explore", "url": "https://example.com/explore"}]
        with tempfile.TemporaryDirectory() as tmp:
            state = {}
            pages.check_pages(page, state, fetch=lambda u: v1, text_dir=Path(tmp), now=NOW)
            before = sorted(p.name for p in Path(tmp).iterdir())
            dry_state = {u: dict(r) for u, r in state.items()}
            dry = pages.check_pages(page, dry_state, fetch=lambda u: v2, text_dir=Path(tmp), now=NOW, save=False)
            self.assertEqual([e["kind"] for e in dry], ["changed"])
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), before)
            self.assertEqual((Path(tmp) / before[0]).read_text().count("\n"), 30, "prints file untouched")
            real = pages.check_pages(page, state, fetch=lambda u: v2, text_dir=Path(tmp), now=NOW)
            self.assertEqual([e["kind"] for e in real], ["changed"], "the real run still sees the change")

    def test_dry_run_creates_no_folder(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            where = Path(tmp) / "pages"
            pages.check_pages([{"name": "X", "url": "https://example.com/x"}], {}, fetch=lambda u: "x" * 500,
                              text_dir=where, now=NOW, save=False)
            self.assertFalse(where.exists())


class EligibilityCacheInDryRun(unittest.TestCase):
    def test_watch_run_save_false_keeps_the_cache_in_memory(self):
        from scout import matching, watch
        raw = {"simplify": listings.load_json(FIXTURES / "simplify.json")}
        with mock.patch.object(eligibility, "fetch_text", return_value="Graduating in 2030."), \
             mock.patch.object(eligibility, "is_readable_board", return_value=True), \
             mock.patch.object(eligibility, "load_cache", return_value={}), \
             mock.patch.object(eligibility, "save_cache") as save:
            matches, _ = watch.run(raw, {**matching.load_targets(), "max_age_days": None}, W, check_pages=3, allow_network=True, now=NOW, save=False)
            save.assert_not_called()
            self.assertTrue(any(m["eligibility"] == "ok" for m in matches), "pages were still read")
            watch.run(raw, {**matching.load_targets(), "max_age_days": None}, W, check_pages=3, allow_network=True, now=NOW)
            save.assert_called_once()


class OpenTotal(unittest.TestCase):
    def test_ruled_out_postings_are_not_open(self):
        import json, tempfile
        from collections import Counter
        from scout import watch
        rows = [match("a"), match("b", eligibility="ineligible"), match("c", eligibility="closed"), match("d", eligibility="ok")]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "matches.json"
            watch.write_matches(rows, Counter(), out, limit=1)
            data = json.loads(out.read_text())
        self.assertEqual((data["total_matches"], data["open_total"], len(data["matches"])), (4, 2, 1))


if __name__ == "__main__":
    unittest.main()
