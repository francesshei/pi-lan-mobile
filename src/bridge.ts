// pi-lan-mobile bridge: standalone node:http LAN server.
//
// Port of the DSH Desktop LanMobileBridge security/pairing/RPC-proxy contract,
// with the desktop-side HTTP routes REMOVED by design (SPEC SR-2): pairing
// approval, disconnect and status are in-process callbacks consumed by the
// pi TUI, never HTTP routes. Every request handler is fail-closed.
//
// Erasable TypeScript only (runs under `node --test` type stripping).

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import { renderMobilePage, renderPairingWaitPage } from "./pages.ts";

const MAX_BODY_BYTES = 64 * 1024;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const COOKIE_NAME = "pi_lan_mobile";

/** The curation. The phone talks to the agent, never to the machine. */
export const RPC_ALLOWLIST = new Set([
	"workspace.list",
	"session.list",
	"session.history",
	"session.create",
	"session.prompt",
	"session.cancel",
]);

export interface RpcResult {
	ok: boolean;
	value?: unknown;
	error?: string;
}

export interface BridgeHandlers {
	/** Dispatch an allowlisted RPC method. Set by the extension entry on every (re)bind. */
	rpc(method: string, payload: unknown): Promise<RpcResult>;
	/** A phone presented a valid pairing token and awaits the desktop decision. */
	onPairingRequested(id: string, remoteAddress: string): void;
}

export interface BridgeOptions {
	port?: number;
	now?: () => number;
}

export interface BridgeSnapshot {
	running: boolean;
	connected: boolean;
	port?: number;
	pairingUrl?: string;
	expiresAt?: number;
}

interface MobileSession {
	token: string;
}

interface PendingPairing {
	id: string;
	remoteAddress: string;
	expiresAt: number;
	decision?: boolean;
}

export class Bridge {
	handlers?: BridgeHandlers;
	readonly now: () => number;
	server?: ReturnType<typeof createServer>;
	port?: number;
	pairingToken?: string;
	pairingExpiresAt?: number;
	sessions: Map<string, MobileSession>;
	pendingPairings: Map<string, PendingPairing>;
	private readonly requestedPort?: number;

	constructor(options?: BridgeOptions) {
		this.handlers = undefined;
		this.now = options?.now ?? Date.now;
		this.requestedPort = options?.port;
		this.server = undefined;
		this.port = undefined;
		this.pairingToken = undefined;
		this.pairingExpiresAt = undefined;
		this.sessions = new Map();
		this.pendingPairings = new Map();
	}

	/** Rebind handlers without disturbing running server/sessions (extension reload, session switch). */
	configure(handlers: BridgeHandlers): void {
		this.handlers = handlers;
	}

	async start(): Promise<BridgeSnapshot> {
		if (this.server) {
			// DSH parity: start-when-running rotates the pairing link and drops pendings.
			this.rotatePairingToken();
			this.pendingPairings.clear();
			return this.snapshot();
		}
		this.rotatePairingToken();
		this.server = createServer((request, response) => {
			void this.handle(request, response).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.json(response, 500, { ok: false, error: message });
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(this.requestedPort ?? 0, "0.0.0.0", resolve);
		});
		this.port = (this.server.address() as AddressInfo).port;
		return this.snapshot();
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.port = undefined;
		this.pairingToken = undefined;
		this.pairingExpiresAt = undefined;
		this.sessions.clear();
		this.pendingPairings.clear();
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	snapshot(): BridgeSnapshot {
		const address = preferredLanAddress();
		if (!this.server || !this.port || !this.pairingToken || !this.pairingExpiresAt || !address) {
			return { running: Boolean(this.server), connected: this.sessions.size > 0 };
		}
		return {
			running: true,
			connected: this.sessions.size > 0,
			port: this.port,
			pairingUrl: `http://${address}:${this.port}/pair?token=${this.pairingToken}`,
			expiresAt: this.pairingExpiresAt,
		};
	}

	/** Desktop-side decision, delivered in-process (TUI confirm). No HTTP route reaches this. */
	decide(id: string, approved: boolean): void {
		const pending = this.pendingPairings.get(id);
		if (pending) pending.decision = approved;
	}

	/** Desktop-side view of pairing requests awaiting a decision. */
	pendingRequests(): Array<{ id: string; remoteAddress: string }> {
		const now = this.now();
		return [...this.pendingPairings.values()]
			.filter((item) => item.decision === undefined && item.expiresAt >= now)
			.map((item) => ({ id: item.id, remoteAddress: item.remoteAddress }));
	}

	/** Revoke every paired phone (and, from M3 on, the persisted store). */
	disconnectAll(): void {
		this.sessions.clear();
		this.pendingPairings.clear();
		this.rotatePairingToken();
	}

	private rotatePairingToken(): void {
		this.pairingToken = randomBytes(32).toString("base64url");
		this.pairingExpiresAt = this.now() + PAIRING_TTL_MS;
	}

	// ---------------------------------------------------------------- requests

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		// SR-6: security headers on every response.
		response.setHeader("cache-control", "no-store");
		response.setHeader("x-content-type-options", "nosniff");
		response.setHeader("x-frame-options", "DENY");
		response.setHeader("referrer-policy", "no-referrer");
		response.setHeader(
			"content-security-policy",
			"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
		);

		// SR-1: private-network-only clients.
		const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress ?? "");
		if (!isPrivateAddress(remoteAddress)) return this.text(response, 403, "Private network only.");

		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

		if (request.method === "GET" && url.pathname === "/pair") return this.handlePair(request, url, remoteAddress, response);
		if (request.method === "GET" && url.pathname === "/pair/status") return this.handlePairStatus(url, response);

