/* Scout dashboard. One Cloudflare Worker, one KV namespace, four pages, a password.
 *
 * Where the data comes from: the GitHub Actions cron (scout/sync.py push) POSTs each run's matches,
 * page-watcher state, and config text to /api/ingest with the INGEST_SECRET. The Worker keeps them in KV.
 * Where the data goes: tracker changes, "Prep this" taps, and "Pass" taps are stored in KV and pulled
 * back into data/ by the next cron run (scout/sync.py pull), so the repo stays the long-term record.
 *
 * Pages (all behind the password):   /  New   /programs   /review   /tracker   /settings
 * Review: prep kits uploaded from the Mac (scout.sync push --kits), to read, edit, copy, download, and mark
 * submitted. Kits hold the candidate's phone, email, and answers, so they live only here in KV, never in git.
 * JSON (cookie):                     POST /api/tracker  POST /api/queue  POST /api/pass  POST /api/kit-answer
 * JSON (secret header):              POST /api/ingest   POST /api/ingest-tracker   POST /api/ingest-kits   POST /api/ingest-mascot   GET /api/export
 * Open:                              GET /login  POST /login  GET /logout  GET /api/health  GET /panda/<name>.png
 *
 * Cron (wrangler.toml [triggers]): GitHub skips most of its scheduled runs (4 of 22 on October 15, 2026),
 * so this Worker checks every hour at :47. If no run has reached the dashboard in 50 minutes, it starts one
 * (GH_DISPATCH_TOKEN). If none has in 4 hours, it sends one phone alert per outage (NTFY_TOPIC).
 */

import tokens from "./tokens.css";
import { ICONS } from "./icons.js";

const STATES = ["Found", "Saved", "Prepped", "Applied", "OA", "Interview", "Offer", "Rejected", "Withdrawn", "Passed"];
const COOKIE = "scout";
const COOKIE_DAYS = 30;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Home-screen icons and the web app manifest are public: iOS fetches them without the login cookie.
    if (ICONS[path]) return png(ICONS[path]);
    // The borrowed panda is public like the icons: the login page shows it before anyone has a cookie.
    const pandaFile = path.match(/^\/panda\/([a-z-]+)\.png$/);
    if (pandaFile) return servePanda(env, pandaFile[1]);
    if (path === "/manifest.webmanifest") return manifest();
    if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });
    if (path === "/login") return request.method === "POST" ? login(request, env) : loginForm("");
    if (path === "/about") return aboutPage(await validCookie(request, env));
    if (path === "/logout") return redirect("/login", { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0` });

    // Cron endpoints: a shared secret, no cookie.
    if (path === "/api/ingest" || path === "/api/ingest-tracker" || path === "/api/ingest-kits" || path === "/api/ingest-mascot" || path === "/api/export") {
      if (!env.INGEST_SECRET || !(await sameSecret(request.headers.get("x-scout-secret") || "", env.INGEST_SECRET))) return json({ error: "unauthorized" }, 401);
      if (path === "/api/ingest-tracker") return ingestTracker(request, env);
      if (path === "/api/ingest-kits") return ingestKits(request, env);
      if (path === "/api/ingest-mascot") return ingestMascot(request, env);
      return path === "/api/ingest" ? ingest(request, env) : exportState(env);
    }

    // Everything else needs the login cookie.
    if (!(await validCookie(request, env))) {
      return path.startsWith("/api/") ? json({ error: "unauthorized" }, 401) : redirect("/login");
    }
    if (request.method === "POST") {
      if (path === "/api/tracker") return setTracker(request, env);
      if (path === "/api/queue") return setQueue(request, env);
      if (path === "/api/pass") return setPassed(request, env);
      if (path === "/api/kit-answer") return setKitAnswer(request, env);
      return json({ error: "not found" }, 404);
    }
    if (path === "/") return newPage(env);
    if (path === "/programs") return programsPage(env);
    if (path === "/tracker") return trackerPage(env);
    if (path === "/settings") return settingsPage(env);
    if (path === "/review") return reviewList(env);
    const kitFile = path.match(/^\/review\/([a-z0-9-]+)\/(resume|letter)\.pdf$/);
    if (kitFile) return kitPdf(env, kitFile[1], kitFile[2]);
    const kitPage = path.match(/^\/review\/([a-z0-9-]+)$/);
    if (kitPage) return reviewKit(env, kitPage[1]);
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(heartbeat(env, Date.now()));
  },
};

/* ---------------------------------------------------------------- cron: keep Scout running */

const START_AFTER_MIN = 50;   // GitHub's own :17 run reaches the dashboard by about :20, so :47 sees it
const WARN_AFTER_MIN = 240;   // the 6 AM gap (Morning Brief hours) is about 3 hours; 4 means something broke

async function heartbeat(env, now) {
  const data = await get(env, "matches", {});
  const last = Date.parse(data.generated_at || "") || 0;
  const ageMin = (now - last) / 60000;
  if (env.GH_DISPATCH_TOKEN && env.GH_REPO && ageMin > START_AFTER_MIN) {
    try { await startRun(env, ageMin); } catch (e) { console.log(`scout run not started: ${e}`); }  // the warning below still runs
  }
  if (env.NTFY_TOPIC && ageMin > WARN_AFTER_MIN) {
    const health = await get(env, "health", {});
    if (health.warned_for === (data.generated_at || "never")) return;  // one alert per outage
    const since = last ? when(data.generated_at) : "it was set up";
    const r = await fetch("https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title: `Scout: no run since ${since}`, priority: 4, tags: ["warning"],
        message: "No Scout run has reached the dashboard in over 4 hours, so no alerts are going out. Check the Actions tab on GitHub.",
        click: env.GH_REPO ? `https://github.com/${env.GH_REPO}/actions` : undefined }),
    }).catch(() => null);
    if (r && r.ok) await put(env, "health", { warned_for: data.generated_at || "never", warned_at: new Date(now).toISOString() });
  }
}

async function startRun(env, ageMin) {
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/scout.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json",
               "User-Agent": "scout-dashboard-cron", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { mode: "watch" } }),
  });
  console.log(`scout run ${r.status === 204 ? "started" : "not started: " + r.status}, last run ${Math.round(ageMin)} min ago`);
}

/* ---------------------------------------------------------------- auth */

async function login(request, env) {
  const form = await request.formData();
  const given = String(form.get("password") || "");
  if (!env.DASH_PASSWORD || !(await sameSecret(given, env.DASH_PASSWORD))) {
    return loginForm("nope. try again.");
  }
  const expires = Date.now() + COOKIE_DAYS * 86400e3;
  const token = `${expires}.${await hmac(env.SESSION_SECRET, String(expires))}`;
  return redirect("/", {
    "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}`,
  });
}

async function validCookie(request, env) {
  const raw = (request.headers.get("Cookie") || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(COOKIE + "="));
  if (!raw || !env.SESSION_SECRET) return false;
  const [expires, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  return sameSecret(sig, await hmac(env.SESSION_SECRET, expires));
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compare two strings without leaking their length or where they differ: hash both, compare the hashes.
async function sameSecret(a, b) {
  const h = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ---------------------------------------------------------------- KV helpers */

const get = (env, key, fallback) => env.SCOUT.get(key, "json").then((v) => v ?? fallback);
const put = (env, key, value) => env.SCOUT.put(key, JSON.stringify(value));

/* ---------------------------------------------------------------- cron endpoints */

async function ingest(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.matches)) return json({ error: "expected { matches: [...] }" }, 400);
  await Promise.all([
    put(env, "matches", {
      generated_at: body.generated_at || new Date().toISOString(), counts: body.counts || {}, matches: body.matches,
      total_matches: Number.isInteger(body.total_matches) ? body.total_matches : body.matches.length,
      open_total: Number.isInteger(body.open_total) ? body.open_total : null,
    }),
    put(env, "pages", body.pages || {}),
    put(env, "config_text", body.config_text || {}),
    put(env, "logos", body.logos && typeof body.logos === "object" ? body.logos : {}),
  ]);
  // The repo is the long-term record for the tracker; the cron pushes its copy up so edits made
  // through /status on the Mac also show here. Phone edits are newer when their "updated" is later.
  if (body.tracker) await mergeTracker(env, body.tracker);
  return json({ ok: true, matches: body.matches.length });
}

// The tracker alone, from /prep and /status on the Mac (scout.sync push --tracker-only), so a kit shows up
// as Prepped right away without touching the matches the cron uploaded.
async function ingestTracker(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.tracker !== "object" || body.tracker === null || Array.isArray(body.tracker)) {
    return json({ error: "expected { tracker: {...} }" }, 400);
  }
  const merged = await mergeTracker(env, body.tracker);
  return json({ ok: true, tracker: Object.keys(merged).length });
}

// Newer wins per posting: a phone edit and a Mac edit each keep the row with the later "updated".
async function mergeTracker(env, incoming) {
  const mine = await get(env, "tracker", {});
  for (const [key, row] of Object.entries(incoming)) {
    if (row && typeof row === "object" && (!mine[key] || (row.updated || "") >= (mine[key].updated || ""))) mine[key] = row;
  }
  await put(env, "tracker", mine);
  return mine;
}

async function exportState(env) {
  const [tracker, queue, passed, index] = await Promise.all([get(env, "tracker", {}), get(env, "queue", []), get(env, "passed", {}), get(env, "kits", [])]);
  // Answers edited on the phone go back to the Mac (scout.sync pull writes them into answers.md).
  const kit_edits = {};
  for (const k of index) {
    const kit = await get(env, `kit:${k.slug}`, null);
    const edited = (kit?.answers || []).filter((a) => a.edited);
    if (edited.length || kit?.letter_edited) kit_edits[k.slug] = { answers: edited, ...(kit.letter_edited ? { letter: kit.letter } : {}) };
  }
  return json({ tracker, queue, passed, kit_edits });
}

/* ---------------------------------------------------------------- prep kits (Review) */

// The Mac's applications/ folder is the source of truth for which kits exist. An answer edited on the phone
// after the Mac's copy was last saved is kept, so an upload never undoes a phone edit.
async function ingestKits(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.kits)) return json({ error: "expected { kits: [...] }" }, 400);
  const old = await get(env, "kits", []);
  const index = [];
  for (const kit of body.kits) {
    if (!kit || !/^[a-z0-9-]+$/.test(kit.slug || "")) continue;
    const prev = await get(env, `kit:${kit.slug}`, null);
    const kept = new Map((prev?.answers || []).filter((a) => a.edited && (a.edited_at || "") > (kit.updated || "")).map((a) => [a.q, a]));
    kit.answers = (kit.answers || []).map((a) => kept.get(a.q) || a);
    if (prev?.letter_edited && (prev.letter_edited_at || "") > (kit.updated || "")) Object.assign(kit, { letter: prev.letter, letter_edited: true, letter_edited_at: prev.letter_edited_at });
    await put(env, `kit:${kit.slug}`, kit);
    index.push({ slug: kit.slug, key: kit.key || "", company: kit.company || "", title: kit.title || "", updated: kit.updated || "", opened: kit.opened || "" });
  }
  for (const k of old) if (!index.some((n) => n.slug === k.slug)) await env.SCOUT.delete(`kit:${k.slug}`);
  await put(env, "kits", index);
  return json({ ok: true, kits: index.length });
}

