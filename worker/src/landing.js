/* The public landing page (/hello, and / for anyone not signed in). It says why Scout exists, then how it works.
 *
 * Every number and every notification on it is real: they come from the last cron run in KV (landingData in
 * index.js). No made-up user counts. If KV has no run yet, the numbers are left out and the phone stays empty.
 *
 * The panda changes pose with what's happening: it waves when the page opens, celebrates when a notification
 * lands on the phone, gives a thumbs up when you point at the sign-up button, and naps if you leave the page
 * alone for 30 seconds. With reduced motion on, nothing slides. The panda shows up only where it has a job:
 * the hero, the sad panda in october, and the thumbs up on the "you always click submit" card.
 */

const fmt = (n) => Number(n || 0).toLocaleString("en-US");

export function landingBody(ui, signedIn, data) {
  const { posts = [], checked = 0, open = 0, ruled = 0, updated = "" } = data || {};
  const cta = signedIn
    ? '<a class="btn accent big" href="/">open scout</a>'
    : '<a class="btn accent big" href="/signup" data-pose="thumbs">get scout. it\'s free.</a>';
  const first = posts[0];
  const note = (p) => `
      <div class="push" role="status">
        <div class="push-top"><span class="push-app"><svg viewBox="0 0 62 62" aria-hidden="true"><circle cx="31" cy="31" r="26.5" fill="#ffc93c" stroke="#1a1333" stroke-width="9"/><circle cx="31" cy="31" r="11" fill="#f6f9dc" stroke="#1a1333" stroke-width="6"/><circle cx="31" cy="31" r="4" fill="#1a1333"/></svg>scout</span><span>now</span></div>
        <b class="push-title">${ui.esc(p.company)}: ${ui.esc(p.title)}</b>
        <span class="push-body">${ui.esc(p.where)} · scores ${p.score} · you can apply</span>
      </div>`;
  const stats = checked ? `
  <dl class="stats" aria-label="scout's last run${updated ? `, ${ui.esc(updated)}` : ""}">
    <div><dt>listings checked</dt><dd>${fmt(checked)}</dd></div>
    <div><dt>skipped as a bad fit</dt><dd>${fmt(ruled)}</dd></div>
    <div><dt>actually worth a look</dt><dd>${fmt(open)}</dd></div>
  </dl>${updated ? `<p class="stats-note">from scout's last hourly run, ${ui.esc(updated)}.</p>` : ""}` : "";
  return `
  <section class="hero">
    <div class="hero-copy">
      <h1 class="hero-h1"><span class="lead">the good internships close in days.</span><span class="hl">scout finds them <mark>first.</mark></span></h1>
      <p class="hero-sub">for college students in tech, freshman year and up: scout checks the big internship lists every hour, skips the ones you can't apply to, and pings your phone when a good one drops.</p>
      <div class="hero-cta">${cta}</div>
    </div>
    <div class="hero-art">
      <div class="phone" aria-label="a phone getting a Scout notification">
        <div class="phone-screen">
          <div class="lock-time" id="lock-time">9:41</div>
          <div class="lock-date" id="lock-date">monday</div>
          <div class="push-slot" id="push-slot" data-posts="${ui.esc(JSON.stringify(posts.slice(0, 8)))}">${first ? note(first) : ""}</div>
        </div>
      </div>
      ${ui.panda("wave", "hero-mascot")}
    </div>
  </section>
  ${stats}

  <section class="why" id="why">
    <h2 class="sec-h">why scout exists</h2>
    <ol class="timeline">
      <li class="card"><span class="when">august</span><p>big tech starts posting next summer's internships, almost a year before they start.</p></li>
      <li class="card"><span class="when">a few days later</span><p>the popular ones start closing.</p></li>
      <li class="card late"><span class="when">october</span><div class="late-row">${ui.panda("sad", "tl-panda")}<p>you hear about it from a friend who already applied.</p></div></li>
    </ol>
    <p class="why-copy">the lists that exist are huge, unranked, and full of postings you can't even apply to: wrong graduation year, grad students only, already closed. scout started as one NJIT freshman's fix for his own search. now anyone can use it.</p>
  </section>

  <section class="how">
    <h2 class="sec-h">how it works</h2>
    <ol class="how-list">
      <li><h3>it watches</h3><p>every hour, scout pulls the big public internship lists and the career pages of the companies you care about.</p></li>
      <li><h3>it reads the fine print</h3><p>it opens each posting and rules out what isn't for you, like "graduating in 2028" when you graduate in 2030, or "PhD students only".</p></li>
      <li><h3>it ranks and pings</h3><p>the rest get a score from your answers. a great one pings your phone within the hour, or they all wait for one digest. your call.</p></li>
      <li><h3>it helps you prep</h3><p>save a posting and scout writes a prompt for your own Claude Code (or Claude) to tailor your resume and answers. your resume never leaves your computer.</p></li>
    </ol>
  </section>

  <section class="promise card">
    ${ui.panda("thumbs", "promise-panda")}
    <div><h2>you always click submit.</h2><p>scout never applies for you, never logs into job sites, and never makes anything up about you.</p></div>
  </section>

  <section class="end">
    <h2 class="end-h">beat the october friend.</h2>
    <p>13 questions you have to answer, the rest you can skip.</p>
    ${cta}
    <p class="made">made by jeremiah sleman · <a href="/privacy">privacy</a> · <a href="https://github.com/jeremiah123-luma/scout" target="_blank" rel="noopener">see the code ↗</a></p>
  </section>`;
}

