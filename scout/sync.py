"""Move data between the repo and the dashboard Worker.

    .venv/bin/python -m scout.sync push     # matches, page state, config text, tracker  -> Worker KV
    .venv/bin/python -m scout.sync pull     # tracker, prep queue, passed keys  <- Worker KV, into data/
    .venv/bin/python -m scout.sync push --tracker-only   # just data/tracker.json -> Worker KV (after /prep or /status)
    .venv/bin/python -m scout.sync push --kits           # applications/*/ -> the dashboard's Review page (Mac only)
    .venv/bin/python -m scout.sync push --mascot         # the borrowed panda art -> the dashboard (Mac only)
    .venv/bin/python -m scout.sync push --mascot --remove   # take the panda back off the dashboard

pull also writes answers and cover letters edited on the Review page back into applications/ (when it exists).

--tracker-only exists because the Mac's data/matches.json is an old copy: a full push from the Mac would
replace the dashboard's matches with it. The tracker merges per posting, newer "updated" wins.

Needs two settings, from the environment or from me/dashboard.env (gitignored, KEY=value lines):
    SCOUT_URL            https://scout-dashboard.<account>.workers.dev
    SCOUT_INGEST_SECRET  the same value as the Worker's INGEST_SECRET

In GitHub Actions both come from repository secrets. Without them, both commands print a note and exit 0,
so a missing dashboard never breaks the cron.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

from scout import kits, logos

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
ENV_FILE = ROOT / "me" / "dashboard.env"


def _env_file() -> dict:
    out = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def settings() -> tuple[str, str] | None:
    env = dict(os.environ)
    for k, v in _env_file().items():
        env.setdefault(k, v)
    url, secret = env.get("SCOUT_URL", "").rstrip("/"), env.get("SCOUT_INGEST_SECRET", "")
    return (url, secret) if url and secret else None


def _load(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def _call(url: str, secret: str, method: str = "GET", body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    # Cloudflare answers 403 to Python's default "Python-urllib" User-Agent before the Worker ever sees
    # the request, so the sync identifies itself by name.
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={"x-scout-secret": secret, "Content-Type": "application/json",
                                              "User-Agent": "scout-sync/0.1 (GitHub Actions cron)"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def build_push_payload(data_dir: Path = DATA, config_dir: Path = ROOT / "config") -> dict:
    """Everything the dashboard shows, from the files the cron just wrote.

    Not the tracker: the cron never changes it, and sending back the copy it pulled minutes earlier would undo
    a phone edit made in between (both stamp the same date). /prep and /status use push --tracker-only."""
    matches = _load(data_dir / "matches.json", {"matches": [], "counts": {}, "generated_at": ""})
    seen = _load(data_dir / "seen.json", {})
    for m in matches["matches"]:
        m["first_seen"] = (seen.get(m["key"]) or {}).get("at", "")
    config_text = {}
    for name, key in (("targets.yaml", "targets"), ("scoring.yaml", "scoring"), ("watch-pages.yaml", "watch_pages")):
        p = config_dir / name
        config_text[key] = p.read_text(encoding="utf-8") if p.exists() else ""
    return {
        "generated_at": matches.get("generated_at", ""),
        "counts": matches.get("counts", {}),
        "total_matches": matches.get("total_matches", len(matches["matches"])),  # matches.json holds only the top 300
        "open_total": matches.get("open_total", matches.get("total_matches", len(matches["matches"]))),
        "matches": matches["matches"],
        "pages": _load(data_dir / "pages.json", {}),
        "config_text": config_text,
        "logos": logos.by_company(matches["matches"]),  # company name -> logo, for tracker and Review cards
    }


# The panda is art borrowed from another of Jeremiah's projects. It never goes into this public repo: the files
# stay in a folder on his Mac (MASCOT_DIR in me/dashboard.env, or the default below) and go straight to KV.
# Each pose is two layers, made once on the Mac: <file>-bg.png (mood circle, leaves, ground) and <file>-fg.png (the
# panda alone), so only the panda moves on the page.
MASCOT_DEFAULT = Path.home() / "Desktop" / "mascot"
MASCOT_FILES = {  # dashboard name -> file in that folder
    "wave": "01-welcome", "celebrate": "happy-celebrating", "nap": "napping", "bamboo": "eating-bamboo",
    "sunglasses": "sunglasses", "judging": "judging", "proud": "proud", "sad": "sad",
    "close": "07-getting-close", "thumbs": "03-screen-time-permission", "walking": "walking-tossing-phone",
}


def pack_mascot(folder: Path, max_side: int = 360) -> dict[str, str]:
    """Both layers of each pose, shrunk to at most max_side pixels (twice its largest size on the page), as base64
    PNG: "<name>" is the panda, "<name>-bg" the background."""
    import base64
    import io

    from PIL import Image  # Mac only; the cron never runs this

    images = {}
    for name, stem in MASCOT_FILES.items():
        for suffix, key in (("-fg", name), ("-bg", f"{name}-bg")):
            path = folder / f"{stem}{suffix}.png"
            if not path.exists():
                print(f"  missing {path.name}, skipped")
                continue
            img = Image.open(path).convert("RGBA")
            img.thumbnail((max_side, max_side), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, "PNG", optimize=True)
            images[key] = base64.b64encode(buf.getvalue()).decode("ascii")
    return images


def apply_pull(state: dict, data_dir: Path = DATA) -> dict:
    """Write what the phone changed into data/. Returns a summary. The Worker already merged the tracker."""
    data_dir.mkdir(parents=True, exist_ok=True)
    tracker = state.get("tracker", {})
    (data_dir / "tracker.json").write_text(json.dumps(tracker, indent=1, sort_keys=True, ensure_ascii=False), encoding="utf-8")
    queue = state.get("queue", [])
    (data_dir / "queue.json").write_text(json.dumps(queue, indent=1), encoding="utf-8")
    passed = state.get("passed", {})
    (data_dir / "passed.json").write_text(json.dumps(passed, indent=1, sort_keys=True), encoding="utf-8")
    return {"tracker": len(tracker), "queue": len(queue), "passed": len(passed)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=["push", "pull"])
    ap.add_argument("--tracker-only", action="store_true", help="push: send only data/tracker.json")
    ap.add_argument("--kits", action="store_true", help="push: send the prep kits in applications/ to the Review page")
    ap.add_argument("--mascot", action="store_true", help="push: upload the borrowed panda art to the dashboard")
    ap.add_argument("--remove", action="store_true", help="with --mascot: delete the panda from the dashboard")
    args = ap.parse_args()
    cfg = settings()
    if not cfg:
        print("sync skipped: SCOUT_URL and SCOUT_INGEST_SECRET are not set")
        return 0
    url, secret = cfg
    try:
        if args.command == "push" and args.mascot:
            if args.remove:
                result = _call(f"{url}/api/ingest-mascot", secret, "POST", {"clear": True})
                print(f"removed the panda from the dashboard ({result.get('removed', 0)} images)")
            else:
                folder = Path(os.environ.get("MASCOT_DIR") or _env_file().get("MASCOT_DIR") or MASCOT_DEFAULT).expanduser()
                images = pack_mascot(folder)
                result = _call(f"{url}/api/ingest-mascot", secret, "POST", {"images": images})
                print(f"uploaded {result.get('pandas', 0)} panda images from {folder}")
        elif args.command == "push" and args.kits:
            packed = kits.pack_all()
            result = _call(f"{url}/api/ingest-kits", secret, "POST", {"kits": packed})
            print(f"pushed {result.get('kits', 0)} prep kits to the Review page")
        elif args.command == "push" and args.tracker_only:
            result = _call(f"{url}/api/ingest-tracker", secret, "POST", {"tracker": _load(DATA / "tracker.json", {})})
            print(f"pushed tracker ({result.get('tracker', 0)} rows on the dashboard)")
        elif args.command == "push":
            result = _call(f"{url}/api/ingest", secret, "POST", build_push_payload())
            print(f"pushed {result.get('matches', 0)} matches to the dashboard")
        else:
            state = _call(f"{url}/api/export", secret)
            summary = apply_pull(state)
            edits = kits.apply_edits(state.get("kit_edits", {}))
            print(f"pulled tracker ({summary['tracker']}), queue ({summary['queue']}), passed ({summary['passed']})"
                  + (f", {edits} edit(s) from the Review page written into applications/" if edits else ""))
    except Exception as exc:
        print(f"sync {args.command} failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
