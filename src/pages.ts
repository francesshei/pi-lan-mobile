// pi-lan-mobile phone pages.
//
// Server-rendered single-file pages, DSH-style: inline style/script only, no
// external assets (the CSP from the bridge forbids them anyway). Dynamic
// content is inserted via textContent/createElement, never innerHTML.
//
// Keep page-side JS backtick-free so these templates stay plain string arrays.

const PAGE_BASE_STYLE = [
	"*{box-sizing:border-box}",
	"body{margin:0;background:#0f1115;color:#e6e6e6;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding-bottom:120px}",
	"h1{font-size:15px;margin:0;font-weight:600}",
	"button{font:inherit;border:0;border-radius:10px;padding:8px 14px;background:#2f81f7;color:#fff;cursor:pointer}",
	"button.secondary{background:#262b36;color:#c9d1d9}",
	"button:disabled{opacity:.45}",
	".muted{color:#8b949e}",
	".dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#8b949e}",
	".dot.on{background:#3fb950}.dot.off{background:#f85149}.dot.wait{background:#d29922}",
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
		'"use strict";\n',
		script,
		"</script>",
		"</body></html>",
	].join("\n");
}

// ----------------------------------------------------------- pairing wait page

export function renderPairingWaitPage(id: string): string {
	const style = [
		PAGE_BASE_STYLE,
		"main{max-width:480px;margin:18vh auto 0;padding:0 20px;text-align:center}",
	].join("\n");

	const body = [
		'<main><h1><span class="dot wait" id="d"></span>Pairing <span id="s">waiting for the desktop…</span></h1>',
		'<p class="muted">Approve this phone in the pi terminal. This page refreshes itself.</p>',
		'<p><a href="/" style="color:#8b949e">Start over</a></p></main>',
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
	"header{position:sticky;top:0;background:#0f1115cc;backdrop-filter:blur(8px);display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #21262d;z-index:5}",
	"header .grow{flex:1}",
	"main{padding:12px 12px 0;display:flex;flex-direction:column;gap:10px}",
	".item{border-radius:12px;padding:9px 12px;max-width:94%;overflow-wrap:break-word}",
	".user{align-self:flex-end;background:#1f3b63}",
	".assistant{align-self:flex-start;background:#171b22;white-space:pre-wrap}",
	".thinking,.tool{align-self:stretch;background:#12151c;border:1px solid #21262d}",
	".thinking>summary,.tool>summary{cursor:pointer;color:#8b949e}",
	".tool .out{white-space:pre-wrap;color:#9da7b3;max-height:320px;overflow:auto;margin:6px 0 0}",
	".info{align-self:center;color:#8b949e;font-size:13px}",
	"form.composer{position:fixed;left:0;right:0;bottom:0;display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:#0f1115f2;border-top:1px solid #21262d}",
	"textarea{flex:1;font:inherit;background:#171b22;color:#e6e6e6;border:1px solid #30363d;border-radius:12px;padding:9px 12px;resize:none;max-height:140px}",
	"pre{margin:0;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}",
].join("\n");

const CHAT_BODY = [
	'<header><h1 class="grow">pi</h1>',
	'<span class="muted"><span class="dot off" id="dot"></span><span id="net">offline</span></span>',
	'<button class="secondary" id="newBtn" title="new session">new</button>',
	'<button class="secondary" id="stopBtn" title="interrupt the agent">stop</button></header>',
	"<main id=\"log\"></main>",
	'<form class="composer" id="composer">',
		'<textarea id="input" rows="1" placeholder="Message pi…" enterkeyhint="send" autocomplete="off"></textarea>',
		'<button id="send" disabled>send</button>',
	"</form>",
].join("\n");

const CHAT_SCRIPT = [
	"var log = document.getElementById('log'), byKey = {}, order = [], after = 0;",
	"var dot = document.getElementById('dot'), net = document.getElementById('net');",
	"var form = document.getElementById('composer'), input = document.getElementById('input'), send = document.getElementById('send');",
	"function net_(on, text) { dot.className = 'dot ' + (on ? 'on' : 'off'); net.textContent = text; }",
	"function rpc(method, payload) {",
	"  return fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' },",
	"    body: JSON.stringify({ method: method, payload: payload || {} }) }).then(function (r) { return r.json(); });",
	"}",
	"function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }",
	"function nearBottom() { return window.scrollY + window.innerHeight > document.body.scrollHeight - 160; }",
	"function build(item) {",
	"  if (item.kind === 'user') return el('div', 'item user', item.text || '');",
	"  if (item.kind === 'text') return el('div', 'item assistant', item.text || '');",
	"  if (item.kind === 'info') return el('div', 'item info', item.text || '');",
	"  if (item.kind === 'thinking') {",
	"    var d = document.createElement('details'); d.className = 'item thinking';",
	"    d.appendChild(el('summary', null, 'thinking'));",
	"    d.appendChild(el('pre', 'out', item.text || ''));",
	"    return d;",
	"  }",
	"  if (item.kind === 'tool') {",
	"    var t = document.createElement('details'); t.className = 'item tool';",
	"    var label = (item.status === 'running' ? '\\u25d0 ' : item.status === 'error' ? '\\u2717 ' : '\\u2713 ') + (item.toolName || 'tool');",
	"    t.appendChild(el('summary', null, label));",
	"    if (item.input) t.appendChild(el('pre', 'out', item.input));",
	"    if (item.output) t.appendChild(el('pre', 'out', item.output));",
	"    return t;",
	"  }",
	"  return el('div', 'item info', String(item.kind));",
	"}",
	"function apply(item) {",
	"  if (!byKey[item.key]) { order.push(item.key); byKey[item.key] = { node: build(item), item: item }; log.appendChild(byKey[item.key].node); }",
	"  else {",
	"    var slot = byKey[item.key];",
	"    if (slot.node.tagName === 'DIV' || slot.item.kind !== item.kind) {",
	"      var fresh = build(item); log.replaceChild(fresh, slot.node); slot.node = fresh;",
	"    } else {",
	"      var sum = slot.node.querySelector('summary');",
	"      if (sum) sum.textContent = (item.status === 'running' ? '\\u25d0 ' : item.status === 'error' ? '\\u2717 ' : '\\u2713 ') + (item.toolName || 'tool');",
	"      var pres = slot.node.querySelectorAll('pre');",
	"      while (pres.length) pres[pres.length - 1].remove();",
	"      if (item.text) slot.node.appendChild(el('pre', 'out', item.text));",
	"      if (item.input) slot.node.appendChild(el('pre', 'out', item.input));",
	"      if (item.output) slot.node.appendChild(el('pre', 'out', item.output));",
	"    }",
	"    slot.item = item;",
	"  }",
	"}",
	"function reset(items) { log.textContent = ''; byKey = {}; order = []; (items || []).forEach(apply); }",
	"function tick() {",
	"  rpc('session.history', { after: after }).then(function (r) {",
	"    if (!r.ok) { net_(false, r.error || 'error'); return; }",
	"    net_(true, 'connected');",
	"    var v = r.value || {};",
	"    if (v.reset) reset(v.items); else (v.updates || []).forEach(apply);",
	"    after = v.cursor;",
	"    if (nearBottom()) window.scrollTo({ top: document.body.scrollHeight });",
	"  }).catch(function () { net_(false, 'offline'); });",
	"}",
	"tick(); setInterval(tick, 1000);",
	"function submit(text) {",
	"  text = (text || '').trim(); if (!text) return;",
	"  send.disabled = true; input.value = '';",
	"  rpc('session.prompt', { text: text }).then(function (r) { if (!r.ok) net_(false, r.error || 'send failed'); tick(); });",
	"}",
	"form.addEventListener('submit', function (e) { e.preventDefault(); submit(input.value); });",
	"input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); } });",
	"input.addEventListener('input', function () { send.disabled = !input.value.trim(); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });",
	"document.getElementById('stopBtn').addEventListener('click', function () { rpc('session.cancel', {}); });",
	"document.getElementById('newBtn').addEventListener('click', function () { if (confirm('Start a new pi session?')) rpc('session.create', {}); });",
].join("\n");

export function renderMobilePage(): string {
	return pageShell("pi · mobile", CHAT_STYLE, CHAT_BODY, CHAT_SCRIPT);
}
