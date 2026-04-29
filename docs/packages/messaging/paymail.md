---
id: pkg-paymail
title: "@bsv/paymail"
kind: package
domain: messaging
version: "2.3.0"
source_repo: "bsv-blockchain/paymail"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/paymail"
repo: "https://github.com/bsv-blockchain/paymail"
status: stable
tags: [paymail, messaging, brc-29, identity]
---

# @bsv/paymail

> TypeScript SDK for BSV Paymail (BRC-121 capability discovery and routing). Provides both client-side capability discovery and server-side router with built-in support for PKI, P2P destinations, and public profiles.

## Install

```bash
npm install @bsv/paymail
```

## Quick start

```typescript
import { PaymailClient } from '@bsv/paymail'

const client = new PaymailClient()

const publicProfile = await client.getPublicProfile('satoshi@myDomain.com')
console.log(publicProfile.name, publicProfile.avatar)

const capabilities = await client.getCapabilities('myDomain.com')
console.log(capabilities) // lists all supported BRC-121 capabilities

const pkiResult = await client.getPki('satoshi@myDomain.com')
console.log(pkiResult.pubkey) // user's identity key
```

## What it provides

- **PaymailClient** — Discover capabilities, retrieve profiles, get PKI, request payment destinations
- **PaymailRouter** — Express router for `/.well-known/bsvalias/*` endpoints
- **PublicProfileRoute** — Respond to profile requests with name, avatar, avatar_hash
- **PublicKeyInfrastructureRoute** — Respond to PKI requests with user public key
- **ReceiveRawTransactionRoute** — Accept raw transactions for receiving payments
- **P2PDestinationsRoute** — Return payment derivation instructions per BRC-29
- **Capability negotiation** — Client discovers what a domain supports before making requests
- **Domain logic delegates** — Routes delegate user lookup to your `domainLogicHandler` callback

## Common patterns

### Server setup

```typescript
import express from 'express'
import { PaymailRouter, PublicKeyInfrastructureRoute, PublicProfileRoute } from '@bsv/paymail'

const app = express()
const baseUrl = 'https://myDomain.com'

const publicProfileRoute = new PublicProfileRoute({
  domainLogicHandler: async (name, domain) => {
    const user = await fetchUser(name, domain)
    return {
      name: user.getAlias(),
      domain,
      avatar: user.getAvatarUrl()
    }
  }
})

const pkiRoute = new PublicKeyInfrastructureRoute({
  domainLogicHandler: async (name, domain) => {
    const user = await fetchUser(name, domain)
    return {
      bsvalias: '1.0',
      handle: `${name}@${domain}`,
      pubkey: user.getIdentityKey()
    }
  }
})

const routes = [publicProfileRoute, pkiRoute]
const paymailRouter = new PaymailRouter({ baseUrl, routes })
app.use(paymailRouter.getRouter())

app.listen(3000, () => {
  console.log(`Paymail server running on ${baseUrl}:3000`)
})
```

### Client capability discovery

```typescript
import { PaymailClient } from '@bsv/paymail'

const client = new PaymailClient()

// Get public profile
const profile = await client.getPublicProfile('alice@example.com')
console.log(profile.name, profile.avatar)

// Discover all capabilities
const caps = await client.getCapabilities('example.com')

// Get user's public key
const pki = await client.getPki('alice@example.com')

// Get payment destination
const p2pDest = await client.getP2pDestinations('alice@example.com', 10000, 'payment')
```

## Key concepts

- **BRC-121 capabilities** — Discovery of Paymail services (PKI, P2P destinations, receive transaction, public profile)
- **Well-known endpoints** — All Paymail services exposed via `/.well-known/bsvalias/*` paths
- **Capability negotiation** — Client discovers what a domain supports before making requests
- **PKI (Public Key Infrastructure)** — Maps paymail to public key via BRC-121
- **P2P Destinations** — Returns payment output derivation per BRC-29
- **Domain logic** — Routes delegate user lookup to your `domainLogicHandler` callback
- **Paymail format** — `name@domain` validated per BRC-121 spec

## When to use this

- Building payment applications that need Paymail integration
- Discovering user capabilities (payments, messaging, profiles) via Paymail
- Verifying user identities and public keys via Paymail
- Implementing P2P payment flows with Paymail recipient discovery
- Building user directories or identity-based routing
- Hosting Paymail services for your own domain

## When NOT to use this

- Simple HTTP APIs without Paymail requirement — use direct APIs
- Users don't have Paymail addresses — use raw Bitcoin addresses
- Non-payment identity — use DID clients instead
- On-chain identity verification — use overlay-based DID

## Spec conformance

- **BRC-121** (Paymail Service Discovery): Full capability discovery, service routing, profile/PKI/P2P capability exposure
- **BRC-29** (Payment Derivation): P2P payment destination uses BRC-29 key derivation
- **BRC-100** (Wallet interface): Public key infrastructure integrates with wallet identity keys

## Common pitfalls

1. **Domain logic is async** — all `domainLogicHandler` callbacks are async; implement accordingly
2. **Paymail format validation** — library validates `name@domain` format; invalid paymail raises error
3. **BaseUrl must match DNS** — PaymailRouter's baseUrl should match the domain's actual DNS (e.g., 'https://myDomain.com')
4. **No trailing slashes** — baseUrl should not have trailing slash
5. **HTTP-only discovery** — Paymail service discovery happens via standard HTTP DNS lookup + well-known paths

## Related packages

- **@bsv/message-box-client** — Messaging to paymail addresses for peer discovery
- **@bsv/auth-express-middleware** — Can combine with Paymail for authenticated routes
- **@bsv/authsocket** / **@bsv/authsocket-client** — Real-time communication paired with Paymail discovery

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/paymail/)
- [Source on GitHub](https://github.com/bsv-blockchain/paymail)
- [npm](https://www.npmjs.com/package/@bsv/paymail)
