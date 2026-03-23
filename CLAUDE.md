# @bsv/simple v2 — AI Knowledge Base

## 1. Library Architecture

**Package:** `@bsv/simple` v0.2.3

**Entry points:**
- `@bsv/simple` — Browser-safe exports only (no server utilities)
- `@bsv/simple/browser` — Browser-only: `createWallet()`, `Wallet`, `Overlay`, `Certifier`, `DID`, `CredentialSchema`, `CredentialIssuer`, `MemoryRevocationStore`
- `@bsv/simple/server` — Server-only: `ServerWallet`, `FileRevocationStore`, `generatePrivateKey()`, handler factories (`createIdentityRegistryHandler`, `createDIDResolverHandler`, `createServerWalletHandler`, `createCredentialIssuerHandler`), utility classes (`JsonFileStore`, `IdentityRegistry`, `DIDResolverService`, `ServerWalletManager`)

**Module composition pattern:** `WalletCore` (abstract base) defines shared methods. `_BrowserWallet` / `_ServerWallet` extend it. Factory functions (`createWallet`, `ServerWallet.create`) instantiate the class then `Object.assign()` mixin methods from each module. The composed type is a union: `_BrowserWallet & TokenMethods & InscriptionMethods & MessageBoxMethods & CertificationMethods & OverlayMethods & DIDMethods & CredentialMethods`.

**Build:** `npm run build` (runs `tsc`)

**Dependencies:**
- `@bsv/sdk` ^2.0.4 — Core BSV blockchain SDK
- `@bsv/wallet-toolbox` ^2.0.19 — Backend wallet (Node.js only, used by ServerWallet)
- `@bsv/wallet-toolbox-client` ^2.0.19 — Wallet toolbox client
- `@bsv/message-box-client` ^2.0.2 — PeerPayClient for P2P messaging

**Source layout:**
```
src/
├── core/
│   ├── WalletCore.ts    — Abstract base: wallet info, key derivation, pay, send, fundServerWallet
│   ├── types.ts         — All shared TypeScript interfaces (including server handler config types)
│   ├── errors.ts        — Error classes: SimpleError, WalletError, TransactionError, MessageBoxError, CertificationError, DIDError, CredentialError
│   └── defaults.ts      — DEFAULT_CONFIG, mergeDefaults()
├── modules/
│   ├── tokens.ts        — createTokenMethods(): createToken, listTokenDetails, sendToken, redeemToken, sendTokenViaMessageBox, listIncomingTokens, acceptIncomingToken
│   ├── inscriptions.ts  — createInscriptionMethods(): inscribeText, inscribeJSON, inscribeFileHash, inscribeImageHash
│   ├── messagebox.ts    — createMessageBoxMethods(): certifyForMessageBox, getMessageBoxHandle, revokeMessageBoxCertification, sendMessageBoxPayment, listIncomingPayments, acceptIncomingPayment, registerIdentityTag, lookupIdentityByTag, listMyTags, revokeIdentityTag
│   ├── certification.ts — Certifier class + createCertificationMethods(): acquireCertificateFrom, listCertificatesFrom, relinquishCert
│   ├── overlay.ts       — Overlay class + createOverlayMethods(): advertiseSHIP, advertiseSLAP, broadcastAction, withRetry
│   ├── did.ts           — DID class + createDIDMethods(): getDID, resolveDID, registerDID
│   ├── credentials.ts   — CredentialSchema, CredentialIssuer, MemoryRevocationStore, toVerifiableCredential, toVerifiablePresentation + createCredentialMethods(): acquireCredential, listCredentials, createPresentation
│   └── file-revocation-store.ts — FileRevocationStore (Node.js only, uses fs)
├── server/
│   ├── handler-types.ts           — HandlerRequest, HandlerResponse, toNextHandlers() (framework-agnostic)
│   ├── json-file-store.ts         — JsonFileStore<T> generic file persistence
│   ├── identity-registry.ts       — IdentityRegistry class + createIdentityRegistryHandler()
│   ├── did-resolver.ts            — DIDResolverService class + createDIDResolverHandler()
│   ├── server-wallet-manager.ts   — ServerWalletManager class + createServerWalletHandler()
│   ├── credential-issuer-handler.ts — createCredentialIssuerHandler()
│   └── index.ts                   — Re-exports all server/ utilities
├── browser.ts           — BrowserWallet type + createWallet() factory + re-exports
├── server.ts            — ServerWallet type + ServerWallet.create() factory + generatePrivateKey() + re-exports from server/ + re-exports from browser
└── index.ts             — Browser-safe exports only (no server utilities)
```

---

## 2. Critical Gotchas

1. **`basket insertion` vs `wallet payment` are MUTUALLY EXCLUSIVE** in `internalizeAction`. You cannot use both on the same output. `wallet payment` provides derivation info for spending (output NOT in any app basket). `basket insertion` puts output in a named basket (derivation info goes in `customInstructions`).

2. **PeerPayClient.acceptPayment() swallows errors** — Returns the string `'Unable to receive payment!'` instead of throwing. Always check: `if (typeof result === 'string') throw new Error(result)`.

3. **`result.tx` from `createAction` may be `undefined`** — Always check before using for overlay broadcasting.

