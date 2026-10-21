/* Accounts for other people (docs/multi-user-plan.md, milestones U1 and U2). LOCAL ONLY until the plan's
 * later milestones land: nothing here is deployed yet.
 *
 * Who is who:
 *   the owner   Jeremiah. Logs in with the dashboard password alone (leave the email blank) and sees today's
 *               New / Programs / Review / Tracker, which are still his data.
 *   a user      anyone who signs up with an email and password. They answer the sign-up questions and get a
 *               "you" page with their answers. Their own matches and alerts come in U3 and U4; until then the
 *               owner's pages stay closed to them.
 *
 * Storage is D1 (free SQL): one users row per person, answers kept as JSON so adding a question never needs a
 * migration. Passwords are PBKDF2-SHA256 with a random salt (Web Crypto, built into Workers). The session is a
 * signed cookie (user id, expiry, HMAC), like the owner's. Failed logins are counted per email and per IP, and
 * more than 8 in 15 minutes locks that key out for the rest of the window.
 */

import { LANDING_CSS, LANDING_JS, landingBody } from "./landing.js";
import { STUDENT_TABLES, STUDENT_CSS, studentHome, studentTracker, studentApi, studentExport, privacyPage, metaFor, deleteStudentData, studentDock, trackedCount, ping } from "./student.js";

const USER_COOKIE = "scout_u";
const COOKIE_DAYS = 30;
// 60,000 rounds keeps a login under the free plan's 10 ms of CPU per request (100,000 measured about 10 ms on its
// own). The lockout below is what stops guessing; the rounds slow down a stolen database. Each hash stores its own
// round count, so this can change without breaking existing passwords.
const PBKDF2_ROUNDS = 60000;
const LOCK_WINDOW = 15 * 60 * 1000;
const LOCK_AFTER = 8;

/* ---------------------------------------------------------------- the questions */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const YEARS = Array.from({ length: 10 }, (_, i) => String(2026 + i));
const HOURS = ["6:00 AM", "7:00 AM", "8:00 AM", "9:00 AM", "12:00 PM", "3:00 PM", "5:00 PM", "6:00 PM", "7:00 PM", "8:00 PM", "9:00 PM", "10:00 PM"];
const QUIET = ["no quiet hours", "10:00 PM to 7:00 AM", "11:00 PM to 8:00 AM", "midnight to 9:00 AM", "during class (9:00 AM to 3:00 PM)"];
const ZONES = ["Eastern (New York)", "Central (Chicago)", "Mountain (Denver)", "Pacific (Los Angeles)", "Alaska", "Hawaii", "outside the US"];
// Companies students pick from, with logos from each company's public Simplify page (the same source as the
// dashboard's logos). Picked names are saved as plain names, so the list can change without touching answers.
const COMPANIES = [
  ["Google", "https://storage.googleapis.com/simplify-imgs/companies/b60541c7-697d-49d9-889e-9e23ae58c480/logo.png"],
  ["Apple", "https://storage.googleapis.com/simplify-imgs/companies/e75c9eb7-40e1-4539-abf9-6433a9946636/logo.png"],
  ["Meta", "https://storage.googleapis.com/simplify-imgs/companies/274bb79f-19a9-4287-b5f6-ae4cd39636ec/logo.png"],
  ["Amazon", "https://storage.googleapis.com/simplify-imgs/companies/6d9aadb2-0270-47c0-9e33-e0814f021086/logo.png"],
  ["Microsoft", "https://storage.googleapis.com/simplify-imgs/companies/527fc2d9-67a9-4418-a8fa-662bdb033151/logo.png"],
  ["NVIDIA", "https://storage.googleapis.com/simplify-imgs/companies/3cd4b225-8559-433f-8b19-7f0bd97cae5a/logo.png"],
  ["Netflix", "https://storage.googleapis.com/simplify-imgs/companies/a9e95af8-fcce-4aab-8efa-a1f0c54a47ea/logo.png"],
  ["OpenAI", "https://storage.googleapis.com/simplify-imgs/companies/b9abb3b3-3119-4b5c-af43-80caa62c25a9/logo.png"],
  ["Anthropic", "https://storage.googleapis.com/simplify-imgs/companies/dd90aecf-23a9-478d-a952-262aa2b20ab2/logo.png"],
  ["Spotify", "https://storage.googleapis.com/simplify-imgs/companies/098b9478-9768-4ce4-bcef-f3b5c087112a/logo.png"],
  ["Figma", "https://storage.googleapis.com/simplify-imgs/companies/626fbafa-3868-42ac-8473-95841e851a35/logo.png"],
  ["Adobe", "https://storage.googleapis.com/simplify-imgs/companies/2eaf773c-8884-44f1-a06f-0be1cd1975ef/logo.png"],
  ["Stripe", "https://storage.googleapis.com/simplify-imgs/companies/bde55618-d289-4ffe-ad8f-21cdf7908c74/logo.png"],
  ["Notion", "https://storage.googleapis.com/simplify-imgs/companies/b5ce16d4-556e-447e-aa11-09240edd3031/logo.png"],
  ["Duolingo", "https://storage.googleapis.com/simplify-imgs/companies/e37657c0-dfec-49bf-8a99-6f29085f7afe/logo.png"],
  ["Pinterest", "https://storage.googleapis.com/simplify-imgs/companies/93c13b86-3fc7-4bab-b5f2-f35e5c6bc637/logo.png"],
  ["Airbnb", "https://storage.googleapis.com/simplify-imgs/companies/13cb2ceb-fab2-40ec-9bb3-8ccc1ddb2992/logo.png"],
  ["Uber", "https://storage.googleapis.com/simplify-imgs/companies/88c7a242-03a9-4e70-a9d0-72029f41339a/logo.png"],
  ["Salesforce", "https://storage.googleapis.com/simplify-imgs/companies/cac781d4-f8b7-40b8-a019-f39a9d475c93/logo.png"],
  ["LinkedIn", "https://storage.googleapis.com/simplify-imgs/companies/139a269c-3ba1-4757-a561-242393abc8e1/logo.png"],
  ["Snap", "https://storage.googleapis.com/simplify-imgs/companies/58aee0e3-e073-4178-b6a9-ff500c783b25/logo.png"],
  ["Discord", "https://storage.googleapis.com/simplify-imgs/companies/6c1c79fe-1b10-4c34-acee-5223e0cf1575/logo.png"],
  ["Roblox", "https://storage.googleapis.com/simplify-imgs/companies/97bd292f-5763-4685-b4c0-8c6163f4095c/logo.png"],
  ["Tesla", "https://storage.googleapis.com/simplify-imgs/companies/d7232671-3132-4928-a7ef-1a42535d440d/logo.png"],
  ["Datadog", "https://storage.googleapis.com/simplify-imgs/companies/badf5319-ccd0-4a62-886a-dc9cbb400ba1/logo.png"],
  ["Cloudflare", "https://storage.googleapis.com/simplify-imgs/companies/b6bcb093-a0cb-4098-894c-a69c439d36ec/logo.png"],
  ["Coinbase", "https://storage.googleapis.com/simplify-imgs/companies/717694f5-7321-4c6f-91a5-5a46b250f459/logo.png"],
  ["Robinhood", "https://storage.googleapis.com/simplify-imgs/companies/3b1dc521-93dd-4da7-90e5-3cb2db2bdbff/logo.jpg"],
  ["Canva", "https://storage.googleapis.com/simplify-imgs/companies/481f7584-cd1c-4822-b012-23e2513cadc2/logo.png"],
  ["Bloomberg", "https://storage.googleapis.com/simplify-imgs/companies/5d93f136-9bf2-4c84-9bd4-a5fc4da19d2b/logo.png"],
  ["IBM", "https://storage.googleapis.com/simplify-imgs/companies/bf3b0cf7-1238-4104-902d-dbb6f0d57449/logo.png"],
  ["Oracle", "https://storage.googleapis.com/simplify-imgs/companies/78f74e67-f9af-4cea-bd6a-ccb9d92747f9/logo.png"],
  ["Jane Street", "https://storage.googleapis.com/simplify-imgs/companies/89a554fe-af5f-44db-9c57-2cbceacc878f/logo.png"],
];

