// Manual check (not a suite file): TUI pairing widget collapses to one line
// when a phone is connected and shows the full QR again when it is not.
import entry from "/Users/francescosheiban/Developer/Projects/pi-lan-mobile/extensions/pi-lan-mobile.ts";
import { getBridge } from "/Users/francescosheiban/Developer/Projects/pi-lan-mobile/src/bridge.ts";
import assert from "node:assert/strict";

const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
let current: unknown;
const pi = {
	on: () => {},
	registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
		commands.set(name, options);
	},
	sendUserMessage: () => Promise.resolve(),
};
entry(pi as never);

const ctx = {
	isIdle: () => true,
	sessionManager: { getSessionFile: () => undefined },
	ui: {
		notify: () => {},
		setStatus: () => {},
		setWidget: (_key: string, content: unknown) => { current = content; },
		confirm: async () => true,
	},
	newSession: async () => ({ cancelled: false }),
};

await commands.get("mobile")!.handler("", ctx);
assert.equal(typeof current, "function", "component factory widget");
const bridge = getBridge();

const full = (current as (t: unknown, th: unknown) => { render(w: number): string[] })(undefined, undefined).render(80);
assert.ok(full.length > 11, `full QR widget is tall when unconnected (${full.length} lines)`);
assert.ok(full.some((l) => l.includes("pair your phone")), "prompt line present");

// A phone connects (sessions map is what snapshot().connected reads).
bridge.sessions.set("tok", { token: "tok" });
const collapsed = (current as (t: unknown, th: unknown) => { render(w: number): string[] })(undefined, undefined).render(80);
assert.equal(collapsed.length, 1, `collapsed to one line when connected (${collapsed.length} lines)`);
assert.match(collapsed[0] ?? "", /phone connected/);
assert.match(collapsed[0] ?? "", /\/mobile/);

// Phone disconnects (disconnectAll / stop revokes sessions): QR returns.
bridge.disconnectAll();
const again = (current as (t: unknown, th: unknown) => { render(w: number): string[] })(undefined, undefined).render(80);
assert.ok(again.length > 11, "full QR restored after disconnect");

await bridge.stop();
console.log("widget collapse/expand contract: OK");
