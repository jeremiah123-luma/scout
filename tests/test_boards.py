"""Company job boards, with every board answer faked. No network."""

import unittest
from datetime import datetime, timezone

from scout import boards, dedupe

NOW = datetime(2026, 10, 16, tzinfo=timezone.utc)


class Boards(unittest.TestCase):
    def test_greenhouse_keeps_interns_and_uses_the_lists_url(self):
        answer = {"jobs": [
            {"id": 6180005004, "title": "Product Design Intern (2027)", "absolute_url": "https://boards.greenhouse.io/figma/jobs/6180005004?gh_jid=6180005004",
             "location": {"name": "San Francisco, CA • New York, NY"}, "first_published": "2026-10-01T12:00:00-04:00"},
            {"id": 1, "title": "Staff Product Designer", "absolute_url": "https://boards.greenhouse.io/figma/jobs/1", "location": {"name": "SF"}},
        ]}
        rows = boards.greenhouse("figma", "Figma", NOW, fetch=lambda url: answer)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["url"], "https://boards.greenhouse.io/figma/jobs/6180005004")
        self.assertEqual(row["locations"], ["San Francisco, CA", "New York, NY"])
        self.assertEqual(row["terms"], ["2027"])
        self.assertEqual(row["source"], "boards")

    def test_company_hosted_greenhouse_keeps_its_own_link(self):
        answer = {"jobs": [{"id": 8214788, "title": "Solutions Engineer Intern 2027 (USA)",
                            "absolute_url": "https://www.pinterestcareers.com/jobs/?gh_jid=8214788", "location": {"name": "Remote, US"}}]}
        self.assertEqual(boards.greenhouse("pinterest", "Pinterest", NOW, fetch=lambda url: answer)[0]["url"],
                         "https://www.pinterestcareers.com/jobs/?gh_jid=8214788")

    def test_anthropic_fellows_program_is_kept_and_phd_fellowships_are_dropped(self):
        # Anthropic has no internships; its Fellows Program (open "regardless of previous experience") is the door.
        # The PhD-only fellowships share the word "Fellow" but are not "fellows program" titles.
        from scout import matching
        answer = {"jobs": [
            {"id": 5183044008, "title": "Anthropic Fellows Program, AI Safety & Security",
             "absolute_url": "https://job-boards.greenhouse.io/anthropic/jobs/5183044008",
             "location": {"name": "London, UK; Remote-Friendly, United States; San Francisco, CA"}},
            {"id": 5447080008, "title": "Conceptual Reasoning Fellow",
             "absolute_url": "https://job-boards.greenhouse.io/anthropic/jobs/5447080008",
             "location": {"name": "Remote-Friendly, United States; San Francisco, CA"}},
            {"id": 2, "title": "Research Engineer, Interpretability",
             "absolute_url": "https://job-boards.greenhouse.io/anthropic/jobs/2", "location": {"name": "SF"}},
        ]}
        rows = boards.greenhouse("anthropic", "Anthropic", NOW, fetch=lambda url: answer)
        self.assertEqual([r["title"] for r in rows], ["Anthropic Fellows Program, AI Safety & Security", "Conceptual Reasoning Fellow"])
        targets = matching.load_targets()
        kept = [r["title"] for r in rows if matching.passes_filters(matching.describe(r, targets))[0]]
        self.assertEqual(kept, ["Anthropic Fellows Program, AI Safety & Security"])

    def test_fellowships_are_programs_and_graduate_fellowships_drop(self):
        # "Meritocracy Fellowship" names no role, so before fellowships counted as programs it was dropped.
        from scout import matching
        lev = [{"id": f"p{i}", "text": title, "hostedUrl": f"https://jobs.lever.co/palantir/p{i}",
                "categories": {"allLocations": ["New York, NY"]}, "createdAt": 1790000000000}
               for i, title in enumerate(["Meritocracy Fellowship", "Neurodivergent Fellowship",
                                          "PhD Fellowship in Machine Learning", "Postdoctoral Fellowship",
                                          "Graduate Research Fellowship", "Account Executive"])]
        rows = boards.lever("palantir", "Palantir", NOW, fetch=lambda url: lev)
        targets = matching.load_targets()
        kept = [r["title"] for r in rows if matching.passes_filters(matching.describe(r, targets))[0]]
        self.assertEqual(kept, ["Meritocracy Fellowship", "Neurodivergent Fellowship"])
        self.assertTrue(all(r["early_career"] == "strong" for r in rows if r["title"] in kept))
        # The board only lists open jobs, so a posting first published long ago is still kept.
        self.assertTrue(matching.passes_filters(rows[0], max_age_days=240, now=1790000000 + 400 * 86400)[0])

    def test_terms_when_the_title_has_no_year(self):
        self.assertEqual(boards.terms_for("Data Analyst, Intern", NOW), ["Summer 2027 (year not stated)"])
        self.assertEqual(boards.terms_for("Software Engineer Intern (Winter 2027)", NOW), ["Winter 2027"])

    def test_ashby_and_lever(self):
        ash = {"jobs": [{"id": "abc", "title": "Software Engineer Intern (Summer 2027)", "location": "San Francisco, California",
                         "isListed": True, "publishedAt": "2026-09-01T00:00:00Z"},
                        {"id": "def", "title": "Head of Early Career Recruiting", "location": "SF"}]}
        self.assertEqual([r["url"] for r in boards.ashby("notion", "Notion", NOW, fetch=lambda url: ash)],
                         ["https://jobs.ashbyhq.com/notion/abc"])
        lev = [{"id": "x1", "text": "Design Intern", "hostedUrl": "https://jobs.lever.co/spotify/x1",
                "categories": {"allLocations": ["New York, NY"]}, "createdAt": 1790000000000}]
        row = boards.lever("spotify", "Spotify", NOW, fetch=lambda url: lev)[0]
        self.assertEqual((row["locations"], row["date_posted"]), (["New York, NY"], 1790000000))

    def test_smartrecruiters_keeps_interns_and_pages_with_offset(self):
        def posting(i, title, remote=False):
            return {"id": str(744000110000000 + i), "name": title, "releasedDate": "2026-10-01T15:05:36.671Z",
                    "location": {"city": "Plymouth", "region": "MI", "country": "us", "remote": remote}}
        pages = {0: [posting(i, "Warehouse Clerk") for i in range(99)] + [posting(99, "Software Engineering Intern ")],
                 100: [posting(100, "IT Co-op, Spring 2027", remote=True), posting(101, "Plant Manager")]}
        asked = []

        def fetch(url):
            asked.append(url)
            offset = int(url.rsplit("offset=", 1)[1])
            return {"offset": offset, "limit": 100, "totalFound": 102, "content": pages[offset]}

        rows = boards.smartrecruiters("BoschGroup", "Bosch", NOW, fetch=fetch)
        self.assertEqual(len(asked), 2)  # stopped after the short second page
        self.assertTrue(all("country=us" in url and "limit=100" in url for url in asked))
        self.assertEqual([r["title"] for r in rows], ["Software Engineering Intern", "IT Co-op, Spring 2027"])
        self.assertEqual(rows[0]["url"], "https://jobs.smartrecruiters.com/BoschGroup/744000110000099")
        self.assertEqual(rows[0]["locations"], ["Plymouth, MI"])
        self.assertEqual(rows[1]["locations"], ["Plymouth, MI", "Remote"])
        self.assertEqual(rows[1]["terms"], ["Spring 2027"])
        self.assertEqual((rows[0]["source"], rows[0]["date_posted"]), ("boards", 1790867136))
        # The lists link the same posting this way, so dedupe merges the two copies.
        self.assertEqual(dedupe.normalize_url("https://jobs.smartrecruiters.com/BoschGroup/744000110000099/"),
                         dedupe.normalize_url(rows[0]["url"]))

    def test_smartrecruiters_stops_at_the_page_limit(self):
        calls = []
        full = {"totalFound": 100_000, "content": [{"id": "1", "name": "Driver", "location": {}}] * 100}
        boards.smartrecruiters("Big", "Big", NOW, fetch=lambda url: calls.append(url) or full)
        self.assertEqual(len(calls), boards.SMARTRECRUITERS_MAX_PAGES)

    def test_one_broken_board_is_reported_not_fatal(self):
        original = boards.READERS["greenhouse"]
        boards.READERS["greenhouse"] = lambda board, company, now=None: (_ for _ in ()).throw(OSError("404"))
        try:
            rows, errors = boards.fetch_boards({"greenhouse": {"gone": "Gone"}, "ashby": {}})
        finally:
            boards.READERS["greenhouse"] = original
        self.assertEqual(rows, [])
        self.assertIn("greenhouse gone", errors[0])

    def test_the_lists_row_wins_a_merge(self):
        listed = {"source": "simplify", "company": "Figma", "title": "Software Engineer Intern", "date_updated": 1,
                  "url": "https://boards.greenhouse.io/figma/jobs/6143238004"}
        board = {"source": "boards", "company": "Figma", "title": "Software Engineer Intern (Summer 2027)", "date_updated": 99,
                 "url": "https://boards.greenhouse.io/figma/jobs/6143238004"}
        kept = dedupe.dedupe([board, listed])
        self.assertEqual([k["title"] for k in kept], ["Software Engineer Intern"])
        self.assertEqual(sorted(kept[0]["sources"]), ["boards", "simplify"])

    def test_ashby_apply_links_match_the_posting(self):
        self.assertEqual(dedupe.normalize_url("https://jobs.ashbyhq.com/notion/abc/application?embed=true"),
                         dedupe.normalize_url("https://jobs.ashbyhq.com/notion/abc"))


if __name__ == "__main__":
    unittest.main()
