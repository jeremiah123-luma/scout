"""Company logos for the dashboard, taken from Simplify's public company pages.

Every Simplify listing links to a company page (company_url, like https://simplify.jobs/c/NVIDIA). That page
names a square logo image on Google Cloud Storage (storage.googleapis.com/simplify-imgs/companies/<id>/logo.png),
100 to 200 pixels, which is cleaner than any favicon service. robots.txt allows /c/ pages.

Each company page is read once and cached in data/logos.json, so a normal run reads none or a few. A page that
fails is tried again after a week. Rows from the other sources (the community list, company boards, the tracker)
have no company_url, so they borrow the logo of a Simplify company with the same name. Anything still without a
logo gets a letter badge on the dashboard.
"""

from __future__ import annotations

import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGOS_PATH = ROOT / "data" / "logos.json"
RETRY_AFTER = 7 * 86400   # a page that failed is tried again a week later
NEW_PER_RUN = 200         # at most this many company pages per run (the first run reads about 175, then a few a day)
DELAY = 0.4               # seconds between page reads

SLUG = re.compile(r"^https?://(?:www\.)?simplify\.jobs/c/([^/?#]+)", re.I)
LOGO = re.compile(r"https://storage\.googleapis\.com/simplify-imgs/companies/[0-9a-f-]+/logo\.(?:png|jpe?g|webp)", re.I)
SUFFIXES = re.compile(r"[,.]?\s+(inc|llc|ltd|corp|corporation|co|company|plc|group|holdings|technologies)\.?$", re.I)


def norm_name(name: str) -> str:
    """'NVIDIA Corporation' and 'Nvidia' are the same company here."""
    n = (name or "").strip().lower()
    for _ in range(2):
        n = SUFFIXES.sub("", n).strip()
    return re.sub(r"\s+", " ", n)


def slug_of(company_url: str) -> str:
    m = SLUG.match(company_url or "")
    return m.group(1) if m else ""


def logo_from_page(html: str) -> str:
    """The company's logo URL from its Simplify page, or "" when the page has none."""
    m = LOGO.search(html or "")
    return m.group(0) if m else ""


def load(path: Path = LOGOS_PATH) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(cache: dict, path: Path = LOGOS_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=1, sort_keys=True), encoding="utf-8")


def fetch_page(slug: str) -> str:
    request = urllib.request.Request(f"https://simplify.jobs/c/{slug}",
                                     headers={"User-Agent": "scout/0.1 (personal internship tracker; reads company logos)"})
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read(600_000).decode("utf-8", "replace")


def name_slugs(raw_by_source: dict[str, list]) -> dict[str, str]:
    """Company name to Simplify slug, from every Simplify row (open or closed), for rows from other sources."""
    out: dict[str, str] = {}
    for row in raw_by_source.get("simplify", []) or []:
        slug, name = slug_of(row.get("company_url", "")), norm_name(row.get("company_name", ""))
        if slug and name:
            out.setdefault(name, slug)
    return out


def attach(matches: list[dict], raw_by_source: dict[str, list], cache: dict, *, fetch=fetch_page,
           allow_network: bool = True, now: float | None = None, delay: float = DELAY) -> int:
    """Give each match a `logo` URL where one is known. Reads at most NEW_PER_RUN new company pages.
    Returns how many pages it read. The cache maps slug -> {"logo": url or "", "checked": unix time}."""
    now = now if now is not None else time.time()
    by_name = name_slugs(raw_by_source)
    read = 0
    for m in matches:
        slug = slug_of(m.get("company_url", "")) or by_name.get(norm_name(m.get("company", "")), "")
        if not slug:
            continue
        entry = cache.get(slug)
        stale = entry is None or (not entry.get("logo") and now - entry.get("checked", 0) > RETRY_AFTER)
        if stale and allow_network and read < NEW_PER_RUN:
            try:
                logo = logo_from_page(fetch(slug))
            except Exception:
                logo = ""
            entry = {"logo": logo, "checked": int(now)}
            cache[slug] = entry
            read += 1
            if delay:
                time.sleep(delay)
        if entry and entry.get("logo"):
            m["logo"] = entry["logo"]
            m["logo_slug"] = slug
    return read


def by_company(matches: list[dict]) -> dict[str, str]:
    """Normalized company name -> logo URL, for the dashboard's tracker and Review cards, which only know a name."""
    out: dict[str, str] = {}
    for m in matches:
        if m.get("logo"):
            out.setdefault(norm_name(m.get("company", "")), m["logo"])
    return out
