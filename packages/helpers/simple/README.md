# @bsv/simple

A high-level TypeScript library that makes BSV blockchain development simple. Build wallets, send payments, create tokens, issue credentials, and more — in just a few lines of code.

## Install

```bash
npm install @bsv/simple @bsv/sdk
```

Use the browser-safe default entry point in frontend applications and
`@bsv/simple/server` only in Node.js server code. See the
[installation guide](docs/installation.md) for framework-specific setup.

## What is @bsv/simple?

`@bsv/simple` wraps the low-level `@bsv/sdk` into a clean, modular API. Instead of manually constructing locking scripts, managing key derivation, and handling transaction internalization, you call methods like `wallet.pay()`, `wallet.createToken()`, and `wallet.inscribeText()`.

## What can you build?

| Feature                       | Description                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| **Payments**                  | Send BSV to any identity key via BRC-29 peer-to-peer payments                       |
| **Multi-Output Transactions** | Combine P2PKH payments, OP_RETURN data, and PushDrop tokens in a single transaction |
| **Encrypted Tokens**          | Create, transfer, and redeem PushDrop tokens with encrypted payloads                |
| **Inscriptions**              | Write text, JSON, or file hashes permanently to the blockchain                      |
| **MessageBox P2P**            | Send and receive payments and tokens peer-to-peer via MessageBox                    |
| **Certification**             | Issue and manage BSV certificates with a standalone Certifier                       |
| **Verifiable Credentials**    | W3C-compatible VCs backed by BSV certificates, with on-chain revocation             |
| **DIDs**                      | Generate and resolve `did:bsv:` Decentralized Identifiers                           |
| **Overlay Networks**          | Broadcast to and query SHIP/SLAP overlay services                                   |
| **Server Wallet**             | Run a backend wallet for automated operations and funding flows                     |

## Browser vs Server

The library has two entry points:

- **`@bsv/simple`** (default) — Browser-safe. Uses `WalletClient` from `@bsv/sdk` to connect to the user's wallet on the client side. Will not pull in any server-only dependencies.
- **`@bsv/simple/server`** — Uses `@bsv/wallet-toolbox` to run a server-side wallet from a private key. Used for agents, or servers receiving payments.

Both entry points provide the same API surface — the only difference is how they connect to the underlying wallet.

Message Box payment helpers normalize historical number-array, current binary
Wallet Wire, and numeric-key JSON transaction representations before sending
or internalizing them. Malformed transaction records fail without acknowledging
the pending payment. The server adapter applies the same compatibility contract
to request and response bodies before the host framework's JSON boundary.

The packaged Message Box Client dependency now starts at 2.5.0. Existing helper
calls retain the default HTTP and live-socket behavior; no migration is required.

The bundled Simple identity registry is a legacy unauthenticated directory: its
register/revoke wire format does not prove control of the supplied public key.
Treat its mappings only as discovery hints, confirm recipient keys independently,
and do not expose its mutation handler publicly without application authorization.
It is not a certificate or a payment-recipient trust source.

Remote certificate and credential acquisition accepts a credential-free HTTPS
service URL, pins the advertised public origin through the SDK's restricted
transport, authenticates the returned certificate signature, and binds its
certifier, subject, and type before changing wallet state. The optional `fetch`
override is an explicitly trusted escape hatch for controlled tests or local
development; applications must provide equivalent origin and network controls.

Certificate and persisted credential field names retain their historical UTF-16
code-unit order, independent of the host locale. The shared internal comparator
in the unpublished 0.6.0 candidate does not change signed bytes or require a
consumer migration.

`CredentialIssuer.verify()` authenticates the embedded BSV certificate and
requires the W3C wrapper's issuer, subject, type, fields, proof, and revocation
reference to match it. Wrapper timestamps are formatting metadata, not claims
covered by the certificate signature. The current synchronous
`toVerifiablePresentation()` / `createPresentation()` helpers only assemble a
presentation envelope: their `proof` has no holder signature, challenge, or
audience and must not be used for authentication or replay-sensitive access
decisions.

Remote DID resolution treats the configured universal resolver, application
proxy, and transaction/spend-index provider as authoritative trust sources.
Responses are bounded, strictly validated, and bound to the requested DID and
reported output-0 chain, but the current result carries no cryptographic chain
or freshness proof. Do not use a remotely resolved key as the sole evidence for
authentication or an irreversible payment; confirm it through an independently
trusted channel or resolver policy.

The generated server-wallet handler defaults every action closed. Applications
must provide an authorization callback bound to their authenticated session and
must authorize the specific status, create, request, receive, balance, outputs,
or reset action. Persisted local wallet/issuer/revocation state is bounded,
owner-only, atomically replaced, and fails closed on corruption or symlinks.

Version 0.6 changes the generated server-wallet route from implicit access to
explicit application authorization. A previously deployed route such as:

```ts
const handler = createServerWalletHandler()
```

must be configured with authenticated, action-level policy:

```ts
const handler = createServerWalletHandler({
  authorize: async ({ action, headers }) => {
    const session = await authenticateApplicationRequest(headers)
    return session?.canUseServerWallet(action) === true
  }
})
```

Until that callback returns literal `true`, every status, create, request,
receive, balance, outputs, and reset request returns HTTP 403. Roll out the
authentication layer and callback with the package upgrade, update probes or
automation that called these routes anonymously, and verify every replica uses
the same policy before exposing the route. Do not restore the old deployment
behavior with an unconditional public `authorize: () => true` callback.

Token and DID custom-input spends locate the requested outpoint rather than
assuming input zero, sign only that input, and require the wallet's final
transaction to preserve every inspected input and output. Incoming MessageBox
tokens are bounded and rebound to a fresh authenticated envelope before
internalization; body or caller metadata cannot replace the authenticated
sender or transaction.

## A taste of the API

```typescript
import { createWallet } from '@bsv/simple/browser'

// Connect to the user's wallet
const wallet = await createWallet()

// Send a payment
await wallet.pay({ to: recipientKey, satoshis: 1000, memo: 'Coffee' })

// Create an encrypted token
await wallet.createToken({ data: { type: 'loyalty', points: 50 }, basket: 'rewards' })

// Inscribe text on-chain
await wallet.inscribeText('Hello BSV!')

// Get your DID
const did = wallet.getDID()
// { id: 'did:bsv:02abc...', ... }
```

## Next Steps

- [Quick Start](docs/quick-start.md) — Get running in 5 minutes
- [Installation](docs/installation.md) — Detailed setup instructions
- [Architecture](docs/architecture.md) — How the library is built

## License

TS Stack first-party changes are under the [Open BSV License Version 6](./LICENSE.txt).
The identified pre-monorepo source remains MIT-licensed; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and [LICENSES/](./LICENSES/).

## Next dependency release candidate

This candidate refreshes the packed first-party dependency ranges for the next
wallet interoperability release. It adds no independent API or wire-format
change. Adopt after the new dependency graph is published; current wallet
releases retain their existing published pins.
