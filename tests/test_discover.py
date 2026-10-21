"""Boards found in the lists' links, read in a rotating batch. Every board answer is faked. No network."""

import io
import json
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

from scout import boards, dedupe, discover, matching

NOW = 1792540800.0  # 2026-10-21, noon-ish UTC


def http_404():
    return urllib.error.HTTPError("https://api.lever.co/v0/postings/gone", 404, "Not Found", {}, io.BytesIO(b""))


def entry(kind="greenhouse", slug="acme", company="Acme", last_read=None, failures=0, first_seen="2026-10-01T00:00:00+00:00"):
    return {"slug": slug, "kind": kind, "company": company, "first_seen": first_seen,
            "last_read": last_read, "last_count": None, "failures": failures}


def intern_rows(slug, company, now=None, fetch=None):
    return [{"id": f"{slug}:1", "source": "boards", "company": company, "title": "Software Engineer Intern",
             "url": f"https://boards.greenhouse.io/{slug}/jobs/1"}]


class BoardFromUrl(unittest.TestCase):
    def test_each_host_form(self):
        cases = {
            "https://boards.greenhouse.io/transcarent/jobs/5806321004": ("greenhouse", "transcarent"),
            "https://job-boards.greenhouse.io/drwuniversityjobs/jobs/7642959?gh_src=x": ("greenhouse", "drwuniversityjobs"),
            "https://jobs.lever.co/multiplylabs/8203fbb3-4d42-4f6a-ae64-f05c3dcf0e9b/apply": ("lever", "multiplylabs"),
            "https://jobs.ashbyhq.com/G2/c61dbaff-87e5-4481-82a7-0636e8aea415/application": ("ashby", "G2"),
            "https://jobs.ashbyhq.com/Acme%20Careers/c61dbaff-87e5-4481-82a7-0636e8aea415": ("ashby", "Acme Careers"),
            "https://jobs.smartrecruiters.com/BoschGroup/744000110888755": ("smartrecruiters", "BoschGroup"),
            "https://careers.smartrecruiters.com/RedBull": ("smartrecruiters", "RedBull"),
        }
        for url, expected in cases.items():
            self.assertEqual(discover.board_from_url(url), expected, url)

    def test_junk_urls_give_nothing(self):
        for url in ("https://www.weareroku.com/jobs/7645901?gh_jid=7645901",  # a company site: no board name
                    "https://boards.greenhouse.io/embed/job_app?for=acme&token=1",
                    "https://boards.greenhouse.io/acme",  # not a job link
                    "https://job-boards.eu.greenhouse.io/imc/jobs/4780585101",  # EU host, other API
                    "https://jobs.eu.lever.co/cirrus/e7182492-be4e-465f-8123-77a48aa3bcd3/apply",
                    "https://jobright.ai/jobs/info/6ac83eb351a1b3e4219f0f08",
                    "https://jobs.lever.co/", "not a url", "", None,
                    "https://jobs.lever.co/<script>/1", "https://evil.example/jobs.lever.co/acme/1"):
            self.assertIsNone(discover.board_from_url(url), url)


class Discover(unittest.TestCase):
    def test_new_boards_keep_the_lists_company_name_and_targets_are_skipped(self):
        items = [
            {"company": "DRW", "url": "https://job-boards.greenhouse.io/drwuniversityjobs/jobs/1", "active": False},
            {"company": "DRW Holdings", "url": "https://boards.greenhouse.io/DRWUniversityJobs/jobs/2"},  # same board
            {"company": "Figma", "url": "https://boards.greenhouse.io/figma/jobs/3"},  # read from targets.yaml already
            {"company": "Bosch", "url": "https://jobs.smartrecruiters.com/BoschGroup/744000110888755"},
            {"company": "Roku", "url": "https://www.weareroku.com/jobs/7645901?gh_jid=7645901"},
        ]
        state = {}
        added = discover.discover(items, state, NOW, skip={"greenhouse:figma"})
        self.assertEqual(added, 2)
        self.assertEqual(sorted(state), ["greenhouse:drwuniversityjobs", "smartrecruiters:boschgroup"])
        drw = state["greenhouse:drwuniversityjobs"]
        self.assertEqual((drw["company"], drw["slug"], drw["last_read"], drw["failures"]), ("DRW", "drwuniversityjobs", None, 0))
        self.assertEqual(discover.discover(items, state, NOW + 3600), 1)  # only Figma, now that it is not skipped


