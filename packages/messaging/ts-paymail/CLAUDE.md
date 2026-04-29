# CLAUDE.md — @bsv/paymail

## Purpose
TypeScript SDK for BSV Paymail (BRC-121 capability discovery and routing). Provides both client-side capability discovery and server-side router with built-in support for PKI, P2P destinations, and public profiles.

## Public API surface

### Client (@bsv/paymail/client or default export)
- **PaymailClient** (class): `new PaymailClient(httpClient, validateDomain, validateEmail)`
  - `getPublicProfile(paymail)` — retrieve name, avatar, avatar_hash for user@domain
  - `getCapabilities(domain)` — discover all capabilities (PKI, P2P Destinations, etc.) for domain
  - `getPki(paymail)` — get user's public key (BRC-121 PKI capability)
  - `getP2pDestinations(paymail, amount, purpose)` — get payment output scripts (BRC-121 P2P capability)
  - Internal: auto-discovers capabilities, validates paymail format, caches results

### Server (@bsv/paymail/router)
- **PaymailRouter** (class): `new PaymailRouter({ baseUrl, routes })`
  - Constructor takes Express baseUrl (e.g., 'https://myDomain.com') and array of `PaymailRoute` handlers
  - `.getRouter()` — returns Express router configured for `/.well-known/bsvalias/*` endpoints
  - Built-in routes: `PublicProfileRoute`, `PublicKeyInfrastructureRoute`, `ReceiveRawTransactionRoute`

### Built-in Route Classes
- **PublicProfileRoute** — responds to `GET /.well-known/bsvalias/public-profile/{name}@{domain}`
  - Requires `domainLogicHandler` callback for looking up user profile
  - Returns: `{ name, domain, avatar?, avatar_hash? }`

- **PublicKeyInfrastructureRoute** — responds to `GET /.well-known/bsvalias/pki/{name}@{domain}`
  - Requires `domainLogicHandler` callback returning user's public key
  - Returns: `{ bsvalias, handle, pubkey }`

- **ReceiveRawTransactionRoute** — responds to `POST /.well-known/bsvalias/receive-transaction/{name}@{domain}`
  - Requires `domainLogicHandler` callback for transaction handling
  - Receives hex-encoded raw transaction, returns: `{ txid }`

- **P2PDestinationsRoute** — responds to `GET /.well-known/bsvalias/p2p-payment-destination/{name}@{domain}?sats={amount}&purpose={purpose}`
  - Returns payment derivation instructions per BRC-29
  - Returns: `{ outputs: [ { derivationSuffix, script, satoshis } ] }`

## Real usage patterns

From README:
```ts
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

Client:
```ts
import { PaymailClient } from '@bsv/paymail'

const client = new PaymailClient()

const publicProfile = await client.getPublicProfile('satoshi@myDomain.com')
console.log(publicProfile.name, publicProfile.avatar)

const capabilities = await client.getCapabilities('myDomain.com')
console.log(capabilities) // lists all supported BRC-121 capabilities

const pkiResult = await client.getPki('satoshi@myDomain.com')
console.log(pkiResult.pubkey) // user's identity key
```

From tests:
```ts
const paymailClient = new PaymailClient(new HttpClient())

const publicProfile = await paymailClient.getPublicProfile('brandonbryant@handcash.io')
expect(publicProfile).toHaveProperty('name')
expect(publicProfile).toHaveProperty('avatar')
```

## Key concepts

- **BRC-121 capabilities**: Discovery of Paymail services (PKI, P2P destinations, receive transaction, public profile)
- **Well-known endpoints**: All Paymail services exposed via `/.well-known/bsvalias/*` paths
- **Capability negotiation**: Client discovers what a domain supports before making requests
- **PKI (Public Key Infrastructure)**: BRC-121 PKI capability maps paymail to public key
- **P2P Destinations**: BRC-121 P2P capability returns payment output derivation per BRC-29
- **Domain logic**: Routes delegate user lookup to your `domainLogicHandler` callback
- **Route extensibility**: Create custom `PaymailRoute` subclasses for custom capabilities
- **Paymail format**: `name@domain` validated per BRC-121 spec

## Dependencies

- `@bsv/sdk` ^2.0.14 — crypto, HTTP utilities
- `express` ^5.1.0 — web framework (server only)
- `joi` ^18.0.1 — schema validation
- `cross-fetch` or `node-fetch` ^3 — HTTP client
- Dev: jest, ts-jest, TypeScript, ts-standard

## Common pitfalls / gotchas

1. **Domain logic is async** — all `domainLogicHandler` callbacks are async; implement accordingly
2. **Paymail format validation** — library validates `name@domain` format; invalid paymail raises error
3. **Capability caching** — client caches discovered capabilities; use options to control TTL
4. **BaseUrl must match DNS** — PaymailRouter's baseUrl should match the domain's actual DNS (e.g., 'https://myDomain.com')
5. **No trailing slashes** — baseUrl should not have trailing slash
6. **HTTP-only PKI discovery** — Paymail service discovery happens via standard HTTP DNS lookup + well-known paths
7. **Error handling** — 404 if user not found, 403 if user found but capability not offered

## Spec conformance

- **BRC-121** (Paymail Service Discovery): Full capability discovery, service routing, profile/PKI/P2P capability exposure
- **BRC-29** (Payment Derivation): P2P payment destination uses BRC-29 key derivation
- **BRC-100** (Wallet interface): Public key infrastructure integrates with wallet identity keys

## File map

```
/Users/personal/git/ts-stack/packages/messaging/ts-paymail/
  src/
    index.ts              — main exports
    paymailClient/
      paymailClient.ts    — client for capability discovery and profile retrieval
      httpClient.ts       — HTTP transport
      resolver/           — DNS resolution for Paymail domains
    paymailRouter/
      paymailRouter.ts    — Express router configuration
      routes/
        PublicProfileRoute.ts
        PublicKeyInfrastructureRoute.ts
        ReceiveRawTransactionRoute.ts
        P2PDestinationsRoute.ts
    capability/           — capability definitions and handlers
    errors/               — PaymailError, ValidationError
  tests/
    **/tests/            — unit & integration tests
  docs/
    examples/            — example server & client code
```

## Integration points

- **@bsv/sdk** — Wallet identity keys, public key operations, HTTP utilities
- **express** — Web framework for server-side router
- **auth-express-middleware** — Can be combined for authenticated Paymail routes (BRC-103 + BRC-121)
- **message-box-client** — Can use Paymail for peer discovery before messaging
