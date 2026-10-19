# Running Scout

The commands and moving parts behind the README. Everything below assumes a Python 3.12 venv at `.venv/`.

## Folder layout

```
config/              targets.yaml, scoring.yaml, watch-pages.yaml (edit these, not code)
scout/               the Python code
scout/templates/     resume.html and letter.html, one-column ATS-safe layouts
tests/               unit tests on saved fixture JSON, no network
worker/              the Cloudflare Worker dashboard
docs/                screenshots, this file, design decisions, the reference report
.claude/commands/    /interview, /triage, /prep, /status for Claude Code
me/                  your master profile, voice rules, answer bank, resume variants   (gitignored; template in me.example/)
applications/        one folder per prep kit                                          (gitignored)
data/                runtime state; in GitHub Actions it is the "data" branch          (gitignored on main)
```

## The watcher

```bash
.venv/bin/python -m scout.watch                           # fetch both lists, print the top 20, write data/matches.json
.venv/bin/python -m scout.watch --top 50 --no-pages       # more rows, skip the page checks
.venv/bin/python -m scout.watch --offline tests/fixtures  # saved copies only, no network
.venv/bin/python -m unittest discover -s tests -t .       # the tests
```

Pipeline, in order: `listings.py` fetches the Simplify and vanshb03 JSON files, plus the intern, co-op, and fellowship postings on the company job boards named under `boards:` in `config/targets.yaml` (Greenhouse, Ashby, and Lever public APIs, read by `boards.py`), and normalizes every row; `matching.py` decides company tier, role, location, freshman-friendliness, and degree from `config/targets.yaml`; hard drops are inactive rows, non-2027 terms, graduate-only degrees or titles (Masters, MBA, PhD with no undergrad degree named), non-target roles (an exclude word like hardware drops a title even inside a freshman program, unless the title says software), postings whose every location is outside the US, citizenship-required postings when `us_citizen` is false, and postings older than 240 days (company board rows skip this, since a board lists only open jobs); `dedupe.py` collapses the same posting across both lists; `scoring.py` applies `config/scoring.yaml` and keeps the breakdown (a blank degrees field scores the same as Bachelor's listed, and Tier 1 and 2 postings never take the over-90-days penalty); `eligibility.py` reads the posting page for the top 40 rows and for every row that could push on its own (Tier 1 or 2, a freshman program, an ambassador role), looking for graduation windows ("between December 2027 and June 2028", "by June 2029", "2028 or later") and class-year requirements, cached 14 days. A page the board says is gone is labeled closed. Anything the posting rules out or that is closed sinks to the bottom, still labeled, and never pushes. Within the US, location only changes the score.

```
 1. [100] NVIDIA  |  Software Engineer Intern
      Santa Clara, CA  |  posted 10d  |  eligible: page mentions freshman/sophomore/underclassmen
      role swe 30 + tier 1 20 + early strong 45 + deg 5 + loc us 6 + fresh 0 + kw 0 = 100   (106, capped at 100)
```

## Alerts and the schedule

```bash
export NTFY_TOPIC=...                                  # the private topic; also a GitHub Actions secret
.venv/bin/python -m scout.run --mode test              # one test push
.venv/bin/python -m scout.run --mode watch --dry-run   # what a run would push, without sending
.venv/bin/python -m scout.run --mode watch --seed      # first run only: mark today's matches as seen
.venv/bin/python -m scout.run --mode digest --force    # send the digest now
.venv/bin/python -m scout.run --mode catchup --dry-run # preview the catch-up push; the real send runs only from
                                                       # the workflow (mode catchup), where data/ is the data branch
```

`--dry-run` saves nothing: no seen list, no matches.json, no eligibility cache, no page fingerprints. It still reads the lists and posting pages so the printout is real.

**Catch-up.** The first run's `--seed` marks every match as seen, so Tier 1 and 2 postings that were already open never alerted. `--mode catchup` (also the workflow's `mode` input: Actions, scout, Run workflow, mode `catchup`) sends one push listing the seeded postings that are still on the lists, Tier 1 or 2 or a freshman program, and not ruled out or closed by their page, best first. Each one listed is marked via `catchup` in `seen.json`. If they don't all fit in one ntfy message, the push says how many are left and the next catch-up run sends those; once nothing is left it says so.