		// Everything below is cookie-authenticated (SR-4: Map keyed by full secret).
		if (!this.authorized(request)) return this.text(response, 401, "Pair your phone again.");

		if (request.method === "GET" && url.pathname === "/") {
			return this.html(response, renderMobilePage());
		}
		if (request.method === "GET" && url.pathname === "/api/status") {
			return this.json(response, 200, { connected: true });
		}
		if (request.method === "POST" && url.pathname === "/api/rpc") {
			this.verifySameOrigin(request); // SR-7
			const input = JSON.parse(await readBody(request)) as { method?: unknown; payload?: unknown };
			if (typeof input.method !== "string" || !RPC_ALLOWLIST.has(input.method)) {
				return this.json(response, 403, { ok: false, error: "RPC method is not available on mobile." });
			}
			if (!this.handlers) return this.json(response, 503, { ok: false, error: "Bridge handler is not bound." });
			const result = await this.handlers.rpc(input.method, input.payload ?? {});
			return this.json(response, result.ok ? 200 : 400, result);
		}
		this.text(response, 404, "Not found.");
	}

	private handlePair(request: IncomingMessage, url: URL, remoteAddress: string, response: ServerResponse): void {
		if (this.authorized(request)) {
			response.statusCode = 302;
			response.setHeader("location", "/");
			response.end();
			return;
		}
		// SR-3/SR-4: short-lived, timing-safe, single-use pairing token.
		if (!this.validPairingToken(url.searchParams.get("token"))) {
			return this.text(response, 401, "This pairing link is invalid or expired.");
		}
		const id = randomUUID();
		this.pendingPairings.set(id, { id, remoteAddress, expiresAt: this.pairingExpiresAt ?? this.now() });
		this.handlers?.onPairingRequested(id, remoteAddress);
		this.html(response, renderPairingWaitPage(id));
	}

	private handlePairStatus(url: URL, response: ServerResponse): void {
		const id = url.searchParams.get("id");
		const pending = id ? this.pendingPairings.get(id) : undefined;
		if (!pending) return this.json(response, 200, { expired: true });
		if (pending.expiresAt < this.now()) {
			this.pendingPairings.delete(pending.id);
			return this.json(response, 200, { expired: true });
		}
		if (pending.decision === false) {
			this.pendingPairings.delete(pending.id);
			return this.json(response, 200, { denied: true });
		}
		if (pending.decision !== true) return this.json(response, 200, { pending: true });
		// SR-9: single paired phone — approval replaces all prior sessions.
		const token = randomBytes(32).toString("base64url");
		this.sessions.clear();
		this.sessions.set(token, { token });
		this.pendingPairings.delete(pending.id);
		// SR-3: the pairing token is consumed by one approval.
		this.pairingToken = undefined;
		this.pairingExpiresAt = undefined;
		response.setHeader(
			// SR-5: HttpOnly, SameSite=Strict; token never readable by page JS.
			"set-cookie",
			`${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
		);
		this.json(response, 200, { approved: true });
	}

	// ------------------------------------------------------------------- auth

	private validPairingToken(candidate: string | null): boolean {
		if (!candidate || !this.pairingToken || !this.pairingExpiresAt) return false;
		if (this.now() > this.pairingExpiresAt) return false;
		const left = Buffer.from(candidate);
		const right = Buffer.from(this.pairingToken);
		return left.length === right.length && timingSafeEqual(left, right);
	}

	private authorized(request: IncomingMessage): boolean {
		const cookie = request.headers.cookie ?? "";
		const match = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`).exec(cookie);
		if (!match) return false;
		return this.sessions.has(match[1] as string);
	}

	private verifySameOrigin(request: IncomingMessage): void {
		const origin = request.headers.origin;
		const host = request.headers.host;
		if (origin && host && new URL(origin).host !== host) throw new Error("Cross-origin request rejected.");
	}

	// ------------------------------------------------------------------ output

	private html(response: ServerResponse, body: string): void {
		response.statusCode = 200;
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(body);
	}

	private text(response: ServerResponse, status: number, body: string): void {
		response.statusCode = status;
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end(body);
	}

	private json(response: ServerResponse, status: number, body: unknown): void {
		if (response.headersSent) {
			response.end();
			return;
		}
		response.statusCode = status;
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(body));
	}
}

// ------------------------------------------------------------------- network

export function preferredLanAddress(): string | undefined {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal && isPrivateAddress(entry.address)) return entry.address;
		}
	}
	return undefined;
}

export function normalizeRemoteAddress(address: string): string {
	return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function isLoopbackAddress(address: string): boolean {
	return address === "::1" || address === "127.0.0.1";
}

/** SR-1 policy: RFC1918 IPv4, loopback, IPv6 ULA/link-local. */
export function isPrivateAddress(address: string): boolean {
	if (isLoopbackAddress(address)) return true;
	if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
	const match = /^172\.(\d+)\./.exec(address);
	if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
	return /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe8[0-9a-f]:/i.test(address);
}

/** SR-8: hard body cap enforced while streaming. */
export async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
		bytes += buffer.length;
		if (bytes > MAX_BODY_BYTES) throw new Error("Request body is too large.");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------- process-wide singleton
// Shared across extension reloads and session rebinds so the running bridge
// survives pi's extension-instance lifecycle (SPEC §7: pairing survives /new).

const globalRef = globalThis as typeof globalThis & { __piLanMobileBridge?: Bridge };

export function getBridge(): Bridge {
	globalRef.__piLanMobileBridge ??= new Bridge();
	return globalRef.__piLanMobileBridge as Bridge;
}