const FIELDS = ["software engineering", "product management", "data and analytics", "AI and machine learning", "UX/UI and product design",
  "IT and support", "cybersecurity", "hardware", "quant", "research"];

// Each step is one screen. `why` is the line under the step title: people answer more when they know what it's for.
// Field types: text, url, select, radio (pick one), chips (pick any), tags (comma list), textarea.
const STEPS = [
  {
    id: "you", short: "you", lead: "first,", head: "about you", pose: "wave", color: "orange",
    why: "your school year and graduation date decide most of what you can apply to, so these come first.",
    fields: [
      { name: "name", label: "what should we call you?", type: "text", required: true, placeholder: "first name is fine" },
      { name: "school", label: "school", type: "text", required: true, placeholder: "NJIT, Rutgers, Georgia Tech..." },
      { name: "degree", label: "what degree are you working on?", type: "radio", required: true, options: ["bachelor's", "master's", "PhD", "associate"] },
      { name: "major", label: "major", type: "text", required: true, placeholder: "computer science" },
      { name: "minor", label: "second major or minor", type: "text", placeholder: "optional" },
      { name: "year", label: "year in school", type: "radio", required: true, options: ["first", "second", "third", "fourth", "fifth or more", "recent grad"] },
      { name: "grad", label: "when do you graduate?", type: "monthyear", required: true, why: "postings say \"graduating in 2028\" all the time. this is how scout skips the ones that aren't you." },
      { name: "gpa", label: "GPA", type: "text", placeholder: "optional, never shown to anyone", why: "only used when a posting has a cutoff." },
      { name: "cross_major", label: "open to roles outside your major?", type: "radio", options: ["yes", "maybe", "no"] },
    ],
  },
  {
    id: "work", short: "work status", lead: "the boring", head: "but big part", pose: "judging", color: "purple",
    why: "a lot of postings rule people out on these. answering now means fewer you can't take.",
    fields: [
      { name: "authorized", label: "are you authorized to work in the US?", type: "radio", required: true, options: ["yes", "no"] },
      { name: "sponsorship", label: "will you need visa sponsorship?", type: "radio", required: true, options: ["no", "yes, now", "yes, later"] },
      { name: "citizen", label: "US citizen?", type: "radio", options: ["yes", "no", "rather not say"], why: "some defense and government roles require it." },
      { name: "clearance", label: "open to getting a security clearance?", type: "radio", options: ["yes", "maybe", "no"] },
    ],
  },
  {
    id: "want", short: "what you want", lead: "what are", head: "you after?", pose: "sunglasses", color: "teal",
    why: "pick everything that sounds good. you can change any of this later.",
    fields: [
      { name: "kinds", label: "what kind of role?", type: "chips", required: true, options: ["internship", "co-op", "part-time during school", "new grad full-time", "fellowship", "research"] },
      { name: "seasons", label: "which seasons?", type: "chips", required: true, options: ["summer", "fall", "winter", "spring", "year-round"] },
      { name: "fields", label: "fields you're into", type: "chips", required: true, options: FIELDS },
      { name: "top_field", label: "your top field", type: "select", options: ["", ...FIELDS], why: "it gets a little extra weight in your scores." },
      { name: "roles", label: "roles that sound right", type: "tags", placeholder: "front end, iOS, product design, data analyst" },
      { name: "never_words", label: "words that should never show up", type: "tags", placeholder: "sales, unpaid, commission" },
      { name: "paid_only", label: "paid roles only?", type: "radio", options: ["yes", "no"] },
    ],
  },
  {
    id: "where", short: "where", lead: "where do", head: "you want to be?", pose: "walking", color: "sand",
    why: "places you pick rank higher. nothing gets hidden for being somewhere else unless you say so.",
    fields: [
      { name: "places", label: "cities or regions you'd love", type: "tags", required: true, placeholder: "NYC, New Jersey, Seattle, Bay Area" },
      { name: "relocate", label: "willing to move?", type: "radio", options: ["anywhere in the US", "some places", "no"] },
      { name: "remote", label: "remote roles", type: "radio", options: ["love them", "fine", "rather not"] },
      { name: "abroad", label: "outside the US?", type: "radio", options: ["no", "yes"] },
      { name: "countries", label: "which countries?", type: "text", placeholder: "Canada, UK", showIf: ["abroad", "yes"] },
    ],
  },
  {
    id: "companies", short: "companies", lead: "who's on", head: "your list?", pose: "proud", color: "orange",
    why: "dream companies ping your phone within the hour they post. the rest wait for your digest.",
    fields: [
      { name: "dream", label: "dream companies", type: "companies" },
      { name: "excited", label: "companies you'd be excited about", type: "companies" },
      { name: "size", label: "company size", type: "chips", options: ["startup", "mid-size", "big tech", "no preference"] },
      { name: "industries", label: "industries you care about", type: "chips", options: ["health", "climate", "gaming", "finance", "government", "education", "media", "retail", "sports", "space"] },
      { name: "never_companies", label: "companies to never show", type: "tags", placeholder: "optional" },
    ],
  },
  {
    id: "programs", short: "programs", lead: "the secret", head: "menu", pose: "bamboo", color: "purple",
    why: "programs built for first and second years are the best finds there are, and the easiest to miss.",
    fields: [
      { name: "early", label: "want any of these?", type: "chips", options: ["freshman and sophomore programs", "fellowships", "ambassador programs", "hackathons", "competitions"] },
      { name: "known_programs", label: "programs you're eyeing", type: "tags", placeholder: "Microsoft Explore, MLH Fellowship" },
    ],
  },
  {
    id: "alerts", short: "alerts", lead: "how loud", head: "should we be?", pose: "close", color: "teal",
    why: "the good ones close in days. pick how fast you want to hear about them.",
    fields: [
      { name: "speed", label: "when a strong match drops", type: "radio", required: true, options: ["tell me right away", "once a day", "once a week"] },
      { name: "strong", label: "what counts as strong?", type: "radio", options: ["dream companies only", "anything that scores high"] },
      { name: "digest_time", label: "daily digest time", type: "select", options: HOURS, default: "7:00 PM" },
      { name: "timezone", label: "time zone", type: "select", options: ZONES },
      { name: "quiet", label: "quiet hours", type: "select", options: QUIET },
      { name: "channel", label: "phone alerts?", type: "radio", options: ["phone (free app, 1-minute setup)", "no alerts for now"], why: "free, through the ntfy app. setup is on the you page." },
    ],
  },
  {
    id: "background", short: "background", lead: "show us", head: "what you've got", pose: "thumbs", color: "sand",
    why: "scout scores matches with these. your full resume never comes here; it stays on your computer for your Claude Code to use.",
    fields: [
      { name: "skills", label: "skills and tools", type: "tags", placeholder: "Python, Figma, Swift, SQL" },
      { name: "experience", label: "jobs, internships, projects", type: "textarea", placeholder: "one per line. a few words each is plenty." },
      { name: "linkedin", label: "LinkedIn", type: "url", placeholder: "https://linkedin.com/in/..." },
      { name: "github", label: "GitHub", type: "url", placeholder: "https://github.com/..." },
      { name: "portfolio", label: "portfolio", type: "url", placeholder: "https://..." },
      { name: "languages", label: "languages you speak", type: "tags", placeholder: "English, Spanish" },
    ],
  },
  {
    id: "applying", short: "applying", lead: "last one,", head: "promise", pose: "nap", color: "orange",
    why: "pick a number and scout will keep count once your tracker is live.",
    fields: [
      { name: "weekly_goal", label: "how many applications a week?", type: "radio", options: ["1 or 2", "3 to 5", "6 to 10", "more than 10"] },
      { name: "help_with", label: "what do you want help with?", type: "chips", options: ["tailored resumes", "cover letters", "short answers"] },
    ],
  },
];

