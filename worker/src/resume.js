/* "Let's Add to Your Resume" (owner only for now).
 *
 * /resume                       the page: Resume additions on top, then Hackathons and Certifications tabs
 * /resume/mail/<id>             the email an event card came from (kept text only), so a card can link back to it
 * POST /api/resume-status       { key, state, project? }  Interested -> Signed up -> Done (Done writes the resume line)
 * POST /api/resume-line         { key, line }             edit a resume line before copying it
 * POST /api/resume-settings     { radius }                the hackathon radius in miles
 * Secret header (cron / Mac):   POST /api/ingest-resume   the daily feed (scout/feed.py)
 *                               POST /api/ingest-mail     forwarded or Gmail-read announcements (scout/mailfeed.py)
 * Email Worker (index.js email()): mail forwarded to the Cloudflare address lands in handleEmail below.
 *
 * Everything is gated on the owner's cookie in index.js, after the student accounts have had their turn, so a
 * signed-in student on /resume is sent to their own home page like on any other owner page. State is in KV
 * (resume:state, resume:settings), like the owner's tracker. When this opens to students it moves to a D1 table
 * shaped like `tracks`; the pure rules in resumelogic.js don't change.
 *
 * Page text and email text are untrusted: everything printed is escaped, every link goes through safeUrl.
 */

import { parseHackathonMail } from "./mailparse.js";
import { STATES, DEFAULT_RADIUS, decorate, visible, sortEvents, mergeEvents, hackathonLine, certLine, roleLabels, todayET } from "./resumelogic.js";
import places from "./places.json" with { type: "json" };

export const MAIL_SENDERS = ["ywcc@njit.edu", "ywcc-advising@njit.edu", "danello@njit.edu"];
const SCHOOL_ALIASES = ["njit", "new jersey institute of technology", "hacknjit"];
const MAX_MAIL = 200;
const MAX_TEXT = 12000;
const get = (env, key, fallback) => env.SCOUT.get(key, "json").then((v) => v ?? fallback);
const put = (env, key, value) => env.SCOUT.put(key, JSON.stringify(value));

const senderAddress = (from) => {
  const m = /<([^>]+)>/.exec(String(from || ""));
  return (m ? m[1] : String(from || "")).trim().toLowerCase();
};
export const allowedSender = (from, env) => {
  const list = env && env.MAIL_SENDERS ? String(env.MAIL_SENDERS).toLowerCase().split(/[,\s]+/).filter(Boolean) : MAIL_SENDERS;
  return list.includes(senderAddress(from));
};

/* ---------------------------------------------------------------- feeds in */

export async function ingestResume(request, env, ui) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return ui.json({ error: "expected the feed object" }, 400);
  const jobs = [];
  if (body.hackathons && Array.isArray(body.hackathons.events)) jobs.push(put(env, "resume:hackathons", body.hackathons));
  if (body.certs && Array.isArray(body.certs.items)) jobs.push(put(env, "resume:certs", body.certs));
  await Promise.all(jobs);
  return ui.json({ ok: true, hackathons: (body.hackathons?.events || []).length, certs: (body.certs?.items || []).length });
}

// Parse and store messages. Mail from anyone but the allowed senders is dropped before it is read or kept.
export async function storeMail(env, messages) {
  const store = await get(env, "resume:mail", {});
  let kept = 0;
  for (const m of messages) {
    if (!m || !m.id || !allowedSender(m.from, env)) continue;
    const id = String(m.id).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80);
    if (!id) continue;
    const events = parseHackathonMail({ id, from: m.from, subject: m.subject, date: m.date, text: m.text });
    store[id] = {
      id, from: senderAddress(m.from), subject: String(m.subject || "").slice(0, 200), date: String(m.date || "").slice(0, 40),
      text: String(m.text || "").slice(0, MAX_TEXT), link: typeof m.link === "string" ? m.link.slice(0, 300) : "", events,
      stored_at: new Date().toISOString(),
    };
    kept += 1;
  }
  const ids = Object.keys(store).sort((a, b) => (store[b].date || "").localeCompare(store[a].date || ""));
  for (const id of ids.slice(MAX_MAIL)) delete store[id];
  await put(env, "resume:mail", store);
  return kept;
}

