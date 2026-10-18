# Thumbs up / thumbs down on matches

**Idea:** on every match in the dashboard, a thumbs up or thumbs down. Scout learns which internships Jeremiah actually likes and which he doesn't, and ranks future matches with that in mind.

## Why

Scoring today is fixed rules in `config/scoring.yaml`. The rules are good, but they can't tell that he keeps passing on a certain kind of role or company and keeps saving another. His reactions are the best signal Scout isn't using yet.

## First sketch

- Two small buttons on each match card (New page): thumbs up and thumbs down. "Pass" already exists; thumbs down could replace or sit beside it.
- Each tap is stored in Workers KV with the match's features: company, tier, role category, title keywords, location, and eligibility signals.
- On each run, the watcher reads the feedback (pulled down like tracker updates) and turns it into small, visible score adjustments. Examples: "+6 because you liked 3 design roles at similar companies", "-8 because you passed on 4 IT support roles".
- It stays rules-only, with no AI in the hourly cron (a hard rule). It's just counting and weighting, so it's free and explainable.
- The score breakdown shows the learned part as its own line, so he can always see why.
- A Settings view lists what Scout has learned, with a way to undo any of it.

## Open questions

- Should a thumbs down hide the match, or just lower similar ones?
- How strong should learning be, so a few taps don't drown out eligibility (still the most important filter)?
- Should a thumbs up also add it to Saved in the tracker?
