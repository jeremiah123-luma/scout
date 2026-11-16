"""SpeedyApply and Zapply readers, from saved README excerpts. No network: the redirect resolver is faked."""

import unittest
from pathlib import Path

from scout import dedupe, morelists

FIX = Path(__file__).parent / "fixtures"
NOW = 1_795_000_000


class Speedy(unittest.TestCase):
    def setUp(self):
        self.rows = morelists.parse_speedy((FIX / "speedyapply_readme.md").read_text(), NOW)

    def test_reads_both_table_shapes(self):
        # FAANG+ rows have a Salary column, Other rows do not; both must give a company link and an age.
        companies = {r["company"] for r in self.rows}
        self.assertIn("Meta", companies)
        self.assertIn("Atalanta", companies)
        atalanta = next(r for r in self.rows if r["company"] == "Atalanta")
        self.assertTrue(atalanta["url"].startswith("https://jobs.ashbyhq.com/atalanta/"))
        self.assertEqual(atalanta["date_posted"], NOW - 86400)
        self.assertEqual(atalanta["locations"], ["Washington, DC"])

    def test_every_row_is_an_internship_with_a_link(self):
        self.assertTrue(self.rows)
        self.assertTrue(all(r["url"].startswith("http") and r["source"] == "speedyapply" for r in self.rows))


class Zapply(unittest.TestCase):
    def setUp(self):
        self.rows = morelists.parse_zapply((FIX / "zapply_readme.md").read_text(), NOW)

    def test_fields_ages_and_sponsorship(self):
        rtx = self.rows[0]
        self.assertEqual(rtx["company"], "RTX")
        self.assertEqual(rtx["category"], "Software Engineering")
        self.assertEqual(rtx["sponsorship"], "Offers Sponsorship")
        self.assertEqual(rtx["date_posted"], NOW - 86400)
        self.assertNotIn("?", rtx["url"])

    def test_minutes_are_minutes_and_unknown_dates_are_undated(self):
        ages = {NOW - r["date_posted"] for r in self.rows if r["date_posted"]}
        self.assertIn(14 * 60, ages)                      # "14m" is 14 minutes, not 14 months
        self.assertTrue(any(r["date_posted"] == 0 for r in self.rows))   # "Date unknown"

    def test_links_are_swapped_and_unresolved_rows_wait(self):
        first, second = self.rows[0]["url"], self.rows[1]["url"]
        answers = {first: "https://acme.wd1.myworkdayjobs.com/en-US/acme/job/X_JR1"}
        cache = {}
        out = morelists.attach_links(self.rows[:2], cache, resolver=lambda u: answers.get(u))
        self.assertEqual([r["url"] for r in out], [answers[first]])
        self.assertEqual(out[0]["id"], "X_JR1")
        self.assertIsNone(cache[second])                  # no company link: remembered, never asked again
        calls = []
        morelists.attach_links(self.rows[:2], cache, resolver=lambda u: calls.append(u))
        self.assertEqual(calls, [])

    def test_budget_out_leaves_the_link_for_next_run(self):
        cache = {}
        out = morelists.attach_links(self.rows[:1], cache, resolver=lambda u: "https://x", budget=-1)
        self.assertEqual((out, cache), ([], {}))


class Dedupe(unittest.TestCase):
    def test_simplify_row_wins_over_a_reworded_copy(self):
        base = {"locations": [], "terms": ["Summer 2027"], "degrees": [], "active": True, "date_posted": NOW}
        simplify = {**base, "source": "simplify", "company": "TikTok", "title": "Software Engineer Intern - TikTok Search",
                    "url": "https://lifeattiktok.com/search/1", "degrees": ["Bachelor's"]}
        speedy = {**base, "source": "speedyapply", "company": "TikTok",
                  "title": "Software Engineer - Intern - TikTok Search - 2027 Start", "url": "https://lifeattiktok.com/search/2"}
        out = dedupe.dedupe([speedy, simplify])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["source"], "simplify")
        self.assertEqual(out[0]["sources"], ["simplify", "speedyapply"])


if __name__ == "__main__":
    unittest.main()