- **Instant push:** a Tier 1 or Tier 2 posting scoring 60 or more, any freshman/sophomore program, any ambassador role, or a watched page that gained new text. Ineligible and closed postings never push. A posting whose page names your graduation year pushes at high priority; one whose page could not confirm it pushes quietly with "check the graduation year".
- **Daily digest:** the top 10 new matches that did not push instantly, once a day after 7:00 PM New York time.
- **Page watchers:** each page in `config/watch-pages.yaml` is fetched, stripped to text with volatile tokens (hashes, cloud region names, rotating job-carousel cards) removed, and hashed. Only new lines count as a change. Scout stores a fingerprint of each line, never the page text, so the repo does not republish anyone's page. A page that can't be read twice in a row, or serves no text, warns once.
- **Nothing twice:** `seen.json` holds every key ever pushed or digested, with how (`instant`, `digest`, `seeded`, `catchup`) and the posting URLs. A repost (same company and title, a new URL, posted after the last alert) alerts again.
- **Failing loudly:** if a source list can't be fetched, or the lists return less than half the rows of the last run, one push says so.
- **Schedule:** hourly at :17 except two early-morning hours. GitHub delays and skips scheduled runs when busy (4 of 22 ran on October 15, 2026), so the digest is a once-a-day check inside every run rather than its own schedule, and the dashboard Worker has its own cron at :47: if no run has reached the dashboard in 50 minutes it starts one through the GitHub API (`GH_DISPATCH_TOKEN`), and after 4 hours with no run it sends one warning push per outage (`NTFY_TOPIC`).
- **State:** the workflow checks out the `data` branch into `data/`, runs, and commits back to `data`, so `main` stays code only.

## Prep kits (Claude Code)

`/triage` reads the newest matches and recommends three or four. `/prep <key>` builds `applications/<company>-<role>/` with `resume.json` and its PDF, `cover-letter.md` and its PDF when the posting wants one, `answers.md`, `notes.md`, `posting.txt`, and `match.json`. A drafter writes from `me/master_profile.md` only; a separate reviewer agent checks every claim against the profile, the voice rules, and the posting's must-haves, and its flags go into `notes.md`. `/status <key> Applied` logs a submission, which is always done by hand.

```bash
.venv/bin/python -m scout.posting "<url>"                      # read a posting as text (Workday included)
.venv/bin/python scout/build_resume.py me/resumes/swe.json     # one-page PDF with an ATS text-layer check
.venv/bin/python scout/build_letter.py applications/<folder>/cover-letter.md
.venv/bin/python -m scout.tracker list
```

PDFs need `brew install pango poppler` and `pip install -r requirements-resume.txt`.

## Dashboard

```
GitHub Actions run --push-->  Worker + KV  <--taps--  phone (New, Programs, Tracker, Settings)
GitHub Actions run <--pull--  tracker, prep queue, passed keys
```

- `worker/src/index.js` is the whole app: routing, the password login (HMAC-signed cookie, 30 days), server-rendered pages, and small JSON endpoints for the buttons. `worker/src/tokens.css` holds every color and size.
- `scout/sync.py push` sends matches (with first-seen times), page state, the tracker, and the config text to `/api/ingest` with a secret header. `matches.json` keeps only the top 300 by score, so it also sends `total_matches`; the New page counts open matches from that total and says the list is ranked from the top 300. `scout/sync.py pull` fetches `/api/export` and writes the tracker, queue, and passed keys into `data/` (never committed). `scout/sync.py push --tracker-only` sends only `data/tracker.json` to `/api/ingest-tracker`; `/prep` and `/status` run pull, then the tracker change, then this, so the dashboard updates at once and a full push from the Mac (whose matches are an old copy) is never needed.
- "Prep this" queues a posting for `/prep`; "Pass" hides it (with undo).
- **Review** shows every prep kit, uploaded from the Mac with `scout.sync push --kits` (kits hold the candidate's phone, email, and answers, so they live only in the Worker's KV behind the password, never in git). Each answer and the cover letter is an editable box with a save button; the resume and letter PDFs open from the page; "I submitted it" marks the posting Applied. `scout.sync pull` writes saved edits back into `applications/<kit>/` and rebuilds an edited cover letter's PDF, and an upload from the Mac never replaces an answer edited on the phone after the Mac's copy was saved. Scout still never submits anything. Tracker edits from the phone win over older ones by date.
- Worker secrets: `DASH_PASSWORD`, `SESSION_SECRET`, `INGEST_SECRET`, and for the heartbeat cron `GH_DISPATCH_TOKEN` (a fine-grained token for this repo only, Actions read and write) and `NTFY_TOPIC`. Repo secrets: `NTFY_TOPIC`, `SCOUT_URL`, `SCOUT_INGEST_SECRET`.

```bash
cd worker && npm install && npx wrangler deploy
cp .dev.vars.example .dev.vars && npx wrangler dev     # local copy with test values
```

## Cost

$0. Public repos get unlimited Actions minutes; each run takes about a minute, about 22 a day (roughly 660 minutes a month, inside the 2,000 free minutes even if the repo goes private). Cloudflare Workers and KV free tier: 100,000 requests a day. ntfy is free.
