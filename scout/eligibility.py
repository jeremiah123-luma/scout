"""Read a posting page and look for a graduation-year requirement.

Many postings say things like "graduating between December 2027 and June 2028" or "Class of 2028".
For someone graduating in 2030 (graduation_year in config/targets.yaml) those are out even when the
list says "Bachelor's". The lists
do not carry this, so for the top matches Scout fetches the page (Workday, Google Careers,
Greenhouse, Lever, Ashby) and reads it.

Verdicts:
  "ok"          the page names a graduation window that includes yours, or names no year and says
                freshman/sophomore
  "ineligible"  the page names graduation windows and yours is in none of them, or names no year and asks
                for penultimate-year, final-year, junior, or senior students
  "closed"      the board says the posting is gone, the page says it is no longer available, or its stated
                application deadline has passed (treated like "ineligible": never pushed, sorted last)
  "unknown"     the page could not be read, or says nothing about graduation year (never hidden, just labeled)

Reading the page is scout/posting.py's job (Workday, Google Careers, Greenhouse, Lever, Ashby).

Results are cached in data/eligibility_cache.json by URL so a page is fetched once, not every run.
Posting text is untrusted: it is only ever searched with regular expressions, never executed or followed.
"""

from __future__ import annotations

import json
import re
import time
from datetime import date, datetime
from pathlib import Path

from scout import matching, posting

ROOT = Path(__file__).resolve().parent.parent
CACHE_PATH = ROOT / "data" / "eligibility_cache.json"
CACHE_DAYS = 14
CLOSED = "\0closed"  # fetch_text's answer for a posting the board says is gone
CACHE_VERSION = 6  # bump when the verdict rules change, so old verdicts are re-read
TITLE_PREFIX = "Title: "  # fetch_text puts the page's own title on the first line, so title rules can see it

_TAGS = re.compile(r"<script.*?</script>|<style.*?</style>|<[^>]+>", re.S | re.I)
_YEAR = re.compile(r"\b(20[2-3][0-9])\b")
# A graduation requirement is a sentence with "graduating", "graduation", "class of", or "degree expected" in it.
# Every year in that sentence counts, so "December 2028, May 2029, December 2029, or May 2030" yields all four.
# The text is flattened to one line first: Pinterest puts "graduate by" and "June 2029" on separate lines.
# "graduate degree", "graduate students", and the like are about degree level, not a date: Northrop Grumman's
# "undergraduate or graduate degree ... enrolled full time in Fall 2027" is not a 2027 graduation rule.
# Some pages never say "graduate": Pinterest's Solutions Engineer intern says "Obtain Bachelor's in Computer Science ...
# by June 2028", Booz Allen says "Scheduled to obtain a Bachelor's degree ... by Summer 2028", and Point72's Data
# Research Fellowship says "Undergraduate degree conferred in 2025 or 2026". Those are graduation dates too.
# LLNL's "apply for the Computing Scholar Graduate position" names a job, not a date, so "graduate position" is skipped.
_GRAD_SENTENCE = re.compile(
    r"[^.]{0,80}\b(?:graduat(?:e[sd]?|ing|ion)\b(?!\s+(?:degrees?|students?|programs?|level|school|studies|coursework|research|positions?|postings?|roles?))"
    r"|class of\b|degree expected\b|expected (?:degree|completion)\b|degree completion\b"
    r"|(?:obtain|complete|earn|receive|finish)(?:s|ed|ing)?\s+(?:a\s+|an\s+|your\s+|their\s+|the\s+)?(?:bachelor'?s?|undergraduate|b\.?s\.?|b\.?a\.?)(?![a-z])"
    r"|degree (?:conferred|awarded)\b)[^.]{0,160}", re.I)
