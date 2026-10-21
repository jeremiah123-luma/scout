"""One stable key per posting, so the same job never alerts twice.

The slug and key functions are adapted from MadsLorentzen/ai-job-search, tools/job_key.py
(MIT License, Copyright (c) 2025 Mads Lorentzen). See THIRD_PARTY_NOTICES.md.
The original solved two real problems: keys with "/" or "," in them broke folder names,
and the same job stored twice because two runs truncated a long title differently.
Scout keeps the fix (length-capped slugs plus a short hash of the full slug) and drops the
non-Latin-script handling, which our sources do not need.

Scout also dedupes on the posting URL first, because both source lists carry one.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

COMPANY_MAX = 40
TITLE_MAX = 60
HASH_LEN = 6

_NON_SLUG = re.compile(r"[^a-z0-9]+")
_TRACKING_PARAMS = ("utm_", "ref", "source", "gh_src", "lever-source", "src")


def slugify(text: str) -> str:
    """Lowercase ASCII slug: 'Software Engineer (Intern), Summer' -> 'software-engineer-intern-summer'."""
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFKD", str(text))
    ascii_only = decomposed.encode("ascii", "ignore").decode("ascii")
    return _NON_SLUG.sub("-", ascii_only.lower()).strip("-")


def _cap(slug: str, limit: int) -> str:
    """Cap length without making truncation lossy: append a hash of the full slug."""
    if len(slug) <= limit:
        return slug
    digest = hashlib.sha1(slug.encode("utf-8")).hexdigest()[:HASH_LEN]
    return f"{slug[:limit].rstrip('-')}-{digest}"


def make_key(company: str, title: str) -> str:
    """'Google LLC' + 'Software Engineering Intern, Summer 2027' -> 'google-llc_software-engineering-intern-summer-2027'."""
    company_slug = _cap(slugify(company), COMPANY_MAX) or "unknown-company"
    title_slug = _cap(slugify(title), TITLE_MAX) or "untitled"
    return f"{company_slug}_{title_slug}"


def normalize_url(url: str) -> str:
    """Strip tracking parameters, fragments, and trailing slashes so two links to one posting compare equal."""
    if not url:
        return ""
    parts = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith(_TRACKING_PARAMS)]
    path = parts.path.rstrip("/")
    if parts.netloc.lower() == "jobs.ashbyhq.com" and path.endswith("/application"):
        path = path[: -len("/application")]  # the apply form and the posting are one job
        query = [(k, v) for k, v in query if k.lower() != "embed"]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, urlencode(query), ""))


_WORKDAY_JOB = re.compile(r"^https?://([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com/.*_([a-z]*-?[0-9][a-z0-9-]*?)(?:-\d)?/?(?:[?#].*)?$", re.I)


# Board links that name one job by its id. The lists write the same job several ways: Greenhouse under
# boards.greenhouse.io, job-boards.greenhouse.io, or a company page with ?gh_jid=; Lever with and without "/apply".
_BOARD_JOBS = (
    ("greenhouse", re.compile(r"^https?://(?:job-)?boards(?:\.eu)?\.greenhouse\.io/[^/?#]+/jobs/(\d+)", re.I)),
    ("greenhouse", re.compile(r"[?&]gh_jid=(\d+)", re.I)),
    ("lever", re.compile(r"^https?://jobs(?:\.eu)?\.lever\.co/[^/?#]+/([0-9a-f-]{36})", re.I)),
    ("ashby", re.compile(r"^https?://jobs\.ashbyhq\.com/[^/?#]+/([0-9a-f-]{36})", re.I)),
    ("smartrecruiters", re.compile(r"^https?://(?:jobs|careers)\.smartrecruiters\.com/([^/?#]+/\d+)", re.I)),
)


def posting_id(url: str) -> str:
    """'workday:<tenant>:<requisition>' for a Workday link, '<board>:<job id>' for a Greenhouse, Lever, Ashby,
    or SmartRecruiters link, else ''.

    Workday serves one requisition under several links: with and without "/en-US/", under two career sites
    (Salesforce's External_Career_Site and Futureforce_Internships), with "-1" and "-2" suffixes (Kensho and S&P Global
    share the spgi tenant), and with different letter case (Booz Allen). The lists carry each link as its own row,
    often under a different title or company name, so five postings showed up twice on the New page. The board ids
    let a company board's copy of a posting merge with the lists' copy whichever link form each one uses."""
    m = _WORKDAY_JOB.match((url or "").strip())
    if m:
        return f"workday:{m.group(1).lower()}:{m.group(2).upper()}"
    for board, pattern in _BOARD_JOBS:
        m = pattern.search((url or "").strip())
        if m:
            return f"{board}:{m.group(1).lower()}"
    return ""


SOURCE_RANK = {"boards": 1, "jobright": 0}  # anything else is one of the lists: 2
_LOOSE_NOISE = re.compile(r"^(20[2-3][0-9]|summer|fall|winter|spring|intern|interns|internship|internships|start|s)$")


def loose_key(company: str, title: str) -> str:
    """Company plus the title's words in any order, minus years, seasons, and "intern". Jobright reorders
    titles: its "Software Engineer Intern (Media Engine) - 2027 Summer" is the lists' "Software Engineer
    Intern - Media Engine". Used only to match Jobright rows, so the lists' own keys never change."""
    words = {w for w in slugify(title).split("-") if w and not _LOOSE_NOISE.match(w)}
    return f"{slugify(company)}_{'-'.join(sorted(words))}"


def dedupe(listings: list[dict]) -> list[dict]:
    """Keep one listing per posting. Prefer the one updated most recently.

    Two listings are the same posting when their normalized URLs match, their Workday requisition matches,
    or their company+title key matches. The survivor records every source it was seen in.
    """
    by_url: dict[str, dict] = {}
    by_id: dict[str, dict] = {}
    by_key: dict[str, dict] = {}
    by_loose: dict[str, dict] = {}
    survivors: list[dict] = []

    # The lists' row wins over a company board's copy of the same posting, so its title and key stay the
    # ones already in seen.json (a board title like "Software Engineer Intern (Summer 2027)" would re-alert).
    # A Jobright row loses to both: its link is Jobright's page, and the others link the company's own.
    for item in sorted(listings, key=lambda x: (SOURCE_RANK.get(x.get("source"), 2), x.get("date_updated") or 0), reverse=True):
        url = normalize_url(item.get("url", ""))
        key = make_key(item.get("company", ""), item.get("title", ""))
        item["key"] = key
        pid = posting_id(item.get("url", ""))
        loose = loose_key(item.get("company", ""), item.get("title", ""))
        existing = (by_url.get(url) if url else None) or (by_id.get(pid) if pid else None) or by_key.get(key)
        if existing is None and item.get("source") == "jobright":
            existing = by_loose.get(loose)
        if existing is not None:
            sources = existing.setdefault("sources", [existing.get("source")])
            if item.get("source") not in sources:
                sources.append(item.get("source"))
            # Remember every URL and the newest post date, so a repost under the same title can still alert.
            if url and url not in existing["urls"]:
                existing["urls"].append(url)
            existing["latest_posted"] = max(existing["latest_posted"], item.get("date_posted") or 0)
            continue
        item.setdefault("sources", [item.get("source")])
        item["urls"] = [url] if url else []
        item["latest_posted"] = item.get("date_posted") or 0
        if url:
            by_url[url] = item
        if pid:
            by_id[pid] = item
        by_key[key] = item
        by_loose.setdefault(loose, item)
        survivors.append(item)
    return survivors