class Rotation(unittest.TestCase):
    def test_oldest_first_and_never_read_before_everything(self):
        state = {"greenhouse:new": entry(slug="new"),
                 "lever:old": entry("lever", "old", last_read="2026-10-20T01:00:00+00:00"),
                 "ashby:recent": entry("ashby", "recent", last_read="2026-10-21T09:00:00+00:00"),
                 "lever:older": entry("lever", "older", last_read="2026-10-19T01:00:00+00:00")}
        self.assertEqual(discover.pick_batch(state, size=3), ["greenhouse:new", "lever:older", "lever:old"])

    def test_batch_size_reads_each_board_about_every_8_runs(self):
        self.assertEqual(discover.batch_size(1145), 144)
        self.assertEqual(discover.batch_size(10), discover.MIN_BATCH)
        self.assertEqual(discover.batch_size(100_000), discover.MAX_BATCH)
        state = {f"greenhouse:b{i}": entry(slug=f"b{i}") for i in range(400)}
        self.assertEqual(len(discover.pick_batch(state)), 50)

    def test_a_full_rotation_reads_every_board(self):
        state = {f"greenhouse:b{i}": entry(slug=f"b{i}") for i in range(400)}
        read = set()
        for hour in range(8):
            keys = discover.pick_batch(state)
            discover.read_batch(state, keys, NOW + hour * 3600, readers={"greenhouse": intern_rows})
            read.update(keys)
        self.assertEqual(len(read), 400)


class Failures(unittest.TestCase):
    def test_three_404s_drop_a_board_and_it_is_not_found_again(self):
        def gone(slug, company, now=None, fetch=None):
            raise http_404()
        state = {"lever:gone": entry("lever", "gone")}
        for run in range(3):
            self.assertEqual(discover.pick_batch(state), ["lever:gone"])
            rows, errors = discover.read_batch(state, ["lever:gone"], NOW + run, readers={"lever": gone})
            self.assertEqual(rows, [])
            self.assertIn("lever gone", errors[0])
        self.assertEqual(state["lever:gone"]["failures"], 3)
        self.assertEqual(discover.pick_batch(state), [])
        discover.discover([{"company": "Gone", "url": "https://jobs.lever.co/gone/8203fbb3-4d42-4f6a-ae64-f05c3dcf0e9b"}], state, NOW)
        self.assertEqual(discover.pick_batch(state), [])  # still dropped, not added back fresh

    def test_a_timeout_does_not_count_and_a_good_read_resets(self):
        def slow(slug, company, now=None, fetch=None):
            raise TimeoutError("The read operation timed out")
        state = {"greenhouse:acme": entry(failures=2)}
        discover.read_batch(state, ["greenhouse:acme"], NOW, readers={"greenhouse": slow})
        self.assertEqual(state["greenhouse:acme"]["failures"], 2)
        rows, _ = discover.read_batch(state, ["greenhouse:acme"], NOW, readers={"greenhouse": intern_rows})
        self.assertEqual((state["greenhouse:acme"]["failures"], state["greenhouse:acme"]["last_count"]), (0, 1))
        self.assertTrue(rows[0]["discovered"])

    def test_boards_not_reached_in_time_stay_first_in_line(self):
        state = {"greenhouse:a": entry(slug="a"), "greenhouse:b": entry(slug="b")}
        rows, errors = discover.read_batch(state, ["greenhouse:a", "greenhouse:b"], NOW,
                                           readers={"greenhouse": intern_rows}, budget=-1)
        self.assertEqual((rows, errors), ([], []))
        self.assertIsNone(state["greenhouse:a"]["last_read"])

    def test_one_failing_board_never_hides_the_others_and_small_failures_stay_quiet(self):
        def some_fail(slug, company, now=None, fetch=None):
            if slug == "b3":
                raise http_404()
            return intern_rows(slug, company)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "boards.json"
            items = [{"company": f"B{i}", "url": f"https://boards.greenhouse.io/b{i}/jobs/{i}"} for i in range(30)]
            rows, errors = discover.run(items, {}, NOW, path=path, readers={"greenhouse": some_fail})
            self.assertEqual(len(rows), 24)  # MIN_BATCH (25) of the 30, minus the one that failed
            self.assertEqual(errors, [])  # one of 25 failing is not worth a push
            self.assertEqual(len(json.loads(path.read_text())["boards"]), 30)

    def test_most_of_a_batch_failing_is_one_summary_line(self):
        errors = [f"greenhouse b{i}: HTTP Error 429" for i in range(200)]
        lines = discover.summarize(errors, 250)
        self.assertEqual(len(lines), 1)
        self.assertIn("200 of 250 failed", lines[0])
        self.assertEqual(discover.summarize(errors[:10], 250), [])

    def test_a_dry_run_saves_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "boards.json"
            items = [{"company": "Acme", "url": "https://boards.greenhouse.io/acme/jobs/1"}]
            rows, _ = discover.run(items, {}, NOW, save_state=False, path=path, readers={"greenhouse": intern_rows})
            self.assertEqual(len(rows), 1)
            self.assertFalse(path.exists())


    def test_a_dry_run_of_the_cron_leaves_boards_json_alone(self):
        from unittest import mock
        from scout import listings, run
        with mock.patch.object(listings, "fetch_all", return_value=({}, [])) as fetch_all:
            run.score_everything(run.Sender(None, dry_run=True), NOW)
        self.assertEqual(fetch_all.call_args.kwargs, {"save_boards": False})


