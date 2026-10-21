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

const USER_COOKIE = "scout_u";
const COOKIE_DAYS = 30;
const PBKDF2_ROUNDS = 100000; // the most Workers' Web Crypto allows
const LOCK_WINDOW = 15 * 60 * 1000;
const LOCK_AFTER = 8;

/* ---------------------------------------------------------------- the questions */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const YEARS = Array.from({ length: 10 }, (_, i) => String(2026 + i));
const HOURS = ["6:00 AM", "7:00 AM", "8:00 AM", "9:00 AM", "12:00 PM", "3:00 PM", "5:00 PM", "6:00 PM", "7:00 PM", "8:00 PM", "9:00 PM", "10:00 PM"];
const QUIET = ["no quiet hours", "10:00 PM to 7:00 AM", "11:00 PM to 8:00 AM", "midnight to 9:00 AM", "during class (9:00 AM to 3:00 PM)"];
const ZONES = ["Eastern (New York)", "Central (Chicago)", "Mountain (Denver)", "Pacific (Los Angeles)", "Alaska", "Hawaii", "outside the US"];
const FIELDS = ["software engineering", "product management", "data and analytics", "AI and machine learning", "UX/UI and product design",
  "IT and support", "cybersecurity", "hardware", "quant and finance", "consulting", "marketing", "business and operations", "research", "something else"];

// Each step is one screen. `why` is the line under the step title: people answer more when they know what it's for.
// Field types: text, url, select, radio (pick one), chips (pick any), tags (comma list), textarea.
const STEPS = [
  {
    id: "you", short: "you", lead: "first,", head: "about you", pose: "wave", color: "orange",
    why: "your school year and graduation date decide most of what you can apply to, so these come first.",
    fields: [
      { name: "name", label: "what should we call you?", type: "text", required: true, placeholder: "first name is fine" },
      { name: "school", label: "school", type: "text", required: true, placeholder: "NJIT, Rutgers, Stanford... or \"not in school\"" },
      { name: "degree", label: "what degree are you working on?", type: "radio", required: true, options: ["associate", "bachelor's", "master's", "PhD", "bootcamp", "none right now"] },
      { name: "major", label: "major", type: "text", required: true, placeholder: "computer science" },
      { name: "minor", label: "second major or minor", type: "text", placeholder: "optional" },
      { name: "year", label: "year in school", type: "radio", required: true, options: ["first", "second", "third", "fourth", "fifth or more", "recent grad"] },
      { name: "grad", label: "when do you graduate?", type: "monthyear", required: true, why: "postings say \"graduating in 2028\" all the time. this is how scout skips the ones that aren't you." },
      { name: "gpa", label: "GPA", type: "text", placeholder: "optional, never shown to anyone", why: "only used when a posting has a cutoff." },
      { name: "cross_major", label: "open to roles meant for other majors?", type: "radio", options: ["yes", "maybe", "no"] },
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
      { name: "dream", label: "dream companies", type: "tags", placeholder: "Apple, Figma, Spotify" },
      { name: "excited", label: "companies you'd be excited about", type: "tags", placeholder: "Duolingo, Notion, Pinterest" },
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
      { name: "channel", label: "where should alerts go?", type: "chips", options: ["phone (the free ntfy app)", "email"] },
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
  ]);
  schemaReady = true;
}

async function userById(env, id) {
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  return row ? { ...row, answers: JSON.parse(row.answers || "{}") } : null;
}

/* ---------------------------------------------------------------- passwords and sessions */

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));

async function hashPassword(password, saltHex = hex(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(saltHex), iterations: PBKDF2_ROUNDS }, key, 256);
  return `pbkdf2$${PBKDF2_ROUNDS}$${saltHex}$${hex(bits)}`;
}

async function checkPassword(password, stored, ui) {
  const [, , salt] = String(stored).split("$");
  return salt ? ui.sameSecret(await hashPassword(password, salt), stored) : false;
}