/* ---------------------------------------------------------------- storage */

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL,
      answers TEXT NOT NULL DEFAULT '{}', step INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_fails (key TEXT NOT NULL, at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS login_fails_key ON login_fails (key, at)`),
    ...STUDENT_TABLES.map((sql) => env.DB.prepare(sql)),
  ]);
  schemaReady = true;
}

async function userById(env, id) {
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  return row ? { ...row, answers: upgradeAnswers(JSON.parse(row.answers || "{}")) } : null;
}

// Answers saved under an older version of a question, mapped to today's options, so editing a step never silently
// drops them: alerts used to be a list ("phone (the free ntfy app)", "email"), and the degree and field lists were
// longer before Scout narrowed to college students in tech.
function upgradeAnswers(a) {
  const out = { ...a };
  if (Array.isArray(out.channel) || /^phone \(the free/.test(out.channel || "")) {
    out.channel = [].concat(out.channel || []).some((c) => String(c).startsWith("phone")) ? "phone (free app, 1-minute setup)" : "no alerts for now";
  }
  if (out.fields) out.fields = [].concat(out.fields).map((f) => (f === "quant and finance" ? "quant" : f)).filter((f) => FIELDS.includes(f));
  if (out.top_field === "quant and finance") out.top_field = "quant";
  return out;
}

/* ---------------------------------------------------------------- passwords and sessions */

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));

async function hashPassword(password, saltHex = hex(crypto.getRandomValues(new Uint8Array(16))), rounds = PBKDF2_ROUNDS) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(saltHex), iterations: rounds }, key, 256);
  return `pbkdf2$${rounds}$${saltHex}$${hex(bits)}`;
}

// An unknown email still costs one hash (against a throwaway salt), so the response time doesn't say which emails
// have accounts.
const DUMMY_HASH = "pbkdf2$60000$00000000000000000000000000000000$0";
async function checkPassword(password, stored, ui) {
  const [, rounds, salt] = String(stored || DUMMY_HASH).split("$");
  if (!salt || !/^\d+$/.test(rounds)) return false;
  const ok = await ui.sameSecret(await hashPassword(password, salt, Number(rounds)), String(stored || DUMMY_HASH));
  return !!stored && ok;
}

// The cookie's signature covers a piece of the password hash, so changing the password (a reset) ends every
// session that was signed in with the old one.
async function userCookie(env, id, ui, pw) {
  const expires = Date.now() + COOKIE_DAYS * 86400e3;
  const sig = await ui.hmac(env.SESSION_SECRET, `u:${id}.${expires}.${String(pw || "").slice(-16)}`);
  return `${USER_COOKIE}=${id}.${expires}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}`;
}

async function currentUser(request, env, ui) {
  const raw = (request.headers.get("Cookie") || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(USER_COOKIE + "="));
  if (!raw || !env.SESSION_SECRET || !env.DB) return null;
  const [id, expires, sig] = raw.slice(USER_COOKIE.length + 1).split(".");
  if (!id || !expires || !sig || Number(expires) < Date.now()) return null;
  await ensureSchema(env);
  const user = await userById(env, Number(id));
  if (!user || !(await ui.sameSecret(sig, await ui.hmac(env.SESSION_SECRET, `u:${id}.${expires}.${String(user.pw || "").slice(-16)}`)))) return null;
  return user;
}

// keys: [name, limit] pairs. A guesser is stopped by the per-IP and per-email-and-IP keys at 8; the email on its
// own takes 40 from anywhere, so a stranger can't lock someone out of their own account with a handful of tries.
async function lockedOut(env, keys) {
  const since = Date.now() - LOCK_WINDOW;
  for (const [key, limit] of keys) {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_fails WHERE key = ? AND at > ?").bind(key, since).first();
    if (row && row.n >= limit) return true;
  }
  return false;
}

async function noteFail(env, keys) {
  const now = Date.now();
  await env.DB.batch([
    ...keys.map(([k]) => env.DB.prepare("INSERT INTO login_fails (key, at) VALUES (?, ?)").bind(k, now)),
    env.DB.prepare("DELETE FROM login_fails WHERE at < ?").bind(now - LOCK_WINDOW),
  ]);
}

/* ---------------------------------------------------------------- routes */

// Returns a Response for the paths this module owns, or null to let index.js carry on (the owner's pages).
export async function routeAccounts(request, env, url, ui) {
  const path = url.pathname;
  const isOwner = await ui.isOwner(request);
  const user = isOwner ? null : await currentUser(request, env, ui);

  if (path === "/logout") {
    return ui.redirect("/", [["Set-Cookie", "scout=; Path=/; Max-Age=0"], ["Set-Cookie", `${USER_COOKIE}=; Path=/; Max-Age=0`]]);
  }
  if (path === "/privacy") return privacyPage(ui, !!user);
  if (path === "/" && !isOwner) {
    if (!user) return landing(ui);
    return user.done ? studentHome(env, user, url, ui) : ui.redirect(`/start?step=${resumeStep(user)}`);
  }
  if (user && !isOwner) {
    if (path === "/tracker") return user.done ? studentTracker(env, user, ui) : ui.redirect(`/start?step=${resumeStep(user)}`);
    if (path.startsWith("/api/u/")) return studentApi(request, env, user, path, ui);
    if (path === "/you/export") return studentExport(env, user);
  }
  if (path === "/hello") return landing(ui, isOwner || !!user);
  if (path === "/login") {
    if (request.method !== "POST") return loginPage(ui, "", "");
    return login(request, env, ui);
  }
  if (path === "/forgot") return request.method === "POST" ? forgot(request, env, url, ui) : forgotPage(ui, "");
  if (path === "/reset") return reset(request, env, url, ui);
  if (path === "/signup") {
    if (!env.DB) return ui.page(`<div class="card"><p>sign up isn't open yet.</p></div>`, { title: "Sign up", page: "login", lead: "almost", head: "there", nav: false });
    if (user) return ui.redirect("/you");
    return request.method === "POST" ? signup(request, env, ui) : signupPage(ui, "", "");
  }
  if (path === "/start" || path === "/you" || path === "/you/delete") {
    if (!user) return ui.redirect(isOwner ? "/" : "/login");
    if (path === "/you/delete") return request.method === "POST" ? deleteAccount(env, user, ui) : ui.redirect("/you");
    if (path === "/you") return youPage(user, ui, url.searchParams.get("saved"), await metaFor(env, user.id), await trackedCount(env, user.id));
    if (request.method === "POST") return saveStep(request, env, user, url, ui);
    return stepPage(user, ui, url, url.searchParams.get("missing") ? missing(STEPS[stepIndex(url) - 1], user.answers) : []);
  }
  // A signed-in student on any of the owner's pages goes to their own; the owner's data is not theirs to see.
  if (user && !isOwner) return path.startsWith("/api/") ? ui.json({ error: "unauthorized" }, 401) : ui.redirect("/");
  return null;
}

/* ---------------------------------------------------------------- log in and sign up */

const AUTH_CSS = `
.auth{background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow);padding:22px;display:grid;gap:0;position:relative}
.auth label{display:block;font-weight:700;font-size:var(--small);text-transform:lowercase;margin:18px 0 6px} .auth label:first-of-type{margin-top:0}
.auth input{font:500 var(--text) var(--font);color:var(--ink);background:#fff;border:var(--line) solid var(--ink);border-radius:12px;padding:12px 14px;width:100%}
.auth input:focus{outline:none;box-shadow:0 0 0 4px var(--accent)}
.auth .btn.big{margin-top:22px;justify-self:stretch;text-align:center}
.auth p{margin:0} .auth .note{margin-top:6px;color:var(--ink);font-size:var(--small)} .auth .note a{color:var(--ink);font-weight:700} .auth .warn{margin-top:12px} .auth .swap{margin-top:14px}
.auth .swap{font-size:var(--small)} .auth .swap a{color:var(--ink);font-weight:700}
.pw{position:relative} .pw input{padding-right:74px}
.pw .show{position:absolute;right:8px;top:50%;transform:translateY(-50%);font:700 var(--small) var(--font);color:var(--ink);background:var(--cream);border:2px solid var(--ink);border-radius:999px;padding:5px 11px;cursor:pointer}
.auth .warn{margin:0;font-weight:700;color:var(--red)}

.auth-panda{position:absolute;right:14px;top:-74px;width:96px;height:96px}
.auth-wrap{margin-top:78px}
body[data-page="login"] h1,body[data-page="signup"] h1{margin-bottom:0}
body[data-page="login"] main,body[data-page="login"] header,body[data-page="signup"] main,body[data-page="signup"] header{max-width:460px}
body[data-page="login"] header,body[data-page="signup"] header{justify-content:space-between}
body[data-page="login"] h1,body[data-page="signup"] h1{text-align:left}
body[data-page="signup"]{--page:var(--orange)} body[data-page="signup"] main{display:block}
@media (min-width:900px){
  body[data-page="login"] main,body[data-page="login"] header,body[data-page="signup"] main,body[data-page="signup"] header{max-width:1000px}
  body[data-page="login"] main,body[data-page="signup"] main{display:grid;grid-template-columns:minmax(0,1fr) 440px;gap:60px;align-items:center;min-height:calc(100vh - 140px)}
  body[data-page="login"] h1,body[data-page="signup"] h1{font-size:clamp(40px,4.6vw,68px);grid-column:1;margin:0}
  .auth-wrap{margin-top:0} .auth-panda{top:-104px;width:130px;height:130px}
}
`;

