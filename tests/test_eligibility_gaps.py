"""Holes found by real picks that turned out ineligible (Oct 20, 2026). No network."""

import unittest

from scout import eligibility, watch


class GraduateOnlyPages(unittest.TestCase):
    def verdict(self, text):
        return eligibility.verdict_from_text(text, 2030, this_year=2026)

    def test_sony_phd_line(self):
        text = "QUALIFICATIONS FOR POSITION ● Completed or currently pursuing a PhD in Computer Science, Machine Learning, or related scientific discipline. ● Strong understanding of ML."
        self.assertEqual(self.verdict(text), ("ineligible", "page asks for PhD students"))

    def test_masters_students_only(self):
        self.assertEqual(self.verdict("Open to Master's students in Computer Science.")[0], "ineligible")

    def test_bachelors_or_phd_is_open(self):
        self.assertNotEqual(self.verdict("Currently pursuing a Bachelor's, Master's, or PhD in Computer Science.")[0], "ineligible")
        self.assertNotEqual(self.verdict("Pursuing a BS/MS or PhD in a related field.")[0], "ineligible")

    def test_graduate_degree_words_alone_do_not_count(self):
        self.assertNotEqual(self.verdict("Our team includes people with graduate degrees and self-taught engineers.")[0], "ineligible")

    def test_palantir_2028_rule_still_wins(self):
        text = "Must be planning on graduating in 2028. This should be your final internship before graduating."
        self.assertEqual(self.verdict(text)[0], "ineligible")


class SharedDegrees(unittest.TestCase):
    def test_community_row_borrows_simplify_degrees(self):
        simplify = {"company": "Sony", "title": "Research Engineer Intern", "url": "https://sony.example/job/1?src=x", "degrees": ["PhD"]}
        community = {"company": "Sony", "title": "Research Engineer Intern", "url": "https://sony.example/job/1", "degrees": []}
        watch.share_degrees([simplify, community])
        self.assertEqual(community["degrees"], ["PhD"])

    def test_by_company_and_title_when_links_differ(self):
        a = {"company": "Acme", "title": "SWE Intern", "url": "https://a.example/1", "degrees": ["Master's"]}
        b = {"company": "acme", "title": "swe intern", "url": "https://b.example/2", "degrees": []}
        watch.share_degrees([a, b])
        self.assertEqual(b["degrees"], ["Master's"])

    def test_rows_with_their_own_degrees_keep_them(self):
        a = {"company": "Acme", "title": "SWE Intern", "url": "u", "degrees": ["PhD"]}
        b = {"company": "Acme", "title": "SWE Intern", "url": "u", "degrees": ["Bachelor's"]}
        watch.share_degrees([a, b])
        self.assertEqual(b["degrees"], ["Bachelor's"])


if __name__ == "__main__":
    unittest.main()
