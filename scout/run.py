"""The entry point the cron calls. One command, four modes.

    .venv/bin/python -m scout.run --mode watch            # every hour: score, instant pushes, page watchers, and the digest once it is past 7:00 PM ET
    .venv/bin/python -m scout.run --mode digest           # the daily digest on its own (exits quietly before 7:00 PM ET)
    .venv/bin/python -m scout.run --mode test             # one test push to the phone
    .venv/bin/python -m scout.run --mode catchup          # once: one push of the big tech postings the first run seeded
    .venv/bin/python -m scout.run --mode watch --dry-run  # print what would be sent, send nothing, save nothing

NTFY_TOPIC must be set in the environment (a GitHub Actions secret in the cron, exported by hand locally).
Without it, every mode runs as a dry run.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from scout import alerts, listings, logos, matching, notify, pages, scoring, watch

ROOT = Path(__file__).resolve().parent.parent
DIGEST_HOUR_ET = 19  # 7:00 PM: the digest goes out on the first run at or after this hour, once a day
DIGEST_STATE = ROOT / "data" / "digest.json"
HEALTH_STATE = ROOT / "data" / "health.json"


class Sender:
    """Wraps Ntfy so a dry run prints instead of posting."""

    def __init__(self, topic: str | None, dry_run: bool):
        self.dry_run = dry_run or not topic
        self.ntfy = notify.Ntfy(topic) if topic else None
        self.sent = 0
        self.failed = 0

    def send(self, push: dict) -> bool:
        line = f"[{'DRY' if self.dry_run else 'PUSH'}] {push['title']}\n    " + push["message"].replace("\n", "\n    ")
        print(line)
        if self.dry_run:
            return True
        ok = self.ntfy.send(push["title"], push["message"], push.get("click"), push.get("priority", 3), push.get("tags"))
        self.sent += ok
        self.failed += (not ok)
        return ok


def score_everything(sender: Sender, now: float, allow_network: bool = True):
    targets = matching.load_targets()
    weights = scoring.load_weights()
    raw, errors = listings.fetch_all()
    for err in errors:
        print(f"SOURCE ERROR: {err}", file=sys.stderr)
        sender.send(notify.failure_push("source fetch", err))
    if not raw:
        return [], weights
    check_row_count(sender, sum(len(rows) for rows in raw.values()))
    # Every row the dashboard shows (write_matches keeps 300) gets its page read; verdicts are cached for 14 days.
    matches, counts = watch.run(raw, targets, weights, check_pages=300, allow_network=allow_network, now=now,
                                save=not sender.dry_run)
    # Logos only for the rows the dashboard shows (write_matches keeps the top 300), read once per company.
    logo_cache = logos.load()
    read = logos.attach(matches[:300], raw, logo_cache, allow_network=allow_network)
    if read:
        print(f"read {read} company page(s) for logos")
    if not sender.dry_run:
        logos.save(logo_cache)
        watch.write_matches(matches, counts)
    print(f"scored {len(matches)} matches " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return matches, weights


def check_row_count(sender: Sender, rows: int, path: Path = HEALTH_STATE) -> None:
    """A list that suddenly shrinks by half usually means its format changed, not that jobs vanished.
    The fetch still "works", so without this Scout would quietly alert on almost nothing."""
    try:
        last = json.loads(path.read_text(encoding="utf-8")).get("rows", 0)
    except (OSError, ValueError):
        last = 0
    if last and rows < last / 2:
        sender.send(notify.failure_push("source size check", f"The lists returned {rows} rows; the last run had {last}. "
                                        "A source may have changed shape."))
    if not sender.dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"rows": rows}), encoding="utf-8")


def mode_watch(sender: Sender, now: float, seed: bool = False) -> None:
    matches, weights = score_everything(sender, now)
    seen = alerts.load_seen()
    if seed:
        # First run only: everything that exists today counts as already seen, so the phone
        # gets alerts for what appears from now on, not a flood of a thousand old postings.
        fresh = [m for m in matches if alerts.is_new(m, seen)]
        alerts.mark_seen(seen, fresh, "seeded", now)
        print(f"seeded {len(fresh)} existing matches as seen; no pushes")
    else:
        instant = alerts.select_instant(matches, seen, weights)
        print(f"{len(instant)} instant alert(s)")
        sent = [m for m in instant if sender.send(notify.match_push(m, now))]
        alerts.mark_seen(seen, sent, "instant", now)

    page_list = pages.load_pages()
    state = pages.load_state()
    events = pages.check_pages(page_list, state, now=now, save=not sender.dry_run)
    for ev in events:
        print(f"page {ev['kind']}: {ev['name']}: {ev['summary'].splitlines()[0] if ev['summary'] else ''}")
        if ev["kind"] in ("changed", "unreadable", "thin"):
            sender.send(notify.page_push(ev))
    if not sender.dry_run:
        alerts.save_seen(seen)
        pages.save_state(state)

    # GitHub runs scheduled jobs late or skips them when it is busy, so the digest is not its own
    # schedule: every run checks whether it is due and sends it at most once per New York day.
    if digest_due(now):
        send_digest(sender, matches, weights, now)


def et_date(now: float) -> str:
    return datetime.fromtimestamp(now, notify.ET).strftime("%Y-%m-%d")


def digest_due(now: float, path: Path = DIGEST_STATE) -> bool:
    """True when it is 7:00 PM or later in New York and today's digest has not gone out."""
    if notify.et_hour(now) < DIGEST_HOUR_ET:
        return False
    try:
        last = json.loads(path.read_text(encoding="utf-8")).get("last_sent", "")
    except (OSError, ValueError):
        last = ""
    return last != et_date(now)