// The new pages all mark the headline with the same highlighter as the landing page, painted behind the words
// themselves (inline, cloned on each line), so it ends where the words end. The owner's pages keep their doodle.
const HEAD_CSS = `
h1 .head{display:inline;padding:0 .06em;background:linear-gradient(transparent 52%,var(--accent) 52%,var(--accent) 88%,transparent 88%);-webkit-box-decoration-break:clone;box-decoration-break:clone}
h1 .head::after{display:none}`;

// Show/hide the password, and the panda closes its eyes (the nap pose) while a password is being typed.
const AUTH_JS = `(function(){var pw=document.getElementById("password"),b=document.querySelector(".pw .show"),p=document.querySelector(".auth-panda");
var bg=p&&p.querySelector(".panda-bg"),fg=p&&p.querySelector(".panda-fg"),start=fg&&fg.getAttribute("src").match(/panda\\/([a-z-]+)\\.png/)[1];
function pose(n){if(bg&&fg){bg.src="/panda/"+n+"-bg.png";fg.src="/panda/"+n+".png"}}
if(pw){pw.addEventListener("focus",function(){if(pw.type==="password")pose("nap")});pw.addEventListener("blur",function(){pose(start)})}
if(b)b.addEventListener("click",function(){var on=pw.type==="password";pw.type=on?"text":"password";b.textContent=on?"hide":"show";b.setAttribute("aria-pressed",on);pose(on?start:"nap");pw.focus()})})();`;

function loginPage(ui, message, email) {
  return ui.page(`<div class="auth-wrap"><form method="post" action="/login" class="auth">
    ${ui.panda(message ? "sad" : "wave", "auth-panda")}
    <label for="email">email</label>
    <input id="email" name="email" type="email" autocomplete="username" value="${ui.esc(email)}" autofocus>
    <label for="password">password</label>
    <div class="pw"><input id="password" name="password" type="password" autocomplete="current-password" required><button type="button" class="show" aria-pressed="false">show</button></div>
    <button class="btn accent big" type="submit">let me in</button>
    ${message ? `<p class="warn">${ui.esc(message)}</p>` : ""}
    <p class="swap">new here? <a href="/signup">make an account</a></p>
    <p class="swap"><a href="/forgot">forgot your password?</a></p>
  </form></div>`, { title: "Log in", page: "login", lead: "who goes", head: "there?", nav: false, links: '<a class="pill-link" href="/hello">what is scout?</a>', css: HEAD_CSS + AUTH_CSS, script: AUTH_JS }, message ? 401 : 200);
}

function signupPage(ui, message, email) {
  return ui.page(`<div class="auth-wrap"><form method="post" action="/signup" class="auth">
    ${ui.panda("celebrate", "auth-panda")}
    <label for="email">email</label>
    <input id="email" name="email" type="email" autocomplete="email" value="${ui.esc(email)}" required autofocus>
    <label for="password">password</label>
    <div class="pw"><input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required aria-describedby="pw-note"><button type="button" class="show" aria-pressed="false">show</button></div>
    <p class="note" id="pw-note">10 characters or more.</p>
    <button class="btn accent big" type="submit">let's go</button>
    ${message ? `<p class="warn">${ui.esc(message)}</p>` : ""}
    <p class="swap">been here before? <a href="/login">log in</a></p>
  </form></div>`, { title: "Sign up", page: "signup", lead: "let's find", head: "your internship", nav: false, links: '<a class="pill-link" href="/hello">what is scout?</a>', css: HEAD_CSS + AUTH_CSS, script: AUTH_JS }, message ? 400 : 200);
}

async function login(request, env, ui) {
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  // The owner's dashboard password still works on its own, with the email left blank, under the same lockout:
  // 8 misses from one IP, or 40 from everywhere, in 15 minutes.
  if (!email) {
    if (!env.DB) return ui.ownerLogin(password, () => loginPage(ui, "nope. try again.", ""));
    await ensureSchema(env);
    const keys = [[`owner-ip:${ip}`, LOCK_AFTER], ["owner", 40]];
    if (await lockedOut(env, keys)) return loginPage(ui, "too many tries. give it 15 minutes.", "");
    return ui.ownerLogin(password, async () => { await noteFail(env, keys); return loginPage(ui, "nope. try again.", ""); });
  }
  if (!env.DB) return loginPage(ui, "accounts aren't open yet.", email);
  await ensureSchema(env);
  const keys = [[`ip:${ip}`, 20], [`e+ip:${email}|${ip}`, LOCK_AFTER], [`e:${email}`, 40]];
  if (await lockedOut(env, keys)) return loginPage(ui, "too many tries. give it 15 minutes.", email);
  const row = await env.DB.prepare("SELECT id, pw, done, step, answers FROM users WHERE email = ?").bind(email).first();
  if (!(await checkPassword(password, row ? row.pw : null, ui)) || !row) {
    await noteFail(env, keys);
    return loginPage(ui, "that email and password don't match.", email);
  }
  const next = row.done ? "/" : `/start?step=${resumeStep({ answers: safeParse(row.answers), step: row.step })}`;
  return ui.redirect(next, [["Set-Cookie", await userCookie(env, row.id, ui, row.pw)]]);
}

async function signup(request, env, ui) {
  await ensureSchema(env);
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return signupPage(ui, "that email doesn't look right.", email);
  if (password.length < 10) return signupPage(ui, "the password needs 10 characters or more.", email);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await lockedOut(env, [[`signup:${ip}`, LOCK_AFTER]])) return signupPage(ui, "too many sign ups from here. try again in 15 minutes.", email);
  const taken = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (taken) return signupPage(ui, "there's already an account with that email. try logging in.", email);
  const now = new Date().toISOString();
  // Two sign ups with one email at the same moment: the second hits the UNIQUE constraint, not a 500.
  const pw = await hashPassword(password);
  const result = await env.DB.prepare("INSERT INTO users (email, pw, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(email, pw, now, now).run().catch(() => null);
  if (!result) return signupPage(ui, "there's already an account with that email. try logging in.", email);
  await noteFail(env, [[`signup:${ip}`, LOCK_AFTER]]); // counts sign ups per IP with the same window as failed logins
  return ui.redirect("/start?step=1", [["Set-Cookie", await userCookie(env, result.meta.last_row_id, ui, pw)]]);
}

/* ---------------------------------------------------------------- forgot password */

// There's no free way to send email, but a student with phone alerts already has a private channel: their ntfy
// topic. The reset link goes there. It's signed, lasts 30 minutes, and includes a piece of the current password
// hash, so it stops working the moment the password changes. The page says the same thing whether or not the
// email has an account.
const RESET_MINUTES = 30;
const resetSig = (env, ui, id, exp, pw) => ui.hmac(env.SESSION_SECRET, `reset:${id}.${exp}.${String(pw).slice(-16)}`);

function forgotPage(ui, message) {
  return ui.page(`<div class="auth-wrap"><form method="post" action="/forgot" class="auth">
    ${ui.panda("close", "auth-panda")}
    <label for="email">your email</label>
    <input id="email" name="email" type="email" autocomplete="username" required autofocus>
    <button class="btn accent big" type="submit">ping me a reset link</button>
    ${message ? `<p class="note" role="status">${ui.esc(message)}</p>` : '<p class="note">the link goes to your phone through scout\'s alerts. no phone alerts set up? then there\'s no way to reset it yet.</p>'}
    <p class="swap"><a href="/login">back to log in</a></p>
  </form></div>`, { title: "Forgot password", page: "login", lead: "it happens.", head: "let's fix it.", nav: false, links: '<a class="pill-link" href="/hello">what is scout?</a>', css: HEAD_CSS + AUTH_CSS });
}

