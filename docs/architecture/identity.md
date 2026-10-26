---
id: architecture-identity
title: Identity & Mutual Authentication
kind: meta
version: 'n/a'
last_updated: '2026-09-18'
last_verified: '2026-09-18'
review_cadence_days: 30
status: stable
tags: ['architecture', 'identity', 'auth', 'BRC-31', 'BRC-103', 'BRC-104']
---

# Identity & Mutual Authentication

The ts-stack uses a layered authentication model. Three BRC numbers are relevant: BRC-103, BRC-104, and BRC-31. They are related but distinct.

## BRC-103 — Peer Mutual Authentication Framework

BRC-103 defines the core mutual-auth primitive: a **`Peer`** abstraction.

- Both parties authenticate each other simultaneously (mutual, not one-way)
- Neither party trusts the other until the handshake completes
- The framework is transport-agnostic — it operates over WebSocket, HTTP, or raw byte streams
- Authentication uses Bitcoin keys; no passwords or tokens

`@bsv/authsocket` implements BRC-103 over WebSocket.
`@bsv/auth-express-middleware` wraps BRC-103/104 for Express HTTP servers.
`@bsv/message-box-client` uses BRC-103 to authenticate against MessageBox
servers. It requires the response to remain mutually authenticated, retains one
server identity per URL origin for the client lifetime, and supports an
independently validated identity pin. AuthFetch's unauthenticated compatibility
fallback is not accepted as Message Box authority.

## BRC-104 — HTTP Transport Binding

BRC-104 binds BRC-103 mutual authentication to HTTP. Use the actual SDK
AuthFetch or auth middleware implementation and its current encoding; headers
copied from an old handshake example are insufficient authentication evidence.
BRC-31 is historical guidance, not the current HTTP integration contract.

`@bsv/auth-express-middleware` installs BRC-103/BRC-104 for Express routes.
Application authorization must use the authenticated peer and exact signed
request context.

The machine-readable spec is at `specs/auth/brc103-mutual-auth.yaml` (AsyncAPI 3.0).

## Identity Keys

An identity key is a long-lived compressed secp256k1 public key representing a user, service, or application. Properties:

- Stable and reusable (unlike transaction keys, which rotate for privacy)
- Published and discoverable (e.g., via identity registry overlays)
- Used for: authentication, message routing, certificate issuance, encryption

BRC-103 authentication binds peers to identity keys and uses derived signing keys. Applications retrieve their identity key via `wallet.getPublicKey({ identityKey: true })`.

For the BRC-104 v0.1 HTTP binding, that identity authenticates the encoded
method, path, query, declared signed-header subset, and body—not the transport
authority or every HTTP header. `Host`, cookies, forwarding metadata, and most
standard headers remain outside the signature. A trusted edge must pin the
authority, and application authorization must use exact signed fields rather
than omitted metadata. Virtual authorities representing different security
principals should use distinct server identity keys.

## AuthSocket — Persistent Authenticated Channels

`@bsv/authsocket` and `@bsv/authsocket-client` implement BRC-103 over WebSocket:

- Server-side: `authsocket` exposes an authenticated WebSocket server
- Client-side: `authsocket-client` connects with mutual authentication before any messages are exchanged
- Once connected, the channel is end-to-end authenticated for the session's lifetime
- Useful for: real-time notifications, live data feeds, persistent agent connections

## MessageBox — Store-and-Forward Messaging

MessageBox is a higher-level messaging substrate built on BRC-103/104:

- Store-and-forward: messages are held until the recipient retrieves them
- BRC-103/104 mutual auth required for both `sendMessage` and `getMessages`
- Message payloads are encrypted with the recipient's identity key
- Supports acknowledgement and message expiry

`@bsv/message-box-client` is the client library. The MessageBox server is a separate deployable (see [Infrastructure: MessageBox Server](../infrastructure/message-box-server.md)).

## BRC-31 vs BRC-103/104: When to Use Which

| Use case                               | Use                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------- |
| HTTP API mutual auth (REST/Express)    | BRC-103/BRC-104 via `@bsv/auth-express-middleware`                     |
| Persistent WebSocket channel           | BRC-103 via `@bsv/authsocket`                                          |
| Store-and-forward messaging            | MessageBox via `@bsv/message-box-client` (uses BRC-103/104 internally) |
| Payment + identity in one HTTP request | BRC-121 + BRC-103/BRC-104                                              |

## Certificate-Based Identity

BRC-100 certificate methods integrate with BRC-103 authentication. The proposed
BRC-203 adapter in `@bsv/did/brc52` preserves the original BRC-52 signed bytes
and encrypted fields. Verification derives the BRC-42 certificate signing key;
it does not verify the certificate directly against the certifier root key.

`@bsv/simple` exposes `Certifier`, `CredentialSchema`, and `CredentialIssuer`
for native certificate workflows and signature-preserving envelopes. Trust,
schema acceptance, selected-field authorization and outpoint status remain
explicit application decisions. Revocation requires locally selected chain
status evidence; a missing local secret or overlay discovery result is not
proof of revocation.

The old mutable DID and copied VC/unsigned VP wrapper APIs are removed. BRC-202
DIDs resolve immutable identity keys offline. Selected fields require explicit
wallet permission and verifier keyrings; a fresh authenticated interaction must
bind the holder, recipient, exact envelope and application context. The proposed
W3C securing/status extensions remain unregistered. See the
[unified integration guide](../guides/identity-did-vc.md) and
[migration notes](../guides/identity-did-vc-migration.md).

## Related

- [Key Concepts: Identity](../get-started/concepts.md#identity-and-mutual-authentication)
- [Spec: BRC-31 Auth Handshake](../specs/brc-31-auth.md)
- [Spec: AuthSocket](../specs/authsocket.md)
- [`@bsv/auth-express-middleware`](../packages/middleware/auth-express-middleware.md)
- [`@bsv/authsocket`](../packages/messaging/authsocket.md)
- [`@bsv/message-box-client`](../packages/messaging/message-box-client.md)
- [Infrastructure: MessageBox Server](../infrastructure/message-box-server.md)