4. **BRC-29 Payment Derivation Protocol ID:** `[2, '3241645161d8']`

5. **FileRevocationStore is server-only** — It's in a separate file (`file-revocation-store.ts`) to avoid bundling Node.js `fs` in browser builds. Import from `@bsv/simple/server`.

6. **Overlay topics must start with `tm_`**, lookup services must start with `ls_`** — The Overlay class enforces these prefixes and throws if violated.

7. **Token send/redeem uses signableTransaction flow** — These operations require a two-step `createAction` → `signAction` pattern with PushDrop unlock templates.

8. **PeerPayClient instance is lazily created and reused** — The messagebox module creates one `PeerPayClient` per wallet instance and reuses it across calls.

9. **`pay()` uses PeerPayClient.sendPayment()** — Payments are routed via MessageBox P2P, not direct on-chain P2PKH. For direct on-chain payments, use `send()` with a P2PKH output.

10. **Server exports not available from `@bsv/simple`** — Server-only utilities (ServerWallet, handler factories, FileRevocationStore, generatePrivateKey) must be imported from `@bsv/simple/server`.

---

## 3. Browser Wallet API

### Initialization

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()
// Optional: pass defaults
const wallet = await createWallet({ network: 'main' })
```

### Wallet Info (WalletCore)

| Method | Returns | Description |
|--------|---------|-------------|
| `getIdentityKey()` | `string` | Compressed public key hex (66 chars) |
| `getAddress()` | `string` | P2PKH address derived from identity key |
| `getStatus()` | `WalletStatus` | `{ isConnected, identityKey, network }` |
| `getWalletInfo()` | `WalletInfo` | `{ identityKey, address, network, isConnected }` |
| `getClient()` | `WalletInterface` | Underlying SDK wallet client |

### Key Derivation (WalletCore)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `derivePublicKey(protocolID, keyID, counterparty?, forSelf?)` | `[SecurityLevel, string], string, string?, boolean?` | `Promise<string>` | Derive public key for any protocol |
| `derivePaymentKey(counterparty, invoiceNumber?)` | `string, string?` | `Promise<string>` | Derive BRC-29 payment key |

### Payments (WalletCore)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `pay(options)` | `PaymentOptions` | `Promise<TransactionResult>` | Payment via MessageBox P2P (PeerPayClient) |
| `send(options)` | `SendOptions` | `Promise<SendResult>` | Multi-output: P2PKH + OP_RETURN + PushDrop in one tx |
| `fundServerWallet(request, basket?)` | `PaymentRequest, string?` | `Promise<TransactionResult>` | Fund a ServerWallet using BRC-29 derivation (legacy) |

### Direct Payments — BRC-29 Wallet Payment Internalization (WalletCore)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `createPaymentRequest(options)` | `{ satoshis, memo? }` | `PaymentRequest` | Generate BRC-29 derivation data for someone to pay you |
| `sendDirectPayment(request)` | `PaymentRequest` | `Promise<DirectPaymentResult>` | Create BRC-29 derived P2PKH tx + return remittance data |
| `receiveDirectPayment(payment)` | `IncomingPayment` | `Promise<void>` | Internalize into wallet balance via `wallet payment` (NOT into a basket) |

### Tokens (tokens module)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `createToken(options)` | `TokenOptions` | `Promise<TokenResult>` | Create encrypted PushDrop token |
| `listTokenDetails(basket?)` | `string?` | `Promise<TokenDetail[]>` | List + decrypt tokens in a basket |
| `sendToken(options)` | `SendTokenOptions` | `Promise<TransactionResult>` | Transfer token to another key (on-chain) |
| `redeemToken(options)` | `RedeemTokenOptions` | `Promise<TransactionResult>` | Spend/destroy a token |
| `sendTokenViaMessageBox(options)` | `SendTokenOptions` | `Promise<TransactionResult>` | Transfer token via MessageBox P2P |
| `listIncomingTokens()` | — | `Promise<any[]>` | List tokens waiting in MessageBox inbox |
| `acceptIncomingToken(token, basket?)` | `any, string?` | `Promise<any>` | Accept incoming token into a basket |

### Inscriptions (inscriptions module)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `inscribeText(text, opts?)` | `string, { basket?, description? }?` | `Promise<InscriptionResult>` | OP_RETURN text inscription |
| `inscribeJSON(data, opts?)` | `object, { basket?, description? }?` | `Promise<InscriptionResult>` | OP_RETURN JSON inscription |
| `inscribeFileHash(hash, opts?)` | `string, { basket?, description? }?` | `Promise<InscriptionResult>` | OP_RETURN SHA-256 file hash |
| `inscribeImageHash(hash, opts?)` | `string, { basket?, description? }?` | `Promise<InscriptionResult>` | OP_RETURN SHA-256 image hash |

### MessageBox (messagebox module)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `certifyForMessageBox(handle, registryUrl?, host?)` | `string, string?, string?` | `Promise<{ txid, handle }>` | Register handle + anoint MessageBox host |
| `getMessageBoxHandle(registryUrl?)` | `string?` | `Promise<string \| null>` | Check if wallet has a registered handle |
| `revokeMessageBoxCertification(registryUrl?)` | `string?` | `Promise<void>` | Remove all registered handles |
| `sendMessageBoxPayment(to, satoshis)` | `string, number` | `Promise<any>` | Send payment via MessageBox P2P |
| `listIncomingPayments()` | — | `Promise<any[]>` | List payments in MessageBox inbox |
| `acceptIncomingPayment(payment, basket?)` | `any, string?` | `Promise<any>` | Accept payment (into basket or via PeerPay) |
| `registerIdentityTag(tag, registryUrl?)` | `string, string?` | `Promise<{ tag }>` | Register an identity tag |
| `lookupIdentityByTag(query, registryUrl?)` | `string, string?` | `Promise<{ tag, identityKey }[]>` | Search identity registry |
| `listMyTags(registryUrl?)` | `string?` | `Promise<{ tag, createdAt }[]>` | List own registered tags |
| `revokeIdentityTag(tag, registryUrl?)` | `string, string?` | `Promise<void>` | Remove a registered tag |

### Certification (certification module)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `acquireCertificateFrom(config)` | `{ serverUrl, replaceExisting? }` | `Promise<CertificateData>` | Acquire certificate from remote server (uses `?action=info` and `?action=certify` query params) |
| `listCertificatesFrom(config)` | `{ certifiers, types, limit? }` | `Promise<{ totalCertificates, certificates }>` | List certificates by certifier/type |
| `relinquishCert(args)` | `{ type, serialNumber, certifier }` | `Promise<void>` | Revoke/relinquish a certificate |

### DID (did module)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `getDID()` | — | `DIDDocument` | Get this wallet's DID Document |
| `resolveDID(didString)` | `string` | `DIDDocument` | Resolve any `did:bsv:` to its DID Document |
| `registerDID(options?)` | `{ persist? }?` | `Promise<DIDDocument>` | Persist DID as a BSV certificate |

### Credentials (credentials module)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `acquireCredential(config)` | `{ serverUrl, schemaId?, fields?, replaceExisting? }` | `Promise<VerifiableCredential>` | Acquire VC from remote issuer |
| `listCredentials(config)` | `{ certifiers, types, limit? }` | `Promise<VerifiableCredential[]>` | List wallet certs as W3C VCs |
| `createPresentation(credentials)` | `VerifiableCredential[]` | `VerifiablePresentation` | Wrap VCs into a VP |

---

## 4. Server Wallet API

### Initialization

```typescript
// In a Next.js API route (server-only):
const { ServerWallet } = await import('@bsv/simple/server')

