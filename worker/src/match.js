/* Matching for students with accounts (multi-user plan, U3 and U4). Pure functions only: no KV, no D1, no fetch,
 * so `node --test worker/test` can check every rule without a Worker.
 *
 * The cron reads each posting page once and saves its facts (scout/eligibility.py facts_from_text). Here those
 * facts are judged for one student (verdict, a port of verdict_from_facts), and the posting is scored from that
 * student's answers to the sign-up questions (score, the same shape as config/scoring.yaml). The owner's own
 * pages keep using the cron's verdicts and scores.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const YEAR_IN_SCHOOL = { first: 1, second: 2, third: 3, fourth: 4, "fifth or more": 4, "recent grad": 5 };

// The answers, reduced to what the eligibility rules and the scorer need.
export function profileFrom(answers, today = new Date()) {
  const a = answers || {};
  const [month, year] = String(a.grad || "").toLowerCase().split(" ");
  const gradYear = Number(year) || today.getFullYear() + 4;
  const yearInSchool = YEAR_IN_SCHOOL[a.year] || yearFromGrad(gradYear, today);
  return {
    gradYear,
    gradMonth: Math.max(1, MONTHS.indexOf(month) + 1),
    yearInSchool,
    degree: String(a.degree || "bachelor's").toLowerCase(),
    enrolled: a.year !== "recent grad",
    pastInternship: /\bintern/i.test(String(a.experience || "")),
    cycleYear: today.getMonth() >= 7 ? today.getFullYear() + 1 : today.getFullYear(), // August on: next summer
    citizen: a.citizen || "",
    authorized: a.authorized || "",
    sponsorship: a.sponsorship || "",
  };
}

// 1 for a first-year ... 4 for a senior. The school year turns over in August, as in scout/eligibility.py.
export function yearFromGrad(gradYear, today = new Date()) {
  const ends = today.getMonth() >= 7 ? today.getFullYear() + 1 : today.getFullYear();
  return Math.max(1, Math.min(4, 4 - (gradYear - ends)));
}

// The year in school a class-standing rule needs, as in standing_min_year.
export function standingMinYear(phrase) {
  const low = String(phrase).toLowerCase();
  if (/junior or senior|junior\/senior|juniors and seniors|third[- ]year or fourth|third or fourth/.test(low)) return 3;
  if (/\b(senior|four|4)\b/.test(low)) return 4;
  if (/\b(junior|three|3)\b/.test(low)) return /complet|minimum|at least|years? (?:of|towards?|toward)/.test(low) && !/at least an? junior/.test(low) ? 4 : 3;
  if (/\bat least an? sophomore|\bcurrent(?:ly)?\s+(?:an?\s+)?sophomore/.test(low)) return 2;
  return 3;
}

function describe([low, high]) {
  if (high === 9999) return `${low} or later`;
  if (low === 0) return `by ${high}`;
  return high !== low ? `${low} to ${high}` : `${low}`;
}

// ["ok" | "ineligible" | "closed" | "unknown", reason], the same order of rules as verdict_from_facts.
export function verdict(facts, p) {
  if (!facts) return ["unknown", "page not read yet"];
  const grad = p.gradYear, year = p.yearInSchool, degree = p.degree;
  if (facts.gone) return ["closed", "the page says the job is no longer available"];
  if (facts.not_enrolled && p.enrolled) return ["ineligible", "page requires not being enrolled in college"];
  if (facts.fulltime_job) return ["ineligible", "page is a full-time job, not an internship"];
  if (facts.returning_only) return ["ineligible", "page is only for the company's past interns"];
  const graduate = /^(master|phd|doctor|mba)/.test(degree);
  if (facts.graduate_title && !graduate) return ["ineligible", "page title is for graduate students"];
  const level = facts.graduate_only;
  if (level && !(graduate && (level !== "PhD" || /^(phd|doctor)/.test(degree)))) return ["ineligible", `page asks for ${level} students`];
  if (facts.prior_internship && !p.pastInternship) return ["ineligible", "page requires a previous internship"];
  const fulltime = facts.fulltime_ranges || [];
  if (fulltime.length && !fulltime.some(([lo, hi]) => lo <= grad && grad <= hi)) return ["ineligible", "page wants a full-time start " + describe(fulltime[0])];
  if (facts.relative_grad && grad > p.cycleYear + 1) return ["ineligible", "page requires graduating within a year of the internship"];
  const standing = facts.standing || "";
  const short = !!standing && year < standingMinYear(standing);
  const ranges = facts.grad_ranges || [];
  if (ranges.length) {
    const fits = ranges.filter(([lo, hi]) => lo <= grad && grad <= hi);
    const named = fits.filter(([lo, hi]) => lo > 0 && hi < 9999);
    if (named.length) return ["ok", "page names graduation " + describe(named[0])];
    if (short) return ["ineligible", `page requires "${standing}"`];
    if (fits.length) return ["ok", "page names graduation " + describe(fits[0])];
    return ["ineligible", "page requires graduation " + describe(ranges[0])];
  }
  if (short) return ["ineligible", `page requires "${standing}"`];
  if (facts.underclass && year <= 2) return ["ok", "page mentions freshman/sophomore/underclassmen"];
  if (facts.upperclass && year < 3) return ["ineligible", `page asks for ${facts.upperclass} students`];
  return ["unknown", "page says nothing about graduation year"];
}

/* ---------------------------------------------------------------- scoring */

