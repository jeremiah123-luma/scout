"""The "Let's Add to Your Resume" feed on saved snippets. No network."""

import base64
import unittest
from datetime import datetime, timezone

from scout import certs, feed, hackathons

MLH_HTML = (
    '<script>{"events":[' +
    '{"id":"01a0eeb9-5924-af9e-cdc9-e95db9dced9e","slug":"hackprinceton","name":"HackPrinceton","status":"pending",'
    '"startsAt":"2026-11-13T22:00:00Z","endsAt":"2026-11-15T17:00:00Z","url":"\\/events\\/hackprinceton\\/prizes",'
    '"location":"Princeton, NJ","formatType":"physical","websiteUrl":"https:\\/\\/hackprinceton.com\\/",'
    '"venueAddress":{"city":"Princeton","state":"NJ","country":"US"}},' +
    '{"id":"01a06247-8bb4-b4aa-ad42-b521be80b16a","slug":"hacktrent","name":"HackTrent","startsAt":"2026-11-06T22:00:00Z",'
    '"endsAt":"2026-11-08T20:00:00Z","url":"\\/events\\/hacktrent\\/prizes","location":"Peterborough, Ontario","formatType":"physical",'
    '"venueAddress":{"city":"Peterborough","state":"Ontario","country":"CA"}},' +
    '{"id":"01a0a682-b6ce-34cc-4fb5-70e9a47a3a6c","slug":"online-hack","name":"OnlineHack","startsAt":"2026-11-07T22:00:00Z",'
    '"endsAt":"2026-11-08T20:00:00Z","url":"\\/events\\/online-hack\\/prizes","location":"Everywhere","formatType":"digital",'
    '"venueAddress":{"city":"","state":"","country":"US"}}' + ']}</script>'
)
CONFIG = {"sources": {"mlh": {"enabled": True, "url": "https://example.test/{season}"}, "pinned": {"enabled": False}},
          "nearby_states": ["NJ", "NY"]}


class Hackathons(unittest.TestCase):
    def test_parse_and_filter_mlh(self):
        raw = hackathons.parse_mlh(MLH_HTML)
        self.assertEqual([r["slug"] for r in raw], ["hackprinceton", "hacktrent", "online-hack"])
        events, statuses = hackathons.collect(CONFIG, datetime(2026, 10, 28, tzinfo=timezone.utc),
                                              fetch=lambda url: MLH_HTML, allow_network=False, cache={})
        self.assertEqual([e["name"] for e in events], ["HackPrinceton"], "in person, US, nearby state only")
        e = events[0]
        self.assertEqual((e["start"], e["end"]), ("2026-11-13", "2026-11-15"))
        self.assertEqual(e["url"], "https://hackprinceton.com/")
        self.assertIsNone(e["deadline"], "the listing has no deadline, so none is invented")
        self.assertIsNone(e["travel"])
        self.assertAlmostEqual(e["lat"], 40.3431, places=3, msg="Princeton resolves from the known places")
        self.assertTrue(statuses[0]["ok"])

    def test_season_and_distance(self):
        self.assertEqual(hackathons.season_year(datetime(2026, 10, 28)), 2027)
        self.assertEqual(hackathons.season_year(datetime(2027, 3, 1)), 2027)
        d = hackathons.miles(40.7424, -74.1779, 40.3431, -74.6551)
        self.assertTrue(35 < d < 42)
        self.assertEqual(hackathons.find_place("UConn Stamford hack", hackathons.load_places())["name"], "UConn Stamford")

    def test_pinned_is_checked_against_its_site(self):
        entry = {"key": "pinned:x", "name": "X", "url": "https://x.test/", "verify_url": "https://x.test/", "verify_text": "November 21-22, 2026"}
        pages = {"https://x.test/": '<script src="/a.js"></script>', "https://x.test/a.js": "when: November 21-22, 2026"}
        self.assertTrue(hackathons.check_pinned(entry, pages.__getitem__)["checked"])
        pages["https://x.test/a.js"] = "when: moved"
        self.assertFalse(hackathons.check_pinned(entry, pages.__getitem__)["checked"])


PAGE = "<html><body><script>var x=1</script><p>Exam duration 90 minutes. Cost 100 USD. Visit Exam pricing.</p></body></html>"


class Certs(unittest.TestCase):
    CERT = {"key": "cert:a", "name": "A", "provider": "P", "url": "https://p.test/", "roles": ["swe"], "why": "w",
            "cost": {"pattern": r"Cost\s+(\d+)\s+USD", "format": "${0} exam fee"},
            "hours": {"pattern": r"(\d+) hours", "format": "{0} hours"}}

    def test_value_comes_from_the_page_with_evidence(self):
        out = certs.verify(self.CERT, lambda url: PAGE)
        self.assertEqual(out["cost"], "$100 exam fee")
        self.assertIn("Cost 100 USD", out["evidence"]["cost"])
        self.assertIsNone(out["hours"], "a pattern the page doesn't match stays blank")
        self.assertTrue(out["checked_at"])

    def test_unreadable_or_changed_page_never_falls_back_to_a_number(self):
        def boom(url):
            raise OSError("down")
        out = certs.verify(self.CERT, boom)
        self.assertIsNone(out["cost"])
        self.assertIn("could not read", out["error"])
        self.assertIsNone(certs.verify(self.CERT, lambda url: "no price here")["cost"])

    def test_free_first(self):
        free = {**self.CERT, "key": "f", "name": "Z", "cost": {"pattern": r"(free)", "format": "Free"}}
        got = certs.collect({"certs": [self.CERT, free]}, lambda url: PAGE + " free")
        self.assertEqual(got[0]["key"], "f")


class Feed(unittest.TestCase):
    def test_refresh_keeps_last_good_events_when_every_source_fails(self):
        old = {"hackathons": {"fetched_at": 0, "events": [{"key": "a"}], "sources": []}}

        def boom(url):
            raise OSError("down")
        out = feed.refresh(old, 10 ** 9, hack_config=CONFIG, cert_config={"certs": []}, fetch=boom)
        self.assertEqual(out["hackathons"]["events"], [{"key": "a"}])
        self.assertFalse(out["hackathons"]["sources"][0]["ok"])

    def test_due(self):
        self.assertFalse(feed.due({"certs": {"fetched_at": 1000}}, "certs", 100, 1050))
        self.assertTrue(feed.due({}, "certs", 100, 1050))


if __name__ == "__main__":
    unittest.main()
