---
id: pkg-message-box-client
title: '@bsv/message-box-client'
kind: package
domain: messaging
version: '2.2.2'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/message-box-client'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/message-box-client'
status: stable
tags: [messaging, message-box, brc-103, brc-29]
---

# @bsv/message-box-client

> Browser- and Node-compatible authenticated store-and-forward messaging,
> live WebSockets, peer payments, token settlement, permissions, quotes, and
> push-device registration.

## Install

```bash
npm install @bsv/message-box-client @bsv/sdk
```

`@bsv/sdk` is a required peer. Node.js 22 or newer is supported.

## Quick start

```ts
import { MessageBoxClient } from '@bsv/message-box-client'
import { WalletClient } from '@bsv/sdk'

const wallet = new WalletClient()
const client = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://message-box-us-1.bsvb.tech'
})

await client.sendMessage({
  recipient: '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366',
  messageBox: 'general_inbox',
  body: { text: 'Hello' }
})

const messages = await client.listMessages({ messageBox: 'general_inbox' })
await client.acknowledgeMessage({
  messageIds: messages.map(message => message.messageId)
})
```

Initialization is automatic. Call `init()` only when explicit startup control
is useful.

## What it provides

- `MessageBoxClient` — authenticated HTTP polling and live WebSocket delivery
- encryption through the BRC-100 wallet protocol, enabled by default
- overlay host advertisement and public-HTTPS discovery
- sender-specific and box-wide permissions with fee quotes
- Firebase push-device registration
- `PeerPayClient` — BRC-29 payments, requests, responses, and refunds
- `PeerTokenClient` — token transport through pluggable settlement adapters
- `RemittanceAdapter` — SDK remittance communication integration

## Security and interoperability

Configured hosts must be absolute HTTP(S) URLs without credentials, query
strings, or fragments. HTTP is retained for operator-controlled local
development. Untrusted overlay destinations require HTTPS and cannot target
local, private, link-local, reserved, or documentation-only hosts.

Message Box remains accessible from arbitrary deployed browser origins by
default. Server-side exact-origin allowlists or disabled CORS are operator
opt-ins. CORS and CSP do not replace BRC-103 identity authentication,
recipient-owned boxes, permissions, payment checks, quotas, or end-to-end
message encryption.

## Distribution and verification

The package publishes ESM, CommonJS, declarations, source maps, and a UMD
browser bundle. Exact-tarball validation exercises clean ESM/CommonJS
consumers, strict declaration resolution, `publint`, browser bundling through
Vite and esbuild, and bundle budgets. Source and tests are not published.

## Related

- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/message-box-client#readme)
- [Message Box HTTP API](../../specs/message-box-http.md)
- [Peer-to-peer messaging guide](../../guides/peer-to-peer-messaging.md)
- [Message Box Server](../../infrastructure/message-box-server.md)
- [npm](https://www.npmjs.com/package/@bsv/message-box-client)
