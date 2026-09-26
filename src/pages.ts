// pi-lan-mobile phone pages.
//
// Server-rendered single-file pages, DSH-style: inline style/script only, no
// external assets (the CSP from the bridge forbids them anyway). Dynamic
// content is inserted via textContent/createElement, never innerHTML.
//
// Keep page-side JS backtick-free so these templates stay plain string arrays.
//
// UI design pattern (prevents the layout bugs v1 had):
//   1. App shell, not fixed parts: #app is a flex column (header / transcript /
//      composer). Nothing is position:fixed, so nothing can hide under the
//      on-screen keyboard or drift when the layout viewport changes.
//   2. One viewport owner: fit() is the ONLY place that measures the viewport;
//      it binds #app height to visualViewport.height (the keyboard-aware
//      number) and re-settles scroll. All keyboard behavior flows through it.
//   3. One state machine: netOk x working is the single source of truth for
//      the header chip and the stop button (chip()). DOM state never diverges
//      because it is never set anywhere else.
//   4. One keyed reconciler: every transcript item is upserted by item.key;
//      details nodes are patched IN PLACE on same-kind updates (replacing the
//      node would reset the <pre> scroll to 0 and fight the reader mid-box),
//      and their open state restores from openKeys.

import { FONT_DATA_URI, FONT_FAMILY } from "./font-embedded.ts";
import { BODY_FONT_DATA_URI, BODY_FONT_FAMILY } from "./font-embedded-body.ts";

// Inline @font-face for the embedded subset. The only src is the data: URI
// this string carries (CSP: font-src data:).
const FONT_FACE =
	"@font-face{font-family:'" + FONT_FAMILY + "';font-style:normal;font-weight:400;src:url(" + FONT_DATA_URI + ") format('woff2')}";

// Same pattern for the body face (Departure Mono, see font-embedded-body.ts).
const BODY_FONT_FACE =
	"@font-face{font-family:'" + BODY_FONT_FAMILY + "';font-style:normal;font-weight:400;src:url(" + BODY_FONT_DATA_URI + ") format('woff2')}";

const PAGE_BASE_STYLE = [
	FONT_FACE,
	BODY_FONT_FACE,
	":root{",
	"--bg:#000;--panel:#0b0b0b;--panel-2:#070707;--border:#262626;",
	"--text:#e8e4dc;--muted:#7a756c;--pre:#b5afa3;--accent:#e2571f;",
	"--user:#231307;--ok:#cfc9bd;--warn:#e2571f;--err:#f0473c;",
	"--mono:'" + BODY_FONT_FAMILY + "',ui-monospace,SFMono-Regular,Menlo,monospace;",
	"--doto:'" + FONT_FAMILY + "',ui-monospace,SFMono-Regular,Menlo,monospace",
	"}",
	"*{box-sizing:border-box}",
	"html,body{height:100%}",
	"body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
	"h1{font-size:15px;margin:0;font-weight:600}",
	"button{font:inherit;font-size:14px;border:0;border-radius:0;padding:7px 13px;background:var(--accent);color:#000;cursor:pointer}",
	"button.ghost{background:transparent;color:var(--muted);border:0;padding:5px 11px;font:13px var(--doto)}",
	"button:disabled{opacity:.4;cursor:default}",
	".dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}",
	".dot.on{background:var(--ok)}",
	".dot.off{background:var(--err)}",
	".dot.wait{background:var(--warn);animation:pulse 1.4s ease-in-out infinite}",
	"@keyframes pulse{50%{opacity:.35}}",
].join("\n");

function pageShell(title: string, style: string, body: string, script: string): string {
	return [
		"<!doctype html>",
		'<html lang="en"><head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
		`<title>${title}</title>`,
		"<style>",
		style,
		"</style>",
		"</head><body>",
		body,
		"<script>",
		"'use strict';\n",
		script,
		"</script>",
		"</body></html>",
	].join("\n");
}

// ----------------------------------------------------------- pairing wait page