async function forgot(request, env, url, ui) {
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const sent = "if that email has phone alerts set up, a reset link is on its way to your phone. it works for 30 minutes.";
  if (!env.DB || !email) return forgotPage(ui, sent);
  await ensureSchema(env);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const keys = [[`forgot:${ip}`, 5], [`forgot-e:${email}|${ip}`, 3]];
  if (await lockedOut(env, keys)) return forgotPage(ui, "too many tries. give it 15 minutes.");
  await noteFail(env, keys);
  const row = await env.DB.prepare("SELECT u.id, u.pw, u.answers, m.topic FROM users u JOIN student_meta m ON m.user_id = u.id WHERE u.email = ?").bind(email).first();
  if (row && [].concat(safeParse(row.answers).channel || []).some((c) => String(c).startsWith("phone"))) {
    const exp = Date.now() + RESET_MINUTES * 60e3;
    const link = `${url.origin}/reset?t=${row.id}.${exp}.${await resetSig(env, ui, row.id, exp, row.pw)}`;
    ui.waitUntil(ping(row.topic, { title: "Scout: reset your password", message: "tap to pick a new password. if you didn't ask for this, ignore it; nothing changes.", click: link }));
  }
  return forgotPage(ui, sent);
}

async function reset(request, env, url, ui) {
  const token = String(url.searchParams.get("t") || "");
  const [id, exp, sig] = token.split(".");
  const bad = () => forgotPage(ui, "that link has expired or was already used. ask for a new one.");
  if (!env.DB || !id || !exp || !sig || Number(exp) < Date.now()) return bad();
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT id, email, pw FROM users WHERE id = ?").bind(Number(id)).first();
  if (!row || !(await ui.sameSecret(sig, await resetSig(env, ui, row.id, exp, row.pw)))) return bad();
  const form = (message) => ui.page(`<div class="auth-wrap"><form method="post" action="/reset?t=${ui.esc(token)}" class="auth">
    ${ui.panda("thumbs", "auth-panda")}
    <label for="password">new password</label>
    <div class="pw"><input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required autofocus aria-describedby="pw-note"><button type="button" class="show" aria-pressed="false">show</button></div>
    <p class="note" id="pw-note">10 characters or more.</p>
    <button class="btn accent big" type="submit">save it and log in</button>
    ${message ? `<p class="warn">${ui.esc(message)}</p>` : ""}
  </form></div>`, { title: "New password", page: "login", lead: "new", head: "password", nav: false, links: "", css: HEAD_CSS + AUTH_CSS, script: AUTH_JS }, message ? 400 : 200);
  if (request.method !== "POST") return form("");
  const password = String((await request.formData()).get("password") || "");
  if (password.length < 10) return form("the password needs 10 characters or more.");
  const pw = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pw = ?, updated_at = ? WHERE id = ?").bind(pw, new Date().toISOString(), row.id),
    // Clear this email's lockout so the new password works right away. Exact prefixes, not LIKE (an email can hold "_").
    env.DB.prepare("DELETE FROM login_fails WHERE key = ? OR substr(key, 1, ?) = ?").bind(`e:${row.email}`, `e+ip:${row.email}|`.length, `e+ip:${row.email}|`),
  ]);
  return ui.redirect("/", [["Set-Cookie", await userCookie(env, row.id, ui, pw)]]);
}

async function deleteAccount(env, user, ui) {
  await deleteStudentData(env, user.id);
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  return ui.redirect("/hello?bye=1", [["Set-Cookie", `${USER_COOKIE}=; Path=/; Max-Age=0`]]);
}

/* ---------------------------------------------------------------- the questions, one step per screen */

const STEP_CSS = `
body[data-page="start"]{padding-bottom:40px}
body[data-page="start"][data-color="orange"]{--page:var(--orange)} body[data-page="start"][data-color="purple"]{--page:var(--purple)}
body[data-page="start"][data-color="teal"]{--page:var(--teal)} body[data-page="start"][data-color="sand"]{--page:var(--sand);--on-page:var(--ink)}
.progress{display:flex;gap:6px;margin:4px 0 6px} .progress i{flex:1;height:12px;border:var(--line) solid var(--ink);border-radius:999px;background:var(--cream)}
.progress i.done{background:var(--ink)} .progress i.now{background:var(--accent)}
.step-count{font-weight:700;font-size:var(--small);color:var(--on-page);margin:0 0 4px}
body[data-page="start"] h1{padding-right:190px;text-wrap:balance} body[data-page="start"] h1 .head{text-wrap:balance}
@media (max-width:899px){body[data-page="start"] h1{padding-right:130px}}
@media (max-width:560px){body[data-page="start"] h1{padding-right:84px}}
.why-line{color:var(--on-page);font-weight:700;margin:6px 0 18px;max-width:52ch;text-wrap:pretty}
.qcard>*{min-width:0} .q select{max-width:100%;text-overflow:ellipsis}
.qcard{background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;display:grid;gap:22px}
.q{display:grid;gap:8px;border:0;margin:0;padding:0;min-width:0} .q[hidden]{display:none}
.q legend,.q>label{font-weight:700;font-size:17px;padding:0;margin:0} .q legend{margin-bottom:8px}
.q .need{margin-left:3px;color:var(--red);text-decoration:none;font-weight:700}
.legend{margin:0;font-size:var(--small);color:var(--muted)} .legend b{color:var(--red)}
.q .qwhy{font-size:var(--small);color:var(--muted);margin:0} .q>label+.qwhy{margin-top:-6px}
.q input[type=text],.q input[type=url],.q select,.q textarea{font:500 var(--text) var(--font);color:var(--ink);background:#fff;border:var(--line) solid var(--ink);border-radius:12px;padding:11px 13px;width:100%}
.q textarea{min-height:110px;resize:vertical}
.q input:focus,.q select:focus,.q textarea:focus{outline:none;box-shadow:0 0 0 4px var(--accent)}
.q .pair{display:grid;grid-template-columns:1.4fr 1fr;gap:10px}
.opts{display:flex;flex-wrap:wrap;gap:8px}
.opt{position:relative;max-width:100%;min-width:0} .opt span{max-width:100%}
.opt input{position:absolute;opacity:0;top:0;left:0;width:100%;height:100%;min-width:0;border:0;box-shadow:none;margin:0;padding:0;cursor:pointer;appearance:none;-webkit-appearance:none}
.opt span{display:inline-block;font-weight:700;font-size:14px;background:#fff;border:var(--line) solid var(--ink);border-radius:999px;padding:8px 14px;box-shadow:3px 3px 0 var(--ink);transition:transform .15s cubic-bezier(.3,1.6,.5,1),box-shadow .15s,background-color .15s;user-select:none}
.opt input:checked+span{background:var(--ink);color:var(--cream)}
.opt.taken span{border-style:dashed;box-shadow:none;background:transparent} .opt.taken span::after{content:" · dream";font-weight:700;color:var(--muted)} .opt.taken{cursor:not-allowed}
.co-opt span{display:inline-flex;align-items:center;gap:8px;padding:5px 14px 5px 5px}
.co-opt img{width:28px;height:28px;border-radius:50%;object-fit:cover;background:#fff;border:2px solid var(--ink);flex:none}
.opt input:checked+span img{border-color:var(--cream)} .co-opt input:checked+span::before{content:none}
.q .sub{font-weight:700;font-size:var(--small);color:var(--muted);margin-top:12px}
.opt input:checked+span::before{content:"✓ "}
.opt input:focus-visible+span{outline:3px solid var(--ink);outline-offset:3px}
@media (hover:hover){.opt span:hover{transform:translate(-1px,-1px) rotate(-1.5deg)}}
.more summary{display:inline-block;cursor:pointer;font-weight:700;font-size:14px;margin:0;padding:7px 14px;border:2px dashed var(--ink);border-radius:999px;list-style:none} .more summary::-webkit-details-marker{display:none} .more[open] .opts{margin-top:8px} .more summary::before{content:"+ "} .more[open] summary::before{content:"− "}
.step-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:22px}
.step-actions .back{color:var(--on-page);font-weight:700}
.step-go{display:flex;align-items:center;gap:24px;margin-left:auto} .legend a{color:var(--ink);font-weight:700}
.payoff{display:inline-flex;align-items:baseline;gap:8px;margin:-6px 0 18px;background:var(--cream);border:var(--line) solid var(--ink);border-radius:999px;padding:6px 16px;box-shadow:var(--shadow-sm);font-weight:700;white-space:nowrap;max-width:100%}
.payoff b{font-family:var(--display);font-weight:400;font-size:20px}
.payoff.none{white-space:normal;border-radius:12px}
@media (max-width:560px){.step-actions .btn.big{flex:1} .step-go{flex:1;justify-content:flex-end} .step-go .btn{flex:1;text-align:center}}
.qerr{background:var(--red);color:#fff;border:var(--line) solid var(--ink);border-radius:12px;padding:10px 14px;font-weight:700;box-shadow:var(--shadow-sm)}
.q.bad legend,.q.bad>label{color:var(--red)}
@media (min-width:900px){body[data-page="start"] main,body[data-page="start"] header{max-width:720px} body[data-page="start"] main{display:block}}
@media (prefers-reduced-motion:reduce){.opt span{transition:none}}
`;

