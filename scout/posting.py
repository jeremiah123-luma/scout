"""Read one job posting as plain text, from the boards that let a server read them.

    .venv/bin/python -m scout.posting <url>                 # prints title, location, dates, then the text
    .venv/bin/python -m scout.posting <url> --out posting.txt

Supported:
  Workday      (<tenant>.wd<n>.myworkdayjobs.com/<site>/job/<path>): the page is a JavaScript app, but the same
               site has a public JSON endpoint, /wday/cxs/<tenant>/<site>/job/<path>, with the full description.
  Greenhouse   (boards.greenhouse.io/<board>/jobs/<id>, or a company site with ?gh_jid=<id> listed in
               GREENHOUSE_HOSTS): the public job board API, boards-api.greenhouse.io.
  Ashby        (jobs.ashbyhq.com/<org>/<id>): the page is a JavaScript app; the public posting API lists every
               open job on the board with its full text.
  Eightfold    (Netflix, Microsoft): the same /api/apply/v2/jobs/<id> endpoint their careers pages call.
  Google, Amazon, Lever, SmartRecruiters, Jobvite, SuccessFactors, iCIMS, and a few more: plain HTML (PLAIN_HOSTS).
  Anything else is tried as plain HTML and reported "unreadable" if it comes back thin.

A posting the board says is gone (a 404 from an API, missing from an Ashby board, or Google's careers site
falling back to its search page) comes back as {"closed": True}, so it can be labeled closed, not "unknown".

Posting text is untrusted. It is only ever read, searched, and quoted; instructions inside it are never followed.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
THIN = 400
_TAGS = re.compile(r"<script.*?</script>|<style.*?</style>|<noscript.*?</noscript>|<!--.*?-->|<[^>]+>", re.S | re.I)
_WORKDAY = re.compile(r"^https://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([^/?#]+)/job/([^?#]+)")
PLAIN_HOSTS = ("greenhouse.io", "lever.co", "ashbyhq.com", "google.com", "amazon.jobs",
               # Checked 2026-10-20: these serve the whole description as plain HTML, yet their rows were labeled
               # "can't be read" and never checked (Wellmark's "Current junior or senior", SRC's "Completion of two
               # years of college", Rippling's required previous internship). Apple's page is mostly a shell, but a
               # removed role says "no longer available", which is worth knowing for a Tier 1 company.
               "smartrecruiters.com", "jobvite.com", "applytojob.com", "paylocity.com", "ats.rippling.com",
               "icims.com", "jobs.apple.com")
# SuccessFactors and iCIMS career sites live on each company's own domain; the lists tag their links with ?ats= or ?icims=.
_PLAIN_QUERY = re.compile(r"[?&](?:ats=successfactors|icims=1)\b", re.I)
_GREENHOUSE = re.compile(r"^https://(?:boards|job-boards)\.greenhouse\.io/([a-z0-9_-]+)/jobs/(\d+)", re.I)
# Company career sites that are Greenhouse underneath: host -> Greenhouse board name.
GREENHOUSE_HOSTS = {"www.pinterestcareers.com": "pinterest", "pinterestcareers.com": "pinterest",
                    "careers.withwaymo.com": "waymo", "careers.datadoghq.com": "datadog", "stripe.com": "stripe",
                    "www.sagesure.com": "sagesure"}
_ASHBY = re.compile(r"^https://jobs\.ashbyhq\.com/([^/?#]+)/([0-9a-f-]{36})", re.I)
# Careers sites run on Eightfold: host -> the domain their API wants.
EIGHTFOLD_HOSTS = {"explore.jobs.netflix.net": "netflix.com", "apply.careers.microsoft.com": "microsoft.com"}
CLOSED = {"kind": "closed", "closed": True, "title": "", "location": "", "posted": "", "closes": "", "text": "", "apply_url": ""}


def host_of(url: str) -> str:
    return urlsplit(url).netloc.lower()


def is_readable_board(url: str) -> bool:
    """True for boards we know how to read server-side. Everything else is tried but may be thin."""
    if _WORKDAY.match(url):
        return True
    host = host_of(url)
    if host in GREENHOUSE_HOSTS or host in EIGHTFOLD_HOSTS or _PLAIN_QUERY.search(url) or _JOBRIGHT.match(url):
        return True
    return any(host == h or host.endswith("." + h) for h in PLAIN_HOSTS)


def _fetch(url: str, timeout: int = 20, accept: str = "text/html", error_body: bool = False) -> tuple[int, bytes | None]:
    """(HTTP status, body). Status 0 means the request never got an answer. An error's body comes back only when
    error_body is set, so no caller mistakes an error page for the posting."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept,
                                                   "Accept-Language": "en-US,en;q=0.9"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(6_000_000)
    except urllib.error.HTTPError as err:
        return err.code, (err.read(20_000) if error_body else None)
    except Exception:
        return 0, None