// Which of the cron's role classes each sign-up field covers.
export const FIELD_ROLES = {
  "software engineering": ["swe"], "AI and machine learning": ["swe"], "data and analytics": ["swe"],
  "product management": ["pm"], "UX/UI and product design": ["design"], "IT and support": ["it"], "cybersecurity": ["it"],
};
const ROLE_POINTS = { swe: 30, pm: 24, it: 18, design: 15, program: 20, ambassador: 28 };
const BIG_TECH = ["google", "apple", "meta", "amazon", "microsoft", "netflix", "nvidia"];

export const norm = (s) => String(s || "").toLowerCase().replace(/[,.]?\s+(inc|llc|ltd|corp|corporation|co|company|plc|group|holdings|technologies)\.?$/g, "").replace(/\s+/g, " ").trim();
// A company is on a list when its name matches an entry or starts with it ("Google" covers "Google DeepMind").
// Lists are normalized once per student (prepare), not once per posting: ranking stays under a millisecond.
const onList = (normed, company) => { const c = norm(company); return normed.some((n) => c === n || c.startsWith(n + " ")); };
const listed = (list, company) => onList((list || []).map(norm).filter(Boolean), company);

// The parts of a student's answers the scorer reads for every posting, worked out once.
export function prepare(a) {
  a = a || {};
  return {
    a, roles: new Set((a.fields || []).flatMap((f) => FIELD_ROLES[f] || [])), top: new Set(FIELD_ROLES[a.top_field] || []),
    dream: (a.dream || []).map(norm).filter(Boolean), excited: (a.excited || []).map(norm).filter(Boolean),
    hidden: (a.never_companies || []).map(norm).filter(Boolean), places: words(a.places).filter((w) => w.length > 1),
    never: words(a.never_words), keys: [...words(a.roles), ...words(a.skills)].filter((w) => w.length > 2),
    wantsPrograms: (a.early || []).length > 0,
  };
}
const words = (list) => (list || []).map((w) => String(w).toLowerCase().trim()).filter(Boolean);

// A location is in the US when it says so ("Remote in USA or Canada") or names nowhere else. Two-letter codes only
// count as foreign where no US state shares them: "Chicago, IL" is Illinois, not Israel; "CA" is California.
const US_NAMED = /\b(USA|U\.S\.A?\.?|United States)\b/i;
const ABROAD = /\b(United Kingdom|England|London|Canada|Toronto|Vancouver|Montreal|Ontario|Quebec|India|Bengaluru|Bangalore|Hyderabad|Pune|Germany|Berlin|Munich|France|Paris|Ireland|Dublin|Israel|Tel Aviv|Singapore|Japan|Tokyo|China|Shanghai|Beijing|Shenzhen|Hong Kong|Taiwan|Taipei|Korea|Seoul|Australia|Sydney|Melbourne|Netherlands|Amsterdam|Poland|Warsaw|Spain|Madrid|Barcelona|Mexico|Brazil|Sao Paulo|Switzerland|Zurich|Sweden|Stockholm|Denmark|Copenhagen|Europe|EMEA|APAC|LATAM|Asia)\b|,\s*(UK|CAN|MX|NL|KR|BC|ON|QC|SG|JP|CN|AU|BR|CH|ES|PL|FR|GB|SE|DK|TW|HK)\s*$/i;
export const usLocation = (loc) => US_NAMED.test(String(loc)) || !ABROAD.test(String(loc));
export const inUS = (m) => !(m.locations || []).length || (m.locations || []).some(usLocation);