class AgeCutoff(unittest.TestCase):
    """Hand-picked boards skip the 240-day cutoff (Palantir's yearly fellowship); discovered boards keep it."""

    def setUp(self):
        self.targets = matching.load_targets()
        lev = [{"id": "f1", "text": "Software Engineer Intern", "hostedUrl": "https://jobs.lever.co/acme/f1",
                "categories": {"allLocations": ["New York, NY"]}, "createdAt": int((NOW - 900 * 86400) * 1000)}]
        self.when = datetime.fromtimestamp(NOW, timezone.utc)
        self.fetch = lambda url: lev

    def test_a_years_old_posting_on_a_discovered_board_is_dropped(self):
        def reader(slug, company, now=None, fetch=None):
            return boards.lever(slug, company, now, fetch=self.fetch)
        state = {"lever:acme": entry("lever", "acme")}
        rows, _ = discover.read_batch(state, ["lever:acme"], NOW, readers={"lever": reader})
        row = matching.describe(rows[0], self.targets)
        self.assertEqual(matching.passes_filters(row, max_age_days=240, now=NOW), (False, "older than 240 days"))

    def test_the_same_posting_on_a_hand_picked_board_is_kept(self):
        row = matching.describe(boards.lever("acme", "Acme", self.when, fetch=self.fetch)[0], self.targets)
        self.assertTrue(matching.passes_filters(row, max_age_days=240, now=NOW)[0])


class Dedupe(unittest.TestCase):
    def test_a_list_row_beats_a_discovered_copy_whatever_link_form_each_uses(self):
        pairs = [
            ("https://job-boards.greenhouse.io/acme/jobs/7642959", "https://boards.greenhouse.io/acme/jobs/7642959"),
            ("https://jobs.lever.co/acme/8203fbb3-4d42-4f6a-ae64-f05c3dcf0e9b/apply",
             "https://jobs.lever.co/acme/8203fbb3-4d42-4f6a-ae64-f05c3dcf0e9b"),
            ("https://jobs.smartrecruiters.com/BoschGroup/744000110888755?trid=x",
             "https://jobs.smartrecruiters.com/BoschGroup/744000110888755"),
        ]
        for listed_url, board_url in pairs:
            listed = {"source": "simplify", "company": "Acme", "title": "Software Engineer Intern", "date_updated": 1,
                      "url": listed_url}
            board = {"source": "boards", "discovered": True, "company": "Acme", "title": "Software Engineering Intern 2027",
                     "date_updated": 99, "url": board_url}
            kept = dedupe.dedupe([board, listed])
            self.assertEqual([(k["source"], k["title"]) for k in kept], [("simplify", "Software Engineer Intern")], listed_url)
            self.assertEqual(sorted(kept[0]["sources"]), ["boards", "simplify"])

    def test_board_posting_ids(self):
        self.assertEqual(dedupe.posting_id("https://www.weareroku.com/jobs/7645901?gh_jid=7645901"), "greenhouse:7645901")
        self.assertEqual(dedupe.posting_id("https://jobs.ashbyhq.com/G2/C61DBAFF-87e5-4481-82a7-0636e8aea415/application"),
                         "ashby:c61dbaff-87e5-4481-82a7-0636e8aea415")
        self.assertEqual(dedupe.posting_id("https://example.com/careers/123"), "")


if __name__ == "__main__":
    unittest.main()