const wallet = await ServerWallet.create({
  privateKey: 'hex_private_key',
  network: 'main',                          // optional, default 'main'
  storageUrl: 'https://storage.babbage.systems'  // optional
})
```

### ServerWallet-specific Methods

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `receivePayment(payment)` | `IncomingPayment` | `Promise<void>` | **Deprecated.** Use `receiveDirectPayment()` (inherited from WalletCore). Kept for backward compat with `server_funding` label. |

### Shared Methods

ServerWallet has all the same methods as BrowserWallet (pay, send, createToken, inscribeText, createPaymentRequest, sendDirectPayment, receiveDirectPayment, etc.) via the same module composition pattern.

---

## 5. Standalone Classes

### DID

```typescript
import { DID } from '@bsv/simple/browser'

DID.fromIdentityKey('02abc...')   // → DIDDocument
DID.parse('did:bsv:02abc...')     // → { method: 'bsv', identityKey: '02abc...' }
DID.isValid('did:bsv:02abc...')   // → boolean
DID.getCertificateType()          // → base64 string for 'did:bsv'
```

### Certifier

```typescript
import { Certifier } from '@bsv/simple/browser'

const certifier = await Certifier.create()                     // random key
const certifier = await Certifier.create({ privateKey: 'hex' }) // specific key
const certifier = await Certifier.create({
  privateKey: 'hex',
  certificateType: 'base64type',
  defaultFields: { role: 'admin' },
  includeTimestamp: true  // default: true
})

certifier.getInfo()           // → { publicKey, certificateType }
await certifier.certify(wallet, { extra: 'field' })  // → CertificateData (also acquires into wallet)
```

### CredentialSchema

```typescript
import { CredentialSchema } from '@bsv/simple/browser'

