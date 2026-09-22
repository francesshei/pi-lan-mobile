// pi-lan-mobile RPC allowlist adapter.
//
// Maps the six curated verbs onto pi extension APIs. This module is the only
// place that touches pi's agent controls; the bridge enforces the allowlist
// before calling in. Responses are {ok,value,error} (SPEC §5.3).

import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpcResult } from "./bridge.ts";
import type { TranscriptLog } from "./stream.ts";

const MAX_PROMPT_CHARS = 32 * 1024;

export interface RpcDeps {
	getPi(): ExtensionAPI | undefined;
	getCtx(): ExtensionContext | undefined;
	log: TranscriptLog;
}

function error(message: string): RpcResult {
	return { ok: false, error: message };
}

/** ~/.pi/agent/sessions — derived from the active session file when possible. */
function sessionsRoot(ctx: ExtensionContext): string | undefined {
	const file = ctx.sessionManager.getSessionFile();
	if (file) return path.dirname(path.dirname(file));
	return path.join(os.homedir(), ".pi", "agent", "sessions");
}

async function countSessionFiles(dir: string): Promise<number> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

export function createRpcHandler(deps: RpcDeps): (method: string, payload: unknown) => Promise<RpcResult> {
	return async (method, payload) => {
		const input = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
		const ctx = deps.getCtx();
		const pi = deps.getPi();

		try {
			switch (method) {
				case "workspace.list": {
					if (!ctx) return error("pi context unavailable");
					const root = sessionsRoot(ctx);
					if (!root) return error("sessions root not found");
					const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
					const workspaces: Array<{ workspace: string; sessions: number }> = [];
					for (const entry of entries) {
						if (!entry.isDirectory()) continue;
						workspaces.push({ workspace: entry.name, sessions: await countSessionFiles(path.join(root, entry.name)) });
					}
					return { ok: true, value: { root, workspaces } };
				}

				case "session.list": {
					if (!ctx) return error("pi context unavailable");
					const file = ctx.sessionManager.getSessionFile();
					if (!file) return { ok: true, value: { current: undefined, sessions: [] } };
					const dir = path.dirname(file);
					const names = (await readdir(dir).catch(() => []))
						.filter((name) => name.endsWith(".jsonl"));
					const sessions = [];
					for (const name of names) {
						const info = await stat(path.join(dir, name)).catch(undefined as never);
						sessions.push({
							file: name,
							mtime: info?.mtimeMs,
							size: info?.size,
							active: name === path.basename(file),
						});
					}
					sessions.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
					return { ok: true, value: { current: path.basename(file), sessions } };
				}

				case "session.history": {
					const after = typeof input.after === "number" ? input.after : -1;
					return { ok: true, value: deps.log.since(after) };
				}

				case "session.create": {
					if (!pi) return error("pi runtime unavailable");
					// Session control (newSession) lives on ExtensionCommandContext (user-initiated
					// commands only). A supported, rebind-safe way to reach a LIVE command ctx:
					// dispatch our own extension command — _tryExecuteExtensionCommand runs it
					// immediately (even mid-turn) and awaits it (agent-session.ts prompt()).
					await pi.sendUserMessage("/mobile create", { expandPromptTemplates: true, deliverAs: "steer" });
					return { ok: true, value: { dispatched: true } };
				}

				case "session.prompt": {
					if (!pi) return error("pi runtime unavailable");
					if (!ctx) return error("pi context unavailable");
					const text = typeof input.text === "string" ? input.text.trim() : "";
					if (!text) return error("text is required");
					if (text.length > MAX_PROMPT_CHARS) return error("text too long");
					if (ctx.isIdle()) {
						// Idle: immediate delivery, triggers a new turn (docs/extensions.md §sendUserMessage).
						await pi.sendUserMessage(text);
						return { ok: true, value: { accepted: true, deliverAs: "immediate" } };
					}
					// Mid-turn: phone acts like the human steering an in-flight turn.
					await pi.sendUserMessage(text, { deliverAs: "steer" });
					return { ok: true, value: { accepted: true, deliverAs: "steer" } };
				}

				case "session.cancel": {
					if (!ctx) return error("pi context unavailable");
					const wasRunning = !ctx.isIdle();
					if (wasRunning) ctx.abort();
					return { ok: true, value: { wasRunning } };
				}

				default:
					return error("RPC method is not available on mobile.");
			}
		} catch (cause) {
			return error(cause instanceof Error ? cause.message : String(cause));
		}
	};
}
