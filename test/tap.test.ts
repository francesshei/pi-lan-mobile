// pi event tap contract: the phone must receive the COMPLETE thinking block.
// message_update is throttled, so message_end carries an unthrottled final
// snapshot sharing the same keys. Regression: v1 bug where the phone's
// thinking text froze at whatever the last throttled poll happened to catch.
// Pure and static: runs under plain `node --test` with zero node_modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptLog, tapPiEvents } from "../src/stream.ts";

type Handler = (event: any) => Promise<void> | void;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	return {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		async emit(name: string, event: any) {
			for (const handler of handlers.get(name) ?? []) await handler(event);
		},
	};
}

test("message_end finalizes thinking even when throttle dropped tail updates", async () => {
	const log = new TranscriptLog();
	const pi = fakePi();
	tapPiEvents(pi as any, log);

	await pi.emit("message_start", { message: { role: "assistant", content: [] } });
	// First update passes the throttle window and captures a partial snapshot.
	await pi.emit("message_update", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "partial thi" }] },
	});
	// Immediately after: throttled, so this fuller snapshot is dropped by design.
	await pi.emit("message_update", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "partial thinking, fully streamed" }] },
	});
	// The unthrottled end snapshot must restore the complete block.
	await pi.emit("message_end", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "partial thinking, fully streamed" }] },
	});

	const thinking = [...log.items.values()].filter((item) => item.kind === "thinking");
	assert.equal(thinking.length, 1, "one thinking item, upserted by key");
	assert.equal(thinking[0].text, "partial thinking, fully streamed");
});

test("end snapshot upserts the same keys the stream updates used", async () => {
	const log = new TranscriptLog();
	const pi = fakePi();
	tapPiEvents(pi as any, log);

	await pi.emit("message_start", { message: { role: "assistant", content: [] } });
	await pi.emit("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "start of answer" }] },
	});
	const streamCursor = log.cursor;
	await pi.emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "start of answer, completed" }] },
	});

	const updates = log.since(streamCursor).updates ?? [];
	const finals = updates.filter((u) => u.item.key === "a1:text");
	assert.equal(finals.length, 1, "final text replaces by key, no duplicate item");
	assert.equal(log.items.get("a1:text")?.text, "start of answer, completed");
});
