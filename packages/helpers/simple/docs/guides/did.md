# DID (Decentralized Identity)

`@bsv/simple` supports `did:bsv:` Decentralized Identifiers — W3C-compatible DIDs anchored on the BSV blockchain using UTXO chain linking.

## How it Works

A `did:bsv:` DID is identified by the **txid of its issuance transaction**:

```
did:bsv:d803b04af611b67074af7864e5ee520060265547f8b929f2494b3e05af190636
```

The DID lifecycle uses a chain of UTXO spends:

1. **TX0 (Issuance)** — Creates a chain UTXO (output 0) + OP_RETURN with `BSVDID` marker and payload `"1"`. The txid becomes the DID identifier.
2. **TX1 (Document)** — Spends TX0 output 0, creates a new chain UTXO (output 0) + OP_RETURN with the full DID Document as JSON.
3. **TX2+ (Updates)** — Same pattern: spend previous output 0, create new chain UTXO + updated document.
4. **Revocation** — Spend the chain UTXO with OP_RETURN payload `"3"`. Chain terminates.

Any resolver can follow this output-0-spend chain to discover the latest DID Document.

## Creating a DID

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()

const result = await wallet.createDID()
console.log(result.did)          // 'did:bsv:<txid>'
console.log(result.document)     // Full W3C DID Document
console.log(result.identityCode) // Internal identity code
```

With services:

```typescript
const result = await wallet.createDID({
  services: [
    {
      id: 'did:bsv:<txid>#messaging',
      type: 'MessagingService',
      serviceEndpoint: 'https://example.com/messages'
    }
  ]
})
```

## DID Document Structure (V2)

```json
{
  "@context": "https://www.w3.org/ns/did/v1",
  "id": "did:bsv:d803b04a...",
  "verificationMethod": [
    {
      "id": "did:bsv:d803b04a...#subject-key",
      "type": "JsonWebKey2020",
      "controller": "did:bsv:d803b04a...",
      "publicKeyJwk": {
        "kty": "EC",
        "crv": "secp256k1",
        "x": "...",
        "y": "..."
      }
    }
  ],
  "authentication": ["did:bsv:d803b04a...#subject-key"],
  "controller": "did:bsv:d803b04a..."
}
```

## Resolving a DID

### Same Wallet (Fast Path)

Resolving your own DID checks the local basket first — no network calls needed:

```typescript
const result = await wallet.resolveDID('did:bsv:<your-txid>')
console.log(result.didDocument)         // DID Document
console.log(result.didDocumentMetadata) // { created, updated, versionId }
```

### Cross-Wallet Resolution

Resolving a DID created by **another wallet** requires on-chain lookups. In a browser environment, this needs a **server-side proxy** because:

- The nChain Universal Resolver (`bsvdid-universal-resolver.nchain.systems`) is currently unreliable (returns HTTP 500)
- Direct WhatsOnChain API calls from browsers are blocked by CORS and rate-limited (HTTP 429)

The proxy makes all external API calls server-side where there are no CORS restrictions or browser rate limits.

#### Resolution Flow

```
Browser: wallet.resolveDID(did)
  1. Check local basket (own DIDs) → fast return
  2. Call proxy: GET /api/resolve-did?did=did:bsv:<txid>

Proxy (server-side):
  1. Try nChain Universal Resolver
     - 200 → return document
     - 410 → return deactivated
  2. On any nChain error → WoC chain-following:
     a. Fetch TX from WoC
     b. Parse OP_RETURN for BSVDID marker
     c. Follow output 0 spend chain
     d. Return last document found
