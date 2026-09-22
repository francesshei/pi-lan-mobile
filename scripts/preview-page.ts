// Dev-only: serve the freshly-rendered phone pages on the LAN WITHOUT the bridge.
// Keyboard/viewport behavior is pure client code, so this loop skips pi restarts
// and pairing entirely: edit src/pages.ts, pull-to-refresh on the phone.
// Serves static HTML only — no pairing, no RPC, no pi access, no secrets.
import http from "node:http";
import os from "node:os";
import { renderMobilePage, renderPairingWaitPage } from "../src/pages.ts";

const PORT = Number(process.env.PREVIEW_PORT ?? 8799);

const server = http.createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://preview");
	// Same headers as the bridge (SR-6), so what renders here is representative.
	const headers = {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"content-security-policy":
			"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
	};
	if (url.pathname === "/pair") {
		response.writeHead(200, headers);
		response.end(renderPairingWaitPage("preview-id"));
		return;
	}
	response.writeHead(200, headers);
	response.end(renderMobilePage());
});

server.listen(PORT, "0.0.0.0", () => {
	const ips: string[] = [];
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) ips.push(a.address);
	}
	const host = ips[0] ?? "127.0.0.1";
	console.log(`chat page preview (bridge offline by design): http://${host}:${PORT}/`);
	console.log(`pairing wait page preview:                    http://${host}:${PORT}/pair`);
	console.log("edit src/pages.ts, then pull-to-refresh on the phone.");
});
