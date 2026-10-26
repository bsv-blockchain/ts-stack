---
id: spec-message-box-http
title: MessageBox Server HTTP API
kind: spec
version: '1.0.0'
last_updated: '2026-09-18'
last_verified: '2026-09-18'
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

The client requires mutual authentication on responses as well as requests.
An ordinary unauthenticated HTTP fallback is not a successful Message Box
response. The response identity must be a canonical compressed public key and
must remain stable for the origin during the client lifetime; deployments may
add an independently validated `serverIdentityKeysByHost` pin. Public hosts
require HTTPS, while HTTP is limited to loopback development.

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

Client send inputs are captured before any asynchronous wallet, lookup, or
network operation. A recipient is a canonical compressed public key;
message-box names are exact, control-free strings of at most 128 UTF-8 bytes;
message IDs are exact, control-free strings of at most 256 UTF-8 bytes; and the
portable serialized body is at
most 4 MiB. Deployments may impose the smaller resource-profile limit described
by their runtime configuration. Successful responses are used only when any
returned result binds the submitted recipient and message ID.

## Live transport

Authenticated Socket.IO connections use the same BRC-103 peer identity.
Connections may join only rooms owned by that identity. Live sends reuse the
HTTP handler's validation, permission, payment, deduplication, and persistence
logic; delivery notifications go only to connections authenticated as the
recipient. The client falls back to HTTP if the WebSocket does not acknowledge
a send. Live message IDs, recipients, room names, and message-box suffixes are
canonical and byte-bounded. The service bounds total and per-identity
connections, rooms per connection, join/leave events, concurrent and per-minute
sends, and recipient notification fan-out; explicit `-1`/`unlimited` resource
overrides remain operator trust decisions. Rejected unauthenticated sends and
join/leave attempts consume the same per-connection event budgets, preventing
error responses themselves from becoming unbounded work.

Live sends use the same immutable client-side snapshot and validation as HTTP
sends before any connection, wallet, lookup, or network work. Firebase push
data retains the message ID for application retrieval, while visible fallback
notification text is generic and never reflects a caller-selected identifier.

## Permissions and payments

Recipient permissions use:

- `-1` — blocked
- `0` — allowed without recipient payment
- positive integer through `2,147,483,647` — required recipient fee in satoshis

The quote route caps a request at 100 recipients and executes permission
lookups with bounded concurrency. Permission or fee storage failures fail
closed with an internal error; they do not silently grant free delivery. A
permission update is acknowledged only after the durable write succeeds.
Quote and send recipients must be unique after public-key canonicalization;
equivalent compressed and uncompressed encodings cannot create duplicate fee,
message-ID, or output-allocation rows.
Persisted recipient fees must remain safe integers from `-1` through
`2,147,483,647`; legacy server delivery fees must remain safe integers from `0`
through that maximum.

For a multi-recipient send, the advertised server delivery fee applies to each
allowed recipient. The client places the checked aggregate in the single
server remittance output at index zero; the server recomputes and verifies that
aggregate before accepting the payment or storing any message.

Clients treat quote JSON as untrusted financial input. Each requested recipient
and message-box name must be represented exactly once, status and
blocked-recipient fields must agree with the bounded integer fee, and totals are
recomputed with checked arithmetic. `maximumPayment` optionally applies a
caller-owned ceiling before any wallet action. The server is authoritative for
its advertised price, but the wallet is the spending authority. A payment is
accepted for transport only after the returned Atomic BEEF independently proves
that every requested script and amount remains at its remittance output index;
wallet return bytes alone are not payment evidence.

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