# A degree already conferred names past years ("conferred in 2025 or 2026"); those count, unlike "founded in 2021".
_CONFERRED = re.compile(r"\b(?:conferred|awarded)\b", re.I)
# "2028 or later" is a floor, not a single year. "graduate before Summer 2028" / "by June 2029" is a ceiling.
_OPEN_AFTER = re.compile(r"\b20[2-3][0-9]\s*(?:or|and)\s*(?:later|after|beyond)\b|\b20[2-3][0-9]\s*onwards?\b", re.I)
_CEILING = re.compile(r"\b(?:before|by|no later than|prior to)\s+(?:[a-z/]+\s+){0,2}20[2-3][0-9]\b", re.I)
# Floors: "on or after December 2027", "no earlier than May 2028", "do not anticipate graduating before May 2028",
# and "students graduating by Summer 2027 are not eligible". Checked before _CEILING, which they would otherwise trip.
_FLOOR = re.compile(
    r"\b(?:(?:on|in) or after|after|no earlier than)\s+(?:[a-z/]+\s+){0,2}20[2-3][0-9]\b"
    r"|\bnot\b[^.]{0,40}?\b(?:before|prior to)\s+(?:[a-z/]+\s+){0,2}20[2-3][0-9]\b"
    r"|\b(?:before|by|prior to)\s+(?:[a-z/]+\s+){0,2}20[2-3][0-9]\b[^.]{0,30}\b(?:are|is) (?:not |in)eligible", re.I)
# "first year of the program" (AbbVie) and "first year of an MBA" (Amgen's grad intern) are not freshman words.
_UNDERCLASS = re.compile(r"\b(freshman|freshmen|sophomore|first[- ]year(?! of (?:the|a|an|their|your|mba|master|ph\.?d|graduate))"
                         r"|second[- ]year|underclass\w*)\b", re.I)
# Phrases that mean "not a freshman": Google writes "penultimate academic year", others say "rising junior".
_UPPERCLASS = re.compile(
    r"\b(penultimate|final[- ]year|last[- ]year of|rising (?:junior|senior)s?|junior or senior|juniors and seniors|"
    r"junior/senior|third[- ]year or fourth[- ]year|third or fourth year|(?:junior|senior) standing)\b", re.I)

# Class-standing requirements a 2030 graduate cannot meet by Summer 2027 (he finishes his freshman year in May 2027).
# These are checked before freshman words, because the words inside them are freshman words: Westinghouse's
# "Completed Sophomore year of college" and GlobalFoundries' "At least a sophomore at time of application" were
# labeled freshman-friendly. They also beat an open floor like "Dec 2027 or later" (Corning says both).
_STANDING = re.compile(
    r"\bcomplet(?:ed?|ion of)\s+(?:at least\s+)?(?:two|2|three|3|four|4)\+?\s+(?:full\s+)?(?:academic\s+)?years?\s+(?:of\s+)?"
    r"(?:college|university|undergrad\w*|study|studies|school|coursework|(?:a\s+|your\s+|the\s+)?(?:bachelor|degree|engineering|program))"
    r"|\b(?:minimum|at least)\s+(?:of\s+)?(?:two|2|three|3)\+?\s+years?\s+(?:of\s+)?(?:working\s+)?towards?\s+(?:the|a|your)\s+degree"
    r"|\bcomplet(?:ed|ion of)\s+(?:their\s+|your\s+|the\s+)?(?:sophomore|junior)\s+year"
    r"|\bat least an?\s+(?:sophomore|junior|senior)\s+(?:at|by)\s+(?:the\s+)?time of\s+(?:application|applying)"
    r"|\bcurrent(?:ly)?\s+(?:an?\s+)?sophomores?\b"
    r"|\b(?:at least|minimum of|completed)\s+(?:4[5-9]|[5-9]\d|1[0-2]\d)\s+(?:completed\s+)?(?:college[- ]level\s+|college\s+|semester\s+)?credit", re.I)

# A graduation date tied to the internship instead of a year: Ryan's "Anticipated graduation date within one year of
# internship" and HeyGen's "within one year of graduation" both mean a 2027 or 2028 graduate.
_RELATIVE_GRAD = re.compile(
    r"\bgraduat\w*(?:\s+date)?\s+(?:is\s+)?within\s+(?:one|1|a|twelve|12|six|6)\s+(?:years?|months?)\s+(?:of|after|following)\b"
    r"|\bwithin\s+(?:one|1|a|twelve|12|six|6)\s+(?:years?|months?)\s+of\s+graduat", re.I)

# A full-time start date is a graduation date in disguise: Amgen's "commit to future full-time employment by July 2028",
# PDT's "eligible for full-time roles starting in 2028 or 2029", Datadog's "Targeting a 2028 full-time start date", and
# Sigma's "start work full-time by either January 2028 or June 2028". Each passed as "2027 or later" or said nothing.
# "a full-time position for the summer, May - August 2027" (Westinghouse) is the internship itself, so it is skipped.
_FULLTIME = re.compile(
    r"[^.;!?\u2022\u25cf]{0,100}?\b(?:full[- ]time\s+(?:[a-z-]+\s+){0,3}?(?:roles?|positions?|employment|start|offers?|jobs?|hire|graduation)"
    r"|(?:start|begin)(?:ning)?\s+(?:work(?:ing)?\s+)?full[- ]time)\b[^.;!?\u2022\u25cf]{0,100}", re.I)
