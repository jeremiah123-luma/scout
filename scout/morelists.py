"""Read two more public internship lists: SpeedyApply and Zapply.

speedyapply  github.com/speedyapply/2027-SWE-College-Jobs and 2027-AI-College-Jobs. One README per list,
             with the USA internships in HTML-link tables (FAANG+, Quant, Other). Links go straight to the
             company's own posting, and each row has an age ("5d").
zapply       github.com/zapplyjobs/Internships-2027. One README with a table per field, postings from the
             last two weeks, updated every 10 minutes. Each link is a zapply.jobs redirect to the company's
             posting; Scout follows it once (one 301 and one 302, no page read) and caches the answer in
             data/zapply_links.json, so a link is resolved one time ever. A row whose link is not resolved
             yet waits for the next run instead of reaching the queue with a link no one can read.

README text is untrusted: titles and places are stored and matched, never followed or executed. The only
link followed is a zapply.jobs redirect, and only its Location header is read.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from scout import boards, jobright

SPEEDY = ("https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/README.md",
          "https://raw.githubusercontent.com/speedyapply/2027-AI-College-Jobs/main/README.md")
ZAPPLY = "https://raw.githubusercontent.com/zapplyjobs/Internships-2027/main/README.md"
LINKS_PATH = Path(__file__).resolve().parent.parent / "data" / "zapply_links.json"
USER_AGENT = jobright.USER_AGENT
RESOLVE_WORKERS = 8
RESOLVE_BUDGET = 60   # seconds per run; links not reached wait for the next run

_HREF = re.compile(r'<a href="([^"]+)"')
_TAG = re.compile(r"<[^>]+>")
_MD_LINK = re.compile(r"\]\((https?://[^)\s]+)\)")
_AGE = re.compile(r"^\s*(\d+)\s*(h|d|w|mo|m|y)\b", re.I)
_ZAPPLY_LINK = re.compile(r"^https://zapply\.jobs/l/")
_UNIT = {"m": 1 / 1440, "h": 1 / 24, "d": 1, "w": 7, "mo": 30, "y": 365}  # Zapply's "14m" is minutes


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _posted(age: str, now: float) -> int:
    """'5d' -> unix seconds five days ago. An age it can't read gives 0 (undated)."""
    m = _AGE.match(age or "")
    if not m:
        return 0
    return int(now - int(m.group(1)) * _UNIT[m.group(2).lower()] * 86400)


def _row(source: str, company: str, title: str, url: str, place: str, posted: int, category: str | None,
         sponsorship: str = "Other") -> dict:
    company = jobright._SUFFIX.sub("", company).strip()
    places = [p.strip() for p in re.split(r"\s*;\s*|\s+\+\d+$", place) if p.strip()]
    return {"id": url.rstrip("/").rsplit("/", 1)[-1].split("?")[0], "source": source, "company": company,
            "title": title, "url": url, "locations": places, "terms": boards.terms_for(title),
            "degrees": [], "sponsorship": sponsorship, "category": category,
            "date_posted": posted, "date_updated": posted, "active": True}


def parse_speedy(readme: str, now: float | None = None) -> list[dict]:
    """USA internship tables only: rows after '## 2027 USA ... Internships' and before the next '## ' heading."""
    now = now if now is not None else time.time()
    rows, inside = [], False
    for line in readme.splitlines():
        if line.startswith("## "):
            inside = "usa" in line.lower() and "intern" in line.lower()
            continue
        if not inside or not line.startswith("| <"):
            continue
        cells = _cells(line)
        if len(cells) < 5:
            continue
        # FAANG+ and Quant tables have a Salary column, Other does not: the apply link is the cell with the
        # Apply button, and the age is always the last cell.
        company = _TAG.sub("", cells[0]).strip()
        title = _TAG.sub("", cells[1]).strip()
        link = next((_HREF.search(c) for c in cells[3:] if 'alt="Apply"' in c), None)
        if not (company and title and link) or not boards.INTERN.search(title):
            continue
        rows.append(_row("speedyapply", company, title, link.group(1), _TAG.sub("", cells[2]),
                         _posted(cells[-1], now), None))
    return rows