```

## Setting Up the Resolution Proxy

### 1. Create the API Route

Create `app/api/resolve-did/route.ts` in your Next.js app using the handler factory:

```typescript
// app/api/resolve-did/route.ts
import { createDIDResolverHandler } from '@bsv/simple/server'
const handler = createDIDResolverHandler()
export const GET = handler.GET
```

That's it. The handler automatically:
- Tries the nChain Universal Resolver first (10s timeout)
- Falls back to WoC chain-following on failure (parses OP_RETURN, follows output-0 spend chain)
- Handles deactivated DIDs (returns `deactivated: true`)
- Limits chain hops to 100

**API:** `GET ?did=did:bsv:<txid>` → `DIDResolutionResult`

**Custom config (optional):**
```typescript
createDIDResolverHandler({
  resolverUrl: 'https://custom-resolver.com',  // nChain Universal Resolver by default
  wocBaseUrl: 'https://api.whatsonchain.com',   // WoC fallback
  resolverTimeout: 10000,                        // ms
  maxHops: 100                                   // chain-following limit
})
```

### 2. Configure the Wallet

Pass `didProxyUrl` in your wallet defaults so `resolveDID()` uses the proxy:

```typescript
const wallet = await createWallet({
  didProxyUrl: '/api/resolve-did'
})
```

Or if your proxy is hosted elsewhere:

```typescript
const wallet = await createWallet({
  didProxyUrl: 'https://my-app.com/api/resolve-did'
})
```

### 3. Resolve Cross-Wallet

```typescript
// Wallet A creates a DID
const { did } = await walletA.createDID()
console.log(did) // 'did:bsv:d803b04a...'

// Wallet B resolves it (goes through proxy → WoC chain-following)
const result = await walletB.resolveDID(did)
console.log(result.didDocument)          // Full DID Document
console.log(result.didDocumentMetadata)  // { created, updated, versionId }
```

## Updating a DID

```typescript
const result = await wallet.updateDID({
  did: 'did:bsv:<txid>',
  services: [
    {
      id: 'did:bsv:<txid>#api',
      type: 'APIService',
      serviceEndpoint: 'https://api.example.com'
    }
  ],
  additionalKeys: ['03abc...'] // Optional extra verification keys
})
```

## Deactivating a DID

```typescript
const { txid } = await wallet.deactivateDID('did:bsv:<txid>')
console.log('Deactivated in TX:', txid)

// Resolving a deactivated DID returns:
// { didDocumentMetadata: { deactivated: true } }
```

## Listing Your DIDs

```typescript
const dids = await wallet.listDIDs()
for (const entry of dids) {
  console.log(entry.did, entry.status) // 'active' or 'deactivated'
}
```

## The DID Utility Class

`DID` is a standalone class — no wallet needed:

```typescript
import { DID } from '@bsv/simple/browser'

// Build a DID Document from a known txid and public key
const doc = DID.buildDocument(txid, subjectPubKeyHex)

// Create a DID string from a txid
const did = DID.fromTxid('d803b04a...')

// Parse and validate
DID.parse('did:bsv:d803b04a...')  // { method: 'bsv', identifier: 'd803b04a...' }
DID.isValid('did:bsv:d803b04a...') // true
```

## Legacy DIDs

The library still supports legacy identity-key-based DIDs (`did:bsv:<66-char-pubkey>`):

```typescript
// Legacy: derive DID from identity key (deprecated)
const doc = wallet.getDID()
await wallet.registerDID()

// Legacy DIDs resolve automatically (no chain following needed)
const result = await wallet.resolveDID('did:bsv:02a1b2c3...')
```

## Server-Side Usage (Without Proxy)

When using `@bsv/simple` on the server (e.g., in a Node.js script), no proxy is needed. The SDK calls resolvers directly:

```typescript
import { ServerWallet } from '@bsv/simple/server'

const wallet = await ServerWallet.create({ privateKey: '...' })

// No didProxyUrl needed — server-side has no CORS restrictions
const result = await wallet.resolveDID('did:bsv:<txid>')
```

The resolution order without a proxy is:
1. Local basket
2. nChain Universal Resolver (direct)
3. WhatsOnChain chain-following (direct)

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| Cross-wallet resolve fails with CORS error | Browser calling WoC directly | Set up the `/api/resolve-did` proxy route |
| nChain returns HTTP 500 | Their infrastructure is down | The proxy automatically falls back to WoC |
| WoC returns HTTP 429 | Browser rate-limited | Use the server-side proxy (no browser rate limits) |
| `resolveDID` returns `notYetAvailable` | Document TX hasn't propagated | Wait a few seconds and retry |
| Own DID resolves but others don't | No `didProxyUrl` configured | Pass `didProxyUrl: '/api/resolve-did'` to `createWallet()` |
