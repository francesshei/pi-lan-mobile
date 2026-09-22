// pi-lan-mobile — extension entry.
//
// /mobile starts the bridge and prints the pairing QR in the TUI (widget above
// the editor). Pairing approval is a native ctx.ui.confirm fired on the next
// idle moment — there is no desktop web page by design (SPEC §2): the operator
// sitting at the TUI *is* the ambient layer.
//
// State that must survive pi's extension rebind cycle (session /new, /resume,
// /fork, /reload) lives behind globalThis singletons; `pi`/`ctx` references are
// never cached across session boundaries — they are refreshed on every load and
// on session_start.

import QRCode from "qrcode";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBridge } from "../src/bridge.ts";
import { TranscriptLog, tapPiEvents } from "../src/stream.ts";
import { createRpcHandler } from "../src/rpc.ts";

const UI_KEY = "pi-lan-mobile";

const shared = globalThis as typeof globalThis & {
	__piLanMobileLog?: TranscriptLog;
	__piLanMobileTapped?: boolean;
	__piLanMobileApprovalDraining?: boolean;
};

function getLog(): TranscriptLog {
	shared.__piLanMobileLog ??= new TranscriptLog();
	return shared.__piLanMobileLog as TranscriptLog;
}

export default function (pi: ExtensionAPI): void {
	const log = getLog();
	const bridge = getBridge();

	// Live references, never stale: refreshed on load and on every session switch.
	let currentCtx: ExtensionContext | undefined;

	// Attach the event tap exactly once per process (listeners only ever write
	// to the shared log, so an old tap on an old instance is harmless; a second
	// tap would be duplicate work).
	if (!shared.__piLanMobileTapped) {
		tapPiEvents(pi, log);
		shared.__piLanMobileTapped = true;
	}

	// --- pairing approvals: FIFO queue drained on idle (a modal cannot open
	// over a streaming turn; the phone's wait page absorbs the latency).

	async function drainApprovals(): Promise<void> {
		if (shared.__piLanMobileApprovalDraining) return;
		shared.__piLanMobileApprovalDraining = true;
		try {
			for (;;) {
				const pending = bridge.pendingRequests();
				if (!pending.length) break;
				const ctx = currentCtx;
				if (!ctx || !ctx.isIdle()) break; // retried on next agent_end / session_start
				const { id, remoteAddress } = pending[0];
				let approved = false;
				try {
					approved = await ctx.ui.confirm("Pair phone?", `${remoteAddress} scanned the QR code. Allow this phone?`);
				} catch {
					approved = false;
				}
				bridge.decide(id, approved);
				if (approved) ctx.ui.notify("Phone paired", "info");
				else ctx.ui.notify("Phone pairing denied", "warning");
				refreshStatus();
			}
		} finally {
			shared.__piLanMobileApprovalDraining = false;
		}
	}

	function refreshStatus(): void {
		if (!currentCtx?.ui?.setStatus) return;
		if (!bridge.snapshot().running) {
			currentCtx.ui.setStatus(UI_KEY, undefined);
			return;
		}
		const snap = bridge.snapshot();
		currentCtx.ui.setStatus(UI_KEY, snap.connected ? "📱 phone connected" : "📱 mobile listening");
	}

	// Rebind bridge handlers to *this* extension instance's closures on every
	// load/rebind. The running server, cookies and pendings survive untouched.
	bridge.configure({
		rpc: createRpcHandler({
			getPi: () => pi,
			getCtx: () => currentCtx,
			log,
		}),
		onPairingRequested: () => {
			void drainApprovals();
		},
	});

	// --- session lifecycle: re-grab ctx, keep the dot honest, drain approvals,
	// and restore the QR widget after a rebind so the pairing surface never
	// silently vanishes across /new, /resume or /reload.

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		refreshStatus();
		void drainApprovals();
		const snap = bridge.snapshot();
		if (snap.running && snap.pairingUrl) {
			const qr = await QRCode.toString(snap.pairingUrl, { type: "terminal", small: true });
			ctx.ui.setWidget(UI_KEY, ["📱 pair your phone (same network):", ...qr.split("\n"), snap.pairingUrl]);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		refreshStatus();
		void drainApprovals();
	});

	// --- /mobile command

	pi.registerCommand("mobile", {
		description: "QR-pair a phone on the LAN as a curated chat remote (/mobile [off|status|refresh])",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const sub = args.trim().toLowerCase();
			const snap0 = bridge.snapshot();

			if (sub === "create") {
				// Internal verb, also usable by hand. This command handler is the
				// sanctioned place for session control (ExtensionCommandContext);
				// session.create RPC dispatches here (see src/rpc.ts).
				try {
					const result = await ctx.newSession();
					ctx.ui.notify(result.cancelled ? "New session cancelled." : "New session started.", "info");
				} catch (cause) {
					ctx.ui.notify(`New session failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
				}
				return;
			}

			if (sub === "off") {
				await bridge.stop(); // revokes every cookie + pending, closes the port
				ctx.ui.setWidget(UI_KEY, undefined);
				ctx.ui.setStatus(UI_KEY, undefined);
				ctx.ui.notify("Mobile access closed.", "info");
				return;
			}

			if (sub === "status") {
				const snap = bridge.snapshot();
				const lines = [
					`bridge: ${snap.running ? `running on :${snap.port}` : "stopped"}`,
					`paired phones: ${snap.connected ? 1 : 0}`,
					snap.pairingUrl ? `pairing link valid until expiry (rotate with /mobile refresh)` : "pairing link: none (run /mobile)",
				];
				ctx.ui.notify(lines.join(" · "), "info");
				return;
			}

			if (sub !== "" && sub !== "refresh") {
				ctx.ui.notify("Usage: /mobile [off|status|refresh]", "warning");
				return;
			}

			// start() when running == rotate pairing link + drop pendings (DSH parity).
			const snap = await bridge.start();
			if (!snap.running || !snap.pairingUrl) {
				ctx.ui.notify(
					"No private LAN address found. Connect your VPN (e.g. Tailscale) or stay off-LAN; /mobile needs an RFC1918 address.",
					"error",
				);
				return;
			}

			// QR in the TUI: half-block terminal rendering (~41 cols for a v4–5 QR).
			const qr = await QRCode.toString(snap.pairingUrl, { type: "terminal", small: true });
			ctx.ui.setWidget(UI_KEY, ["📱 pair your phone (same network):", ...qr.split("\n"), snap.pairingUrl]);
			ctx.ui.setStatus(UI_KEY, "📱 mobile listening");
			ctx.ui.notify(
				`Mobile listening on :${snap.port} — QR above, link valid ~5 min. Approvals appear here.`,
				"info",
			);
			void drainApprovals();
		},
	});
}
