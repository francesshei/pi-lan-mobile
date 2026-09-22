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
