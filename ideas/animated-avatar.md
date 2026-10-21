# An animated avatar for Scout

**Status (2026-10-20):** a borrowed panda fills this role for now. It lives only in the dashboard's KV, never in this repo, and comes off with `python -m scout.sync push --mascot --remove`. Its moods map to the states below: celebrating when new matches drop, napping when nothing changed, a side-eye when a watched page changed, proud once applications are in, and a wave on the login page.

**Idea:** give Scout a character: a small animated avatar that lives in the dashboard and gives the app personality.

## Why

The dashboard works, but it's all cards and numbers. A friendly animated mascot makes it feel like a product, gives empty and loading states something to show, and is a strong design piece for his portfolio.

## First sketch

- Start from Scout's existing brand: the "scout" wordmark with the bullseye "o" (gold #ffc93c ring, navy #1a1333, cream #f6f9dc, Titan One).
- Design the character around the bullseye, for example a scout or a target with eyes, so it's clearly the same brand.
- Animated states:
  - idle (blinks, small breathing motion)
  - searching (while matches load or the watcher runs)
  - excited (a strong match or an early-career program dropped)
  - celebrating (an application marked Applied, an OA or an interview)
  - sleepy (nothing new today)
- Where it appears: the dashboard header, empty states, the loading screen, ntfy notification icons, and the Review page.
- Tools, all free:
  - SVG plus CSS animation for the simplest version
  - Rive (free tier) or Lottie for richer motion
  - keep it small and respect reduced motion

## Open questions

- Cute mascot, or sleek and minimal?
- Does it have a name?
- Should it react to his thumbs up / thumbs down (see [thumbs-feedback.md](thumbs-feedback.md))?
