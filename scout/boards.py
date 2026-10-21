"""Read target companies' own job boards, for internships the public lists never carry.

The Simplify and vanshb03 lists are built around software engineering, so a posting like Figma's
"Product Design Intern (2027)" never reaches them. Greenhouse, Ashby, Lever, and SmartRecruiters publish
every company's open jobs as public JSON, with no login, so Scout reads the boards named in config/targets.yaml
(boards:), plus the boards scout/discover.py finds in the lists' own links, and keeps only internship, co-op,
and fellowship titles (Anthropic has no internships, only a Fellows Program).

Each kept job becomes a row in the same shape listings.py produces, with source "boards". The URL is the
one the lists use for the same posting (boards.greenhouse.io/<board>/jobs/<id>, or the company's own
careers link), so dedupe.py merges a posting both carry, and the list's row (its title, its key) wins.

Board text is untrusted: titles and locations are stored and matched, never followed or executed.
"""

from __future__ import annotations

import json
import re
import urllib.request
from datetime import datetime, timezone

USER_AGENT = "scout-internship-watcher/0.1 (personal project; reads public job boards only)"
INTERN = re.compile(r"\b(intern|interns|internship|co-?op|fellow|fellows|fellowship)\b", re.I)
_YEAR = re.compile(r"\b(20[2-3][0-9])\b")
_SEASON = re.compile(r"\b(summer|fall|winter|spring)\b", re.I)


def _get(url: str, timeout: int = 30):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def cycle_year(now: datetime | None = None) -> int:
    """Internships recruit about a year ahead: from July on, an unlabeled posting is for next summer."""
    now = now or datetime.now(timezone.utc)
    return now.year + 1 if now.month >= 7 else now.year


def terms_for(title: str, now: datetime | None = None) -> list[str]:
    """'Product Design Intern (2027)' -> ['2027']; 'Data Analyst, Intern' -> ['Summer 2027 (year not stated)']."""
    years = sorted(set(_YEAR.findall(title)))
    season = _SEASON.search(title)
    if years:
        return [f"{season.group(1).title()} {y}" if season else y for y in years]
    return [f"{season.group(1).title() if season else 'Summer'} {cycle_year(now)} (year not stated)"]


def _split_places(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\s*[;•|]\s*", text or "") if p.strip()]


def _row(company: str, board: str, job_id: str, title: str, url: str, places: list[str], posted: int,
         now: datetime | None) -> dict:
    return {"id": f"{board}:{job_id}", "source": "boards", "company": company, "title": title.strip(), "url": url,
            "locations": places, "terms": terms_for(title, now), "degrees": [], "sponsorship": "Other",
            "category": None, "date_posted": posted, "date_updated": posted, "active": True}


def _iso_seconds(text: str) -> int:
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp())
    except (AttributeError, ValueError):
        return 0


def greenhouse(board: str, company: str, now: datetime | None = None, fetch=_get) -> list[dict]:
    rows = []
    for job in fetch(f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs").get("jobs", []):
        if not INTERN.search(job.get("title", "")):
            continue
        absolute = job.get("absolute_url", "")
        # Lists link greenhouse-hosted jobs without the ?gh_jid echo, and company-hosted ones with it.
        url = (f"https://boards.greenhouse.io/{board}/jobs/{job['id']}" if "greenhouse.io" in absolute else absolute)
        posted = _iso_seconds(job.get("first_published") or job.get("updated_at") or "")
        rows.append(_row(company, board, str(job["id"]), job["title"], url,
                         _split_places((job.get("location") or {}).get("name", "")), posted, now))
    return rows


def ashby(org: str, company: str, now: datetime | None = None, fetch=_get) -> list[dict]:
    rows = []
    for job in fetch(f"https://api.ashbyhq.com/posting-api/job-board/{org}").get("jobs", []):
        if not INTERN.search(job.get("title", "")) or job.get("isListed") is False:
            continue
        places = [job.get("location", "")] + [s.get("location", "") for s in job.get("secondaryLocations") or []]
        rows.append(_row(company, org, job["id"], job["title"], f"https://jobs.ashbyhq.com/{org}/{job['id']}",
                         [p for p in places if p], _iso_seconds(job.get("publishedAt", "")), now))
    return rows


def lever(org: str, company: str, now: datetime | None = None, fetch=_get) -> list[dict]:
    rows = []
    for job in fetch(f"https://api.lever.co/v0/postings/{org}?mode=json"):
        if not INTERN.search(job.get("text", "")):
            continue
        categories = job.get("categories") or {}
        places = categories.get("allLocations") or [categories.get("location", "")]
        rows.append(_row(company, org, job["id"], job["text"], job.get("hostedUrl", ""),
                         [p for p in places if p], int(job.get("createdAt") or 0) // 1000, now))
    return rows


SMARTRECRUITERS_PAGE = 100  # the API's largest page
SMARTRECRUITERS_MAX_PAGES = 10  # Bosch alone has 5,000 postings worldwide; 1,000 US ones is plenty to scan


def _sr_places(location: dict) -> list[str]:
    """{'city': 'Plymouth', 'region': 'MI', 'remote': True} -> ['Plymouth, MI', 'Remote']."""
    place = ", ".join(p for p in (location.get("city"), location.get("region")) if p)
    return [p for p in (place, "Remote" if location.get("remote") else "") if p]


def smartrecruiters(company_id: str, company: str, now: datetime | None = None, fetch=_get) -> list[dict]:
    """SmartRecruiters' public postings API, one page of 100 at a time.

    Only US postings are asked for (country=us): Scout drops postings outside the US anyway, and it cuts
    Bosch from 52 pages to 4. The URL is the jobs.smartrecruiters.com/<Company>/<id> form the lists use,
    so dedupe.py merges a posting both carry."""
    rows = []
    for page in range(SMARTRECRUITERS_MAX_PAGES):
        offset = page * SMARTRECRUITERS_PAGE
        answer = fetch(f"https://api.smartrecruiters.com/v1/companies/{company_id}/postings"
                       f"?country=us&limit={SMARTRECRUITERS_PAGE}&offset={offset}")
        postings = answer.get("content") or []
        for job in postings:
            title = job.get("name") or ""
            if not INTERN.search(title):
                continue
            rows.append(_row(company, company_id, str(job["id"]), title,
                             f"https://jobs.smartrecruiters.com/{company_id}/{job['id']}",
                             _sr_places(job.get("location") or {}), _iso_seconds(job.get("releasedDate", "")), now))
        if len(postings) < SMARTRECRUITERS_PAGE or offset + len(postings) >= int(answer.get("totalFound") or 0):
            break
    return rows


READERS = {"greenhouse": greenhouse, "ashby": ashby, "lever": lever, "smartrecruiters": smartrecruiters}


def fetch_boards(config: dict, now: datetime | None = None) -> tuple[list[dict], list[str]]:
    """All boards in targets.yaml. One board failing never hides the others; its error is returned."""
    rows: list[dict] = []
    errors: list[str] = []
    for kind, boards in (config or {}).items():
        reader = READERS.get(kind)
        if reader is None:
            errors.append(f"boards: unknown board type {kind!r}")
            continue
        for board, company in (boards or {}).items():
            try:
                rows.extend(reader(board, company, now))
            except Exception as exc:  # a 404 or a timeout on one board: report it, keep going
                errors.append(f"boards: {kind} {board}: {exc}")
    return rows, errors
