---
id: spec-message-box-http
title: MessageBox Server HTTP API
kind: spec
version: '1.0.0'
last_updated: '2026-07-26'
last_verified: '2026-07-26'
status: stable
tags: ['spec', 'messaging', 'brc-103']
---

# MessageBox Server HTTP API

> An authenticated store-and-forward API for sending messages to named boxes,
> retrieving them later, and deleting them after acknowledgment.

## Contract

| Field          | Value                                         |
| -------------- | --------------------------------------------- |
| Artifact       | OpenAPI 3.1                                   |
| Authentication | BRC-103 over the BRC-104 HTTP binding         |
| Client         | `@bsv/message-box-client`                     |
| Server         | `infra/message-box-server` in this repository |

Except for health and API-documentation routes, requests use the
`x-bsv-auth-*` header family emitted and verified by the BSV auth middleware.
The authenticated identity is the sender for sends and the owner for list,
acknowledgment, device, and permission operations.

## Endpoints

| Method | Path                  | Authentication | Purpose                                          |
| ------ | --------------------- | -------------- | ------------------------------------------------ |
| GET    | `/health`             | Public         | Process liveness                                 |
| GET    | `/ready`              | Public         | Database readiness without dependency details    |
| POST   | `/sendMessage`        | BRC-103        | Send to one or up to 100 recipients              |
| POST   | `/listMessages`       | BRC-103        | List a bounded page of an identity-owned box     |
| POST   | `/acknowledgeMessage` | BRC-103        | Delete up to 1,000 identity-owned messages by ID |
| POST   | `/registerDevice`     | BRC-103        | Register a push-notification device              |
| GET    | `/devices`            | BRC-103        | List registered devices with redacted tokens     |
| POST   | `/permissions/set`    | BRC-103        | Set a sender-specific or box-wide permission     |
| GET    | `/permissions/get`    | BRC-103        | Get a permission                                 |
| GET    | `/permissions/list`   | BRC-103        | List permissions with pagination                 |
| GET    | `/permissions/quote`  | BRC-103        | Quote one or up to 100 recipients                |
| GET    | `/docs`               | Public         | Swagger UI                                       |
| GET    | `/openapi.json`       | Public         | Runtime OpenAPI document                         |

`ROUTING_PREFIX` may prefix every route in a deployment.

## Send, retrieve, acknowledge

```ts
import { MessageBoxClient } from '@bsv/message-box-client'
import { WalletClient } from '@bsv/sdk'

const client = new MessageBoxClient({
  walletClient: new WalletClient(),
  host: 'https://message-box-us-1.bsvb.tech'
})

await client.sendMessage({
  recipient: '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366',
  messageBox: 'general_inbox',
  body: 'Hello'
})

const messages = await client.listMessages({ messageBox: 'general_inbox' })
await client.acknowledgeMessage({
  messageIds: messages.map(message => message.messageId)
})
```

The client encrypts message bodies by default. The server persists the opaque
payload together with routing metadata. Acknowledgment deletes only rows owned
by the authenticated recipient.

## Live transport

Authenticated Socket.IO connections use the same BRC-103 peer identity.
Connections may join only rooms owned by that identity. Live sends reuse the
HTTP handler's validation, permission, payment, deduplication, and persistence
logic; delivery notifications go only to connections authenticated as the
recipient. The client falls back to HTTP if the WebSocket does not acknowledge
a send.

## Permissions and payments

Recipient permissions use:

- `-1` — blocked
- `0` — allowed without recipient payment
- positive integer — required recipient fee in satoshis

The quote route caps a request at 100 recipients and executes permission
lookups with bounded concurrency. Permission or fee storage failures fail
closed with an internal error; they do not silently grant free delivery.

Message reads are deterministic pages of at most 1,000 records with a bounded
offset and `hasMore` indicator. The client follows those pages with an explicit
100,000-message ceiling, preventing any single database response or accidental
client loop from becoming unbounded. Device and permission listings likewise
use strict, bounded pagination.

## Public-service edge policy

Message Box is intentionally callable from deployed applications, wallet UIs,
mobile webviews, native shells, and unknown future domains. The default browser
policy is credential-free wildcard CORS, including opaque `Origin: null`.
Operators may opt into an exact-origin allowlist or disable CORS. Wildcard
origin is never combined with credentials.

CSP applies to served documents such as `/docs`; it is not API access control.
BRC-103 authentication, recipient ownership, permissions, payments, quotas,
request limits, and encryption remain the service's security boundaries.

## Conformance

The OpenAPI artifact is code-generated and checked for deterministic drift.
Message Box behavior is covered by client and server tests; there is no
standalone Message Box vector directory in the portable conformance corpus.

## Artifact

[message-box-http.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/messaging/message-box-http.yaml)
