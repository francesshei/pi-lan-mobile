// Entry smoke test with a fake pi harness: command registration, subcommand
// branches, rebind idempotency. Needs `npm install` (imports the entry, which
// uses qrcode); the pure src contract tests stay dependency-free.

import { test } from "node:test";
import assert from "node:assert/strict";
import entry from "../extensions/pi-lan-mobile.ts";
import { getBridge } from "../src/bridge.ts";

interface FakeHandler {
	(event: unknown, ctx: unknown): unknown;
}

function makeFakePi() {
	const handlers = new Map<string, FakeHandler[]>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
	const sent: Array<{ text: string; options?: unknown }> = [];
	const pi = {
		on(event: string, handler: FakeHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		sendUserMessage(text: string, options?: unknown) {
			sent.push({ text, options });
			return Promise.resolve();
		},
	};
	return { pi: pi as any, handlers, commands, sent };
}

function makeFakeCtx(notices: string[] = []) {
	return {
		isIdle: () => true,
		sessionManager: { getSessionFile: () => undefined },
		ui: {
			notify: (text: string) => notices.push(text),
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
		},
		newSession: async () => ({ cancelled: false }),
	};
}

test("entry registers /mobile and is rebind-idempotent", () => {
	const { pi, commands, handlers } = makeFakePi();
	entry(pi);
	const bridge = getBridge();
	assert.ok(bridge.handlers, "bridge handlers configured");
	assert.ok(commands.has("mobile"));
	assert.ok(handlers.has("session_start") && handlers.has("agent_end"));
	const tappedBefore = (globalThis as any).__piLanMobileLog;
	entry(pi); // simulate rebind
	assert.equal((globalThis as any).__piLanMobileLog, tappedBefore, "shared log reused, tap not doubled");
});

test("subcommand branches: usage warning, create, off", async () => {
	const { pi, commands } = makeFakePi();
	entry(pi);
	const command = commands.get("mobile")!;
	const bridge = getBridge();

	const notices: string[] = [];
	const ctx = makeFakeCtx(notices);

	await command.handler("bogus", ctx);
	assert.match(notices.at(-1) ?? "", /Usage: \/mobile/);

	notices.length = 0;
	await command.handler("create", ctx);
	assert.match(notices.at(-1) ?? "", /New session started/);

	// off stops the bridge even if it wasn't started (no throw) and notifies.
	await bridge.start();
	assert.equal(bridge.snapshot().running, true);
	await command.handler("off", ctx);
	assert.equal(bridge.snapshot().running, false);
	assert.match(notices.at(-1) ?? "", /closed/i);
});

test("session.create dispatches the sanctioned /mobile create command", async () => {
	const { pi, commands, sent } = makeFakePi();
	entry(pi);
	void commands;
	const log = (globalThis as any).__piLanMobileLog;
	const { createRpcHandler } = await import("../src/rpc.ts");
	const handler = createRpcHandler({
		getPi: () => pi,
	getCtx: () => makeFakeCtx() as any,
		log,
	});
	const result: any = await handler("session.create", {});
	assert.equal(result.ok, true);
	assert.equal(sent.at(-1)?.text, "/mobile create");
	assert.deepEqual(sent.at(-1)?.options, { expandPromptTemplates: true, deliverAs: "steer" });
});

test("pairing widget is a component factory that survives pi's 10-line string cap", async () => {
	const { pi, commands } = makeFakePi();
	entry(pi);
	const widgets: Array<{ key: string; content: unknown }> = [];
	const ctx = {
		...makeFakeCtx(),
		ui: {
			...makeFakeCtx().ui,
			setWidget: (key: string, content: unknown) => {
				widgets.push({ key, content });
			},
		},
	};
	await commands.get("mobile")!.handler("", ctx as any);
	const set = widgets.find((w) => w.key === "pi-lan-mobile" && typeof w.content === "function");
	assert.ok(set, "/mobile must set a component widget (not a string array)");
	const factory = set!.content as (tui: unknown, theme: unknown) => { render(w: number): string[]; invalidate(): void };
	const component = factory(undefined, undefined);

	const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
	const full = component.render(80);
	assert.ok(full.length > 11, `full QR height exceeds the 10-line string cap (got ${full.length} lines)`);
	assert.ok(full.some((l) => l.includes("\u2584") || l.includes("\u2580")), "QR block characters render");
	assert.ok(full.at(-1)?.includes("http"), "pairing URL is the last line");
	assert.ok(full.every((l) => stripAnsi(l).length <= 80), "no line overflows the width");

	// Narrow pane: ANSI-aware fit, escape sequences never spill as garbage.
	const narrow = component.render(30);
	assert.ok(narrow.every((l) => stripAnsi(l).length <= 30), "narrow width respected");
	component.invalidate(); // must exist and not throw (theme-change contract)
	await (await import("../src/bridge.ts")).getBridge().stop();
});