export function renderPairingWaitPage(id: string): string {
	const style = [
		PAGE_BASE_STYLE,
		"main{max-width:420px;margin:22vh auto 0;padding:0 22px;text-align:center}",
		".card{background:var(--panel);border:1px solid var(--border);border-radius:0;padding:22px 18px}",
		".state{display:flex;align-items:center;gap:9px;justify-content:center;font-size:16px;font-weight:600}",
		".sub{color:var(--muted);font-size:13.5px;margin:10px 0 0}",
		"a{color:var(--muted);font-size:13px;display:inline-block;margin-top:18px}",
	].join("\n");

	const body = [
		'<main><div class="card">',
		'<div class="state"><span class="dot wait" id="d"></span><span id="s">waiting for the desktop…</span></div>',
		'<p class="sub">Approve this phone in the pi terminal. This page checks by itself.</p>',
		"</div>",
		'<a href="/">start over</a>',
		"</main>",
	].join("\n");

	// NOTE: id is embedded as a JSON string; page JS stays backtick-free.
	const script = [
		"var id = " + JSON.stringify(id) + ";",
		"var state = document.getElementById('s'), dot = document.getElementById('d');",
		"function say(text, cls) { state.textContent = text; dot.className = 'dot ' + cls; }",
		"function tick() {",
		"  fetch('/pair/status?id=' + encodeURIComponent(id))",
		"    .then(function (r) { return r.json(); })",
		"    .then(function (v) {",
		"      if (v.pending) say('waiting for the desktop…', 'wait');",
		"      else if (v.expired) say('this pairing link expired — scan a fresh QR', 'off');",
		"      else if (v.denied) say('the desktop denied this pairing — scan again to retry', 'off');",
		"      else if (v.approved) { say('paired — opening chat…', 'on'); location.replace('/'); }",
		"    }).catch(function () { say('lost contact with the desktop', 'off'); });",
		"}",
		"tick(); setInterval(tick, 1000);",
	].join("\n");

	return pageShell("Pair pi", style, body, script);
}

// ------------------------------------------------------------------ chat page

