// TranscriptLog contract: monotonic cursor, ordered updates, stale-cursor
// reset, rebase forcing a client refresh across desktop session switches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptLog } from "../src/stream.ts";

test("since(after) returns ordered updates after cursor", () => {
	const log = new TranscriptLog();
	log.push({ key: "a", kind: "user", text: "hi" });
	log.push({ key: "b", kind: "text", text: "hello" });
	assert.equal(log.cursor, 2);

	let r = log.since(0);
	assert.equal(r.reset, undefined);
	assert.deepEqual(
		r.updates?.map((u) => u.item.key),
		["a", "b"],
	);

	r = log.since(2);
	assert.deepEqual(r.updates, []);
	assert.equal(r.cursor, 2);

	// Upsert by key: same key replaces the item map but stays in the update stream.
	log.push({ key: "b", kind: "text", text: "hello v2" });
	r = log.since(2);
	assert.equal(r.updates?.length, 1);
	assert.equal(r.updates?.[0].item.text, "hello v2");
	assert.equal(r.cursor, 3);
});

test("stale cursor triggers full reset", () => {
	const log = new TranscriptLog();
	for (let i = 0; i < 5; i++) log.push({ key: `k${i}`, kind: "info", text: String(i) });
	const r = log.since(-1);
	assert.equal(r.reset, true);
	assert.equal(r.items?.length, 5);
});

test("ring eviction: too-old cursor resets instead of lying", () => {
	const log = new TranscriptLog();
	for (let i = 0; i < 4005; i++) log.push({ key: `k${i}`, kind: "info", text: String(i) });
	const r = log.since(1); // cursor 4005, only last 4000 updates kept
	assert.equal(r.reset, true);
	const fresh = log.since(4005 - 3999);
	assert.equal(fresh.reset, undefined);
});

test("rebase: wipe + notice; any pre-rebase cursor forces client reset", () => {
	const log = new TranscriptLog();
	log.push({ key: "old", kind: "user", text: "from previous session" });
	log.rebase();
	const r = log.since(1); // client was up to date at cursor 1
	assert.equal(r.reset, true);
	assert.equal(r.items?.length, 1);
	assert.equal(r.items?.[0].kind, "info");
	assert.match(r.items?.[0].text ?? "", /new session/);
});
