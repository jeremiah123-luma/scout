"""Prep kits, packed for the dashboard's Review page, and phone edits written back into them.

    .venv/bin/python -m scout.sync push --kits    # applications/*/ -> the Review page (Worker KV, behind the password)
    .venv/bin/python -m scout.sync pull           # also writes answers edited on the phone back into answers.md

A kit is a folder /prep wrote under applications/ (gitignored). It holds the candidate's phone, email, and
answers, so it only ever goes to the password-protected dashboard, never to git or the public data branch.

answers.md is split on its "## " headings: each heading is a question, the text under it is the answer.
The page edits one answer at a time; pull writes an edited answer back under the same heading.
"""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APPLICATIONS = ROOT / "applications"
LESSONS = ROOT / "me" / "voice-lessons.md"   # private: every edit he makes, and what it teaches

LESSONS_HEADER = """# Voice lessons (private, grows with every edit)

Read this before drafting anything with his name on it. His edits beat every general rule.

## Takeaways

(Distilled from the edits below at the start of each /prep. Newest first. Each one: the rule, then the edit that taught it.)

## Edits

Logged automatically by `scout.sync pull` when he saves an edit on the Review page. Entries marked [new] have not been
turned into takeaways yet.
"""
_HEADING = re.compile(r"^## (.+)$", re.M)


def split_answers(text: str) -> tuple[str, list[dict]]:
    """('intro text', [{'q': heading, 'a': body}, ...]) from an answers.md."""
    parts = _HEADING.split(text)
    intro = re.sub(r"^# .*\n?", "", parts[0]).strip()
    sections = [{"q": parts[i].strip(), "a": parts[i + 1].strip()} for i in range(1, len(parts) - 1, 2)]
    return intro, sections


def join_answers(title: str, intro: str, sections: list[dict]) -> str:
    out = [f"# {title}", ""] if title else []
    if intro:
        out += [intro, ""]
    for s in sections:
        out += [f"## {s['q']}", "", s["a"].strip(), ""]
    return "\n".join(out).rstrip() + "\n"


def _title_line(text: str) -> str:
    m = re.match(r"^# (.+)$", text, re.M)
    return m.group(1).strip() if m else ""


def _b64(path: Path | None) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii") if path and path.exists() else ""


def _mtime(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")


def pack(folder: Path) -> dict | None:
    """One kit as the Worker stores it, or None if the folder is not a kit."""
    answers_file = folder / "answers.md"
    if not answers_file.exists():
        return None
    match = json.loads((folder / "match.json").read_text(encoding="utf-8")) if (folder / "match.json").exists() else {}
    text = answers_file.read_text(encoding="utf-8")
    intro, sections = split_answers(text)
    resume = next(iter(sorted(folder.glob("*Resume*.pdf"))), None)
    letter_md = folder / "cover-letter.md"
    letter_body = letter_md.read_text(encoding="utf-8").split("---", 1)[-1].strip() if letter_md.exists() else ""
    return {
        "slug": folder.name,
        "key": match.get("key", ""),
        "company": match.get("company", ""),
        "title": match.get("title", ""),
        "url": match.get("url", ""),
        "answers_title": _title_line(text),
        "intro": intro,
        "answers": sections,
        "notes": (folder / "notes.md").read_text(encoding="utf-8") if (folder / "notes.md").exists() else "",
        "letter": letter_body,
        "resume_name": resume.name if resume else "",
        "resume_pdf": _b64(resume),
        "letter_pdf": _b64(folder / "cover-letter.pdf"),
        "updated": _mtime(answers_file),
        "opened": opened_date(folder, match),
    }


def opened_date(folder: Path, match: dict) -> str:
    """When the posting went up, as YYYY-MM-DD, kept with the kit so the Review page always has it, even after
    the posting falls out of the dashboard's matches. From the saved posting first, then the list's date."""
    posting = folder / "posting.txt"
    if posting.exists():
        for line in posting.read_text(encoding="utf-8").splitlines()[:8]:
            if line.lower().startswith("posted:"):
                value = line.split(":", 1)[1].strip()[:10]
                if len(value) == 10 and value[4] == "-" and value[7] == "-":
                    return value
    ts = match.get("date_posted")
    if isinstance(ts, (int, float)) and ts > 0:
        from datetime import datetime, timezone
        return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")
    return ""


def pack_all(root: Path = APPLICATIONS) -> list[dict]:
    if not root.exists():
        return []
    return [k for k in (pack(f) for f in sorted(root.iterdir()) if f.is_dir()) if k]


def log_lesson(company: str, question: str, draft: str, edited: str, path: Path | None = None) -> None:
    """Append one before/after pair to the lessons file, marked [new] until /prep distills it."""
    path = path or LESSONS
    if not path.parent.exists():
        return  # no me/ folder (the cron): nothing personal is ever written there
    if not path.exists():
        path.write_text(LESSONS_HEADER, encoding="utf-8")
    quote = lambda t: "\n".join("> " + line if line else ">" for line in t.strip().splitlines())
    day = datetime.now().strftime("%Y-%m-%d")
    entry = f"\n### [new] {day} · {company} · {question}\n\nDraft:\n\n{quote(draft)}\n\nHis edit:\n\n{quote(edited)}\n"
    with path.open("a", encoding="utf-8") as f:
        f.write(entry)


def _company(folder: Path) -> str:
    try:
        return json.loads((folder / "match.json").read_text(encoding="utf-8")).get("company") or folder.name
    except (OSError, ValueError):
        return folder.name


def apply_letter(folder: Path, body: str) -> bool:
    """Put a letter edited on the phone back under the header of cover-letter.md and rebuild its PDF."""
    path = folder / "cover-letter.md"
    if not path.exists():
        return False
    header, sep, old = path.read_text(encoding="utf-8").partition("---")
    if not sep or old.strip() == body.strip():
        return False
    log_lesson(_company(folder), "Cover letter", old, body)
    path.write_text(f"{header}---\n{body.strip()}\n", encoding="utf-8")
    import subprocess, sys
    subprocess.run([sys.executable, str(ROOT / "scout" / "build_letter.py"), str(path)], check=False)
    return True


def apply_edits(edits: dict, root: Path = APPLICATIONS) -> int:
    """Write answers edited on the phone into answers.md. edits: {slug: {"answers": [{"q","a"}, ...], "letter": "..."}}.

    Only kits that exist on this Mac are touched (the cron has no applications/ folder), and only
    sections whose heading still matches, so a question renamed on the Mac is never overwritten.
    Returns how many answers changed.
    """
    changed = 0
    for slug, kit in (edits or {}).items():
        path = root / slug / "answers.md"
        if not path.exists() or "/" in slug or slug.startswith("."):
            continue
        text = path.read_text(encoding="utf-8")
        intro, sections = split_answers(text)
        phone = {s["q"]: s["a"] for s in kit.get("answers", []) if s.get("edited")}
        here = 0
        for s in sections:
            if s["q"] in phone and phone[s["q"]].strip() != s["a"].strip():
                log_lesson(_company(root / slug), s["q"], s["a"], phone[s["q"]])
                s["a"] = phone[s["q"]]
                here += 1
        changed += here
        if here:
            path.write_text(join_answers(_title_line(text), intro, sections), encoding="utf-8")
        if kit.get("letter") and apply_letter(root / slug, kit["letter"]):
            changed += 1
    return changed
