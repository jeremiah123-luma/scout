# Review checklist

Run through this before anything ships. It's short on purpose: each line is something that has gone wrong in a web app like this one, Scout included. Ideas drawn from the checklists in the ECC project (github.com/affaan-m/ECC), rewritten for Scout.

## Security
- Every page and API route checks who is asking before it reads anything: the owner cookie, a student cookie, or the cron's secret. Student routes filter every query by that student's id; one student asking for another's row gets a 404.
- Every D1 query is `prepare(...).bind(...)`. No string-built SQL.
- Everything put into HTML goes through `esc()`. Links go through `safeUrl()` so a `javascript:` URL never becomes an `href`.
- Every POST comes from Scout's own pages (Origin check) and the student APIs need the `x-scout` header, which a form on another site can't send.
- Logins are rate limited per IP, per email and IP, and per email, so guessing is slow and nobody can lock someone else out with a few tries.
- Secrets live in Wrangler secrets and GitHub secrets, never in the repo. `git grep` for keys before every push.

## Correctness
- Pure logic lives in modules with no Worker imports (`worker/src/match.js`) and has tests (`cd worker && npm test`). Python rules have tests in `tests/` (`.venv/bin/python -m unittest discover -s tests`).
- When the same rule exists in Python and JavaScript, one generates fixtures for the other (`worker/test/fixtures/verdicts.json`).
- Test the edges: empty, missing, too long, special characters, the same request twice, and two people at once.
- No silent failures: a `catch` either recovers on purpose (with a comment saying why) or tells someone.

## Every screen, every state
Check each page in each state before calling it done:

| State | What the student should see |
|---|---|
| Loading | Nothing jumps; server-rendered pages arrive whole |
| Empty | A panda, one sentence on why it's empty, and the one thing to do next |
| Error | Plain words on what happened and how to fix it, next to what failed |
| Partial | What's there, and an honest note about what isn't (no facts yet, list capped) |
| Success | Quiet confirmation in place ("saved ✓"), no pop-ups |
| Not allowed | A redirect to where they belong, never someone else's data |

## Accessibility
- Every input has a label (visible, or `.sr` for a screen reader only).
- Icon-only buttons have an `aria-label`. Nothing clickable is a `div`.
- Focus is visible on every control. Touch targets are at least 44px on a phone.
- Text meets 4.5:1 contrast on its background.
- Motion respects `prefers-reduced-motion`.

## Before it ships
1. Both test suites pass, and `node --check` passes on every worker file.
2. The end-to-end run (two students, sign-up to delete) passes against `wrangler dev`.
3. Screenshots at 390px and 1440px for every changed page, checked by eye.
4. `git diff` read top to bottom.