def parse_zapply(readme: str, now: float | None = None) -> list[dict]:
    """Every field's table. Columns: Company | Role | Location | Posted | Visa | Apply."""
    now = now if now is not None else time.time()
    rows, field = [], None
    for line in readme.splitlines():
        heading = re.search(r"<summary><h3>.*?<strong>([^<]+)</strong>", line)
        if heading:
            field = heading.group(1).strip()
            continue
        if not line.startswith("| **"):
            continue
        cells = _cells(line)
        link = _MD_LINK.search(cells[-1]) if len(cells) >= 6 else None
        company, title = cells[0].replace("*", "").strip(), cells[1].strip() if len(cells) > 1 else ""
        if not (link and company and title) or not boards.INTERN.search(title):
            continue
        sponsorship = "Offers Sponsorship" if "sponsor" in cells[4].lower() else "Other"
        rows.append(_row("zapply", company, title, link.group(1).split("?")[0], cells[2],
                         _posted(cells[3], now), field, sponsorship))
    return rows


def _get(url: str, timeout: int = 30) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(3_000_000).decode("utf-8", errors="replace")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def resolve(url: str, hops: int = 3, timeout: int = 15) -> str | None:
    """Follow zapply.jobs redirects (Location headers only, nothing else read) to the first link off zapply.jobs."""
    for _ in range(hops):
        try:
            _OPENER.open(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=timeout)
            return None  # a 200 from zapply itself: no company link to take
        except urllib.error.HTTPError as exc:
            location = exc.headers.get("Location") if 300 <= exc.code < 400 else None
            if not location:
                return None
            url = urllib.parse.urljoin(url, location)
            if not _ZAPPLY_LINK.match(url):
                return url
        except Exception:
            return None
    return None


def load_links(path: Path = LINKS_PATH) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def attach_links(rows: list[dict], cache: dict, resolver=resolve, budget: float = RESOLVE_BUDGET) -> list[dict]:
    """Swap each zapply link for the company link; rows not resolved yet are left out this run."""
    todo = [r["url"] for r in rows if r["url"] not in cache]
    deadline = time.monotonic() + budget

    def one(url):
        return url, (resolver(url) if time.monotonic() < deadline else False)

    with ThreadPoolExecutor(RESOLVE_WORKERS) as pool:
        for url, target in pool.map(one, dict.fromkeys(todo)):
            if target is not False:   # False = budget ran out, try next run; None = no company link, remember
                cache[url] = target
    out = []
    for r in rows:
        target = cache.get(r["url"])
        if target:
            out.append({**r, "url": target, "id": target.rstrip("/").rsplit("/", 1)[-1].split("?")[0]})
    return out


def fetch_more(now: float | None = None, fetch=_get, resolver=resolve, save: bool = True,
               links_path: Path = LINKS_PATH) -> tuple[dict[str, list], list[str]]:
    """{'speedyapply': rows, 'zapply': rows}, errors. One list failing never hides the other."""
    raw: dict[str, list] = {"speedyapply": [], "zapply": []}
    errors: list[str] = []
    seen: set[str] = set()
    for url in SPEEDY:
        try:
            for row in parse_speedy(fetch(url), now):
                if row["url"] not in seen:
                    seen.add(row["url"])
                    raw["speedyapply"].append(row)
        except Exception as exc:
            errors.append(f"speedyapply: {url.split('/')[4]}: {exc}")
    try:
        cache = load_links(links_path)
        raw["zapply"] = attach_links(parse_zapply(fetch(ZAPPLY), now), cache, resolver)
        if save:
            links_path.write_text(json.dumps(cache, indent=0, sort_keys=True), encoding="utf-8")
    except Exception as exc:
        errors.append(f"zapply: {exc}")
    return raw, errors
