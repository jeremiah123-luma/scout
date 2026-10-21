# Scout brand

How Scout looks and sounds. The code that carries it: `worker/src/tokens.css` (colors and sizes), `worker/src/theme.js` (the themes, the art, the job card), and `worker/art/scene.py` (the Blender art).

## Voice
- Lowercase, short, plain. "good morning, maya." "save a posting on new." No exclamation points in body copy; the "fresh!" tape is the one place one appears.
- Says what happens next, not how it works inside. "it lands in your tracker" beats "added to tracker database".
- No em dashes anywhere.
- Scout never applies for you, and the copy never implies it: "you always click submit."

## Themes
Three themes, one per time of day. The app follows the clock where the student is (light from 7:00 AM to 6:59 PM, dark after) until they pick one with the ◐ button in the header.

| Theme | Page | Text on the page | The art |
|---|---|---|---|
| light | orange to peach to lavender to sky blue, top to bottom | navy `#1a1333` | a sun rising out of the top-right corner, soft rays turning once every 3 minutes |
| sky | dusty blue `#9fb6d6` to pink `#e9d6e0` | deep blue `#1d3d6e` | soft clouds drifting up a little slower than the page |
| dark | navy `#1a1333` to purple to deep teal `#0e3a44` | cream `#f6f9dc` | a navy and cream lighthouse at the bottom-right of the page, its beam sweeping slowly. On a phone the tower goes and its night stays: faint stars, the lamp's glow from the corner, the beam, and the rocks and sea |

The landing page, log in, sign up, and the sign-up questions wear the themes too.

## Color
- Navy `#1a1333`: outlines and text on cream. Cream `#f6f9dc`: cards. Gold `#ffc93c`: the one main action on a card (save, prep) and the logo's bullseye.
- Cards are cream glass: about 90% opaque, a soft blur behind them, a bright edge along the top. On light they keep the navy outline and a hard 4px shadow; on sky and dark they float on a soft shadow.
- Frames say why a posting matters, never how high it scored:
  - **dream company**: a rainbow ring (one of the companies they picked)
  - **big hitter**: a purple ring (big tech, or a company they're excited about)
  - **freshman program** or **fellowship**: an orange ring
  - The label sits first in the card's tag row, in the frame's colors. The higher frame wins. Rings stay still until you point at the card; then the rainbow turns and the purple and orange glint.

## Type
| Use | Font |
|---|---|
| the wordmark | Titan One |
| big headlines and the name in the greeting | Bowlby One (sky uses Fredoka for the name) |
| the greeting's first line, scores, small notes | Patrick Hand |
| buttons, nav, card titles, tags | Fredoka |
| body text and details | Rubik |
| the "fresh!" tape | Coming Soon (the "!" is Fredoka, since Coming Soon draws it like an "l") |
| company names | each company's brand font, or the closest free one (Meta in Figtree, Figma in Inter, IBM in IBM Plex Sans) |

All of them are free Google Fonts. Fonts that are free only for personal use (Handodle, Scribble Marker) can't be used, since Scout is a public site.

## Pieces
- **Nav**: text tabs (new, tracker, you); the page you're on sits in a rounded pill.
- **Views**: a row of pills with counts, the one you're on filled.
- **Job card**: logo, company name in its own type, title (links to the posting), place and age, tags, then save and pass, then the score in a rounded box. On a phone, save and pass drop under the tags.
- **"fresh!" tape**: a small strip of see-through washi tape over a card's top-right corner, for postings that arrived since your last visit or in the last day. Every strip gives one shake when the page opens.

## Motion
- Slow and rare. Nothing loops fast: the sun's rays turn once in 3 minutes, the beam sweeps once in 14 seconds, frames move only on hover.
- Everything stops for people who turn on reduced motion.

## Art
- The sun and the lighthouse are modeled for Scout in Blender (`worker/art/scene.py`) and served as small WebP files. The clouds are drawn in code. None of it needs credit.
- No mascot for now. The panda was borrowed from another project and was retired on October 21, 2026. Small Scout-owned art for the empty states and the welcome note is in the works; until then those moments are words only.
