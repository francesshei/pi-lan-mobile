// Dev-only: serve the phone pages on the LAN WITH a scripted fake bridge.
// Keyboard/viewport behavior and transcript styling need content to iterate
// on, so this loop skips pi restarts and pairing entirely: edit src/pages.ts,
// pull-to-refresh on the phone.
//
// The fake bridge is a faithful mirror of the real session.history contract
// (cursor model + reset snapshot on stale cursor, cf. src/stream.ts), but the
// transcript it streams is a SCRIPT: user bubbles, streaming thinking, a tool
// call that goes running -> done, another that errors and retries, turn-end
// info lines. Typing in the composer triggers a scripted reply turn; "new"
// replays the demo from the top.
//
// Security posture is unchanged: no pairing, no real pi access, no secrets,
// no state that matters. HTML + canned JSON only — kill it when done, it has
// no auth.
import http from "node:http";
import os from "node:os";
import { renderMobilePage, renderPairingWaitPage } from "../src/pages.ts";

const PORT = Number(process.env.PREVIEW_PORT ?? 8799);
const MAX_DELIVER = 50; // mirror of the real update-ring cap (per poll)

type Json = { [k: string]: unknown };

// Mirrors the TranscriptItem shape the page's reconciler consumes.
type Item = {
	key: string;
	kind: string; // user | text | info | thinking | tool
	text?: string;
	status?: string; // running | error | done
	toolName?: string;
	input?: string;
	output?: string;
};

type Ev = { at: number; item: Item };

let t0 = Date.now();
let events: Ev[] = [];
let seq = 0;
let turnCount = 0;

// Per-client cursor state, keyed by the pv cookie the page GETs on load
// (fetch sends it automatically; pages.ts stays dev-free). Two open tabs
// no longer reset each other; 'new' (session.create) bumps a generation
// counter so every client re-seeds from a snapshot on its next poll.
type Client = { lastStop: number; gen: number; seen: number };
const clients = new Map<string, Client>();
let globalGen = 0;

function mkKey(): string {
	return "p" + ++seq;
}

function push(at: number, item: Item): void {
	events.push({ at, item });
}

// Stream one text-bearing item: partial snapshots growing chunkChars at a
// time, stepMs apart. Returns the time just past the final snapshot.
function streamText(at: number, key: string, kind: string, full: string, chunkChars: number, stepMs: number): number {
	let i = 0;
	while (i < full.length) {
		i = Math.min(full.length, i + chunkChars);
		push(at, { key, kind, text: full.slice(0, i) });
		at += stepMs;
	}
	return at;
}

// Stream one tool item: running+input, partial outputs while running, then:
//  mode "error"  — land on ✕ and stay there (a settled screen shows the state)
//  mode "recover" — dwell on ✕, then retry succeeds to ✓ (the same-key
//                   error->done patch the in-place reconciler exists for)
function streamTool(
	at: number,
	key: string,
	toolName: string,
	input: string,
	outputLines: string[],
	stepMs: number,
	mode?: "error" | "recover",
): number {
	push(at, { key, kind: "tool", status: "running", toolName, input });
	at += stepMs * 2;
	let out = "";
	for (const line of outputLines) {
		out = out ? out + "\n" + line : line;
		push(at, { key, kind: "tool", status: "running", toolName, input, output: out });
		at += stepMs;
	}
	if (mode) {
		// dwell in error state (✕ glyph) before deciding the ending
		push(at, { key, kind: "tool", status: "error", toolName, input, output: out + "\n⨯ " + (mode === "error" ? "failed" : "retrying…") });
		at += stepMs * 3;
		if (mode === "error") return at;
	}
	push(at, { key, kind: "tool", status: "done", toolName, input, output: out });
	return at + stepMs;
}

function turnEnd(at: number, seconds: number): number {
	push(at, { key: mkKey(), kind: "info", text: `turn finished · ${seconds.toFixed(1)}s` });
	return at + 400;
}

// --- scripted turns ------------------------------------------------------

const T1_USER = "Give me a full transcript — every element kind needs a style to show.";
const T1_THINK =
	"The phone is blind without content. I should stream a thinking block here, a tool call that completes below, and later one that errors first — plus a long answer so the reader has to scroll and the jump-to-latest button appears.";