const CHAT_STYLE = [
	PAGE_BASE_STYLE,
	"#app{display:flex;flex-direction:column;height:100vh}",
	"header{flex:none;display:flex;align-items:center;gap:8px;padding:calc(env(safe-area-inset-top) + 9px) 12px 9px;border-bottom:1px solid var(--border);background:var(--bg)}",
	"header .title{font:650 15px/1.2 var(--doto);letter-spacing:.08em}",
	"header .grow{flex:1}",
	".chip{display:flex;align-items:center;gap:6px;font:11px/1 var(--doto);letter-spacing:.05em;color:var(--muted);border:1px solid var(--border);border-radius:0;padding:4px 10px}",
	"main{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}",
	"#log{position:relative;counter-reset:step;max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:10px;padding:14px 12px 24px}",
	".bubble{border-radius:0;padding:9px 13px;overflow-wrap:break-word;max-width:88%}",
	".user{align-self:flex-end;background:var(--user);border:1px solid #3a2413;font:13.5px/1.65 var(--mono)}",
	".assistant{align-self:flex-start;background:var(--panel);border:1px solid var(--border);white-space:pre-wrap;font:13.5px/1.65 var(--mono)}",
	".step{align-self:stretch;counter-increment:step;background:var(--panel-2);border:1px solid var(--border);border-left:3px solid var(--muted);border-radius:0;font:12px/1.5 var(--doto)}",
	".step.done{border-left-color:var(--ok)}",
	".step.think{border-left-color:#8b7ab8}",
	".step.running{border-left-color:var(--warn)}",
	".step.error{border-left-color:var(--err)}",
	".step>summary{list-style:none;cursor:pointer;padding:7px 11px;color:var(--muted);display:flex;align-items:center;gap:8px;-webkit-user-select:none;user-select:none}",
	".step>summary::-webkit-details-marker{display:none}",
	// the step number is a CSS counter, not JS: numbering survives in-place
	// patches, resets and rebinds without touching the reconciler.
	".step>summary::before{content:'▸ ' counter(step,decimal-leading-zero) ' '}",
	".step[open]>summary::before{content:'▾ ' counter(step,decimal-leading-zero) ' '}",
	".step pre{margin:0;padding:7px 11px;border-top:1px solid var(--border);background:#050505;white-space:pre-wrap;overflow:auto;max-height:280px;color:var(--pre);font:12px/1.5 var(--mono)}",
	".info{align-self:center;color:var(--muted);font:10.5px/1.7 var(--doto);letter-spacing:.07em;text-align:center}",
	".empty{align-self:center;color:var(--muted);text-align:center;margin-top:16vh;font:11px/1.9 var(--doto);letter-spacing:.09em;max-width:320px}",
	".empty::before{content:'▓▒░  pi-lan-mobile v0.1  ░▒▓\\A· awaiting first prompt ·';white-space:pre;display:block;color:var(--pre);margin-bottom:6px}",
	// the dot-matrix strip: the pins' dither texture, kept OFF the reading area.
	".empty::after{content:'';display:block;width:230px;height:64px;margin:16px auto 0;opacity:.5;background:radial-gradient(var(--border) 1px,transparent 1.2px);background-size:8px 8px}",
	"form{flex:none;display:flex;align-items:flex-end;gap:8px;padding:9px 12px calc(env(safe-area-inset-bottom) + 9px);border-top:1px solid var(--border);background:var(--bg)}",
	// Safari zooms the page on focus when a field's font is under 16px.
	"textarea{flex:1;font-size:16px;font-family:var(--mono);background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:0;padding:8px 14px;resize:none;max-height:140px;outline:none}",
	"textarea:focus{border-color:var(--accent)}",
	// markdown leaves (md()/inl() in the page script): sized to sit inside a
	// 13.5px bubble without shouting. Code blocks stay the same near-black
	// plate as the step <pre>s.
	"code.mdc{font-family:var(--mono);font-size:12px;background:#141210;border:1px solid var(--border);border-radius:3px;padding:0 4px}",
	".assistant pre.mdpre{margin:0 0 7px;padding:7px 9px;background:#050505;border:1px solid var(--border);border-radius:0;overflow:auto;max-width:100%;max-height:240px;font:12px/1.5 var(--mono);white-space:pre}",
	".assistant p.mdp{margin:0 0 7px}",
	".assistant div.mdh{font-weight:700;margin:9px 0 6px}",
	".assistant div.mdh1{font-size:17px}",
	".assistant div.mdh2{font-size:15.5px}",
	".assistant div.mdh3,.assistant div.mdh4{font-size:14px}",
	".assistant .mdq{margin:0 0 7px;padding:1px 0 1px 10px;border-left:2px solid var(--accent);color:var(--muted)}",
	".assistant ul.mdlist,.assistant ol.mdlist{margin:0 0 7px;padding-left:22px}",
	".assistant .mdhair{border-top:1px solid var(--border);margin:9px 0}",
	// tables: the wrapper owns the horizontal scroll (a phone column cannot
	// fit a wide grid); the table itself stays a plain hairline grid.
	".mdtsv{overflow-x:auto;max-width:100%;margin:0 0 7px;-webkit-overflow-scrolling:touch}",
	"table.mdt{border-collapse:collapse;font:12px/1.5 var(--mono);white-space:nowrap}",
	".mdt th,.mdt td{border:1px solid var(--border);padding:3px 9px;text-align:left}",
	".mdt th{color:var(--muted);font-weight:700}",
	".bubble a,.bubble a:visited{color:var(--accent);text-decoration:underline}",
	"#send{flex:none;width:38px;height:38px;border-radius:0;padding:0;position:relative;background:var(--bg);font:0/0 var(--doto)}",
	".glyf{position:absolute;left:50%;top:50%;margin:-18px 0 0 -18px;width:36px;text-align:left;white-space:pre;font:5.46px/3.27px var(--doto)}",
	".glyf.field{color:var(--accent);opacity:.6}",
	".glyf.mark{color:var(--text)}",
	"#send:disabled{opacity:1}",
	"#send:disabled .glyf.mark{color:var(--pre)}",
	// jump-to-latest lives INSIDE the scroller as a sticky element: 'bottom:0'
	// pins it to the visible band no matter how the keyboard reshapes the page.
	"#jump{position:sticky;bottom:2px;align-self:center;z-index:2;width:34px;height:34px;border-radius:0;font:16px var(--doto);padding:0;display:flex;align-items:center;justify-content:center;background:var(--panel);border:1px solid var(--border);color:var(--text);box-shadow:0 2px 8px rgba(0,0,0,.45)}",
	"#jump[hidden]{display:none}",
].join("\n");