// Why a posting is left out for this student, or "" when it stays. These are their own hard answers.
export function exclusion(m, a, p, pre = prepare(a)) {
  if (a.abroad !== "yes" && !inUS(m)) return "outside the US";
  if (m.citizens_only && (a.citizen === "no" || p.authorized === "no")) return "US citizens only";
  if ((a.sponsorship || "").startsWith("yes") && /does not offer/i.test(m.sponsorship || "")) return "no visa sponsorship";
  const title = String(m.title || "").toLowerCase();
  const bad = pre.never.find((w) => title.includes(w));
  if (bad) return `has "${bad}"`;
  if (onList(pre.hidden, m.company)) return "a company you hid";
  return "";
}

// A score out of 100 for this student, with the parts that add up to it.
export function score(m, a, p, now = Date.now(), pre = prepare(a)) {
  const { roles, top, wantsPrograms } = pre;
  const parts = {};
  // Role: a field they picked, a little more for their top one. Programs count for anyone who asked for them.
  if (roles.has(m.role)) parts.role = (ROLE_POINTS[m.role] || 15) + (top.has(m.role) ? 5 : 0);
  else if (m.role === "program" || m.role === "ambassador") parts.role = wantsPrograms ? ROLE_POINTS[m.role] : 8;
  else parts.role = roles.size ? 0 : 15;
  // Company: their dream list first, then the ones they're excited about, then big tech.
  parts.company = onList(pre.dream, m.company) ? 25 : onList(pre.excited, m.company) ? 18 : BIG_TECH.includes(norm(m.company)) ? 12 : m.tier === 2 ? 8 : 0;
  // Built for first and second years: worth a lot to them, nothing extra to a senior.
  parts.early = m.early_career === "strong" ? (p.yearInSchool <= 2 ? 30 : 5) : m.early_career === "weak" ? 3 : 0;
  // Places they named rank higher; remote follows their answer.
  const locs = (m.locations || []).join(" | ").toLowerCase();
  const places = pre.places;
  const remote = /remote/.test(locs);
  parts.location = places.some((w) => locs.includes(w)) ? 12 : remote ? (a.remote === "love them" ? 12 : a.remote === "rather not" ? -6 : 6) : inUS(m) ? 4 : 0;
  // Fresh postings first; the good ones close fast.
  const posted = (m.latest_posted || m.date_posted || 0) * 1000;
  const days = posted ? (now - posted) / 86400000 : 999;
  // Old postings sink whoever posted them: a 180-day-old fellowship shouldn't top a freshman's list.
  parts.fresh = days < 1 ? 10 : days < 7 ? 5 : days > 150 ? -20 : days > 90 ? -10 : 0;
  // Roles and skills they wrote down, found in the title.
  const title = String(m.title || "").toLowerCase();
  const hits = pre.keys.filter((w) => title.includes(w));
  parts.keywords = Math.min(9, hits.length * 3);
  const total = Object.values(parts).reduce((s, n) => s + n, 0);
  return { score: Math.max(0, Math.min(100, Math.round(total))), parts };
}

export const why = (parts) => Object.entries(parts).filter(([, n]) => n).map(([k, n]) => `${k} ${n > 0 ? "+" : ""}${n}`).join(" · ") || "no points yet";

// Every shared posting judged and scored for one student, best first. Left-out postings come back marked.
export function rank(matches, answers, now = Date.now()) {
  const a = answers || {}, p = profileFrom(a, new Date(now)), pre = prepare(a);
  return matches.filter((m) => inTheirFields(m, a)).map((m) => {
    const [elig, note] = m.eligibility === "closed" ? ["closed", m.eligibility_note || "closed"] : verdict(m.posting_facts, p);
    const out = exclusion(m, a, p, pre);
    const s = score(m, a, p, now, pre);
    return { ...m, my: { eligibility: elig, note, out, score: s.score, parts: s.parts } };
  }).sort((x, y) => y.my.score - x.my.score);
}

