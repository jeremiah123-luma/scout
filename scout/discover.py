"""Find company job boards in the lists' own links, and read a rotating batch of them every run.

The lists (Simplify, vanshb03) link thousands of postings on Greenhouse, Lever, Ashby, and SmartRecruiters. Each
link names the company's board: job-boards.greenhouse.io/<board>/jobs/<id>, jobs.lever.co/<board>/<id>, and so on.
Every one of those boards is public JSON (scout/boards.py reads them), and a board lists postings the lists have not
picked up yet: a company the lists already know often opens a second intern posting days before anyone adds it.

So every run:
  1. every list link (active or not, so the set only grows) is checked for a board, and new ones are added to
     data/boards.json with the company name the list used;
  2. the boards read longest ago are read, a batch big enough that each one comes around about every 8 runs
     (8 to 12 hours, since GitHub skips some hourly runs), 8 at a time, with a time budget;
  3. a board that answers 404 three reads in a row is dropped (kept in the file, so it is not found again).

The boards in targets.yaml are not part of this: boards.fetch_boards reads them every run.

A newly found board's open postings alert like any other. On October 21 a full rotation of 1,145 boards would have
pushed 8 postings (fellowships, mostly) spread over its 8 runs, and the first run pushed none, so no first-read
seeding was needed.

Board text is untrusted: titles and locations are stored and matched, never followed or executed.
"""

from __future__ import annotations

import json
import math
import re
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from scout import boards

ROOT = Path(__file__).resolve().parent.parent
STATE_PATH = ROOT / "data" / "boards.json"

ROTATION_RUNS = 8     # each board is read about once every 8 runs
MIN_BATCH = 25
MAX_BATCH = 400       # a ceiling, so a jump in boards found can never stretch one run past its time limit
WORKERS = 8           # a small pool: fast enough, and no board host sees more than a few requests at once
TIMEOUT = 20          # seconds per request
BUDGET = 150          # seconds for the whole batch; boards not reached in time stay first in line for next run
DROP_AFTER = 3        # 404s in a row before a board is dropped

# Host -> board kind. EU-hosted Greenhouse and Lever boards are left out: they sit behind other API hosts,
# and their postings are almost all outside the US, which Scout drops anyway.
_HOSTS = {
    "boards.greenhouse.io": "greenhouse",
    "job-boards.greenhouse.io": "greenhouse",
    "jobs.lever.co": "lever",
    "jobs.ashbyhq.com": "ashby",
    "jobs.smartrecruiters.com": "smartrecruiters",
    "careers.smartrecruiters.com": "smartrecruiters",
}
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$")
_NOT_BOARDS = {"embed", "jobs", "api", "v1", "apply", "share"}  # path words that are not a company's board name


def board_from_url(url: str) -> tuple[str, str] | None:
    """'https://job-boards.greenhouse.io/figma/jobs/123' -> ('greenhouse', 'figma'); anything else -> None.

    A company-site link with ?gh_jid= names the job but not the board, so it gives nothing."""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        return None
    kind = _HOSTS.get(parts.netloc.lower())
    segments = [unquote(s) for s in parts.path.split("/") if s]
    if not kind or not segments:
        return None
    slug = segments[0].strip()
    if not _SLUG.match(slug) or slug.lower() in _NOT_BOARDS:
        return None
    # Greenhouse board links always have /jobs/<id> after the board name; a bare page there is a search or embed.
    if kind == "greenhouse" and (len(segments) < 3 or segments[1] != "jobs"):
        return None
    return kind, slug


def _key(kind: str, slug: str) -> str:
    return f"{kind}:{slug.lower()}"  # board names are not case-sensitive (Ashby's "G2" is "g2")


