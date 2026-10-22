"""Build a one-page, ATS-safe resume PDF from a JSON file of facts.

Usage (from the repo root, inside the venv):

    .venv/bin/python scout/build_resume.py me/resumes/swe.json
    .venv/bin/python scout/build_resume.py me/resumes/*.json      # all variants

How it works, in order:
  1. Read the JSON (name, contact line, optional summary, sections with entries and bullets).
     The JSON lives in me/ and is gitignored because it holds personal data.
  2. Render scout/templates/resume.html with Jinja2 (HTML autoescaped, so a "<" in a bullet is safe).
  3. Turn the HTML into a PDF with WeasyPrint.
  4. Refuse to finish if the PDF is not exactly one page.
  5. Read the PDF's text layer back with pypdf and check what an ATS parser would see:
     the name, email, and phone must be present as real text, and the section headings
     must come out in the same order they were written. Print the first lines so a
     human can eyeball it too.

Nothing here invents content. Every word in the PDF comes from the JSON.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = ROOT / "scout" / "templates"
DASHES = re.compile("[\\u2013\\u2014]")  # en dash, em dash (by code point): never allowed in the documents


def load_variant(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("name", "contact", "sections", "filename"):
        if key not in data:
            sys.exit(f"{path}: missing required key {key!r}")
    text_blob = json.dumps(data, ensure_ascii=False)
    if DASHES.search(text_blob):
        sys.exit(f"{path}: contains an em or en dash. Replace it with a comma, colon, or hyphen.")
    return data


def render_html(data: dict) -> str:
    from jinja2 import Environment, FileSystemLoader, select_autoescape
    env = Environment(loader=FileSystemLoader(TEMPLATE_DIR), autoescape=select_autoescape(["html"]))
    return env.get_template("resume.html").render(**data)


def build_pdf(html: str, out_path: Path) -> int:
    """Write the PDF and return its page count."""
    from weasyprint import HTML
    document = HTML(string=html, base_url=str(TEMPLATE_DIR)).render()
    document.write_pdf(out_path)
    return len(document.pages)


def ats_check(pdf_path: Path, data: dict) -> list[str]:
    """Return a list of problems an ATS parser would hit. Empty list means clean."""
    from pypdf import PdfReader
    text = "\n".join(page.extract_text() or "" for page in PdfReader(str(pdf_path)).pages)
    problems: list[str] = []

    if data["name"] not in text:
        problems.append("name not found in extracted text")
    # contact2 is an optional second contact line, for when one line would wrap and strand an item.
    for item in data["contact"] + data.get("contact2", []):
        # Compare digits only for the phone, so "(555) 123-4567" matches however it wraps.
        needle = re.sub(r"\D", "", item) if re.search(r"\d{3}.*\d{4}", item) else item
        haystack = re.sub(r"\D", "", text) if needle.isdigit() else text
        if needle not in haystack:
            problems.append(f"contact item not found as text: {item}")

    # Headings must appear in the order they were written (single column, top to bottom).
    positions = []
    for section in data["sections"]:
        pos = text.upper().find(section["heading"].upper())
        if pos < 0:
            problems.append(f"heading missing from text layer: {section['heading']}")
        positions.append(pos)
    if positions != sorted(positions):
        problems.append("section headings extracted out of order (reading order broken)")

    if "�" in text or "(cid:" in text:
        problems.append("garbled characters in text layer")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("variants", nargs="+", type=Path, help="one or more me/resumes/*.json files")
    ap.add_argument("--out", type=Path, default=None, help="output folder (default: next to the JSON)")
    args = ap.parse_args()

    failed = False
    for path in args.variants:
        data = load_variant(path)
        out_dir = args.out or path.parent
        out_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = out_dir / data["filename"]
        html_path = out_dir / (Path(data["filename"]).stem + ".html")

        html = render_html(data)
        html_path.write_text(html, encoding="utf-8")  # kept next to the PDF for debugging layout
        pages = build_pdf(html, pdf_path)

        status = "OK" if pages == 1 else f"FAIL: {pages} pages, must be 1"
        print(f"{pdf_path}  [{status}]")
        if pages != 1:
            failed = True

        problems = ats_check(pdf_path, data)
        for p in problems:
            print(f"  ATS problem: {p}")
            failed = True
        if not problems:
            print("  ATS text layer: name, contact, and headings all present and in order")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