const CHAT_BODY = [
	'<div id="app">',
	'<header><span class="title">pi</span><span class="grow"></span>',
	'<span class="chip"><span class="dot off" id="dot"></span><span id="net">offline</span></span>',
	'<button class="ghost" id="newBtn" title="new session">[new]</button>',
	'<button class="ghost" id="stopBtn" disabled title="interrupt the agent">[stop]</button></header>',
	'<main id="scroller"><div id="log">',
	'<div class="empty" id="empty">Nothing here yet.<br>Message pi from the phone, or type on the desktop.</div>',
	'<button id="jump" type="button" hidden aria-label="jump to latest">↓</button>',
	"</div></main>",
	'<form id="composer">',
	'<textarea id="input" rows="1" placeholder="Message pi…" enterkeyhint="send" autocomplete="off"></textarea>',
	'<button id="send" disabled aria-label="Send"><span class="glyf field">•••••••••••\n•••••••••••\n•••••••••••\n•••••••••••\n•••••••••••\n•••••••••••\n•••••••••••\n•••••••••••\n•••••••••••\n•••••••••••\n•••••••••••</span><span class="glyf mark">           \n           \n     •     \n    •••    \n   • • •   \n  •  •  •  \n     •     \n     •     \n     •     \n           \n           </span></button>',
	"</form>",
	"</div>",
].join("\n");

