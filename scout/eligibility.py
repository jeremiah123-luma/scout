"""Read a posting page and look for a graduation-year requirement.

Many postings say things like "graduating between December 2027 and June 2028" or "Class of 2028".
For someone graduating in 2030 (graduation_year in config/targets.yaml) those are out even when the
list says "Bachelor's". The lists
do not carry this, so for the top matches Scout fetches the page (Workday, Google Careers,
Greenhouse, Lever, Ashby) and reads it.

Verdicts:
  "ok"          the page names a graduation window that includes yours, or names no year and says
                freshman/sophomore
  "ineligible"  the page names graduation windows and yours is in none of them, or names no year and asks
                for penultimate-year, final-year, junior, or senior students
  "closed"      the board says the posting is gone (treated like "ineligible": never pushed, sorted last)
  "unknown"     the page could not be read, or says nothing about graduation year (never hidden, just labeled)

Reading the page is scout/posting.py's job (Workday, Google Careers, Greenhouse, Lever, Ashby).

Results are cached in data/eligibility_cache.json by URL so a page is fetched once, not every run.
Posting text is untrusted: it is only ever searched with regular expressions, never executed or followed.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path

from scout import posting

ROOT = Path(__file__).resolve().parent.parent
CACHE_PATH = ROOT / "data" / "eligibility_cache.json"
CACHE_DAYS = 14
CLOSED = "\0closed"  # fetch_text's answer for a posting the board says is gone
CACHE_VERSION = 5  # bump when the verdict rules change, so old verdicts are re-read

_TAGS = re.compile(r"<script.*?</script>|<style.*?</style>|<[^>]+>", re.S | re.I)
_YEAR = re.compile(r"\b(20[2-3][0-9])\b")
# A graduation requirement is a sentence with "graduating", "graduation", "class of", or "degree expected" in it.
# Every year in that sentence counts, so "December 2028, May 2029, December 2029, or May 2030" yields all four.
# The text is flattened to one line first: Pinterest puts "graduate by" and "June 2029" on separate lines.
# "graduate degree", "graduate students", and the like are about degree level, not a date: Northrop Grumman's
# "undergraduate or graduate degree ... enrolled full time in Fall 2027" is not a 2027 graduation rule.
_GRAD_SENTENCE = re.compile(
    r"[^.]{0,80}\b(?:graduat(?:e[sd]?|ing|ion)\b(?!\s+(?:degrees?|students?|programs?|level|school|studies|coursework|research))"
    r"|class of\b|degree expected\b|expected (?:degree|completion)\b|degree completion\b)[^.]{0,160}", re.I)
# "2028 or later" is a floor, not a single year. "graduate before Summer 2028" / "by June 2029" is a ceiling.
_OPEN_AFTER = re.compile(r"\b20[2-3][0-9]\s*(?:or|and)\s*(?:later|after|beyond)\b|\b20[2-3][0-9]\s*onwards?\b", re.I)
_CEILING = re.compile(r"\b(?:before|by|no later than|prior to)\s+(?:[a-z/]+\s+){0,2}20[2-3][0-9]\b", re.I)
# Floors: "on or after December 2027", "no earlier than May 2028", "do not anticipate graduating before May 2028",
# and "students graduating by Summer 2027 are not eligible". Checked before _CEILING, which they would otherwise trip.
_FLOOR = re.compile(
    r"\b(?:(?:on|in) or after|after|no earlier than)\s+(?:[a-z/]+\s+){0,2}20[2-3][0-9]\b"
    r"|\bnot\b[^.]{0,40}?\b(?:before|prior to)\s+(?:[a-z/]+\s+){0,2}20[2-3][0-9]\b"
    r"|\b(?:before|by|prior to)\s+(?:[a-z/]+\s+){0,2}20[2-3][0-9]\b[^.]{0,30}\b(?:are|is) (?:not |in)eligible", re.I)
_UNDERCLASS = re.compile(r"\b(freshman|freshmen|sophomore|first[- ]year|second[- ]year|underclass\w*)\b", re.I)
# Phrases that mean "not a freshman": Google writes "penultimate academic year", others say "rising junior".
_UPPERCLASS = re.compile(
    r"\b(penultimate|final[- ]year|last[- ]year of|rising (?:junior|senior)s?|junior or senior|juniors and seniors|"
    r"junior/senior|third[- ]year or fourth[- ]year|(?:junior|senior) standing)\b", re.I)


# Programs built as an alternative to college (Palantir's Meritocracy Fellowship, the Thiel Fellowship) require
# not being enrolled. A current college student is ruled out whatever the graduation year.
_NOT_ENROLLED = re.compile(
    r"\b(?:not|cannot|can't|can not)\s+(?:be )?(?:currently )?enrolled in (?:an? |any )?(?:accredited )?(?:u\.?s\.? )?(?:college|university|degree)", re.I)


# Degree level. Sony's AI Ethics intern says "Completed or currently pursuing a PhD in Computer Science"; a page
# like that names no graduation year, so the year rules above never see it. A sentence that also names a
# bachelor's or undergraduate degree ("pursuing a BS, MS, or PhD") is open to him and does not count.
_GRAD_DEGREE = re.compile(
    r"\b(?:pursuing|enrolled in|currently in|candidates? for|working toward|working towards)\b[^.;]{0,40}?"
    r"\b(ph\.?\s?d\.?|doctoral|doctorate|master'?s|graduate degree)"
    r"|\b(ph\.?\s?d\.?|doctoral|master'?s)\s+(?:students?|candidates?|programs?)\b", re.I)
_UNDERGRAD = re.compile(r"\b(bachelor'?s?|undergrad\w*|b\.?s\.?|b\.?a\.?|bs/ms|ba/bs)\b", re.I)


def graduate_only(text: str) -> str:
    """'PhD' or "master's" when the page asks only for graduate students, else ''."""
    for sentence in re.split(r"(?<=[.;!?•●])\s+|\n", text):
        m = _GRAD_DEGREE.search(sentence)
        if m and not _UNDERGRAD.search(sentence):
            level = (m.group(1) or m.group(2) or "").lower()
            return "master's" if level.startswith("master") else "graduate" if "graduate" in level else "PhD"
    return ""


def is_readable_board(url: str) -> bool:
    return posting.is_readable_board(url)


def fetch_text(url: str) -> str | None:
    """The posting's text, CLOSED when the board says it is gone, or None when it cannot be read server-side."""
    post = posting.read_posting(url)
    if post and post.get("closed"):
        return CLOSED
    return post["text"] if post else None


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def years_mentioned(text: str) -> list[int]:
    """Every graduation year the page names, e.g. 'graduating between Dec 2027 and June 2028' -> [2027, 2028]."""
    years: set[int] = set()
    for sentence in _GRAD_SENTENCE.finditer(_flat(text)):
        for year in _YEAR.findall(sentence.group(0)):
            years.add(int(year))
    return sorted(years)


