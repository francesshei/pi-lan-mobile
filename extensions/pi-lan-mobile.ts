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
// Injected as a virtual module by pi at runtime (same bundled copy pi uses
// internally); declared a devDependency only so test/entry.test.ts can run
// the entry under bare `node --test`.
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBridge } from "../src/bridge.ts";
import { TranscriptLog, tapPiEvents } from "../src/stream.ts";
import { createRpcHandler } from "../src/rpc.ts";

const UI_KEY = "pi-lan-mobile";

const shared = globalThis as typeof globalThis & {
	__piLanMobileLog?: TranscriptLog;
	__piLanMobileTapped?: boolean;
	__piLanMobileApprovalDraining?: boolean;
	__piLanMobileQr?: { url: string; qr: string };
};

function getLog(): TranscriptLog {
	shared.__piLanMobileLog ??= new TranscriptLog();
	return shared.__piLanMobileLog as TranscriptLog;
}

// The pairing QR must NOT go through the string-array widget form: pi hard-
// caps string arrays at InteractiveMode.MAX_WIDGET_LINES (10) and appends
// "... (widget truncated)", amputating the ~17-line half-block QR. The
// component-factory form is the sanctioned bypass: content holds no theme-
// baked styling (qrcode's own SGR is stable), so rendering is stateless and
// invalidate() is a genuine no-op. Lines are ANSI-fit to width, mirroring the
// paddingX=1 inset the string path had.
// The widget live-reads bridge state on every render: full QR while a pairing
// link is live, ONE collapsed line once a phone is connected (a 17-line QR
// loitering above the editor after pairing succeeded is pure noise). Callers
// re-setWidget at known transition points (approval, session_start, /mobile)
// to force the immediate redraw; any other TUI repaint also picks it up.
function pairingWidget(qr: string, url: string): { invalidate(): void; render(width: number): string[] } {
	const bridge = getBridge();
	return {
		invalidate(): void {},
		render(width: number): string[] {
			if (width < 4) return [""]; // nothing renderable at this width
			const snap = bridge.snapshot();
			if (snap.connected) {
				return [` ${truncateToWidth(`📱 phone connected on :${snap.port} — /mobile shows the QR again`, width - 2, "")} `];
			}
			const lines = ["📱 pair your phone (same network):", ...qr.split("\n"), url];
			// "" ellipsis: clip like the terminal edge did, never splice "…" into QR modules.
			return lines.map((line) => ` ${truncateToWidth(line, width - 2, "")} `);
		},
	};
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
				if (approved) {
					ctx.ui.notify("Phone paired", "info");
					void watchConnected(ctx);
				} else ctx.ui.notify("Phone pairing denied", "warning");
				refreshStatus();
			}
		} finally {
			shared.__piLanMobileApprovalDraining = false;
		}
	}

	// --- pairing widget surface: QR generation is cached per pairing URL so
	// redraws (collapse/expand) never re-run qrcode work mid-render.

	async function showSurface(ctx: ExtensionContext): Promise<void> {
		const snap = bridge.snapshot();
		if (!snap.running || !snap.pairingUrl) return;
		const url = snap.pairingUrl;
		if (!shared.__piLanMobileQr || shared.__piLanMobileQr.url !== url) {
			// QR in the TUI: half-block terminal rendering (~35 cols for a v4–5 QR),
			// as a component widget so the full height survives (see pairingWidget).
			shared.__piLanMobileQr = { url, qr: await QRCode.toString(url, { type: "terminal", small: true }) };
		}
		redrawSurface(ctx);
	}

	function redrawSurface(ctx: ExtensionContext): void {
		const cached = shared.__piLanMobileQr;
		if (!cached) return;
		// A fresh factory call forces renderWidgets + requestRender, so the widget
		// visibly changes the moment the state transition lands.
		ctx.ui.setWidget(UI_KEY, () => pairingWidget(cached.qr, cached.url));
	}

	// The phone's /pair/status poll is what actually creates the session, and it
	// lands slightly AFTER the approval decision. Watch briefly, then redraw so
	// the QR collapses as soon as the phone is really connected.
	function watchConnected(ctx: ExtensionContext): void {
		let ticks = 0;
		const timer = setInterval(() => {
			const snap = bridge.snapshot();
			if (ctx !== currentCtx || ++ticks > 15 || !snap.running) {
				clearInterval(timer); // stale rebind or bridge gone: drop, the new instance owns the surface
				return;
			}
			if (snap.connected) {
				clearInterval(timer);
				redrawSurface(ctx);
			}
		}, 400);
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
		await showSurface(ctx);
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

			await showSurface(ctx);
			ctx.ui.setStatus(UI_KEY, "📱 mobile listening");
			ctx.ui.notify(
				`Mobile listening on :${snap.port} — QR above, link valid ~5 min. Approvals appear here.`,
				"info",
			);
			void drainApprovals();
		},
	});
}
