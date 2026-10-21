"""Milestone U0: a page's facts are read once and judged for different people. No network."""

import unittest
from datetime import date

from scout import eligibility as e

FRESHMAN = {"graduation_year": 2030, "year_in_school": 1}
SOPHOMORE = {"graduation_year": 2029, "year_in_school": 2}
JUNIOR = {"graduation_year": 2028, "year_in_school": 3}
MASTERS = {"graduation_year": 2028, "year_in_school": 4, "degree": "master's"}
PHD = {"graduation_year": 2029, "year_in_school": 4, "degree": "PhD"}


def verdict(text, profile):
    return e.verdict_from_facts(e.facts_from_text(text, this_year=2026), {**profile, "cycle_year": 2027})[0]


class SamePageDifferentPeople(unittest.TestCase):
    def test_graduation_window(self):
        text = "Candidates must be graduating in 2028."
        self.assertEqual(verdict(text, FRESHMAN), "ineligible")
        self.assertEqual(verdict(text, JUNIOR), "ok")

    def test_completed_sophomore_year(self):
        text = "Requirements: Completed sophomore year of college by the start of the internship."
        self.assertEqual(verdict(text, FRESHMAN), "ineligible")
        self.assertEqual(verdict(text, SOPHOMORE), "ineligible")
        self.assertNotEqual(verdict(text, JUNIOR), "ineligible")

    def test_at_least_a_sophomore(self):
        text = "Requirements: At least a sophomore at time of application."
        self.assertEqual(verdict(text, FRESHMAN), "ineligible")
        self.assertNotEqual(verdict(text, SOPHOMORE), "ineligible")

    def test_phd_only(self):
        text = "Qualifications: Currently pursuing a PhD in Computer Science."
        self.assertEqual(verdict(text, FRESHMAN), "ineligible")
        self.assertEqual(verdict(text, MASTERS), "ineligible")
        self.assertNotEqual(verdict(text, PHD), "ineligible")

    def test_masters_only(self):
        text = "Open to Master's students in Computer Science."
        self.assertEqual(verdict(text, JUNIOR), "ineligible")
        self.assertNotEqual(verdict(text, MASTERS), "ineligible")

    def test_freshman_words_only_help_first_and_second_years(self):
        text = "This program is open to freshmen and sophomores."
        self.assertEqual(verdict(text, FRESHMAN), "ok")
        self.assertEqual(verdict(text, JUNIOR), "unknown")

    def test_juniors_and_seniors(self):
        text = "We are looking for juniors and seniors studying CS."
        self.assertEqual(verdict(text, FRESHMAN), "ineligible")
        self.assertNotEqual(verdict(text, JUNIOR), "ineligible")

    def test_previous_internship(self):
        text = "Requirements: Previous internship experience is required."
        self.assertEqual(verdict(text, FRESHMAN), "ineligible")
        self.assertNotEqual(verdict(text, {**JUNIOR, "past_internship": True}), "ineligible")


class YearInSchool(unittest.TestCase):
    def test_from_graduation_year(self):
        october = date(2026, 10, 20)
        self.assertEqual(e.year_in_school(2030, october), 1)
        self.assertEqual(e.year_in_school(2027, october), 4)
        self.assertEqual(e.year_in_school(2030, date(2027, 3, 1)), 1)
        self.assertEqual(e.year_in_school(2030, date(2027, 9, 1)), 2)


class Cache(unittest.TestCase):
    def test_cache_keeps_facts_and_judges_each_profile(self):
        url = "https://boards.greenhouse.io/acme/jobs/1"
        cache = {url: {"v": e.CACHE_VERSION, "checked_at": 2**40, "facts": e.facts_from_text("Must be graduating in 2028.", 2026)}}
        a = e.check({"url": url}, 2030, cache, allow_network=False)
        b = e.check({"url": url}, {"graduation_year": 2028}, cache, allow_network=False)
        self.assertEqual((a["eligibility"], b["eligibility"]), ("ineligible", "ok"))
        self.assertNotIn("verdict", cache[url])


if __name__ == "__main__":
    unittest.main()