const T1_ANSWER =
	"Here is the whole surface of the chat page, streamed live through the real keyed reconciler.\n\nThe bubbles above and below are the two flanks of the transcript: yours pinned right, mine on the left with the panel border. The folded boxes in between are the step cards — thinking traces and tool calls — and they patch IN PLACE while tokens arrive, so scrolling inside one to read a long output survives the stream (a rebuilt node would jump you back to the top ~twice a second).\n\nOpen one. The header chip should have pulsed amber with 'working…' during the turn and settled back to 'connected' when the turn-end line landed. If you scrolled away from the bottom, the ↓ jump button rode along inside the scroller.\n\nNow type anything into the composer: a scripted reply turn arrives (it includes a tool call that errors ✕ and then recovers to ✓ — the retry is a same-key update, which is the case in-place patching exists for). 'new' reseeds the whole demo and every open client resets from a snapshot, which is the stale-cursor path in the real bridge too.";

// Error-path turn that plays without any interaction, so a fresh client
// still sees every state without having to type.
const T2_USER = "And the error states?";
const T2_OUT_BAD = ["GET https://api.internal:9999/status", "⨯ ECONNREFUSED 127.0.0.1:9999"];

function scriptDemo(): void {
	turnCount = 0;
	let t = 300;
	push(t, { key: mkKey(), kind: "user", text: T1_USER });
	t += 400;
	t = streamText(t, mkKey(), "thinking", T1_THINK, 22, 90);
	t += 150;
	t = streamTool(t, mkKey(), "bash", "npm test 2>&1 | tail -6", [
		"> pi-lan-mobile@0.1.0 test",
		"> node --test test/",
		"# tests 148",
		"# pass 148",
		"# fail 0",
	], 320);
	t += 200;
	t = streamTool(t, mkKey(), "read", "src/pages.ts · limit=40", [
		"// pi-lan-mobile phone pages.",
		"// Server-rendered single-file pages…",
	], 260);
	t += 150;
	t = streamText(t, mkKey(), "text", T1_ANSWER, 46, 130);
	t = turnEnd(t, 5.2);

	t += 1400;
	push(t, { key: mkKey(), kind: "user", text: T2_USER });
	t += 500;
	streamTool(t, mkKey(), "webfetch", "https://api.internal:9999/status", T2_OUT_BAD, 300, "error");
	const end = events[events.length - 1].at;
	push(end + 300, { key: mkKey(), kind: "info", text: "⚠ webfetch failed — the ✕ box above is that state" });
	push(end + 700, { key: mkKey(), kind: "info", text: "turn finished · 1.9s" });
}

// Composer submissions get a scripted turn too, so the working chip, stop
// button and in-place patching can be exercised interactively.
function scriptPromptTurn(text: string): void {
	const t = Date.now() - t0 + 150;
	push(t, { key: mkKey(), kind: "user", text });
	const reply = `Echoed into the void — this is a scripted reply so you can watch the working chip pulse while it streams, then land on the turn-end line. You said: ${JSON.stringify(text)}`;
	let t2 = t + 400;
	t2 = streamText(t2, mkKey(), "thinking", "Prompt received by the preview stub. There is no pi behind this; script a running tool, flip it to error, retry it, then stream the answer.", 24, 80);
	t2 = streamTool(t2, mkKey(), "bash", "echo " + text.slice(0, 60), ["(scripted) ok", "worktree: new-mobile-ui", "bridge: fake"], 350, "recover");
	t2 = streamText(t2 + 100, mkKey(), "text", reply, 40, 120);
	turnEnd(t2, 3.1);
	turnCount++;
}

function scriptCreate(): void {
	t0 = Date.now();
	events = [];
	globalGen++; // every client resets from a snapshot on its next poll
	scriptDemo();
}

// --- session.history: mirror of the real cursor contract -----------------
// Fresh/stale cursor -> { reset, items } snapshot; current cursor -> the
// contiguous run of updates whose scheduled time has come. Cursor never
// points past an undelivered event, so time-gating loses nothing.
function historySince(after: number, st: Client): Json {
	const now = Date.now() - t0;
	st.seen = Date.now();
	if (st.gen !== globalGen || after > events.length || after < st.lastStop) {
		let stop = 0;
		while (stop < events.length && events[stop].at <= now) stop++;
		const items: Item[] = [];
		const seen = new Map<string, number>();
		for (let i = 0; i < stop; i++) {
			const e = events[i];
			if (seen.has(e.item.key)) items[seen.get(e.item.key)!] = e.item;
			else {
				seen.set(e.item.key, items.length);
				items.push(e.item);
			}
		}
		st.lastStop = stop;
		st.gen = globalGen;
		return { cursor: stop, reset: true, items };
	}
	const updates: Json[] = [];
	let i = after;
	while (i < events.length && events[i].at <= now && updates.length < MAX_DELIVER) {
		updates.push({ cursor: i + 1, item: events[i].item });
		i++;
	}
	st.lastStop = i;
	return { cursor: i, updates };
}

