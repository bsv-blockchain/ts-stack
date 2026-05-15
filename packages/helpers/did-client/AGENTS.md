# CLAUDE.md — @bsv/did-client

## Purpose (1-2 sentences)

DID (Decentralized Identifier) client for BSV blockchain. Creates, revokes, and queries `did:bsv:` tokens stored as PushDrop outputs on-chain, with overlay broadcast and lookup service integration.

## Public API surface

### DIDClient
- `constructor(opts?: DIDClientOptions)` — Create client with optional overlay configuration
- `async createDID(serialNumber: string, subject: PubKeyHex, opts?: CreateDIDOpts): Promise<BroadcastResponse | BroadcastFailure>` — Mint new DID token as PushDrop output
- `async revokeDID(opts: { serialNumber?: string, outpoint?: string }): Promise<BroadcastResponse | BroadcastFailure>` — Spend DID token to revoke (by serial or outpoint)
- `async findDID(query: DIDQuery & PaginationOpts, opts?: FindDIDOpts): Promise<DIDRecord[]>` — Query overlay lookup service for DID tokens
- `parseLookupAnswer(ans: LookupAnswer, includeBeef: boolean): DIDRecord[]` — Helper to parse lookup responses

### Configuration (DIDClientOptions)
- `overlayTopic?: string` — Broadcast topic (default: 'tm_did')
- `overlayService?: string` — Lookup service name (default: 'ls_did')
- `wallet?: WalletInterface` — Custom wallet instance; defaults to new WalletClient()
- `networkPreset?: 'mainnet' | 'testnet' | 'local'` — Network for overlay broadcast/query
- `acceptDelayedBroadcast?: boolean` — Allow delayed broadcast if immediate fails

### Types
- `DIDRecord` — { txid: string, outputIndex: number, serialNumber: Base64String, beef?: number[] }
- `DIDQuery` — { serialNumber?: Base64String, outpoint?: string }
- `CreateDIDOpts` — { wallet?: WalletInterface, derivationPrefix?: Base64String, derivationSuffix?: Base64String }
- `FindDIDOpts` — { resolver?: LookupResolver, wallet?: WalletInterface, includeBeef?: boolean }
- `PaginationOpts` — { limit?: number, skip?: number, sortOrder?: 'asc' | 'desc', startDate?: string, endDate?: string }

## Real usage patterns

```typescript
import { DIDClient } from '@bsv/did-client'
import { WalletClient } from '@bsv/sdk'

// 1. Initialize client
const wallet = new WalletClient()
const didClient = new DIDClient({
  wallet,
  networkPreset: 'mainnet',
  overlayTopic: 'tm_did',
  overlayService: 'ls_did'
})

// 2. Create a DID token
const subjectPublicKey = '02abc123...'  // Public key of identity subject
const createResult = await didClient.createDID(
  'sn-12345-abc',  // Serial number (arbitrary string)
  subjectPublicKey,
  {
    derivationPrefix: Utils.toBase64(Random(10)),
    derivationSuffix: Utils.toBase64(Random(10))
  }
)

if (createResult.status === 'success') {
  console.log(`DID created: ${createResult.txid}`)
} else {
  console.error(`Broadcast failed: ${createResult.description}`)
}

// 3. Find DID tokens on overlay
const foundDIDs = await didClient.findDID(
  {
    serialNumber: 'sn-12345-abc',
    limit: 10
  },
  { includeBeef: true }
)

console.log(`Found ${foundDIDs.length} DID records`)
foundDIDs.forEach(did => {
  console.log(`  txid: ${did.txid}, output: ${did.outputIndex}`)
})

// 4. Query by outpoint
const byOutpoint = await didClient.findDID({
  outpoint: 'abc123def456.0'
})

// 5. Revoke DID by serial number
const revokeResult = await didClient.revokeDID({
  serialNumber: 'sn-12345-abc'
})

if (revokeResult.status === 'success') {
  console.log(`DID revoked in tx ${revokeResult.txid}`)
}

// 6. Pagination and filtering
const page1 = await didClient.findDID({
  limit: 50,
  skip: 0,
  sortOrder: 'desc',
  startDate: '2024-01-01',
  endDate: '2024-12-31'
})
```

## Key concepts

- **DID Token** — PushDrop output containing serialNumber, subject, and derivation params
- **Serial Number** — Arbitrary Base64-encoded identifier for the DID
- **Subject** — Public key of the entity the DID represents
- **Derivation Prefix/Suffix** — Random values used in PushDrop key derivation; must be preserved to revoke
- **BEEF** — Complete transaction chain for proof; required for revocation
- **Overlay Broadcast** — Publish DID tokens to SHIP/SLAP overlay network for discoverability
- **Lookup Service** — Query indexed overlay for DIDs by serialNumber or outpoint
- **Revocation** — Spending the DID output burns it (marks as revoked)
- **Wallet Storage** — DIDs stored in wallet basket 'did' with tags for efficient lookup

## Dependencies

**Runtime:**
- `@bsv/sdk` ^2.0.14 (WalletClient, Transaction, Utils, PushDrop, TopicBroadcaster, LookupResolver)
- `@bsv/wallet-toolbox-client` ^2.1.18 (implied via @bsv/sdk)

**Dev:**
- TypeScript, Jest, ts-jest, ts-standard, webpack

## Common pitfalls / gotchas

1. **Derivation params not preserved** — If you don't store derivationPrefix and derivationSuffix, you cannot revoke the DID later
2. **Serial number encoding** — Serial number must be Base64-encoded string; UTF-8 strings won't work
3. **Subject public key format** — Must be valid public key hex; invalid format causes lock script failure
4. **No wallet storage** — DIDs are broadcast to overlay but NOT automatically stored in the wallet; create your own tracking if needed
5. **Revoke requires BEEF** — To revoke, the output's complete transaction chain is fetched; if wallet doesn't have it, revoke fails
6. **Overlay availability** — If overlay is down, broadcast may be delayed or fail; `acceptDelayedBroadcast: true` allows retry
7. **Update functionality disabled** — `updateDID()` is commented out in source; currently read-only after creation

## Spec conformance

- **did:bsv** — DID method specification (draft)
- **BRC-95** — PushDrop token format (key derivation, encryption)
- **BRC-29** — Hierarchical key derivation
- **SHIP/SLAP** — Overlay network for broadcast and lookup
- **BEEF** — Transaction proof format

## File map

```
did-client/
  src/
    index.ts                    # DIDClient class and main exports
    types/
      index.ts                  # DIDRecord, DIDQuery type definitions
  mod.ts                         # Main entrypoint (re-exports)
  webpack.config.js             # Browser bundle configuration
  tsconfig.cjs.json             # CommonJS build config
```

## Integration points

- **Depends on:** `@bsv/sdk` (WalletClient, Transaction, PushDrop, TopicBroadcaster, LookupResolver), overlay services (SHIP/SLAP)
- **Used by:** Identity systems, DID resolver implementations, any app issuing on-chain identifiers
- **Complements:** `@bsv/simple` (high-level wallet operations), credential issuers (can issue VCs for DID subjects)
