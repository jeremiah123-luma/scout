"""Decide what a listing is: which company tier, which role, where, and whether it is freshman-friendly.

Everything here reads config/targets.yaml and returns plain strings, so scoring.py can turn
the answers into points and the breakdown can show a human why.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit

import yaml

ROOT = Path(__file__).resolve().parent.parent
TARGETS_PATH = ROOT / "config" / "targets.yaml"

# Short words that must match whole words only. "it" inside "Pittsburgh" is not an IT job.
SHORT_TOKENS = {"india", "it", "ui", "ux", "swe", "sde", "pm", "apm", "ai", "ml", "web", "ios", "nj", "ny", "nyc", "uk", "aws", "ibm", "x", "step", "rf"}

US_STATES = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la", "me",
    "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa",
    "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
}
US_STATE_NAMES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
    "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
    "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska",
    "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas",
    "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
    "washington, d.c.", "washington dc", "d.c.",
}
# Big US tech cities the lists sometimes write with no state.
US_CITY_SHORTHANDS = {"nyc", "sf", "la", "usa", "united states", "us", "south sf", "san jose", "los angeles",
                      "san francisco", "seattle", "boston", "austin", "chicago", "atlanta", "mountain view",
                      "sunnyvale", "palo alto", "menlo park", "cupertino", "redmond", "bay area"}


def load_targets(path: Path = TARGETS_PATH) -> dict:
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def _word_match(text: str, word: str) -> bool:
    """True when `word` appears in `text`. Short tokens and single words match on word boundaries."""
    word = word.lower().strip()
    if not word:
        return False
    if word in SHORT_TOKENS or (" " not in word and len(word) <= 4):
        return re.search(rf"(?<![a-z0-9]){re.escape(word)}(?![a-z0-9])", text) is not None
    return word in text


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower()).strip()


# ---------------------------------------------------------------- company tier

CORPORATE_SUFFIXES = ("inc", "llc", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "lp", "l p", "holdings", "group")


def _company_core(company: str) -> str:
    """'Apple Inc.' -> 'apple', 'NVIDIA Corporation' -> 'nvidia', 'Apple Bank' -> 'apple bank' (unchanged)."""
    name = re.sub(r"[^a-z0-9 ]+", " ", _clean(company).replace(".", ""))  # "L.P." -> "lp", "Inc." -> "inc"
    name = re.sub(r"\s+", " ", name).strip()
    words = name.split(" ")
    while len(words) > 1 and words[-1] in CORPORATE_SUFFIXES:
        words.pop()
    return " ".join(words)


def company_tier(company: str, targets: dict) -> tuple[int, str | None]:
    """('Google LLC') -> (1, 'google'). Anything not listed -> (3, None).

    The whole company name (minus Inc/LLC/Corp) must equal an alias. A word match is not enough:
    "Apple Bank" is not Apple and "Meta Marketing Group" is not Meta. Subsidiaries that should count
    (Amazon Web Services, Google DeepMind) are listed as their own alias in targets.yaml.
    """
    core = _company_core(company)
    if not core:
        return 3, None
    for tier_number, group in ((1, targets.get("tier1", {})), (2, targets.get("tier2", {}))):
        for canonical, aliases in group.items():
            if any(core == _company_core(alias) for alias in aliases):
                return tier_number, canonical
    return 3, None


# ---------------------------------------------------------------- role

# Titles that are for graduate students whatever the degrees field says: "Software Engineering Intern, Masters".
_GRAD_TITLE = re.compile(r"(?<![a-z])(master['\u2019]?s|mba|ph\.?\s?d|ms/phd|m\.s\.|doctoral|graduate[- ]level"
                         r"|post-?doc\w*|graduate (?:research )?fellow\w*)(?![a-z])"
                         r"|[-(]\s*ms\s*\)?\s*$", re.I)


_UNDERGRAD_TITLE = re.compile(r"(?<![a-z])(bs|b\.s\.|ba|bachelor'?s?|undergrad\w*)(?![a-z])", re.I)


def graduate_title(title: str) -> bool:
    """A Masters/MBA/PhD title that names no undergrad degree. "Intern (BS/MS)" stays."""
    return _GRAD_TITLE.search(title or "") is not None and _UNDERGRAD_TITLE.search(title or "") is None


def excluded_title(title: str, targets: dict) -> bool:
    """A title with an exclude word (hardware, quant, ...) is out, unless it plainly says software.

    "Privacy and Civil Liberties Software Engineer Intern" is a software job that happens to contain "civil".
    """
    text = _clean(title)
    # "Software Defined Radio Hardware Intern" is still hardware: the override needs a title without "hardware".
    if any(_word_match(text, w) for w in targets["roles"].get("software_overrides", [])) and "hardware" not in text:
        return False
    return any(_word_match(text, w) for w in targets["roles"].get("exclude", []))


def classify_role(title: str, targets: dict) -> str:
    """Return 'ambassador' | 'design' | 'pm' | 'it' | 'swe' | 'none' from the title."""
    text = _clean(title)
    roles = targets["roles"]
    # Ambassador programs first, before the exclusions: they often carry "marketing" in the title.
    if any(_word_match(text, w) for w in roles.get("ambassador", [])):
        return "ambassador"
    if excluded_title(title, targets):
        return "none"
    for role in ("design", "pm", "it", "swe"):
        if any(_word_match(text, w) for w in roles.get(role, [])):
            return role
    return "none"


# ---------------------------------------------------------------- early career

def early_career(title: str, company_key: str | None, targets: dict, url: str = "") -> str:
    """Return 'strong' (freshman/sophomore word or a named program), 'weak' ('early career'), or 'none'.

    The URL is searched too, because the lists often shorten titles: NVIDIA's Ignite posting is listed
    as "Software Engineer Intern" while its URL says "NVIDIA-2027-Ignite-Internships".
    """
    path = re.sub(r"[-_/+.%]+", " ", urlsplit(url).path.lower()) if url else ""
    text = _clean(title) + " " + path
    programs = targets.get("programs", {})
    if company_key and any(_word_match(text, w) for w in programs.get(company_key, [])):
        return "strong"
    if any(_word_match(text, w) for w in programs.get("any", [])):
        return "strong"
    if any(_word_match(text, w) for w in targets.get("early_career_weak", [])):
        return "weak"
    return "none"


# ---------------------------------------------------------------- location

def location_class(locations: list[str], targets: dict) -> str:
    """Best location in the list: 'priority' (NJ, NYC, remote US) | 'us' | 'other' | 'unknown'.

    US signals are checked before non-US words, so "New Berlin, WI" is Wisconsin, not Germany.
    """
    if not locations:
        return "unknown"
    cfg = targets["locations"]
    best = "other"
    for raw in locations:
        loc = _clean(raw)
        if any(_word_match(loc, w) for w in cfg.get("priority", [])):
            return "priority"
        if _looks_canada(loc):
            continue  # checked first: "Toronto, ON, CA" ends in a US state code
        if _looks_us(loc):
            best = "us"
            continue
        if any(_word_match(loc, w) for w in cfg.get("non_us_words", [])):
            continue  # a non-US location can never raise the class
        if any(_word_match(loc, w) for w in cfg.get("remote_words", [])):
            return "priority"  # bare "Remote" with no other country named
    return best


def outside_us_only(locations: list[str], targets: dict) -> bool:
    """True when every location names another country. An unrecognized place is not proof of anything."""
    cfg = targets["locations"]
    if not locations:
        return False
    for raw in locations:
        loc = _clean(raw)
        if _looks_canada(loc):
            continue
        if _looks_us(loc) or not any(_word_match(loc, w) for w in cfg.get("non_us_words", [])):
            return False
    return True


CA_PROVINCES = {"on", "bc", "qc", "ab", "ns", "mb", "sk", "nb", "nl", "pe"}


def _looks_canada(loc: str) -> bool:
    """'Toronto, ON', 'Waterloo, ON, Canada', or 'Toronto, ON, CA' (Pinterest's board, where CA is Canada,
    not California): a province code as the last part, or right before the country."""
    parts = [p.strip() for p in loc.split(",")]
    return parts[-1] in CA_PROVINCES or (len(parts) > 1 and parts[-1] in ("canada", "ca") and parts[-2] in CA_PROVINCES)


def _looks_us(loc: str) -> bool:
    if loc in US_CITY_SHORTHANDS or any(_word_match(loc, w) for w in ("united states", "usa")):
        return True
    if any(loc == c or loc.startswith(c + ",") for c in US_CITY_SHORTHANDS):
        return True
    if loc in US_STATE_NAMES:
        return True
    tail = loc.rsplit(",", 1)[-1].strip()
    if tail in ("us", "usa", "united states"):
        return True
    return tail in US_STATES or tail in US_STATE_NAMES


# ---------------------------------------------------------------- degrees

def degree_class(degrees: list[str], targets: dict) -> str:
    """'bachelors' | 'unknown' | 'graduate_only'."""
    if not degrees:
        return "unknown"
    graduate_only = {d.lower() for d in targets.get("graduate_only_degrees", [])}
    listed = {d.lower() for d in degrees}
    if listed and listed <= graduate_only:
        return "graduate_only"
    return "bachelors"


# ---------------------------------------------------------------- keywords

def keyword_hits(title: str, targets: dict) -> list[str]:
    text = _clean(title)
    return [k for k in targets.get("keywords", []) if _word_match(text, k)]


# ---------------------------------------------------------------- put it together

def describe(listing: dict, targets: dict) -> dict:
    """Attach tier, role, early-career, location, degree, and keyword facts to a listing (in place)."""
    tier, company_key = company_tier(listing["company"], targets)
    listing["tier"] = tier
    listing["company_key"] = company_key
    listing["role"] = classify_role(listing["title"], targets)
    listing["early_career"] = early_career(listing["title"], company_key, targets, listing.get("url", ""))
    listing["location_class"] = location_class(listing.get("locations", []), targets)
    listing["outside_us_only"] = outside_us_only(listing.get("locations", []), targets)
    listing["excluded"] = listing["role"] != "ambassador" and excluded_title(listing["title"], targets)
    listing["graduate_title"] = graduate_title(listing["title"])
    # The lists mark some postings "U.S. Citizenship is Required" (often defense work). Whether that rules
    # him out depends on us_citizen in targets.yaml: false drops them, null keeps them with a label.
    required = listing.get("sponsorship") == "U.S. Citizenship is Required"
    listing["citizens_only"] = required and targets.get("us_citizen") is None   # the label, while unconfirmed
    listing["citizenship_blocked"] = required and targets.get("us_citizen") is False
    listing["degree_class"] = degree_class(listing.get("degrees", []), targets)
    listing["keyword_hits"] = keyword_hits(listing["title"], targets)
    return listing


def passes_filters(listing: dict, cycle_year: str = "2027", max_age_days: int | None = None,
                   now: float | None = None) -> tuple[bool, str]:
    """Hard drops only. Returns (keep, reason). Everything that passes gets scored, nothing is hidden for location."""
    if not listing.get("active", True):
        return False, "inactive"
    if not any(cycle_year in t for t in listing.get("terms", [])):
        return False, "not a 2027 term"
    # A company board only lists jobs that are open now, so its rows skip the age cutoff: Palantir reposts
    # the same Meritocracy Fellowship every year, and its posting date is from 2025.
    if max_age_days and listing.get("date_posted") and listing.get("source") != "boards":
        import time
        age_days = ((now if now is not None else time.time()) - listing["date_posted"]) / 86400
        if age_days > max_age_days:
            return False, f"older than {max_age_days} days"
    if listing.get("degree_class") == "graduate_only" or listing.get("graduate_title"):
        return False, "graduate students only"
    if listing.get("outside_us_only"):
        return False, "outside the US"
    if listing.get("citizenship_blocked"):
        return False, "US citizens only"
    # A freshman program keeps a title with no role word ("Explore Program"), but not one that names
    # a field he isn't looking for: NVIDIA's Ignite program also has a Hardware Engineering track.
    if listing.get("excluded"):
        return False, "not a target role"
    if listing.get("role") == "none" and listing.get("early_career") != "strong":
        return False, "not a target role"
    return True, "ok"