function stepIndex(url) {
  const n = Number(url.searchParams.get("step") || 1);
  return Number.isInteger(n) && n >= 1 && n <= STEPS.length ? n : 1;
}

function fieldHtml(f, answers, bad, ui) {
  const v = answers[f.name];
  const need = f.required ? '<abbr class="need" title="needed">*</abbr>' : "";
  const why = f.why ? `<p class="qwhy">${ui.esc(f.why)}</p>` : "";
  const id = `q-${f.name}`;
  const cls = `q${bad.includes(f.name) ? " bad" : ""}`;
  // A follow-up question (showIf) stays hidden until its answer is picked; the step script toggles it.
  const gate = f.showIf ? ` data-show-if="${f.showIf[0]}=${ui.esc(f.showIf[1])}"${answers[f.showIf[0]] === f.showIf[1] ? "" : " hidden"}` : "";
  if (f.type === "radio" || f.type === "chips") {
    const picked = f.type === "chips" ? (Array.isArray(v) ? v : []) : [v];
    const kind = f.type === "chips" ? "checkbox" : "radio";
    const chip = (o) => `<label class="opt"><input type="${kind}" name="${f.name}" value="${ui.esc(o)}"${picked.includes(o) ? " checked" : ""}${f.required && kind === "radio" ? " required" : ""}><span>${ui.esc(o)}</span></label>`;
    // More than 8 options is a wall of chips: show 6 and fold the rest, opened already if one of them is picked.
    const many = f.options.length > 8;
    const rest = many ? f.options.slice(6) : [];
    return `<fieldset class="${cls}"><legend>${ui.esc(f.label)}${need}</legend>${why}<div class="opts">${(many ? f.options.slice(0, 6) : f.options).map(chip).join("")}</div>${many
      ? `<details class="more"${rest.some((o) => picked.includes(o)) ? " open" : ""}><summary>more ${f.name === "fields" ? "fields" : "options"}</summary><div class="opts">${rest.map(chip).join("")}</div></details>` : ""}</fieldset>`;
  }
  if (f.type === "companies") {
    // Logo chips for the companies most students ask about, the rest folded, and a box for anyone else.
    const picked = Array.isArray(v) ? v : [];
    const known = new Set(COMPANIES.map(([n]) => n));
    const chip = ([n, logo]) => `<label class="opt co-opt"><input type="checkbox" name="${f.name}" value="${ui.esc(n)}"${picked.includes(n) ? " checked" : ""}><span><img src="${ui.esc(logo)}" alt="" loading="lazy" onerror="this.remove()">${ui.esc(n)}</span></label>`;
    const rest = COMPANIES.slice(12);
    const others = picked.filter((n) => !known.has(n));
    return `<fieldset class="${cls}"><legend>${ui.esc(f.label)}${need}</legend>${why}<div class="opts">${COMPANIES.slice(0, 12).map(chip).join("")}</div>
      <details class="more"${rest.some(([n]) => picked.includes(n)) ? " open" : ""}><summary>more companies</summary><div class="opts">${rest.map(chip).join("")}</div></details>
      <label class="sub" for="${id}-other">anyone else? separate with commas</label>
      <input id="${id}-other" name="${f.name}_other" type="text" value="${ui.esc(others.join(", "))}" placeholder="a startup you love" autocomplete="off"></fieldset>`;
  }
  if (f.type === "select") {
    const cur = v ?? f.default ?? "";
    return `<div class="${cls}"><label for="${id}">${ui.esc(f.label)}${need}</label>${why}<select id="${id}" name="${f.name}">${f.options.map((o) =>
      `<option value="${ui.esc(o)}"${o === cur ? " selected" : ""}>${o ? ui.esc(o) : "pick one"}</option>`).join("")}</select></div>`;
  }
  if (f.type === "monthyear") {
    const [m, y] = String(v || "").split(" ");
    return `<fieldset class="${cls}"><legend>${ui.esc(f.label)}${need}</legend>${why}<div class="pair">
      <select name="${f.name}_month" aria-label="month"${f.required ? " required" : ""}><option value="">month</option>${MONTHS.map((o) => `<option${o === m ? " selected" : ""}>${o}</option>`).join("")}</select>
      <select name="${f.name}_year" aria-label="year"${f.required ? " required" : ""}><option value="">year</option>${YEARS.map((o) => `<option${o === y ? " selected" : ""}>${o}</option>`).join("")}</select></div></fieldset>`;
  }
  if (f.type === "textarea") {
    return `<div class="${cls}"><label for="${id}">${ui.esc(f.label)}${need}</label>${why}<textarea id="${id}" name="${f.name}" placeholder="${ui.esc(f.placeholder || "")}">${ui.esc(v || "")}</textarea></div>`;
  }
  const shown = f.type === "tags" && Array.isArray(v) ? v.join(", ") : v || "";
  return `<div class="${cls}"${gate}><label for="${id}">${ui.esc(f.label)}${need}</label>${why}<input id="${id}" name="${f.name}" type="${f.type === "url" ? "url" : "text"}" value="${ui.esc(shown)}" placeholder="${ui.esc(f.placeholder || "")}"${f.required ? " required" : ""} autocomplete="off"></div>`;
}

const STEP_JS = `function syncCos(){var d={};document.querySelectorAll('input[name="dream"]:checked').forEach(function(i){d[i.value]=1});document.querySelectorAll('input[name="excited"]').forEach(function(i){var on=!!d[i.value];i.disabled=on;if(on)i.checked=false;i.closest(".opt").classList.toggle("taken",on)})}syncCos();
document.addEventListener("change",function(e){syncCos();document.querySelectorAll("[data-show-if]").forEach(function(q){var p=q.dataset.showIf.split("="),on=document.querySelector('input[name="'+p[0]+'"]:checked');q.hidden=!(on&&on.value===p[1])})});`;

