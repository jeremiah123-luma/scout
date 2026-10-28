/* Hackathon announcements out of plain email text, by pattern. Pure functions, no I/O (tested in test/resume.test.mjs).
 *
 * The rule here is "blank beats wrong". A field the email doesn't state stays null. A date with no year is only
 * accepted when its weekday names the year ("Saturday, November 8" is a Saturday in exactly one of the next two
 * years); otherwise the date is kept as the words the email used (date_text) and left unsorted.
 * Email text is untrusted: it is searched for fields, never followed or executed.
 */

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DAY_RE = "(Sun(?:day)?|Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:rs(?:day)?)?|Fri(?:day)?|Sat(?:urday)?)";
// [weekday,] Month D[-D | - Month D][, YYYY]
const DATE_SRC = `(?:${DAY_RE}\\.?,?\\s+)?${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*(?:-|–|—|to|through)\\s*(?:${MONTH_RE}\\.?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s*(20\\d\\d))?`;
const TRAVEL_RE = /[^.\n]*\b(?:travel (?:reimbursement|stipend|grants?|support|funding)|reimburs\w+|(?:free )?(?:bus(?:es)?|shuttle|transportation) (?:will be )?(?:provided|available|from)|transportation (?:provided|available))\b[^.\n]*/i;
const SKIP_URL = /unsubscribe|mailto:|facebook\.com|twitter\.com|x\.com\/|linkedin\.com\/(?:company|in)|instagram\.com|list-manage|mailchi|constantcontact|google\.com\/(?:maps|calendar)|\.(?:png|jpe?g|gif)(?:\?|$)/i;

const monthIndex = (s) => MONTHS[s.slice(0, 3).toLowerCase()];
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const weekdayOf = (y, m, d) => new Date(Date.UTC(y, m, d)).getUTCDay();

// Which date (ISO) a match names, or null. `sent` is the email's own date.
function resolve(m, sent) {
  const [, wd, mon1, d1, mon2, d2, yr] = m;
  const monthA = monthIndex(mon1);
  const dayA = +d1;
  const monthB = mon2 ? monthIndex(mon2) : monthA;
  const dayB = d2 ? +d2 : dayA;
  const sentDate = sent ? new Date(sent) : null;
  let year = yr ? +yr : null;
  if (!year && wd && sentDate && !Number.isNaN(+sentDate)) {
    const want = WEEKDAYS[wd.slice(0, 3).toLowerCase()];
    const floor = +sentDate - 7 * 86400000;
    const fits = [sentDate.getUTCFullYear(), sentDate.getUTCFullYear() + 1].filter(
      (y) => weekdayOf(y, monthA, dayA) === want && Date.UTC(y, monthA, dayA) >= floor);
    if (fits.length === 1) year = fits[0];
  }
  if (!year) return { start: null, end: null };
  if (monthA > 11 || dayA < 1 || dayA > 31) return { start: null, end: null };
  const endYear = monthB < monthA ? year + 1 : year;
  return { start: iso(year, monthA, dayA), end: iso(endYear, monthB, dayB) };
}

const words = (m) => m[0].replace(/\s+/g, " ").trim();

// The registration deadline: a phrase like "register by", "registration closes", "apply by", or "deadline:" followed by a date.
function findDeadline(text, sent) {
  const re = new RegExp(`(?:regist\\w*|appl\\w*|sign[- ]?ups?|RSVP|deadline)[^.\\n]{0,40}?(?:closes?|due|deadline|by|until|ends?|before|is)?\\s*[:\\-]?\\s*(?:on\\s+)?(${DATE_SRC})`, "i");
  const hit = [...text.matchAll(new RegExp(re.source, "gi"))].find((x) => /(?:closes?|due|deadline|by|until|ends?|before)/i.test(x[0].slice(0, x[0].indexOf(x[1]))));
  if (!hit) return null;
  const inner = new RegExp(DATE_SRC, "i").exec(hit[1]);
  const r = inner ? resolve(inner, sent) : { start: null };
  return { deadline: r.start, text: inner ? words(inner) : null, span: [hit.index, hit.index + hit[0].length] };
}

function findDate(text, sent, skipSpan) {
  const re = new RegExp(DATE_SRC, "gi");
  for (const m of text.matchAll(re)) {
    if (skipSpan && m.index >= skipSpan[0] && m.index < skipSpan[1]) continue;
    const r = resolve(m, sent);
    return { ...r, text: words(m) };
  }
  return null;
}

