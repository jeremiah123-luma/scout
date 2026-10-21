"""The posting readers, with every HTTP answer faked. No network."""

import json
import unittest

from scout import alerts, posting


class FakeWeb:
    """Stands in for posting._fetch: url -> (status, body)."""

    def __init__(self, answers):
        self.answers, self.asked = answers, []

    def __call__(self, url, timeout=20, accept="text/html", error_body=False):
        self.asked.append(url)
        status, body = self.answers.get(url, (404, None))
        return status, (json.dumps(body).encode() if isinstance(body, dict) else body)


class Readers(unittest.TestCase):
    def setUp(self):
        self.original = posting._fetch
        posting._ashby_boards.clear()

    def tearDown(self):
        posting._fetch = self.original

    def fake(self, answers):
        posting._fetch = FakeWeb(answers)
        return posting._fetch

    def test_greenhouse_behind_a_company_site(self):
        api = "https://boards-api.greenhouse.io/v1/boards/pinterest/jobs/7838577"
        self.fake({api: (200, {"title": "Software Engineer Intern 2027", "location": {"name": "Remote, US"},
                               "content": "&lt;p&gt;On track to graduate by&lt;/p&gt;&lt;p&gt;June 2029&lt;/p&gt;"})})
        post = posting.read_posting("https://www.pinterestcareers.com/jobs/?gh_jid=7838577")
        self.assertEqual(post["kind"], "greenhouse")
        self.assertIn("June 2029", post["text"])
        self.assertEqual(post["location"], "Remote, US")

    def test_greenhouse_404_is_closed(self):
        self.fake({})
        self.assertTrue(posting.read_posting("https://boards.greenhouse.io/figma/jobs/1")["closed"])

    def test_ashby_reads_the_board_once(self):
        board = "https://api.ashbyhq.com/posting-api/job-board/notion"
        jobs = {"jobs": [{"id": "3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c", "title": "Software Engineer Intern",
                          "isListed": True, "descriptionPlain": "Must graduate before Summer 2028."}]}
        web = self.fake({board: (200, jobs)})
        post = posting.read_posting("https://jobs.ashbyhq.com/notion/3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c/application?embed=true")
        self.assertIn("Summer 2028", post["text"])
        gone = posting.read_posting("https://jobs.ashbyhq.com/notion/00000000-0000-0000-0000-000000000000")
        self.assertTrue(gone["closed"])
        self.assertEqual(web.asked.count(board), 1)

    def test_eightfold_by_path_and_by_pid(self):
        netflix = "https://explore.jobs.netflix.net/api/apply/v2/jobs/790318904468?domain=netflix.com"
        microsoft = "https://apply.careers.microsoft.com/api/apply/v2/jobs/1970393556922929?domain=microsoft.com"
        self.fake({netflix: (200, {"posting_name": "Software Engineer Intern - Summer 2027",
                                   "job_description": "<p>Graduation date between December 2027 and Spring 2028.</p>"}),
                   microsoft: (200, {"name": "Software Engineer Intern", "job_description": "<p>One term remaining.</p>",
                                     "canonicalPositionUrl": "https://apply.careers.microsoft.com/careers/job/1970393556922929"})})
        self.assertIn("December 2027", posting.read_posting("https://explore.jobs.netflix.net/careers/job/790318904468")["text"])
        post = posting.read_posting("https://apply.careers.microsoft.com/careers?query=intern&pid=1970393556922929")
        self.assertEqual(post["apply_url"], "https://apply.careers.microsoft.com/careers/job/1970393556922929")

    def test_removed_google_posting_is_closed(self):
        url = "https://www.google.com/about/careers/applications/jobs/results/85564713261245126-software-engineering-intern"
        self.fake({url: (200, ("<title>Jobs search \u2014 Google Careers</title>" + "<p>filler</p>" * 200).encode())})
        self.assertTrue(posting.read_posting(url)["closed"])

    def test_closed_never_pushes(self):
        self.assertFalse(alerts.is_instant({"eligibility": "closed", "early_career": "strong", "tier": 1, "score": 99}, {}))


if __name__ == "__main__":
    unittest.main()
