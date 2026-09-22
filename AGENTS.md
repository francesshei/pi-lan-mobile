# pi-lan-mobile — agent instructions

QR-paired LAN mobile remote for a running pi session (pi coding-agent extension).
Mirrors the DSH Desktop LanMobileBridge mechanism, with the desktop-side HTTP
routes removed by design: the operator at the pi TUI is the approval surface.

## Binding rules

- **Erasable TypeScript only** (no enums, no parameter properties, no namespaces):
  tests run under plain `node --test` with native type stripping. The pure
  contract tests (`test/bridge.test.ts`, `test/stream.test.ts`) must run with
  **zero node_modules** (pi packages are type-only imports; nothing under
  `src/` may import `qrcode`). `test/entry.test.ts` is the one suite that needs
  `npm install` (it exercises the entry, which renders QRs).
- **The security checklist (SR-1…SR-12) is the contract.** Any change to
  `src/bridge.ts` must keep `test/bridge.test.ts` green; new routes or allowlist
  entries require a matching contract test.
- **The RPC allowlist is exactly six methods** (`workspace.list`, `session.list`,
  `session.history`, `session.create`, `session.prompt`, `session.cancel`).
  Expanding it is a spec change, not an implementation detail — discuss before
  adding (phone-side approvals = M4, opt-in only, must deny on timeout).
- **Never cache `ctx`/`pi` across session boundaries.** pi rebinds extensions on
  `/new`, `/resume`, `/fork`, `/reload`; refresh live references on
  `session_start`/`agent_end`. State that must survive rebinds lives behind
  `globalThis` singletons (`getBridge()`, `getLog()`).
- **No desktop-side HTTP routes.** Approval, disconnect and status are
  in-process callbacks consumed by the TUI (SPEC SR-2). Do not "restore parity
  with DSH" by re-adding them.
- **Plain http, LAN only.** No TLS, no relay, no tunneling in scope. Beyond-LAN
  is a Tailscale story, documented, not implemented.
- v2 items (resident daemon, multi-session supervisor, headless approvals) are
  **deferred together — do not half-build them into v1**. Anything that needs a
  process outliving the pi TUI belongs to v2.

## Layout

- `extensions/pi-lan-mobile.ts` — entry: `/mobile` command, QR widget, idle-queued
  `ctx.ui.confirm` approvals, rebind handling.
- `src/bridge.ts` — node:http server, pairing tokens/cookies/network policy.
- `src/stream.ts` — TranscriptLog (cursor model) + pi event tap.
- `src/rpc.ts` — the six-verb allowlist adapter onto pi APIs.
- `src/pages.ts` — phone pages (string templates; page JS must stay backtick-free
  and use textContent, never innerHTML for dynamic content).
- `test/*.test.ts` — contract tests (bridge + log).

## Commands

- `npm test` — run all suites (needs `npm install` for the entry suite; pure
  contract suites can run with `node --test test/bridge.test.ts test/stream.test.ts`
  on a bare checkout).
- Manual check: load pi in this dir (`pi -e extensions/pi-lan-mobile.ts` or via
  `pi install`), run `/mobile`, scan/visit the printed URL from a LAN device.

## Design docs

Full spec and rationale live in the personal vault (`Vault/Projects/pi-lan-mobile/`:
README.md, SPEC.md, DESIGN-NOTES.md). SPEC.md is normative; when code and SPEC
disagree, one of them is wrong — fix the right one deliberately.