// i is the answer's index, or "letter" for the cover letter.
async function setKitAnswer(request, env) {
  const { slug, i, text } = await request.json().catch(() => ({}));
  if (!/^[a-z0-9-]+$/.test(slug || "") || !(Number.isInteger(i) || i === "letter") || typeof text !== "string") return json({ error: "need slug, i, text" }, 400);
  const kit = await get(env, `kit:${slug}`, null);
  if (!kit || (i !== "letter" && !kit.answers[i]) || (i === "letter" && !kit.letter)) return json({ error: "no such answer" }, 404);
  const now = new Date().toISOString();
  if (i === "letter") Object.assign(kit, { letter: text.slice(0, 20000), letter_edited: true, letter_edited_at: now });
  else kit.answers[i] = { ...kit.answers[i], a: text.slice(0, 20000), edited: true, edited_at: now };
  await put(env, `kit:${slug}`, kit);
  return json({ ok: true });
}

async function kitPdf(env, slug, which) {
  const kit = await get(env, `kit:${slug}`, null);
  const b64 = kit && (which === "resume" ? kit.resume_pdf : kit.letter_pdf);
  if (!b64) return new Response("not found", { status: 404 });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const name = which === "resume" ? kit.resume_name || "resume.pdf" : `${slug}-cover-letter.pdf`;
  return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${name.replace(/[^\w.-]/g, "")}"`, "Cache-Control": "no-store" } });
}

/* ---------------------------------------------------------------- the borrowed panda */

// The panda is art borrowed from another project, so it never goes into this public repo. The Mac uploads it
// straight into KV (scout.sync push --mascot) and removes it the same way (--mascot --remove). With nothing
// uploaded, every panda image removes itself and the pages look exactly as they did before.
// Each pose is two layers: "<name>" is the panda alone and "<name>-bg" his mood circle and leaves, so only he moves.
const POSES = ["wave", "celebrate", "nap", "bamboo", "sunglasses", "judging", "proud", "sad", "close", "thumbs", "walking"];
const PANDAS = POSES.flatMap((n) => [n, `${n}-bg`]);

async function ingestMascot(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || (typeof body.images !== "object" && !body.clear)) return json({ error: "expected { images: {...} } or { clear: true }" }, 400);
  if (body.clear) {
    await Promise.all(PANDAS.map((n) => env.SCOUT.delete(`panda:${n}`)));
    return json({ ok: true, removed: PANDAS.length });
  }
  const names = Object.keys(body.images).filter((n) => PANDAS.includes(n) && typeof body.images[n] === "string");
  await Promise.all(names.map((n) => env.SCOUT.put(`panda:${n}`, body.images[n])));
  return json({ ok: true, pandas: names.length });
}

async function servePanda(env, name) {
  const b64 = PANDAS.includes(name) ? await env.SCOUT.get(`panda:${name}`) : null;
  if (!b64) return new Response("not found", { status: 404 });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
}

// The background sits still and the panda breathes on top of it. If either layer is missing, the whole thing goes.
function panda(name, cls = "") {
  return `<span class="panda${cls ? " " + cls : ""}" aria-hidden="true"><img class="panda-bg" src="/panda/${name}-bg.png" alt="" onerror="this.parentNode.remove()"><img class="panda-fg" src="/panda/${name}.png" alt="" onerror="this.parentNode.remove()"></span>`;
}

/* ---------------------------------------------------------------- company logos */

// The cron finds each company's logo on its Simplify page (scout/logos.py). Without one, a letter badge in a
// color picked from the name, so every card still has the same shape.
const BADGE_COLORS = ["#d2612a", "#9b84d8", "#3fa9b5", "#7cc96e", "#e7c98f", "#ffc93c"];

function normName(n) {
  let s = String(n || "").trim().toLowerCase();
  for (let i = 0; i < 2; i++) s = s.replace(/[,.]?\s+(inc|llc|ltd|corp|corporation|co|company|plc|group|holdings|technologies)\.?$/i, "").trim();
  return s.replace(/\s+/g, " ");
}

function logo(company, url) {
  const name = String(company || "?").trim();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const letter = (name.match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
  const img = /^https:\/\/storage\.googleapis\.com\/simplify-imgs\//.test(url || "")
    ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
  return `<span class="logo" style="--badge:${BADGE_COLORS[h % BADGE_COLORS.length]}" aria-hidden="true"><b>${esc(letter)}</b>${img}</span>`;
}

// Logo plus company name. Words never break in the middle: names with a long word ("Communications") get smaller.
function coHead(company, url, label) {
  const longest = Math.max(0, ...String(label || "").split(/\s+/).map((w) => w.length));
  const size = longest >= 14 ? " class=\"xlong\"" : longest >= 11 ? " class=\"long\"" : "";
  return `<div class="co">${logo(company, url)}<h3${size}>${esc(label)}</h3></div>`;
}

// For cards that only know a company name (tracker, Review): the logo map the cron uploads.
const logoFor = (logos, company) => logos[normName(company)] || "";

async function reviewList(env) {
  const [index, tracker, logos] = await Promise.all([get(env, "kits", []), get(env, "tracker", {}), get(env, "logos", {})]);
  const state = (k) => tracker[k.key]?.state || "Prepped";
  const order = (k) => (state(k) === "Applied" ? 1 : 0);
  const cards = [...index].sort((a, b) => order(a) - order(b)).map((k) => `
    <a class="card kitcard" href="/review/${esc(k.slug)}">
      <div class="tags"><span class="tag ${state(k) === "Applied" ? "green" : "ink"}">${esc(state(k))}</span></div>
      ${coHead(k.company || k.slug, logoFor(logos, k.company), k.company || k.slug)}
      <div class="title">${esc(k.title)}</div>
      <div class="meta">${kitDates(k)}</div>
    </a>`).join("");
  const ready = index.filter((k) => state(k) !== "Applied").length;
  const body = `<div class="intro"><p class="note">every kit /prep built. read it, fix anything you wouldn't say and save, open the application, then mark it submitted. you still click submit on their site. saved edits go back into the kit the next time the Mac pulls from Scout.</p></div>
    ${cards ? `<div class="kitgrid">${cards}</div>` : '<article class="card emptybox"><h3>no kits yet</h3><p>run /prep on the Mac and each kit it builds shows up here to read and send.</p><div class="actions"><a class="btn" href="/">find one to prep</a></div></article>'}`;
  return page(body, { title: "Review", page: "review", lead: "read it,", head: "send it", mood: ready ? "thumbs" : "nap" });
}

// The length a question asks for, read from its wording: "(about 120 words)", "max 150 words", "(3-4 sentences)",
// "500 characters". The page shows it next to the live count and flags the answer when it runs over.
function answerLimit(q) {
  let m;
  if ((m = q.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*sentences?/i))) return { kind: "sentences", max: +m[2], soft: false, label: `${m[1]}-${m[2]} sentences` };
  if ((m = q.match(/(\d+)\s*sentences?/i))) return { kind: "sentences", max: +m[1], soft: false, label: `${m[1]} sentences` };
  if ((m = q.match(/(\d[\d,]*)\s*(?:-|to)\s*(\d[\d,]*)\s*words?/i))) return { kind: "words", max: +m[2].replace(/,/g, ""), soft: false, label: `${m[1]}-${m[2]} words` };
  if ((m = q.match(/(\d[\d,]*)\s*char/i))) return { kind: "chars", max: +m[1].replace(/,/g, ""), soft: false, label: `${m[1]} characters` };
  if ((m = q.match(/(about|around|roughly|~)?\s*(\d[\d,]*)\s*words?/i))) {
    const n = +m[2].replace(/,/g, "");
    return { kind: "words", max: n, soft: !!m[1], label: m[1] ? `about ${n} words` : `${n} words` };
  }
  return null;
}

// Counts the same way the page script does, so the number doesn't jump when you start typing.
function countBy(kind, t) {
  t = t.trim();
  if (!t) return 0;
  if (kind === "chars") return t.length;
  if (kind === "sentences") return t.split(/[.!?]+(?:\s+|$)/).filter((x) => x.trim()).length;
  return t.split(/\s+/).length;
}

