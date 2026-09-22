// pi-lan-mobile transcript log.
//
// Projects pi agent events into phone-sized items, upserted by key, with a
// monotonic cursor. The phone polls `since(cursor)` and applies updates in
// order; a stale cursor yields a full reset snapshot (SPEC §5.6).
// Polling transport may later become SSE without changing this contract.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface TranscriptItem {
	key: string;
	kind: "user" | "text" | "thinking" | "tool" | "info";
	text?: string;
	toolName?: string;
	status?: "running" | "done" | "error";
	input?: string;
	output?: string;
}

export interface TranscriptUpdate {
	cursor: number;
	item: TranscriptItem;
}

export interface SinceResult {
	cursor: number;
	reset?: boolean;
	items?: TranscriptItem[];
	updates?: TranscriptUpdate[];
}

const MAX_UPDATES = 4000;
const UPDATE_THROTTLE_MS = 450;
const MAX_TEXT = 32 * 1024;
const MAX_TOOL_PREVIEW = 4 * 1024;

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… (${text.length - max} more chars)`;
}

function safeJson(value: unknown, max: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	try {
		return truncate(typeof value === "string" ? value : JSON.stringify(value, null, 2), max);
	} catch {
		return undefined;
	}
}

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

interface TapMessage {
	role?: string;
	content?: ContentBlock[] | string;
}

export class TranscriptLog {
	cursor: number;
	updates: TranscriptUpdate[];
	items: Map<string, TranscriptItem>;
	lastAssistantMessageAt: number;
	private infoSeq: number;
	private userSeq: number;

	constructor() {
		this.cursor = 0;
		this.updates = [];
		this.items = new Map();
		this.lastAssistantMessageAt = 0;
		this.infoSeq = 0;
		this.userSeq = 0;
	}

	push(item: TranscriptItem): void {
		this.cursor += 1;
		this.items.set(item.key, item);
		this.updates.push({ cursor: this.cursor, item });
		if (this.updates.length > MAX_UPDATES) this.updates.splice(0, this.updates.length - MAX_UPDATES);
	}

	/** Info line, auto-keyed. Use for transient notices ("desktop started a new session"). */
	info(text: string): void {
		this.infoSeq += 1;
		this.push({ key: `info:${this.infoSeq}`, kind: "info", text });
	}

	since(after: number): SinceResult {
		if (!Number.isFinite(after) || after < 0 || after < this.cursor - this.updates.length) {
			return { cursor: this.cursor, reset: true, items: [...this.items.values()] };
		}
		const start = after - (this.cursor - this.updates.length);
		return { cursor: this.cursor, updates: this.updates.slice(Math.max(0, start)) };
	}

	/** Keep phone context alive across desktop session switches without leaking old content. */
	rebase(message = "desktop started a new session"): void {
		this.items.clear();
		this.updates = [];
		this.lastAssistantMessageAt = 0;
		// Dead cursor bump: keeps the update-ring indexing invariant while making
		// every pre-rebase client cursor stale → clients reset and wiped content
		// from the previous session cannot linger on the phone.
		this.cursor += 1;
		this.info(message);
	}
}

/** Attach pi event listeners feeding the log. Call once per extension (re)bind. */
export function tapPiEvents(pi: ExtensionAPI, log: TranscriptLog): void {
	let assistantSeq = 0;
	let userSeq = 0;
	let currentAssistantKey: string | undefined;
	let lastAssistantUpdateAt = 0;

	const blockText = (message: TapMessage): string => {
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((block) => block?.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
	};

	const thinkingText = (message: TapMessage): string => {
		const blocks = Array.isArray(message.content) ? message.content : [];
		return blocks
			.filter((block) => block?.type === "thinking")
			.map((block) => block.thinking ?? "")
			.join("\n");
	};

	// Snapshot pair for the current assistant message; update and end share
	// this so the final push can never lag a throttled stream update.
	const assistantItems = (message: TapMessage): TranscriptItem[] => {
		const items: TranscriptItem[] = [];
		const thinking = truncate(thinkingText(message), MAX_TEXT);
		if (thinking) items.push({ key: `${currentAssistantKey}:thinking`, kind: "thinking", text: thinking });
		const text = truncate(blockText(message), MAX_TEXT);
		if (text) items.push({ key: `${currentAssistantKey}:text`, kind: "text", text });
		return items;
	};

	pi.on("message_start", async (event) => {
		const message = event.message as TapMessage;
		if (message.role === "user") {
			userSeq += 1;
			log.push({ key: `user:${userSeq}`, kind: "user", text: truncate(blockText(message), MAX_TEXT) });
		} else if (message.role === "assistant") {
			assistantSeq += 1;
			currentAssistantKey = `a${assistantSeq}`;
			lastAssistantUpdateAt = 0;
		}
	});

	// Snapshot-style updates: rebuild the assistant text/thinking items from the
	// streaming message content; client upserts by key. Throttled to keep the
	// update ring small without hurting perceived liveness.
	pi.on("message_update", async (event) => {
		const message = event.message as TapMessage;
		if (message.role !== "assistant" || !currentAssistantKey) return;
		const now = Date.now();
		if (lastAssistantUpdateAt && now - lastAssistantUpdateAt < UPDATE_THROTTLE_MS) return;
		lastAssistantUpdateAt = now;

		for (const item of assistantItems(message)) log.push(item);
	});

	pi.on("message_end", async (event) => {
		const message = event.message as TapMessage;
		if (message.role === "user") {
			// Finalize user messages too (message_start may carry empty content for phone prompts initially).
			return;
		}
		if (message.role === "assistant" && currentAssistantKey) {
			// message_update is throttled; this unthrottled final snapshot is
			// what guarantees the phone sees the COMPLETE thinking block, not
			// whatever the last poll happened to catch.
			for (const item of assistantItems(message)) log.push(item);
			currentAssistantKey = undefined;
		}
	});

	pi.on("tool_execution_start", async (event) => {
		log.push({
			key: `tool:${event.toolCallId}`,
			kind: "tool",
			toolName: event.toolName,
			status: "running",
			input: safeJson(event.args, MAX_TOOL_PREVIEW),
		});
	});

	pi.on("tool_execution_update", async (event) => {
		const output = safeJson(event.partialResult, MAX_TOOL_PREVIEW);
		if (!output) return;
		log.push({ key: `tool:${event.toolCallId}`, kind: "tool", toolName: event.toolName, status: "running", output });
	});

	pi.on("tool_execution_end", async (event) => {
		log.push({
			key: `tool:${event.toolCallId}`,
			kind: "tool",
			toolName: event.toolName,
			status: event.isError ? "error" : "done",
			output: safeJson(event.result, MAX_TOOL_PREVIEW),
		});
	});

	pi.on("agent_end", async () => {
		log.info("turn finished");
	});

	pi.on("session_start", async (event) => {
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			log.rebase(event.reason === "resume" ? "desktop resumed another session" : "desktop started a new session");
		}
	});
}