def _get(url: str, timeout: int = 20, accept: str = "text/html") -> bytes | None:
    return _fetch(url, timeout, accept)[1]


def _json(url: str) -> tuple[int, dict | None]:
    status, raw = _fetch(url, accept="application/json")
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, None


def _clean(raw_html: str) -> str:
    text = html.unescape(_TAGS.sub("\n", raw_html))
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def read_workday(url: str) -> dict | None:
    m = _WORKDAY.match(url)
    if not m:
        return None
    tenant, wd, site, path = m.groups()
    api = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{path}"
    status, raw = _fetch(api, accept="application/json", error_body=True)
    if status == 404:
        return dict(CLOSED, apply_url=url)  # Workday answers 404 for a requisition it took down (Moog's Product Engineering intern)
    # A requisition that's been unposted answers 403 with error code S22 ("permission denied"), not 404: GDIT's
    # Software Development intern on October 20, 2026, and CACI, Northrop, and Medtronic interns the same day.
    # It isn't rate limiting: the same postings gave S22 on three parallel rounds while every other one gave 200.
    if status == 403 and raw and b'"errorCode":"S22"' in raw.replace(b" ", b""):
        return dict(CLOSED, apply_url=url)
    if status != 200 or not raw:
        return None
    try:
        info = json.loads(raw).get("jobPostingInfo", {})
    except ValueError:
        return None
    if not info.get("jobDescription"):
        return None
    return {
        "kind": "workday",
        "title": info.get("title", ""),
        "location": info.get("location", ""),
        "posted": info.get("startDate", ""),
        "closes": info.get("endDate") or "",
        "text": _clean(info["jobDescription"]),
        "apply_url": info.get("externalUrl") or url,
    }