async function stepPage(user, ui, url, bad = [], answers = user.answers, status = 200) {
  const n = stepIndex(url);
  const step = STEPS[n - 1];
  const fromYou = url.searchParams.get("from") === "you";
  const hasRequired = step.fields.some((f) => f.required);
  // The payoff shows up as soon as there's something to count (after "what you want"), so the rest of the
  // questions feel like they're sharpening a real list. The count is real, from the last cron run.
  const fit = n >= 4 && !fromYou ? await ui.fits(answers) : null;
  const payoff = fit ? (fit.count
    ? `<p class="payoff"><b>${fit.count}</b> ${fit.count === 1 ? "posting fits" : "postings fit"} so far</p>`
    : `<p class="payoff none">nothing open fits yet. scout checks the lists every hour.</p>`) : "";
  const dots = STEPS.map((_, i) => `<i class="${i + 1 < n ? "done" : i + 1 === n ? "now" : ""}"></i>`).join("");
  const body = `
    <div class="progress" role="progressbar" aria-valuemin="1" aria-valuemax="${STEPS.length}" aria-valuenow="${n}" aria-label="step ${n} of ${STEPS.length}">${dots}</div>
    <p class="step-count">step ${n} of ${STEPS.length} · ${ui.esc(step.short)}</p>
    <h1><span class="lead">${ui.esc(step.lead)}</span><span class="head">${ui.esc(step.head)}</span>${ui.panda(step.pose, "hero-panda")}</h1>
    <p class="why-line">${ui.esc(step.why)}</p>
    ${payoff}
    <form method="post" action="/start?step=${n}${fromYou ? "&from=you" : ""}" novalidate>
      ${bad.length ? `<p class="qerr" role="alert">${bad.length === 1 ? "one thing still needs an answer." : `${bad.length} things still need an answer.`}</p>` : ""}
      <div class="qcard">${hasRequired ? '<p class="legend"><b>*</b> scout needs these. everything else is optional.</p>' : fromYou ? '<p class="legend">all optional.</p>' : `<p class="legend">all optional. <a href="${n === STEPS.length ? "/?welcome=1" : `/start?step=${n + 1}`}">skip this step</a> if you want.</p>`}${step.fields.map((f) => fieldHtml(f, answers, bad, ui)).join("")}</div>
      <div class="step-actions">
        ${fromYou ? '<a class="back" href="/you">cancel</a>' : n > 1 ? `<a class="back" href="/start?step=${n - 1}">← back</a>` : ""}
        <span class="step-go"><button class="btn accent big" type="submit">${fromYou ? "save" : n === STEPS.length ? "finish" : "next →"}</button></span>
      </div>
    </form>`;
  return withColor(ui.page(body, { title: `Step ${n}`, page: "start", nav: false, links: '<a class="pill-link" href="/logout">log out</a>', css: HEAD_CSS + STEP_CSS, script: STEP_JS }, status), step.color);
}

// The page shell sets data-page; the step's color rides on a second attribute so each step gets its own page color.
async function withColor(response, color) {
  const html = (await response.text()).replace('<body data-page="start">', `<body data-page="start" data-color="${color}">`);
  return new Response(html, { status: response.status, headers: response.headers });
}

function readStep(form, step) {
  const out = {};
  for (const f of step.fields) {
    if (f.type === "chips") out[f.name] = form.getAll(f.name).map(String).filter((o) => f.options.includes(o));
    else if (f.type === "companies") {
      const known = new Set(COMPANIES.map(([n]) => n));
      const extra = String(form.get(`${f.name}_other`) || "").split(",").map((t) => t.trim().slice(0, 80)).filter(Boolean);
      out[f.name] = [...new Set([...form.getAll(f.name).map(String).filter((n) => known.has(n)), ...extra])].slice(0, 40);
    }
    else if (f.type === "radio" || f.type === "select") {
      const v = String(form.get(f.name) || "");
      out[f.name] = f.options.includes(v) ? v : "";
    } else if (f.type === "monthyear") {
      const m = String(form.get(`${f.name}_month`) || ""), y = String(form.get(`${f.name}_year`) || "");
      out[f.name] = MONTHS.includes(m) && YEARS.includes(y) ? `${m} ${y}` : "";
    } else if (f.type === "tags") {
      out[f.name] = String(form.get(f.name) || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 40).map((t) => t.slice(0, 80));
    } else if (f.type === "url") {
      const v = String(form.get(f.name) || "").trim().slice(0, 300);
      out[f.name] = /^https?:\/\/\S+$/i.test(v) ? v : v ? `https://${v.replace(/^\/+/, "")}` : "";
    } else {
      out[f.name] = String(form.get(f.name) || "").trim().slice(0, f.type === "textarea" ? 2000 : 200);
    }
  }
  return out;
}

const missing = (step, values) => step.fields.filter((f) => f.required && (Array.isArray(values[f.name]) ? !values[f.name].length : !values[f.name])).map((f) => f.name);

