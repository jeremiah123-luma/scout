"""Run the whole watcher once: fetch, normalize, dedupe, filter, score, write data/matches.json.

    .venv/bin/python -m scout.watch                       # live: fetch both lists
    .venv/bin/python -m scout.watch --top 30              # show more rows
    .venv/bin/python -m scout.watch --offline tests/fixtures   # use saved copies, no network
    .venv/bin/python -m scout.watch --no-pages            # skip the graduation-year page check

What it prints: the top matches with a one-line breakdown each, then the counts of what was
dropped and why. What it writes: data/matches.json (every listing that passed the filters, with
score and breakdown) and data/eligibility_cache.json. Alerting lives in scout/run.py.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from scout import eligibility, listings, matching, scoring
from scout.dedupe import dedupe

ROOT = Path(__file__).resolve().parent.parent
MATCHES_PATH = ROOT / "data" / "matches.json"


def run(raw_by_source: dict[str, list], targets: dict, weights: dict, *, check_pages: int = 40,
        allow_network: bool = True, now: float | None = None, save: bool = True) -> tuple[list[dict], Counter]:
    """The pipeline, with no I/O except the optional page checks. Returns (scored matches, drop counts).

    save=False (a dry run) still reads posting pages but keeps the eligibility cache in memory, so a dry run
    can never record a verdict that hides a later change to the page.
    """
    now = now if now is not None else time.time()
    counts: Counter = Counter()

    items = listings.normalize_all(raw_by_source)
    counts["rows"] = len(items)
    share_degrees(items)
    items = [matching.describe(x, targets) for x in items]

    kept: list[dict] = []
    for item in items:
        ok, reason = matching.passes_filters(item, max_age_days=targets.get("max_age_days"), now=now)
        if ok:
            kept.append(item)
        else:
            counts[f"dropped: {reason}"] += 1

    before = len(kept)
    kept = dedupe(kept)
    counts["dropped: duplicate"] = before - len(kept)

    for item in kept:
        scoring.score(item, weights, now)
    kept.sort(key=lambda x: (x["score"], x.get("date_posted", 0)), reverse=True)

    # Read the posting page for the top rows, plus every row that could push on its own (Tier 1 or 2,
    # a freshman program, an ambassador program) wherever it ranks, so no alert goes out unchecked.
    #
    # "Top rows" means the rows that will be shown, counted after the sort below moves ruled-out rows to the bottom.
    # Counting by score rank instead let every ineligible or closed row among the first 300 pull an unchecked row up
    # into view: on October 20, 70 of the 300 cards on the New page were never read (Workday's "graduation between
    # December 2027 and June 2028" interns among them).
    cache = eligibility.load_cache()
    profile = eligibility_profile(targets)
    shown = 0
    for item in kept:
        if shown < check_pages or could_push(item) or on_board(item):
            eligibility.check(item, profile, cache, allow_network)
        else:
            item["eligibility"], item["eligibility_note"] = "unknown", "not checked (below top rows)"
        if item.get("eligibility") not in ("ineligible", "closed"):
            shown += 1
    if allow_network and save:
        eligibility.save_cache(cache)
    # A posting the page itself rules out (wrong graduation year, upperclassmen only, taken down) drops to the
    # bottom. It is kept and labeled, never hidden, but it should not outrank something you can apply to.
    kept.sort(key=lambda x: (x.get("eligibility") not in ("ineligible", "closed"), x["score"], x.get("date_posted", 0)), reverse=True)
    counts["kept"] = len(kept)
    return kept, counts


def eligibility_profile(targets: dict) -> dict:
    """Who the page check judges for. Only graduation_year is required; the rest have defaults in
    eligibility.verdict_from_facts (a bachelor's student, enrolled, no past internship, year worked out from the
    graduation year). Each comes from targets.yaml today and from the sign-up questions later."""
    keys = ("graduation_year", "year_in_school", "degree", "enrolled", "past_internship", "cycle_year")
    profile = {k: targets[k] for k in keys if targets.get(k) is not None}
    profile.setdefault("graduation_year", 2030)
    return profile


def share_degrees(items: list[dict]) -> None:
    """The community list records no degrees, so a PhD-only posting it carries would pass the graduate filter
    even though Simplify's copy of the same posting says PhD. Rows with no degrees borrow them from another
    row with the same link, or the same company and title. (Sony's AI Ethics intern came through this way.)"""
    from scout.dedupe import normalize_url
    by_url, by_name = {}, {}
    for x in items:
        if x.get("degrees"):
            by_url.setdefault(normalize_url(x.get("url", "")), x["degrees"])
            by_name.setdefault((x.get("company", "").lower(), x.get("title", "").lower()), x["degrees"])
    for x in items:
        if not x.get("degrees"):
            found = by_url.get(normalize_url(x.get("url", ""))) or by_name.get((x.get("company", "").lower(), x.get("title", "").lower()))
            if found:
                x["degrees"] = list(found)


def on_board(item: dict) -> bool:
    """Postings on Lever, Greenhouse, or Ashby are read through cheap public APIs and cached, and that is where
    rules like "must be planning on graduating in 2028" live, so every one of them gets checked."""
    url = item.get("url", "").lower()
    return any(h in url for h in ("lever.co/", "greenhouse.io/", "ashbyhq.com/", "gh_jid="))


def could_push(item: dict) -> bool:
    """Rows that alert without waiting for the digest (see alerts.is_instant)."""
    return item.get("tier", 3) <= 2 or item.get("early_career") == "strong" or item.get("role") == "ambassador"


def age_text(date_posted: int, now: float) -> str:
    days = int((now - date_posted) // 86400) if date_posted else None
    if days is None:
        return "?"
    return "today" if days == 0 else f"{days}d"


def print_table(matches: list[dict], top: int, now: float) -> None:
    print(f"\nTop {min(top, len(matches))} of {len(matches)} matches\n")
    for i, m in enumerate(matches[:top], 1):
        loc = ", ".join(m.get("locations", [])[:2]) or "?"
        if len(m.get("locations", [])) > 2:
            loc += f" (+{len(m['locations']) - 2})"
        elig = m.get("eligibility", "unknown")
        flag = {"ok": "eligible", "ineligible": "INELIGIBLE", "closed": "CLOSED", "unknown": "unknown"}[elig]
        print(f"{i:>2}. [{m['score']:>3}] {m['company']}  |  {m['title']}")
        print(f"      {loc}  |  posted {age_text(m.get('date_posted', 0), now)}  |  {flag}: {m.get('eligibility_note', '')}")
        print(f"      {scoring.explain(m)}")
        print(f"      {m['url']}")


RULED_OUT_EXTRA = 100  # postings ruled out for the owner that still go up, for students they may fit


def write_matches(matches: list[dict], counts: Counter, path: Path = MATCHES_PATH, limit: int = 300,
                  extra: int = RULED_OUT_EXTRA) -> None:
    """Write the top `limit` open matches, plus up to `extra` of the best ones the owner's own page check ruled out.

    The dashboard shares this list with every student, and "ruled out" here means ruled out for the owner: a
    posting that wants 2028 graduates is wrong for a 2030 graduate and exactly right for a junior. Those rows carry
    their page facts, so each student's own verdict decides (worker/src/match.js). The owner's pages still treat
    them as ruled out. Kept small on purpose: the cron commits this file every run."""
    path.parent.mkdir(parents=True, exist_ok=True)
    ruled = lambda m: m.get("eligibility") in ("ineligible", "closed")
    shared = [m for m in matches if not ruled(m)][:limit]
    shared += [m for m in matches if ruled(m) and m.get("eligibility") != "closed" and m.get("posting_facts")][:extra]
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "counts": dict(counts),
        "total_matches": len(matches),
        "open_total": sum(1 for m in matches if not ruled(m)),
        "matches": shared,
    }
    path.write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the Scout watcher once.")
    ap.add_argument("--top", type=int, default=20, help="rows to print (default 20)")
    ap.add_argument("--offline", type=Path, default=None, help="folder with saved simplify.json and vanshb03.json")
    ap.add_argument("--no-pages", action="store_true", help="skip fetching posting pages for the graduation check")
    ap.add_argument("--check-pages", type=int, default=40, help="how many top rows to page-check (default 40)")
    ap.add_argument("--out", type=Path, default=MATCHES_PATH)
    args = ap.parse_args()

    targets = matching.load_targets()
    weights = scoring.load_weights()

    if args.offline:
        raw = {name: listings.load_json(args.offline / f"{name}.json") for name in listings.SOURCES
               if (args.offline / f"{name}.json").exists()}
        errors: list[str] = []
    else:
        raw, errors = listings.fetch_all()
    for err in errors:
        print(f"SOURCE ERROR: {err}", file=sys.stderr)
    if not raw:
        print("No source could be fetched. Nothing to do.", file=sys.stderr)
        return 2

    now = time.time()
    matches, counts = run(raw, targets, weights, check_pages=args.check_pages,
                          allow_network=not (args.no_pages or args.offline), now=now)
    print_table(matches, args.top, now)
    print("\nCounts:")
    for k, v in sorted(counts.items()):
        print(f"  {k}: {v}")
    write_matches(matches, counts, args.out)
    print(f"\nWrote {args.out}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
