"""The graduation-year reader, on HTML snippets. No network."""

import unittest

from scout import eligibility

GRAD = 2030


class Verdicts(unittest.TestCase):
    def test_range_that_excludes_him(self):
        text = "<p>Candidates must be graduating between December 2027 and June 2028.</p>"
        verdict, note = eligibility.verdict_from_text(eligibility._TAGS.sub(" ", text), GRAD, this_year=2026)
        self.assertEqual(verdict, "ineligible")
        self.assertIn("2027", note)

    def test_class_of_that_includes_him(self):
        text = "Open to students in the Class of 2029 or 2030."
        self.assertEqual(eligibility.verdict_from_text(text, GRAD)[0], "ok")

    def test_single_year_that_excludes_him(self):
        text = "Expected graduation date: May 2028."
        self.assertEqual(eligibility.verdict_from_text(text, GRAD, this_year=2026)[0], "ineligible")

    def test_underclass_words_win(self):
        text = "This program is for freshmen and sophomores. Graduating 2029 or later preferred."
        self.assertEqual(eligibility.verdict_from_text(text, GRAD)[0], "ok")

    def test_not_enrolled_in_college_rules_him_out(self):
        # Palantir's Meritocracy Fellowship is for high school graduates who skip college.
        text = "Applicants must earn a high school diploma and not be enrolled in an accredited U.S. university."
        verdict, note = eligibility.verdict_from_text(text, GRAD)
        self.assertEqual(verdict, "ineligible")
        self.assertIn("not being enrolled", note)
        lever = "What We Require: Candidates cannot be enrolled in an accredited U.S. university."
        self.assertEqual(eligibility.verdict_from_text(lever, GRAD)[0], "ineligible")

    def test_silence_is_unknown(self):
        text = "We are looking for a motivated intern who loves to code."
        self.assertEqual(eligibility.verdict_from_text(text, GRAD)[0], "unknown")

    def test_years_mentioned(self):
        self.assertEqual(eligibility.years_mentioned("graduating in 2027 or 2028 from an accredited program"), [2027, 2028])
        self.assertEqual(eligibility.years_mentioned("2028 graduates welcome"), [2028])
        self.assertEqual(eligibility.years_mentioned("Expected graduation dates of December 2028, May 2029, December 2029, or May 2030."),
                         [2028, 2029, 2030])
        self.assertEqual(eligibility.years_mentioned("Founded in 2021. We hire great people."), [])

    def test_listed_graduation_dates_include_ours(self):
        text = "Expected graduation dates of December 2028, May 2029, December 2029, or May 2030. 3.0 cumulative GPA or higher."
        verdict, note = eligibility.verdict_from_text(text, GRAD)
        self.assertEqual(verdict, "ok")
        self.assertIn("2030", note)

    def test_readable_boards(self):
        self.assertTrue(eligibility.is_readable_board("https://boards.greenhouse.io/acme/jobs/1"))
        self.assertTrue(eligibility.is_readable_board("https://jobs.lever.co/acme/abc"))
        self.assertTrue(eligibility.is_readable_board("https://jobs.ashbyhq.com/acme/abc"))
        self.assertTrue(eligibility.is_readable_board("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/NYC/SWE-Intern_R1"))
        self.assertTrue(eligibility.is_readable_board("https://www.google.com/about/careers/applications/jobs/results/123"))
        self.assertFalse(eligibility.is_readable_board("https://evil-greenhouse.io/x"))
        self.assertTrue(eligibility.is_readable_board("https://www.amazon.jobs/en/jobs/1"))
        self.assertTrue(eligibility.is_readable_board("https://explore.jobs.netflix.net/careers/job/790318904468"))
        self.assertTrue(eligibility.is_readable_board("https://careers.withwaymo.com/jobs?gh_jid=8198218"))
        self.assertFalse(eligibility.is_readable_board("https://careers.example.com/jobs?gh_jid=1"))

    def test_upperclass_phrases_are_ineligible(self):
        text = "This internship is intended for students in their penultimate academic year, pursuing a Bachelor's degree."
        verdict, note = eligibility.verdict_from_text(text, GRAD)
        self.assertEqual(verdict, "ineligible")
        self.assertIn("penultimate", note)
        self.assertEqual(eligibility.verdict_from_text("Open to rising juniors and seniors.", GRAD)[0], "ineligible")

    def test_explicit_years_beat_upperclass_words(self):
        text = "Expected graduation dates of December 2028, May 2029, December 2029, or May 2030. Final year students welcome."
        self.assertEqual(eligibility.verdict_from_text(text, GRAD)[0], "ok")

    def test_network_off_gives_unknown_without_fetching(self):
        item = {"url": "https://boards.greenhouse.io/acme/jobs/1"}
        eligibility.check(item, GRAD, cache={}, allow_network=False)
        self.assertEqual(item["eligibility"], "unknown")


