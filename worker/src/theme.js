/* The app's look: three themes (light, sky, dark), the art behind each, and the job card the New pages share.
 *
 * light  an orange-to-sky gradient, the sun rising out of the top-right corner
 * sky    dusty blue to pink, soft clouds drifting up as you scroll
 * dark   navy to deep teal, a lighthouse at the bottom of the page sweeping its beam (on a phone: no tower, just its stars, beam, glow, and rocks)
 *
 * The theme follows the clock where the student is (light from 7:00 AM to 6:59 PM, dark after), unless they pick one
 * with the button in the header; the pick is a per-browser convenience in localStorage. The choice is made by a
 * tiny script in <head>, before the page paints, so nothing flashes.
 *
 * The sun and lighthouse were modeled for Scout in Blender (worker/art/scene.py) and are served from /art/.
 * Cards are cream glass: a little see-through, with a soft blur behind them. Frames say why a posting matters:
 * a dream company (rainbow), a big hitter (purple), a freshman program or fellowship (orange).
 */

import SUN from "./art/sun.webp";
import LIGHTHOUSE from "./art/lighthouse.webp";

export const ART = { "/art/sun.webp": SUN, "/art/lighthouse.webp": LIGHTHOUSE };

// Pages that wear the themes: the app, plus the landing page, log in, sign up, and the questions.
export const THEMED = new Set(["new", "tracker", "you", "programs", "review", "resume", "settings", "about", "login", "signup", "landing", "start"]);

export const FONTS_LINK = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Patrick+Hand&family=Coming+Soon&display=swap" rel="stylesheet">';

// Runs in <head> before anything paints: the saved pick, or the clock.
export const THEME_HEAD = `<script>(function(){var t="auto";try{t=localStorage.getItem("scout-theme")||"auto"}catch(e){}
var q=new URLSearchParams(location.search).get("theme");if(q==="light"||q==="sky"||q==="dark")t=q;
var h=new Date().getHours(),th=t==="auto"?(h>=7&&h<19?"light":"dark"):t;document.documentElement.dataset.theme=th;document.documentElement.dataset.pick=t;
var m=document.querySelector('meta[name="theme-color"]');if(m)m.content={light:"#e2672f",sky:"#9fb6d6",dark:"#1a1333"}[th]})();</script>`;

// The header button: light, sky, dark, then back to following the clock.
export const THEME_BUTTON = '<button class="theme-btn" type="button" id="theme-btn" aria-label="change theme">◐ <span></span></button>';
export const THEME_JS = `(function(){var order=["auto","light","sky","dark"],b=document.getElementById("theme-btn");if(!b)return;var s=b.querySelector("span");
function show(){var p=document.documentElement.dataset.pick||"auto";s.textContent=p==="auto"?"auto":p}show();
b.addEventListener("click",function(){var p=document.documentElement.dataset.pick||"auto",n=order[(order.indexOf(p)+1)%order.length];try{localStorage.setItem("scout-theme",n)}catch(e){}
var h=new Date().getHours(),th=n==="auto"?(h>=7&&h<19?"light":"dark"):n;document.documentElement.dataset.pick=n;document.documentElement.dataset.theme=th;
var m=document.querySelector('meta[name="theme-color"]');if(m)m.content={light:"#e2672f",sky:"#9fb6d6",dark:"#1a1333"}[th];show()})})();
// the phone's view menu closes when you tap anywhere else
document.addEventListener("click",function(e){document.querySelectorAll(".viewmenu[open]").forEach(function(d){if(!d.contains(e.target))d.open=false})});
// Sky: the clouds drift up a little slower than the page, so they feel far away. Still for reduced motion.
(function(){var layer=document.querySelector(".sky-layer"),cs=[].slice.call(document.querySelectorAll(".cl"));if(!cs.length||matchMedia("(prefers-reduced-motion: reduce)").matches)return;
// only while the clouds are showing (the sky theme, or the landing page)
if(getComputedStyle(layer).display==="none"){var mo=new MutationObserver(function(){if(getComputedStyle(layer).display!=="none"){mo.disconnect();start()}});mo.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});return}start();function start(){
var queued=false;addEventListener("scroll",function(){if(queued)return;queued=true;requestAnimationFrame(function(){queued=false;var y=scrollY;cs.forEach(function(c){c.style.transform="translateY("+(-y*c.dataset.speed)+"px)"})})},{passive:true})}})();`;