export const LANDING_CSS = `
body[data-page="landing"]{--page:var(--orange);padding-bottom:40px}
body[data-page="landing"] main,body[data-page="landing"] header{max-width:1120px}
body[data-page="landing"] main{display:block}
.hero{display:grid;gap:28px;align-items:center;padding:18px 0 34px}
.hero-h1{font-family:var(--display);text-transform:uppercase;line-height:.95;margin:0 0 18px;font-size:clamp(34px,8.6vw,72px);letter-spacing:0}
.hero-h1 .lead{display:block;color:var(--lead)} .hero-h1 .hl{display:block;color:var(--ink)}
.hero-h1 mark{color:var(--ink);background:linear-gradient(transparent 52%,var(--accent) 52%,var(--accent) 88%,transparent 88%);padding:0 .06em}
.hero-sub{font-size:clamp(17px,2.4vw,20px);font-weight:700;color:var(--on-page);max-width:44ch;margin:0 0 22px}
.hero-cta{display:flex;flex-wrap:wrap;align-items:center;gap:14px 20px}
.hero-art{position:relative;min-height:420px;display:flex;justify-content:center;align-items:flex-start}
.phone{position:relative;width:min(300px,78vw);aspect-ratio:9/17;background:var(--cream);border:5px solid var(--ink);border-radius:44px;box-shadow:10px 10px 0 var(--ink);padding:14px;transform:rotate(3deg)}
.phone::before{content:"";position:absolute;top:12px;left:50%;width:84px;height:24px;margin-left:-42px;background:var(--ink);border-radius:999px}
.phone-screen{height:100%;border-radius:32px;background:var(--purple);border:var(--line) solid var(--ink);padding:52px 12px 12px;display:flex;flex-direction:column;align-items:center;overflow:hidden}
.lock-time{font-family:var(--display);font-size:54px;line-height:1;color:var(--cream)}
.lock-date{font-weight:700;color:var(--cream);margin:4px 0 18px;white-space:nowrap;font-size:clamp(12px,3.4vw,16px)}
.push-slot{width:100%;display:grid}
.push{grid-area:1/1;background:var(--cream);border:var(--line) solid var(--ink);border-radius:18px;box-shadow:var(--shadow-sm);padding:10px 12px;display:grid;gap:3px;text-align:left}
.push.in{animation:pushIn .55s cubic-bezier(.3,1.5,.5,1) both} .push.out{animation:pushOut .35s ease both}
@keyframes pushIn{from{transform:translateY(-26px) scale(.96);opacity:0}to{transform:none;opacity:1}}
@keyframes pushOut{to{transform:translateY(14px) scale(.97);opacity:0}}
.push-top{display:flex;justify-content:space-between;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.push-app{display:inline-flex;align-items:center;gap:5px;color:var(--ink)} .push-app svg{width:14px;height:14px}
.push-title{font-size:14px;line-height:1.25} .push-body{font-size:12px;color:var(--muted);font-weight:700}
.hero-mascot{position:absolute;left:calc(50% - min(150px,39vw) - 46px);bottom:-6px;width:clamp(130px,30vw,190px);height:clamp(130px,30vw,190px);z-index:2}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow)}
.stats div{padding:16px 18px;display:flex;flex-direction:column-reverse;gap:4px} .stats div+div{border-left:var(--line) solid var(--ink)}
.stats dt{font-weight:700;font-size:var(--small);color:var(--muted)} .stats dd{margin:0;font-family:var(--display);font-size:clamp(26px,5vw,40px);line-height:1}
.stats-note{margin:10px 0 56px;font-size:var(--small);font-weight:700;color:var(--on-page)}
.how-list{list-style:none;margin:0;padding:0;counter-reset:how;display:grid;gap:14px}
.how-list li{counter-increment:how;background:var(--cream);border:var(--line) solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:16px 18px 16px 70px;position:relative}
.how-list li::before{content:counter(how);position:absolute;left:16px;top:15px;width:36px;height:36px;border-radius:50%;background:var(--cream);border:var(--line) solid var(--ink);font-family:var(--display);font-size:18px;display:grid;place-items:center}
.soon-note{margin:14px 0 0;font-weight:700;color:var(--on-page)}
.how-list h3{font-family:var(--display);text-transform:uppercase;font-size:20px;margin:0 0 4px} .how-list p{margin:0}
.sec-h{font-family:var(--display);text-transform:uppercase;font-size:clamp(28px,6vw,46px);line-height:1;color:var(--ink);margin:0 0 18px}
.sec-h::after,.promise h2::after,.end-h::after{display:none}
section.promise{margin-bottom:96px}
.why{margin-bottom:56px}
.timeline{list-style:none;margin:0 0 18px;padding:0;display:grid;gap:14px}
.timeline .card{margin:0;position:relative;padding-top:16px}
.when{display:inline-block;font-family:var(--display);text-transform:uppercase;font-size:20px;background:var(--ink);color:var(--cream);border-radius:10px;padding:5px 11px;margin-bottom:8px}
.late-row{display:flex;align-items:center;gap:12px} .late-row p{margin:0}
.tl-panda{flex:none;width:64px;height:64px}
.why-copy{font-size:clamp(17px,2.2vw,20px);font-weight:700;color:var(--on-page);max-width:58ch;margin:0}
.how{margin-bottom:56px}
.promise{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;align-items:center;margin:0 0 80px;position:relative}
.promise h2{font-family:var(--display);text-transform:uppercase;font-size:clamp(24px,5vw,36px);line-height:1;margin:0 0 6px;color:var(--ink)}
.promise p{margin:0;font-weight:700}
.promise-panda{width:110px;height:110px}
.end{display:grid;justify-items:start;gap:10px;padding:10px 0 20px}
.end-h{font-family:var(--display);text-transform:uppercase;font-size:clamp(34px,8vw,64px);line-height:.95;margin:0;color:var(--ink);text-wrap:balance}
.end p{margin:0;font-weight:700;color:var(--on-page)}
.end .made{margin-top:26px;font-size:var(--small)} .end .made a{color:var(--on-page)}
@media (min-width:900px){
  .hero{grid-template-columns:7fr 5fr;padding:28px 0 56px;align-items:start}
  .hero-copy{padding-top:0}
  .hero-art{min-height:0;padding:6px 0 20px}
  .phone{width:310px}
  .hero-mascot{left:-70px;bottom:0;width:190px;height:190px}
  .timeline{grid-template-columns:repeat(3,minmax(0,1fr))}
  .how-list{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
  .promise{padding:24px 28px}
}
@media (max-width:560px){
  .hero{padding-bottom:20px}
  .hero-art{min-height:0;padding:0 0 10px 40px}
  .phone{width:230px;transform:rotate(3deg)}
  .lock-time{font-size:42px}
  .hero-mascot{left:0;bottom:0;width:120px;height:120px}
  .promise{grid-template-columns:1fr} .promise-panda{width:90px;height:90px}
}
@media (max-width:560px){.stats{grid-template-columns:1fr} .stats div+div{border-left:0;border-top:var(--line) solid var(--ink)} .stats div{flex-direction:row-reverse;justify-content:space-between;align-items:baseline}}
@media (prefers-reduced-motion:reduce){.push.in,.push.out{animation:none}}
`;