async function saveStep(request, env, user, url, ui) {
  const n = stepIndex(url);
  const step = STEPS[n - 1];
  const values = readStep(await request.formData(), step);
  const answers = { ...user.answers, ...values };
  const bad = missing(step, values);
  if (bad.length) return stepPage(user, ui, url, bad, answers, 400);
  const furthest = Math.max(user.step, n);
  // Sign-up only finishes when every step's required answers are in. Jumping to the last step's URL used to mark
  // an account done with no graduation year or fields, which breaks matching.
  const gap = firstIncomplete({ answers });
  const done = gap > STEPS.length ? 1 : 0;
  if (n === STEPS.length && !done && url.searchParams.get("from") !== "you") {
    await env.DB.prepare("UPDATE users SET answers = ?, step = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(answers), furthest, new Date().toISOString(), user.id).run();
    return ui.redirect(`/start?step=${gap}&missing=1`);
  }
  await env.DB.prepare("UPDATE users SET answers = ?, step = ?, done = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(answers), furthest, done, new Date().toISOString(), user.id).run();
  if (done) await metaFor(env, user.id); // alerts need the student's topic row, even before they open a page
  if (url.searchParams.get("from") === "you") return ui.redirect(`/you?saved=${step.id}`);
  return ui.redirect(n === STEPS.length ? "/?welcome=1" : `/start?step=${n + 1}`);
}

const safeParse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

// The first step with a required answer still missing, or STEPS.length + 1 when every required answer is in.
function firstIncomplete(user) {
  const i = STEPS.findIndex((s) => missing(s, user.answers || {}).length);
  return i === -1 ? STEPS.length + 1 : i + 1;
}

// Where an unfinished sign-up picks up: the first gap, or the step after the furthest one they saved.
function resumeStep(user) {
  return Math.min(firstIncomplete(user), (user.step || 0) + 1, STEPS.length);
}

/* ---------------------------------------------------------------- the "you" page */

// The you page's buttons: copy the topic, send a test ping. Same-origin JSON with a custom header, like student.js.
const STUDENT_YOU_JS = `if(matchMedia("(min-width:900px)").matches){var w=document.querySelector(".answers-wrap");if(w)w.open=true}
document.addEventListener("click",function(e){var b=e.target.closest("[data-u]");if(!b||b.disabled)return;
if(b.dataset.u==="copy"){var t=document.getElementById(b.dataset.src);(navigator.clipboard?navigator.clipboard.writeText(t.value):Promise.reject()).then(function(){b.textContent="copied ✓";setTimeout(function(){b.textContent="copy"},1600)},function(){t.select()});return}
if(b.dataset.u==="test"){b.disabled=true;b.textContent="sending...";fetch("/api/u/test",{method:"POST",headers:{"Content-Type":"application/json","x-scout":"1"},body:"{}"}).then(function(r){return r.json()}).then(function(r){b.textContent=r.ok?"sent. check your phone":"that didn't send. try again";b.disabled=false},function(){b.textContent="that didn't send. try again";b.disabled=false})}});`;

const YOU_CSS = `
body[data-page="you"]{--page:var(--teal)}
.you-line{margin:-4px 0 26px;font-weight:700;font-size:18px;color:var(--on-page);max-width:56ch}
.ans .edit{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border:2px solid var(--ink);border-radius:999px;background:#fff;color:var(--ink);font-weight:700;text-decoration:none}
.ans .add{color:var(--muted);font-weight:700;display:inline-block;padding:4px 0}
.alerts .alt{margin-top:10px;font-size:var(--small)}
.answers{display:grid;gap:14px}
.ans{background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:16px 18px}
.ans header{all:unset;display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
.ans h3{margin:0;font-family:var(--display);font-size:18px;text-transform:uppercase}
.ans dl{margin:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:6px 14px;font-size:14px}
@media (min-width:900px){.ans dl{grid-template-columns:200px minmax(0,1fr)}}
@media (max-width:600px){.ans dl{grid-template-columns:1fr;gap:0} .ans dt{font-size:var(--small);margin-top:14px} .ans dt:first-child{margin-top:0} .ans dd{font-size:16px;margin:2px 0 0}}
.ans dt{color:var(--muted);font-weight:700} .ans dd{margin:0;overflow-wrap:anywhere}
.ans.just-saved{outline:4px solid var(--accent);outline-offset:3px}
.answers-wrap>summary{list-style:none;cursor:pointer;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap} .answers-wrap>summary::-webkit-details-marker{display:none}
.answers-wrap>summary h2{margin-bottom:12px} .answers-wrap:not([open])>summary h2::after{display:none} .answers-wrap>summary .count{font-weight:700;font-size:var(--small);color:var(--on-page)}
.answers-wrap:not([open])>summary{background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:12px 18px;margin:0 0 26px}
.answers-wrap:not([open])>summary h2{color:var(--ink);margin:0} .answers-wrap:not([open])>summary .count{color:var(--muted)}
.answers-wrap:not([open])>summary::after{content:"show ▾";margin-left:auto;font-weight:700}
.alerts{margin:0 0 26px;position:relative} .alerts-panda{position:absolute;right:14px;top:14px;width:76px;height:76px} .alerts h3+p{padding-right:84px}
@media (max-width:600px){.alerts-panda{width:60px;height:60px} .alerts h3+p{padding-right:64px}}
.alerts h3{padding-right:80px;font-family:var(--display);text-transform:uppercase;font-size:20px;margin:0 0 6px} .alerts p{margin:0 0 8px} .alerts a{color:var(--ink);font-weight:700}
.alerts .turn-on{margin:14px 0 0} .alerts .alt{margin:12px 0 0}
.setup{margin:10px 0;padding-left:22px;display:grid;gap:12px} .setup li::marker{font-weight:700}
.topic{display:flex;gap:8px;margin-top:8px} .topic input{flex:1;min-width:0;font:600 14px var(--mono);color:var(--ink);background:#fff;border:var(--line) solid var(--ink);border-radius:12px;padding:10px 12px;box-shadow:none}
.account{margin:0 0 26px} .account h3{font-family:var(--display);text-transform:uppercase;font-size:20px;margin:0 0 4px}
.account ul{list-style:none;margin:0;padding:0} .account li{border-top:2px solid color-mix(in srgb,var(--ink) 14%,transparent)} .account li:first-child{border-top:0}
.account a,.account button{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:48px;padding:0;background:none;border:0;box-shadow:none;color:var(--ink);font:700 16px var(--font);text-decoration:none;cursor:pointer;text-align:left}
.account a::after{content:"→"} .account a:hover,.account button:hover{text-decoration:underline}
.account .danger,.account .danger button{margin:0} .account .danger button{color:var(--red)}

/* Desktop: settings on the left, every answer open on the right, all lined up with the header and tabs. */
@media (min-width:900px){
  body[data-page="you"] main{grid-template-columns:minmax(300px,380px) minmax(0,1fr);column-gap:28px;align-content:start}
  body[data-page="you"] main>h1,.you-line{grid-column:1 / -1} .alerts{grid-column:1;grid-row:3} .account{grid-column:1;grid-row:4}
  .answers-wrap{grid-column:2;grid-row:3 / span 3} .answers-wrap>summary{pointer-events:none} .answers-wrap>summary::after{display:none}
  .answers-wrap>summary h2{color:var(--ink);font-size:28px} .answers-wrap>summary .count{color:var(--on-page)}
  .answers{display:block;columns:2;column-gap:16px} .answers .ans{break-inside:avoid;margin-bottom:16px}
  .answers .ans dl{grid-template-columns:1fr;gap:0} .answers .ans dt{font-size:var(--small);margin-top:12px} .answers .ans dt:first-child{margin-top:0} .answers .ans dd{margin:2px 0 0}}
`;

function shown(f, v) {
  if (Array.isArray(v)) return v.join(", ");
  return v || "";
}

function youPage(user, ui, saved, meta, tracked) {
  const a = user.answers;
  const first = (a.name || "").split(" ")[0] || "you";
  const all = saved === "all";
  const cards = STEPS.map((s, i) => `
    <section class="ans${saved === s.id ? " just-saved" : ""}" id="${s.id}">
      <header><h3>${ui.esc(s.short)}</h3><a class="edit" href="/start?step=${i + 1}&from=you">edit</a></header>
      <dl>${s.fields.filter((f) => !f.showIf || a[f.showIf[0]] === f.showIf[1]).map((f) => {
        const raw = f.name === "gpa" && a.gpa ? "saved, kept private" : shown(f, a[f.name]);
        const v = f.type === "url" ? raw.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : raw;
        return `<dt>${ui.esc(f.label)}</dt><dd>${v ? ui.esc(v) : `<a class="add" href="/start?step=${i + 1}&from=you">add</a>`}</dd>`;
      }).join("")}</dl>
    </section>`).join("");
  // Peak-end: the page ends the sign-up on real postings, not a thank-you note.
  const phone = [].concat(a.channel || []).some((c) => String(c).startsWith("phone"));
  const topicUrl = `https://ntfy.sh/${meta.topic}`;
  const alerts = `
    <section class="card alerts" id="alerts">
      ${ui.panda(phone ? "close" : "nap", "alerts-panda")}
      <h3>phone alerts</h3>
      ${phone ? `<p>${a.speed === "tell me right away" ? "strong matches ping you within the hour they post" : a.speed === "once a week" ? "a digest every Monday" : "one digest a day"}${a.speed !== "tell me right away" && a.digest_time ? ` at ${ui.esc(a.digest_time)}` : ""}${a.quiet && a.quiet !== "no quiet hours" ? `, never ${ui.esc(a.quiet.replace(/^during class /, "during class, "))}` : ""}.</p>
      <ol class="setup">
        <li>get the free <b>ntfy</b> app (<a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a> or <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>).</li>
        <li>tap <b>+</b> and subscribe to this topic. it's yours alone, so keep it to yourself:
          <div class="topic"><input id="topic" readonly value="${ui.esc(meta.topic)}" aria-label="your alert topic"><button class="btn" type="button" data-u="copy" data-src="topic" data-label="copy">copy</button></div></li>
        <li><button class="btn accent" type="button" data-u="test">send a test ping</button></li>
      </ol>
      <p class="alt">on a computer instead? open <a href="${ui.esc(topicUrl)}" target="_blank" rel="noopener">your topic in the browser</a>.</p>`
      : `<p>phone alerts are off, so new matches wait for you on the new page.</p><p class="turn-on"><a class="btn accent" href="/start?step=7&from=you">turn them on</a></p>`}
    </section>`;
  const body = `
    <p class="you-line">${all ? `that's everything scout needs, ${ui.esc(first.toLowerCase())}.` : `everything you told scout, ${ui.esc(first.toLowerCase())}.`} ${all ? "change any answer whenever you want." : "tap edit to change anything."}</p>
    ${alerts}
    <details class="answers-wrap"${saved && saved !== "all" ? " open" : ""}><summary><h2>your answers</h2><span class="count">9 groups · edit anytime</span></summary>
      <div class="answers">${cards}</div>
    </details>
    <section class="card account"><h3>your account</h3><ul>
      <li><a href="/you/export">download my data</a></li>
      <li><a href="/privacy">privacy</a></li>
      <li><form class="danger" method="post" action="/you/delete" onsubmit="return confirm('delete your account and every answer? this can\\'t be undone.')"><button type="submit">delete my account</button></form></li>
    </ul></section>`;
  return ui.page(body, { title: "You", page: "you", lead: all ? "nice," : "your", head: all ? "you're set" : "scout", nav: false, links: `<a class="pill-link" href="/logout">log out</a>`, dock: user.done ? studentDock("you", tracked) : "", css: HEAD_CSS + YOU_CSS + STUDENT_CSS, script: STUDENT_YOU_JS });
}

/* ---------------------------------------------------------------- the landing page */

async function landing(ui, signedIn = false) {
  return ui.page(landingBody(ui, signedIn, await ui.landingData()), {
    title: "Find the internship before it closes", page: "landing", nav: false,
    links: signedIn ? '<a class="pill-link" href="/">open scout</a>' : '<a class="pill-link" href="/login">log in</a>',
    css: LANDING_CSS, script: LANDING_JS,
  });
}

export const QUESTION_STEPS = STEPS; // for tests and the future settings sync
