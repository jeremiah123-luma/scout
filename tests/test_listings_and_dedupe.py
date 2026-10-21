"""Normalizing both source shapes and deduping across them, on saved fixtures. No network."""

import unittest
from pathlib import Path

from scout import listings
from scout.dedupe import dedupe, make_key, normalize_url

FIXTURES = Path(__file__).parent / "fixtures"
REQUIRED_KEYS = {"id", "source", "company", "title", "url", "locations", "terms", "degrees",
                 "sponsorship", "category", "date_posted", "date_updated", "active", "company_url"}


class Normalize(unittest.TestCase):
    def setUp(self):
        self.simplify = listings.load_json(FIXTURES / "simplify.json")
        self.vansh = listings.load_json(FIXTURES / "vanshb03.json")

    def test_every_row_has_the_same_keys(self):
        for item in listings.normalize_all({"simplify": self.simplify, "vanshb03": self.vansh}):
            self.assertEqual(set(item.keys()), REQUIRED_KEYS, item)

    def test_vanshb03_season_gets_the_year(self):
        items = [listings.normalize_vanshb03(r) for r in self.vansh]
        summer = [i for i in items if i["terms"] == ["Summer 2027"]]
        self.assertTrue(summer, "expected at least one Summer row")
        null_season = [i for i, r in zip(items, self.vansh) if (r.get("season") or "").lower() == "null"]
        for i in null_season:
            self.assertEqual(i["terms"], [])

    def test_simplify_inactive_rows_are_marked(self):
        items = [listings.normalize_simplify(r) for r in self.simplify]
        self.assertTrue(any(not i["active"] for i in items), "fixture should include an inactive row")


class Dedupe(unittest.TestCase):
    def test_key_is_stable_and_safe(self):
        key = make_key("Deloitte", "Junior Cybersecurity Analyst (OT/IoT)")
        self.assertEqual(key, "deloitte_junior-cybersecurity-analyst-ot-iot")
        self.assertNotIn("/", key)

    def test_long_titles_do_not_collide_or_drift(self):
        long_a = "Software Engineer Intern " * 6 + "Alpha"
        long_b = "Software Engineer Intern " * 6 + "Beta"
        self.assertNotEqual(make_key("Acme", long_a), make_key("Acme", long_b))
        self.assertEqual(make_key("Acme", long_a), make_key("Acme", long_a))

    def test_url_normalization(self):
        a = normalize_url("https://Boards.Greenhouse.io/acme/jobs/123?utm_source=github&gh_src=abc#top")
        b = normalize_url("https://boards.greenhouse.io/acme/jobs/123/")
        self.assertEqual(a, b)

    def test_same_url_across_sources_counts_once(self):
        items = [
            {"source": "simplify", "company": "Acme", "title": "SWE Intern", "url": "https://x.com/j/1?utm_source=a", "date_updated": 10},
            {"source": "vanshb03", "company": "Acme Inc", "title": "Software Engineer Intern", "url": "https://x.com/j/1", "date_updated": 5},
        ]
        out = dedupe(items)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["source"], "simplify")  # the most recently updated one survives
        self.assertEqual(sorted(out[0]["sources"]), ["simplify", "vanshb03"])

    def test_same_company_and_title_counts_once(self):
        items = [
            {"source": "simplify", "company": "Acme", "title": "SWE Intern", "url": "https://x.com/a", "date_updated": 1},
            {"source": "simplify", "company": "Acme", "title": "SWE Intern", "url": "https://x.com/b", "date_updated": 2},
        ]
        self.assertEqual(len(dedupe(items)), 1)

    def test_fixture_cross_source_duplicate(self):
        raw = {"simplify": listings.load_json(FIXTURES / "simplify.json"),
               "vanshb03": listings.load_json(FIXTURES / "vanshb03.json")}
        items = listings.normalize_all(raw)
        merged = dedupe(items)
        self.assertLess(len(merged), len(items), "the fixtures contain one posting present in both lists")


if __name__ == "__main__":
    unittest.main()