const schema = new CredentialSchema({
  id: 'my-schema',
  name: 'My Credential',
  description: 'Optional description',
  fields: [
    { key: 'name', label: 'Full Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'role', label: 'Role', type: 'select', options: [{ value: 'admin', label: 'Admin' }] }
  ],
  validate: (values) => values.name.length < 2 ? 'Name too short' : null,
  computedFields: (values) => ({ verified: 'true', timestamp: Date.now().toString() })
})

schema.validate({ name: 'A', email: 'test@test.com' })  // → 'Name too short'
schema.computeFields({ name: 'Alice' })                   // → { name: 'Alice', verified: 'true', ... }
schema.getInfo()  // → { id, name, description, certificateTypeBase64, fieldCount }
```

### CredentialIssuer

```typescript
import { CredentialIssuer } from '@bsv/simple/browser'

const issuer = await CredentialIssuer.create({
  privateKey: 'hex_key',
  schemas: [schemaConfig],            // CredentialSchemaConfig[]
  revocation: {
    enabled: true,
    wallet: serverWalletInstance,      // WalletInterface for creating revocation UTXOs
    store: new MemoryRevocationStore() // or FileRevocationStore for server
  }
})

const vc = await issuer.issue(subjectIdentityKey, 'schema-id', { name: 'Alice' })
const result = await issuer.verify(vc)       // → { valid, revoked, errors, issuer, subject, type }
await issuer.revoke(serialNumber)            // → { txid }
await issuer.isRevoked(serialNumber)         // → boolean
issuer.getInfo()                             // → { publicKey, did, schemas: [{ id, name }] }
```

### MemoryRevocationStore / FileRevocationStore

```typescript
import { MemoryRevocationStore } from '@bsv/simple/browser'
import { FileRevocationStore } from '@bsv/simple/server'

// Memory (browser/tests)
const store = new MemoryRevocationStore()

// File (server — writes .revocation-secrets.json)
const store = new FileRevocationStore()                       // default path
const store = new FileRevocationStore('/path/to/secrets.json') // custom path

// Both implement RevocationStore interface:
await store.save(serialNumber, { secret, outpoint, beef })
await store.load(serialNumber)  // → RevocationRecord | undefined
await store.delete(serialNumber)
await store.has(serialNumber)   // → boolean
await store.findByOutpoint(outpoint)  // → boolean
```

### Overlay

```typescript
import { Overlay } from '@bsv/simple/browser'

const overlay = await Overlay.create({
  topics: ['tm_my_topic'],
  network: 'mainnet',                    // 'mainnet' | 'testnet' | 'local'
  slapTrackers: ['https://...'],         // optional
  hostOverrides: { tm_topic: ['url'] },  // optional
  additionalHosts: { tm_topic: ['url'] } // optional
})

overlay.getInfo()                         // → { topics, network }
overlay.addTopic('tm_new')               // add topic (must start with tm_)
overlay.removeTopic('tm_old')            // remove topic
await overlay.broadcast(transaction)      // → OverlayBroadcastResult
await overlay.broadcast(tx, ['tm_specific'])  // broadcast to specific topics
await overlay.query('ls_service', queryData)  // → LookupAnswer
await overlay.lookupOutputs('ls_service', q)  // → OverlayOutput[]
overlay.getBroadcaster()                  // raw TopicBroadcaster
overlay.getResolver()                     // raw LookupResolver
```

### W3C VC/VP Utilities

```typescript
import { toVerifiableCredential, toVerifiablePresentation } from '@bsv/simple/browser'

const vc = toVerifiableCredential(certData, issuerPublicKey, { credentialType: 'MyCredential' })
const vp = toVerifiablePresentation([vc1, vc2], holderPublicKey)
```

---

## 6. Server Handler Factories

Pre-built Next.js API route handlers that eliminate boilerplate. Each factory returns `{ GET, POST }` compatible with Next.js App Router. No `@bsv/sdk` import needed in consumer code.

### generatePrivateKey()

```typescript
import { generatePrivateKey } from '@bsv/simple/server'
const key = generatePrivateKey()  // random hex private key, no @bsv/sdk needed
```

### JsonFileStore\<T\>

Generic file-based JSON persistence used by all handlers internally. Also available for custom use.

```typescript
import { JsonFileStore } from '@bsv/simple/server'
const store = new JsonFileStore<{ name: string }>('/path/to/data.json')
store.save({ name: 'Alice' })
const data = store.load()  // { name: 'Alice' } | null
store.exists()             // boolean
store.delete()
```

### createIdentityRegistryHandler(config?)

Identity tag/handle registry for MessageBox. Replaces ~150 lines of route code with 3 lines.

```typescript
// app/api/identity-registry/route.ts
import { createIdentityRegistryHandler } from '@bsv/simple/server'
const handler = createIdentityRegistryHandler()
export const GET = handler.GET, POST = handler.POST
```

**Config options:**
```typescript
interface IdentityRegistryConfig {
  store?: IdentityRegistryStore    // Custom backend (default: file-based .identity-registry.json)
  validateTag?: (tag: string, identityKey: string) => string | null  // Custom validation
  maxTagsPerIdentity?: number      // Default: Infinity
}
```

**API contract** (matches what `messagebox.ts` already calls):
- `GET ?action=lookup&query=...` → `{ success, results: [{ tag, identityKey }] }`
- `GET ?action=list&identityKey=...` → `{ success, tags: [{ tag, createdAt }] }`
- `POST ?action=register` body: `{ tag, identityKey }` → `{ success, message, tag }`
- `POST ?action=revoke` body: `{ tag, identityKey }` → `{ success, message, tag }`

### createDIDResolverHandler(config?)

Server-side DID resolution proxy. Replaces ~322 lines of OP_RETURN parsing + WoC chain-following.

```typescript
// app/api/resolve-did/route.ts
import { createDIDResolverHandler } from '@bsv/simple/server'
const handler = createDIDResolverHandler()
export const GET = handler.GET
```

**Config options:**
```typescript
interface DIDResolverConfig {
  resolverUrl?: string       // Default: nChain Universal Resolver
  wocBaseUrl?: string        // Default: WoC mainnet API
  resolverTimeout?: number   // Default: 10000ms
  maxHops?: number           // Default: 100
}
```

**API:** `GET ?did=did:bsv:<txid>` → `DIDResolutionResult`

### createServerWalletHandler(config?)

Server wallet with lazy-init singleton + key persistence. Replaces ~105 lines of boilerplate.

```typescript
// app/api/server-wallet/route.ts
import { createServerWalletHandler } from '@bsv/simple/server'
const handler = createServerWalletHandler()
export const GET = handler.GET, POST = handler.POST
```

**Config options:**
```typescript
interface ServerWalletManagerConfig {
  envVar?: string               // Default: 'SERVER_PRIVATE_KEY'
  keyFile?: string              // Default: '.server-wallet.json' in cwd
  network?: 'main' | 'testnet'
  storageUrl?: string           // Default: 'https://storage.babbage.systems'
  defaultRequestSatoshis?: number  // Default: 1000
  requestMemo?: string
}
```

**API:**
- `GET ?action=create|status|request|balance|outputs|reset`
- `POST ?action=receive` body: `{ tx, senderIdentityKey, derivationPrefix, derivationSuffix, outputIndex }`

### createCredentialIssuerHandler(config)

W3C Verifiable Credential issuer. Replaces ~220 lines + `[[...path]]` catch-all route. Uses a normal `route.ts`.

```typescript
// app/api/credential-issuer/route.ts  (no [[...path]] needed!)
import { createCredentialIssuerHandler } from '@bsv/simple/server'
const handler = createCredentialIssuerHandler({
  schemas: [{
    id: 'freelancer-verified',
    name: 'VerifiedFreelancer',
    fields: [
      { key: 'name', label: 'Full Name', type: 'text', required: true },
      { key: 'skill', label: 'Primary Skill', type: 'select', required: true },
      { key: 'rate', label: 'Hourly Rate', type: 'number', required: true },
    ]
  }]
})
export const GET = handler.GET, POST = handler.POST
```

**Config options:**
```typescript
interface CredentialIssuerHandlerConfig {
  schemas: CredentialSchemaConfig[]   // Required: at least one schema
  envVar?: string                     // Default: 'CREDENTIAL_ISSUER_KEY'
  keyFile?: string                    // Default: '.credential-issuer-key.json'
  serverWalletManager?: ServerWalletManager  // For revocation UTXOs
  revocationStorePath?: string
}
```

**API (query-param based):**
- `GET ?action=info` → `{ certifierPublicKey, certificateType, schemas }`
- `GET ?action=schema&id=...` → schema details
- `GET ?action=status&serialNumber=...` → revocation status
- `POST ?action=certify` body: `{ identityKey, schemaId, fields }` → `CertificateData`
- `POST ?action=issue` body: `{ subjectKey, schemaId, fields }` → `{ credential: VerifiableCredential }`
- `POST ?action=verify` body: `{ credential }` → `{ verification: VerificationResult }`
- `POST ?action=revoke` body: `{ serialNumber }` → `{ txid }`

Also supports legacy path-based `/api/info` and `/api/certify` for backward compatibility.

### IdentityRegistry (core class)

Framework-agnostic registry logic, usable outside Next.js:

```typescript
import { IdentityRegistry } from '@bsv/simple/server'
const registry = new IdentityRegistry()
registry.register('alice', identityKey)
registry.lookup('ali')    // [{ tag: 'alice', identityKey: '...' }]
registry.list(identityKey) // [{ tag: 'alice', createdAt: '...' }]
registry.revoke('alice', identityKey)
```

### DIDResolverService (core class)

```typescript
import { DIDResolverService } from '@bsv/simple/server'
const resolver = new DIDResolverService()
const result = await resolver.resolve('did:bsv:<txid>')
```

### ServerWalletManager (core class)

```typescript
import { ServerWalletManager } from '@bsv/simple/server'
const manager = new ServerWalletManager()
const wallet = await manager.getWallet()   // lazy init + key persist
manager.getStatus()  // { saved: boolean, identityKey: string | null }
manager.reset()
```

---

## 7. Next.js Integration Guide

### Import Patterns

```typescript
// Browser components (client-side):
'use client'
import { createWallet, Certifier, DID, Overlay } from '@bsv/simple/browser'
import { CredentialSchema, CredentialIssuer, MemoryRevocationStore } from '@bsv/simple/browser'

// Server API routes (handler factories — preferred):
import { createIdentityRegistryHandler } from '@bsv/simple/server'
import { createDIDResolverHandler } from '@bsv/simple/server'
import { createServerWalletHandler } from '@bsv/simple/server'
import { createCredentialIssuerHandler } from '@bsv/simple/server'

// Server utilities (when you need lower-level access):
const { ServerWallet, generatePrivateKey } = await import('@bsv/simple/server')
const { FileRevocationStore } = await import('@bsv/simple/server')
```

### next.config.ts (CRITICAL for Turbopack)

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@bsv/wallet-toolbox",
    "knex",
    "better-sqlite3",
    "tedious",
    "mysql",
    "mysql2",
    "pg",
    "pg-query-stream",
    "oracledb",
    "dotenv"
  ]
};

export default nextConfig;
```

Without `serverExternalPackages`, Turbopack will try to bundle `@bsv/wallet-toolbox` and its database drivers for the browser, causing build failures.

### Browser Wallet Setup

```typescript
'use client'
import { useState, useEffect } from 'react'
import { createWallet, type BrowserWallet } from '@bsv/simple/browser'

export default function Page() {
  const [wallet, setWallet] = useState<BrowserWallet | null>(null)

  const connect = async () => {
    const w = await createWallet()
    setWallet(w)
  }

  return <button onClick={connect}>Connect</button>
}
```

### Server API Routes (Simplified)

All server routes use handler factories — no boilerplate needed:

```typescript
// app/api/identity-registry/route.ts
import { createIdentityRegistryHandler } from '@bsv/simple/server'
const handler = createIdentityRegistryHandler()
export const GET = handler.GET, POST = handler.POST

// app/api/resolve-did/route.ts
import { createDIDResolverHandler } from '@bsv/simple/server'
const handler = createDIDResolverHandler()
export const GET = handler.GET

// app/api/server-wallet/route.ts
import { createServerWalletHandler } from '@bsv/simple/server'
const handler = createServerWalletHandler()
export const GET = handler.GET, POST = handler.POST

// app/api/credential-issuer/route.ts  (no [[...path]] needed!)
import { createCredentialIssuerHandler } from '@bsv/simple/server'
const handler = createCredentialIssuerHandler({
  schemas: [{ id: 'my-credential', name: 'MyCredential', fields: [...] }]
})
export const GET = handler.GET, POST = handler.POST
```

### Key Persistence Pattern

Server wallet private keys persist automatically via `ServerWalletManager`:
1. Check `process.env.SERVER_PRIVATE_KEY`
2. If not set, check `.server-wallet.json` file
3. If not found, generate key via `generatePrivateKey()` and save to file

No `@bsv/sdk` import needed — use `generatePrivateKey()` from `@bsv/simple/server`.

---

## 8. Code Recipes

### 7.1 Connect Wallet + Auto-check MessageBox Handle

```typescript
const wallet = await createWallet()
const handle = await wallet.getMessageBoxHandle('/api/identity-registry')
if (handle) {
  console.log('MessageBox handle:', handle)
} else {
  await wallet.certifyForMessageBox('@alice', '/api/identity-registry')
}
```

### 7.2 Simple Payment via MessageBox P2P

```typescript
const result = await wallet.pay({
  to: recipientKey,
  satoshis: 1000
})
console.log('TXID:', result.txid)
```

### 7.3 Multi-Output Send (P2PKH + OP_RETURN + PushDrop)

```typescript
const result = await wallet.send({
  outputs: [
    { to: recipientKey, satoshis: 1000, basket: 'payments' },                   // P2PKH
    { data: ['Hello blockchain!'], basket: 'text' },                             // OP_RETURN
    { to: wallet.getIdentityKey(), data: [{ value: 42 }], satoshis: 1, basket: 'tokens' }  // PushDrop
  ],
  description: 'Multi-output transaction'
})
// result.outputDetails: [{ index: 0, type: 'p2pkh' }, { index: 1, type: 'op_return' }, { index: 2, type: 'pushdrop' }]
```

### 7.4 Create / List / Send / Redeem Tokens

```typescript
// Create
const token = await wallet.createToken({
  data: { type: 'loyalty', points: 100 },
  basket: 'my-tokens',
  satoshis: 1
})

// List with decryption
const tokens = await wallet.listTokenDetails('my-tokens')
// [{ outpoint, satoshis, data: { type: 'loyalty', points: 100 }, protocolID, keyID, counterparty }]

// Send to another key
await wallet.sendToken({ basket: 'my-tokens', outpoint: tokens[0].outpoint, to: recipientKey })

// Redeem (destroy)
await wallet.redeemToken({ basket: 'my-tokens', outpoint: tokens[0].outpoint })
```

### 7.5 Token Transfer via MessageBox

```typescript
// Sender
await wallet.sendTokenViaMessageBox({ basket: 'my-tokens', outpoint: '...', to: recipientKey })

// Recipient
const incoming = await wallet.listIncomingTokens()
await wallet.acceptIncomingToken(incoming[0], 'received-tokens')
```

### 7.6 Text / JSON Inscriptions

```typescript
const text = await wallet.inscribeText('Hello blockchain!')
// { txid, type: 'text', dataSize: 17, basket: 'text' }

const json = await wallet.inscribeJSON({ title: 'Document', created: Date.now() })
// { txid, type: 'json', dataSize: ..., basket: 'json' }

const fileHash = await wallet.inscribeFileHash('a'.repeat(64))
// { txid, type: 'file-hash', dataSize: 64, basket: 'hash-document' }
```

### 7.7 MessageBox: Certify, Send, Receive Payments

```typescript
// Certify identity
await wallet.certifyForMessageBox('@alice', '/api/identity-registry')

// Search for someone
const results = await wallet.lookupIdentityByTag('bob', '/api/identity-registry')

// Send payment
await wallet.sendMessageBoxPayment(results[0].identityKey, 1000)

// Receive payments
const incoming = await wallet.listIncomingPayments()
await wallet.acceptIncomingPayment(incoming[0], 'received-payments')
```

### 7.8 Direct Payments (BRC-29 Wallet Payment Internalization)

```typescript
// Direct payments work on BOTH browser and server wallets.
// Funds go directly into the wallet's spendable balance (NOT into a basket).

// --- Flow: Browser pays Server ---

// Server: generate payment request
const request = serverWallet.createPaymentRequest({ satoshis: 2000 })

// Browser: create BRC-29 derived P2PKH transaction
const payment = await browserWallet.sendDirectPayment(request)

// Browser: send tx + remittance to server (via API)
await fetch('/api/receive-payment', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tx: Array.from(payment.tx),
    senderIdentityKey: payment.senderIdentityKey,
    derivationPrefix: payment.derivationPrefix,
    derivationSuffix: payment.derivationSuffix,
    outputIndex: payment.outputIndex
  })
})

// Server: internalize
await serverWallet.receiveDirectPayment({ tx, senderIdentityKey, derivationPrefix, derivationSuffix, outputIndex: 0 })

// --- Flow: Server pays Browser ---

// Browser: create payment request
const request = browserWallet.createPaymentRequest({ satoshis: 100 })
// ... send request to server via API ...

// Server: create payment
const payment = await serverWallet.sendDirectPayment(request)
// ... return payment data to browser ...

// Browser: internalize into wallet balance
await browserWallet.receiveDirectPayment({
  tx: paymentData.tx,
  senderIdentityKey: paymentData.senderIdentityKey,
  derivationPrefix: paymentData.derivationPrefix,
  derivationSuffix: paymentData.derivationSuffix,
  outputIndex: paymentData.outputIndex
})
```

### 7.8b Server Wallet: Legacy Fund Flow

```typescript
// Legacy pattern — prefer sendDirectPayment/receiveDirectPayment instead
const { ServerWallet } = await import('@bsv/simple/server')
const server = await ServerWallet.create({ privateKey: 'hex', network: 'main' })
const request = server.createPaymentRequest({ satoshis: 50000 })
const result = await wallet.fundServerWallet(request, 'server-funding')
await server.receivePayment({ tx, senderIdentityKey, derivationPrefix, derivationSuffix, outputIndex: 0 })
```

### 7.9 DID: Get, Register, Resolve

```typescript
import { DID } from '@bsv/simple/browser'

// Get DID document for this wallet
const didDoc = wallet.getDID()
// { '@context': [...], id: 'did:bsv:02abc...', controller: '...', verificationMethod: [...] }

// Register DID (persists as BSV certificate)
await wallet.registerDID()

// Resolve any DID
const doc = wallet.resolveDID('did:bsv:02abc...')

// Static utility
DID.isValid('did:bsv:02abc...')  // true
DID.parse('did:bsv:02abc...')    // { method: 'bsv', identityKey: '02abc...' }
```

### 7.10 Credentials: Issue VC, List VCs, Create Presentation

```typescript
import { CredentialIssuer, CredentialSchema, MemoryRevocationStore } from '@bsv/simple/browser'

// Define schema
const schema = new CredentialSchema({
  id: 'age-verification',
  name: 'AgeVerification',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'over18', label: 'Over 18', type: 'checkbox', required: true }
  ]
})

// Create issuer
const issuer = await CredentialIssuer.create({
  privateKey: 'hex_key',
  schemas: [schema.getConfig()],
  revocation: { enabled: false }
})

// Issue
const vc = await issuer.issue(subjectKey, 'age-verification', { name: 'Alice', over18: 'true' })

// List from wallet
const vcs = await wallet.listCredentials({
  certifiers: [issuer.getInfo().publicKey],
  types: [schema.getInfo().certificateTypeBase64]
})

// Create presentation
const vp = wallet.createPresentation(vcs)
```

### 7.11 Overlay: Create, Query, Advertise SHIP/SLAP

```typescript
import { Overlay } from '@bsv/simple/browser'

const overlay = await Overlay.create({ topics: ['tm_payments'], network: 'mainnet' })

// Advertise hosting
await wallet.advertiseSHIP('https://myserver.com', 'tm_payments', 'ship-tokens')
await wallet.advertiseSLAP('https://myserver.com', 'ls_payments', 'slap-tokens')

// Broadcast + query
const { txid, broadcast } = await wallet.broadcastAction(overlay, {
  outputs: [{ lockingScript: '...', satoshis: 1, outputDescription: 'Overlay output' }],
  description: 'Overlay broadcast'
}, ['tm_payments'])

const results = await overlay.lookupOutputs('ls_payments', { tag: 'recent' })
```

---

## 9. Type Reference

### Core Types

```typescript
type Network = 'main' | 'testnet'

interface WalletDefaults {
  network: Network; description: string; outputDescription: string
  tokenBasket: string; tokenProtocolID: [SecurityLevel, string]; tokenKeyID: string
  messageBoxHost: string; registryUrl?: string
  didBasket: string; didResolverUrl: string; didProxyUrl?: string; didProtocolID: [SecurityLevel, string]
}

interface PaymentOptions {
  to: string; satoshis: number; memo?: string; description?: string
}

interface SendOptions { outputs: SendOutputSpec[]; description?: string }

interface SendOutputSpec {
  to?: string; satoshis?: number; data?: Array<string | object | number[]>
  description?: string; basket?: string; protocolID?: [number, string]; keyID?: string
}
// Rules: to only → P2PKH | data only → OP_RETURN | to + data → PushDrop

interface TransactionResult { txid: string; tx: any; outputs?: OutputInfo[] }
interface SendResult extends TransactionResult { outputDetails: SendOutputDetail[] }
```

### Token Types

```typescript
interface TokenOptions { to?: string; data: any; basket?: string; protocolID?: [number, string]; keyID?: string; satoshis?: number }
interface TokenResult extends TransactionResult { basket: string; encrypted: boolean }
interface TokenDetail { outpoint: string; satoshis: number; data: any; protocolID: any; keyID: string; counterparty: string }
interface SendTokenOptions { basket: string; outpoint: string; to: string }
interface RedeemTokenOptions { basket: string; outpoint: string }
```

### Inscription Types

```typescript
type InscriptionType = 'text' | 'json' | 'file-hash' | 'image-hash'
interface InscriptionResult extends TransactionResult { type: InscriptionType; dataSize: number; basket: string }
```

### Server Wallet Types

```typescript
interface ServerWalletConfig { privateKey: string; network?: Network; storageUrl?: string }
interface PaymentRequest { serverIdentityKey: string; derivationPrefix: string; derivationSuffix: string; satoshis: number; memo?: string }
interface IncomingPayment { tx: number[] | Uint8Array; senderIdentityKey: string; derivationPrefix: string; derivationSuffix: string; outputIndex: number; description?: string }
interface DirectPaymentResult extends TransactionResult { senderIdentityKey: string; derivationPrefix: string; derivationSuffix: string; outputIndex: number }
```

### DID Types

```typescript
interface DIDDocument { '@context': string[]; id: string; controller: string; verificationMethod: DIDVerificationMethod[]; authentication: string[]; assertionMethod: string[] }
interface DIDParseResult { method: string; identifier: string }
```

### Credential Types

```typescript
interface CredentialSchemaConfig { id: string; name: string; description?: string; certificateTypeBase64?: string; fields: CredentialFieldSchema[]; validate?: (values) => string | null; computedFields?: (values) => Record<string, string> }
interface CredentialIssuerConfig { privateKey: string; schemas?: CredentialSchemaConfig[]; revocation?: { enabled: boolean; wallet?: any; store?: RevocationStore } }
interface VerifiableCredential { '@context': string[]; type: string[]; issuer: string; issuanceDate: string; credentialSubject: { id: string; [key: string]: any }; proof: { type: string; signatureValue: string; ... }; _bsv: { certificate: CertificateData } }
interface VerifiablePresentation { '@context': string[]; type: string[]; holder: string; verifiableCredential: VerifiableCredential[]; proof: { ... } }
interface RevocationStore { save: (sn: string, record: RevocationRecord) => Promise<void>; load: (sn: string) => Promise<RevocationRecord | undefined>; delete: (sn: string) => Promise<void>; has: (sn: string) => Promise<boolean>; findByOutpoint: (op: string) => Promise<boolean> }
```

### Overlay Types

```typescript
interface OverlayConfig { topics: string[]; network?: 'mainnet' | 'testnet' | 'local'; slapTrackers?: string[]; hostOverrides?: Record<string, string[]>; additionalHosts?: Record<string, string[]> }
interface OverlayBroadcastResult { success: boolean; txid?: string; code?: string; description?: string }
interface OverlayOutput { beef: number[]; outputIndex: number; context?: number[] }
```

### Server Handler Config Types

```typescript
interface IdentityRegistryConfig { store?: IdentityRegistryStore; validateTag?: (tag: string, identityKey: string) => string | null; maxTagsPerIdentity?: number }
interface IdentityRegistryStore { load: () => RegistryEntry[]; save: (entries: RegistryEntry[]) => void }
interface RegistryEntry { tag: string; identityKey: string; createdAt: string }
interface DIDResolverConfig { resolverUrl?: string; wocBaseUrl?: string; resolverTimeout?: number; maxHops?: number }
interface ServerWalletManagerConfig { envVar?: string; keyFile?: string; network?: Network; storageUrl?: string; defaultRequestSatoshis?: number; requestMemo?: string }
interface CredentialIssuerHandlerConfig { schemas: CredentialSchemaConfig[]; envVar?: string; keyFile?: string; serverWalletManager?: any; revocationStorePath?: string }
```

### Error Classes

```typescript
SimpleError          // base (code?: string)
├── WalletError          // WALLET_ERROR
├── TransactionError     // TRANSACTION_ERROR
├── MessageBoxError      // MESSAGEBOX_ERROR
├── CertificationError   // CERTIFICATION_ERROR
├── DIDError             // DID_ERROR
└── CredentialError      // CREDENTIAL_ERROR
```

### Default Configuration

```typescript
{
  network: 'main',
  description: 'BSV-Simplify transaction',
  outputDescription: 'BSV-Simplify output',
  tokenBasket: 'tokens',
  tokenProtocolID: [0, 'token'],
  tokenKeyID: '1',
  messageBoxHost: 'https://messagebox.babbage.systems',
  registryUrl: undefined,
  didBasket: 'did-chain',
  didResolverUrl: 'https://bsvdid-universal-resolver.nchain.systems',
  didProtocolID: [0, 'bsvdid']
}
```