export async function ingestMail(request, env, ui) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return ui.json({ error: "expected { messages: [...] }" }, 400);
  return ui.json({ ok: true, kept: await storeMail(env, body.messages.slice(0, 100)) });
}

// Cloudflare Email Routing hands the raw message here. Two checks before anything is read: the envelope sender
// is the owner's own forwarding address (MAIL_FORWARDER, set with wrangler secret), and the From header is one of
// the hackathon senders. Anything else is rejected and never stored.
export async function handleEmail(message, env) {
  const forwarder = String(env.MAIL_FORWARDER || "").trim().toLowerCase();
  if (!forwarder || String(message.from || "").toLowerCase() !== forwarder) { message.setReject("not accepted"); return; }
  const { default: PostalMime } = await import("postal-mime");
  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > 2_000_000) { message.setReject("too large"); return; }
  const mail = await new PostalMime().parse(raw);
  const from = mail.from ? `${mail.from.name || ""} <${mail.from.address || ""}>` : "";
  const subject = mail.subject || "";
  const text = mail.text || String(mail.html || "").replace(/<[^>]+>/g, " ");
  // An automatic forward keeps the original From header; a hand-made forward names the sender in the body.
  const orig = allowedSender(from, env) ? from : (text.match(/From:\s*([^\n]+)/i) || [])[1] || "";
  if (!allowedSender(orig, env)) { message.setReject("sender not on the list"); return; }
  await storeMail(env, [{ id: (mail.messageId || `${Date.now()}`).replace(/[<>]/g, ""), from: orig, subject, date: mail.date || new Date().toISOString(), text }]);
}

/* ---------------------------------------------------------------- state API */

export async function resumeApi(request, env, ui, path) {
  if (request.method !== "POST") return ui.json({ error: "bad request" }, 400);
  const body = await request.json().catch(() => ({}));
  const now = new Date().toISOString();

  if (path === "/api/resume-settings") {
    const radius = Math.round(Number(body.radius));
    if (!(radius >= 5 && radius <= 500)) return ui.json({ error: "radius must be 5 to 500 miles" }, 400);
    await put(env, "resume:settings", { radius });
    return ui.json({ ok: true, radius });
  }
  const key = typeof body.key === "string" && body.key.length <= 200 ? body.key : "";
  if (!key) return ui.json({ error: "need key" }, 400);
  const state = await get(env, "resume:state", {});

  if (path === "/api/resume-line") {
    if (!state[key] || state[key].state !== "Done") return ui.json({ error: "not done yet" }, 404);
    state[key].line = String(body.line || "").slice(0, 400);
    state[key].line_edited = true;  // a later "Done" tap must not overwrite what was typed
    state[key].updated = now;
    await put(env, "resume:state", state);
    return ui.json({ ok: true });
  }
  if (path === "/api/resume-status") {
    if (body.state === "" || body.state === null) { delete state[key]; await put(env, "resume:state", state); return ui.json({ ok: true }); }
    if (!STATES.includes(body.state)) return ui.json({ error: "unknown state" }, 400);
    const found = await findItem(env, key, state);
    if (!found) return ui.json({ error: "that item isn't in the feed anymore" }, 404);
    const row = state[key] || { history: [] };
    if (row.state !== body.state) row.history = [...(row.history || []), { date: now, state: body.state }].slice(-20);
    Object.assign(row, { state: body.state, kind: found.kind, title: found.title, url: found.url, start: found.start || "", updated: now });
    if (typeof body.project === "string") row.project = body.project.slice(0, 120);
    if (body.state === "Done") {
      row.done_at = row.done_at || now;
      if (!row.line_edited) row.line = found.kind === "hack" ? hackathonLine(found.item, row.project, row.done_at) : certLine(found.item, row.done_at);
    }
    state[key] = row;
    await put(env, "resume:state", state);
    return ui.json({ ok: true, line: row.line || "" });
  }
  return ui.json({ error: "not found" }, 404);
}

