"""Read Jobright's daily internship lists, the same postings intern-list.com shows.

intern-list.com is Jobright's site, and its tables are Airtable embeds. Jobright also publishes those lists as
public GitHub repos (github.com/jobright-ai), one README table per field, refreshed every day with about the
last week's 100 postings. Reading the README is one plain request per field, with no Airtable and no login.

Each row links to the posting's page on jobright.ai, not the company's own site: Jobright shows the company's
apply link only after you sign in, and Scout never signs in. So dedupe.py lets a list or board row win over a
Jobright copy of the same posting, and a Jobright link only reaches the queue for postings no one else has.

README text is untrusted: titles and places are stored and matched, never followed or executed.
"""

from __future__ import annotations

import re
import urllib.request
from datetime import datetime, timezone

from scout import boards

# The repos are named for the 2026 season but list whatever posted this week (Summer 2027 roles now).
FIELDS = ("Software-Engineer", "Data-Analysis", "Product-Management", "Design", "Engineer")
README = "https://raw.githubusercontent.com/jobright-ai/2026-{field}-Internship/master/README.md"
USER_AGENT = "scout-internship-watcher/0.1 (personal project; reads public job lists only)"

_LINK = re.compile(r"\[([^\]]*)\]\(([^)\s]*)\)")
_MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}
# "Qorvo, Inc." and Simplify's "Qorvo" are one company; without this the same posting shows up twice.
_SUFFIX = re.compile(r",?\s+(inc\.?|llc|l\.l\.c\.|corp\.?|corporation|co\.|ltd\.?|plc|lp|l\.p\.)$", re.I)
# Some titles carry the page's own heading: "Internship - ATC Software Job Details / Alstom".
_TITLE_TAIL = re.compile(r"\s+Job Details\s*/.*$", re.I)


def _get(url: str, timeout: int = 30) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(2_000_000).decode("utf-8", errors="replace")


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _link(cell: str) -> tuple[str, str]:
    m = _LINK.search(cell)
    return (m.group(1).strip(), m.group(2).strip()) if m else (cell.replace("*", "").strip(), "")


def _posted(text: str, now: datetime) -> int:
    """'Oct 21' -> unix seconds. The table has no year: a date later than tomorrow is from last year."""
    m = re.match(r"([A-Za-z]{3})\w*\s+(\d{1,2})", text.strip())
    if not m or m.group(1).lower() not in _MONTHS:
        return 0
    try:
        day = datetime(now.year, _MONTHS[m.group(1).lower()], int(m.group(2)), 12, tzinfo=timezone.utc)
    except ValueError:
        return 0
    if (day - now).days >= 1:
        day = day.replace(year=now.year - 1)
    return int(day.timestamp())


def _strip_tracking(url: str) -> str:
    return url.split("?", 1)[0] if "jobright.ai/jobs/info/" in url else url


def parse(readme: str, field: str, now: datetime | None = None) -> list[dict]:
    """One README table -> rows in listings.py's shape. A '↳' company cell repeats the row above's company."""
    now = now or datetime.now(timezone.utc)
    rows: list[dict] = []
    company, company_url = "", ""
    for line in readme.splitlines():
        if not line.startswith("|"):
            continue
        cells = _cells(line)
        if len(cells) < 5 or cells[0] in ("Company", "") or set(cells[0]) <= set("-: "):
            continue
        if cells[0] != "↳":
            company, company_url = _link(cells[0])
            company = _SUFFIX.sub("", company).strip()
        title, url = _link(cells[1])
        title = _TITLE_TAIL.sub("", title).strip()
        if not (company and title and url) or not boards.INTERN.search(title):
            continue
        place = re.sub(r",\s*United States$", "", cells[2]).strip()
        remote = cells[3].lower() == "remote"
        posted = _posted(cells[4], now)
        rows.append({
            "id": url.rstrip("/").rsplit("/", 1)[-1].split("?")[0], "source": "jobright", "company": company,
            "title": title, "url": _strip_tracking(url),
            "locations": [p for p in (place, "Remote" if remote and "remote" not in place.lower() else "") if p],
            "terms": boards.terms_for(title, now), "degrees": [], "sponsorship": "Other", "category": field,
            "date_posted": posted, "date_updated": posted, "active": True, "company_url": company_url,
        })
    return rows


def fetch_jobright(now: datetime | None = None, fetch=_get) -> tuple[list[dict], list[str]]:
    """Every field's README. One failing never hides the others; its error is returned."""
    rows: list[dict] = []
    errors: list[str] = []
    seen: set[str] = set()
    for field in FIELDS:
        try:
            for row in parse(fetch(README.format(field=field)), field, now):
                if row["url"] not in seen:  # a posting can sit in two fields' lists
                    seen.add(row["url"])
                    rows.append(row)
        except Exception as exc:  # a 404 or a timeout on one list: report it, keep going
            errors.append(f"jobright: {field}: {exc}")
    return rows, errors
