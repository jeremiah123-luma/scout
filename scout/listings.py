"""Fetch the public internship lists and normalize every row into one shape.

Sources (all free, all public JSON, no login):
  simplify  SimplifyJobs/Summer2027-Internships  (~13 MB, ~17K rows, the main list)
  vanshb03  vanshb03/Summer2027-Internships      (~275 KB, MIT, a separate community list)
  boards    target companies' own Greenhouse, Ashby, and Lever boards (scout/boards.py, targets.yaml boards:),
            for internships the lists never carry, like design roles

Every row becomes a plain dict with the same keys, so nothing downstream cares which list it came from:

  {
    "id": "...",                 # the source's own id
    "source": "simplify",        # which list
    "company": "Google",
    "title": "Software Engineering Intern, Summer 2027",
    "url": "https://...",
    "locations": ["NYC", "Mountain View, CA"],
    "terms": ["Summer 2027"],    # vanshb03 rows carry a season with no year; the list is scoped to 2027
    "degrees": ["Bachelor's"],   # [] when the source does not say
    "sponsorship": "Other",      # "Other" | "Offers Sponsorship" | "Does Not Offer Sponsorship" | "U.S. Citizenship is Required"
    "category": "Software",      # the source's category when it has one, else None
    "date_posted": 1760000000,   # unix seconds
    "date_updated": 1760000000,
    "active": True,
  }

Network calls live only in fetch_json(). Tests pass saved fixture files instead.
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import yaml

from scout import boards

SOURCES = {
    "simplify": "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    "vanshb03": "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/main/.github/scripts/listings.json",
}

USER_AGENT = "scout-internship-watcher/0.1 (personal project; reads public JSON only)"


class SourceError(Exception):
    """A source could not be fetched or did not look like the list we expect. The caller alerts loudly."""


def fetch_json(url: str, timeout: int = 60) -> list:
    """Download one source file. Raises SourceError on any failure so the run can fail loudly."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.load(response)
    except Exception as exc:  # network error, timeout, bad JSON: all the same to the caller
        raise SourceError(f"fetch failed for {url}: {exc}") from exc
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        raise SourceError(f"unexpected shape from {url}: expected a non-empty list of objects")
    return data


def load_json(path: Path) -> list:
    """Read a saved copy of a source file (fixtures in tests, or --offline runs)."""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def normalize_simplify(row: dict) -> dict:
    return {
        "id": str(row.get("id", "")),
        "source": "simplify",
        "company": (row.get("company_name") or "").strip(),
        "title": (row.get("title") or "").strip(),
        "url": (row.get("url") or "").strip(),
        "locations": [str(x).strip() for x in (row.get("locations") or []) if x],
        "terms": [str(x).strip() for x in (row.get("terms") or []) if x],
        "degrees": [str(x).strip() for x in (row.get("degrees") or []) if x],
        "sponsorship": (row.get("sponsorship") or "Other").strip(),
        "category": row.get("category") or None,
        "date_posted": int(row.get("date_posted") or 0),
        "date_updated": int(row.get("date_updated") or row.get("date_posted") or 0),
        "active": bool(row.get("active")) and bool(row.get("is_visible", True)),
        "company_url": (row.get("company_url") or "").strip(),  # Simplify's company page: scout/logos.py reads its logo
    }


def normalize_vanshb03(row: dict) -> dict:
    # This list has a "season" ("Summer", "Fall", "Winter", "Spring", "Spring/Summer") but no year.
    # The repo itself is the 2027 cycle, so the year is filled in here. "null" means the row did not say.
    season = (row.get("season") or "").strip()
    terms = [f"{season} 2027"] if season and season.lower() != "null" else []
    return {
        "id": str(row.get("id", "")),
        "source": "vanshb03",
        "company": (row.get("company_name") or "").strip(),
        "title": (row.get("title") or "").strip(),
        "url": (row.get("url") or "").strip(),
        "locations": [str(x).strip() for x in (row.get("locations") or []) if x],
        "terms": terms,
        "degrees": [],  # the list does not record degrees
        "sponsorship": (row.get("sponsorship") or "Other").strip(),
        "category": None,
        "date_posted": int(row.get("date_posted") or 0),
        "date_updated": int(row.get("date_updated") or row.get("date_posted") or 0),
        "active": bool(row.get("active")) and bool(row.get("is_visible", True)),        "company_url": (row.get("company_url") or "").strip(),
    }


NORMALIZERS = {"simplify": normalize_simplify, "vanshb03": normalize_vanshb03, "boards": lambda row: row}
TARGETS_PATH = Path(__file__).resolve().parent.parent / "config" / "targets.yaml"


def normalize_all(raw_by_source: dict[str, list]) -> list[dict]:
    """{"simplify": [...rows...], "vanshb03": [...rows...]} -> one flat list of normalized dicts."""
    out: list[dict] = []
    for source, rows in raw_by_source.items():
        normalize = NORMALIZERS[source]
        for row in rows:
            item = normalize(row)
            if item["company"] and item["title"]:
                out.append(item)
    return out


def fetch_all(sources: dict[str, str] | None = None, with_boards: bool = True) -> tuple[dict[str, list], list[str]]:
    """Fetch every source. Returns (raw rows by source, list of error messages).

    One broken source must not hide the other, so errors are collected, not raised.
    The caller decides whether to alert on them.
    """
    sources = sources or SOURCES
    raw: dict[str, list] = {}
    errors: list[str] = []
    for name, url in sources.items():
        try:
            raw[name] = fetch_json(url)
        except SourceError as exc:
            errors.append(f"{name}: {exc}")
    if with_boards:
        config = (yaml.safe_load(TARGETS_PATH.read_text(encoding="utf-8")) or {}).get("boards") or {}
        rows, board_errors = boards.fetch_boards(config)
        raw["boards"] = rows
        errors.extend(board_errors)
    return raw, errors
