"""Certifications for "Let's Add to Your Resume": identity from config/certs.yaml, cost and hours from the provider.

Nothing about price, time, or student offers is written down by hand. Each cert names a pattern; this module reads
the provider's own page, applies the pattern, and keeps the matching sentence as evidence. If the page can't be
read or the pattern no longer matches, the value stays None and the card says to check the provider. A stale or
remembered number never shows.

Page text is untrusted: it is searched for a number, never followed or executed.
"""

from __future__ import annotations

import html
import re
import urllib.request
from datetime import datetime, timezone

USER_AGENT = "scout-internship-watcher/0.1 (personal project; reads public certification pages; https://github.com/jeremiah123-luma/scout)"


def _get(url: str, timeout: int = 30) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def page_text(markup: str) -> str:
    """Visible text of a page: scripts and styles dropped, tags dropped, spaces collapsed."""
    markup = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", markup)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"(?s)<[^>]+>", " ", markup))).strip()


def extract(text: str, rule: dict | None) -> dict | None:
    """{value, evidence} for a rule {pattern, format|text}, or None when the page doesn't say it."""
    if not rule:
        return None
    m = re.search(rule["pattern"], text)
    if not m:
        return None
    if "format" in rule:
        groups = [g for g in m.groups()]
        value = rule["format"].format(*groups) if groups else rule["format"]
    else:
        value = rule.get("text", m.group(0))
    a, b = max(0, m.start() - 60), min(len(text), m.end() + 60)
    return {"value": value, "evidence": text[a:b].strip()}


def verify(cert: dict, fetch=_get, now: datetime | None = None) -> dict:
    """One cert as the Worker shows it. Fields the provider's page didn't confirm are None."""
    now = now or datetime.now(timezone.utc)
    out = {k: cert.get(k) for k in ("key", "name", "provider", "url", "roles", "why", "resume_line")}
    out.update(cost=None, hours=None, student=None, free=False, evidence={}, checked_at="", error="")
    try:
        text = page_text(fetch(cert["url"]))
    except (OSError, ValueError) as err:
        out["error"] = f"could not read the page: {err}"
        return out
    for field in ("cost", "hours"):
        got = extract(text, cert.get(field))
        if got:
            out[field] = got["value"]
            out["evidence"][field] = got["evidence"]
    if cert.get("student"):
        rule = cert["student"]
        text2 = text
        if rule.get("url"):  # the offer lives on another official page
            try:
                text2 = page_text(fetch(rule["url"]))
            except (OSError, ValueError):
                text2 = ""
        got = extract(text2, rule)
        if got:
            out["student"] = got["value"]
            out["evidence"]["student"] = got["evidence"]
    out["free"] = (out["cost"] or "").lower().startswith("free")
    out["checked_at"] = now.isoformat(timespec="seconds") if (out["cost"] or out["hours"] or out["student"]) else ""
    return out


def collect(config: dict, fetch=_get, now: datetime | None = None) -> list[dict]:
    """Every cert verified, free ones first, then the ones with a verified price, then the rest."""
    certs = [verify(c, fetch, now) for c in config.get("certs") or []]
    return sorted(certs, key=lambda c: (0 if c["free"] else 1 if c["cost"] else 2, c["name"]))
