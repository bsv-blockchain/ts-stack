---
id: architecture-identity
title: Identity & Mutual Authentication
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["architecture", "identity", "auth", "BRC-31", "BRC-103", "BRC-104"]
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
`@bsv/message-box-client` uses BRC-103 to authenticate against MessageBox servers.

## BRC-104 — Message-Layer Transport

BRC-104 defines the message-framing layer used with BRC-103 Peer sessions. It specifies how messages are encoded, versioned, and transmitted once a BRC-103 session is established.

## BRC-31 — HTTP Mutual Authentication Handshake

BRC-31 is the **HTTP-specific** profile of the BRC-103/104 mutual auth framework.

It specifies a set of `x-bsv-auth-*` HTTP request and response headers that implement the challenge-response handshake over standard HTTP semantics:

```
Client request:
  x-bsv-auth-version: 1
  x-bsv-auth-identity-key: <client's identity public key>
  x-bsv-auth-nonce: <random nonce>
  x-bsv-auth-signature: <signature over nonce + request metadata>

Server response:
  x-bsv-auth-nonce: <server nonce>
  x-bsv-auth-signature: <server signature proving its identity>
```

Both parties emerge from the handshake having verified each other's identity keys. Subsequent requests in the same session use a session token derived from the initial handshake.

`@bsv/auth-express-middleware` installs BRC-31 as Express middleware. Any route wrapped by it requires a valid BRC-31 handshake from the client.

The machine-readable spec is at `specs/auth/brc31-handshake.yaml` (AsyncAPI 3.0).

## Identity Keys

An identity key is a long-lived BRC-42-derived public key representing a user, service, or application. Properties:

- Stable and reusable (unlike transaction keys, which rotate for privacy)
- Derived deterministically from the wallet's root key using a stable BRC-42 derivation path
- Published and discoverable (e.g., via identity registry overlays)
- Used for: authentication, message routing, certificate issuance, encryption

All BRC-103/104 and BRC-31 handshakes use identity keys for signing. Applications retrieve their identity key via `wallet.getPublicKey({ identityKey: true })`.

## AuthSocket — Persistent Authenticated Channels

`@bsv/authsocket` and `@bsv/authsocket-client` implement BRC-103/104 over WebSocket:

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

| Use case | Use |
|----------|-----|
| HTTP API mutual auth (REST/Express) | BRC-31 via `@bsv/auth-express-middleware` |
| Persistent WebSocket channel | BRC-103/104 via `@bsv/authsocket` |
| Store-and-forward messaging | MessageBox via `@bsv/message-box-client` (uses BRC-103/104 internally) |
| Payment + identity in one HTTP request | BRC-121 + BRC-31 together |

## Certificate-Based Identity (BRC-103/104 Extension)

BRC-100's certificate methods (`acquireCertificate`, `proveCertificate`, `listCertificates`) integrate with the auth framework:

- **Selective disclosure** — Prove specific certificate fields without revealing others (`proveCertificate`)
- **Verifiable by counterparty** — Any party with the issuer's public key can verify a disclosed certificate
- **Revocation** — Supported via revocation overlay services

`@bsv/simple` exposes `Certifier`, `CredentialSchema`, and `CredentialIssuer` for W3C Verifiable Credential workflows built on top of BRC certificate primitives.

## Related

- [Key Concepts: Identity](../get-started/concepts.md#identity-and-mutual-authentication)
- [Spec: BRC-31 Auth Handshake](../specs/brc-31-auth.md)
- [Spec: AuthSocket](../specs/authsocket.md)
- [`@bsv/auth-express-middleware`](../packages/middleware/auth-express-middleware.md)
- [`@bsv/authsocket`](../packages/messaging/authsocket.md)
- [`@bsv/message-box-client`](../packages/messaging/message-box-client.md)
- [Infrastructure: MessageBox Server](../infrastructure/message-box-server.md)
