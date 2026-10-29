---
id: pkg-paymail
title: '@bsv/paymail'
kind: package
domain: messaging
version: '2.5.0'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-10-29'
last_verified: '2026-10-29'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/paymail'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/ts-paymail'
status: stable
tags: [paymail, messaging, brc-29, identity]
---

# @bsv/paymail

This source candidate declares SDK peer `^2.1.6 || ^3.0.0 || ^4.0.1`. SDK3 remains
a coordinated proposal; see the [qualification and migration limits](../../guides/identity-did-vc-migration.md)
before adopting it.

> TypeScript library for BSV Paymail ([BRC-28](https://github.com/bsv-blockchain/BRCs/blob/master/payments/0028.md) capability discovery and routing). Provides a client and an Express router with built-in support for PKI, P2P destinations, transaction receipt, public profiles and [BRC-235](https://github.com/bsv-blockchain/BRCs/blob/master/payments/0235.md) profile lookup.

The 2.5.0 source candidate adds BRC-235 public profile lookup and reverse lookup. Earlier candidates fixed the CommonJS build of the P2P signature and `PaymailClient` key helpers. No API migration is required.

## Install

```bash
npm install @bsv/paymail
```

## Quick start

```typescript
import { PaymailClient, PublicProfileCapability } from '@bsv/paymail'

const client = new PaymailClient()

const publicProfile = await client.getPublicProfile('satoshi@myDomain.com')
console.log(publicProfile.name, publicProfile.avatar)

const profileEndpoint = await client.ensureCapabilityFor(
  'myDomain.com',
  PublicProfileCapability.getCode()
)
console.log(profileEndpoint)

const pkiResult = await client.getPki('satoshi@myDomain.com')
console.log(pkiResult.pubkey) // user's identity key
```

## What it provides

- **PaymailClient** — Discover capabilities, retrieve profiles, get PKI, request payment destinations, look up BRC-235 profiles
- **PaymailRouter** — Express router serving `/.well-known/bsvalias` and the configured capability routes
- **PublicProfileRoute** — Respond to profile requests with name and avatar
- **PublicKeyInfrastructureRoute** — Respond to PKI requests with user public key
- **ReceiveTransactionRoute / ReceiveBeefTransactionRoute** — Accept raw or BEEF transactions for receiving payments
- **ProfileLookupRoute / ProfileReverseLookupRoute** — BRC-235 handle-to-identity-key lookup and reverse lookup with self-signed profile certificates; hostable without any legacy capability
- **P2pPaymentDestinationRoute** — Return payment output scripts for a requested amount
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
  domainLogicHandler: async params => {
    const { name, domain } = PublicProfileRoute.getNameAndDomain(params)
    const user = await fetchUser(name, domain)
    return {
      name: user.getAlias(),
      domain,
      avatar: user.getAvatarUrl()
    }
  }
})

const pkiRoute = new PublicKeyInfrastructureRoute({
  domainLogicHandler: async params => {
    const { name, domain } = PublicKeyInfrastructureRoute.getNameAndDomain(params)
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
import { PaymailClient, PublicProfileCapability } from '@bsv/paymail'

const client = new PaymailClient()

// Get public profile
const profile = await client.getPublicProfile('alice@example.com')
console.log(profile.name, profile.avatar)

// Discover all capabilities
const profileEndpoint = await client.ensureCapabilityFor(
  'example.com',
  PublicProfileCapability.getCode()
)

// Get user's public key
const pki = await client.getPki('alice@example.com')

// Get payment destination
const p2pDest = await client.getP2pPaymentDestination('alice@example.com', 10000)
```

## Key concepts

- **Capabilities** — BRFC-identified Paymail services (PKI, P2P destinations, receive transaction, public profile, BRC-235 profile lookup)
- **Well-known document** — `/.well-known/bsvalias` lists each capability's URL template; the routes themselves live wherever the host puts them
- **Capability negotiation** — Client discovers what a domain supports before making requests
- **PKI (Public Key Infrastructure)** — Maps paymail to public key
- **P2P Destinations** — Returns payment output scripts (BRC-28)
- **Profile certificates** — BRC-235 lookups return self-signed BRC-52 certificates that the client verifies; the verified identity key is the BRC-29 recipient
- **Domain logic** — Routes delegate user lookup to your `domainLogicHandler` callback
- **Paymail format** — `name@domain`, validated before any request

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

- **BRC-28** (Paymail): Capability discovery, service routing, profile/PKI/P2P capability exposure
- **BRC-235** (Paymail Public Profile Lookup): `0ace65da5987` and `43dcf83ddc5f` routes, client methods with full certificate verification
- **BRC-70** (Paymail BEEF Transaction): `ReceiveBeefTransactionRoute` and `sendBeefTransactionP2P`
- **BRC-100** (Wallet interface): `createProfileCertificate` signs with a wallet's identity key

## Common pitfalls

1. **Domain logic is async** — all `domainLogicHandler` callbacks are async; implement accordingly
2. **Paymail format validation** — library validates `name@domain` format; invalid paymail raises error
3. **BaseUrl must match DNS** — PaymailRouter's baseUrl should match the domain's actual DNS (e.g., 'https://myDomain.com')
4. **No trailing slashes** — baseUrl should not have trailing slash
5. **Discovery** — The host comes from the `_bsvalias._tcp` SRV record (DNSSEC required when it names another host), then the well-known document over HTTPS
6. **Profile lookups are suggestions** — show each result's full paymail and let the user choose; never pick `lookupProfiles()[0]`

## Related packages

- **@bsv/message-box-client** — Messaging to paymail addresses for peer discovery
- **@bsv/auth-express-middleware** — Can combine with Paymail for authenticated routes
- **@bsv/authsocket** / **@bsv/authsocket-client** — Real-time communication paired with Paymail discovery

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/paymail/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/ts-paymail)
- [npm](https://www.npmjs.com/package/@bsv/paymail)

The SDK4 peer alternative now requires `@bsv/sdk ^4.0.1` for the numeric wallet
result and legacy wire hotfix. Existing SDK2/3 alternatives and lower bounds
remain unchanged. No wire or data migration is required.