// The event's own link. Mailing-list plumbing (view online, preferences, opt out, "got this as a forward") never counts;
// a link after "website" or "more information" beats one after "register", which beats any other.
function findUrl(text) {
  let best = null;
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"']+/g)) {
    const u = m[0].replace(/[.,;:!?\]]+$/, "");
    const before = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
    if (SKIP_URL.test(u) || /e2ma\.net\/(?:message|optout)|\/audience\/|\/unsubscribe/i.test(u)) continue;
    if (/view this email|paste this link|manage your preferences|opt out|got this as a forward/.test(before)) continue;
    const score = /website|visit|more information|details/.test(before) ? 3 : /regist|apply|sign up|rsvp/.test(before) || /hack|devpost|mlh|luma|lu\.ma|eventbrite/i.test(u) ? 2 : 1;
    if (!best || score > best.score) best = { u, score };
  }
  return best ? best.u : null;
}

function cleanSubject(subject) {
  return String(subject || "").replace(/^(?:\s*(?:fwd?|re|fw)\s*:\s*)+/i, "").replace(/^\s*\[[^\]]{1,30}\]\s*/, "").replace(/\s+/g, " ").trim();
}

// A subject like "Register Today for GirlHacks!" or "UConn Hackathon - TOMORROW 10/21" is the event's name plus filler.
function subjectName(subject) {
  return subject
    .replace(/^(?:(?:last chance|reminder|register|apply|sign up|join us)\b[^A-Za-z0-9]*(?:today|now)?\s*(?:for|to|at)?:?\s+)+/i, "")
    .replace(/\s*[-–—|]\s*(?:tomorrow|today|this \w+|reminder|register\b|applications?\b|deadline\b)[^]*$/i, "")
    .replace(/[\s!.]+$/, "").trim();
}

// "hosted by NJIT's Women in Computing Society" or "Kean University is hosting KeanUHackThis".
function findHost(text) {
  const a = /(?:hosted by|co-hosted by|organized by)\s+([A-Z][^.,;()\n]{2,70}?)(?=[.,;(\n]|\s+and\s|\s+for\s|$)/.exec(text);
  if (a) return a[1].trim();
  const b = /([A-Z][\w&'’-]*(?:\s+[A-Z][\w&'’-]*){0,4}) is hosting/.exec(text);
  return b ? b[1].trim() : null;
}

// "Join us for SBUHacks 2026!" -> "SBUHacks 2026"; a subject that is only a headline falls back to a name in the body.
function eventName(subject, body) {
  const NAME = /\b((?:[A-Z][\w@&'’.-]*\s+){0,3}(?:[A-Z][\w@&'’-]*)?(?:Hack[A-Z]\w+|Hack(?:athon|s|ers|ing)?|HackTheNorth)\b(?:\s+(?:20\d\d|[IVX]+|\d+\.\d))?)/;
  for (const src of [subject, body.slice(0, 600)]) {
    const m = NAME.exec(src);
    if (m) {
      const name = m[1].replace(/^(?:Join|Our|The|At|For|And|To|A|An|This|Next)\s+/i, "").trim();
      if (name.length >= 4) return name;
    }
  }
  return null;
}

/** Events in one email: [] when it isn't about a hackathon. msg: { id, from, subject, date, text }. */
export function parseHackathonMail(msg) {
  const subject = cleanSubject(msg.subject);
  const text = String(msg.text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ");
  const blocks = text.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  const hackBlocks = blocks.filter((b) => /hack/i.test(b));
  if (!/hack/i.test(subject) && !hackBlocks.length) return [];

  // One announcement: the whole email is the event. A digest (several hackathon paragraphs under a non-hackathon
  // subject, like a monthly newsletter) yields one event per paragraph that names one.
  const single = /hack/i.test(subject);
  const units = single ? [{ name: subjectName(subject) || eventName(subject, text), body: text }]
    : hackBlocks.map((b) => ({ name: eventName("", b), body: b })).filter((u) => u.name);
  const seen = new Set();
  const out = [];
  for (const u of units) {
    if (!u.name || seen.has(u.name.toLowerCase())) continue;
    seen.add(u.name.toLowerCase());
    const dl = findDeadline(u.body, msg.date);
    const when = findDate(u.body, msg.date, dl && dl.span);
    const loc = /(?:Location|Where|Venue)\s*:\s*([^\n]{3,90})/i.exec(u.body);
    const travel = TRAVEL_RE.exec(u.body);
    out.push({
      name: u.name.slice(0, 120),
      start: when ? when.start : null,
      end: when ? when.end : null,
      date_text: when ? when.text : null,
      deadline: dl ? dl.deadline : null,
      deadline_text: dl ? dl.text : null,
      host: findHost(u.body),
      location: loc ? loc[1].trim() : null,
      travel: travel ? travel[0].trim().slice(0, 160) : null,
      url: findUrl(u.body),
    });
  }
  return out;
}
