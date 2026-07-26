# Message Box Client Maintainer Guide

## Scope

`@bsv/message-box-client` is the browser- and Node-compatible client for the
Message Box HTTP/WebSocket protocol. It provides encrypted store-and-forward
messaging, BRC-29 peer payments, token-settlement adapters, delivery
permissions and quotes, and push-device registration.

Public entry points are exported from `mod.ts`. Preserve both ESM and CommonJS
consumers and the UMD browser bundle.

## Security and compatibility invariants

- Messages are encrypted per recipient by default. Plaintext requires an
  explicit `skipEncryption: true`.
- A shared multi-recipient body cannot be encrypted per recipient. The batch
  API therefore requires explicit plaintext opt-in; notification convenience
  APIs send bounded individual encrypted requests.
- Explicitly configured hosts may use HTTP for local/operator-controlled
  environments. Overlay-advertised hosts are untrusted and must be public
  HTTPS destinations; reject loopback, private, link-local, reserved, and
  documentation-only targets.
- Preserve configured URL path prefixes when constructing route URLs.
- BRC-103 authentication, recipient ownership, permission/payment checks, and
  encryption are the access boundaries. Message Box is a public protocol
  service; compatible servers use credential-free wildcard CORS by default and
  may opt into an exact allowlist.
- Keep `sendMesagetoRecepients` as a deprecated compatibility wrapper around
  the correctly spelled `sendMessageToRecipients`.
- Never silently contact a deployed integration target. Live integration tests
  require explicit environment configuration and a separate acknowledgement
  for `*.bsvb.tech`.

## Server contract

Authenticated routes:

- `POST /sendMessage`
- `POST /listMessages` (bounded pagination)
- `POST /acknowledgeMessage`
- `POST /registerDevice`
- `GET /devices`
- `POST /permissions/set`
- `GET /permissions/get`
- `GET /permissions/list`
- `GET /permissions/quote`

Live delivery uses authenticated Socket.IO rooms named
`{identityKey}-{messageBox}`. The reviewed source contract is
`specs/messaging/message-box-http.yaml`.

## File map

- `mod.ts` — public exports
- `src/MessageBoxClient.ts` — base HTTP, WebSocket, overlay, permission, quote,
  device, and message APIs
- `src/PeerPayClient.ts` — BRC-29 payments and payment requests
- `src/PeerTokenClient.ts` — token transfer/request transport
- `src/TokenSettlementAdapter.ts` — token-standard adapter contract
- `src/RemittanceAdapter.ts` — SDK remittance integration
- `src/host.ts` — configured-host and untrusted-overlay URL policy
- `src/types.ts`, `src/types/permissions.ts` — public types
- `src/__tests/` — deterministic unit and contract tests
- `src/__tests/integration/` — explicitly configured live tests
- `tsdown.config.ts` — unbundled ESM/CommonJS/declaration build
- `webpack.config.js` — UMD build
- `browser-budget.json` — Vite, esbuild, and UMD size/composition budgets

## Required checks

Run from the repository root:

```bash
pnpm --filter @bsv/message-box-client typecheck
pnpm --filter @bsv/message-box-client format:check
pnpm --filter @bsv/message-box-client lint
pnpm --filter @bsv/message-box-client test
pnpm --filter @bsv/message-box-client test:coverage
pnpm --filter @bsv/message-box-client pack:check
pnpm --filter @bsv/message-box-client test:browser
```

The integration suite additionally requires:

```bash
MESSAGE_BOX_RUN_INTEGRATION=true \
MESSAGE_BOX_INTEGRATION_HOST=http://127.0.0.1:8080 \
MESSAGE_BOX_WALLET_ORIGINATOR=localhost \
pnpm --filter @bsv/message-box-client test:integration
```

Do not weaken browser budgets to hide growth. Update a budget only with measured
artifact evidence and an explanation.

## Release contract

The tarball contains compiled `dist/` artifacts, declarations, source maps,
README, and license only. It must not contain source tests, coverage, editor
files, package-manager locks, or repository workflows. Do not bump or publish a
version as an incidental part of maintenance work.