def send_digest(sender: Sender, matches: list, weights: dict, now: float, path: Path = DIGEST_STATE) -> None:
    seen = alerts.load_seen()
    chosen = alerts.select_digest(matches, seen, weights)
    sender.send(notify.digest_push(chosen, now))
    print(f"digest sent with {len(chosen)} match(es)")
    if not sender.dry_run:
        alerts.mark_seen(seen, chosen, "digest", now)
        alerts.save_seen(seen)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"last_sent": et_date(now)}), encoding="utf-8")


def mode_digest(sender: Sender, now: float, force: bool = False) -> None:
    """Send the digest by hand. Without --force it only goes out when it is due."""
    if not force and not digest_due(now):
        print("digest not due: it goes out once a day, on the first run after 7:00 PM in New York")
        return
    matches, weights = score_everything(sender, now, allow_network=False)
    send_digest(sender, matches, weights, now)


def on_data_branch() -> bool:
    """True in the cron, where data/ is a git worktree of the data branch."""
    return (ROOT / "data" / ".git").exists()


def mode_catchup(sender: Sender, now: float) -> None:
    """One push for what the first run's --seed swallowed: Tier 1 or 2 postings and freshman programs that are
    still on the lists and not ruled out by their page. Each one listed is marked via "catchup", so a second
    run only sends what did not fit the first time, and once everything has gone out it sends "nothing"."""
    # Only the cron's checkout of the data branch holds the real seen list. On the Mac, data/ is an old
    # gitignored copy, so a real send from here would repeat later when the workflow runs catch-up.
    if not sender.dry_run and not on_data_branch():
        print("catch-up sends only from the workflow (Actions > scout > Run workflow, mode catchup); "
              "data/ here is not the data branch. Add --dry-run to preview.")
        return
    matches, _ = score_everything(sender, now)
    seen = alerts.load_seen()
    chosen = alerts.select_catchup(matches, seen)
    push, listed = notify.catchup_push(chosen, now)
    print(f"catch-up: {len(chosen)} qualify, {len(listed)} in this push")
    if sender.send(push) and not sender.dry_run:
        alerts.mark_seen(seen, listed, "catchup", now)
        alerts.save_seen(seen)


def main() -> int:
    ap = argparse.ArgumentParser(description="Run Scout once.")
    ap.add_argument("--mode", choices=["watch", "digest", "test", "catchup"], required=True)
    ap.add_argument("--dry-run", action="store_true", help="print pushes, send nothing, save nothing")
    ap.add_argument("--force", action="store_true", help="digest: send even outside 7:00 PM ET")
    ap.add_argument("--seed", action="store_true", help="watch: mark everything current as seen, push nothing (first run)")
    args = ap.parse_args()

    topic = notify.topic_from_env()
    sender = Sender(topic, args.dry_run)
    if sender.dry_run:
        print("dry run" + ("" if topic else " (NTFY_TOPIC not set)"))
    now = time.time()

    if args.mode == "test":
        sender.send(notify.test_push())
    elif args.mode == "watch":
        mode_watch(sender, now, seed=args.seed)
    elif args.mode == "catchup":
        mode_catchup(sender, now)
    else:
        mode_digest(sender, now, args.force)

    if sender.failed:
        print(f"{sender.failed} push(es) failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