# Checked from just before "full-time" onward, so an earlier "for the duration of the internship program" (Amgen) does not
# hide the rule. CACI's "intern starting in July 2027 ... with the potential to transition to a full-time position" is
# about the internship's own dates.
_FULLTIME_IS_INTERNSHIP = re.compile(r"\bfor the summer\b|\bsummer (?:of )?20\d\d\b|\d+[- ]weeks?\b|\binternship (?:period|program|session)"
                                     r"|\bpotential (?:to|for) (?:transition|convert|conversion)\b", re.I)

# Required earlier internships. Harvey: "Previous internship experience is required." Rippling: "What you will need
# Previous internship/Co-op experience". AgZen: "at least one prior internship or co-op". A first-year student has none.
_PRIOR_INTERNSHIP = re.compile(
    r"\b(?:previous|prior)\s+(?:software\s+|engineering\s+|technical\s+)?(?:internship|co-?op)s?(?:\s*/\s*co-?op)?\s+(?:experience\s+)?(?:is\s+|are\s+)?required\b"
    r"|\bat least one\s+(?:prior\s+|previous\s+)?(?:software\s+)?(?:internship|co-?op)\b"
    r"|\b(?:need|must have|requires?|required:?)\s+(?:completed\s+)?(?:an?\s+|at least one\s+)?(?:previous|prior)\s+(?:internship|co-?op)"
    # A requirements bullet that starts with it (Rippling's page puts "What you will need" on its own line).
    r"|^\W*(?:previous|prior)\s+(?:software\s+)?(?:internship|co-?op)s?(?:\s*/\s*co-?op)?\s+experience\b", re.I)

# Postings for the company's own past interns. Sierra Nevada: "For SNC Summer 2026 Interns Only" and
# "Must have been a SNC summer 2026 intern."
_RETURNING_ONLY = re.compile(r"\bmust have been an?\s+(?:[\w-]+\s+){0,4}interns?\b|\b20\d\d\s+interns\s+only\b"
                             r"|\b(?:former|returning)\s+(?:[\w-]+\s+){0,3}interns\s+only\b", re.I)

# A full-time job filed as a fellowship: Palantir's Neurodivergent Fellowship says "You'll join Palantir as a full-time
# employee" with a $110,000 salary. That is a job for someone who has finished school, not an internship.
_FULLTIME_JOB = re.compile(r"\bjoin\s+[\w&.' -]{1,40}?\s+as\s+an?\s+full[- ]time\s+employee\b", re.I)

# Pages that say the job is gone even though the board still serves them (MITRE: "the job you are trying to apply for
# is no longer available").
# Microsoft's "applications accepted ... until the position is filled" is not a closed posting, so "is filled" is not used.
_GONE = re.compile(r"\bno longer (?:accepting applications|available|open for applications)\b|\bposition has been filled\b"
                   r"|\b(?:job|posting|position|requisition|role) (?:you are (?:trying|looking) to apply for |you are looking for )?"
                   r"(?:has been (?:closed|removed)|has expired|is (?:closed|expired))\b", re.I)

