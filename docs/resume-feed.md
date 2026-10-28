# Let's Add to Your Resume: sources, terms, and setup

The owner's page at `/resume` lists hackathons near NJIT and certifications that fit the target roles, tracks each one
Interested, Signed up, Done, and keeps a list of ready-to-paste resume lines for everything marked Done. It is owner-only:
every `/resume` page and `/api/resume-*` route sits behind the owner's cookie, and a signed-in student is sent to their own
home page. No student dock link exists. Opening it to students later means moving state from KV to a D1 table shaped like
`tracks`; the rules in `worker/src/resumelogic.js` stay the same.

## Source audit (robots.txt and terms read on 2026-10-28; unclear counts as off)

| Source | robots.txt | Terms | Verdict |
|---|---|---|---|
| MLH season events (mlh.com/seasons/2027/events) | `Allow: /`; blocks only account, admin, API paths | Personal, non-commercial use of the content; no scraping clause found | **On, owner-only.** One request a day, facts only (name, dates, city, link back). Re-read the terms before this opens to students, because "personal, non-commercial" is the limit. |
| HackNJIT (hacknjit.org) | none (404) | no terms page | **On** as a pinned event: the page and its script are fetched once a day to confirm "November 21-22, 2026" is still there. The card says "checked on its site" or "check the site". Registration deadline is not published in a readable place, so it stays blank. |
| Email from ywcc@, ywcc-advising@, danello@njit.edu | n/a | mail sent to the owner | **On, owner-only.** Two routes, below. |
| Devpost | allows | Terms forbid using scripts or robots to "scrape" or "crawl" the site | **Off.** |
| Devfolio | allows | terms page is a script-only page that could not be read | **Off** (unclear). |
| Meetup | restricts some paths | terms returned 403 to an automated request | **Off** (unclear). |
| Luma | only Googlebot rules | "must not access the Service by any means other than our publicly supported interfaces" | **Off** for page reading. A calendar's own ICS subscription feed is a supported interface; add one if a useful NJ/NYC calendar turns up (none verified yet). |
| Eventbrite | blocks search and calendar URL patterns | the terms page fetched was the privacy policy; its public search API is gone | **Off** (unclear). |
| hackathon.com | allows | terms bar use "for commercial purposes or for personal gain" without permission | **Off** (a resume is arguably personal gain; unclear). |
| NJIT Highlander Hub (njit.campuslabs.com/engage) | `Disallow: /engage/api/` and `/api/`; the page itself is script-only | login for membership | **Off.** The only machine-readable route is disallowed. Club events arrive by email instead. |
| YWCC events and news (computing.njit.edu) | allows | none found | **Read, nothing to parse.** `/events` is prose with no dated events; `/news` named no hackathons. The monthly newsletter arrives by email. |
| Individual hackathon sites | varies | varies | Not crawled. Add one as a pinned entry in `config/hackathons.yaml` with a `verify_text`. |

Certification pages (AWS, Google Cloud, Microsoft Learn, GitHub, Coursera, Hugging Face) were each fetched once and
parsed for a price, hours, and offer sentence; their robots.txt files allow ordinary page reads. Nothing is read from
them except those few sentences, which are kept as evidence on each card.

## How prices are verified

`config/certs.yaml` holds names, links, role fit, and a "why" line, never a price. `scout/certs.py` reads the
provider's own page weekly, applies the cert's pattern, and stores the value with the sentence it matched and the time
it checked. If the page can't be read or the pattern stops matching, the value is blank and the card says "check
<provider>". A first run on 2026-10-28 verified: AWS Cloud Practitioner exam fee, Google Cloud Digital Leader exam fee,
the Google UX certificate's monthly price and hours, the Hugging Face courses being free, and the AWS Educate path being
free. It could not verify Azure Fundamentals or GitHub Foundations (script-rendered pages), so those cards link out.

## Reading the announcement emails (by pattern, never guessed)

`worker/src/mailparse.js` pulls out the name (the subject, minus filler like "Register Today for"), the event date, the
registration deadline ("applications close ...", "registration closes ..."), a `Location:` or `Where:` line, host
("hosted by", "is hosting"), travel help (only a sentence that says so), and the event's own link. Rules:

- A field the email doesn't state stays blank.
- A date with no year is accepted only when its weekday fixes the year ("Friday, November 6" is a Friday in 2026 only).
  Otherwise the words are kept as written and the event sorts last.
- Every card links back to its source email: a Gmail link when it came through the Gmail path, or the stored text at
  `/resume/mail/<id>` when it came through the email route.
- Mail from any address not on `mail_senders` is dropped before it is read or stored.

### Route A: Gmail, read-only, limited to those senders and one label

`scout/mailfeed.py`. Its only search is `(from:(the listed senders) OR label:scout-hackathons) newer_than:120d`; it
fetches only those messages and never lists or opens anything else. It uses Google's read-only scope; Google has no
narrower one, so the limit lives in that one file. Setup (you, once):

1. Google Cloud Console: new project, enable the Gmail API, configure the OAuth consent screen (External, add your NJIT
   address as a test user), create an OAuth client of type Desktop app, download its JSON to `me/gmail-client.json`.
2. `.venv/bin/python -m scout.mailfeed auth`. Your browser opens Google's page; sign in and click Allow. The refresh token is
   saved to `me/gmail-token.json` (gitignored). Nothing is typed into Scout or chat.
3. `.venv/bin/python -m scout.mailfeed pull --dry-run`, then `pull` to send the messages to the dashboard.

### Route B: Cloudflare Email Worker (forwarded mail)

Needs no Google grant at all. Mail is forwarded to an address on a domain whose email routing is in Cloudflare and arrives
in `email()` in `worker/src/index.js`. Two checks before anything is read: the envelope sender must equal the secret
`MAIL_FORWARDER`, and the From header must be a listed sender. Setup (you, once, after deploy):

1. Cloudflare dashboard, the domain, Email, Email Routing: enable it, add a custom address (for example `resume@`), action
   "Send to a Worker", pick `scout-dashboard`.
2. `cd worker && npx wrangler secret put MAIL_FORWARDER` and enter the address your forwards come from.
3. In Gmail, a filter for the three senders, "Forward it to" that custom address (Gmail asks you to confirm the forwarding address once).

Route B is the narrower of the two for privacy: only the forwarded messages ever leave the mailbox.

## Daily and weekly refresh

`python -m scout.feed` runs as a step in the hourly Actions job with `continue-on-error`. Hackathons refresh when the last
copy is over 20 hours old, certifications after about 6.5 days. A source that fails keeps its last good copy and shows
why under "where these come from". It writes `data/resume_feed.json` on the data branch and posts it to
`/api/ingest-resume` (same secret as the other uploads). Distance comes from `worker/src/places.json` (campus and city
centers) or one cached OpenStreetMap lookup per new city (one request a second, a real User-Agent, kept in
`data/geocache.json`).

## Where things are

- Python: `scout/hackathons.py`, `scout/certs.py`, `scout/feed.py`; config in `config/hackathons.yaml`
  and `config/certs.yaml`; tests in `tests/test_resume_feed.py`.
- Worker: `worker/src/resume.js` (page, API, ingest, email), `resumelogic.js` and `mailparse.js` (pure rules), `places.json`;
  tests in `worker/test/resume.test.mjs`.
- State: KV keys `resume:hackathons`, `resume:certs`, `resume:mail`, `resume:state`, `resume:settings`.
