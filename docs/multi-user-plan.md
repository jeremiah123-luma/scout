# Scout for other people: the plan

Status: U0 to U5 and U7 built on the multi-user branch, 2026-10-21. U6 (fields beyond tech) is dropped: Scout is for college students in tech, freshman year and up.

## Decisions so far
- **Sign up, then a long set of questions.** Right after someone makes an account, Scout asks everything it needs to find the right jobs for them: major, year, where they want to work, what roles, what companies. Their answers become their settings. Nobody edits YAML.
- **Each user brings their own Claude Code.** Finding, scoring, alerts, and the dashboard are shared and free. Building prep kits (resume, cover letter, answers) runs in the user's own Claude Code on their own computer, against their own copy of their profile. Scout never pays for AI and never stores a resume it didn't need to.
- **It still costs nothing to run.** Cloudflare Workers, D1 (its free SQL database), and KV on the free tier; one GitHub Actions job fetches the public lists for everyone.

## How it fits together
```
GitHub Actions (hourly, one job for everyone)
  fetch the lists and boards once -> normalize -> read each posting page once
  -> store posting FACTS (grad years, degree level, class standing, closed, location, term)
                    |
                    v
Cloudflare Worker + D1 (free)
  accounts, sign up, the questions, each user's settings
  score every posting against each user's settings (cheap math, no AI)
  each user's New / Programs / Review / Tracker pages
  each user's alerts (their own ntfy topic, later web push)
                    |
                    v
The user's own Claude Code (their subscription)
  /prep <posting> pulls the posting and their profile, builds the kit locally,
  uploads it to their Review page
```
The key change from today: page checks store facts about a posting ("asks for 2028 graduates", "PhD only"), not a verdict against one person's graduation year. Each user's verdict is computed from those facts and their answers.

## The questions (asked right after sign up)
Each question says why it is asked. Every answer can be changed later on the "you" page. Questions marked **(required)** have to be answered before the first matches show.

**About you**
1. Name you go by (required)
2. School (required), or "not in school"
3. Degree you're working on: associate, bachelor's, master's, PhD, bootcamp, none (required)
4. Major (required), and a second major or minor
5. Year in school: first, second, third, fourth, fifth or more, recent grad (required)
6. Expected graduation month and year (required): this decides most eligibility rules
7. GPA (optional, kept private, only used when a posting has a cutoff)
8. Are you open to roles for a different major than yours?

**Work authorization**
9. Are you authorized to work in the US? (required)
10. Will you need visa sponsorship now or later? (required)
11. US citizen? (some defense and government roles require it)
12. Willing to get a security clearance?

**What you want**
13. Internship, co-op, part-time during school, new grad full-time, fellowship, research (pick all) (required)
14. Which seasons: summer, fall, winter, spring, year-round (required)
15. Fields (pick all, then your top one): software engineering, product management, data and analytics, AI/ML, design (UX/UI, product), IT and support, cybersecurity, hardware, quant and finance, consulting, marketing, business and operations, research, plus "other" (required)
16. Roles that sound right (for example front end, iOS, data analyst)
17. Words that should never show up (for example "sales", "unpaid")
18. Paid only?

**Where**
19. Cities or regions you'd most like (type them) (required)
20. Willing to relocate? Anywhere in the US, only some places, no
21. Remote: prefer, fine, avoid
22. Outside the US: no, yes (which countries)

**Companies**
23. Dream companies (search and pick): these get instant alerts
24. Companies you're excited about: second tier
25. Company size you like: startup, mid-size, big tech, no preference
26. Industries you care about: for example health, climate, gaming, finance, government, education
27. Companies to never show

**Early-career programs**
28. Want freshman and sophomore programs, fellowships, ambassador programs, hackathons and competitions? (pick all)
29. Programs you already know you want (for example Microsoft Explore, MLH Fellowship)

**Alerts**
30. How fast: every strong match right away, a daily digest, or a weekly digest
31. What counts as "strong" for an instant alert: dream companies only, or any high score
32. Digest time and time zone
33. Quiet hours
34. Where: phone app (ntfy), email, or both

**Your background (used for scoring and by your own /prep)**
35. Skills and tools you know (pick and add)
36. Past jobs, internships, projects (short list; the full profile lives in your own Claude Code)
37. Links: LinkedIn, GitHub, portfolio
38. Languages you speak

**Applying**
39. How many applications a week you're aiming for (sets a goal on the Tracker)
40. What do you want help with: tailored resumes, cover letters, short answers?

## Milestones (one at a time, an OK between each)
- **U0, posting facts.** Page checks save facts about each posting instead of a verdict for one person, and today's verdicts become a function of those facts plus a profile. Jeremiah's dashboard keeps working on top of it. *(M)*
- **U1, accounts.** Sign up and log in with email and password, password reset, rate limits, per-user data in D1. Jeremiah's data moves into the first account. *(L)*
- **U2, the questions.** The onboarding flow above, a "you" page to review and edit every answer, and answers stored as each user's settings. *(M)*
- **U3, per-user scoring and pages.** The shared fetch runs once; every user gets their own New, Programs, Review, and Tracker. *(L)*
- **U4, per-user alerts.** Each user's ntfy topic or email, digest time, quiet hours, unsubscribe. *(M)*
- **U5, bring your own Claude Code.** A small public repo with `/setup` (links Claude Code to their Scout account with a token), `/interview` (builds their master profile locally), and `/prep`. Kits upload to their Review page. *(M)*
- **U6, beyond tech.** Sources and role words for other majors, since the current lists are mostly tech. *(L)*
- **U7, trust.** Privacy policy and terms, delete-my-account and export, encryption for anything personal, a check of each source's terms of use. *(M)*

## Before any of this
The repo is public, and a few things in it are about Jeremiah specifically (see the readiness review, Oct 20). Those get cleaned up first, so a new user's first look at the code doesn't show his personal details.

## What U0 to U2 built (local only, 2026-10-20)
- **U0:** page checks save facts about each posting; each person's verdict is computed from those facts and their profile (`scout/eligibility.py`).
- **U1:** sign up and log in with email and password, a signed cookie, and a lockout after 8 failed tries in 15 minutes (`worker/src/accounts.js`). Password reset needs an email sender and is not built. The owner still logs in with the dashboard password alone.
- **U2:** the 9 steps of questions, a live count of fitting postings from step 4, and a "you" page that ends on a first look at real postings, with every answer editable and a delete-my-account button.
- **Landing page** (`worker/src/landing.js`): public, explains why Scout exists, with numbers from the last run.
- **Before deploying:** create the D1 database (`npx wrangler d1 create scout-users`) and put its id in `worker/wrangler.toml`; keep the landing page's alert and prep claims in step with U4 and U5.

## What U3 to U7 built (2026-10-21)
- **U3:** every student gets their own New page (`worker/src/student.js`): the shared postings judged and scored for them by `worker/src/match.js`, with views, save, and pass. Their tracker lives in D1.
- **U4:** phone alerts through each student's own ntfy topic, from the Worker's hourly cron: instant pings for strong matches by their own rule, or a daily or weekly digest at their hour, never in their quiet hours. Email alerts are out (no free sender).
- **U5:** instead of a separate repo, each tracker row has a prep prompt for the student's own Claude Code (or Claude): the posting, their answers, and Scout's rules (never invent, say what's missing, apply yourself). Their resume never comes to Scout.
- **U7:** a privacy page, download my data, delete my account, security headers, same-origin POSTs, and rate-limited logins. Password reset still needs an email sender.
- **Audience:** the questions are now for college students in tech, freshman year and up, and the company questions pick from logos.
