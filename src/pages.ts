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

const PAGE_BASE_STYLE = [
	":root{",
	"--bg:#0d1117;--panel:#161b22;--panel-2:#10151c;--border:#262e3d;",
	"--text:#e6edf3;--muted:#8d96a5;--pre:#aab4c3;--accent:#3d7dff;",
	"--user:#1e3a5f;--ok:#3fb950;--warn:#d29922;--err:#f85149",
	"}",
	"*{box-sizing:border-box}",
	"html,body{height:100%}",
	"body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
	"h1{font-size:15px;margin:0;font-weight:600}",
	"button{font:inherit;font-size:14px;border:0;border-radius:10px;padding:7px 13px;background:var(--accent);color:#fff;cursor:pointer}",
	"button.ghost{background:var(--panel);color:var(--muted);border:1px solid var(--border);border-radius:9px;padding:5px 11px;font-size:13px}",
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
		".card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px 18px}",
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
	"header .title{font-weight:650;font-size:16px}",
	"header .grow{flex:1}",
	".chip{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:3px 9px}",
	"main{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}",
	"#log{position:relative;max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:10px;padding:14px 12px 24px}",
	".bubble{border-radius:16px;padding:9px 13px;overflow-wrap:break-word;max-width:88%}",
	".user{align-self:flex-end;background:var(--user);border-bottom-right-radius:5px}",
	".assistant{align-self:flex-start;background:var(--panel);border:1px solid var(--border);border-bottom-left-radius:5px;white-space:pre-wrap}",
	".step{align-self:stretch;background:var(--panel-2);border:1px solid var(--border);border-left:3px solid var(--muted);border-radius:10px;font-size:13px}",
	".step.done{border-left-color:var(--ok)}",
	".step.think{border-left-color:#6e40c9}",
	".step.running{border-left-color:var(--warn)}",
	".step.error{border-left-color:var(--err)}",
	".step>summary{list-style:none;cursor:pointer;padding:7px 11px;color:var(--muted);display:flex;align-items:center;gap:8px;-webkit-user-select:none;user-select:none}",
	".step>summary::-webkit-details-marker{display:none}",
	".step>summary::before{content:'▸';font-size:11px;transition:transform .15s}",
	".step[open]>summary::before{transform:rotate(90deg)}",
	".step pre{margin:0;padding:7px 11px;border-top:1px solid var(--border);white-space:pre-wrap;overflow:auto;max-height:280px;color:var(--pre);font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}",
	".info{align-self:center;color:var(--muted);font-size:12px}",
	".empty{align-self:center;color:var(--muted);text-align:center;margin-top:18vh;font-size:14px;line-height:1.8;max-width:300px}",
	"form{flex:none;display:flex;align-items:flex-end;gap:8px;padding:9px 12px calc(env(safe-area-inset-bottom) + 9px);border-top:1px solid var(--border);background:var(--bg)}",
	// Safari zooms the page on focus when a field's font is under 16px.
	"textarea{flex:1;font:inherit;font-size:16px;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:20px;padding:8px 14px;resize:none;max-height:140px;outline:none}",
	"textarea:focus{border-color:var(--accent)}",
	"#send{flex:none;width:38px;height:38px;border-radius:50%;font-size:17px;padding:0;display:flex;align-items:center;justify-content:center}",
	// jump-to-latest lives INSIDE the scroller as a sticky element: 'bottom:0'
	// pins it to the visible band no matter how the keyboard reshapes the page.
	"#jump{position:sticky;bottom:2px;align-self:center;z-index:2;width:34px;height:34px;border-radius:50%;font-size:16px;padding:0;display:flex;align-items:center;justify-content:center;background:var(--panel);border:1px solid var(--border);color:var(--text);box-shadow:0 2px 8px rgba(0,0,0,.45)}",
	"#jump[hidden]{display:none}",
].join("\n");

const CHAT_BODY = [
	'<div id="app">',
	'<header><span class="title">pi</span><span class="grow"></span>',
	'<span class="chip"><span class="dot off" id="dot"></span><span id="net">offline</span></span>',
	'<button class="ghost" id="newBtn" title="new session">new</button>',
	'<button class="ghost" id="stopBtn" disabled title="interrupt the agent">stop</button></header>',
	'<main id="scroller"><div id="log">',
	'<div class="empty" id="empty">Nothing here yet.<br>Message pi from the phone, or type on the desktop.</div>',
	'<button id="jump" type="button" hidden aria-label="jump to latest">↓</button>',
	"</div></main>",
	'<form id="composer">',
	'<textarea id="input" rows="1" placeholder="Message pi…" enterkeyhint="send" autocomplete="off"></textarea>',
	'<button id="send" disabled aria-label="Send">↑</button>',
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
	"  if (item.kind === 'text') return el('div', 'bubble assistant', item.text || '');",
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
	"    var body = item.text !== undefined ? item.text : item.output;",
	"    // first-write-wins mirrors the old build(): input is set once at tool",
	"    // start; a pre that never existed for a field is not conjured mid-turn.",
	"    if (item.input !== undefined && slot.node.preA && !slot.node.preA.textContent) slot.node.preA.textContent = item.input;",
	"    if (body !== undefined && slot.node.preA && !item.input) slot.node.preA.textContent = body;",
	"    if (body !== undefined && slot.node.preB) slot.node.preB.textContent = body;",
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