function clientState(id: string): Client {
	const now = Date.now();
	let st = clients.get(id);
	if (!st) {
		if (clients.size > 50) for (const [k, v] of clients) if (now - v.seen > 10 * 60_000) clients.delete(k);
		st = { lastStop: -1, gen: -1, seen: now };
		clients.set(id, st);
	}
	return st;
}

function rpc(body: string, client: string): Json {
	const rpcClient = client;
	let req: Json;
	try {
		req = JSON.parse(body);
	} catch {
		return { ok: false, error: "preview: malformed json" };
	}
	const method = String(req.method ?? "");
	const payload = (req.payload ?? {}) as Json;
	switch (method) {
		case "workspace.list":
			return { ok: true, value: { root: "(preview)", workspaces: [{ name: "pi-lan-mobile · preview" }] } };
		case "session.list":
			return { ok: true, value: { current: "preview-session", sessions: [{ name: "preview-session" }] } };
		case "session.history": {
			const raw = Number(payload.after ?? 0);
			const after = Number.isFinite(raw) && raw >= 0 ? raw : 0;
			return { ok: true, value: historySince(after, clientState(rpcClient)) };
		}
		case "session.prompt": {
			const text = String(payload.text ?? "").trim();
			if (!text) return { ok: false, error: "preview: empty prompt" };
			scriptPromptTurn(text);
			return { ok: true, value: { dispatched: true } };
		}
		case "session.cancel":
			push(Date.now() - t0, { key: mkKey(), kind: "info", text: "⏹ interrupted (scripted)" });
			return { ok: true, value: { wasRunning: true } };
		case "session.create":
			scriptCreate();
			return { ok: true, value: { current: "preview-session" } };
		default:
			return { ok: false, error: `preview: method not scripted: ${method}` };
	}
}

// ------------------------------------------------------------------ server

const HTML_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'self'",
};

function readBody(request: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "";
		request.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
			if (text.length > 1_000_000) reject(new Error("body too large"));
		});
		request.on("end", () => resolve(text));
		request.on("error", reject);
	});
}

function cookieId(request: http.IncomingMessage): string {
	const raw = request.headers.cookie ?? "";
	for (const part of raw.split(";")) {
		const [k, v] = part.trim().split("=");
		if (k === "pv" && v) return v;
	}
	return "anon";
}

const server = http.createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://preview");
	const pageHeaders = (id: string) => ({ ...HTML_HEADERS, "set-cookie": `pv=${id}; Path=/; SameSite=Lax` });
	if (request.method === "GET" && url.pathname === "/pair") {
		response.writeHead(200, pageHeaders("pair" + ++seq));
		response.end(renderPairingWaitPage("preview-id"));
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/rpc") {
		readBody(request)
			.then((body) => {
				const result = rpc(body, cookieId(request));
				response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
				response.end(JSON.stringify(result));
			})
			.catch(() => {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: false, error: "preview: bad request" }));
			});
		return;
	}
	if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
		response.writeHead(200, pageHeaders("c" + ++seq));
		response.end(renderMobilePage());
		return;
	}
	response.writeHead(404, { "content-type": "text/plain" });
	response.end("not found\n");
});

scriptDemo();

server.listen(PORT, "0.0.0.0", () => {
	const ips: string[] = [];
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) ips.push(a.address);
	}
	const host = ips[0] ?? "127.0.0.1";
	console.log(`chat page preview (fake bridge, no pi behind it): http://${host}:${PORT}/`);
	console.log(`pairing wait page preview:                        http://${host}:${PORT}/pair`);
	console.log("the demo transcript streams on its own; composer prompts get scripted replies;");
	console.log("'new' replays the demo. edit src/pages.ts, then pull-to-refresh on the phone.");
});
