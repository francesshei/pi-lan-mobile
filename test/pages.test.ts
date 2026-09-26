// Pages contract: the phone page must stay a self-contained, parseable,
// keyboard-safe document. These assertions guard the Safari fixes (focus zoom,
// keyboard-pan anchoring, post-event settle, IME Enter, tap-to-dismiss) so they
// cannot silently regress. Pure and static: runs under plain `node --test`
// with zero node_modules.
import test from "node:test";
import assert from "node:assert/strict";
import { renderMobilePage, renderPairingWaitPage } from "../src/pages.ts";

function parts(page: string) {
	const style = page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
	const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
	return { style, script };
}

test("page JS is backtick-free and parses", () => {
	for (const page of [renderMobilePage(), renderPairingWaitPage("id-1")]) {
		const { script } = parts(page);
		assert.ok(!script.includes("`"), "no backticks in page JS");
		assert.doesNotThrow(() => new Function(script), "page JS compiles");
	}
});

test("CSS carries no // comment lines (the parser eats the following rule)", () => {
	for (const page of [renderMobilePage(), renderPairingWaitPage("id-2")]) {
		const { style } = parts(page);
		for (const line of style.split("\n")) {
			assert.ok(!line.trim().startsWith("//"), `bad CSS comment line: ${line}`);
		}
	}
});

test("Safari keyboard contract on the chat page", () => {
	const { style, script } = parts(renderMobilePage());
	// Focus zoom: Safari zooms the page when a focused field's font is < 16px.
	assert.match(style, /textarea\{[^}]*font-size:16px/, "textarea is 16px");
	// Keyboard pan: fit() anchors #app with the visual viewport's height AND
	// its offsetTop (the pan is not document scroll and cannot be scrollTo'd).
	assert.match(script, /vv\.offsetTop/, "fit reads offsetTop");
	assert.match(script, /app\.style\.transform = top \? 'translateY\(/, "fit compensates the pan");
	// Safari settles the pan AFTER the last visualViewport event: fit must
	// keep re-reading the viewport on frames until it is still.
	assert.match(script, /fit\.quiet/, "fit re-polls after the last event");
	assert.match(script, /visualViewport\.addEventListener\('scroll', fit\)/, "fit hears vv scroll, not only resize");
	// Focus and blur are the pan's cause and its end.
	assert.match(script, /input\.addEventListener\('focus', fit\)/, "fit on focus");
	assert.match(script, /input\.addEventListener\('blur', fit\)/, "fit on blur");
	// IME: Enter confirming a candidate is not a send.
	assert.match(script, /!e\.isComposing/, "IME Enter guarded");
	// Safari only hides the keyboard via 'Done'; a tap on the transcript blurs.
	assert.match(script, /input\.blur\(\)/, "tap dismisses the keyboard");
	// Keyboard OPEN must reveal the message being answered: a significant
	// viewport shrink forces the scroller to the latest message even when the
	// tall pre-keyboard viewport had the reader parked at the top of the log.
	assert.match(script, /fit\.prev - h > 150\) scrollBottom\(\)/, "keyboard-open forces scroll to bottom");
});

test("dynamic content only ever arrives via textContent", () => {
	const { script } = parts(renderMobilePage());
	assert.ok(!script.includes("innerHTML"), "no innerHTML in chat page JS");
});

test("streaming patches details nodes in place (reading scroll survives tokens)", () => {
	// Regression: same-kind updates used to replaceChild the whole details box;
	// a fresh <pre> starts at scrollTop 0, so reading a streaming thinking box
	// jumped to the top on every update. Same-kind updates must now patch the
	// existing summary/pre nodes and touch nothing else.
	const { script } = parts(renderMobilePage());
	assert.match(script, /tagName === 'DETAILS'\) \{\s*\n[^]*?\.textContent = /, "details branch patches via textContent");
	const applyBody = script.slice(script.indexOf("function apply(item)"));
	const applyFn = applyBody.slice(0, applyBody.indexOf("\n}") + 2);
	const afterKindSwap = applyFn.split("kind !== item.kind")[1] ?? "";
	const detailsBranch = afterKindSwap.split("tagName === 'DETAILS'")[1] ?? "";
	assert.ok(detailsBranch.length > 0, "the DETAILS patch branch exists");
	assert.ok(!/replaceChild/.test(detailsBranch), "no node swap on the same-kind path");
});