export const isOpen = (m) => !m.my.out && m.my.eligibility !== "ineligible" && m.my.eligibility !== "closed";

// Whether a posting is in a field they picked, or a program and they asked for programs. Postings outside their
// fields aren't shown at all (not even as "ruled out"), so every count on every page means the same thing.
export function inTheirFields(m, a) {
  const roles = new Set(((a || {}).fields || []).flatMap((f) => FIELD_ROLES[f] || []));
  if (!roles.size) return true;
  if (roles.has(m.role)) return true;
  return (((a || {}).early || []).length > 0) && (m.role === "program" || m.role === "ambassador" || m.early_career === "strong");
}

/* ---------------------------------------------------------------- alert timing */

const ZONES = {
  "Eastern (New York)": "America/New_York", "Central (Chicago)": "America/Chicago", "Mountain (Denver)": "America/Denver",
  "Pacific (Los Angeles)": "America/Los_Angeles", "Alaska": "America/Anchorage", "Hawaii": "Pacific/Honolulu", "outside the US": "UTC",
};
export const zoneOf = (label) => ZONES[label] || "America/New_York";

// The student's local hour (0 to 23), weekday (0 Sunday), and date, in their time zone.
export function localNow(label, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zoneOf(label), hour: "numeric", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { hour: Number(parts.hour) % 24, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday), date: `${parts.year}-${parts.month}-${parts.day}` };
}

// The greeting at the top of the New page, by the hour where the student is.
export function greeting(hour) {
  if (hour >= 5 && hour < 12) return "good morning,";
  if (hour >= 12 && hour < 17) return "good afternoon,";
  if (hour >= 17 && hour < 22) return "good evening,";
  return "up late,";
}

// "7:00 PM" -> 19
export function hourOf(label) {
  const m = String(label || "").match(/^(\d{1,2}):\d{2}\s*(AM|PM)$/i);
  if (!m) return 19;
  const h = Number(m[1]) % 12;
  return m[2].toUpperCase() === "PM" ? h + 12 : h;
}

const QUIET = { "10:00 PM to 7:00 AM": [22, 7], "11:00 PM to 8:00 AM": [23, 8], "midnight to 9:00 AM": [0, 9], "during class (9:00 AM to 3:00 PM)": [9, 15] };
export function isQuiet(label, hour) {
  const q = QUIET[label];
  if (!q) return false;
  const [start, end] = q;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// Whether the digest should go out now: at or after the student's digest hour, once that day (weekly: Mondays).
// "At or after", so a busy run that reaches them late still sends. Quiet hours don't apply: they picked the time.
export function digestDue(a, lastDigestDate, now = new Date()) {
  if (a.speed !== "once a day" && a.speed !== "once a week") return false;
  const local = localNow(a.timezone, now);
  if (local.hour < hourOf(a.digest_time || "7:00 PM")) return false;
  if (a.speed === "once a week" && local.weekday !== 1) return false;
  return lastDigestDate !== local.date;
}

// When a posting reached the dashboard (index.js ingest sets "arrived"); older uploads fall back to first_seen, then
// the posted date. Date.parse("") is NaN, so each fallback really falls back.
export const arrivedMs = (m) => Date.parse(m.arrived || "") || Date.parse(m.first_seen || "") || (m.latest_posted || m.date_posted || 0) * 1000;

// Postings that deserve an instant ping: arrived after the student joined, not pinged yet, open for them, and
// strong by their own rule. There's no time window, so a ping held back by quiet hours or a failed send goes out
// on the next run instead of being lost; the pinged list is what stops repeats.
export function instantPicks(ranked, a, alreadySent, joinedMs) {
  if (a.speed !== "tell me right away") return [];
  const dream = (a.dream || []).map(norm).filter(Boolean);
  return ranked.filter((m) => isOpen(m) && !alreadySent.has(m.key) && arrivedMs(m) >= joinedMs
    && (a.strong === "dream companies only" ? onList(dream, m.company) : m.my.score >= 60));
}
