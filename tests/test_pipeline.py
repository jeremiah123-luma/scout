"""The whole watcher on fixtures, offline. Checks the properties that must always hold."""

import unittest
from pathlib import Path

from scout import listings, matching, scoring, watch

FIXTURES = Path(__file__).parent / "fixtures"


class Pipeline(unittest.TestCase):
    # The fixture rows were saved months apart; the 30-day cutoff has its own tests (test_matching.py), so
    # these pipeline tests turn it off to keep testing everything else.
    @classmethod
    def setUpClass(cls):
        raw = {"simplify": listings.load_json(FIXTURES / "simplify.json"),
               "vanshb03": listings.load_json(FIXTURES / "vanshb03.json")}
        cls.matches, cls.counts = watch.run(raw, {**matching.load_targets(), "max_age_days": None}, scoring.load_weights(),
                                            check_pages=5, allow_network=False, now=1_800_000_000)

    def test_something_survives(self):
        self.assertGreater(len(self.matches), 0)
        self.assertEqual(self.counts["kept"], len(self.matches))

    def test_every_row_that_could_push_gets_its_page_checked(self):
        for m in self.matches[5:]:
            if watch.could_push(m):
                self.assertNotEqual(m["eligibility_note"], "not checked (below top rows)", m["title"])

    def test_no_graduate_only_or_inactive_or_wrong_year(self):
        for m in self.matches:
            self.assertNotEqual(m["degree_class"], "graduate_only", m["title"])
            self.assertTrue(m["active"])
            self.assertTrue(any("2027" in t for t in m["terms"]), m["title"])

    def test_no_hardware_or_quant_without_a_program(self):
        for m in self.matches:
            if m["role"] == "none":
                self.assertEqual(m["early_career"], "strong", m["title"])

    def test_sorted_eligible_first_then_score_then_date(self):
        keys = [(m["eligibility"] != "ineligible", m["score"], m["date_posted"]) for m in self.matches]
        self.assertEqual(keys, sorted(keys, reverse=True))

    def test_ineligible_sinks_below_eligible(self):
        from scout import eligibility
        raw = {"simplify": listings.load_json(FIXTURES / "simplify.json")}
        original = eligibility.check
        def fake_check(item, grad, cache, allow_network=True):
            item["eligibility"], item["eligibility_note"] = ("ineligible", "test") if item is first[0] else ("unknown", "")
            return item
        first = []
        try:
            eligibility.check = lambda item, *a, **k: (first.append(item) if not first else None, fake_check(item, *a, **k))[1]
            matches, _ = watch.run(raw, {**matching.load_targets(), "max_age_days": None}, scoring.load_weights(), check_pages=5, allow_network=False, now=1_800_000_000)
        finally:
            eligibility.check = original
        self.assertEqual(matches[-1]["eligibility"], "ineligible")

    def test_every_match_explains_itself(self):
        for m in self.matches:
            self.assertEqual(m["score"], min(100, sum(m["breakdown"].values())))
            self.assertIn(m["eligibility"], ("ok", "ineligible", "unknown"))
            self.assertIn("key", m)

    def test_drop_counts_are_reported(self):
        self.assertIn("dropped: graduate students only", self.counts)
        self.assertIn("dropped: not a target role", self.counts)
        self.assertIn("dropped: inactive", self.counts)


if __name__ == "__main__":
    unittest.main()
