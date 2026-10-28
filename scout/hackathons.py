"""Hackathons for "Let's Add to Your Resume": the public MLH season listing, plus events written by hand.

Only sources that docs/resume-feed.md records as allowed are read (config/hackathons.yaml, sources:). The MLH page
carries its events as JSON; each has a name, dates, a city, and the event's own site. It does not carry a
registration deadline or travel help, so those stay blank rather than guessed.

Distance needs coordinates. A campus or city in worker/src/places.json is used as is; for any other nearby-state
city one lookup goes to OpenStreetMap's Nominatim (one request a second, a real User-Agent, cached for good in
data/geocache.json), the way their usage policy asks.

Page text is untrusted: it is parsed into fields, never followed or executed.
"""

from __future__ import annotations

import json
import math
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
PLACES_PATH = ROOT / "worker" / "src" / "places.json"
GEOCACHE_PATH = ROOT / "data" / "geocache.json"
USER_AGENT = "scout-internship-watcher/0.1 (personal project; reads public event listings; https://github.com/jeremiah123-luma/scout)"
ET = ZoneInfo("America/New_York")
MAX_NEW_LOOKUPS = 40
# Nominatim reads a bare "PA" as the wrong place (a University Park in Alabama), so states go in by full name.
STATE_NAMES = {"NJ": "New Jersey", "NY": "New York", "PA": "Pennsylvania", "CT": "Connecticut", "DE": "Delaware",
               "MD": "Maryland", "MA": "Massachusetts", "RI": "Rhode Island", "VT": "Vermont", "NH": "New Hampshire"}


def _get(url: str, timeout: int = 30) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def load_places(path: Path = PLACES_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in miles."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def find_place(text: str, places: dict) -> dict | None:
    """The known campus or city a piece of text names, longest alias first so 'UConn Stamford' beats 'Stamford'."""
    hay = " " + re.sub(r"[^a-z0-9, ]+", " ", (text or "").lower()) + " "
    best, best_len = None, 0
    for place in places["places"]:
        for alias in place["aliases"]:
            if len(alias) > best_len and re.search(r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])", hay):
                best, best_len = place, len(alias)
    return best


def parse_mlh(html: str) -> list[dict]:
    """Event objects out of an MLH season page. The page embeds them as JSON; each starts at {"id":"..."}."""
    decoder = json.JSONDecoder()
    found, seen = [], set()
    for m in re.finditer(r'\{"id":"[0-9a-f-]{36}","slug":', html):
        try:
            obj, _ = decoder.raw_decode(html, m.start())
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("slug") and obj.get("startsAt") and obj["slug"] not in seen:
            seen.add(obj["slug"])
            found.append(obj)
    return found


def _et_date(stamp: str) -> str:
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(ET).date().isoformat()
    except ValueError:
        return ""


def normalize_mlh(raw: dict, nearby_states: set[str]) -> dict | None:
    """One MLH event as a card, or None when it isn't an in-person US event in a nearby state."""
    addr = raw.get("venueAddress") or {}
    if raw.get("formatType") != "physical" or addr.get("country") != "US":
        return None
    if str(addr.get("state", "")) not in nearby_states:
        return None
    url = str(raw.get("url") or "")
    return {
        "key": f"mlh:{raw['slug']}",
        "source": "mlh",
        "name": str(raw.get("name") or "")[:120],
        "host": "",  # MLH's listing doesn't name the host school; blank, not guessed
        "start": _et_date(str(raw.get("startsAt"))),
        "end": _et_date(str(raw.get("endsAt"))),
        "location": str(raw.get("location") or "")[:120],
        "city": str(addr.get("city") or ""),
        "state": str(addr.get("state") or ""),
        "deadline": None,
        "travel": None,
        "url": str(raw.get("websiteUrl") or ("https://www.mlh.com" + url.split("/prizes")[0] if url.startswith("/") else "")),
        "source_url": "https://www.mlh.com" + url.split("/prizes")[0] if url.startswith("/") else "",
    }


def season_year(now: datetime) -> int:
    """MLH names a season by the year it ends: the 2027 season starts in the fall of 2026."""
    return now.year + 1 if now.month >= 8 else now.year


