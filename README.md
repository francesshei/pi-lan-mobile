# pi-lan-mobile

A QR-paired LAN mobile remote for a running [pi](https://github.com/earendil-works/pi) coding-agent session — the **DSH Desktop "scan a QR, chat from your phone" experience as a pi extension**.

Run `/mobile` in pi. A QR code appears in your terminal. Scan it from a phone on the same network, approve the pairing prompt in the TUI, and your phone browser becomes a curated chat remote for **that pi session**: live transcript, send prompts, interrupt, start a new session. Nothing else.

```
pi TUI (you)                    phone browser (same LAN)
────────────────────────        ──────────────────────────────
/mobile            ──► QR       GET /pair?token=…  →  approve in TUI
📱 mobile listening  ◄── ●      chat page: transcript, prompt,
/mobile off          ──► ✕      stop, new session (6 verbs only)
```

## What it is / is not

- **Curated like DSH's bridge**: the phone can talk *to the agent* through exactly six RPC verbs — `workspace.list`, `session.list`, `session.history`, `session.create`, `session.prompt`, `session.cancel`. Anything else gets `403 "RPC method is not available on mobile."` It cannot touch files, the terminal, settings, or model switching.
- **TUI-first**: no relay, no daemon, no app, no accounts, no desktop web pages. The bridge runs *inside* the pi process; pairing approval is a native pi dialog. You, at the keyboard, are the ambient layer.
- **Not** remote control of the machine, and **not** multi-session: one pi process = one bridge = one paired phone.

## Install

```bash
pi install npm:pi-lan-mobile   # once published
# or, from this repo:
pi -e extensions/pi-lan-mobile.ts
```

Requires pi and a phone on the same private network (RFC1918; Tailscale users: see security notes).

## Use

1. `/mobile` — starts the bridge on a random port; QR + URL appear above the editor.
2. Scan with the phone (or open the printed URL). Phone shows "waiting for the desktop…".
3. Approve `Pair phone?` in the pi TUI. The phone lands on the chat page.
4. Chat. Prompts appear in the TUI as user messages — the desk always sees what the phone sent.
5. `/mobile off` — closes the port and revokes every paired phone.

Other commands: `/mobile status`, `/mobile refresh` (new pairing link).

## Security model (summary)

- Clients restricted to private-network ranges (RFC1918 IPv4, loopback, IPv6 ULA/link-local). Public IPs are refused at the socket level.
- Pairing links: 32-byte random token, 5-minute TTL, single-use, timing-safe compared; re-running `/mobile` rotates them.
- Session cookie: `HttpOnly; SameSite=Strict`; **single paired phone** — a new approval revokes the old device; `/mobile off` revokes all.
- Fail-closed HTTP: strict CSP, `X-Frame-Options: DENY`, same-origin checks on RPC posts, 64 KB body cap, no-store.
- Plain `http://` on the LAN (same threat model as DSH's bridge). For beyond-LAN, run Tailscale and note its `100.64/10` range is **not** in the default private-network policy — enable LAN exposure over your tunnel only if you understand the trade.
- Honest caveat: the six verbs can't touch the machine, but the agent behind `session.prompt` runs tools under pi's normal permission posture. If you want tighter gating, pair this with a tool-approval extension.

## Development

```bash
npm test        # contract tests (runs on bare node, no build step)
```

Erasable-TypeScript only; see `AGENTS.md` for binding rules. Design spec: the project's `SPEC.md` (SR-1…SR-12 checklist drives the test suite).

## Status

M1 (faithful core) implemented: bridge, pairing, approvals, six verbs, chat page. Roadmap (M2 transcript fidelity → M3 attachments + cookie persistence → M4 phone-side approvals) and deferred v2 (daemon, multi-session) per the design plan.

## License

MIT