class RealPostings(unittest.TestCase):
    """Lines from real postings Scout alerted on in October 2026 that he could not apply to (and two he could)."""

    def verdict(self, text):
        return eligibility.verdict_from_text(text, GRAD, this_year=2026)[0]

    def test_netflix_window(self):
        self.assertEqual(self.verdict("Expected graduation date between December 2027 and Spring/Summer 2028."), "ineligible")

    def test_notion_ceiling(self):
        self.assertEqual(self.verdict("Must graduate before Summer 2028."), "ineligible")

    def test_pinterest_year_on_the_next_line(self):
        self.assertEqual(self.verdict("On track to graduate by\nJune 2029"), "ineligible")

    def test_point72_degree_expected(self):
        self.assertEqual(self.verdict("Bachelor's degree expected between Fall 2027 and Spring 2028."), "ineligible")

    def test_nvidia_ignite_first_years(self):
        self.assertEqual(self.verdict("Open to first-year (class of 2030) or second year students."), "ok")

    def test_lowes_list_of_dates(self):
        self.assertEqual(self.verdict("Expected graduation of December 2028, May 2029, December 2029, or May 2030."), "ok")


class Windows(unittest.TestCase):
    def verdict(self, text):
        return eligibility.verdict_from_text(text, GRAD, this_year=2026)

    def test_or_later_is_a_floor(self):
        verdict, note = self.verdict("Students graduating in 2028 or later.")
        self.assertEqual(verdict, "ok")
        self.assertIn("or later", note)

    def test_stated_years_beat_a_sophomore_mention(self):
        self.assertEqual(self.verdict("Must be a sophomore or junior graduating in Spring 2029.")[0], "ineligible")

    def test_first_year_word_does_not_rescue_an_old_window(self):
        text = "We hire first-year analysts. Candidates graduating between December 2026 and June 2027."
        self.assertEqual(self.verdict(text)[0], "ineligible")

    def test_past_years_are_not_requirements(self):
        text = "Founded in 2021, our graduate program is open to rising juniors."
        verdict, note = self.verdict(text)
        self.assertEqual(verdict, "ineligible")
        self.assertIn("rising junior", note)

    def test_a_closed_posting_is_labeled_closed(self):
        original = eligibility.fetch_text
        eligibility.fetch_text = lambda url: eligibility.CLOSED
        try:
            item = {"url": "https://boards.greenhouse.io/acme/jobs/1"}
            eligibility.check(item, GRAD, cache={}, allow_network=True)
        finally:
            eligibility.fetch_text = original
        self.assertEqual(item["eligibility"], "closed")

    def test_floors_are_not_deadlines(self):
        for text in ("Graduation date expected in or after December 2027.",
                     "Must graduate on or after July 2028.",
                     "Candidates who do not anticipate graduating before May 2028.",
                     "Students graduating by Summer 2027 are not eligible."):
            self.assertEqual(self.verdict(text)[0], "ok", text)

    def test_graduate_degree_is_not_a_date(self):
        text = "Pursuing an undergraduate or graduate degree; will be enrolled full time in Fall 2027."
        self.assertEqual(self.verdict(text)[0], "unknown")

    def test_unreadable_pages_are_not_cached(self):
        original = eligibility.fetch_text
        eligibility.fetch_text = lambda url: None
        try:
            cache = {}
            item = {"url": "https://boards.greenhouse.io/acme/jobs/1"}
            eligibility.check(item, GRAD, cache, allow_network=True)
        finally:
            eligibility.fetch_text = original
        self.assertEqual((item["eligibility"], cache), ("unknown", {}))

    def test_old_cache_entries_are_reread(self):
        url = "https://boards.greenhouse.io/acme/jobs/1"
        cache = {url: {"verdict": "ok", "note": "old rules", "checked_at": 4_000_000_000}}
        item = {"url": url}
        eligibility.check(item, GRAD, cache, allow_network=False)
        self.assertEqual(item["eligibility"], "unknown")


if __name__ == "__main__":
    unittest.main()
