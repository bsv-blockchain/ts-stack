# Architecture

## Design Principles

1. **One import, full access** — `createWallet()` returns a single object with every method attached.
2. **Modular internals** — Each feature (tokens, inscriptions, messagebox, etc.) is a separate module that can be understood independently.
3. **Browser/server parity** — Same API surface whether you're in the browser or on the server.
4. **Progressive complexity** — Simple things are simple (`wallet.pay()`), complex things are possible (`wallet.send()` with multi-output specs).

## Module Composition

The library uses a mixin pattern to compose wallet functionality:

```
WalletCore (abstract base)
  ├── _BrowserWallet (wraps WalletClient)
  └── _ServerWallet  (wraps ToolboxWallet)

Modules (mixed in via Object.assign):
  ├── tokens        → createToken, listTokenDetails, sendToken, redeemToken, ...
  ├── inscriptions  → inscribeText, inscribeJSON, inscribeFileHash, inscribeImageHash
  ├── messagebox    → certifyForMessageBox, sendMessageBoxPayment, ...
  ├── certification → acquireCertificateFrom, listCertificatesFrom, relinquishCert
  ├── overlay       → advertiseSHIP, advertiseSLAP, broadcastAction, withRetry
  ├── did           → getDID, resolveDID, registerDID
  └── credentials   → acquireCredential, listCredentials, createPresentation
```

When you call `createWallet()`, the library:

1. Creates a `WalletClient` and connects to the browser extension
2. Instantiates `_BrowserWallet` (which extends `WalletCore`)
3. Calls each module factory (`createTokenMethods(wallet)`, `createInscriptionMethods(wallet)`, etc.)
4. Merges all returned methods onto the wallet object via `Object.assign()`
5. Returns the composed wallet with the union type `BrowserWallet`

The same process happens for `ServerWallet.create()`, but with `ToolboxWallet` from `@bsv/wallet-toolbox` instead of `WalletClient`.

## WalletCore — The Base Class

`WalletCore` is an abstract class that provides:

- **Wallet info**: `getIdentityKey()`, `getAddress()`, `getStatus()`, `getWalletInfo()`
- **Key derivation**: `derivePublicKey()`, `derivePaymentKey()`
- **Core transaction methods**: `pay()`, `send()`, `fundServerWallet()`

Subclasses must implement `getClient(): WalletInterface` to provide the underlying wallet.

## Output Routing in `send()`

The `send()` method is the core primitive. It takes an array of output specifications and routes each one based on what fields are present:

| Fields Present | Output Type | Result |
|---------------|-------------|--------|
| `to` only | **P2PKH** | Standard payment to an address |
| `data` only | **OP_RETURN** | Data inscription (0 satoshis) |
| `to` + `data` | **PushDrop** | Encrypted token locked to a key |

```typescript
await wallet.send({
  outputs: [
    { to: key, satoshis: 500 },                           // → P2PKH
    { data: ['Hello!'] },                                   // → OP_RETURN
    { to: key, data: [{ v: 1 }], satoshis: 1 }            // → PushDrop
  ]
})
```

## Standalone Classes

Some classes work independently of any wallet:

| Class | Purpose | Import |
|-------|---------|--------|
| `DID` | Generate/parse/validate `did:bsv:` identifiers | `@bsv/simple/browser` |
| `Certifier` | Issue BSV certificates | `@bsv/simple/browser` |
| `Overlay` | Create topic broadcasters and lookup resolvers | `@bsv/simple/browser` |
| `CredentialSchema` | Define and validate credential field schemas | `@bsv/simple/browser` |
| `CredentialIssuer` | Issue, verify, and revoke W3C Verifiable Credentials | `@bsv/simple/browser` |
| `MemoryRevocationStore` | In-memory revocation secret storage (browser/tests) | `@bsv/simple/browser` |
| `FileRevocationStore` | File-based revocation secret storage (server only) | `@bsv/simple/server` |

## Basket System

BSV wallets organize outputs into **baskets** — named groups that let you track and query outputs by category. Think of them as folders for your UTXOs.

```
my-payments/          → Payment outputs
my-tokens/            → PushDrop tokens
my-change/            → Recovered change outputs
text/                 → Text inscriptions
json/                 → JSON inscriptions
revocation-utxos/     → Credential revocation locks
```

Many methods accept a `basket` parameter to specify where outputs should be stored.

## Dependencies

| Package | Role | Environment |
|---------|------|-------------|
| `@bsv/sdk` | Core blockchain primitives, cryptography, WalletClient | Browser + Server |
| `@bsv/wallet-toolbox` | ToolboxWallet, WalletSigner, StorageClient | Server only |
| `@bsv/wallet-toolbox-client` | Client-only wallet storage (browser-safe alternative) | Browser |
| `@bsv/message-box-client` | PeerPayClient for P2P messaging | Browser + Server |