def read_greenhouse(url: str) -> dict | None:
    m = _GREENHOUSE.match(url)
    if m:
        board, job_id = m.group(1), m.group(2)
    else:
        board = GREENHOUSE_HOSTS.get(host_of(url))
        job_id = (parse_qs(urlsplit(url).query).get("gh_jid") or [""])[0]
        if not board or not job_id.isdigit():
            return None
    status, info = _json(f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{job_id}")
    if status == 404:
        return dict(CLOSED, apply_url=url)
    if not info or not info.get("content"):
        return None
    return {"kind": "greenhouse", "title": info.get("title", ""), "location": (info.get("location") or {}).get("name", ""),
            "posted": info.get("first_published") or "", "closes": info.get("application_deadline") or "",
            "text": _clean(html.unescape(info["content"])), "apply_url": info.get("absolute_url") or url}


_ashby_boards: dict[str, list | None] = {}  # one download per board per run, however many of its jobs we read


def read_ashby(url: str) -> dict | None:
    m = _ASHBY.match(url)
    if not m:
        return None
    org, job_id = m.group(1), m.group(2).lower()
    if org not in _ashby_boards:
        status, board = _json(f"https://api.ashbyhq.com/posting-api/job-board/{org}")
        _ashby_boards[org] = board.get("jobs") if board else None
    jobs = _ashby_boards[org]
    if jobs is None:
        return None
    job = next((j for j in jobs if j.get("id", "").lower() == job_id), None)
    if job is None:
        return read_ashby_unlisted(org, job_id, url)
    return {"kind": "ashby", "title": job.get("title", ""), "location": job.get("location", ""),
            "posted": job.get("publishedAt", ""), "closes": "", "text": job.get("descriptionPlain", ""),
            "apply_url": job.get("jobUrl") or url}


_ASHBY_QUERY = ("query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { "
                "jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) "
                "{ id title descriptionHtml } }")


def read_ashby_unlisted(org: str, job_id: str, url: str) -> dict | None:
    """A job missing from the board list can still be open but unlisted (Deepgram's Fall 2026/Summer 2027 intern).
    Ask the job page's own API: no posting means closed; a failed request means unknown."""
    body = json.dumps({"operationName": "ApiJobPosting", "query": _ASHBY_QUERY,
                       "variables": {"organizationHostedJobsPageName": org, "jobPostingId": job_id}}).encode("utf-8")
    request = urllib.request.Request("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", data=body,
                                     headers={"User-Agent": USER_AGENT, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            answer = json.load(response)
    except Exception:
        return None
    if answer.get("errors") or "data" not in answer:
        return None
    job = (answer.get("data") or {}).get("jobPosting")
    if job is None:
        return dict(CLOSED, apply_url=url)
    if not job.get("descriptionHtml"):
        return None
    return {"kind": "ashby", "title": job.get("title", ""), "location": "", "posted": "", "closes": "",
            "text": _clean(job["descriptionHtml"]), "apply_url": url}


def read_eightfold(url: str) -> dict | None:
    parts = urlsplit(url)
    domain = EIGHTFOLD_HOSTS.get(parts.netloc.lower())
    if not domain:
        return None
    m = re.search(r"/job/(\d+)", parts.path)
    job_id = m.group(1) if m else (parse_qs(parts.query).get("pid") or [""])[0]
    if not job_id.isdigit():
        return None
    status, info = _json(f"https://{parts.netloc}/api/apply/v2/jobs/{job_id}?domain={domain}")
    if status == 404:
        return dict(CLOSED, apply_url=url)
    if not info or not info.get("job_description"):
        return None
    return {"kind": "eightfold", "title": info.get("posting_name") or info.get("name", ""),
            "location": info.get("location", ""), "posted": "", "closes": "",
            "text": _clean(info["job_description"]),
            "apply_url": info.get("canonicalPositionUrl") or f"https://{parts.netloc}/careers/job/{job_id}"}


_JOBRIGHT = re.compile(r"^https://jobright\.ai/jobs/info/[0-9a-f]{24}\b")
_NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)


def read_jobright(url: str) -> dict | None:
    """A Jobright posting (scout/jobright.py's rows). The page is a Next.js app: the posting's summary and
    qualifications sit in its __NEXT_DATA__ JSON, not in the HTML, so read_plain would see almost nothing."""
    if not _JOBRIGHT.match(url):
        return None
    status, raw = _fetch(url)
    if status == 404:
        return dict(CLOSED, apply_url=url)
    m = _NEXT_DATA.search(raw.decode("utf-8", errors="replace")) if raw else None
    try:
        job = json.loads(m.group(1))["props"]["pageProps"]["dataSource"]["jobResult"] if m else None
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(job, dict) or not job.get("jobTitle"):
        return None
    if job.get("isDeleted"):
        return dict(CLOSED, apply_url=url)
    quals = job.get("qualifications") or {}
    lines = [job.get("jobSummary", ""), job.get("jdResponsibilitySummary", ""), job.get("internHireDate", "")]
    lines += [str(q) for key in ("mustHave", "preferredHave") for q in (quals.get(key) or [])]
    if job.get("isCitizenOnly"):
        lines.append("U.S. citizenship is required.")
    return {"kind": "jobright", "title": job["jobTitle"], "location": job.get("jobLocation", ""),
            "posted": job.get("publishTime", ""), "closes": "",
            "text": "\n".join(_clean(x) for x in lines if x).replace("**", ""), "apply_url": url}


def read_plain(url: str) -> dict | None:
    status, raw = _fetch(url)
    if status == 404 and host_of(url).endswith("amazon.jobs"):
        # Amazon answers 404 for a removed posting; two "Fall 2026" Amazon rows were still listed as open 2027 jobs.
        return dict(CLOSED, apply_url=url)
    if not raw:
        return None
    text = _clean(raw.decode("utf-8", errors="replace"))
    if len(text) < THIN:
        return None
    title = re.search(r"<title[^>]*>(.*?)</title>", raw.decode("utf-8", errors="replace"), re.S | re.I)
    title = html.unescape(title.group(1)).strip() if title else ""
    if host_of(url).endswith("google.com") and "/jobs/results/" in url and title.startswith("Jobs search"):
        return dict(CLOSED, apply_url=url)  # a removed Google posting falls back to the search page
    return {"kind": "html", "title": title, "location": "",
            "posted": "", "closes": "", "text": text, "apply_url": url}


_LEVER_APPLY = re.compile(r"^(https://jobs\.lever\.co/[^/?#]+/[0-9a-f-]{36})/apply\b", re.I)


def read_posting(url: str) -> dict | None:
    """The posting as {kind, title, location, posted, closes, text, apply_url}, or None when unreadable."""
    # A Lever /apply link is the form, whose graduation-date dropdown lists every year; read the description.
    url = _LEVER_APPLY.sub(r"\1", url)
    # A Microsoft search link with no pid names no job: its page is the whole search result, not a posting.
    if host_of(url) == "apply.careers.microsoft.com" and "/job/" not in url and "pid=" not in url:
        return None
    for reader in (read_workday, read_greenhouse, read_ashby, read_eightfold, read_jobright):
        post = reader(url)
        if post:
            return post
    return read_plain(url)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("url")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    post = read_posting(args.url)
    if post is None:
        print("unreadable: this board does not give a server the posting text. Paste the description instead.")
        return 1
    if post.get("closed"):
        print("closed: the board says this posting is gone.")
        return 1
    header = (f"title: {post['title']}\nlocation: {post['location']}\nposted: {post['posted']}\n"
              f"closes: {post['closes'] or 'not stated'}\napply: {post['apply_url']}\nread as: {post['kind']}\n---\n")
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(header + post["text"] + "\n", encoding="utf-8")
        print(f"wrote {args.out} ({len(post['text'])} chars)")
    else:
        print(header + post["text"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