// The art behind the page. Each theme shows only its own; a hidden layer's background image never loads.
const PUFFS = [[0, 40, 46], [18, 22, 58], [40, 8, 70], [62, 20, 56], [80, 38, 44], [28, 44, 52], [54, 46, 50]];
const CLOUDS = [[-14, 300, 340, 0.14, 1], [64, 40, 280, 0.24, 0.6], [72, 520, 380, 0.18, 1], [-10, 860, 300, 0.28, 0.6], [50, 1250, 360, 0.2, 1], [6, 1650, 300, 0.3, 0.6], [68, 2050, 340, 0.22, 1]];
const cloud = ([x, y, w, speed, op]) => `<div class="cl" data-speed="${speed}" style="left:${x}%;top:${y}px;width:${w}px;height:${Math.round(w * 0.45)}px;opacity:${op}"><b class="belly"></b>${PUFFS.map(([px, py, r]) => `<i style="left:${px}%;top:${py}%;width:${Math.round(r * w / 100)}px;height:${Math.round(r * w / 100)}px"></i>`).join("")}</div>`;
export const SCENE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="wisp" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="4" seed="9"/><feDisplacementMap in="SourceGraphic" scale="28"/><feGaussianBlur stdDeviation="3"/></filter></svg>
<div class="sky-layer" aria-hidden="true">${CLOUDS.map(cloud).join("")}</div>
<div class="scene" aria-hidden="true"><div class="sun"></div><div class="lh"><div class="beam"></div></div></div>
<div class="night" aria-hidden="true"><i class="stars"></i><i class="glow"></i><i class="sweep"></i><i class="tower"></i><i class="lamp"></i><svg class="rocks" viewBox="0 0 390 70" preserveAspectRatio="none"><path d="M0 70V54l18-9 14 4 22-14 20 10 12-3 18 12 30-6 16 8 40-4 24-16 18 6 14-10 26 12 22-4 16 9 28-8 20 10 22-6 10 3V70z"/><path class="sea" d="M0 62q24-6 48 0t48 0 48 0 48 0 48 0 48 0 48 0 48 0V70H0z"/></svg></div>`;

/* ---------------------------------------------------------------- the views */

// The New page's views: a row of pills on wider screens, and on a phone one button that opens a menu (a row of
// seven pills runs off an iPhone screen). Labels and counts come from the caller; labels are constants.
export function viewPicker(views, line) {
  const on = views.find((v) => v.on) || views[0];
  const link = (v) => `<a href="/?view=${v.id}#list"${v.on ? ' class="on" aria-current="page"' : ""}>${v.label}<small>${v.count.toLocaleString("en-US")}</small></a>`;
  return `<nav class="views" aria-label="views">${views.map(link).join("")}</nav>
    <details class="viewmenu"><summary aria-label="change view">${on.label}<small>${on.count.toLocaleString("en-US")}</small><span class="chev" aria-hidden="true">▾</span></summary><div class="viewmenu-list">${views.map(link).join("")}</div></details>
    <p class="view-line" aria-live="polite">${line}</p>`;
}

/* ---------------------------------------------------------------- the job card */

// Each company's name in its own type. Most brand fonts are private (Meta's Optimistic, Figma Sans, Anthropic's
// Styrene), so these are the closest free fonts; IBM and Red Hat publish theirs. Anyone else gets the card font.
const CO_FONTS = {
  anthropic: ["Space Grotesk", 600], figma: ["Inter", 600], linkedin: ["Source Sans 3", 700], meta: ["Figtree", 700],
  datadog: ["Open Sans", 700], google: ["Outfit", 600], apple: ["Inter", 600], microsoft: ["Open Sans", 600],
  amazon: ["Nunito Sans", 800], netflix: ["Bebas Neue", 400, ".04em"], nvidia: ["Barlow", 700], ibm: ["IBM Plex Sans", 600],
  "red hat": ["Red Hat Display", 700], spotify: ["Figtree", 700], adobe: ["Source Sans 3", 700], airbnb: ["Nunito Sans", 800],
  uber: ["Inter", 700], salesforce: ["Open Sans", 700], pinterest: ["Nunito Sans", 800], duolingo: ["Nunito", 900],
  notion: ["Inter", 600], canva: ["Outfit", 600], snap: ["Montserrat", 800], bloomberg: ["IBM Plex Sans", 600],
  oracle: ["Barlow", 600], tiktok: ["Montserrat", 700], bytedance: ["Montserrat", 700], stripe: ["Inter", 700],
  "lowe's": ["Archivo", 800], hearst: ["Playfair Display", 700], verkada: ["Manrope", 700], palantir: ["Space Grotesk", 600],
  databricks: ["Montserrat", 700], coinbase: ["Inter", 700], openai: ["Inter", 600], doordash: ["Montserrat", 700],
};
const FAMILIES = [...new Set(Object.values(CO_FONTS).map(([f, w]) => `family=${f.replace(/ /g, "+")}:wght@${w}`))];
export const CO_FONTS_LINK = `<link href="https://fonts.googleapis.com/css2?${FAMILIES.join("&")}&display=swap" rel="stylesheet" media="print" onload="this.media='all'">`;
const coKey = (name) => String(name || "").toLowerCase().replace(/[,.]?\s+(inc|llc|ltd|corp|corporation|co|company|plc)\.?$/, "").trim();
export function coFont(name) {
  const f = CO_FONTS[coKey(name)];
  return f ? ` style="font-family:'${f[0]}',var(--round);font-weight:${f[1]}${f[2] ? `;letter-spacing:${f[2]}` : ""}"` : "";
}

// One card for both New pages. Everything passed in is already escaped by the caller.
// frame: "legendary" | "epic" | "rare" | ""; label: the frame's words ("dream company"); fresh: the tape.
export function jobCard({ key, cls = "", frame = "", label = "", fresh = false, logo, company, coStyle = "", title, url, meta, tags = "", acts, score, scoreTitle }) {
  return `
    <article class="card jc${frame ? " " + frame : ""}${cls ? " " + cls : ""}" data-key="${key}">
      ${fresh ? '<span class="tape"><b>fresh<em>!</em></b></span>' : ""}
      <div class="jc-row">
        ${logo}
        <div class="jc-body">
          <h3 class="jc-co"${coStyle}>${company}</h3>
          <div class="title jc-title"><a href="${url}" target="_blank" rel="noopener">${title}</a></div>
          <div class="meta jc-meta">${meta}</div>
          <div class="jc-tags">${label ? `<span class="why-tag ${frame}">${label}</span>` : ""}${tags}</div>
        </div>
        <div class="jc-acts">${acts}</div>
        <details class="jc-score score"><summary aria-label="score ${score} out of 100. why?"><b>${score}</b></summary><div class="why-pop" role="note">${scoreTitle}</div></details>
      </div>
    </article>`;
}

/* ---------------------------------------------------------------- styles */

export const THEME_CSS = `
:root{--round:"Fredoka","Rubik",system-ui,sans-serif;--hand:"Patrick Hand","Comic Sans MS",cursive;--tapefont:"Coming Soon","Patrick Hand",cursive}
html[data-theme="light"]{--g0:#e2672f;--g1:#f08c4c;--g2:#f6a99a;--g3:#c9a7e8;--g4:#9fcaf0;--tx:#1a1333;--name:#1a1333;--handc:#f6f9dc;--hand-shadow:2px 2px 0 #1a1333;--pill:#1a13331f;--pill-edge:#1a133333;--card:rgba(248,250,223,.9);--edge:#1a1333;--cshadow:inset 0 1px 0 rgba(255,255,255,.8),4px 4px 0 #1a1333;--chip-on:#f6f9dc;--sbg:#f6f9dc;--sfg:#1a1333}
html[data-theme="dark"]{--g0:#1a1333;--g1:#2a1652;--g2:#3a1a5c;--g3:#14305a;--g4:#0e3a44;--tx:#f6f9dc;--name:#f6f9dc;--handc:#ffc93c;--hand-shadow:none;--pill:#f6f9dc22;--pill-edge:#f6f9dc40;--card:rgba(246,249,220,.95);--edge:transparent;--cshadow:inset 0 1px 0 rgba(255,255,255,.9),0 8px 24px rgba(0,0,0,.35);--chip-on:#1a1333;--sbg:#1a1333;--sfg:#f6f9dc}
html[data-theme="sky"]{--g0:#9fb6d6;--g1:#a9bfdc;--g2:#b8c6e6;--g3:#cbbfe4;--g4:#e9d6e0;--tx:#1d3d6e;--name:#1d4f9a;--handc:#fdf3cf;--hand-shadow:2px 0 0 #1d3d6e,-2px 0 0 #1d3d6e,0 2px 0 #1d3d6e,0 -2px 0 #1d3d6e,0 0 12px #1d3d6e66;--pill:#ffffff66;--pill-edge:#1d3d6e22;--card:rgba(253,249,234,.8);--edge:#1d3d6e33;--cshadow:inset 0 1px 0 rgba(255,255,255,.9),0 8px 24px rgba(29,61,110,.18);--chip-on:#fdf3cf;--sbg:#e3ecf8;--sfg:#1d3d6e}
body.themed{--on-page:var(--tx);--lead:var(--handc);color:var(--tx);background:linear-gradient(180deg,var(--g0) 0%,var(--g1) 22%,var(--g2) 48%,var(--g3) 74%,var(--g4) 100%);background-color:var(--g0);min-height:100vh;position:relative;display:flex;flex-direction:column;padding-bottom:40px;overflow-x:clip}
body.themed::before{display:none}
html:has(body.themed){background:var(--g0)}
body.themed main,body.themed header,body.themed .dock{position:relative;z-index:1}
/* header: logo on the left; the nav, then the theme button, on the right */
body.themed header{order:0;width:100%;flex-wrap:wrap;gap:8px 16px}
body.themed .brand{color:var(--tx)}
body.themed .brand .o circle:first-child{stroke:var(--tx)}
body.themed .dock{order:1;position:static;background:none;border:0;padding:0;margin:4px auto 0;width:100%;max-width:1120px;display:flex;gap:4px;justify-content:flex-start;flex-wrap:wrap}
body.themed .dock a{flex:none;min-width:0;max-width:none;font:600 17px var(--round);color:var(--tx);background:none;border:0;box-shadow:none;padding:7px 14px;border-radius:12px;animation:none}
body.themed .dock a.on{background:var(--pill);box-shadow:inset 0 0 0 1.5px var(--pill-edge)}
body.themed .dock a:hover{transform:none;box-shadow:inset 0 0 0 1.5px var(--pill-edge)}
body.themed .dock .count{background:var(--tx);color:var(--chip-on)}
body.themed main{order:2;width:100%}
body.themed .pill-link,.theme-btn{font:600 14px var(--round);color:var(--tx);background:var(--pill);border:1.5px solid var(--pill-edge);border-radius:12px;padding:7px 12px;box-shadow:none;cursor:pointer;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
body.themed .pill-link:hover,.theme-btn:hover{transform:none;box-shadow:none}
/* the greeting: handwritten first line, the name big */
body.themed h1{margin:22px 0 6px}
body.themed h1 .lead{font:clamp(34px,8vw,48px)/1 var(--hand);text-transform:none;color:var(--handc);text-shadow:var(--hand-shadow);transform:rotate(-3deg);transform-origin:left;margin-bottom:-2px;white-space:nowrap}
body.themed h1 .head{color:var(--name);padding-bottom:0;font-size:clamp(52px,14vw,96px);line-height:.9}
body.themed h1 .head::after{display:none}
html[data-theme="sky"] body.themed h1 .head{font-family:var(--round);font-weight:700;text-transform:none;letter-spacing:-.02em}
html[data-theme="dark"] body.themed h1 .head{color:var(--name)}
body.themed .hero-panda,body.themed .stat-panda{display:none}
body.themed h2{font-family:var(--round);font-weight:700;text-transform:none;font-size:22px;color:var(--tx)}
body.themed h2::after{display:none}
body.themed .note,body.themed .goal{color:var(--tx)}
body.themed .card .note,body.themed .card .goal,body.themed .sheet .note,body.themed .emptybox .note,body.themed .stat .note{color:#5b5673}
.sub{font:600 18px var(--round);margin:12px 0 16px;color:var(--tx)} .sub b{color:var(--hl,var(--tx))}
html[data-theme="dark"] .sub b{color:#ffc93c} html[data-theme="sky"] .sub b{color:#1d4f9a}
/* view pills */
.views{grid-column:1/-1;display:flex;gap:8px;overflow-x:auto;margin:0 -16px 18px;padding:2px 16px 6px;scrollbar-width:none} .views::-webkit-scrollbar{display:none}
.views a{white-space:nowrap;border:2px solid var(--tx);border-radius:99px;padding:7px 14px;font:600 15px var(--round);color:var(--tx);text-decoration:none;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.views a.on{background:var(--tx);color:var(--chip-on)} .views a small{opacity:.7;font-size:12px;margin-left:4px}
.view-line{grid-column:1/-1;margin:-8px 0 16px;font:500 14px var(--round);color:var(--tx);opacity:.85}
/* glass cards everywhere on the themed pages */
body.themed .card,body.themed .stat,body.themed .sheet,body.themed .emptybox,body.themed .welcome,body.themed .removed,body.themed pre{background:var(--card);border:2px solid var(--edge);border-radius:20px;box-shadow:var(--cshadow);-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);color:#1a1333}
body.themed .card:hover{transform:none}
html[data-theme="sky"] body.themed .card,html[data-theme="sky"] body.themed .stats{-webkit-backdrop-filter:none;backdrop-filter:none}
html[data-theme="sky"]{--card:rgba(253,249,234,.9)}
/* touch screens: every control is at least 44px tall */
@media (pointer:coarse){body.themed .dock a,.views a,.theme-btn,body.themed .pill-link,.jc-acts .btn,.jc-acts .link{min-height:44px;display:inline-flex;align-items:center;justify-content:center}.jc-acts .link{padding:0 10px}}
/* boxes that aren't .card but are cream too: their text stays navy in every theme */
body.themed .ans,body.themed .stat,body.themed .tile,body.themed .account,body.themed .alerts,body.themed .auth,body.themed .login{color:#1a1333}
body.themed .ans{background:var(--card);border:2px solid var(--edge);border-radius:18px;box-shadow:var(--cshadow)}
body.themed .you-line{margin-top:16px}
/* landing: the poster headline keeps its look, colored for the theme; the cream boxes keep navy text */
body.themed .hero-h1 .lead{font:clamp(26px,5.6vw,44px)/1.1 var(--hand);text-transform:none;color:var(--handc);text-shadow:var(--hand-shadow);white-space:normal;transform:rotate(-2deg);transform-origin:left;margin-bottom:4px}
body.themed .hero-h1 .hl{color:var(--name)} body.themed .hero-h1 mark{color:#1a1333}
html[data-theme="sky"] body.themed .hero-h1 .hl{font-family:var(--round);font-weight:700;text-transform:none}
body.themed .stats,body.themed .stats dd,body.themed .card,body.themed .phone{color:#1a1333}
body.themed .stats{background:var(--card);border:2px solid var(--edge);border-radius:20px;box-shadow:var(--cshadow);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
body.themed .stats div+div{border-left-color:#1a133333}
/* log in and sign up: the headline sits beside the form, so it stays a size that fits its column */
body.themed[data-page="login"] h1 .head,body.themed[data-page="signup"] h1 .head{font-size:clamp(40px,6vw,68px)}
body.themed .card h3,body.themed .stat-label{font-family:var(--round);font-weight:700;text-transform:none}
body.themed .btn{font-family:var(--round);font-weight:600}
/* ---- the job card ---- */
.jc{position:relative;overflow:visible;padding:16px 18px!important;margin:0 0 16px}
.jc-row{display:grid;grid-template-columns:46px minmax(0,1fr) auto auto;gap:12px;align-items:center}
.jc-row>.logo{align-self:start;width:46px;height:46px;border-radius:12px;border-width:1.5px;box-shadow:none}
.jc-body{align-self:start;min-width:0}
.jc-co{font:600 17px var(--round);color:#1a1333cc;margin:0;text-transform:none}
.jc-title{margin:1px 0 4px;font:600 19px/1.2 var(--round)} .jc-title a{color:#1a1333;text-decoration:none} .jc-title a:hover{text-decoration:underline}
.jc-meta{font:500 13px var(--font);color:#5b5673}
.jc-tags{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
.jc-tags>span{font:600 12px var(--round);border-radius:8px;padding:3px 9px;background:#1a133312;color:#1a1333}
.jc-tags .red{background:#e04b3a;color:#fff}
.why-tag{border:1.5px solid #1a1333}
.why-tag.legendary{background:linear-gradient(90deg,#ff9bd6,#8fd8ff,#bfff9e)!important}
.why-tag.epic{background:linear-gradient(#8a35e8,#6a1fc9)!important;color:#fff!important}
.why-tag.rare{background:linear-gradient(#ffc56a,#f08a2f)!important;color:#1a1333!important}
.jc-acts{display:grid;gap:4px;justify-items:center;align-content:center;height:68px}
.jc-acts .btn{padding:6px 16px;font-size:15px;box-shadow:2px 2px 0 #1a1333;border-width:2px}
.jc-acts .btn.accent{background:#ffc93c}
.jc-acts .link{background:none;border:0;box-shadow:none;padding:2px;font:500 13px var(--round);color:#5b5673;text-decoration:underline;cursor:pointer}
.jc-score b{display:grid;place-items:center;width:68px;height:68px;border-radius:18px;font:400 40px/1 var(--hand);background:var(--sbg);color:var(--sfg);border:2px solid #1a1333}
.jc-score{background:none!important;padding:0!important;animation:none!important;position:relative}
.jc-score summary{list-style:none;cursor:pointer;border-radius:18px}.jc-score summary::-webkit-details-marker{display:none}
.jc-score summary:focus-visible{outline:3px solid #ffc93c;outline-offset:2px}
.why-pop{position:absolute;right:0;top:calc(100% + 8px);z-index:5;width:max-content;max-width:240px;background:#1a1333;color:#f6f9dc;font:500 13px/1.4 var(--font);padding:8px 12px;border-radius:12px;box-shadow:0 8px 20px rgba(0,0,0,.3)}
.card.jc.dim>.jc-row{opacity:1}.jc.dim .jc-row>:not(.jc-acts){opacity:.35}
.jc.is-out{opacity:.8}
@media (max-width:600px){.jc-row{grid-template-columns:46px minmax(0,1fr) auto}.jc-acts{grid-column:2;grid-row:2;display:flex;gap:14px;align-items:center;height:auto;margin-top:2px}.jc-score{grid-column:3;grid-row:1/span 2;align-self:end}.jc-score b{width:60px;height:60px;font-size:36px}}
@media (min-width:900px){body.themed[data-page="new"] main{grid-template-columns:repeat(2,minmax(0,1fr))!important;column-gap:16px}}
/* frames: a ring in the frame's colors around the cream glass; still until you point at the card, then it plays */
.jc.legendary,.jc.epic,.jc.rare{border-color:transparent!important}
.jc.legendary::after,.jc.epic::after,.jc.rare::after{content:"";position:absolute;inset:-3px;border-radius:22px;padding:3px;pointer-events:none;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}
@property --a{syntax:"<angle>";initial-value:0deg;inherits:true}
@property --p{syntax:"<percentage>";initial-value:-20%;inherits:true}
.jc.legendary::after{background:conic-gradient(from var(--a),#ffe36e,#ff8bd1 22%,#fff 27%,#ff8bd1 32%,#8fe3ff 55%,#b9ff9e 80%,#ffe36e)}
.jc.epic::after{background:linear-gradient(100deg,#7a2bd9,#a13bf0 calc(var(--p) - 12%),#d9a6ff var(--p),#a13bf0 calc(var(--p) + 12%),#7a2bd9)}
.jc.rare::after{background:linear-gradient(100deg,#e0701f,#f0812f calc(var(--p) - 12%),#fff3d6 var(--p),#f0812f calc(var(--p) + 12%),#e0701f)}
html[data-theme="light"] .jc.legendary{box-shadow:inset 0 1px 0 #fffc,0 0 0 2px #1a1333,0 10px 28px #ff8bd166!important}
html[data-theme="light"] .jc.epic{box-shadow:inset 0 1px 0 #fffc,0 0 0 2px #1a1333,0 8px 22px #a13bf055!important}
html[data-theme="light"] .jc.rare{box-shadow:inset 0 1px 0 #fffc,0 0 0 2px #1a1333,0 6px 18px #f0812f44!important}
html:not([data-theme="light"]) .jc.legendary{box-shadow:inset 0 1px 0 #fffc,0 10px 30px #ff8bd177,0 0 22px #8fe3ff44!important}
html:not([data-theme="light"]) .jc.epic{box-shadow:inset 0 1px 0 #fffc,0 8px 26px #a13bf077!important}
html:not([data-theme="light"]) .jc.rare{box-shadow:inset 0 1px 0 #fffc,0 8px 22px #f0812f55!important}
.legendary .jc-score b{background:conic-gradient(from 200deg,#ffe36e,#ff8bd1,#8fe3ff,#b9ff9e,#ffe36e);color:#1a1333}
.epic .jc-score b{background:linear-gradient(#8a35e8,#6a1fc9);color:#fff}
.rare .jc-score b{background:linear-gradient(#ffc56a,#f08a2f);color:#1a1333}
@keyframes turn{to{--a:360deg}}@keyframes glint{0%{--p:-20%}60%,100%{--p:120%}}
@media (prefers-reduced-motion:no-preference){
  .jc.legendary{animation:turn 6s linear infinite paused}.jc.epic,.jc.rare{animation:glint 2.4s ease-in-out infinite paused}
  .jc:hover,.jc:focus-within{animation-play-state:running}
  .jc{transition:transform .25s cubic-bezier(.3,1.4,.5,1)}.jc:hover{transform:translateY(-3px)!important}}
/* "fresh!": a strip of tape over the top-right corner; every strip gives one shake when the page opens */
.tape{position:absolute;top:-9px;right:-16px;z-index:3;width:68px;padding:2px 0 3px;text-align:center;transform:rotate(18deg);--r:18deg;background:rgba(255,240,150,.72);
  background-image:repeating-linear-gradient(100deg,rgba(255,255,255,0) 0 3px,rgba(255,255,255,.22) 3px 4px),linear-gradient(180deg,rgba(255,255,255,.35),rgba(255,255,255,0) 55%);
  clip-path:polygon(0 8%,6% 0,12% 10%,18% 2%,24% 8%,30% 0,70% 0,76% 9%,82% 1%,88% 8%,94% 0,100% 8%,100% 92%,94% 100%,88% 91%,82% 99%,76% 92%,70% 100%,30% 100%,24% 92%,18% 99%,12% 90%,6% 100%,0 92%);
  filter:drop-shadow(0 1px 1px rgba(26,19,51,.25))}
.tape b{font:700 12px var(--tapefont);color:#1a1333;-webkit-text-stroke:.35px #1a1333;letter-spacing:.02em}.tape em{font:700 .95em var(--round);font-style:normal;-webkit-text-stroke:0}
@keyframes shake{0%,100%{transform:rotate(var(--r))}15%{transform:rotate(calc(var(--r) - 12deg)) scale(1.15)}30%{transform:rotate(calc(var(--r) + 9deg)) scale(1.15)}45%{transform:rotate(calc(var(--r) - 6deg))}60%{transform:rotate(calc(var(--r) + 4deg))}75%{transform:rotate(calc(var(--r) - 2deg))}}
@media (prefers-reduced-motion:no-preference){.tape{animation:shake .9s .5s cubic-bezier(.3,1.5,.5,1) both}}
/* ---- the art behind the page ---- */
.scene{position:absolute;inset:0;pointer-events:none;z-index:0;overflow:hidden}
.sky-layer{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;display:none}
.sun,.lh{display:none}
/* the landing page shows all three: the sun, the clouds, and the lighthouse */
html[data-theme="light"] .sun,body[data-page="landing"] .sun{display:block;position:absolute;right:-100px;top:-110px;width:min(32vw,330px);aspect-ratio:1;background:url(/art/sun.webp) center/100% no-repeat;border-radius:50%;box-shadow:0 0 60px 20px rgba(255,190,60,.4),0 0 140px 60px rgba(255,170,60,.2)}
.sun::before{content:"";position:absolute;inset:-70%;border-radius:50%;z-index:-1;background:repeating-conic-gradient(from 0deg,rgba(255,214,120,.38) 0deg 2.5deg,rgba(255,214,120,0) 2.5deg 15deg);
  -webkit-mask:radial-gradient(circle,transparent 30%,#000 34%,rgba(0,0,0,.55) 52%,transparent 70%);mask:radial-gradient(circle,transparent 30%,#000 34%,rgba(0,0,0,.55) 52%,transparent 70%)}
@keyframes rays{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:no-preference){.sun::before{animation:rays 180s linear infinite}}
html[data-theme="dark"] .lh,body[data-page="landing"] .lh{display:block;position:absolute;right:-90px;bottom:-50px;height:min(88%,1500px);aspect-ratio:558/1300;background:url(/art/lighthouse.webp) bottom/contain no-repeat;filter:drop-shadow(0 0 30px #1a133399)}
.beam{position:absolute;left:53%;top:12.4%;width:0;height:0}
.beam::before{content:"";position:absolute;left:0;top:0;width:160vw;height:240px;margin-top:-120px;transform-origin:0 50%;background:linear-gradient(90deg,rgba(255,226,150,.5),rgba(255,226,150,.16) 35%,rgba(255,226,150,0) 75%);clip-path:polygon(0 48%,100% 0,100% 100%,0 52%);filter:blur(6px);transform:rotate(200deg)}
.beam::after{content:"";position:absolute;left:-55px;top:-55px;width:110px;height:110px;border-radius:50%;background:radial-gradient(circle,rgba(255,225,150,.95),rgba(255,200,100,.3) 40%,rgba(255,200,100,0) 70%)}
@keyframes sweep2{0%,100%{transform:rotate(195deg)}50%{transform:rotate(240deg)}}
@media (prefers-reduced-motion:no-preference){.beam::before{animation:sweep2 14s ease-in-out infinite}}
html[data-theme="sky"] .sky-layer,body[data-page="landing"] .sky-layer{display:block}
body[data-page="landing"] .lh{height:min(46%,820px)}
.cl{position:absolute;filter:url(#wisp);will-change:transform}
.cl i{position:absolute;border-radius:50%;background:radial-gradient(circle at 45% 40%,#fff 0,#fffffff2 38%,#ffffff99 58%,#fff0 72%)}
.cl .belly{position:absolute;left:8%;right:8%;bottom:4%;height:38%;border-radius:50%;background:radial-gradient(ellipse at 50% 30%,#dfe7f5cc 0,#c3d1ea88 50%,#c3d1ea00 72%);z-index:1}
@media (max-width:600px){html[data-theme="light"] .sun,body[data-page="landing"] .sun{top:-60px;right:-70px;width:190px}html[data-theme="dark"] .lh{height:70%;right:-120px}body[data-page="landing"] .lh{height:40%;right:-110px}}
/* ---- review pass 2 ---- */
/* text on cream stays navy in every theme, whatever the page around it says */
body.themed :is(.card,.how-list li,.stats,.sheet,.emptybox,.welcome,.removed,.ans,.answers-wrap:not([open])>summary) :is(h2,h3,h4,p,li,dt,dd,label,summary,strong,b:not(.count)){color:#1a1333}
/* the score keeps its own colors */
body.themed .jc .jc-score b{color:var(--sfg)!important} body.themed .jc.legendary .jc-score b,body.themed .jc.rare .jc-score b{color:#1a1333!important} body.themed .jc.epic .jc-score b{color:#fff!important}
/* dark landing: the clouds sit back so the cream words in front of them read */
html[data-theme="dark"] body[data-page="landing"] .sky-layer{opacity:.4}
body.themed .answers-wrap:not([open])>summary{color:#1a1333;background:var(--card);border:2px solid var(--edge);box-shadow:var(--cshadow)}
body.themed .how-list li{color:#1a1333;background:var(--card);border:2px solid var(--edge);border-radius:20px;box-shadow:var(--cshadow)}
/* the gold highlight under a headline word: navy word in light and sky; in dark the word stays cream and the bar dims */
html[data-theme="dark"] body.themed h1 .head{background:linear-gradient(transparent 60%,rgba(255,201,60,.38) 60%,rgba(255,201,60,.38) 90%,transparent 90%)}
html[data-theme="dark"] body.themed .hero-h1 mark{color:#f6f9dc;background:linear-gradient(transparent 60%,rgba(255,201,60,.38) 60%,rgba(255,201,60,.38) 90%,transparent 90%)}
html[data-theme="sky"] body.themed .hero-h1 mark{color:#1d4f9a}
/* sky: the handwritten line in deep blue, plain, so it reads on the dusty blue */
html[data-theme="sky"]{--handc:#1d3d6e;--hand-shadow:none}
/* quieter frames: a soft glow, not a halo */
html:not([data-theme="light"]) .jc.legendary{box-shadow:inset 0 1px 0 #fffc,0 6px 14px rgba(255,139,209,.28)!important}
html:not([data-theme="light"]) .jc.epic{box-shadow:inset 0 1px 0 #fffc,0 6px 14px rgba(161,59,240,.28)!important}
html:not([data-theme="light"]) .jc.rare{box-shadow:inset 0 1px 0 #fffc,0 6px 14px rgba(240,129,47,.25)!important}
/* light: the current tab and header buttons in cream glass with a navy line, not muddy brown */
html[data-theme="light"]{--pill:rgba(246,249,220,.7);--pill-edge:#1a1333}
/* the score's "why" opens above the next card */
.jc:has(.jc-score[open]){z-index:6}
/* phone: the score sits in the save/pass row, so the title gets the full width */
@media (max-width:600px){.jc-body{grid-column:2/4}.jc-acts{grid-column:2;grid-row:2}.jc-score{grid-column:3;grid-row:2;align-self:center}.jc-score b{width:56px;height:56px;font-size:34px}}
@media (pointer:coarse){.jc-acts{height:auto;min-height:68px}}
/* the tape: wide enough for the whole word */
.tape{width:74px}
/* lowercase labels, the brand's voice */
body.themed .tag,body.themed .step,body.themed .when-tag{text-transform:lowercase;letter-spacing:.02em}
/* about and privacy: the nav lines up with the logo's column */
body.themed[data-page="about"] .dock{max-width:860px}
/* the landing page: no blur behind its boxes (the clouds move behind them), and no lighthouse on phones, where it would sit behind the last call to action */
body[data-page="landing"] :is(.card,.stats,.how-list li){-webkit-backdrop-filter:none;backdrop-filter:none}
body[data-page="landing"] .lh{height:min(40%,720px)}
@media (max-width:700px){body[data-page="landing"] .lh{display:none}}
/* tracker scores look like the feed's: a handwritten number in a rounded box */
.tscore{background:none!important;padding:0!important;animation:none!important}
.tscore b{display:grid;place-items:center;width:52px;height:52px;border-radius:14px;font:400 30px/1 var(--hand);background:var(--sbg);color:var(--sfg)!important;border:2px solid #1a1333}
/* log in and sign up: the headline and the card start together near the top, not floating mid-page */
@media (min-width:900px){body.themed[data-page="login"] main,body.themed[data-page="signup"] main{align-items:start;min-height:0;padding-top:110px}
  body.themed[data-page="login"] h1,body.themed[data-page="signup"] h1{margin-top:6px}}
/* ---- review pass 3 ---- */
/* dark: no dim bar behind headline words; where a page underlines its word, a clean gold line under it */
html[data-theme="dark"] body.themed h1 .head{background:none}
html[data-theme="dark"] body.themed:is([data-page="login"],[data-page="signup"],[data-page="start"],[data-page="you"]) h1 .head,html[data-theme="dark"] body.themed .hero-h1 mark{background:none;text-decoration:underline #ffc93c;text-decoration-thickness:6px;text-underline-offset:6px;text-decoration-skip-ink:none}
/* dark: header buttons stay solid so they read over the art */
html[data-theme="dark"] :is(.theme-btn,body.themed .pill-link){background:rgba(26,19,51,.82);border-color:#f6f9dc55}
/* landing: a smaller sun that clears the header and the handwritten line, and the clouds a little quieter */
body[data-page="landing"] .sun{width:min(22vw,230px)!important;right:-90px!important;top:-100px!important}
body[data-page="landing"] .sky-layer{opacity:.85}
@media (max-width:600px){body[data-page="landing"] .sun{width:150px!important;right:-70px!important;top:-70px!important}}
/* room under the big headlines */
body.themed:is([data-page="start"],[data-page="review"],[data-page="about"],[data-page="programs"]) h1{margin-bottom:18px}
/* the sign-up questions card: sky's soft float, like every other sky card */
body.themed .qcard{background:var(--card);border:2px solid var(--edge);border-radius:20px;box-shadow:var(--cshadow);color:#1a1333}
/* log in / sign up: the small note under the password stays readable */
body.themed .auth .note{color:#5b5673} body.themed .auth{color:#1a1333}
/* you page, desktop: "your answers" lines up with the top of the left column */
@media (min-width:900px){body.themed[data-page="you"] .answers-wrap>summary h2{margin-top:0}}
body.themed .alerts .turn-on{margin-top:14px}
/* the tape reads at any size */
.tape{width:80px}.tape b{font-size:13px}
/* about: a lone last card spans both columns; review: dates stay on one line */
@media (min-width:900px){body.themed[data-page="about"] .steps li:last-child:nth-child(odd){grid-column:1/-1}}
body.themed[data-page="review"] .kitcard .meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.themed .state-tag{text-transform:lowercase}
/* empty boxes look the same on every page: the panda small beside one line */
body.themed .emptybox{display:flex;gap:16px;align-items:center;padding:20px;grid-column:1/-1;max-width:640px}
body.themed .emptybox .panda{width:96px;height:96px;flex:none} body.themed .emptybox p{margin:0;font-weight:600}
/* no panda: give back the room it used to hold */
body.themed[data-page="start"] h1{padding-right:0}
body.themed .alerts h3,body.themed .alerts h3+p{padding-right:0}
body.themed .auth-wrap{margin-top:24px}
body.themed .promise{grid-template-columns:1fr}
body.themed .hero-art{min-height:0}
/* ---- iPhone ---- */
/* home-screen app: the page runs under the status bar, so the header steps down by the notch's height */
body.themed header{padding-top:calc(18px + env(safe-area-inset-top))}
/* the views: one button and a menu on a phone */
.viewmenu{display:none;grid-column:1/-1;position:relative;margin:0 0 14px;z-index:8}
.viewmenu>summary{list-style:none;display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:8px 16px;border-radius:99px;background:var(--tx);color:var(--chip-on);font:600 16px var(--round);cursor:pointer}
.viewmenu>summary::-webkit-details-marker{display:none}
.viewmenu>summary small{opacity:.7;font-size:13px}.viewmenu .chev{font-size:12px;transition:transform .2s}.viewmenu[open] .chev{transform:rotate(180deg)}
.viewmenu-list{position:absolute;left:0;top:calc(100% + 8px);min-width:240px;display:grid;padding:6px;border-radius:18px;background:rgba(248,250,223,.97);border:2px solid #1a1333;box-shadow:0 14px 30px rgba(10,5,40,.3);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
.viewmenu-list a{display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:44px;padding:0 14px;border-radius:12px;font:600 16px var(--round);color:#1a1333;text-decoration:none}
.viewmenu-list a small{color:#5b5673;font-size:13px}.viewmenu-list a.on{background:#1a133314}.viewmenu-list a.on::after{content:"✓";margin-left:auto;padding-left:8px}
@media (max-width:600px){.views{display:none}.viewmenu{display:block}.sub{font-size:16px}}
/* ---- the page never slides sideways on a phone ----
   The tape hung a few pixels past the card, and on a phone the card sits 16px from the screen's edge, so it stuck past
   the screen; the sun and the clouds hang off it on purpose. iOS then panned the whole page in both directions (the
   same bug Command Center had). The page clips sideways at the root, the art layers clip their own children, and on a
   phone the tape stays inside the screen. */
html:has(body.themed),body.themed{overflow-x:hidden;max-width:100%;overscroll-behavior-x:none}
.scene,.sky-layer{contain:paint}
body.themed main>*{min-width:0;max-width:100%}
@media (max-width:600px){.tape{right:-6px;top:-12px}}
/* ---- phones: no lighthouse, just what was around it ----
   The tower ate a third of an iPhone screen behind the cards. On a phone the dark theme keeps its night instead:
   faint stars, the lamp's warm glow from past the bottom-right corner, its beam sweeping slowly up the sky, and
   the rocks and sea it stood on. The layer is fixed to the screen like the clouds, and clips itself. */
.night{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;contain:paint;display:none}
.night i{position:absolute;display:block}
.night .stars{inset:0 0 30% 0;opacity:.95;background-image:radial-gradient(1.5px 1.5px at 12% 8%,#f6f9dc,#0000),radial-gradient(1px 1px at 28% 18%,#f6f9dc,#0000),radial-gradient(1.5px 1.5px at 46% 5%,#f6f9dc,#0000),
  radial-gradient(1px 1px at 63% 14%,#f6f9dc,#0000),radial-gradient(2px 2px at 82% 9%,#ffe7a8,#0000),radial-gradient(1px 1px at 8% 34%,#f6f9dc,#0000),radial-gradient(1.5px 1.5px at 37% 41%,#f6f9dc,#0000),
  radial-gradient(1px 1px at 71% 30%,#f6f9dc,#0000),radial-gradient(1.5px 1.5px at 90% 44%,#f6f9dc,#0000),radial-gradient(1px 1px at 19% 58%,#f6f9dc,#0000),radial-gradient(1px 1px at 55% 62%,#f6f9dc,#0000),
  radial-gradient(1.5px 1.5px at 77% 70%,#f6f9dc,#0000),radial-gradient(1px 1px at 33% 80%,#f6f9dc,#0000),radial-gradient(1px 1px at 4% 88%,#f6f9dc,#0000)}
.night .glow{right:-120px;bottom:-60px;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,rgba(255,214,130,.55),rgba(255,190,90,.18) 40%,rgba(255,190,90,0) 70%)}
.night .sweep{right:22px;bottom:40px;width:0;height:0}
.night .sweep::before{content:"";position:absolute;left:0;top:0;width:150vh;height:200px;margin-top:-100px;transform-origin:0 50%;background:linear-gradient(90deg,rgba(255,226,150,.4),rgba(255,226,150,.12) 35%,rgba(255,226,150,0) 75%);clip-path:polygon(0 48%,100% 0,100% 100%,0 52%);filter:blur(6px);transform:rotate(215deg)}
.night .rocks{position:absolute;left:0;right:0;bottom:0;width:100%;height:56px;fill:#0b0820;opacity:.85}
.night .rocks .sea{fill:#0e3a44;opacity:.9}
@keyframes sweep3{0%,100%{transform:rotate(200deg)}50%{transform:rotate(250deg)}}
@keyframes twinkle{50%{opacity:.45}}
@media (prefers-reduced-motion:no-preference){.night .sweep::before{animation:sweep3 14s ease-in-out infinite}.night .stars{animation:twinkle 6s ease-in-out infinite}}
@media (max-width:600px){html[data-theme="dark"] .lh{display:none}html[data-theme="dark"] .night{display:block}}
/* the landing page on a phone shows the lighthouse's beam and glow whatever the theme; stars only at night */
/* a small lighthouse in the corner, so the beam comes from somewhere. 110px tall; its lamp sits 30px in from the right
   and 110px up, and the beam, the glow, and the lamp's halo all start there. */
.night .tower{right:8px;bottom:14px;height:110px;aspect-ratio:558/1300;background:url(/art/lighthouse.webp) bottom/contain no-repeat;filter:drop-shadow(0 0 10px #1a133399)}
.night .sweep{right:30px;bottom:110px}
.night .glow{right:-120px;bottom:-40px}
.night .lamp{right:12px;bottom:92px;width:36px;height:36px;border-radius:50%;background:radial-gradient(circle,rgba(255,225,150,.95),rgba(255,200,100,.3) 40%,rgba(255,200,100,0) 70%)}
@media (max-width:700px){body[data-page="landing"] .night{display:block}html:not([data-theme="dark"]) body[data-page="landing"] .night .stars{display:none}html:not([data-theme="dark"]) body[data-page="landing"] .night .rocks{opacity:.25}}
`;
