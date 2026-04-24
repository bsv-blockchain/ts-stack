# @bsv/simple

A high-level TypeScript library that makes BSV blockchain development simple. Build wallets, send payments, create tokens, issue credentials, and more — in just a few lines of code.

## What is @bsv/simple?

`@bsv/simple` wraps the low-level `@bsv/sdk` into a clean, modular API. Instead of manually constructing locking scripts, managing key derivation, and handling transaction internalization, you call methods like `wallet.pay()`, `wallet.createToken()`, and `wallet.inscribeText()`.

## What can you build?

| Feature | Description |
|---------|-------------|
| **Payments** | Send BSV to any identity key via BRC-29 peer-to-peer payments |
| **Multi-Output Transactions** | Combine P2PKH payments, OP_RETURN data, and PushDrop tokens in a single transaction |
| **Encrypted Tokens** | Create, transfer, and redeem PushDrop tokens with encrypted payloads |
| **Inscriptions** | Write text, JSON, or file hashes permanently to the blockchain |
| **MessageBox P2P** | Send and receive payments and tokens peer-to-peer via MessageBox |
| **Certification** | Issue and manage BSV certificates with a standalone Certifier |
| **Verifiable Credentials** | W3C-compatible VCs backed by BSV certificates, with on-chain revocation |
| **DIDs** | Generate and resolve `did:bsv:` Decentralized Identifiers |
| **Overlay Networks** | Broadcast to and query SHIP/SLAP overlay services |
| **Server Wallet** | Run a backend wallet for automated operations and funding flows |

## Browser vs Server

The library has two entry points:

- **`@bsv/simple`** (default) — Browser-safe. Uses `WalletClient` from `@bsv/sdk` to connect to the user's wallet on the client side. Will not pull in any server-only dependencies.
- **`@bsv/simple/server`** — Uses `@bsv/wallet-toolbox` to run a server-side wallet from a private key. Used for agents, or servers receiving payments.

Both entry points provide the same API surface — the only difference is how they connect to the underlying wallet.

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

- [Quick Start](quick-start.md) — Get running in 5 minutes
- [Installation](installation.md) — Detailed setup instructions
- [Architecture](architecture.md) — How the library is built

# Table of Contents

* [Introduction](README.md)
* [Quick Start](quick-start.md)
* [Installation](installation.md)
* [Architecture](architecture.md)

## Guides

* [Browser Wallet](guides/browser-wallet.md)
* [Server Wallet](guides/server-wallet.md)
* [Payments](guides/payments.md)
* [Tokens](guides/tokens.md)
* [Inscriptions](guides/inscriptions.md)
* [MessageBox & P2P](guides/messagebox.md)
* [Certification](guides/certification.md)
* [DID (Decentralized Identity)](guides/did.md)
* [Verifiable Credentials](guides/credentials.md)
* [Overlay Networks](guides/overlay.md)
* [Next.js Integration](guides/nextjs-integration.md)

## API Reference

* [WalletCore](api-reference/wallet-core.md)
* [BrowserWallet](api-reference/browser-wallet.md)
* [ServerWallet](api-reference/server-wallet.md)
* [Tokens Module](api-reference/tokens.md)
* [Inscriptions Module](api-reference/inscriptions.md)
* [MessageBox Module](api-reference/messagebox.md)
* [Certification Module](api-reference/certification.md)
* [DID Module](api-reference/did.md)
* [Credentials Module](api-reference/credentials.md)
* [Overlay Module](api-reference/overlay.md)
* [Types](api-reference/types.md)
* [Errors](api-reference/errors.md)

## Advanced

* [Gotchas & Pitfalls](gotchas.md)
* [MCP Server](mcp-server.md)