def _stamp(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds")


def load(path: Path = STATE_PATH) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8")).get("boards", {})
    except (OSError, ValueError, AttributeError):
        return {}


def save(state: dict, path: Path = STATE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps({"boards": state}, indent=1, sort_keys=True), encoding="utf-8")


def discover(items: list[dict], state: dict, now: float, skip: set[str] = frozenset()) -> int:
    """Add every board the rows link to that is not in state yet. Returns how many were new.

    skip holds the targets.yaml boards ("greenhouse:figma"), which are read every run already."""
    added = 0
    for item in items:
        found = board_from_url(item.get("url", ""))
        if not found:
            continue
        kind, slug = found
        key = _key(kind, slug)
        if key in state or key in skip or not item.get("company"):
            continue
        state[key] = {"slug": slug, "kind": kind, "company": item["company"], "first_seen": _stamp(now),
                      "last_read": None, "last_count": None, "failures": 0}
        added += 1
    return added


def dropped(entry: dict) -> bool:
    return entry.get("failures", 0) >= DROP_AFTER


def batch_size(total: int) -> int:
    return max(MIN_BATCH, min(MAX_BATCH, math.ceil(total / ROTATION_RUNS)))


def pick_batch(state: dict, size: int | None = None) -> list[str]:
    """The boards read longest ago, never-read ones first. Dropped boards are skipped."""
    live = [k for k, e in state.items() if not dropped(e)]
    size = batch_size(len(live)) if size is None else size
    live.sort(key=lambda k: (state[k].get("last_read") or "", state[k].get("first_seen") or "", k))
    return live[:size]


def _fetch(url: str):
    return boards._get(url, timeout=TIMEOUT)


def _read_one(entry: dict, now: datetime, deadline: float, readers: dict, fetch):
    """(rows, error) for one board, or None when the time budget ran out before it started."""
    if time.monotonic() > deadline:
        return None
    try:
        # Quoted, since a few Ashby board names have spaces ("jobs.ashbyhq.com/Acme%20Careers/...").
        return readers[entry["kind"]](quote(entry["slug"], safe=""), entry["company"], now, fetch=fetch), None
    except Exception as exc:  # a 404, a timeout, bad JSON: recorded on this board, never raised
        return [], exc


def read_batch(state: dict, keys: list[str], now: float, readers: dict | None = None, fetch=_fetch,
               workers: int = WORKERS, budget: float = BUDGET) -> tuple[list[dict], list[str]]:
    """Read the chosen boards. Updates each board's entry in state; returns (rows, error lines)."""
    readers = readers or boards.READERS
    when = datetime.fromtimestamp(now, timezone.utc)
    deadline = time.monotonic() + budget
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda k: _read_one(state[k], when, deadline, readers, fetch), keys))
    rows: list[dict] = []
    errors: list[str] = []
    for key, result in zip(keys, results):
        if result is None:
            continue  # not reached: last_read stays old, so it is first in line next run
        found, exc = result
        entry = state[key]
        entry["last_read"] = _stamp(now)
        if exc is not None:
            # Only a 404 counts toward dropping. A timeout or a 500 says nothing about the board itself, and
            # counting those would let one bad hour on the runner drop hundreds of good boards.
            if isinstance(exc, urllib.error.HTTPError) and exc.code in (404, 410):
                entry["failures"] = entry.get("failures", 0) + 1
            errors.append(f"{entry['kind']} {entry['slug']}: {exc}")
            continue
        entry["last_count"], entry["failures"] = len(found), 0
        for row in found:
            # discovered: the age cutoff applies (matching.passes_filters); only hand-picked boards skip it.
            row["discovered"] = True
        rows.extend(found)
    return rows, errors


def summarize(errors: list[str], read: int) -> list[str]:
    """One line for the failure alert, and only when most of the batch failed.

    Some of a few hundred small boards fail every run (a board closed, a slow host), and that is not worth a push.
    Most of them failing at once means something on Scout's side broke (blocked, offline, an API changed)."""
    if not errors or len(errors) * 2 <= read:
        return []
    return [f"discovered boards: {len(errors)} of {read} failed, e.g. {errors[0]}"]


def run(list_items: list[dict], targets_boards: dict, now: float | None = None, save_state: bool = True,
        path: Path = STATE_PATH, **read_options) -> tuple[list[dict], list[str]]:
    """Discover, pick a batch, read it, save. Returns (board rows, errors worth alerting on)."""
    now = now if now is not None else time.time()
    state = load(path)
    skip = {_key(kind, slug) for kind, entries in (targets_boards or {}).items() for slug in (entries or {})}
    added = discover(list_items, state, now, skip)
    keys = pick_batch(state)
    started = time.monotonic()
    rows, errors = read_batch(state, keys, now, **read_options)
    live = sum(1 for e in state.values() if not dropped(e))
    print(f"discovered boards: {live} known ({added} new), read {len(keys)} in {time.monotonic() - started:.0f}s, "
          f"{len(rows)} intern rows, {len(errors)} failed")
    if save_state:
        save(state, path)
    return rows, summarize(errors, len(keys))
