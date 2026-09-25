// Contract tests for the bridge: pairing lifecycle, network policy, allowlist,
// single-session semantics. Ports the LanMobileBridge acceptance cases from
// DSH Desktop's test file, minus the removed desktop routes (SR-2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge, isPrivateAddress, normalizeRemoteAddress, type BridgeSnapshot } from "../src/bridge.ts";

function makeBridge(now?: () => number): Bridge {
	const bridge = new Bridge({ now });
	bridge.configure({
		rpc: async (method, payload) => ({ ok: true, value: { method, payload } }),
		onPairingRequested: () => {},
	});
	return bridge;
}

function tokenOf(snap: BridgeSnapshot): string {
	assert.ok(snap.pairingUrl, "expected a pairing URL");
	return new URL(snap.pairingUrl).searchParams.get("token") ?? "";
}

/** Full pairing: scan current link, approve in-process, return session cookie string. */
async function pairPhone(bridge: Bridge, base: string): Promise<string> {
	const token = tokenOf(bridge.snapshot());
	const scan = await fetch(`${base}/pair?token=${token}`);
	assert.equal(scan.status, 200);
	const id = bridge.pendingRequests()[0].id;
	bridge.decide(id, true);
	const res = await fetch(`${base}/pair/status?id=${id}`);
	assert.deepEqual(await res.json(), { approved: true });
	const cookie = res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	assert.ok(cookie.startsWith("pi_lan_mobile="), "HttpOnly session cookie expected");
	return cookie;
}

test("pairing lifecycle: scan -> approve -> cookie -> rpc -> stop revokes", async () => {
	const bridge = makeBridge();
	const snap = await bridge.start();
	assert.ok(snap.running && snap.port && snap.pairingUrl);
	const base = `http://127.0.0.1:${snap.port}`;
	const token = tokenOf(snap);

	// Wrong token is rejected with 401 (SR-3/4).
	let res = await fetch(`${base}/pair?token=nope`);
	assert.equal(res.status, 401);

	// Valid token files a pending request and shows the wait page.
	res = await fetch(`${base}/pair?token=${token}`);
	assert.equal(res.status, 200);
	assert.match(await res.text(), /waiting for the desktop/);
	const id = bridge.pendingRequests()[0].id;

	// Poll before decision: pending.
	res = await fetch(`${base}/pair/status?id=${id}`);
	assert.deepEqual(await res.json(), { pending: true });

	// Deny path deletes the pending (natural retry semantics).
	bridge.decide(id, false);
	res = await fetch(`${base}/pair/status?id=${id}`);
	assert.deepEqual(await res.json(), { denied: true });

	// Approve a fresh scan; capture cookie.
	const cookie = await pairPhone(bridge, base);
	const auth = { headers: { cookie } };

	// Chat page + status are reachable with the cookie.
	res = await fetch(`${base}/`, auth);
	assert.equal(res.status, 200);
	assert.match(await res.text(), /Message pi/);
	res = await fetch(`${base}/api/status`, auth);
	assert.deepEqual(await res.json(), { connected: true });

	// Allowlisted RPC dispatches to the handler.
	res = await fetch(`${base}/api/rpc`, {
		method: "POST",
		headers: { cookie, "content-type": "application/json", origin: base },
		body: JSON.stringify({ method: "session.history", payload: { after: 0 } }),
	});
	assert.equal(res.status, 200);
	assert.equal((await res.json()).value.method, "session.history");

	// Non-allowlisted methods: 403 with the curation message (the core of it).
	for (const method of ["bash.exec", "fs.read", "settings.get", "", null, 42]) {
		res = await fetch(`${base}/api/rpc`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json", origin: base },
			body: JSON.stringify({ method }),
		});
		assert.equal(res.status, 403, `expected 403 for ${String(method)}`);
		assert.equal((await res.json()).error, "RPC method is not available on mobile.");
	}

	// Cross-origin POST is rejected fail-closed (SR-7).
	res = await fetch(`${base}/api/rpc`, {
		method: "POST",
		headers: { cookie, "content-type": "application/json", origin: "http://evil.example" },
		body: JSON.stringify({ method: "session.history" }),
	});
	assert.equal(res.status, 500);

	// Unauthenticated access is refused.
	res = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(res.status, 401);

	// No desktop routes exist over HTTP at all (SR-2).
	for (const route of ["/desktop", "/desktop/pending", "/desktop/decide", "/desktop/disconnect"]) {
		res = await fetch(`${base}${route}`, auth);
		assert.equal(res.status, 404, `${route} must not exist`);
	}

	// Stop revokes everything.
	await bridge.stop();
	await assert.rejects(fetch(`${base}/api/status`, auth));
});

