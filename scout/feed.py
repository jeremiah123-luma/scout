"""The "Let's Add to Your Resume" feed: hackathons daily, certifications weekly, pushed to the dashboard.

    .venv/bin/python -m scout.feed                 # refresh whatever is due, then push
    .venv/bin/python -m scout.feed --force         # refresh everything now
    .venv/bin/python -m scout.feed --offline       # no network: just rewrite from the last good copy
    .venv/bin/python -m scout.feed --no-push       # write data/resume_feed.json only

The cron calls this inside its hourly run (a "due" check, like the digest, because GitHub skips schedules). A source
that fails keeps its last good data and says so in its status. Needs the same two settings as scout.sync. Without
them it writes the file and skips the push, so it can never break the cron.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

from scout import certs, hackathons, sync

ROOT = Path(__file__).resolve().parent.parent
FEED_PATH = ROOT / "data" / "resume_feed.json"
HACK_EVERY = 20 * 3600      # about a day
CERT_EVERY = 6.5 * 86400    # about a week


def _load(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def _yaml(name: str) -> dict:
    return yaml.safe_load((ROOT / "config" / name).read_text(encoding="utf-8")) or {}


def due(feed: dict, section: str, every: float, now: float) -> bool:
    return now - float((feed.get(section) or {}).get("fetched_at", 0)) >= every


def refresh(feed: dict, now: float, *, force: bool = False, offline: bool = False,
            hack_config: dict | None = None, cert_config: dict | None = None, fetch=None) -> dict:
    """The feed with whichever sections are due refreshed. A section whose sources all failed is left as it was."""
    stamp = datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds")
    if not offline and (force or due(feed, "hackathons", HACK_EVERY, now)):
        events, statuses = hackathons.collect(hack_config or _yaml("hackathons.yaml"), **({"fetch": fetch} if fetch else {}))
        if events or not (feed.get("hackathons") or {}).get("events"):
            feed["hackathons"] = {"fetched_at": now, "generated_at": stamp, "events": events, "sources": statuses}
        else:  # every source failed: keep the old events, show the new statuses
            feed["hackathons"]["sources"] = statuses
    if not offline and (force or due(feed, "certs", CERT_EVERY, now)):
        items = certs.collect(cert_config or _yaml("certs.yaml"), **({"fetch": fetch} if fetch else {}))
        feed["certs"] = {"fetched_at": now, "generated_at": stamp, "items": items}
    return feed


def main() -> int:
    ap = argparse.ArgumentParser(description="Refresh the resume feed.")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()
    now = time.time()
    feed = refresh(_load(FEED_PATH, {}), now, force=args.force, offline=args.offline)
    FEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    FEED_PATH.write_text(json.dumps(feed, indent=1), encoding="utf-8")
    print(f"resume feed: {len((feed.get('hackathons') or {}).get('events', []))} hackathons, "
          f"{len((feed.get('certs') or {}).get('items', []))} certifications")
    if args.no_push:
        return 0
    cfg = sync.settings()
    if not cfg:
        print("no dashboard settings; wrote the file only")
        return 0
    try:
        sync._call(cfg[0] + "/api/ingest-resume", cfg[1], "POST", feed)
        print("pushed to the dashboard")
    except OSError as err:
        print(f"push failed ({err}); the feed is saved and the next run retries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