async function userCookie(env, id, ui) {
  const expires = Date.now() + COOKIE_DAYS * 86400e3;
  const sig = await ui.hmac(env.SESSION_SECRET, `u:${id}.${expires}`);
  return `${USER_COOKIE}=${id}.${expires}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}`;
}

async function currentUser(request, env, ui) {
  const raw = (request.headers.get("Cookie") || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(USER_COOKIE + "="));
  if (!raw || !env.SESSION_SECRET || !env.DB) return null;
  const [id, expires, sig] = raw.slice(USER_COOKIE.length + 1).split(".");
  if (!id || !expires || !sig || Number(expires) < Date.now()) return null;
  if (!(await ui.sameSecret(sig, await ui.hmac(env.SESSION_SECRET, `u:${id}.${expires}`)))) return null;
  await ensureSchema(env);
  return userById(env, Number(id));
}

async function lockedOut(env, keys) {
  const since = Date.now() - LOCK_WINDOW;
  for (const key of keys) {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_fails WHERE key = ? AND at > ?").bind(key, since).first();
    if (row && row.n >= LOCK_AFTER) return true;
  }
  return false;
}

async function noteFail(env, keys) {
  const now = Date.now();
  await env.DB.batch([
    ...keys.map((k) => env.DB.prepare("INSERT INTO login_fails (key, at) VALUES (?, ?)").bind(k, now)),
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
  if (path === "/" && !isOwner) return user ? ui.redirect(user.done ? "/you" : `/start?step=${Math.min(user.step + 1, STEPS.length)}`) : landing(ui);
  if (path === "/hello") return landing(ui, isOwner || !!user);
  if (path === "/login") {
    if (request.method !== "POST") return loginPage(ui, "", "");
    return login(request, env, ui);
  }
  if (path === "/signup") {
    if (!env.DB) return ui.page(`<div class="card"><p>sign up isn't open yet.</p></div>`, { title: "Sign up", page: "login", lead: "almost", head: "there", nav: false });
    if (user) return ui.redirect("/you");
    return request.method === "POST" ? signup(request, env, ui) : signupPage(ui, "", "");
  }
  if (path === "/start" || path === "/you" || path === "/you/delete") {
    if (!user) return ui.redirect(isOwner ? "/" : "/login");
    if (path === "/you/delete") return request.method === "POST" ? deleteAccount(env, user, ui) : ui.redirect("/you");
    if (path === "/you") return youPage(user, ui, url.searchParams.get("saved"), await ui.fits(user.answers));
    return request.method === "POST" ? saveStep(request, env, user, url, ui) : stepPage(user, ui, url);
  }
  // A signed-in user on any of the owner's pages goes to their own page; the owner's data is not theirs to see.
  if (user && !isOwner) return path.startsWith("/api/") ? ui.json({ error: "unauthorized" }, 401) : ui.redirect("/you");
  return null;
}

/* ---------------------------------------------------------------- log in and sign up */

const AUTH_CSS = `
.auth{background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow);padding:22px;display:grid;gap:0;position:relative}
.auth label{display:block;font-weight:700;font-size:var(--small);text-transform:lowercase;margin:18px 0 6px} .auth label:first-of-type{margin-top:0}
.auth input{font:500 var(--text) var(--font);color:var(--ink);background:#fff;border:var(--line) solid var(--ink);border-radius:12px;padding:12px 14px;width:100%}
.auth input:focus{outline:none;box-shadow:0 0 0 4px var(--accent)}
.auth .btn.big{margin-top:22px;justify-self:stretch;text-align:center}
.auth p{margin:0} .auth .note{margin-top:6px;color:var(--muted);font-size:var(--small)} .auth .warn{margin-top:12px} .auth .swap{margin-top:14px}
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
  body[data-page="login"] h1,body[data-page="signup"] h1{font-size:clamp(48px,5.2vw,76px);grid-column:1;margin:0}
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
  // The owner's dashboard password still works on its own, with the email left blank.
  if (!email) return ui.ownerLogin(password, () => loginPage(ui, "nope. try again.", ""));
  if (!env.DB) return loginPage(ui, "accounts aren't open yet.", email);
  await ensureSchema(env);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const keys = [`e:${email}`, `ip:${ip}`];
  if (await lockedOut(env, keys)) return loginPage(ui, "too many tries. give it 15 minutes.", email);
  const row = await env.DB.prepare("SELECT id, pw, done, step FROM users WHERE email = ?").bind(email).first();
  if (!row || !(await checkPassword(password, row.pw, ui))) {
    await noteFail(env, keys);
    return loginPage(ui, "that email and password don't match.", email);
  }
  return ui.redirect(row.done ? "/you" : `/start?step=${Math.min(row.step + 1, STEPS.length)}`, [["Set-Cookie", await userCookie(env, row.id, ui)]]);
}

async function signup(request, env, ui) {
  await ensureSchema(env);
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return signupPage(ui, "that email doesn't look right.", email);
  if (password.length < 10) return signupPage(ui, "the password needs 10 characters or more.", email);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await lockedOut(env, [`signup:${ip}`])) return signupPage(ui, "too many sign ups from here. try again in 15 minutes.", email);
  const taken = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (taken) return signupPage(ui, "there's already an account with that email. try logging in.", email);
  const now = new Date().toISOString();
  const result = await env.DB.prepare("INSERT INTO users (email, pw, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(email, await hashPassword(password), now, now).run();
  await noteFail(env, [`signup:${ip}`]); // counts sign ups per IP with the same window as failed logins
  return ui.redirect("/start?step=1", [["Set-Cookie", await userCookie(env, result.meta.last_row_id, ui)]]);
}

async function deleteAccount(env, user, ui) {
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

const STEP_JS = `document.addEventListener("change",function(e){document.querySelectorAll("[data-show-if]").forEach(function(q){var p=q.dataset.showIf.split("="),on=document.querySelector('input[name="'+p[0]+'"]:checked');q.hidden=!(on&&on.value===p[1])})});`;

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
    : `<p class="payoff none">nothing fits yet. the lists scout reads are mostly tech today, and more fields are on the way.</p>`) : "";
  const dots = STEPS.map((_, i) => `<i class="${i + 1 < n ? "done" : i + 1 === n ? "now" : ""}"></i>`).join("");
  const body = `
    <div class="progress" role="progressbar" aria-valuemin="1" aria-valuemax="${STEPS.length}" aria-valuenow="${n}" aria-label="step ${n} of ${STEPS.length}">${dots}</div>
    <p class="step-count">step ${n} of ${STEPS.length} · ${ui.esc(step.short)}</p>
    <h1><span class="lead">${ui.esc(step.lead)}</span><span class="head">${ui.esc(step.head)}</span>${ui.panda(step.pose, "hero-panda")}</h1>
    <p class="why-line">${ui.esc(step.why)}</p>
    ${payoff}
    <form method="post" action="/start?step=${n}${fromYou ? "&from=you" : ""}" novalidate>
      ${bad.length ? `<p class="qerr" role="alert">${bad.length === 1 ? "one thing still needs an answer." : `${bad.length} things still need an answer.`}</p>` : ""}
      <div class="qcard">${hasRequired ? '<p class="legend"><b>*</b> needed to find your matches. everything else is optional.</p>' : fromYou ? '<p class="legend">all optional.</p>' : `<p class="legend">all optional. <a href="${n === STEPS.length ? "/you?saved=all" : `/start?step=${n + 1}`}">skip this step</a> if you want.</p>`}${step.fields.map((f) => fieldHtml(f, answers, bad, ui)).join("")}</div>
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
  const done = user.done || (n === STEPS.length ? 1 : 0);
  await env.DB.prepare("UPDATE users SET answers = ?, step = ?, done = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(answers), furthest, done, new Date().toISOString(), user.id).run();
  if (url.searchParams.get("from") === "you") return ui.redirect(`/you?saved=${step.id}`);
  return ui.redirect(n === STEPS.length ? "/you?saved=all" : `/start?step=${n + 1}`);
}

/* ---------------------------------------------------------------- the "you" page */

const YOU_CSS = `
body[data-page="you"]{--page:var(--teal)}
.you-line{margin:-4px 0 26px;font-weight:700;font-size:18px;color:var(--on-page);max-width:56ch}
.you-hero{background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow);padding:22px;display:grid;grid-template-columns:1fr auto;gap:8px 16px;align-items:center;margin-bottom:26px}
.you-hero h2{margin:0;font-family:var(--display);font-size:clamp(24px,6vw,34px);line-height:1;text-transform:uppercase;color:var(--ink)}
.you-hero p{margin:0;grid-column:1} .you-hero .panda{grid-row:1 / span 3;grid-column:2;width:clamp(96px,22vw,140px);height:clamp(96px,22vw,140px)}
.firstlook{display:grid;gap:12px;margin:10px 0 30px} .look{display:block;text-decoration:none;color:var(--ink);margin:0}
.look .title{margin-top:6px}
.ans .edit,.ans .add{color:var(--ink);font-weight:700} .ans .add{color:var(--muted)}
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
.danger{margin-top:80px} .danger button{background:none;border:0;padding:0;color:var(--on-page);opacity:.7;font:500 12px var(--font);text-decoration:underline;cursor:pointer}
@media (min-width:900px){body[data-page="you"] main,body[data-page="you"] header{max-width:860px} body[data-page="you"] main{display:block} .firstlook{grid-template-columns:repeat(2,minmax(0,1fr))}
  .answers{display:block;columns:2;column-gap:16px} .answers .ans{break-inside:avoid;margin-bottom:16px}}
`;

function shown(f, v) {
  if (Array.isArray(v)) return v.join(", ");
  return v || "";
}

function youPage(user, ui, saved, fit) {
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
  const matches = fit.top.length ? `
    <h2>a first look</h2>
    <p class="note">${fit.count} open ${fit.count === 1 ? "posting fits" : "postings fit"} your fields right now. here are ${fit.top.length} of them.</p>
    <div class="firstlook">${fit.top.map((m) => `
      <a class="card look" href="${ui.esc(m.url)}" target="_blank" rel="noopener">
        <div class="row">${ui.coHead(m.company, m.logo, m.company)}<span class="score">${m.score}</span></div>
        <div class="title">${ui.esc(m.title)}</div>
        <div class="meta">${ui.esc(m.where)} · posting ↗</div>
      </a>`).join("")}</div>`
    : `<h2>a first look</h2><p class="note">${fit.tech ? "nothing open fits your fields this hour. scout checks again every hour." : "the lists scout reads are mostly tech today, so nothing fits your fields yet. more fields are on the way."}</p>`;
  const body = `
    <p class="you-line">${all ? `that's everything scout needs, ${ui.esc(first)}.` : `everything you told scout, ${ui.esc(first)}.`} ${all ? "change any answer whenever you want." : "tap edit to change anything."}</p>
    <details class="answers-wrap"${all ? "" : " open"}><summary><h2>your answers</h2><span class="count">9 groups · edit anytime</span></summary>
      <div class="answers">${cards}</div>
    </details>
    ${matches}
    <form class="danger" method="post" action="/you/delete" onsubmit="return confirm('delete your account and every answer? this can\\'t be undone.')"><button type="submit">delete my account</button></form>`;
  return ui.page(body, { title: "You", page: "you", lead: all ? "nice," : "your", head: all ? "you're set" : "scout", mood: all ? "celebrate" : "proud", nav: false, links: `<a class="pill-link" href="/logout">log out</a>`, css: HEAD_CSS + YOU_CSS });
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