test("jump-to-latest button contract", () => {
	const { script } = parts(renderMobilePage());
	assert.match(script, /function updateJump\(\) \{ jump\.hidden = !!empty\.parentNode \|\| nearBottom\(\); \}/, "visibility has one owner");
	assert.match(script, /scroller\.addEventListener\('scroll', updateJump\)/, "manual scroll reveals it");
	assert.match(script, /jump\.addEventListener\('click', function \(\) \{ scrollBottom\(\)/, "click jumps to latest");
	assert.match(script, /updateJump\(\);/, "content arrival re-evaluates it");
});

// --- executable harness ------------------------------------------------------
// Static regexes cannot catch SCOPE bugs. The tool branch once swallowed the
// nodes()/refresh() definitions and referenced a lost `glyph`: strict mode
// block-scoped them, so apply() threw ReferenceError the moment the first
// transcript item rendered — and tick's .catch dressed that crash up as
// "offline" while the bridge sat happily connected. These tests RUN the page
// JS against a minimal DOM so every item kind actually executes.

function makeEl(tag: string) {
	const el: any = {
		tagName: tag.toUpperCase(),
		className: "",
		style: {},
		children: [] as any[],
		parentNode: null as any,
		hidden: false,
		disabled: false,
		open: false,
		value: "",
		scrollTop: 0,
		scrollHeight: 1000,
		clientHeight: 200,
		scrollWidth: 100,
		scrollLeft: 0,
		listeners: [] as string[],
		addEventListener(type: string) {
			el.listeners.push(type);
		},
		appendChild(child: any) {
			el.children.push(child);
			child.parentNode = el;
			return child;
		},
		replaceChild(next: any, old: any) {
			const i = el.children.indexOf(old);
			if (i >= 0) el.children[i] = next;
			next.parentNode = el;
			old.parentNode = null;
			return next;
		},
		removeChild(child: any) {
			const i = el.children.indexOf(child);
			if (i >= 0) el.children.splice(i, 1);
			child.parentNode = null;
			return child;
		},
		getElementsByTagName(name: string) {
			const found: any[] = [];
			const walk = (node: any) => {
				for (const child of node.children) {
					if (child.tagName === name.toUpperCase()) found.push(child);
					walk(child);
				}
			};
			walk(el);
			return found;
		},
		closest() {
			return null;
		},
		attrs: {} as Record<string, string>,
		// the page script stashes scroll position on classList during same-kind
		// text patches; the fake needs the slot to exist.
		classList: {} as Record<string, any>,
		setAttribute(k: string, v: string) {
			el.attrs[k] = v;
		},
		blur() {},
	};
	let text = "";
	// Real textContent AGGREGATES descendant text; the getter must, or table/th
	// cells (filled via text leaves) read empty and lie about what rendered.
	const textOf = (n: any): string =>
		n.children && n.children.length
			? n.children.map(textOf).join("")
			: n.tagName === "#text"
				? n.text
				: n.textContent;
	Object.defineProperty(el, "textContent", {
		get: () => (el.children.length ? el.children.map(textOf).join("") : text),
		// Real DOM: assigning textContent replaces ALL children with one text
		// node. reset() leans on this (log.textContent = ""), so mirror it.
		set: (v: string) => {
			text = String(v);
			if (text === "") el.children = [];
		},
	});
	Object.defineProperty(el, "firstChild", { get: () => el.children[0] ?? null });
	return el;
}

async function runPage() {
	const { script } = parts(renderMobilePage());
	const els = new Map<string, any>();
	for (const id of ["app", "scroller", "log", "dot", "net", "composer", "input", "send", "stopBtn", "jump", "newBtn", "empty"]) {
		els.set(id, makeEl(id === "composer" ? "form" : "div"));
	}
	const log = els.get("log");
	const empty = els.get("empty");
	log.appendChild(empty);
	const doc = {
		getElementById: (id: string) => els.get(id) ?? null,
		createElement: (tag: string) => makeEl(tag),
		// md()/inl() text leaves arrive as text nodes, never as html strings.
		createTextNode: (t: string) => ({ tagName: "#text", text: String(t), children: [], parentNode: null }),
		activeElement: null,
	};
	const env = {
		document: doc,
		window: { innerHeight: 800, addEventListener() {} },
		fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: { cursor: 0, updates: [] } }) }),
		setInterval: () => 0,
		clearInterval: () => {},
		requestAnimationFrame: () => 0,
		confirm: () => false,
	};
	// Expose the internals the test drives; `state()` reads the LIVE vars.
	const body = `${script}\nreturn { apply: apply, tick: tick, state: function () { return { netOk: netOk, working: working }; } };`;
	const run = new Function("document", "window", "fetch", "setInterval", "clearInterval", "requestAnimationFrame", "confirm", body);
	const api = run(env.document, env.window, env.fetch, env.setInterval, env.clearInterval, env.requestAnimationFrame, env.confirm);
	await new Promise((resolve) => setTimeout(resolve, 0)); // let the load-time tick() settle
	return { api, els };
}