def grad_ranges(text: str, this_year: int | None = None) -> list[tuple[int, int]]:
    """One (low, high) graduation window per requirement sentence.

    Years before this year are ignored ("founded in 2021, our graduate program"), "or later" opens the top,
    and "before"/"by" opens the bottom.
    """
    this_year = this_year or datetime.now().year
    ranges = []
    for match in _GRAD_SENTENCE.finditer(_flat(text)):
        sentence = match.group(0)
        years = [int(y) for y in _YEAR.findall(sentence) if int(y) >= this_year]
        if not years:
            continue
        low, high = min(years), max(years)
        if _OPEN_AFTER.search(sentence) or _FLOOR.search(sentence):
            high = 9999
        elif _CEILING.search(sentence):
            low = 0
        ranges.append((low, high))
    return ranges


def _describe(low: int, high: int) -> str:
    if high == 9999:
        return f"{low} or later"
    if low == 0:
        return f"by {high}"
    return f"{low}" + (f" to {high}" if high != low else "")


def verdict_from_text(text: str, graduation_year: int, this_year: int | None = None) -> tuple[str, str]:
    """('ok' | 'ineligible' | 'unknown', short reason).

    Stated graduation years decide first. A page can say "sophomore" and still ask for 2029 graduates,
    so freshman words only count when no year is stated.
    """
    if _NOT_ENROLLED.search(_flat(text)):
        return "ineligible", "page requires not being enrolled in college"
    level = graduate_only(text)
    if level:
        return "ineligible", f"page asks for {level} students"
    ranges = grad_ranges(text, this_year)
    if ranges:
        fits = [r for r in ranges if r[0] <= graduation_year <= r[1]]
        if fits:
            return "ok", "page names graduation " + _describe(*fits[0])
        return "ineligible", "page requires graduation " + _describe(*ranges[0])
    if _UNDERCLASS.search(text):
        return "ok", "page mentions freshman/sophomore/underclassmen"
    upper = _UPPERCLASS.search(text)
    if upper:
        return "ineligible", f"page asks for {upper.group(1).lower()} students"
    return "unknown", "page says nothing about graduation year"


def load_cache(path: Path = CACHE_PATH) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_cache(cache: dict, path: Path = CACHE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(cache, indent=1, sort_keys=True), encoding="utf-8")


def check(listing: dict, graduation_year: int, cache: dict, allow_network: bool = True) -> dict:
    """Attach 'eligibility' and 'eligibility_note' to a listing. Uses the cache first, then the network."""
    url = listing.get("url", "")
    cached = cache.get(url)
    if cached and cached.get("v") == CACHE_VERSION and time.time() - cached.get("checked_at", 0) < CACHE_DAYS * 24 * 3600:
        listing["eligibility"], listing["eligibility_note"] = cached["verdict"], cached["note"]
        return listing
    if not allow_network or not is_readable_board(url):
        listing["eligibility"], listing["eligibility_note"] = "unknown", "not checked (board can't be read server-side)" if not is_readable_board(url) else "not checked (network off)"
        return listing
    text = fetch_text(url)
    if text is None:
        # Not cached: one timeout should not lock a Tier 1 posting at "unknown" for two weeks.
        listing["eligibility"], listing["eligibility_note"] = "unknown", "page could not be read"
        return listing
    if text == CLOSED:
        verdict, note = "closed", "the posting has been taken down"
    else:
        verdict, note = verdict_from_text(text, graduation_year)
    cache[url] = {"verdict": verdict, "note": note, "checked_at": int(time.time()), "v": CACHE_VERSION}
    listing["eligibility"], listing["eligibility_note"] = verdict, note
    return listing
