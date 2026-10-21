"""Pre-send check for application answers, so a draft that breaks the candidate's rules never reaches them.

    .venv/bin/python -m scout.voicecheck applications/<kit>/answers.md [--posting applications/<kit>/posting.txt]

Born from a post-mortem on a rejected answer (October 2026): it praised the company back to itself, quoted the
posting, used one company's name two ways, said "last summer" about the wrong summer, and leaned on a recycled
tagline. Each of those is checked here. What can't be checked in code (one decision with its reason, an outcome,
a callback ending) stays on the checklist in .claude/commands/prep.md.

FAIL (exit 1): em or en dashes, "instead of" / "not just" more than once, banned corporate words, a retired
tagline, a banned personal phrase, [brackets] left in, two names for one company, or 5+ words copied from the posting.
WARN: relative dates ("last summer", "this year") that need checking against today's date.

Personal lists (retired taglines, company name variants, phrases to avoid) live in me/voice-check.yaml, which
is gitignored, so each person's own rules stay on their own machine:

    taglines: ["simple wins"]
    entities: [["Acme Labs", "AcmeSoft"]]     # names that must not both appear in one answer
    phrases:                                   # phrase, then what to do instead
      - ["my old team", "name the team"]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PERSONAL = ROOT / "me" / "voice-check.yaml"

BANNED_WORDS = ["credits to", "grow real experience", "for a living", "leverage", "passionate", "thrilled", "delve",
                "resonate", "synergy", "hit the ground running", "fast-paced", "i believe i would be a great fit"]
CONTRAST = re.compile(r"\binstead of\b|\bnot just\b", re.I)
RELATIVE_DATES = re.compile(r"\b(last (?:summer|year|semester|fall|spring)|this (?:year|semester))\b", re.I)
DASHES = re.compile("[–—]")
SHINGLE = 5            # words in a row shared with the posting that count as quoting it back
SKIP_HEADINGS = ("standard fields",)


def load_personal(path: Path = PERSONAL) -> dict:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return {}


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def copied_from(answer: str, posting: str, n: int = SHINGLE) -> list[str]:
    """Runs of n+ words the answer shares with the posting, merged into the longest phrases."""
    if not posting:
        return []
    a, p = _words(answer), _words(posting)
    grams = {tuple(p[i:i + n]) for i in range(len(p) - n + 1)}
    hits, i = [], 0
    while i <= len(a) - n:
        if tuple(a[i:i + n]) in grams:
            j = i + n
            while j < len(a) and tuple(a[j - n + 1:j + 1]) in grams:
                j += 1
            hits.append(" ".join(a[i:j]))
            i = j
        else:
            i += 1
    return hits


def check(text: str, posting: str = "", personal: dict | None = None) -> dict:
    """{"fail": [...], "warn": [...], "words": N} for one answer."""
    personal = load_personal() if personal is None else personal
    low = text.lower()
    fail, warn = [], []
    if DASHES.search(text):
        fail.append("em or en dash")
    contrast = CONTRAST.findall(text)
    if len(contrast) > 1:
        fail.append(f'"instead of" / "not just" used {len(contrast)} times (once at most)')
    for w in BANNED_WORDS:
        if w in low:
            fail.append(f'banned phrase: "{w}"')
    for t in personal.get("taglines", []):
        if t.lower() in low:
            fail.append(f'retired tagline: "{t}"')
    for phrase, fix in personal.get("phrases", []):
        if phrase.lower() in low:
            fail.append(f'"{phrase}": {fix}')
    if re.search(r"\[[^\]]*\]", text):
        fail.append("[bracket] placeholder left in")
    for group in personal.get("entities", []):
        used = sorted({name for name in group if re.search(rf"\b{re.escape(name)}\b", text, re.I)},
                      key=str.lower)
        if len(used) > 1:
            fail.append(f"one company named {len(used)} ways: {', '.join(used)}")
        for name in group:
            for found in re.findall(rf"\b{re.escape(name)}\b", text, re.I):
                if found != name:
                    fail.append(f'"{found}" should be written "{name}"')
    for phrase in copied_from(text, posting):
        fail.append(f'copied from the posting: "{phrase}"')
    for d in sorted({m.lower() for m in RELATIVE_DATES.findall(text)}):
        warn.append(f'relative date "{d}": check it against today')
    return {"fail": fail, "warn": warn, "words": len(text.split())}


def sections(answers_md: str) -> list[tuple[str, str]]:
    """(heading, body) for each "## " answer worth checking (field lists are skipped)."""
    out = []
    for m in re.finditer(r"^## (.+?)\n\n(.*?)(?=^## |\Z)", answers_md, re.S | re.M):
        heading, body = m.group(1).strip(), m.group(2).strip()
        lines = [l for l in body.splitlines() if l.strip()]
        if heading.lower().startswith(SKIP_HEADINGS) or (lines and all(l.lstrip().startswith("- ") for l in lines)):
            continue
        if len(body.split()) < 12:  # one-word picks like "Product" are not prose
            continue
        out.append((heading, body))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("answers", type=Path)
    ap.add_argument("--posting", type=Path, default=None)
    args = ap.parse_args()
    posting_path = args.posting or args.answers.parent / "posting.txt"
    posting = posting_path.read_text(encoding="utf-8") if posting_path.exists() else ""
    failed = False
    for heading, body in sections(args.answers.read_text(encoding="utf-8")):
        result = check(body, posting)
        status = "FAIL" if result["fail"] else "ok"
        print(f"[{status}] {heading} ({result['words']} words)")
        for f in result["fail"]:
            print(f"    fail: {f}")
        for w in result["warn"]:
            print(f"    warn: {w}")
        failed = failed or bool(result["fail"])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