test("page JS executes: a healthy first tick renders connected", async () => {
	const { api, els } = await runPage();
	assert.equal(api.state().netOk, true, "load-time tick succeeded");
	assert.equal(els.get("net").textContent, "connected");
	assert.equal(els.get("dot").className, "dot on");
});

test("every transcript item kind renders without throwing", async () => {
	const { api, els } = await runPage();
	// The exact item sequence of a first phone message with one tool call.
	// Under the swallowed-scope bug each of these threw ReferenceError.
	const items = [
		{ key: "user:1", kind: "user", text: "Testing" },
		{ key: "a1:thinking", kind: "thinking", text: "hmm, a greeting" },
		{ key: "a1:thinking", kind: "thinking", text: "hmm, a greeting, longer" }, // same-kind details patch (refresh path)
		{ key: "a1:text", kind: "text", text: "hi there" },
		{ key: "tool:1", kind: "tool", toolName: "bash", status: "running", input: '{"command":"ls"}' },
		{ key: "tool:1", kind: "tool", status: "running", output: "partial data" }, // patch with no toolName pre on this update
		{ key: "tool:1", kind: "tool", toolName: "bash", status: "done", output: "file1\nfile2" },
		{ key: "info:1", kind: "info", text: "turn finished" },
	];
	for (const item of items) api.apply(item);
	assert.equal(api.state().netOk, true, "rendering never flips network state");
	assert.equal(els.get("net").textContent, "connected");
	// The tool box summary went running ◐ → done ✓ via in-place refresh, and a
	// thinking box survived alongside it.
	const details = els.get("log").getElementsByTagName("details");
	assert.equal(details.length, 2, "thinking and tool boxes rendered");
	assert.match(details[1].children[0].textContent, /bash\s+✓/, "tool summary refreshed");
});

test("offline has one owner: render crashes cannot pose as network loss", () => {
	const { script } = parts(renderMobilePage());
	// A .catch after the handler also catches exceptions the handler THROWS;
	// that is how a broken renderer looked like a disconnected phone.
	assert.ok(!/\.catch\(function \(\) \{ netOk = false/.test(script), "tick must not flip offline via .catch");
	assert.match(script, /chip\(\);\n\s*\}, function \(\) \{ netOk = false; chip\(\); \}\);/, "offline lands only in the two-arg then rejection arm");
	// Scope guard for the specific regression: nodes/refresh are top-level
	// siblings of build(), not swallowed into a branch of it.
	assert.match(script, /String\(item\.kind\)\);\n\}\nfunction nodes\(item\) \{/, "nodes is top-level after build");
	assert.match(script, /\nfunction refresh\(e, item\) \{/, "refresh is top-level");
	assert.match(script, /var glyph = item\.status/, "the status glyph is defined where it is used");
});

test("assistant text renders markdown as nodes; hrefs are scheme-gated", async () => {
	const { api, els } = await runPage();
	api.apply({
		key: "a1:text",
		kind: "text",
		text:
			"# Title\nsome **bold** *em* `code` and [ok](https://example.com) plus [bad](javascript:alert(1))\n\n```js\nvar fence = 1;\n```\n\n> quoted line\n\n- first\n- second\n\n1. one\n\n| step | ms |\n|---|:-:|\n| parse | 12 |\n| **render** | 4 |",
	});
	const flat: any[] = [];
	const walk = (n: any) => {
		for (const c of n.children) {
			flat.push(c);
			walk(c);
		}
	};
	walk(els.get("log"));
	// fake DOM tagName is uppercased (like the real one)
	const byTag = (t: string) => flat.filter((n) => n.tagName === t.toUpperCase());
	// Inline formatting is built from createElement + text leaves only.
	assert.equal(byTag("strong")[0].textContent, "bold", "bold leaf");
	assert.equal(byTag("em")[0].textContent, "em", "em leaf");
	assert.equal(byTag("code")[0].textContent, "code", "inline code");
	// Links: only http(s)/mailto become anchors; javascript: stays plain text.
	const as = byTag("a");
	assert.equal(as.length, 1, "javascript: never becomes a link");
	assert.equal(as[0].attrs.href, "https://example.com");
	assert.equal(as[0].attrs.rel, "noopener noreferrer");
	assert.ok(!flat.some((n) => /javascript:/i.test(n.attrs?.href ?? "")), "no javascript: href anywhere");
	const txt = flat.filter((n) => n.tagName === "#text").map((n: any) => n.text).join("");
	assert.match(txt, /bad \(javascript:alert\(1\)\)/, "denied link shows its target");
	// Blocks: fence, heading, quote, lists.
	assert.match(byTag("pre")[0].textContent, /var fence = 1;/, "fenced block");
	assert.ok(flat.some((n) => n.className === "mdh mdh1"), "heading block");
	assert.ok(flat.some((n) => n.className === "mdq"), "quote block");
	assert.equal(byTag("ul").length, 1, "bullet list");
	assert.equal(byTag("ol").length, 1, "ordered list");
	assert.equal(byTag("li").length, 3, "two bullets + one ordered item");
	// Table: header row + |---| delimiter + body rows, cells inline-parsed,
	// wrapped in a horizontal scroller.
	assert.equal(byTag("table").length, 1, "one table");
	assert.equal(byTag("th").length, 2, "two header cells");
	assert.equal(byTag("th")[1].textContent, "ms", "header leaf");
	assert.equal(byTag("td").length, 4, "two body rows of two cells");
	assert.equal(byTag("tr").length, 3, "header row + two body rows");
	const cellStrong = byTag("strong").filter((n: any) => n.parentNode && n.parentNode.tagName === "TD");
	assert.equal(cellStrong.length, 1, "cells run through the inline parser");
	assert.ok(flat.some((n) => n.className === "mdtsv"), "table wrapped in a horizontal scroller");
	const tw = flat.find((n) => n.className === "mdtsv");
	assert.ok(tw.listeners.indexOf("scroll") >= 0, "scroller remembers drag position");
});

