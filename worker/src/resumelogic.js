/* "Let's Add to Your Resume": the pure parts. Distance, the 7-day flag, sorting, chips, and the resume lines.
 * No I/O here, so test/resume.test.mjs can run every rule. resume.js does the storage and the page.
 */

import placesData from "./places.json" with { type: "json" };

export const STATES = ["Interested", "Signed up", "Done"];
export const ROLE_LABELS = { swe: "SWE", pm: "PM", itcs: "IT/CS", ux: "UX" };
export const DEFAULT_RADIUS = 50;
export const FLAG_DAYS = 7;
const DAY = 86400000;

export const miles = (lat1, lon1, lat2, lon2) => {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
};

/** The known campus or city a text names, longest alias first ("UConn Stamford" beats "Stamford"). */
export function findPlace(text, places = placesData.places) {
  const hay = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9, ]+/g, " ")} `;
  let best = null;
  let bestLen = 0;
  for (const p of places) {
    for (const alias of p.aliases) {
      if (alias.length > bestLen && new RegExp(`(?<![a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(hay)) { best = p; bestLen = alias.length; }
    }
  }
  return best;
}

const dayNumber = (iso) => (iso ? Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY) : null);
/** Whole days from `today` (YYYY-MM-DD) to `iso`; negative = past; null = no date. */
export const daysUntil = (iso, today) => (iso ? dayNumber(iso) - dayNumber(today) : null);

export const todayET = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const keyOf = (e) => `${norm(e.name).replace(/ 20\d\d$/, "")}|${(e.start || "").slice(0, 4)}`;

/** Merge feed events and email events into one list, one card per event; the feed's fields win, blanks fill from email. */
export function mergeEvents(feedEvents, mailEvents) {
  const byKey = new Map();
  for (const e of feedEvents) byKey.set(keyOf(e), { ...e, sources: [e.source] });
  for (const e of mailEvents) {
    const have = byKey.get(keyOf(e)) || [...byKey.values()].find((x) => norm(x.name) === norm(e.name));
    if (have) {
      for (const f of ["deadline", "deadline_text", "travel", "location", "date_text"]) if (!have[f] && e[f]) have[f] = e[f];
      have.mail = have.mail || e.mail;
      if (!have.sources.includes("email")) have.sources.push("email");
    } else byKey.set(keyOf(e), { ...e, sources: ["email"] });
  }
  return [...byKey.values()];
}

/** Add distance, days to deadline, and the 7-day flag. home = { lat, lon }. */
export function decorate(events, { home, today, schoolAliases = [] }) {
  return events.map((e) => {
    const place = (e.lat == null || !e.host) ? findPlace(`${e.name} ${e.host || ""} ${e.location || ""}`) : null;
    const lat = e.lat != null ? e.lat : place ? place.lat : null;
    const lon = e.lon != null ? e.lon : place ? place.lon : null;
    const host = e.host || (place && place.school ? place.name : "");
    const distance = lat != null ? Math.round(miles(home.lat, home.lon, lat, lon)) : null;
    const dl = daysUntil(e.deadline, today);
    const hay = norm(`${e.host || ""} ${host} ${e.name} ${e.location || ""}`);
    const mine = schoolAliases.some((a) => hay.includes(norm(a)));
    return { ...e, lat, lon, host, distance, deadlineIn: dl, soon: dl != null && dl >= 0 && dl <= FLAG_DAYS, mine, startIn: daysUntil(e.start, today), endIn: daysUntil(e.end || e.start, today) };
  });
}

/** Past events out; chip "mine" keeps the home school's; "nearby" keeps those inside the radius (unknown distance stays out). */
export function visible(events, { chip, radius }) {
  return events.filter((e) => {
    if (e.endIn != null && e.endIn < 0) return false;  // over already
    if (chip === "mine") return e.mine;
    return e.distance != null && e.distance <= radius;
  });
}

/** Soonest registration deadline first; no deadline listed goes after, by event date; no date at all goes last. */
export function sortEvents(events) {
  const rank = (e) => (e.deadlineIn != null && e.deadlineIn >= 0 ? 0 : e.startIn != null ? 1 : 2);
  return [...events].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 0 ? a.deadlineIn - b.deadlineIn : 0)
    || (a.startIn ?? 1e9) - (b.startIn ?? 1e9) || a.name.localeCompare(b.name));
}

/** "Fall 2026"-free year for a resume line: the year of the event, else of the date marked done. */
const yearOf = (iso) => (iso ? String(iso).slice(0, 4) : "");

/** The ready-to-use line for a Done hackathon. Never claims more than the owner typed (a project name). */
export function hackathonLine(event, project, doneAt) {
  const name = String(event.name || "").trim();
  const year = yearOf(event.start) || yearOf(doneAt);
  const label = /\b20\d\d\b/.test(name) || !year ? name : `${name} ${year}`;
  const p = String(project || "").trim().replace(/^\[|\]$/g, "");
  return p ? `Built ${p} at ${label}` : `Participated in ${label}`;
}

/** The ready-to-use line for a Done cert, from its template ({year} = the year it was marked done). */
export function certLine(cert, doneAt) {
  return String(cert.resume_line || `${cert.name}, {year}`).replace("{year}", yearOf(doneAt));
}

/** Whose roles a cert helps, as labels. */
export const roleLabels = (roles) => (roles || []).map((r) => ROLE_LABELS[r]).filter(Boolean);
