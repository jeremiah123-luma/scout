"""Company logos from Simplify company pages, with a fake fetcher. No network."""

import json
import tempfile
import unittest
from pathlib import Path

from scout import logos, sync

PAGE = ('<meta property="og:image" content="https://simplify.jobs/api/og/company?logo=https%3A%2F%2Fstorage.googleapis.com">'
        '<img src="https://storage.googleapis.com/simplify-imgs/companies/3cd4b225-8559-433f-8b19-7f0bd97cae5a/logo.png">')
NVIDIA_LOGO = "https://storage.googleapis.com/simplify-imgs/companies/3cd4b225-8559-433f-8b19-7f0bd97cae5a/logo.png"


class Parse(unittest.TestCase):
    def test_reads_the_logo_and_slug(self):
        self.assertEqual(logos.logo_from_page(PAGE), NVIDIA_LOGO)
        self.assertEqual(logos.logo_from_page("<html>no logo</html>"), "")
        self.assertEqual(logos.slug_of("https://simplify.jobs/c/Expedia-Group"), "Expedia-Group")
        self.assertEqual(logos.slug_of("https://example.com/c/x"), "")

    def test_names_ignore_company_suffixes(self):
        self.assertEqual(logos.norm_name("NVIDIA Corporation"), "nvidia")
        self.assertEqual(logos.norm_name("Acme, Inc."), "acme")


class Attach(unittest.TestCase):
    def setUp(self):
        self.calls = []

    def fetch(self, slug):
        self.calls.append(slug)
        return PAGE if slug == "NVIDIA" else "<html></html>"

    def test_reads_each_company_once_and_caches(self):
        raw = {"simplify": [{"company_name": "NVIDIA", "company_url": "https://simplify.jobs/c/NVIDIA"}]}
        matches = [{"company": "NVIDIA", "company_url": "https://simplify.jobs/c/NVIDIA"},
                   {"company": "NVIDIA", "company_url": "https://simplify.jobs/c/NVIDIA"}]
        cache = {}
        read = logos.attach(matches, raw, cache, fetch=self.fetch, now=1000, delay=0)
        self.assertEqual(read, 1)
        self.assertTrue(all(m["logo"] == NVIDIA_LOGO for m in matches))
        logos.attach([{"company": "NVIDIA", "company_url": "https://simplify.jobs/c/NVIDIA"}], raw, cache, fetch=self.fetch, now=2000, delay=0)
        self.assertEqual(self.calls, ["NVIDIA"], "a cached company is never read again")

    def test_other_sources_borrow_the_logo_by_name(self):
        raw = {"simplify": [{"company_name": "NVIDIA", "company_url": "https://simplify.jobs/c/NVIDIA"}]}
        board_row = {"company": "Nvidia Corporation", "company_url": ""}
        logos.attach([board_row], raw, {}, fetch=self.fetch, now=1000, delay=0)
        self.assertEqual(board_row["logo"], NVIDIA_LOGO)

    def test_failures_retry_after_a_week_not_every_run(self):
        cache = {}
        row = lambda: {"company": "Nobody", "company_url": "https://simplify.jobs/c/Nobody"}
        logos.attach([row()], {}, cache, fetch=self.fetch, now=0, delay=0)
        logos.attach([row()], {}, cache, fetch=self.fetch, now=86400, delay=0)
        self.assertEqual(self.calls, ["Nobody"])
        logos.attach([row()], {}, cache, fetch=self.fetch, now=8 * 86400, delay=0)
        self.assertEqual(self.calls, ["Nobody", "Nobody"])

    def test_offline_runs_read_nothing(self):
        m = {"company": "NVIDIA", "company_url": "https://simplify.jobs/c/NVIDIA"}
        self.assertEqual(logos.attach([m], {}, {}, fetch=self.fetch, allow_network=False), 0)
        self.assertNotIn("logo", m)

    def test_a_failed_fetch_is_recorded_not_raised(self):
        def boom(slug):
            raise OSError("down")
        cache = {}
        logos.attach([{"company": "X", "company_url": "https://simplify.jobs/c/X"}], {}, cache, fetch=boom, now=5, delay=0)
        self.assertEqual(cache["X"], {"logo": "", "checked": 5})


class Payload(unittest.TestCase):
    def test_push_carries_a_name_to_logo_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            d, c = Path(tmp) / "data", Path(tmp) / "config"
            d.mkdir(); c.mkdir()
            (d / "matches.json").write_text(json.dumps({"matches": [{"key": "a", "company": "NVIDIA Corporation", "logo": NVIDIA_LOGO}]}))
            self.assertEqual(sync.build_push_payload(d, c)["logos"], {"nvidia": NVIDIA_LOGO})


if __name__ == "__main__":
    unittest.main()