test("streaming text patches churn children, never the bubble node", async () => {
	// The details boxes must not be the only scroll-safe surface: a text bubble
	// owns no inner scroller, so same-kind patches may rebuild its CHILDREN —
	// but the bubble element itself must keep its identity in the log.
	const { api, els } = await runPage();
	api.apply({ key: "a1:text", kind: "text", text: "half **bo" });
	const bubble = els.get("log").children.find((c: any) => /bubble/.test(c.className));
	api.apply({ key: "a1:text", kind: "text", text: "half **bold**" });
	const again = els.get("log").children.find((c: any) => /bubble/.test(c.className));
	assert.equal(again, bubble, "bubble node identity survives the patch");
	const strongs: any[] = [];
	const walk = (n: any) => { for (const c of n.children) { if (c.tagName === "STRONG") strongs.push(c); walk(c); } };
	walk(bubble);
	assert.equal(strongs.length, 1, "children rebuild without accumulating duplicates");
});

test("a table arriving mid-stream upgrades the bubble, never duplicates blocks", async () => {
	// A table's header line appears BEFORE its |---| delimiter exists, so the
	// streaming bubble briefly shows it as a paragraph; every later token
	// rebuilds the children and the row upgrades to a real table. This test
	// pins that path: after the full text lands, a chunk-streamed render must
	// equal a single full render — one table, same block count.
	const full = "# Title\nsome **bold** text\n\n| a | b |\n|---|---|\n| 1 | 2 |";
	const { api, els } = await runPage();
	let txt = "";
	for (let c = 17; c < full.length; c += 29) {
		txt = full.slice(0, c);
		api.apply({ key: "a1:text", kind: "text", text: txt });
	}
	api.apply({ key: "a1:text", kind: "text", text: full });
	const ref = await runPage();
	ref.api.apply({ key: "a1:text", kind: "text", text: full });
	const bubbleOf = (e: any) =>
		e.get("log").children.find((c: any) => /bubble/.test(c.className));
	const b1 = bubbleOf(els);
	assert.ok(b1, "bubble exists");
	const count = (n: any, tag: string) => {
		let k = 0;
		const w = (x: any) => { for (const c of x.children) { if (c.tagName === tag) k++; w(c); } };
		w(n);
		return k;
	};
	assert.equal(count(b1, "TABLE"), 1, "header ended up a table, not a stray paragraph");
	assert.equal(b1.children.length, bubbleOf(ref.els).children.length, "chunk stream yields the same blocks as a full render");
});

test("markdown renderer respects the page contracts it lives under", () => {
	const { script } = parts(renderMobilePage());
	assert.match(script, /String\.fromCharCode\(96\)/, "the backtick enters only as a charcode");
	assert.match(script, /function safeHref/, "link schemes pass a gate");
	assert.ok(!/\.href\s*=/.test(script), "href is set via setAttribute, never property-cast");
	assert.ok(!/insertAdjacentHTML|outerHTML/.test(script), "no html-string sink besides none");
	const renders = script.match(/md\(item\.text \|\| ''\)\.forEach/g) ?? [];
	assert.equal(renders.length, 2, "build and the same-kind text patch share the renderer");
});