# Application deadlines. Anthropic's Fellows page said "apply here by October 18" and was still listed on October 20.
_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
_DEADLINE = re.compile(
    r"\b(?:apply(?:\s+here)?\s+(?:by|before)|application\s+deadline(?:\s+is)?:?|applications?\s+(?:will\s+)?(?:close|closes|are due|due)(?:\s+on)?"
    r"|deadline\s+to\s+apply(?:\s+is)?:?|close\s+to\s+applicants\s+on)\s+(?:[a-z]+day,?\s+)?"
    r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b", re.I)

# Lines that state a preference or a pay rate, not a requirement: TikTok's "Preferred Qualifications - Currently pursuing a
# Master's degree" and Marvell's "Additional compensation may be available for intern PhD candidates" are not
# master's-only or PhD-only rules, and Paccar's "Junior or senior standing preferred" does not rule a freshman out.
_SOFT = re.compile(r"\b(?:prefer\w*|ideal(?:ly)?|nice[- ]to[- ]have|a plus|bonus|compensation|pay range|salary|hourly|per hour)\b|\$", re.I)
_SOFT_HEADER = re.compile(r"^\W*(?:preferred|nice[- ]to[- ]have|bonus|desired|pluses|additional qualifications|other qualifications|what will make you stand out)", re.I)
_HARD_HEADER = re.compile(r"^\W*(?:minimum|basic|required|requirements|qualifications|must|what you|who you|education|eligibility|"
                          r"responsibilit|about|what we|program eligibility)", re.I)


def hard_lines(text: str) -> list[str]:
    """Sentences that state requirements: everything except preferences, pay lines, and a "Preferred" section."""
    out, soft = [], False
    for line in re.split(r"(?<=[.;!?\u2022\u25cf])\s+|\n", text):
        if _SOFT_HEADER.search(line):
            soft = True
        elif _HARD_HEADER.search(line):
            soft = False
        # "(mechanical is preferred)" inside ITT's "Junior/Senior who is pursuing a degree" does not soften the rule.
        if line.strip() and not soft and not _SOFT.search(re.sub(r"\([^)]*\)", " ", line)):
            out.append(line)
    return out


def _first_hard(pattern: re.Pattern, text: str) -> re.Match | None:
    for line in hard_lines(text):
        m = pattern.search(line)
        if m:
            return m
    return None


# Programs built as an alternative to college (Palantir's Meritocracy Fellowship, the Thiel Fellowship) require
# not being enrolled. A current college student is ruled out whatever the graduation year.
_NOT_ENROLLED = re.compile(
    r"\b(?:not|cannot|can't|can not)\s+(?:be )?(?:currently )?enrolled in (?:an? |any )?(?:accredited )?(?:u\.?s\.? )?(?:college|university|degree)", re.I)


# Degree level. Sony's AI Ethics intern says "Completed or currently pursuing a PhD in Computer Science"; a page
# like that names no graduation year, so the year rules above never see it. A sentence that also names a
# bachelor's or undergraduate degree ("pursuing a BS, MS, or PhD") is open to him and does not count.
# KLA's "Currently enrolled graduate student or PHD" and GM's "in the process of obtaining a Masters or PhD" count too.
_GRAD_DEGREE = re.compile(
    r"\b(?:pursuing|enrolled in|currently in|candidates? for|working toward|working towards|obtaining)\b[^.;]{0,40}?"
    r"\b(ph\.?\s?d\.?|doctoral|doctorate|master'?s|mba|graduate degree)"
    r"|\b(ph\.?\s?d\.?|doctoral|master'?s|mba)\s+(?:students?|candidates?|programs?)\b"
    r"|\b(?:enrolled|current)\s+(graduate|master'?s|ph\.?\s?d\.?|doctoral)\s+students?\b", re.I)
_UNDERGRAD = re.compile(r"\b(bachelor'?s?|undergrad\w*|b\.?s\.?|b\.?a\.?|bs/ms|ba/bs)\b", re.I)
# A bachelor's the applicant already holds does not open a graduate posting: Metamorphic's "Bachelor's degree or
# equivalent experience, currently pursuing a PhD or MS" and Amgen's "Graduated with a bachelor's degree ... Currently
# enrolled in an MBA program ... OR a Master's program" are graduate-only.
_HELD_UNDERGRAD = re.compile(
    r"\b(?:graduated with|hold(?:s|ing)?|completed|earned|possess(?:es|ing)?|already (?:have|hold))\s+(?:a\s+|an\s+|their\s+|your\s+)?"
    r"(?:bachelor'?s?|b\.?s\.?|undergraduate)(?:\s+degree)?|\bbachelor'?s?(?:\s+degree)?\s+or\s+equivalent", re.I)


def graduate_only(text: str) -> str:
    """'PhD' or "master's" when the page asks only for graduate students, else ''."""
    for sentence in hard_lines(text):
        m = _GRAD_DEGREE.search(sentence)
        if m and not _UNDERGRAD.search(_HELD_UNDERGRAD.sub(" ", sentence)):
            level = (m.group(1) or m.group(2) or m.group(3) or "").lower()
            return "master's" if level.startswith("master") else "graduate" if level in ("graduate", "graduate degree", "mba") else "PhD"
    return ""


def is_readable_board(url: str) -> bool:
    return posting.is_readable_board(url)


def fetch_text(url: str) -> str | None:
    """The posting's text, CLOSED when the board says it is gone, or None when it cannot be read server-side.

    The page's own title goes on the first line: the lists shorten titles, so AMD's "2027 Masters Product Development
    Engineering Intern" and Sierra Nevada's "... For SNC Summer 2026 Interns Only" were listed without the words
    that rule him out."""
    post = posting.read_posting(url)
    if post and post.get("closed"):
        return CLOSED
    if not post:
        return None
    title = re.sub(r"\s+", " ", post.get("title") or "").strip()
    return (TITLE_PREFIX + title + "\n" if title else "") + post["text"]


def page_title(text: str) -> str:
    first = text.split("\n", 1)[0]
    return first[len(TITLE_PREFIX):] if first.startswith(TITLE_PREFIX) else ""


def deadline(text: str, today: date | None = None) -> date | None:
    """The latest application deadline the page states, or None. A date with no year gets the year that puts it
    closest to today ("apply by January 15" read in October is next January, "by October 18" is this October)."""
    today = today or date.today()
    found = []
    for m in _DEADLINE.finditer(_flat(text)):
        month, day = _MONTHS[m.group(1).lower()[:3]], int(m.group(2))
        years = [int(m.group(3))] if m.group(3) else [today.year - 1, today.year, today.year + 1]
        options = []
        for y in years:
            try:
                options.append(date(y, month, day))
            except ValueError:
                pass
        if options:
            found.append(min(options, key=lambda d: abs((d - today).days)))
    return max(found) if found else None


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def years_mentioned(text: str) -> list[int]:
    """Every graduation year the page names, e.g. 'graduating between Dec 2027 and June 2028' -> [2027, 2028]."""
    years: set[int] = set()
    for sentence in _GRAD_SENTENCE.finditer(_flat(text)):
        for year in _YEAR.findall(sentence.group(0)):
            years.add(int(year))
    return sorted(years)


def grad_ranges(text: str, this_year: int | None = None) -> list[tuple[int, int]]:
    """One (low, high) graduation window per requirement sentence.

    Years before this year are ignored ("founded in 2021, our graduate program"), "or later" opens the top,
    and "before"/"by" opens the bottom.
    """
    this_year = this_year or datetime.now().year
    ranges = []
    for match in _GRAD_SENTENCE.finditer(_flat(text)):
        sentence = match.group(0)
        floor = this_year - 10 if _CONFERRED.search(sentence) else this_year
        years = [int(y) for y in _YEAR.findall(sentence) if int(y) >= floor]
        if not years:
            continue
        low, high = min(years), max(years)
        if _OPEN_AFTER.search(sentence) or _FLOOR.search(sentence):
            high = 9999
        elif _CEILING.search(sentence):
            low = 0
        ranges.append((low, high))
    return ranges


def fulltime_ranges(text: str, this_year: int | None = None) -> list[tuple[int, int]]:
    """(low, high) years for each "full-time role starting in ..." line. By graduation he can start in 2030, not before."""
    this_year = this_year or datetime.now().year
    ranges = []
    for match in _FULLTIME.finditer(_flat(text)):
        window = match.group(0)
        key = re.search(r"full[- ]time|(?:start|begin)\w*\s+(?:work\w*\s+)?full", window, re.I)
        tail = window[max(0, key.start() - 30):] if key else window
        if _FULLTIME_IS_INTERNSHIP.search(tail) or _FULLTIME_IS_INTERNSHIP.search(window[:key.start() if key else 0][-60:]) \
                or _OPEN_AFTER.search(window) or _FLOOR.search(window):
            continue
        years = [int(y) for y in _YEAR.findall(window) if int(y) >= this_year]
        if years:
            ranges.append((0 if _CEILING.search(window) else min(years), max(years)))
    return ranges


def _describe(low: int, high: int) -> str:
    if high == 9999:
        return f"{low} or later"
    if low == 0:
        return f"by {high}"
    return f"{low}" + (f" to {high}" if high != low else "")


def verdict_from_text(text: str, graduation_year: int, this_year: int | None = None) -> tuple[str, str]:
    """('ok' | 'ineligible' | 'unknown', short reason).

    Stated graduation years decide first. A page can say "sophomore" and still ask for 2029 graduates,
    so freshman words only count when no year is stated.
    """
    flat = _flat(text)
    if _GONE.search(flat):
        return "closed", "the page says the job is no longer available"
    if _NOT_ENROLLED.search(flat):
        return "ineligible", "page requires not being enrolled in college"
    if _FULLTIME_JOB.search(flat):
        return "ineligible", "page is a full-time job, not an internship"
    if _RETURNING_ONLY.search(flat):
        return "ineligible", "page is only for the company's past interns"
    if matching.graduate_title(page_title(text)):
        return "ineligible", "page title is for graduate students"
    level = graduate_only(text)
    if level:
        return "ineligible", f"page asks for {level} students"
    prior = _first_hard(_PRIOR_INTERNSHIP, text)
    if prior:
        return "ineligible", "page requires a previous internship"
    fulltime = fulltime_ranges(text, this_year)
    if fulltime and not any(r[0] <= graduation_year <= r[1] for r in fulltime):
        return "ineligible", "page wants a full-time start " + _describe(*fulltime[0])
    if _first_hard(_RELATIVE_GRAD, text):
        return "ineligible", "page requires graduating within a year of the internship"
    standing = _first_hard(_STANDING, text)
    ranges = grad_ranges(text, this_year)
    if ranges:
        fits = [r for r in ranges if r[0] <= graduation_year <= r[1]]
        # A window that names his year outright wins; an open floor ("Dec 2027 or later") still loses to a standing rule.
        named = [r for r in fits if r[0] > 0 and r[1] < 9999]
        if named:
            return "ok", "page names graduation " + _describe(*named[0])
        if standing:
            return "ineligible", f"page requires \"{standing.group(0).strip()}\""
        if fits:
            return "ok", "page names graduation " + _describe(*fits[0])
        return "ineligible", "page requires graduation " + _describe(*ranges[0])
    if standing:
        return "ineligible", f"page requires \"{standing.group(0).strip()}\""
    if _UNDERCLASS.search(text):
        return "ok", "page mentions freshman/sophomore/underclassmen"
    upper = _first_hard(_UPPERCLASS, text)
    if upper:
        return "ineligible", f"page asks for {upper.group(1).lower()} students"
    return "unknown", "page says nothing about graduation year"


def load_cache(path: Path = CACHE_PATH) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_cache(cache: dict, path: Path = CACHE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(cache, indent=1, sort_keys=True), encoding="utf-8")


def check(listing: dict, graduation_year: int, cache: dict, allow_network: bool = True, today: date | None = None) -> dict:
    """Attach 'eligibility' and 'eligibility_note' to a listing. Uses the cache first, then the network.

    A stated deadline is kept in the cache and compared with today on every run, so a page read before its
    deadline still turns "closed" the day after, without waiting two weeks for the cache to expire."""
    today = today or date.today()
    url = listing.get("url", "")
    cached = cache.get(url)
    if cached and cached.get("v") == CACHE_VERSION and time.time() - cached.get("checked_at", 0) < CACHE_DAYS * 24 * 3600:
        listing["eligibility"], listing["eligibility_note"] = cached["verdict"], cached["note"]
        _apply_deadline(listing, cached.get("deadline"), today)
        return listing
    if not allow_network or not is_readable_board(url):
        listing["eligibility"], listing["eligibility_note"] = "unknown", "not checked (board can't be read server-side)" if not is_readable_board(url) else "not checked (network off)"
        return listing
    text = fetch_text(url)
    if text is None:
        # Not cached: one timeout should not lock a Tier 1 posting at "unknown" for two weeks.
        listing["eligibility"], listing["eligibility_note"] = "unknown", "page could not be read"
        return listing
    due = None
    if text == CLOSED:
        verdict, note = "closed", "the posting has been taken down"
    else:
        verdict, note = verdict_from_text(text, graduation_year)
        due = deadline(text, today)
    cache[url] = {"verdict": verdict, "note": note, "checked_at": int(time.time()), "v": CACHE_VERSION}
    if due:
        cache[url]["deadline"] = due.isoformat()
    listing["eligibility"], listing["eligibility_note"] = verdict, note
    _apply_deadline(listing, cache[url].get("deadline"), today)
    return listing


def _apply_deadline(listing: dict, due: str | None, today: date) -> None:
    if due and listing.get("eligibility") not in ("ineligible", "closed") and date.fromisoformat(due) < today:
        listing["eligibility"] = "closed"
        listing["eligibility_note"] = f"applications closed {date.fromisoformat(due).strftime('%B %-d, %Y')}"