// Cycles real postings through the phone, swaps the panda's pose, and keeps the lock screen clock honest.
export const LANDING_JS = `(function(){
var reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
var hero=document.querySelector(".hero-mascot");
function pose(name){if(!hero)return;var bg=hero.querySelector(".panda-bg"),fg=hero.querySelector(".panda-fg");if(!bg||!fg)return;bg.src="/panda/"+name+"-bg.png";fg.src="/panda/"+name+".png"}
var resting="wave",timer;
function flash(name,ms){pose(name);clearTimeout(timer);timer=setTimeout(function(){pose(resting)},ms)}
var now=new Date(),t=document.getElementById("lock-time"),d=document.getElementById("lock-date");
if(t)t.textContent=now.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}).replace(/\\s?[AP]M/,"");
if(d)d.textContent=now.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"}).toLowerCase();
document.querySelectorAll("[data-pose]").forEach(function(el){el.addEventListener("mouseenter",function(){flash(el.dataset.pose,1800)});el.addEventListener("focus",function(){flash(el.dataset.pose,1800)})});
var slot=document.getElementById("push-slot"),posts=[];try{posts=JSON.parse(slot.dataset.posts||"[]")}catch(e){}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}
var i=0;
function next(){if(posts.length<2||document.hidden)return;i=(i+1)%posts.length;var p=posts[i],old=slot.querySelector(".push");
var el=document.createElement("div");el.className="push in";el.setAttribute("role","status");
el.innerHTML=old.querySelector(".push-top").outerHTML+'<b class="push-title">'+esc(p.company)+": "+esc(p.title)+'</b><span class="push-body">'+esc(p.where)+" · scores "+esc(p.score)+" · you can apply</span>";
if(reduce){old.remove();slot.appendChild(el);return}
old.classList.add("out");setTimeout(function(){old.remove()},350);slot.appendChild(el);flash("celebrate",2600)}
setInterval(next,9000);
var idle;function wake(){if(resting==="nap"){resting="wave";pose("wave")}clearTimeout(idle);idle=setTimeout(function(){resting="nap";pose("nap")},30000)}
["mousemove","keydown","scroll","touchstart"].forEach(function(e){addEventListener(e,wake,{passive:true})});wake();
})();`;
