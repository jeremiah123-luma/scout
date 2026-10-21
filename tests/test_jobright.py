"""Jobright's daily lists (intern-list.com's postings), with every answer faked. No network."""

import json
import unittest
from datetime import datetime, timezone
from unittest import mock

from scout import dedupe, jobright, posting

NOW = datetime(2026, 10, 21, 15, tzinfo=timezone.utc)

README = """# Daily Intern Jobs in Software Engineering by Jobright.ai

| Company | Job Title | Location | Work Model | Date Posted |
| ----- | --------- |  --------- | ---- | ------- |
| **[Alstom](https://www.alstom.com/)** | **[Internship - ATC Software Job Details / Alstom](https://jobright.ai/jobs/info/6ac83eb351a1b3e4219f0f08?utm_campaign=1079&utm_source=git)** | Pittsburgh, PA, United States | On Site | Oct 21 |
| **[Qorvo, Inc.](https://www.qorvo.com/)** | **[Test Engineering Intern](https://jobright.ai/jobs/info/6ad8958267bec1d0d9c7e0db?utm_campaign=1079&utm_source=git)** | Greensboro, NC, United States | On Site | Oct 20 |
| ↳ | **[Software Engineer Intern - 2027 Summer](https://jobright.ai/jobs/info/6a714fcf02d93145bf88ef3c?utm_campaign=1079&utm_source=git)** | Remote, United States | Remote | Oct 19 |
| **[Acme](https://acme.example)** | **[Senior Software Engineer](https://jobright.ai/jobs/info/6a714fcf02d93145bf88ef3d)** | Austin, TX, United States | Hybrid | Oct 19 |
| **[Oldco](https://old.example)** | **[Software Intern](https://jobright.ai/jobs/info/6a714fcf02d93145bf88ef3e)** | Austin, TX, United States | Hybrid | Dec 30 |
"""


class Parse(unittest.TestCase):
    def setUp(self):
        self.rows = jobright.parse(README, "Software-Engineer", NOW)

    def test_keeps_internships_only(self):
        self.assertEqual([r["company"] for r in self.rows], ["Alstom", "Qorvo", "Qorvo", "Oldco"])

    def test_cleans_titles_companies_links_and_places(self):
        alstom, qorvo, remote, _ = self.rows
        self.assertEqual(alstom["title"], "Internship - ATC Software")
        self.assertEqual(alstom["url"], "https://jobright.ai/jobs/info/6ac83eb351a1b3e4219f0f08")
        self.assertEqual(alstom["locations"], ["Pittsburgh, PA"])
        self.assertEqual(qorvo["company"], "Qorvo")  # "Qorvo, Inc." so it dedupes with the lists' "Qorvo"
        self.assertEqual(remote["company"], "Qorvo")  # the ↳ row
        self.assertEqual(remote["locations"], ["Remote"])
        self.assertEqual(remote["terms"], ["Summer 2027"])
        self.assertEqual(alstom["terms"], ["Summer 2027 (year not stated)"])
        self.assertEqual(alstom["source"], "jobright")

    def test_dates_have_no_year(self):
        self.assertEqual(datetime.fromtimestamp(self.rows[0]["date_posted"], timezone.utc).date().isoformat(), "2026-10-21")
        self.assertEqual(datetime.fromtimestamp(self.rows[3]["date_posted"], timezone.utc).year, 2025)  # Dec 30 is last year

    def test_one_failing_list_keeps_the_others(self):
        def fetch(url):
            if "Design" in url:
                raise OSError("timed out")
            return README
        rows, errors = jobright.fetch_jobright(NOW, fetch=fetch)
        self.assertEqual(len(rows), 4)  # the same postings in four fields' lists are kept once
        self.assertEqual(len(errors), 1)
        self.assertIn("Design", errors[0])


class Dedupe(unittest.TestCase):
    def test_a_list_row_beats_the_jobright_copy(self):
        simplify = {"source": "simplify", "company": "Qorvo", "title": "Test Engineering Intern",
                    "url": "https://qorvo.wd1.myworkdayjobs.com/x/job/y", "date_posted": 1, "date_updated": 1}
        jr = jobright.parse(README, "Software-Engineer", NOW)[1]
        kept = dedupe.dedupe([jr, simplify])
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["source"], "simplify")
        self.assertEqual(kept[0]["sources"], ["simplify", "jobright"])


def page(job):
    data = {"props": {"pageProps": {"dataSource": {"jobResult": job}}}}
    return 200, f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script></html>'.encode()


class ReadPage(unittest.TestCase):
    URL = "https://jobright.ai/jobs/info/6aa018b6a2266b538d22e2a8"

    def test_reads_the_qualifications(self):
        job = {"jobTitle": "Software Engineering Intern", "jobLocation": "Boston, MA", "jobSummary": "Build systems.",
               "internHireDate": "Start by 2027 Summer", "isDeleted": False,
               "qualifications": {"mustHave": ["Targeting a **2028** full-time start date"], "preferredHave": ["Go"]}}
        with mock.patch.object(posting, "_fetch", return_value=page(job)):
            post = posting.read_posting(self.URL)
        self.assertEqual(post["kind"], "jobright")
        self.assertIn("Targeting a 2028 full-time start date", post["text"])
        self.assertIn("Start by 2027 Summer", post["text"])
        self.assertTrue(posting.is_readable_board(self.URL))

    def test_a_deleted_or_missing_posting_is_closed(self):
        with mock.patch.object(posting, "_fetch", return_value=page({"jobTitle": "X", "isDeleted": True})):
            self.assertTrue(posting.read_posting(self.URL)["closed"])
        with mock.patch.object(posting, "_fetch", return_value=(404, None)):
            self.assertTrue(posting.read_posting(self.URL)["closed"])


class LooseMatch(unittest.TestCase):
    def test_a_reworded_jobright_title_still_dedupes(self):
        lists = {"source": "simplify", "company": "TikTok", "title": "Software Engineer Intern - Media Engine",
                 "url": "https://lifeattiktok.com/search/1", "date_posted": 1, "date_updated": 1}
        jr = {"source": "jobright", "company": "TikTok", "title": "Software Engineer Intern (Media Engine) - 2027 Summer",
              "url": "https://jobright.ai/jobs/info/6a714fcf02d93145bf88ef3c", "date_posted": 2, "date_updated": 2}
        self.assertEqual([k["source"] for k in dedupe.dedupe([jr, lists])], ["simplify"])

    def test_different_teams_stay_apart(self):
        a = {"source": "simplify", "company": "TikTok", "title": "Software Engineer Intern - Global CRM", "url": "https://a.example/1"}
        b = {"source": "jobright", "company": "TikTok", "title": "Software Engineer Intern (Business Integrity) - 2027 Summer",
             "url": "https://jobright.ai/jobs/info/6a714fcf02d93145bf88ef30"}
        self.assertEqual(len(dedupe.dedupe([a, b])), 2)

    def test_two_list_rows_never_merge_loosely(self):
        a = {"source": "simplify", "company": "X", "title": "Data Science Intern, Summer 2027", "url": "https://a.example/1"}
        b = {"source": "vanshb03", "company": "X", "title": "Data Science Intern - Fall 2027", "url": "https://a.example/2"}
        self.assertEqual(len(dedupe.dedupe([a, b])), 2)