def load_geocache(path: Path = GEOCACHE_PATH) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def geocode(city: str, state: str, cache: dict, budget: list[int]) -> tuple[float, float] | None:
    """Coordinates for a US city, from the cache or one polite Nominatim lookup. None when unknown."""
    state = STATE_NAMES.get(state.upper(), state)
    city = re.sub(r"\s+[A-Z]{2}$", "", city)  # MLH writes some cities as "York PA"
    key = f"{city}, {state}".lower()
    if key in cache:
        got = cache[key]
        return (got[0], got[1]) if got else None
    if budget[0] <= 0:
        return None
    budget[0] -= 1
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"city": city, "state": state, "country": "United States", "format": "json", "limit": 1})
    try:
        rows = json.loads(_get(url, 20))
    except (OSError, ValueError):
        return None  # not cached: try again another day
    time.sleep(1.1)  # their policy: at most one request a second
    cache[key] = [float(rows[0]["lat"]), float(rows[0]["lon"])] if rows else None
    return (cache[key][0], cache[key][1]) if cache[key] else None


def locate(event: dict, places: dict, cache: dict, budget: list[int], allow_network: bool = True) -> None:
    """Fill in lat and lon from the known places first, then the geocode cache or a lookup."""
    place = (find_place(event.get("place", ""), places) if event.get("place") else None) or find_place(
        " ".join([event.get("name", ""), event.get("host", ""), event.get("location", "")]), places)
    if place:
        event["lat"], event["lon"] = place["lat"], place["lon"]
        if place.get("school") and not event.get("host"):
            event["host"] = place["name"]
        return
    if event.get("city") and event.get("state"):
        got = geocode(event["city"], event["state"], cache, budget if allow_network else [0])
        if got:
            event["lat"], event["lon"] = got


def check_pinned(entry: dict, fetch=_get) -> dict:
    """A hand-written event, marked checked only if its own site still carries verify_text (the page or its script)."""
    event = {k: entry.get(k) for k in ("key", "name", "host", "start", "end", "location", "url", "deadline", "travel", "registration_url")}
    event["source"] = "pinned"
    event["source_url"] = entry.get("verify_url") or entry.get("url") or ""
    event["checked"] = False
    try:
        page = fetch(entry["verify_url"])
        texts = [page] + [fetch(urllib.parse.urljoin(entry["verify_url"], s))
                          for s in re.findall(r'<script[^>]+src="([^"]+\.js)"', page)[:3]]
        event["checked"] = any(entry["verify_text"] in t for t in texts)
    except (OSError, ValueError, KeyError):
        pass
    event["checked_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds") if event["checked"] else ""
    return event


def collect(config: dict, now: datetime | None = None, *, fetch=_get, allow_network: bool = True,
            cache: dict | None = None) -> tuple[list[dict], list[dict]]:
    """(events, source statuses). A source that fails reports why and contributes nothing; the caller keeps the
    last good copy."""
    now = now or datetime.now(timezone.utc)
    places = load_places()
    own_cache = cache is None
    cache = load_geocache() if own_cache else cache
    budget = [MAX_NEW_LOOKUPS]
    events, statuses = [], []
    sources = config.get("sources") or {}
    nearby = {str(s) for s in config.get("nearby_states") or []}

    if (sources.get("mlh") or {}).get("enabled"):
        status = {"id": "mlh", "name": "MLH season listing", "ok": False, "count": 0, "note": ""}
        try:
            url = sources["mlh"]["url"].format(season=season_year(now))
            raw = parse_mlh(fetch(url))
            mine = [e for e in (normalize_mlh(r, nearby) for r in raw) if e]
            for e in mine:
                locate(e, places, cache, budget, allow_network)
            events += mine
            status.update(ok=bool(raw), count=len(mine), note=f"{len(raw)} events on the page, {len(mine)} in person nearby")
            if not raw:
                status["note"] = "the page had no events in it (layout changed?)"
        except (OSError, ValueError, KeyError) as err:
            status["note"] = f"could not read it: {err}"
        statuses.append(status)

    if (sources.get("pinned") or {}).get("enabled"):
        for entry in config.get("pinned") or []:
            e = check_pinned(entry, fetch) if allow_network else {**{k: entry.get(k) for k in ("key", "name", "host", "start", "end", "location", "url", "deadline", "travel", "registration_url")}, "source": "pinned", "source_url": entry.get("url", ""), "checked": False, "checked_at": ""}
            e["place"] = entry.get("place", "")
            locate(e, places, cache, budget, False)
            events.append(e)
        statuses.append({"id": "pinned", "name": "Pinned events", "ok": True, "count": len(config.get("pinned") or []),
                         "note": "written by hand; each is checked against its own site"})
    if own_cache and allow_network:
        save_geocache(cache)
    return events, statuses


def save_geocache(cache: dict, path: Path = GEOCACHE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=1, sort_keys=True), encoding="utf-8")