// A section like "Standard fields" is a bullet list of "label: value" lines. Those read better as the
// form fields they'll be typed into, with the ones still waiting on you marked, than as a wall of text.
const isFieldList = (t) => { const lines = t.split("\n").filter((l) => l.trim()); return lines.length > 1 && lines.every((l) => /^\s*[-*] /.test(l)); };
const NEEDS_YOU = /\[(confirm|required|your detail)/i;
function fieldRows(t) {
  return t.split("\n").filter((l) => l.trim()).map((l) => {
    const line = l.replace(/^\s*[-*] /, "");
    const at = line.indexOf(":");
    const [label, value] = at > 0 && at < 60 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : ["", line.trim()];
    const need = NEEDS_YOU.test(value);
    return `<div class="field${need ? " need" : ""}"><dt>${esc(label)}</dt><dd><span class="v">${esc(value)}</span>${need ? '<span class="chip">needs you</span>' : ""}</dd></div>`;
  }).join("");
}

async function reviewKit(env, slug) {
  const [kit, tracker] = await Promise.all([get(env, `kit:${slug}`, null), get(env, "tracker", {})]);
  if (!kit) return page('<p class="note">that kit isn\'t here. <a class="inline" href="/review">back to review</a></p>', { title: "Review", page: "review", lead: "kit", head: "not found" }, 404);
  const st = tracker[kit.key]?.state || "Prepped";

  // The bar under each answer: live count against the asked-for length, saved or unsaved, and save.
  const bar = (text, q, edited, act) => {
    const lim = answerLimit(q || "");
    const kind = lim ? lim.kind : "words";
    const n = countBy(kind, text);
    const over = lim && n > (lim.soft ? lim.max * 1.15 : lim.max);
    const unit = kind === "chars" ? "characters" : kind;
    return `<div class="ans-bar">
        <span class="count${over ? " over" : ""}" data-kind="${kind}"${lim ? ` data-max="${lim.max}" data-soft="${lim.soft ? 1 : 0}"` : ""}><b>${n}</b> ${unit}${lim ? ` <span class="lim">· asks for ${esc(lim.label)}</span>` : ""}</span>
        <span class="status" data-state="saved">${edited ? "saved, edited here" : "saved"}</span>
        <button class="btn accent" data-act="${act}">save</button>
      </div>`;
  };
  const answers = kit.answers.map((a, i) => isFieldList(a.a) ? `
    <article class="answer fields" data-i="${i}">
      <div class="q-row"><h3 class="q">${esc(a.q)}</h3><button class="btn ghost small" data-act="edit-fields">edit</button></div>
      <dl class="fieldlist">${fieldRows(a.a)}</dl>
      <textarea class="ans" data-act="answer" rows="3" hidden>${esc(a.a)}</textarea>
      ${bar(a.a, "", a.edited, "save-answer")}
    </article>` : `
    <article class="answer" data-i="${i}">
      <h3 class="q">${esc(a.q)}</h3>
      <textarea class="ans" data-act="answer" rows="3" spellcheck="true">${esc(a.a)}</textarea>
      ${bar(a.a, a.q, a.edited, "save-answer")}
    </article>`).join("");

  // Phone: one column, header, notes, then the writing. Desktop (900px+): the header and notes stay put
  // on the left while the answers scroll on the right as one readable sheet.
  const body = `
    <div class="kit">
      <aside class="kit-side">
        <article class="card kit-head" data-key="${esc(kit.key)}" data-slug="${esc(kit.slug)}">
          <div class="tags"><span class="tag ${st === "Applied" ? "green" : "ink"}">${esc(st)}</span></div>
          <div class="row"><h3>${esc(kit.company)}</h3></div>
          <div class="title">${esc(kit.title)}</div>
          <div class="meta">${kitDates(kit)}</div>
          <div class="actions">
            <a class="btn accent" href="${esc(safeUrl(kit.url))}" target="_blank" rel="noopener">open the application ↗</a>
            ${kit.resume_pdf ? `<a class="btn" href="/review/${esc(kit.slug)}/resume.pdf" target="_blank">resume.pdf</a>` : ""}
            ${kit.letter_pdf ? `<a class="btn" href="/review/${esc(kit.slug)}/letter.pdf" target="_blank">cover letter.pdf</a>` : ""}
            ${st === "Applied" ? "" : '<button class="btn" data-act="submitted">I submitted it</button>'}
          </div>
        </article>
        <details class="card notes" open><summary><h3>read this first</h3></summary><div class="md">${mdToHtml(kit.notes || "")}</div></details>
      </aside>
      <div class="kit-main">
        <h2>the answers</h2>
        ${answers ? `<section class="sheet">${answers}</section>` : '<p class="note">this kit has no written answers.</p>'}
        ${kit.letter ? `<h2>cover letter</h2><section class="sheet"><article class="answer letter"><textarea class="ans" data-act="letter" rows="8" spellcheck="true">${esc(kit.letter)}</textarea>${bar(kit.letter, "", kit.letter_edited, "save-letter")}</article></section>` : ""}
      </div>
    </div>`;
  return page(body, { title: kit.company || "Review", page: "review", lead: "read it,", head: "send it" });
}

function mdToHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(https?:\/\/[^\s<)]+)/g, (u) => `<a class="inline" href="${safeUrl(u)}" target="_blank" rel="noopener">${u}</a>`);
  const out = [];
  let list = null, table = [];
  const flush = () => {
    if (list) { out.push(`</${list}>`); list = null; }
    if (table.length) {
      const rows = table.filter((r) => !/^\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => `<td>${inline(c.trim())}</td>`).join(""));
      out.push(`<div class="tablewrap"><table>${rows.map((r) => `<tr>${r}</tr>`).join("")}</table></div>`); table = [];
    }
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (/^\|/.test(line)) { if (list) { out.push(`</${list}>`); list = null; } table.push(line); continue; }
    if (table.length) flush();
    let m;
    if ((m = line.match(/^(#{1,3}) (.+)/))) { flush(); out.push(`<h4>${inline(m[2])}</h4>`); }
    else if ((m = line.match(/^\s*[-*] (.+)/))) { if (list !== "ul") { flush(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+\. (.+)/))) { if (list !== "ol") { flush(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) flush();
    else { flush(); out.push(`<p>${inline(line)}</p>`); }
  }
  flush();
  return out.join("");
}

/* ---------------------------------------------------------------- phone actions */

async function setTracker(request, env) {
  const body = await request.json().catch(() => ({}));
  const { key, state, next } = body;
  if (!key || !STATES.includes(state)) return json({ error: "need key and a known state" }, 400);
  const [tracker, data] = await Promise.all([get(env, "tracker", {}), get(env, "matches", { matches: [] })]);
  const match = data.matches.find((m) => m.key === key) || {};
  const today = nyDate();
  const row = tracker[key] || { company: match.company || "", title: match.title || "", url: match.url || "", score: match.score ?? null, history: [] };
  row.state = state;
  row.updated = today;
  if (state === "Applied" && !row.applied) row.applied = today;
  if (typeof next === "string") row.next = next;
  (row.history ||= []).push({ date: today, state });
  tracker[key] = row;
  await put(env, "tracker", tracker);
  return json({ ok: true, row });
}

async function setQueue(request, env) {
  const { key, action } = await request.json().catch(() => ({}));
  if (!key) return json({ error: "need key" }, 400);
  let queue = await get(env, "queue", []);
  queue = queue.filter((q) => q.key !== key);
  if (action !== "remove") queue.push({ key, at: new Date().toISOString() });
  await put(env, "queue", queue);
  return json({ ok: true, queued: action !== "remove" });
}

async function setPassed(request, env) {
  const { key, undo } = await request.json().catch(() => ({}));
  if (!key) return json({ error: "need key" }, 400);
  const passed = await get(env, "passed", {});
  if (undo) delete passed[key]; else passed[key] = new Date().toISOString();
  await put(env, "passed", passed);
  return json({ ok: true, passed: !undo });
}

/* ---------------------------------------------------------------- pages */

async function newPage(env) {
  const [data, tracker, queue, passed, lastVisit] = await Promise.all([
    get(env, "matches", { matches: [], counts: {}, generated_at: "" }), get(env, "tracker", {}), get(env, "queue", []), get(env, "passed", {}), get(env, "last_visit", ""),
  ]);
  const queued = new Set(queue.map((q) => q.key));
  const rows = data.matches.filter((m) => !tracker[m.key] && !passed[m.key]);
  const fresh = rows.filter((m) => m.first_seen && m.first_seen > lastVisit);
  const rest = rows.filter((m) => !fresh.includes(m));
  const programs = rows.filter((m) => m.early_career === "strong" || m.role === "ambassador").length;
  // The cron uploads only the top matches (scout/watch.py write_matches), so the count comes from its total:
  // everything that passed the filters and that its own page does not rule out (open_total), minus the
  // uploaded ones you have tracked or passed.
  const total = Math.max(Number.isInteger(data.open_total) ? data.open_total : data.total_matches || 0, data.matches.length);
  const openCount = total - (data.matches.length - rows.length);
  await put(env, "last_visit", new Date().toISOString());

  const card = (m, isNew) => `
    <article class="card${isNew ? " is-new" : ""}" data-key="${esc(m.key)}">
      <div class="tags">
        <span class="tag">${esc(roleWord(m))}</span>
        ${m.tier <= 2 ? `<span class="tag ink">tier ${m.tier}</span>` : ""}
        ${m.early_career === "strong" ? '<span class="tag accent">freshman friendly</span>' : ""}
        ${m.eligibility === "ineligible" ? '<span class="tag red">not eligible</span>' : m.eligibility === "closed" ? '<span class="tag red">closed</span>' : ""}
        ${m.citizens_only ? '<span class="tag ink">US citizens only</span>' : ""}
        ${m.term_unknown ? '<span class="tag">term not listed</span>' : ""}
        ${isNew ? '<span class="tag accent">new</span>' : ""}
      </div>
      <div class="row">${coHead(m.company, m.logo, m.company)}<span class="score">${m.score}</span></div>
      <div class="title">${esc(m.title)}</div>
      <div class="meta">${esc((m.locations || []).slice(0, 2).join(", ") || "location not listed")} · ${age(m.date_posted)}${m.eligibility_note && m.eligibility !== "unknown" ? " · " + esc(m.eligibility_note) : ""}</div>
      <details class="why"><summary>why ${m.score}?</summary><div class="meta mono">${esc(breakdown(m))}</div></details>
      <div class="actions">
        ${m.eligibility === "ineligible" || m.eligibility === "closed" ? `<button class="btn" disabled>${m.eligibility === "closed" ? "closed" : "not eligible"}</button>` : `<button class="btn accent" data-act="queue" ${queued.has(m.key) ? "disabled" : ""}>${queued.has(m.key) ? "queued ✓" : "prep this"}</button>`}
        <button class="btn" data-act="pass">pass</button>
        <a class="btn ghost" href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener">posting ↗</a>
      </div>
    </article>`;

  const hero = `
    <div class="stat">
      <div class="stat-main">
        ${panda(fresh.length ? "celebrate" : "nap", "stat-panda")}
        <div class="stat-label">you have</div>
        <div class="stat-big" id="open-count">${openCount}</div>
        <div class="stat-sub">open matches</div>
        ${total > data.matches.length ? `<div class="stat-note">the list below is ranked from the top ${data.matches.length} by score</div>` : ""}
      </div>
      <div class="stat-tiles">
        <div class="tile${fresh.length ? " hot" : ""}"><b>${fresh.length}</b><span>new since your last visit</span></div>
        <div class="tile"><b>${programs}</b><span>freshman friendly</span></div>
        <div class="tile"><b>${queue.length}</b><span>queued for /prep</span></div>
      </div>
      <div class="stat-foot">updated ${esc(when(data.generated_at))}</div>
    </div>`;


  const passedRows = data.matches.filter((m) => passed[m.key] && !tracker[m.key]);
  const passedCard = (m) => `
    <article class="card passed" data-key="${esc(m.key)}">
      <div class="row">${coHead(m.company, m.logo, m.company)}<span class="score">${m.score}</span></div>
      <div class="title">${esc(m.title)}</div>
      <div class="meta">passed ${age(passed[m.key])}</div>
      <div class="actions"><button class="btn accent" data-act="unpass">unpass</button><a class="btn ghost" href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener">posting ↗</a></div>
    </article>`;

  const body = `
    ${hero}
    ${fresh.length ? `<h2>fresh off the lists</h2>${fresh.map((m) => card(m, true)).join("")}` : ""}
    <h2>${fresh.length ? "the rest, best first" : "best first"}</h2>
    ${rest.slice(0, 60).map((m) => card(m, false)).join("") || `<div class="empty">${panda("bamboo")}<p class="note">nothing yet. scout checks the lists every hour.</p></div>`}
    <details class="passed-list" id="passed" ${passedRows.length ? "" : "hidden"}><summary><h2>passed (<span id="passed-count">${passedRows.length}</span>)</h2></summary><p class="note">changed your mind? unpass puts it back in the list.</p><div id="passed-cards">${passedRows.map(passedCard).join("")}</div></details>`;
  return page(body, { title: "New", page: "new", lead: "let's get", head: "you hired" });
}

async function programsPage(env) {
  const [pages, data, tracker, passed, logos] = await Promise.all([get(env, "pages", {}), get(env, "matches", { matches: [] }), get(env, "tracker", {}), get(env, "passed", {}), get(env, "logos", {})]);
  // A watched page has a name ("Microsoft Explore"), not a company: use the longest known company name it starts with.
  const known = Object.keys(logos).sort((a, b) => b.length - a.length);
  const pageCompany = (p) => { const n = normName(p.name || ""); return known.find((k) => n === k || n.startsWith(k + " ")) || ""; };
  const recent = Object.values(pages).some((p) => p.changed_at && Date.now() - Date.parse(p.changed_at) < 86400000);
  const watched = Object.entries(pages).map(([url, p]) => `
    <article class="card">
      <div class="tags"><span class="tag${p.changed_at ? " accent" : ""}">${p.changed_at ? "new words " + age(p.changed_at) : "no changes yet"}</span>${p.failures ? `<span class="tag red">${p.failures} failed fetch${p.failures > 1 ? "es" : ""}</span>` : ""}</div>
      ${coHead(p.name || url, logos[pageCompany(p)] || "", p.name || url)}
      ${p.last_change ? `<div class="change"><b>what changed:</b>${esc(p.last_change).replace(/\n/g, "<br>")}</div><div class="meta">a change means go look. it does not mean applications are open.</div>` : ""}<div class="meta">checked ${age(p.checked_at)}</div>
      <div class="actions"><a class="btn ghost" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">open page ↗</a></div>
    </article>`).join("");
  const finds = data.matches.filter((m) => (m.early_career === "strong" || m.role === "ambassador") && !passed[m.key]).map((m) => `
    <article class="card">
      <div class="tags"><span class="tag accent">${m.role === "ambassador" ? "ambassador" : "freshman friendly"}</span>${tracker[m.key] ? `<span class="tag ink">${esc(tracker[m.key].state)}</span>` : ""}</div>
      <div class="row">${coHead(m.company, m.logo, m.company)}<span class="score">${m.score}</span></div>
      <div class="title">${esc(m.title)}</div>
      <div class="meta">${esc((m.locations || []).slice(0, 2).join(", "))} · ${age(m.date_posted)}</div>
      <div class="actions"><a class="btn ghost" href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener">posting ↗</a></div>
    </article>`).join("");
  const body = `
    <div class="intro"><p class="note">${recent ? "a watched page changed today. go look. " : ""}these pages are where freshman programs show up first. scout reads them every hour and pings you when the words change.</p></div>
    <h2>watched pages</h2>${watched || '<p class="note">no pages yet.</p>'}
    <h2>found in the lists</h2>${finds || '<p class="note">none in the lists right now. the pages above are the early warning.</p>'}`;
  return page(body, { title: "Programs", page: "programs", lead: "built for", head: "freshmen", mood: recent ? "close" : "sunglasses" });
}

async function trackerPage(env) {
  const [tracker, logos] = await Promise.all([get(env, "tracker", {}), get(env, "logos", {})]);
  const rows = Object.entries(tracker).filter(([, r]) => r.state !== "Passed").sort((a, b) => (b[1].updated || "").localeCompare(a[1].updated || ""));
  const counts = {};
  for (const [, r] of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  const options = (cur) => STATES.filter((s) => s !== "Passed").map((s) => `<option ${s === cur ? "selected" : ""}>${s}</option>`).join("");
  const pipeline = ["Prepped", "Applied", "OA", "Interview", "Offer"].map((s) => `<span class="step${counts[s] ? " on" : ""}">${s}<b>${counts[s] || 0}</b></span>`).join("");
  const list = rows.map(([key, r]) => `
    <article class="card" data-key="${esc(key)}">
      <div class="tags"><span class="tag ${r.state === "Applied" || r.state === "Offer" ? "green" : r.state === "Rejected" ? "red" : "ink"}">${esc(r.state)}</span><span class="tag">${esc(r.updated || "")}</span></div>
      <div class="row">${coHead(r.company, logoFor(logos, r.company), r.company)}${r.score != null ? `<span class="score">${r.score}</span>` : ""}</div>
      <div class="title">${esc(r.title)}</div>
      <div class="meta">${r.applied ? "applied " + esc(r.applied) + " · " : ""}${r.next ? "next: " + esc(r.next) : "no next action yet"}</div>
      <div class="actions wrap">
        <select data-act="state">${options(r.state)}</select>
        <textarea data-act="next" rows="1" placeholder="next action">${esc(r.next || "")}</textarea>
        <button class="btn accent" data-act="save">save</button>
        ${r.url ? `<a class="btn ghost" href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener">posting ↗</a>` : ""}
      </div>
    </article>`).join("");
  const body = `
    <div class="pipeline">${pipeline}</div>
    ${rows.length ? `<p class="note">${rows.length} tracked. changes here reach the repo on the next cron run. you still click submit yourself.</p>` : ""}
    ${list || '<p class="note">nothing tracked yet. tap "prep this" on New, or run /prep.</p>'}`;
  const mood = !rows.length ? "bamboo" : counts.Offer || counts.Interview || counts.OA ? "celebrate" : counts.Applied ? "walking" : "close";
  return page(body, { title: "Tracker", page: "tracker", lead: "where", head: "things stand", mood });
}

async function settingsPage(env) {
  const cfg = await get(env, "config_text", {});
  const block = (name, text) => `<h2>${esc(name)}</h2><pre>${esc(text || "(not pushed yet)")}</pre>`;
  const body = `<p class="note">read only. edit these files in the repo and the next cron run shows the change here.</p>${block("config/targets.yaml", cfg.targets)}${block("config/scoring.yaml", cfg.scoring)}${block("config/watch-pages.yaml", cfg.watch_pages)}`;
  return page(body, { title: "Settings", page: "settings", lead: "how scout", head: "thinks" });
}

/* ---------------------------------------------------------------- about (public: no personal data) */

function aboutPage(loggedIn) {
  const body = `
    <article class="card">
      ${panda("wave", "about-panda")}
      <h3>the short version</h3>
      <p>Scout watches the public internship lists every hour, scores every posting against what you're looking for, and pings your phone when a strong one shows up. When you pick one, it builds a prep kit: a tailored one page resume, a cover letter if the posting wants one, and draft answers, all from facts you've already confirmed. <b>You always click submit yourself.</b> Scout never applies for you.</p>
    </article>

    <h2>how it works</h2>
    <ol class="steps">
      <li class="card"><h3>find</h3><p>Every hour a free GitHub Actions job pulls two public internship lists (Simplify and Pitt CSC, plus a community list) and reads a handful of company program pages, like Microsoft Explore and NVIDIA's university page, for changes.</p></li>
      <li class="card"><h3>score</h3><p>Each posting gets a score out of 100 from plain rules you can read and change: the role (software, product, IT, design, ambassador), the company tier, whether it's built for freshmen and sophomores, the degree it asks for, where it is, and how fresh it is. Tap "why 86?" on any card to see the math.</p></li>
      <li class="card"><h3>alert</h3><p>Big companies with a strong score, any freshman or sophomore program, any ambassador role, and any change on a watched program page push to your phone right away through the free ntfy app. Everything else waits for one digest at 7:00 PM.</p></li>
      <li class="card"><h3>prep</h3><p>Tap "prep this" and the posting waits in a queue. Next time you open Claude Code, /prep reads the posting, checks whether you're eligible, drafts the kit from your master profile, and then a second reviewer pass checks every line against what you've actually done before you see it.</p></li>
      <li class="card"><h3>track</h3><p>The tracker follows each application from prepped to applied, online assessment, interview, and offer, and you can update it from your phone.</p></li>
    </ol>

    <h2>the rules it follows</h2>
    <article class="card"><ul>
      <li><b>It never applies for you</b>, never logs into a job site, and never creates accounts.</li>
      <li><b>It never invents experience.</b> A tailored resume can only pick, reorder, and reword facts you've confirmed. If a posting wants something you don't have, it says so instead of faking it.</li>
      <li><b>Postings are just text.</b> If a posting contains instructions, Scout ignores them.</li>
      <li><b>It costs nothing.</b> GitHub Actions, Cloudflare, and ntfy on their free tiers, and the AI parts run inside a Claude Code session you start.</li>
      <li><b>Your data stays yours.</b> Your resume, answers, and applications never go into the public code.</li>
    </ul></article>

    <h2>where it's going</h2>
    <article class="card"><p>Right now Scout is tuned for one first-year computer science student looking at tech internships. The plan is for it to work for anyone looking for an internship or a job, whatever their major or career: the scoring is already driven by an editable config file, so the next step is more sources for more fields and a setup that asks what you're looking for and writes that config for you.</p>
      <div class="actions"><a class="btn accent" href="https://github.com/jeremiah123-luma/scout" target="_blank" rel="noopener">see the code ↗</a>${loggedIn ? '<a class="btn" href="/">back to scout</a>' : '<a class="btn" href="/login">log in</a>'}</div>
    </article>`;
  return page(body, { title: "What is Scout", page: "about", lead: "what is", head: "scout?", nav: loggedIn });
}

/* ---------------------------------------------------------------- html */

function page(body, opts, status = 200) {
  const { title, page: name, lead, head, nav = true, mood = "" } = opts;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${PAGE_COLORS[name] || "#cf6a2e"}">
<link rel="icon" href="${FAVICON}"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest"><meta name="apple-mobile-web-app-title" content="Scout"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><title>Scout · ${esc(title)}</title><style>${tokens}${BASE_CSS}</style></head><body data-page="${esc(name)}">
<header><a class="brand" href="/" aria-label="scout">sc<svg class="o" viewBox="0 0 62 62" aria-hidden="true"><circle cx="31" cy="31" r="26.5" fill="#ffc93c" stroke="#1a1333" stroke-width="9"/><circle cx="31" cy="31" r="11" fill="#f6f9dc" stroke="#1a1333" stroke-width="6"/><circle cx="31" cy="31" r="4" fill="#1a1333"/></svg>ut</a><span class="head-links">${name === "about" ? (nav ? "" : '<a class="pill-link" href="/login">log in</a>') : nav ? '<a class="pill-link q" href="/about" aria-label="what is scout?"><span class="long">what is scout?</span><span class="short">?</span></a>' : ""}${nav ? '<a class="pill-link" href="/logout">log out</a>' : ""}</span></header>
<main>
  <h1><span class="lead">${esc(lead)}</span><span class="head">${esc(head)}</span>${mood ? panda(mood, "hero-panda") : ""}</h1>
  ${body}
</main>
${nav ? NAV.replace(`href="/${name === "new" ? "" : name}"`, `href="/${name === "new" ? "" : name}" class="on"`) : ""}
${nav ? `<script>${CLIENT_JS}</script>` : ""}<script>${CYCLE_JS}</script></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const FAVICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#ffc93c" stroke="#1a1333" stroke-width="7"/><circle cx="32" cy="32" r="12" fill="#f6f9dc" stroke="#1a1333" stroke-width="5"/><circle cx="32" cy="32" r="4.5" fill="#1a1333"/></svg>');

// The headline decoration: one of zigzag, highlighter, circle, or loops, picked at random. It draws in once when
// the page opens and stays.
const CYCLE_JS = `(function(){var h=document.querySelector("h1 .head");if(!h)return;var s=["u-zig","u-highlight","u-circle","u-loops"];
h.classList.add(s[Math.floor(Math.random()*s.length)],"draw")})();`;

const PAGE_COLORS = { about: "#3fa9b5", new: "#cf6a2e", programs: "#9b84d8", review: "#cf6a2e", tracker: "#3fa9b5", settings: "#e7c98f", login: "#9b84d8" };

// Settings stays at /settings (linked from the about page) but leaves the dock to make room for Review.
const NAV = `<nav class="dock"><a href="/">new</a><a href="/programs">programs</a><a href="/review">review</a><a href="/tracker">tracker</a></nav>`;

function loginForm(message) {
  return page(`${panda("wave", "login-panda")}<form method="post" action="/login" class="login">
    <label for="password">password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    <button class="btn accent big" type="submit">let me in</button>
    ${message ? `<p class="warn">${esc(message)}</p>` : '<p class="note">it stays unlocked for 30 days. <a href="/about">what is scout?</a></p>'}
  </form>`, { title: "Log in", page: "login", lead: "who goes", head: "there?", nav: false }, message ? 401 : 200);
}

// Layout only. Colors, sizes, and fonts come from tokens.css.
const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:500 var(--text)/1.4 var(--font);padding:0 16px 96px;overflow-x:hidden;-webkit-font-smoothing:antialiased}
body[data-page="about"]{--page:var(--teal)} body[data-page="new"]{--page:var(--orange)} body[data-page="programs"]{--page:var(--purple)} body[data-page="tracker"]{--page:var(--teal)} body[data-page="review"]{--page:var(--green)} body[data-page="settings"]{--page:var(--sand);--on-page:var(--ink)} body[data-page="login"]{--page:var(--purple)}
main{max-width:640px;margin-inline:auto}
header{max-width:640px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:18px 0 6px}
.brand{display:inline-flex;align-items:baseline;font-family:var(--logo);font-size:40px;line-height:1;color:var(--ink);text-decoration:none;letter-spacing:.5px}
.brand .o{width:.56em;height:.56em;margin:0 .015em;flex:none}
body[data-page="about"] main{display:block} @media (min-width:900px){body[data-page="about"] main,body[data-page="about"] header,body[data-page="about"] .dock{max-width:860px} body[data-page="about"] .steps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px}}
.head-links{display:flex;gap:8px;align-items:center} .pill-link .short{display:none} @media (max-width:560px){.pill-link.q .long{display:none} .pill-link.q .short{display:inline}}
.steps{counter-reset:step;list-style:none;padding:0;margin:0}
.steps li{counter-increment:step;position:relative;padding-left:58px}
.steps li::before{content:counter(step);position:absolute;left:18px;top:18px;width:30px;height:30px;border-radius:50%;background:var(--accent);border:var(--line) solid var(--ink);font-family:var(--display);font-size:15px;display:flex;align-items:center;justify-content:center}
.card p{margin:6px 0 0} .change{background:#fff;border:2px solid var(--ink);border-radius:12px;padding:10px 12px;margin:8px 0 6px;font-size:var(--small);font-weight:500;overflow-wrap:anywhere} .change b{display:block;margin-bottom:4px} .card ul{margin:8px 0 0;padding-left:18px} .card li+li{margin-top:4px} .login a,.card a.inline{color:var(--ink);font-weight:700}
.pill-link{font-size:var(--small);font-weight:700;color:var(--ink);background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius-pill);padding:6px 14px;text-decoration:none;box-shadow:var(--shadow-sm)}
h1{font-family:var(--display);font-size:var(--h1);line-height:.92;text-transform:uppercase;margin:14px 0 20px;letter-spacing:0}
h1 .lead{display:block;color:var(--on-page)} h1 .head{display:inline-block;color:var(--ink);padding-bottom:22px;position:relative;isolation:isolate}
/* The headline decoration lives in its own layer (::after) so swapping styles never moves the text. */
h1 .head::after{content:"";position:absolute;z-index:-1;pointer-events:none;left:0;right:0;bottom:0;height:30px;background:url('data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20400%2038%27%20preserveAspectRatio%3D%27none%27%3E%3Cpath%20d%3D%27M3.0%206.9%20Q%203.0%206.9%208.0%2018.6%20Q%2012.9%2030.2%2017.6%2019.2%20Q%2022.3%208.2%2027.9%2016.8%20Q%2033.5%2025.5%2039.6%2015.3%20Q%2045.6%205.2%2051.4%2015.4%20Q%2057.2%2025.6%2062.0%2016.6%20Q%2066.7%207.5%2073.7%2016.8%20Q%2080.7%2026.0%2085.9%2017.4%20Q%2091.0%208.8%2098.4%2019.2%20Q%20105.7%2029.6%20111.4%2020.2%20Q%20117.1%2010.9%20121.7%2021.4%20Q%20126.4%2031.9%20131.7%2018.9%20Q%20137.1%205.9%20142.0%2016.7%20Q%20146.8%2027.5%20153.8%2016.8%20Q%20160.7%206.1%20167.0%2018.1%20Q%20173.2%2030.1%20178.8%2019.2%20Q%20184.4%208.3%20189.1%2016.9%20Q%20193.8%2025.5%20198.9%2017.3%20Q%20204.0%209.1%20209.8%2018.3%20Q%20215.6%2027.5%20221.9%2017.6%20Q%20228.1%207.7%20233.5%2019.5%20Q%20238.9%2031.4%20245.5%2018.9%20Q%20252.1%206.5%20258.3%2017.8%20Q%20264.6%2029.2%20271.7%2019.3%20Q%20278.8%209.4%20284.2%2021.1%20Q%20289.5%2032.8%20294.4%2020.2%20Q%20299.3%207.5%20306.0%2016.9%20Q%20312.8%2026.2%20318.8%2015.7%20Q%20324.7%205.2%20331.2%2018.2%20Q%20337.7%2031.1%20344.0%2020.7%20Q%20350.2%2010.3%20355.6%2020.4%20Q%20361.1%2030.6%20367.3%2019.5%20Q%20373.6%208.5%20379.5%2020.1%20T%20385.4%2031.7%27%20fill%3D%27none%27%20stroke%3D%27%23ffc93c%27%20stroke-width%3D%274.5%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%2F%3E%3C%2Fsvg%3E') no-repeat center/100% 100%}
h1 .head.u-loops::after{background-image:url('data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20400%2038%27%20preserveAspectRatio%3D%27none%27%3E%3Cpath%20d%3D%27M4%2026%20C%2021.1%2026%2C%2024.9%207.5%2C%2015.4%207.5%20C%205.9%207.5%2C%209.7%2030%2C%2028.7%2027%20C%2041.3%2026%2C%2045.4%206.3%2C%2035.2%206.3%20C%2025.0%206.3%2C%2029.1%2030%2C%2049.5%2027%20C%2061.3%2026%2C%2065.3%206.5%2C%2055.3%206.5%20C%2045.3%206.5%2C%2049.3%2030%2C%2069.2%2027%20C%2076.1%2026%2C%2078.9%209.2%2C%2071.8%209.2%20C%2064.7%209.2%2C%2067.5%2030%2C%2081.8%2027%20C%2096.9%2026%2C%20101.2%208.1%2C%2090.4%208.1%20C%2079.7%208.1%2C%2084.0%2030%2C%20105.5%2027%20C%20118.1%2026%2C%20122.4%2011.3%2C%20111.8%2011.3%20C%20101.2%2011.3%2C%20105.4%2030%2C%20126.6%2027%20C%20136.2%2026%2C%20139.8%2010.5%2C%20130.9%2010.5%20C%20122.0%2010.5%2C%20125.6%2030%2C%20143.3%2027%20C%20154.5%2026%2C%20158.2%208.6%2C%20149.0%208.6%20C%20139.8%208.6%2C%20143.5%2030%2C%20161.9%2027%20C%20169.0%2026%2C%20171.9%2010.7%2C%20164.8%2010.7%20C%20157.8%2010.7%2C%20160.6%2030%2C%20174.7%2027%20C%20185.1%2026%2C%20188.3%206.5%2C%20180.2%206.5%20C%20172.1%206.5%2C%20175.3%2030%2C%20191.6%2027%20C%20204.8%2026%2C%20208.8%2011.0%2C%20198.8%2011.0%20C%20188.7%2011.0%2C%20192.7%2030%2C%20212.9%2027%20C%20225.2%2026%2C%20229.2%2011.2%2C%20219.0%2011.2%20C%20208.9%2011.2%2C%20212.9%2030%2C%20233.3%2027%20C%20244.2%2026%2C%20248.0%2011.2%2C%20238.6%2011.2%20C%20229.1%2011.2%2C%20232.9%2030%2C%20251.8%2027%20C%20258.7%2026%2C%20261.6%206.8%2C%20254.5%206.8%20C%20247.5%206.8%2C%20250.3%2030%2C%20264.4%2027%20C%20274.3%2026%2C%20277.4%2010.7%2C%20269.6%2010.7%20C%20261.7%2010.7%2C%20264.9%2030%2C%20280.5%2027%20C%20295.5%2026%2C%20299.9%206.8%2C%20288.9%206.8%20C%20278.0%206.8%2C%20282.4%2030%2C%20304.2%2027%20C%20312.4%2026%2C%20315.6%206.2%2C%20307.5%206.2%20C%20299.3%206.2%2C%20302.6%2030%2C%20318.9%2027%20C%20330.5%2026%2C%20334.1%207.9%2C%20325.0%207.9%20C%20315.8%207.9%2C%20319.5%2030%2C%20337.8%2027%20C%20346.4%2026%2C%20349.5%206.4%2C%20341.7%206.4%20C%20333.9%206.4%2C%20337.0%2030%2C%20352.6%2027%20C%20365.5%2026%2C%20369.4%206.2%2C%20359.7%206.2%20C%20349.9%206.2%2C%20353.8%2030%2C%20373.3%2027%20C%20386.5%2026%2C%20390.7%2010.2%2C%20380.2%2010.2%20C%20369.6%2010.2%2C%20373.8%2030%2C%20395.0%2027%20C%20388%2025%2C%20392%2024%2C%20396%2022%27%20fill%3D%27none%27%20stroke%3D%27%23ffc93c%27%20stroke-width%3D%274.5%27%20stroke-linecap%3D%27round%27%2F%3E%3C%2Fsvg%3E')}
h1 .head.u-highlight::after{left:-6px;right:-6px;top:calc(50% - 6px);bottom:16px;height:auto;background:#ffc93c;transform:rotate(-1deg);border-radius:3px}
h1 .head.u-circle::after{left:-6px;right:-6px;top:-10px;bottom:10px;height:auto;background:url('data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20400%20120%27%20preserveAspectRatio%3D%27none%27%3E%3Cpath%20d%3D%27M60%2018%20C%20150%204%2C%20330%206%2C%20384%2034%20C%20410%2050%2C%20396%2092%2C%20300%20108%20C%20190%20122%2C%2050%20116%2C%2018%2086%20C%20-4%2064%2C%2020%2030%2C%20120%2016%20C%20160%2011%2C%20210%2010%2C%20250%2012%27%20fill%3D%27none%27%20stroke%3D%27%23ffc93c%27%20stroke-width%3D%277%27%20stroke-linecap%3D%27round%27%2F%3E%3C%2Fsvg%3E') no-repeat center/100% 100%}
h1 .head.draw::after{animation:wipe .8s cubic-bezier(.6,0,.2,1) both}
@keyframes wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
h2{font-family:var(--display);font-size:20px;text-transform:uppercase;color:var(--on-page);margin:26px 0 10px;letter-spacing:0}
h3{font-family:var(--display);font-size:20px;margin:0;text-transform:uppercase;line-height:1.05;letter-spacing:0}
.note{color:var(--on-page);font-weight:700;margin:0 0 14px}
.stat{background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow);padding:var(--pad);margin-bottom:8px}
.stat-label{font-family:var(--display);text-transform:uppercase;font-size:18px;letter-spacing:0}
.stat-big{font-family:var(--display);font-size:var(--big);line-height:.9;text-transform:uppercase;margin:4px 0 6px}
.stat{display:grid;gap:16px;position:relative}
.stat-sub{font-weight:700;font-size:18px}
.stat-note{color:var(--muted);font-size:13px;font-weight:700;margin-top:4px}
.stat-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.tile{background:#fff;border:2px solid var(--ink);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:4px;min-width:0}
.tile b{font-family:var(--display);font-size:34px;line-height:1} .tile span{font-size:var(--small);font-weight:700;color:var(--muted);line-height:1.2}
.tile.hot{background:var(--accent)} .tile.hot span{color:var(--ink)}
.stat-foot{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.card{background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow);padding:var(--pad);margin:0 0 16px;max-width:100%}
.card.dim > :not(.actions){opacity:.35} .passed-list > summary{list-style:none;cursor:pointer} .passed-list > summary::-webkit-details-marker{display:none} .passed-list > summary h2::after{content:" ▸"} .passed-list[open] > summary h2::after{content:" ▾"} .card.passed{opacity:.92}
.card.is-new{outline:4px solid var(--accent);outline-offset:-7px}
.row{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--gap)}
.title{font-weight:700;font-size:17px;margin:4px 0 6px} .meta{color:var(--muted);font-size:var(--small);font-weight:700;overflow-wrap:anywhere}
.mono{font-family:var(--mono);font-weight:500}
.score{font-family:var(--display);font-size:18px;background:var(--ink);color:var(--accent);border-radius:var(--radius-pill);padding:4px 12px;flex:none;line-height:1.1}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.tag{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;border:2px solid var(--ink);border-radius:var(--radius-tag);padding:3px 9px;background:var(--orange);color:var(--cream)}
.tag.accent{background:var(--accent);color:var(--ink)} .tag.ink{background:var(--ink);color:var(--cream)} .tag.red{background:var(--red);color:var(--cream)} .tag.green{background:var(--green);color:var(--ink)}
.why{margin-top:8px} .why summary{cursor:pointer;font-size:var(--small);font-weight:700;color:var(--muted)} .why summary::-webkit-details-marker{display:none}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
.btn{appearance:none;font:700 15px/1 var(--font);color:var(--ink);background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius-pill);padding:11px 16px;box-shadow:var(--shadow-sm);text-decoration:none;cursor:pointer;transition:transform .08s,box-shadow .08s}
.btn:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--ink)}
.btn.accent{background:var(--accent)} .btn.ghost{background:transparent;box-shadow:none} .btn.big{font-size:18px;padding:14px 22px}
.btn[disabled]{background:var(--sand);color:var(--muted);box-shadow:none;cursor:default;transform:none}
select,input,textarea{font:700 15px var(--font);padding:10px 12px;border:var(--line) solid var(--ink);border-radius:var(--radius-pill);background:#fff;color:var(--ink);max-width:100%;box-shadow:var(--shadow-sm)}
input{flex:1;min-width:150px}
.pipeline{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.step{font-size:12px;font-weight:700;background:var(--cream);border:2px solid var(--ink);border-radius:var(--radius-pill);padding:5px 10px;color:var(--muted)} .step.on{color:var(--ink);background:var(--accent)} .step b{margin-left:6px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow);padding:var(--pad);font-size:var(--small);font-weight:500}
body[data-page="login"] main,body[data-page="login"] header{max-width:420px} body[data-page="login"] header{justify-content:center} body[data-page="login"] main{display:block} body[data-page="login"] h1{text-align:center} body[data-page="login"] h1 .head{display:inline-block}
.login{display:flex;flex-direction:column;gap:12px;max-width:360px;margin:10px auto 0;background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow);padding:22px}
.login label{font-family:var(--display);text-transform:uppercase;font-size:18px} .login input{width:100%} .login .note{color:var(--muted);margin:0} .warn{color:var(--red);font-weight:700;margin:0}
.dock{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:center;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:var(--page);border-top:var(--line) solid var(--ink)}
.dock a{flex:1;max-width:150px;text-align:center;font:700 14px var(--font);color:var(--ink);background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius-pill);padding:11px 6px;text-decoration:none;box-shadow:var(--shadow-sm)}
.dock a.on{background:var(--accent)}
/* Wider screens: the dock moves to the top, right under the logo. The body becomes a column so order can place it. */
@media (min-width:700px){body{display:flex;flex-direction:column;padding-bottom:40px} header{order:0;width:100%} .dock{order:1;position:static;background:transparent;border:0;width:100%;max-width:640px;margin:6px auto 4px;padding:0;justify-content:flex-start} main{order:2;width:100%}}
/* Wider screens: use the room. The header, headline, and stat card stay full width; cards flow into columns. */
@media (min-width:900px){
  main,header,.dock{max-width:1120px}
  main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:20px;align-items:start}
  main > h1,main > .stat,main > h2,main > .note,main > .pipeline,main > pre,main > form,main > .passed-list,main > .intro,main > .empty{grid-column:1 / -1}
  main > .card{margin-bottom:20px}
  h1{font-size:64px} .stat{grid-template-columns:auto 1fr;column-gap:40px;align-items:center}
  .stat-tiles{gap:14px} .tile{padding:16px 18px} .tile b{font-size:48px}
  .stat-foot{position:absolute;top:var(--pad);right:var(--pad)}
  .dock{justify-content:flex-start;gap:12px} .dock a{flex:none;min-width:150px}
}
@media (min-width:1400px){main{grid-template-columns:repeat(3,minmax(0,1fr))}}
/* ---------- life: gradient backgrounds and motion. Everything here is decoration; reduced-motion users get none of the movement. ---------- */
body{--page-hi:color-mix(in srgb,var(--page) 62%,#fff);--page-lo:color-mix(in srgb,var(--page) 72%,#1a1333);--page-pop:color-mix(in srgb,var(--page) 55%,var(--accent))}
body::before{content:"";position:fixed;inset:-25%;z-index:-1;pointer-events:none;
  background:radial-gradient(circle at 18% 12%,var(--page-hi) 0,transparent 38%),radial-gradient(circle at 85% 30%,var(--page-pop) 0,transparent 34%),radial-gradient(circle at 70% 90%,var(--page-lo) 0,transparent 45%),var(--page);
  animation:drift 22s ease-in-out infinite alternate}
@keyframes drift{0%{transform:translate(0,0) rotate(0)}50%{transform:translate(3%,-2%) rotate(4deg)}100%{transform:translate(-3%,2%) rotate(-3deg)}}
/* cards rise in one after another on load */
main > *{animation:rise .5s cubic-bezier(.2,.9,.3,1.2) both}
main > *:nth-child(2){animation-delay:.04s} main > *:nth-child(3){animation-delay:.08s} main > *:nth-child(4){animation-delay:.12s} main > *:nth-child(5){animation-delay:.16s} main > *:nth-child(6){animation-delay:.2s} main > *:nth-child(7){animation-delay:.24s} main > *:nth-child(n+8){animation-delay:.28s}
@keyframes rise{from{opacity:0;transform:translateY(18px) scale(.98)}to{opacity:1;transform:none}}
/* the scribble draws itself left to right */
/* the headline decoration draws itself in; see CYCLE_JS for the rotation */
/* buttons lift on hover, squash when pressed */
.btn,.dock a,.pill-link{transition:transform .15s cubic-bezier(.3,1.6,.5,1),box-shadow .15s ease,background-color .2s}
@media (hover:hover){.btn:hover:not([disabled]),.dock a:hover,.pill-link:hover{transform:translate(-2px,-2px) rotate(-1deg);box-shadow:6px 6px 0 var(--ink)} .btn.ghost:hover{box-shadow:4px 4px 0 var(--ink)}}
.btn:active:not([disabled]),.dock a:active,.pill-link:active{transform:translate(3px,3px) scale(.97);box-shadow:0 0 0 var(--ink)}
.btn.accent:not([disabled]){background-image:linear-gradient(120deg,transparent 30%,rgba(255,255,255,.55) 45%,transparent 60%);background-size:250% 100%;background-position:120% 0}
@media (hover:hover){.btn.accent:hover:not([disabled]){animation:shine .8s ease}}
@keyframes shine{from{background-position:120% 0}to{background-position:-30% 0}}
.dock a.on{animation:pop .45s cubic-bezier(.3,1.8,.5,1)}
@keyframes pop{0%{transform:scale(.9)}60%{transform:scale(1.06)}100%{transform:scale(1)}}
/* cards tilt up a touch on hover, score pills pop in */
.card{transition:transform .2s cubic-bezier(.3,1.5,.5,1),box-shadow .2s}
@media (hover:hover){main > .card:hover{transform:translate(-2px,-3px);box-shadow:9px 9px 0 var(--ink)}}
.score{animation:pop .5s .35s cubic-bezier(.3,1.8,.5,1) both}
/* the logo's bullseye spins on hover and when the page loads */
.brand .o{transition:transform .5s cubic-bezier(.3,1.6,.5,1);animation:spin-in .9s .1s cubic-bezier(.3,1.4,.5,1) both}
@media (hover:hover){.brand:hover .o{transform:rotate(200deg) scale(1.15)}}
@keyframes spin-in{from{transform:rotate(-180deg) scale(.4)}to{transform:none}}
/* a tapped pass/undo/save button gives a little wiggle */
.btn.tapped{animation:wiggle .35s ease}
@keyframes wiggle{25%{transform:rotate(-3deg)}75%{transform:rotate(3deg)}}
.card.dim{transition:opacity .3s}
/* Review. The kit page is a writing tool: each answer is read, edited until it sounds right, saved, then
   copied into the application by hand. So the answers sit on one quiet sheet with a reading measure,
   not in chunky cards, and the boxes grow with the text. */
a.kitcard{display:block;color:var(--ink);text-decoration:none}
.notes summary{cursor:pointer;list-style:none} .notes summary::-webkit-details-marker{display:none} .notes summary h3{margin:0}
.md{font-size:var(--small);font-weight:500;overflow-wrap:anywhere} .md h4{margin:14px 0 6px;font-size:15px} .md p{margin:6px 0} .md ul,.md ol{margin:6px 0;padding-left:20px}
/* notes tables: words wrap whole, links may break anywhere, and a table still too wide scrolls inside its card */
.md .tablewrap{overflow-x:auto;margin:8px 0} .md table{border-collapse:collapse;width:100%;font-size:13px} .md td{border:2px solid var(--ink);padding:6px 8px;vertical-align:top;overflow-wrap:normal;min-width:4.5em} .md td a{overflow-wrap:anywhere} .md tr:first-child td{font-weight:800;background:var(--sand)}
.btn.saved{background:var(--green)} .btn.small{font-size:13px;padding:7px 12px}
.sheet{background:var(--paper);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow);padding:6px var(--sheet-pad);margin:0 0 16px}
.sheet .answer{padding:var(--sheet-pad) 0} .sheet .answer + .answer{border-top:2px dashed var(--rule)}
.answer .q{font:700 19px/1.3 var(--font);text-transform:none;margin:0 0 12px;max-width:var(--measure)}
.q-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px} .q-row .q{margin-bottom:12px}
textarea.ans{display:block;width:100%;resize:none;overflow:hidden;font:400 var(--read)/1.65 var(--serif);color:var(--ink);background:var(--paper-in);border:1.5px solid var(--rule);border-radius:10px;box-shadow:none;padding:14px 16px;min-height:90px;transition:border-color .15s,box-shadow .15s}
textarea.ans:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px var(--accent)}
textarea.ans[hidden]{display:none}
.ans-bar{display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap;margin-top:10px;font-size:var(--small);font-weight:700;color:var(--muted)}
.ans-bar .count b{color:var(--ink);font-variant-numeric:tabular-nums} .ans-bar .count.over,.ans-bar .count.over b{color:var(--red)} .ans-bar .lim{font-weight:500}
.ans-bar .status{display:inline-flex;align-items:center;gap:6px} .ans-bar .status::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--green);border:1.5px solid var(--ink)}
.ans-bar .status[data-state="dirty"]{color:var(--ink)} .ans-bar .status[data-state="dirty"]::before{background:var(--accent)}
.ans-bar .btn{margin-left:auto;padding:9px 18px}
/* "label: value" sections read as the form fields they'll be typed into */
.fieldlist{margin:0;display:grid;gap:0;max-width:var(--measure)} .field{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:4px 16px;padding:10px 0;border-top:1px solid var(--rule)} .field:first-child{border-top:0}
.field dt{font-size:var(--small);font-weight:700;color:var(--muted);padding-top:2px} .field dd{margin:0;font:400 16px/1.45 var(--serif);overflow-wrap:anywhere}
.field.need dd .v{color:var(--muted)} .chip{display:inline-block;margin-left:8px;font:700 11px/1 var(--font);text-transform:uppercase;letter-spacing:.5px;background:var(--accent);border:2px solid var(--ink);border-radius:var(--radius-tag);padding:3px 7px;vertical-align:2px;white-space:nowrap}
.fields:not(.editing) .ans-bar .btn{display:none} .fields:not(.editing) .ans-bar .count{display:none} .fields.editing .fieldlist{display:none}
@media (max-width:560px){.field{grid-template-columns:1fr;padding:9px 0} .field dt{padding-top:0} textarea.ans{padding:12px}}
/* Desktop: kit header and notes stay pinned on the left; the sheet scrolls on the right. */
@media (min-width:900px){
  body[data-page="review"] main > .kit{grid-column:1 / -1;display:grid;grid-template-columns:300px minmax(0,var(--sheet-max));justify-content:start;column-gap:32px;align-items:start}
  .kit-side{position:sticky;top:calc(16px + env(safe-area-inset-top));max-height:calc(100vh - 32px - env(safe-area-inset-top));display:flex;flex-direction:column;gap:20px;padding-bottom:6px}
  .kit-side > .card{margin:0;flex:none} .kit-side > .notes{flex:0 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
  .kit-main > h2:first-child{margin-top:0}
  body[data-page="review"] main > .kitgrid{grid-column:1 / -1;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px}
  .kitgrid > .kitcard{margin:0;display:flex;flex-direction:column} .kitgrid > .kitcard .meta{margin-top:auto;padding-top:8px}
}
@media (min-width:1200px){body[data-page="review"] main > .kit{grid-template-columns:360px minmax(0,var(--sheet-max))}}
@media (hover:hover){.kitgrid > .card:hover{transform:translate(-2px,-3px);box-shadow:9px 9px 0 var(--ink)}}
.row h3,.co h3{min-width:0;overflow-wrap:break-word;hyphens:manual} .co h3.long,.co h3.xlong{font-size:.9em} .co{align-items:flex-start} .co .logo{margin-top:1px} .tile b{font-size:clamp(26px,8vw,34px)}
/* the next-action box takes its own line and grows with the text, so nothing gets cut off */
textarea[data-act="next"]{flex:1 1 100%;width:100%;order:-1;resize:none;overflow:hidden;line-height:1.35;border-radius:18px;padding:11px 16px;min-height:44px}
/* the hero card: a sheen sweeps across, the number pops and counts up (CLIENT_JS), the tiles bounce in one by one */
.stat{overflow:hidden;isolation:isolate}
.stat::after{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.7) 50%,transparent 65%);background-size:300% 100%;animation:sweep 6s 1s ease-in-out infinite}
@keyframes sweep{0%{background-position:150% 0}40%,100%{background-position:-50% 0}}
.stat-big{display:inline-block;transform-origin:20% 80%;animation:big-in .8s .15s cubic-bezier(.3,1.7,.5,1) both}
@keyframes big-in{from{transform:scale(.3) rotate(-12deg);opacity:0}to{transform:none;opacity:1}}
@media (hover:hover){.stat-big:hover{animation:jelly .6s ease}}
@keyframes jelly{30%{transform:scale(1.12,.88)}50%{transform:scale(.92,1.08)}70%{transform:scale(1.04,.96)}100%{transform:none}}
.stat-label,.stat-sub{animation:slide-in .5s cubic-bezier(.2,.9,.3,1.2) both} .stat-label{animation-delay:.05s} .stat-sub{animation-delay:.3s}
@keyframes slide-in{from{opacity:0;transform:translateX(-16px)}to{opacity:1;transform:none}}
.tile{animation:tile-in .6s cubic-bezier(.3,1.6,.5,1) both;transition:transform .2s cubic-bezier(.3,1.6,.5,1),box-shadow .2s}
.tile:nth-child(1){animation-delay:.35s} .tile:nth-child(2){animation-delay:.47s} .tile:nth-child(3){animation-delay:.59s}
@keyframes tile-in{from{opacity:0;transform:translateY(24px) rotate(4deg) scale(.85)}to{opacity:1;transform:none}}
@media (hover:hover){.tile:hover{transform:translate(-2px,-3px) rotate(-2deg);box-shadow:5px 5px 0 var(--ink)} .tile:nth-child(2):hover{transform:translate(-2px,-3px) rotate(2deg)}}
.tile.hot{animation:tile-in .6s .35s cubic-bezier(.3,1.6,.5,1) both,glow 1.8s 1.2s ease-in-out infinite}
@keyframes glow{0%,100%{box-shadow:0 0 0 0 var(--ink)}50%{box-shadow:0 0 0 6px color-mix(in srgb,var(--accent) 45%,transparent)}}
.stat-foot::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);border:2px solid var(--ink);margin-right:7px;vertical-align:0;animation:beat 2s ease-in-out infinite}
@keyframes beat{0%,100%{transform:scale(1)}50%{transform:scale(1.35)}}
/* section headings draw an underline in */
h2{position:relative;width:fit-content}
h2::after{content:"";position:absolute;left:0;right:0;bottom:-4px;height:4px;border-radius:4px;background:var(--accent);transform-origin:left;animation:underline .7s .4s cubic-bezier(.3,1.4,.5,1) both}
@keyframes underline{from{transform:scaleX(0)}to{transform:scaleX(1)}}
/* tags pop in one after another; the "new" tag keeps a little wiggle */
.tag{display:inline-block;animation:pop .45s cubic-bezier(.3,1.8,.5,1) both} .tag:nth-child(1){animation-delay:.2s} .tag:nth-child(2){animation-delay:.28s} .tag:nth-child(3){animation-delay:.36s} .tag:nth-child(n+4){animation-delay:.44s}
.card.is-new .tag.accent:last-child{animation:pop .45s .44s cubic-bezier(.3,1.8,.5,1) both,nudge 2.4s 1.2s ease-in-out infinite}
@keyframes nudge{0%,80%,100%{transform:none}85%{transform:rotate(-6deg) scale(1.08)}90%{transform:rotate(6deg) scale(1.08)}95%{transform:rotate(-3deg)}}
/* the dock buttons bounce in */
.dock a{animation:pop .5s cubic-bezier(.3,1.8,.5,1) both} .dock a:nth-child(2){animation-delay:.06s} .dock a:nth-child(3){animation-delay:.12s} .dock a:nth-child(4){animation-delay:.18s}
/* company logos: a white tile with the same outline as everything else; the letter badge sits under the image */
.co{display:flex;align-items:center;gap:10px;min-width:0}
.logo{position:relative;flex:none;width:40px;height:40px;border:2.5px solid var(--ink);border-radius:11px;background:var(--badge);box-shadow:2px 2px 0 var(--ink);overflow:hidden;display:grid;place-items:center}
.logo b{font-family:var(--display);font-size:18px;color:var(--ink);line-height:1}
.logo img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.kitcard .co{margin:2px 0 4px}
/* the borrowed panda: art with a transparent background, bobbing gently (reduced motion stops it below) */
/* only the panda layer moves: a slow breath that grows him from his feet, so the circle behind never shows a seam */
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.035,1.05)}}
.panda{display:block;position:relative;pointer-events:none}
.panda img{display:block;width:100%;height:auto}
.panda .panda-fg{position:absolute;inset:0;transform-origin:50% 92%;animation:breathe 3.6s ease-in-out infinite}
.stat-main{position:relative;padding-right:clamp(112px,32vw,170px)}
.stat-panda{position:absolute;right:0;top:50%;width:clamp(100px,28vw,140px);margin-top:calc(clamp(100px,28vw,140px) / -2)}
.intro{display:flex;align-items:center;gap:12px;margin:0 0 14px;max-width:760px} .intro .panda{width:84px;flex:none} .intro .note{margin:0}
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:10px 0 18px} .empty .panda{width:150px}
.login-panda{width:150px;margin:0 auto -6px}
h1{position:relative} .hero-panda{position:absolute;right:0;top:-6px;width:170px}
@media (max-width:899px){.hero-panda{width:120px;top:0}}
@media (max-width:560px){h1:has(.hero-panda){padding-right:78px} .hero-panda{width:72px;top:2px}}
.about-panda{float:right;width:110px;margin:-6px -6px 4px 10px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none !important;transition:none !important}}
`;

// The only JavaScript the pages need: send a tap to the API and update the card in place.
const CLIENT_JS = `
// The next-action box grows to fit its text instead of cutting it off.
document.querySelectorAll('textarea[data-act="next"],textarea.ans').forEach(function(t){const fit=function(){t.style.height="auto";t.style.height=t.scrollHeight+t.offsetHeight-t.clientHeight+"px"};fit();t.addEventListener("input",fit);addEventListener("resize",fit);if(document.fonts)document.fonts.ready.then(fit)});
// The hero numbers count up from zero on load. bump() moves the target too, so a pass mid-count still lands right.
(function(){if(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches)return;document.querySelectorAll(".stat-big,.tile b").forEach(function(el,n){const end=parseInt(el.textContent,10);if(!(end>0))return;el.dataset.end=end;const t0=performance.now()+150+n*120,dur=end>20?1100:600;el.textContent="0";requestAnimationFrame(function tick(t){const k=Math.min(1,Math.max(0,(t-t0)/dur)),goal=+el.dataset.end;el.textContent=Math.round(goal*(1-Math.pow(1-k,3)));if(k<1)requestAnimationFrame(tick);else delete el.dataset.end})})})();
async function post(url, body){const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(!r.ok){alert("that didn't save. try again.");throw new Error(r.status)}return r.json()}
function bump(id,d){const el=document.getElementById(id);if(!el)return;if(el.dataset.end)el.dataset.end=Math.max(0,+el.dataset.end+d);el.textContent=Math.max(0,(parseInt(el.textContent,10)||0)+d)}
function syncPassed(){const box=document.getElementById("passed");const n=parseInt((document.getElementById("passed-count")||{}).textContent,10)||0;if(box){box.hidden=n===0;if(n===0)box.open=false}}
function passedClone(card,key){const a=document.createElement("article");a.className="card passed";a.dataset.key=key;a.dataset.origin="main";
 const row=document.createElement("div");row.className="row";const h=document.createElement("h3");h.textContent=(card.querySelector("h3")||{}).textContent||"";const sc=document.createElement("span");sc.className="score";sc.textContent=(card.querySelector(".score")||{}).textContent||"";row.append(h,sc);
 const t=document.createElement("div");t.className="title";t.textContent=(card.querySelector(".title")||{}).textContent||"";
 const m=document.createElement("div");m.className="meta";m.textContent="passed just now";
 const acts=document.createElement("div");acts.className="actions";const u=document.createElement("button");u.className="btn accent";u.dataset.act="unpass";u.textContent="unpass";acts.append(u);
 const link=card.querySelector("a.btn");if(link){const l=link.cloneNode(true);acts.append(l)}
 a.append(row,t,m,acts);return a}
function mainCard(key){return [...document.querySelectorAll("main > .card[data-key]")].find(c=>c.dataset.key===key)}
function clonesFor(key){return [...document.querySelectorAll("#passed-cards .card")].filter(c=>c.dataset.key===key)}
document.addEventListener("click",async(e)=>{const b=e.target.closest("button[data-act]");if(!b||b.disabled)return;b.classList.remove("tapped");void b.offsetWidth;b.classList.add("tapped");const card=b.closest("[data-key]");const key=card&&card.dataset.key;if(!key)return;b.disabled=true;
 try{
 if(b.dataset.act==="queue"){await post("/api/queue",{key});b.textContent="queued ✓";return}
 if(b.dataset.act==="pass"){await post("/api/pass",{key});card.classList.add("dim");b.textContent="undo";b.dataset.act="unpass";bump("open-count",-1);bump("passed-count",1);const box=document.getElementById("passed-cards");if(box)box.prepend(passedClone(card,key));syncPassed()}
 else if(b.dataset.act==="unpass"){await post("/api/pass",{key,undo:true});bump("passed-count",-1);bump("open-count",1);
  if(card.classList.contains("passed")){clonesFor(key).forEach(c=>c.remove());card.remove();const mc=mainCard(key);if(mc){mc.classList.remove("dim");const pb=mc.querySelector('button[data-act="unpass"]');if(pb){pb.textContent="pass";pb.dataset.act="pass"}}else{syncPassed();location.reload();return}}
  else{card.classList.remove("dim");b.textContent="pass";b.dataset.act="pass";clonesFor(key).forEach(c=>c.remove())}
  syncPassed()}
 else if(b.dataset.act==="save"){const state=card.querySelector('[data-act="state"]').value;const next=card.querySelector('[data-act="next"]').value;await post("/api/tracker",{key,state,next});b.textContent="saved";setTimeout(()=>location.reload(),400)}
 }finally{b.disabled=b.dataset.act==="queue"&&b.textContent.startsWith("queued")}
});
// Review page: save an answer or the letter (it goes back into the kit on the Mac's next pull), mark submitted.
function setStatus(card,state,text){const s=card.querySelector(".status");if(s){s.dataset.state=state;s.textContent=text}}
// Same counting as countBy() on the server: words, sentences, or characters, checked against what the question asks for.
function recount(card){const c=card.querySelector(".count"),t=card.querySelector("textarea.ans");if(!c||!t)return;const v=t.value.trim(),k=c.dataset.kind;
 const n=!v?0:k==="chars"?v.length:k==="sentences"?v.split(/[.!?]+(?:\\s+|$)/).filter(x=>x.trim()).length:v.split(/\\s+/).length;
 c.querySelector("b").textContent=n;const max=+c.dataset.max;c.classList.toggle("over",max>0&&n>(c.dataset.soft==="1"?max*1.15:max))}
// Rebuilds the label and value list after the raw text of a fields section was edited. Mirrors fieldRows() on the server.
function rebuildFields(card){const dl=card.querySelector(".fieldlist"),t=card.querySelector("textarea.ans");if(!dl||!t)return;dl.textContent="";
 t.value.split("\\n").filter(l=>l.trim()).forEach(l=>{const line=l.replace(/^\\s*[-*] /,""),at=line.indexOf(":");const lab=at>0&&at<60?line.slice(0,at).trim():"",val=at>0&&at<60?line.slice(at+1).trim():line.trim();
  const need=/\\[(confirm|required|your detail)/i.test(val);const row=document.createElement("div");row.className="field"+(need?" need":"");const dt=document.createElement("dt");dt.textContent=lab;const dd=document.createElement("dd");const v=document.createElement("span");v.className="v";v.textContent=val;dd.append(v);
  if(need){const c=document.createElement("span");c.className="chip";c.textContent="needs you";dd.append(c)}row.append(dt,dd);dl.append(row)})}
document.addEventListener("click",async(e)=>{const b=e.target.closest("button[data-act]");if(!b||b.disabled)return;const act=b.dataset.act;
 if(act==="edit-fields"){const card=b.closest(".answer"),t=card.querySelector("textarea.ans"),on=!card.classList.contains("editing");card.classList.toggle("editing",on);t.hidden=!on;b.textContent=on?"done":"edit";
  if(on){t.style.height="auto";t.style.height=t.scrollHeight+t.offsetHeight-t.clientHeight+"px";t.focus()}else rebuildFields(card);return}
 if(act!=="save-answer"&&act!=="save-letter"&&act!=="submitted")return;
 const head=document.querySelector(".kit-head");if(!head)return;b.disabled=true;
 try{
  if(act==="submitted"){await post("/api/tracker",{key:head.dataset.key,state:"Applied"});b.textContent="marked applied ✓";const t=head.querySelector(".tag");if(t){t.textContent="Applied";t.className="tag green"}return}
  const card=b.closest(".answer"),text=card.querySelector("textarea").value;
  await post("/api/kit-answer",{slug:head.dataset.slug,i:act==="save-letter"?"letter":parseInt(card.dataset.i,10),text});
  setStatus(card,"saved","saved just now");if(card.classList.contains("fields"))rebuildFields(card);
  b.textContent="saved ✓";b.classList.add("saved");setTimeout(()=>{b.textContent="save";b.classList.remove("saved")},1600);
 }finally{b.disabled=act==="submitted"&&b.textContent.startsWith("marked")}
});
document.addEventListener("input",(e)=>{const t=e.target.closest("textarea.ans");if(!t)return;const card=t.closest(".answer");recount(card);setStatus(card,"dirty","unsaved changes");const b=card.querySelector('button[data-act^="save"]');if(b){b.textContent="save";b.classList.remove("saved")}});
// Warn before leaving with an edit that was never saved.
addEventListener("beforeunload",(e)=>{if(document.querySelector('.status[data-state="dirty"]')){e.preventDefault();e.returnValue=""}});`;

/* ---------------------------------------------------------------- small helpers */

// Today's date in New York (YYYY-MM-DD). The server runs in UTC, which is already tomorrow after 8 PM ET.
function nyDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function roleWord(m) {
  return { swe: "software", pm: "product", it: "IT", design: "design", ambassador: "ambassador", program: "program" }[m.role] || "match";
}

function breakdown(m) {
  const b = m.breakdown || {};
  return `role ${m.role} ${b.role ?? 0} + tier ${m.tier} ${b.tier ?? 0} + early ${b.early_career ?? 0} + deg ${b.degrees ?? 0} + loc ${b.location ?? 0} + fresh ${b.freshness ?? 0} + kw ${b.keywords ?? 0}`;
}
function age(ts) {
  if (!ts) return "?";
  const sec = typeof ts === "number" ? ts : Date.parse(ts) / 1000;
  const days = Math.floor((Date.now() / 1000 - sec) / 86400);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}
// Review cards: when the internship opened (kept in the kit itself, so it never disappears) and when the kit was saved.
function kitDates(k) {
  const opened = /^\d{4}-\d{2}-\d{2}$/.test(k.opened || "")
    ? new Date(k.opened + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "";
  return `${opened ? "opened " + esc(opened) + " · " : ""}kit saved ${esc(when(k.updated))}`;
}

function when(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
// Posting and page links come from outside lists: only http(s) links become hrefs, never javascript: or data:.
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || "")) ? u : "#";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function png(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
}
function manifest() {
  return new Response(JSON.stringify({
    name: "Scout", short_name: "Scout", start_url: "/", scope: "/", display: "standalone",
    background_color: "#ffffff", theme_color: "#d2612a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  }), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" } });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function redirect(to, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: to, ...headers } });
}