// The item behind a key, from the live feed or, for one that has dropped out of it, the snapshot kept in state.
async function findItem(env, key, state) {
  const [hack, certs, mail] = await Promise.all([get(env, "resume:hackathons", {}), get(env, "resume:certs", {}), get(env, "resume:mail", {})]);
  const events = mergeEvents(hack.events || [], mailEvents(mail));
  const e = events.find((x) => x.key === key);
  if (e) return { kind: "hack", item: e, title: e.name, url: e.url || e.source_url || "", start: e.start };
  const c = (certs.items || []).find((x) => x.key === key);
  if (c) return { kind: "cert", item: c, title: c.name, url: c.url, start: "" };
  const old = state[key];
  if (old) return { kind: old.kind, item: old.kind === "hack" ? { name: old.title, start: old.start } : { name: old.title, resume_line: "" }, title: old.title, url: old.url, start: old.start };
  return null;
}

function mailEvents(mail) {
  const out = [];
  for (const m of Object.values(mail || {})) {
    (m.events || []).forEach((e, i) => out.push({
      ...e, key: `mail:${m.id}:${i}`, source: "email", host: e.host || "",
      mail: { id: m.id, link: m.link, subject: m.subject, from: m.from, date: m.date },
    }));
  }
  return out;
}

/* ---------------------------------------------------------------- page */

const dayText = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "");
const rangeText = (e) => {
  if (!e.start) return e.date_text || "date not listed";
  return e.end && e.end !== e.start ? `${dayText(e.start)} to ${dayText(e.end)}, ${e.end.slice(0, 4)}` : `${dayText(e.start)}, ${e.start.slice(0, 4)}`;
};
const ago = (iso) => {
  const h = Math.round((Date.now() - Date.parse(iso || 0)) / 3600000);
  return !iso ? "never" : h < 1 ? "just now" : h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
};