test("pairing token expires by TTL", async () => {
	let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
	const bridge = makeBridge(() => nowMs);
	const snap = await bridge.start();
	const base = `http://127.0.0.1:${snap.port}`;
	const token = tokenOf(snap);

	nowMs += 5 * 60 * 1000 + 1; // past the 300s TTL
	const res = await fetch(`${base}/pair?token=${token}`);
	assert.equal(res.status, 401);
	await bridge.stop();
});

test("approval consumes the pairing token; re-running start() rotates (DSH parity)", async () => {
	const bridge = makeBridge();
	const snap = await bridge.start();
	const base = `http://127.0.0.1:${snap.port}`;
	const token = tokenOf(snap);

	await pairPhone(bridge, base);

	// Token consumed by the approval (SR-3 single-use).
	const res = await fetch(`${base}/pair?token=${token}`);
	assert.equal(res.status, 401);

	// Re-running /mobile while running rotates the link and drops pendings.
	const snap2 = await bridge.start();
	assert.ok(snap2.pairingUrl && snap2.pairingUrl !== snap.pairingUrl);
	await bridge.stop();
});

test("single paired phone: new approval kicks the old one (SR-9)", async () => {
	const bridge = makeBridge();
	const snap = await bridge.start();
	const base = `http://127.0.0.1:${snap.port}`;

	const cookieA = await pairPhone(bridge, base);

	// Second phone needs a rotated link (first approval consumed it): the /mobile
	// re-run path.
	await bridge.start();
	const cookieB = await pairPhone(bridge, base);

	let res = await fetch(`${base}/api/status`, { headers: { cookie: cookieA } });
	assert.equal(res.status, 401, "old phone must be revoked");
	res = await fetch(`${base}/api/status`, { headers: { cookie: cookieB } });
	assert.deepEqual(await res.json(), { connected: true });

	// disconnectAll kills everything but keeps the server up with a fresh link.
	bridge.disconnectAll();
	res = await fetch(`${base}/api/status`, { headers: { cookie: cookieB } });
	assert.equal(res.status, 401);
	assert.ok(bridge.snapshot().pairingUrl, "fresh pairing link after disconnectAll");
	await bridge.stop();
});

test("network policy matrix (SR-1)", () => {
	const cases: Array<[string, boolean]> = [
		["127.0.0.1", true],
		["::1", true],
		["10.1.2.3", true],
		["192.168.0.10", true],
		["172.16.0.1", true],
		["172.31.255.255", true],
		["172.32.0.1", false],
		["172.15.0.1", false],
		["8.8.8.8", false],
		["100.64.0.1", false], // CGNAT (Tailscale) range is NOT trusted by this policy as-is
		["fc00::1", true],
		["fe80::1", true],
		["2001:4860::8888", false],
	];
	for (const [address, expected] of cases) {
		assert.equal(isPrivateAddress(address), expected, `isPrivateAddress(${address})`);
	}
	assert.equal(normalizeRemoteAddress("::ffff:192.168.1.5"), "192.168.1.5");
	assert.equal(isPrivateAddress(normalizeRemoteAddress("::ffff:192.168.1.5")), true);
});

test("security headers on every response (SR-6)", async () => {
	const bridge = makeBridge();
	const snap = await bridge.start();
	const res = await fetch(`http://127.0.0.1:${snap.port}/pair?token=bad`);
	assert.equal(res.headers.get("x-content-type-options"), "nosniff");
	assert.equal(res.headers.get("x-frame-options"), "DENY");
	assert.equal(res.headers.get("referrer-policy"), "no-referrer");
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
	// font-src data: is the only font source (embedded OFL subset, pages.ts);
	// anything beyond data: here would be a spec change, not an implementation detail.
	assert.match(res.headers.get("content-security-policy") ?? "", /font-src data:/);
	await bridge.stop();
});

test("body cap enforced on RPC payloads (SR-8)", async () => {
	const bridge = makeBridge();
	const snap = await bridge.start();
	const base = `http://127.0.0.1:${snap.port}`;
	const cookie = await pairPhone(bridge, base);
	const fat = "x".repeat(70 * 1024);
	const res = await fetch(`${base}/api/rpc`, {
		method: "POST",
		headers: { cookie, "content-type": "application/json", origin: base },
		body: JSON.stringify({ method: "session.prompt", payload: { text: fat } }),
	});
	assert.equal(res.status, 500); // fail-closed: "Request body is too large."
	const body = await res.json();
	assert.match(body.error, /body is too large/);
	await bridge.stop();
});
