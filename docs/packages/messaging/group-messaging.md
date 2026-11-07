---
id: pkg-group-messaging
title: '@bsv/group-messaging'
kind: package
domain: messaging
version: '0.1.0'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-09-16'
last_verified: '2026-09-16'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/group-messaging'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/group-messaging'
status: experimental
tags: [messaging, mls, rfc-9420, group-messaging, brc-100]
---

# @bsv/group-messaging

End-to-end encrypted group messaging for BRC-100 wallets. Group state is MLS
(RFC 9420) by way of [`ts-mls`](https://www.npmjs.com/package/ts-mls), and each
member's MLS credential is bound to their wallet's own secp256k1 identity, so a
peer cannot join a group under a name that is not theirs.

The library opens no database and no network connection of its own. It uses the
storage and transport the host already has.

## ⚠️ Security status

Early release, `0.x`. [`ts-mls`](https://www.npmjs.com/package/ts-mls#%EF%B8%8F-security-disclaimer),
the cryptographic core, states that it has not undergone a formal security
audit, and that inherits. The wallet attestation layer on top of it has been
reviewed by reading and its forgery paths are covered by tests, which is not an
audit. There has been no interop testing against another MLS implementation, and
`ts-mls` is pinned exactly rather than by range because its releases have changed
the key schedule inside a minor bump.

Provided as-is. Use at your own discretion.

## Install

```bash
pnpm add @bsv/group-messaging @bsv/sdk
```

`@bsv/sdk` is a required peer dependency. Node.js 22 or newer; runs in the
browser; ESM and CommonJS entry points.

## Quick start

```ts
import { GroupMessagingClient } from '@bsv/group-messaging'
import { WalletClient } from '@bsv/sdk'

const client = await GroupMessagingClient.create({
  wallet: new WalletClient(),
  storage: sqlDriver,
  transport: messageBoxClient
})

const minted = await client.keyPackages.create()
const group = await client.createGroup({
  chatId: 'project-alpha',
  members: [bobKeyPackage],
  privateKeyPackage: minted.privateKeyPackage
})

await group.sendText('hello')
client.on('message', ({ chatId, sender, content }) => {
  /* … */
})
```

## What a consumer supplies

| Input       | Accepts                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `wallet`    | a BRC-100 `WalletClient`, a `KeyDeriver`, or a bare root `PrivateKey`                       |
| `storage`   | a `SqlDriver`, an `IDBDatabase`, a `Map`, a `StorageProvider`, `"memory"`, or `"indexeddb"` |
| `transport` | a `MessageBoxClient`, a `TransportBackend`, or a `TransportService`                         |

Storage is scoped to the client's identity, so one host database serves however
many accounts the wallet manages.

## Two things worth knowing before you build on it

**A KeyPackage is an entry ticket, not a chat key.** It is consumed once, when
its holder enters a group, and a successful `createGroup` or `joinFromWelcome`
retires it and emits `keyPackageConsumed` naming the ref. That event is the
signal for the host to destroy the private half, which this library never holds.

**Live socket delivery is additive, never a replacement.** `MessageBoxTransport`
accepts `live: true`, which layers a socket over a slower polling backstop. The
socket cannot be a sole source: `joinRoom` replays no backlog, so anything sent
while it was down is only ever seen by a poll.

See the package README for the full invitation handshake, the KeyPackage
lifecycle, and the events a consumer should handle.