const CHAT_SCRIPT = [
	"var app = document.getElementById('app'), scroller = document.getElementById('scroller');",
	"var log = document.getElementById('log'), empty = document.getElementById('empty');",
	"var dot = document.getElementById('dot'), net = document.getElementById('net');",
	"var form = document.getElementById('composer'), input = document.getElementById('input');",
	"var send = document.getElementById('send'), stopBtn = document.getElementById('stopBtn'), jump = document.getElementById('jump');",
	"var byKey = {}, order = [], after = 0, openKeys = {}, localSeq = 0;",
	"var netOk = false, working = false;",
	// --- single source of truth for chip + stop button (pattern #3)
	"function chip() {",
	"  if (!netOk) { dot.className = 'dot off'; net.textContent = 'offline'; }",
	"  else if (working) { dot.className = 'dot wait'; net.textContent = 'working…'; }",
	"  else { dot.className = 'dot on'; net.textContent = 'connected'; }",
	"  stopBtn.disabled = !working;",
	"}",
	"function setWorking(v) { if (working !== v) { working = v; chip(); } }",
	// --- viewport owner (pattern #2): keyboard-aware app height, scroll settle
	"function fit() {",
	"  var vv = window.visualViewport;",
	"  var h = Math.round(vv ? vv.height : window.innerHeight);",
	"  var top = vv ? Math.round(vv.offsetTop) : 0;",
	"  if (!(h > 0)) return;",
	"  var moved = h !== fit.h || top !== fit.top;",
	"  fit.h = h; fit.top = top;",
	"  app.style.height = h + 'px';",
	"  // Safari quirk: the keyboard PANS the visual viewport over the document.",
	"  // The pan is not document scroll (scrollTo cannot undo it), so anchor #app",
	"  // to the visible band itself by compensating visualViewport.offsetTop.",
	"  app.style.transform = top ? 'translateY(' + top + 'px)' : '';",
	"  // A SIGNIFICANT shrink is the keyboard arriving: the composer you just",
	"  // tapped must show the message you are answering, so force to bottom even",
	"  // if the old tall viewport had you parked at the top of the log. Small",
	"  // deltas (animation oscillation, Safari pan) keep manual scroll position.",
	"  if (fit.prev > 0 && fit.prev - h > 150) scrollBottom();",
	"  else if (nearBottom()) scrollBottom();",
	"  fit.prev = h;",
	"  updateJump();",
	"  // Safari settles the keyboard pan AFTER the last visualViewport event, so",
	"  // a one-shot fit strands the composer above the keyboard. Keep re-reading",
	"  // the viewport on frames and stop once it has been still for a few of them.",
	"  fit.quiet = moved ? 0 : fit.quiet + 1;",
	"  if (fit.quiet < 8 && !fit.raf) {",
	"    fit.raf = requestAnimationFrame(function () { fit.raf = 0; fit(); });",
	"  }",
	"}",
	"fit.h = -1; fit.top = -1; fit.prev = -1; fit.quiet = 0; fit.raf = 0;",
	"function nearBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140; }",
	"function scrollBottom() { scroller.scrollTop = scroller.scrollHeight; }",
	"// jump-to-latest: shown while the reader is away from the bottom, tucked",
	"// away the moment they are back at the live edge (or nothing exists yet).",
	"function updateJump() { jump.hidden = !!empty.parentNode || nearBottom(); }",
	"function rpc(method, payload) {",
	"  return fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' },",
	"    body: JSON.stringify({ method: method, payload: payload || {} }) }).then(function (r) { return r.json(); });",
	"}",
	"function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }",
	// --- minimal markdown renderer -------------------------------------------------
	// No innerHTML anywhere: md()/inl() build NODES (createElement) and every text
	// leaf still arrives via createTextNode/textContent, so the dynamic-content
	// contract holds with formatting on. Links are scheme-gated: href is set only
	// when safeHref recognizes http(s)/mailto, so a javascript: target can never
	// become a link (the target text is shown plainly instead). The backtick lives
	// only as BT (charcode 96) so this page JS keeps zero literal backticks.
	// Subset: fences, # headings, +/-/* and 1. lists, > quotes, --- rules,
	// | pipe | tables | (header + |---| delimiter + body rows; alignment colons
	// are accepted but ignored — every cell reads left); inline `code`, **bold**,
	// *em*, ~~strike~~, [label](url). No nesting.
	"var BT = String.fromCharCode(96);",
	"function safeHref(u) { u = String(u).trim(); return /^(https?:|mailto:)/i.test(u) ? u : ''; }",
	"function inl(text, parent) {",
	"  var RE = new RegExp(",
	"    '(' + BT + '+[^' + BT + ']+' + BT + '+)' +",
	"    '|(\\\\[[^\\\\]]*\\\\]\\\\([^)\\\\s]+\\\\))' +",
	"    '|(\\\\*\\\\*[^*]+\\\\*\\\\*)' + '|(__[^_]+__)' +",
	"    '|(~~[^~]+~~)' + '|(\\\\*[^*\\\\n]+\\\\*)',",
	"    'g');",
	"  var last = 0, m;",
	"  function put(s) { if (s) parent.appendChild(document.createTextNode(s)); }",
	"  while ((m = RE.exec(text))) {",
	"    put(text.slice(last, m.index));",
	"    var s = m[0];",
	"    if (s.charAt(0) === BT) {",
	"      parent.appendChild(el('code', 'mdc', s.replace(new RegExp('^' + BT + '+|' + BT + '+$', 'g'), '')));",
	"    } else if (s.charAt(0) === '[') {",
	"      var mm = /^\\[([^\\]]*)\\]\\(([^)\\s]+)\\)$/.exec(s);",
	"      var href = safeHref(mm[2]);",
	"      if (href) { var a = el('a', 'mdl', mm[1]); a.setAttribute('href', href); a.setAttribute('rel', 'noopener noreferrer'); parent.appendChild(a); }",
	"      else { put(mm[1] + ' (' + mm[2] + ')'); }",
	"    } else if (s.charAt(0) === '~') {",
	"      parent.appendChild(el('s', null, s.slice(2, -2)));",
	"    } else {",
	"      var two = s.charAt(1) === s.charAt(0);",
	"      parent.appendChild(el(two ? 'strong' : 'em', null, s.slice(two ? 2 : 1, two ? -2 : -1)));",
	"    }",
	"    last = RE.lastIndex;",
	"  }",
	"  put(text.slice(last));",
	"}",
	"function md(text) {",
	"  var out = [];",
	"  var lines = String(text || '').split('\\n');",
	"  var F3 = BT + BT + BT, fence = false, fbuf = [], list = null, i;",
	"  function flushList() { if (list) { out.push(list); list = null; } }",
	"  function pushBlk(tag, cls) { var n = el(tag, cls); out.push(n); return n; }",
	"  function listItem(ul) {",
	"    var want = ul ? 'UL' : 'OL';",
	"    if (!list || list.tagName !== want) { flushList(); list = document.createElement(ul ? 'ul' : 'ol'); list.className = 'mdlist'; }",
	"    var li = document.createElement('li'); list.appendChild(li); return li;",
	"  }",
	"  function rowCells(s) {",
	"    var r = s.trim().slice(0, 1) === '|' ? s.trim().slice(1) : s.trim();",
	"    if (r.slice(-1) === '|') r = r.slice(0, -1);",
	"    return r.split('|');",
	"  }",
	"  var TSEP = /^\s*\|[\s:|-]+\|\s*$/;",
	"  for (i = 0; i < lines.length; i++) {",
	"    var t = lines[i].trim(), m;",
	"    if (t.slice(0, 3) === F3) {",
	"      if (fence) { pushBlk('pre', 'mdpre').textContent = fbuf.join('\\n'); fence = false; fbuf = []; }",
	"      else { flushList(); fence = true; fbuf = []; }",
	"      continue;",
	"    }",
	"    if (fence) { fbuf.push(lines[i]); continue; }",
	"    if (t === '') { flushList(); continue; }",
	"    m = /^(#{1,4})\\s+(.*)$/.exec(t);",
	"    if (m) { flushList(); var h = el('div', 'mdh mdh' + Math.min(m[1].length, 4)); inl(m[2], h); out.push(h); continue; }",
	"    if (/^(-{3,}|\\*{3,})$/.test(t)) { flushList(); out.push(el('div', 'mdhair')); continue; }",
	"    m = /^[-*+]\\s+(.*)$/.exec(t);",
	"    if (m) { var li1 = listItem(true); inl(m[1], li1); continue; }",
	"    m = /^\\d+[.)]\\s+(.*)$/.exec(t);",
	"    if (m) { var li2 = listItem(false); inl(m[1], li2); continue; }",
	"    m = /^>\\s?(.*)$/.exec(t);",
	"    if (m) { flushList(); var q = el('div', 'mdq'); inl(m[1], q); out.push(q); continue; }",
	"    if (t.slice(0, 1) === '|' && i + 1 < lines.length && TSEP.test(lines[i + 1])) {",
	"      // GFM-style table: this line is the header, lines[i+1] the |---|",
	"      // delimiter, following |-rows the body. Wrapped in a horizontal",
	"      // scroller because a phone column cannot fit a wide grid, and a",
	"      // half-streamed table simply shows its header while the delimiter",
	"      // has not arrived yet — it turns into the table when it does.",
	"      flushList();",
	"      var tw = el('div', 'mdtsv');",
	"      var tb = el('table', 'mdt');",
	"      var hrw = document.createElement('tr');",
	"      rowCells(t).forEach(function (c) { var th = document.createElement('th'); inl(c.trim(), th); hrw.appendChild(th); });",
	"      tb.appendChild(hrw);",
	"      i = i + 2;",
	"      while (i < lines.length && lines[i].trim().slice(0, 1) === '|') {",
	"        var rw = document.createElement('tr');",
	"        rowCells(lines[i]).forEach(function (c) { var td = document.createElement('td'); inl(c.trim(), td); rw.appendChild(td); });",
	"        tb.appendChild(rw);",
	"        i = i + 1;",
	"      }",
	"      i = i - 1;",
	"      tw.appendChild(tb);",
	"      // remember where the reader dragged this scroller: the classList slot",
	"      // rides the BUBBLE (the stable node), so it survives the rebuild; the",
	"      // text patch restores it onto the fresh wrapper.",
	"      tw.addEventListener('scroll', function () { if (tw.parentNode) tw.parentNode.classList.sx = tw.scrollLeft; });",
	"      out.push(tw); continue;",
	"    }",
	"    flushList(); var p = el('p', 'mdp'); inl(t, p); out.push(p);",
	"  }",
	"  if (fence && fbuf.length) pushBlk('pre', 'mdpre').textContent = fbuf.join('\\n');",
	"  flushList();",
	"  return out;",
	"}",
	// --- keyed reconciler (pattern #4): details open state survives updates
	"function step(name, item) {",
	"  var d = document.createElement('details');",
	"  d.className = 'step ' + (item.status === 'running' ? 'running' : item.status === 'error' ? 'error' : 'done');",
	"  d.open = !!openKeys[item.key];",
	"  d.addEventListener('toggle', function () { openKeys[item.key] = d.open; });",
	"  d.appendChild(el('summary', null, name));",
	"  return d;",
	"}",
	"function build(item) {",
	"  if (item.kind === 'user') return el('div', 'bubble user', item.text || '');",
	"  if (item.kind === 'text') { var b = el('div', 'bubble assistant'); md(item.text || '').forEach(function (n) { b.appendChild(n); }); return b; }",
	"  if (item.kind === 'info') return el('div', 'info', item.text || '');",
	"  if (item.kind === 'thinking') { var d = step('thinking', item); d.className = 'step think' + (d.open ? '' : ''); d.open = !!openKeys[item.key]; d.appendChild(el('pre', null, item.text || '')); return d; }",
	"  if (item.kind === 'tool') {",
	"    var glyph = item.status === 'running' ? '◐' : item.status === 'error' ? '✕' : '✓';",
	"    var t = step((item.toolName || 'tool') + '  ' + glyph, item);",
	"    if (item.input) t.appendChild(el('pre', null, item.input));",
	"    if (item.output) t.appendChild(el('pre', null, item.output));",
	"    return t;",
	"  }",
	"  return el('div', 'info', String(item.kind));",
	"}",
	// --- stream-patch targets: for details blocks, the live child nodes we can
	// update IN PLACE. Never replaceChild on a same-kind update: a rebuilt <pre>
	// starts at scrollTop 0, so mid-box reading would jump to the top ~2x/sec
	// while tokens stream. Patching textContent preserves every scroll offset.
	// nodes()/refresh() MUST stay top-level siblings of build(): they were once
	// swallowed into build's tool branch, which block-scoped them under
	// 'use strict', so the first rendered item threw ReferenceError — and tick's
	// .catch dressed that render crash up as "offline" on the phone.
	"function nodes(item) {",
	"  var e = build(item);",
	"  var o = { e: e };",
	"  if (e.tagName === 'DETAILS') {",
	"    o.sum = e.firstChild;",
	"    var pres = e.getElementsByTagName('pre');",
	"    o.preA = pres[0]; o.preB = pres[1];",
	"  }",
	"  return o;",
	"}",
	"function refresh(e, item) {",
	"  e.firstChild.textContent = item.kind === 'tool' ? (item.toolName || 'tool') + '  ' + (item.status === 'running' ? '◐' : item.status === 'error' ? '✕' : '✓') : 'thinking';",
	"}",
	"function toast(text) { apply({ key: 'local:' + (++localSeq), kind: 'info', text: text }); }",
	"function apply(item) {",
	"  if (empty && empty.parentNode) empty.parentNode.removeChild(empty);",
	"  var slot = byKey[item.key];",
	"  if (!slot) {",
	"    slot = { node: nodes(item), item: item }; order.push(item.key); byKey[item.key] = slot;",
	"    log.appendChild(slot.node.e);",
	"  } else if (slot.item.kind !== item.kind) {",
	"    var old = slot.node.e; slot.node = nodes(item); log.replaceChild(slot.node.e, old);",
	"  } else if (slot.node.e.tagName === 'DETAILS') {",
	"    // patch the EXISTING summary/pre nodes: reading position survives",
	"    // arriving tokens (an empty pre for a not-yet-streamed field is a no-op).",
	"    refresh(slot.node.e, item);",
	"    // the status CLASS must follow the stream too: it used to ride only",
	"    // build(), so a tool built while running kept its 'running' border",
	"    // forever after finishing — the glyph moved to ✓ and the border lied.",
	"    slot.node.e.className = item.kind === 'thinking' ? 'step think' : 'step ' + (item.status === 'running' ? 'running' : item.status === 'error' ? 'error' : 'done');",
	"    var body = item.text !== undefined ? item.text : item.output;",
	"    // first-write-wins mirrors the old build(): input is set once at tool",
	"    // start; a pre that never existed for a field is not conjured mid-turn.",
	"    if (item.input !== undefined && slot.node.preA && !slot.node.preA.textContent) slot.node.preA.textContent = item.input;",
	"    if (body !== undefined && slot.node.preA && !item.input) slot.node.preA.textContent = body;",
	"    if (body !== undefined && slot.node.preB) slot.node.preB.textContent = body;",
	"  } else if (item.kind === 'text') {",
	"    // Same-kind text patch: rebuild the markdown children wholesale. Safe,",
	"    // unlike the details boxes: a bubble owns no inner scroller, so there is",
	"    // no mid-box reading position for node churn to destroy. The ELEMENT node",
	"    // itself stays put (byKey identity), only its children turn over.",
	"    slot.node.e.textContent = '';",
	"    var keepSx = slot.node.e.classList ? slot.node.e.classList.sx : 0;",
	"    if (keepSx) slot.node.e.classList.sx = 0;",
	"    md(item.text || '').forEach(function (n) { slot.node.e.appendChild(n); });",
	"    // a rebuilt table scroller comes back at scrollLeft 0; put it back.",
	"    if (keepSx && slot.node.e.getElementsByClassName) {",
	"      var wr = slot.node.e.getElementsByClassName('mdtsv');",
	"      if (wr.length) wr[0].scrollLeft = keepSx;",
	"    }",
	"  } else {",
	"    slot.node.e.textContent = item.text || '';",
	"  }",
	"  slot.item = item;",
	"  updateJump();",
	"  if (item.kind === 'tool' && item.status === 'running') setWorking(true);",
	"  if (item.kind === 'info' && item.key.indexOf('local:') !== 0) setWorking(false);",
	"}",
	"function reset(items) {",
	"  log.textContent = ''; byKey = {}; order = [];",
	"  empty = el('div', 'empty', 'Nothing here yet.'); log.appendChild(empty);",
	"  (items || []).forEach(apply);",
	"}",
	"function tick() {",
	"  rpc('session.history', { after: after }).then(function (r) {",
	"    var was = netOk;",
	"    if (!r.ok) { netOk = false; chip(); return; }",
	"    netOk = true;",
	"    var v = r.value || {};",
	"    if (v.reset) reset(v.items); else (v.updates || []).forEach(function (u) { apply(u.item); });",
	"    after = v.cursor;",
	"    if (!was) fit();",
	"    if (nearBottom()) scrollBottom();",
	"    chip();",
	"  }, function () { netOk = false; chip(); });",
	"  // two-arg then on PURPOSE: a JS exception thrown while RENDERING an",
	"  // update must never land in the network-failure arm and flip the chip to",
	"  // 'offline'. offline = fetch/json/rejection, owned by the second callback.",
	"}",
	"tick(); setInterval(tick, 1000);",
	"function submit(text) {",
	"  text = (text || '').trim(); if (!text) return;",
	"  send.disabled = true; input.value = ''; input.style.height = 'auto';",
	"  rpc('session.prompt', { text: text }).then(function (r) {",
	"    if (!r.ok) { toast('⚠ ' + r.error); setWorking(false); } else { setWorking(true); }",
	"    send.disabled = !input.value.trim(); tick();",
	"  }, function () { toast('⚠ lost contact with the desktop'); send.disabled = !input.value.trim(); });",
	"}",
	"form.addEventListener('submit', function (e) { e.preventDefault(); submit(input.value); });",
	"// isComposing: on iOS with an IME, Enter confirms a candidate, it is not a send.",
	"input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(input.value); } });",
	"jump.addEventListener('click', function () { scrollBottom(); updateJump(); });",
	"scroller.addEventListener('scroll', updateJump);",
	"// Safari only hides the keyboard via 'Done'; a tap on the transcript blurs",
	"// the input instead (interactive parts keep their taps).",
	"scroller.addEventListener('pointerdown', function (e) {",
	"  if (e.target.closest && e.target.closest('a,button,summary')) return;",
	"  if (document.activeElement === input) input.blur();",
	"});",
	"input.addEventListener('input', function () { send.disabled = !input.value.trim(); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });",
	"stopBtn.addEventListener('click', function () { rpc('session.cancel', {}); });",
	"document.getElementById('newBtn').addEventListener('click', function () { if (confirm('Start a new pi session?')) rpc('session.create', {}); });",
	// keyboard + rotation binding: visualViewport resize is the only layout event that
	// knows about the on-screen keyboard; innerHeight resize is the desktop fallback.
	"if (window.visualViewport) {",
	"  // Safari fires 'scroll' (not only 'resize') when the keyboard pans the view.",
	"  window.visualViewport.addEventListener('resize', fit);",
	"  window.visualViewport.addEventListener('scroll', fit);",
	"}",
	"window.addEventListener('resize', fit);",
	"// Focus and blur are the pan's cause and its end; re-anchor on both directly.",
	"input.addEventListener('focus', fit);",
	"input.addEventListener('blur', fit);",
	"fit();",
].join("\n");

export function renderMobilePage(): string {
	return pageShell("pi · mobile", CHAT_STYLE, CHAT_BODY, CHAT_SCRIPT);
}