export async function resumePage(env, ui, url) {
  const tab = url.searchParams.get("tab") === "certs" ? "certs" : "hacks";
  const chip = url.searchParams.get("chip") === "mine" ? "mine" : "nearby";
  const [hack, certs, mail, state, settings] = await Promise.all([get(env, "resume:hackathons", {}), get(env, "resume:certs", {}),
    get(env, "resume:mail", {}), get(env, "resume:state", {}), get(env, "resume:settings", {})]);
  const radius = settings.radius || DEFAULT_RADIUS;
  const today = todayET();
  const all = decorate(mergeEvents(hack.events || [], mailEvents(mail)), { home: places.home, today, schoolAliases: SCHOOL_ALIASES });
  const counts = { mine: visible(all, { chip: "mine", radius }).length, nearby: visible(all, { chip: "nearby", radius }).length };
  const events = sortEvents(visible(all, { chip, radius }));

  const stateSelect = (key, id) => {
    const cur = (state[key] || {}).state || "";
    return `<label class="sr" for="${id}">status</label><select id="${id}" data-r="state"><option value=""${cur ? "" : " selected"}>not started</option>${STATES.map((s) => `<option${s === cur ? " selected" : ""}>${s}</option>`).join("")}</select>`;
  };
  const hackCard = (e, i) => {
    const mailLink = e.mail ? (e.mail.link ? ui.safeUrl(e.mail.link) : `/resume/mail/${encodeURIComponent(e.mail.id)}`) : "";
    const tags = [
      e.soon ? `<span class="tag red">closes ${e.deadlineIn === 0 ? "today" : `in ${e.deadlineIn} day${e.deadlineIn === 1 ? "" : "s"}`}</span>` : "",
      e.mine ? `<span class="tag accent">my school</span>` : "",
      e.checked ? `<span class="tag green">checked on its site</span>` : "",
      e.source === "pinned" && !e.checked ? `<span class="tag ink">check the site</span>` : "",
      e.sources.includes("email") ? `<span class="tag ink">from email</span>` : "",
    ].join("");
    return `<article class="card rcard" data-key="${ui.esc(e.key)}" data-kind="hack">
      <div class="tags">${tags}</div>
      <div class="title">${ui.esc(e.name)}</div>
      <dl class="facts">
        <div><dt>host</dt><dd>${e.host ? ui.esc(e.host) : '<i>not listed</i>'}</dd></div>
        <div><dt>date</dt><dd>${ui.esc(rangeText(e))}${e.location ? ` · ${ui.esc(e.location)}` : ""}</dd></div>
        <div><dt>distance</dt><dd>${e.distance != null ? `about ${e.distance} mi from NJIT` : "<i>unknown</i>"}</dd></div>
        <div><dt>register by</dt><dd>${e.deadline ? ui.esc(rangeText({ start: e.deadline })) : e.deadline_text ? ui.esc(e.deadline_text) : "<i>not listed</i>"}</dd></div>
        <div><dt>travel</dt><dd>${e.travel ? ui.esc(e.travel) : "<i>not listed</i>"}</dd></div>
      </dl>
      <div class="actions">
        ${e.url ? `<a class="btn" href="${ui.esc(ui.safeUrl(e.url))}" target="_blank" rel="noopener">event ↗</a>` : ""}
        ${mailLink ? `<a class="btn ghost" href="${ui.esc(mailLink)}" ${e.mail.link ? 'target="_blank" rel="noopener"' : ""}>source email ↗</a>` : e.source_url ? `<a class="btn ghost" href="${ui.esc(ui.safeUrl(e.source_url))}" target="_blank" rel="noopener">listing ↗</a>` : ""}
        ${stateSelect(e.key, `s-h${i}`)}
      </div>
    </article>`;
  };
  const certCard = (c, i) => `<article class="card rcard" data-key="${ui.esc(c.key)}" data-kind="cert">
      <div class="tags">${c.free ? '<span class="tag green">free</span>' : ""}${roleLabels(c.roles).map((r) => `<span class="tag accent">${ui.esc(r)}</span>`).join("")}</div>
      <div class="title">${ui.esc(c.name)}</div>
      <dl class="facts">
        <div><dt>provider</dt><dd>${ui.esc(c.provider)}</dd></div>
        <div><dt>cost</dt><dd>${c.cost ? ui.esc(c.cost) : `<i>check ${ui.esc(c.provider)}</i>`}${c.student ? ` · ${ui.esc(c.student)}` : ""}</dd></div>
        <div><dt>hours</dt><dd>${c.hours ? ui.esc(c.hours) : "<i>not stated by the provider</i>"}</dd></div>
      </dl>
      <p class="why">${ui.esc(c.why)}</p>
      <p class="meta">${c.checked_at ? `checked on the provider's page ${ago(c.checked_at)}` : "price not verified yet"}</p>
      <div class="actions"><a class="btn" href="${ui.esc(ui.safeUrl(c.url))}" target="_blank" rel="noopener">${ui.esc(c.provider)} ↗</a>${stateSelect(c.key, `s-c${i}`)}</div>
    </article>`;

  const done = Object.entries(state).filter(([, r]) => r.state === "Done").sort((a, b) => (b[1].done_at || "").localeCompare(a[1].done_at || ""));
  const additions = `<section class="card additions" id="additions" aria-labelledby="add-h">
      <div class="row"><h2 id="add-h">Resume additions <span class="count">${done.length}</span></h2>${done.length ? '<button class="btn" data-r="copyall">copy all</button>' : ""}</div>
      ${done.length ? `<ul class="lines">${done.map(([key, r], i) => `<li data-key="${ui.esc(key)}"><textarea id="ln-${i}" rows="2" aria-label="resume line for ${ui.esc(r.title)}">${ui.esc(r.line || "")}</textarea><button class="btn ghost" data-r="copy" data-src="ln-${i}">copy</button></li>`).join("")}</ul>`
        : '<p class="note">mark a hackathon or certification Done and its ready-to-paste resume line shows up here.</p>'}
    </section>`;

  const srcs = (hack.sources || []).map((s) => `${ui.esc(s.name)}: ${ui.esc(s.note)}`).join(" · ");
  const hackBody = `
    <div class="chips" role="group" aria-label="filter">
      <a class="chipbtn${chip === "nearby" ? " on" : ""}" href="/resume?tab=hacks&chip=nearby" aria-pressed="${chip === "nearby"}">Nearby <small>${counts.nearby}</small></a>
      <a class="chipbtn${chip === "mine" ? " on" : ""}" href="/resume?tab=hacks&chip=mine" aria-pressed="${chip === "mine"}">My school <small>${counts.mine}</small></a>
      <label class="radius">within <input id="radius" type="number" min="5" max="500" step="5" value="${radius}" inputmode="numeric" aria-label="radius in miles"> mi of Newark</label>
    </div>
    <p class="note">soonest registration deadline first. a deadline within 7 days is flagged. in-person events only. blank means the source didn't say. updated ${ago(hack.generated_at)}.</p>
    ${events.map(hackCard).join("") || `<div class="emptybox"><p>no ${chip === "mine" ? "NJIT" : `in-person hackathons within ${radius} miles`} listed right now. the feed refreshes daily, and forwarded emails show up as they arrive.</p></div>`}
    <details class="srcs"><summary>where these come from</summary><p class="note">${srcs || "no feed yet"}. every source was checked against its robots.txt and terms; the record is docs/resume-feed.md.</p></details>`;
  const certBody = `<p class="note">free first, then by price. cost and hours come from each provider's own page; where a page didn't say, the card says to check. ${certs.generated_at ? `updated ${ago(certs.generated_at)}.` : "no feed yet."}</p>
    ${(certs.items || []).map(certCard).join("") || '<div class="emptybox"><p>no certifications loaded yet. the weekly feed fills this in.</p></div>'}`;

  const body = `${additions}
    <nav class="rtabs" role="tablist" aria-label="resume ideas">
      <a role="tab" class="${tab === "hacks" ? "on" : ""}" aria-selected="${tab === "hacks"}" href="/resume?tab=hacks">Hackathons</a>
      <a role="tab" class="${tab === "certs" ? "on" : ""}" aria-selected="${tab === "certs"}" href="/resume?tab=certs">Certifications</a>
    </nav>
    ${tab === "hacks" ? hackBody : certBody}`;
  return ui.page(body, { title: "Resume", page: "resume", lead: "let's add to", head: "your resume", css: RESUME_CSS, script: RESUME_JS });
}

export async function mailPage(env, ui, id) {
  const mail = await get(env, "resume:mail", {});
  const m = mail[id];
  if (!m) return new Response("not found", { status: 404 });
  const body = `<article class="card"><div class="tags"><span class="tag ink">email</span></div>
    <div class="title">${ui.esc(m.subject)}</div><p class="meta">from ${ui.esc(m.from)} · ${ui.esc(m.date)}</p>
    <pre class="mailtext">${ui.esc(m.text)}</pre>
    <div class="actions"><a class="btn" href="/resume">back to resume</a>${m.link ? `<a class="btn ghost" href="${ui.esc(ui.safeUrl(m.link))}" target="_blank" rel="noopener">open in Gmail ↗</a>` : ""}</div></article>`;
  return ui.page(body, { title: "Email", page: "resume", lead: "from your", head: "inbox", css: RESUME_CSS });
}

const RESUME_CSS = `
body[data-page="resume"] main>:not(.rcard):not(h1){grid-column:1/-1}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.additions{margin-bottom:18px} .additions h2{margin:0;font-size:20px} .additions .count{font:700 12px var(--font);background:var(--accent);border:2px solid var(--ink);border-radius:var(--radius-tag);padding:2px 8px;vertical-align:3px}
.additions .row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}
.lines{list-style:none;margin:0;padding:0;display:grid;gap:10px} .lines li{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start}
.lines textarea{font:500 15px/1.35 var(--font);color:var(--ink);background:#fff;border:var(--line) solid var(--ink);border-radius:12px;padding:10px 12px;width:100%;resize:vertical}
.rtabs{display:flex;gap:8px;margin:6px 0 14px} .rtabs a{flex:1;text-align:center;font:700 15px var(--font);color:var(--ink);background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius-pill);padding:11px 8px;text-decoration:none;box-shadow:var(--shadow-sm)} .rtabs a.on{background:var(--accent)}
.chips{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.chipbtn{font:700 14px var(--font);color:var(--ink);background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius-pill);padding:7px 14px;text-decoration:none} .chipbtn.on{background:var(--accent)} .chipbtn small{opacity:.7;margin-left:4px}
.radius{font:600 14px var(--font);display:inline-flex;gap:6px;align-items:center} .radius input{width:72px;font:700 15px var(--font);border:var(--line) solid var(--ink);border-radius:10px;padding:6px 8px;background:#fff;color:var(--ink)}
.rcard .facts{margin:8px 0 10px;display:grid;gap:4px} .rcard .facts div{display:grid;grid-template-columns:88px 1fr;gap:8px;font-size:var(--small)} .rcard dt{font-weight:700;text-transform:lowercase;opacity:.75} .rcard dd{margin:0} .rcard .why{margin:4px 0}
.rcard .actions{align-items:center} .rcard select{font:700 14px var(--font);color:var(--ink);background:var(--cream);border:var(--line) solid var(--ink);border-radius:12px;padding:9px 10px}
.srcs{margin:14px 0} .mailtext{white-space:pre-wrap;word-break:break-word;font:500 14px/1.45 var(--font);background:#fff;border:var(--line) solid var(--ink);border-radius:12px;padding:12px}
@media (min-width:900px){ .lines li{grid-template-columns:1fr auto} }
`;

const RESUME_JS = `(function(){
function post(u,b){return fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()})}
document.addEventListener("change",async function(e){
 var s=e.target.closest('select[data-r="state"]');
 if(s){var card=s.closest(".rcard"),body={key:card.dataset.key,state:s.value};
  if(s.value==="Done"&&card.dataset.kind==="hack"){var p=prompt("What did you build? (leave blank if you don't want a project in the line)");if(p===null){location.reload();return}body.project=p}
  try{await post("/api/resume-status",body);location.hash="additions";location.reload()}catch(x){s.style.outline="3px solid red"}return}
 if(e.target.id==="radius"){try{await post("/api/resume-settings",{radius:+e.target.value});location.reload()}catch(x){e.target.style.outline="3px solid red"}}
});
document.addEventListener("focusout",async function(e){var t=e.target.closest(".lines textarea");if(!t)return;var li=t.closest("li");try{await post("/api/resume-line",{key:li.dataset.key,line:t.value})}catch(x){}});
document.addEventListener("click",function(e){
 var b=e.target.closest("button[data-r]");if(!b)return;var c=b.dataset.r;
 var text=c==="copy"?document.getElementById(b.dataset.src).value:c==="copyall"?[].map.call(document.querySelectorAll(".lines textarea"),function(t){return t.value}).join("\\n"):null;
 if(text===null)return;var o=b.textContent;(navigator.clipboard?navigator.clipboard.writeText(text):Promise.reject()).then(function(){b.textContent="copied";setTimeout(function(){b.textContent=o},1400)},function(){var t=document.getElementById(b.dataset.src)||document.querySelector(".lines textarea");if(t){t.select()}});
});
})();`;
