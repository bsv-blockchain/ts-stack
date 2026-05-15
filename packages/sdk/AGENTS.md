# CLAUDE.md — @bsv/sdk v2.0.14

## Purpose
The BSV TypeScript SDK is the foundational cryptographic and transaction library for the BSV blockchain. It provides low-level primitives (keys, signatures, hashing), script construction and execution, transaction creation and signing, and integration interfaces for wallets and overlay networks. Every other ts-stack package builds on top of this.

## Public API Surface

### Primitives (from `src/primitives/`)
- **`PrivateKey`** — Elliptic curve private key for ECDSA signatures; methods: `toPublicKey()`, `toAddress()`, `toWif()`, `fromWif()`, `sign()`, `fromRandom()`
- **`PublicKey`** — Public key point; methods: `toHash()` (P2PKH hash), `toAddress()`, `verify(message, signature)`
- **`Hash`** — Hash utilities: `hash256(data)`, `hash160(data)` for SHA-256 and RIPEMD-160
- **`BigNumber`** — Arbitrary precision arithmetic for satoshi amounts
- **`TransactionSignature`** — ECDSA signature with sighash type
- **`Curve`** — secp256k1 elliptic curve operations
- **`Entropy`** — Random number generation for key derivation

### Script (from `src/script/`)
- **`Script`** — Base class for locking/unlocking scripts; methods: `toHex()`, `toArray()`, `fromHex()`, `chunks()`
- **`LockingScript`** — Output lock constraints; immutable once attached to output
- **`UnlockingScript`** — Signature data to satisfy locking script
- **`ScriptChunk`** — Individual operation code and data; methods: `toHex()`, `toBN()`
- **`OP`** — Bitcoin script operation codes (enum-like): `OP.OP_DUP`, `OP.OP_HASH160`, `OP.OP_EQUAL`, etc.

### Script Templates (from `src/script/templates/`)
- **`P2PKH`** — Pay-to-Public-Key-Hash; methods: `lock(pubKeyHash)`, `unlock(privateKey)` for standard payments
- **`P2PK`** — Pay-to-Public-Key (legacy)
- **`P2SH`** — Pay-to-Script-Hash
- **`PushDrop`** — Proof-carrying data envelope for overlay protocols; methods: `createFromFields(...)` to encode multi-field data

### Transaction (from `src/transaction/`)
- **`Transaction`** — Complete transaction builder; constructor signature: `new Transaction(version?, inputs?, outputs?)`; methods:
  - `addInput(sourceTransaction, sourceOutputIndex, unlockingScriptTemplate)`
  - `addOutput(lockingScript, satoshis, outputDescription?)`
  - `sign()` — Requires wallet implementation via `SignableTransaction`
  - `fee()` — Estimate/calculate fees
  - `broadcast()` — Send to network
  - `toHex()`, `fromHex(hex)`, `id` (txid getter)
- **`Input`** — Single input reference with script template
- **`Output`** — Single output with locking script and satoshi amount
- **`MerklePath`** — Merkle inclusion proof for SPV verification
- **`Beef`** — BRC-62 "BEEF" envelope for atomic transaction batches; constants: `BEEF_V1`, methods: `fromHex()`, `toHex()`
- **`BroadcastResponse`** — Standardized response from broadcasters (ARC, WhatsOnChain, etc.)

### Fee Models (from `src/transaction/fee-models/`)
- **`SatoshisPerKilobyte`** — Linear fee rate; constructor: `new SatoshisPerKilobyte(satoshisPerKb)`
- **`LivePolicy`** — Network-aware fee estimation from chain trackers

### Broadcasters (from `src/transaction/broadcasters/`)
- **`ARC`** — Arc Network transaction submission; methods: `broadcast(tx)` → `Promise<BroadcastResponse>`
- **`WhatsOnChainBroadcaster`** — WhatsOnChain API integration
- **`Teranode`** — Teranode broadcaster
- **`Broadcaster`** — Base interface for all broadcasters

### Chain Trackers (from `src/transaction/chaintrackers/`)
- **`DefaultChainTracker`** — In-memory blockchain state tracking
- **`WhatsOnChainChainTracker`** — Remote chain state via WhatsOnChain API
- **`BlockHeadersService`** — Lightweight header service for SPV

### HTTP (from `src/transaction/http/`)
- **`DefaultHttpClient`** — Node.js HTTP client for remote services
- **`BinaryFetchClient`** — Browser fetch-based HTTP client

### Messages (from `src/messages/`)
- **`Message`** — Signed message container
- Message signing/verification for BRC-18 and other standards

### Wallet (from `src/wallet/`)
- **`WalletInterface`** — BRC-100 standardized wallet interface (peer dependency)
- **`CreateActionArgs`**, **`CreateActionResult`** — Transaction creation request/response
- **`SignActionArgs`**, **`SignActionResult`** — Signing request/response
- **`ListOutputsArgs`**, **`ListActionsArgs`** — UTXO and action history queries
- **`ProtoWallet`** — Minimal in-memory wallet for testing and local use
- **`WalletClient()`** — Factory for connecting to standard BRC-100 wallets (desktop/browser)

### Auth (from `src/auth/`)
- **`Certificate`** — X.509-like certificate for peer authentication
- **`IdentityKey`** — Public identity verification
- **`AuthModule`** — Pluggable authentication mechanisms

### Substrates (from `src/wallet/substrates/`)
- **`Substrate`** — Pluggable signature provider interface
- Implementation adapters for hardware wallets, custody services, etc.

### Storage (from `src/storage/`)
- **`Storage`** — KV store interface
- **`LocalStorageAdapter`** — Browser localStorage
- **`InMemoryStorage`** — Ephemeral storage for testing

### KVStore (from `src/kvstore/`)
- **`KVStore`** — Distributed key-value store interface for immutable data

### Remittance (from `src/remittance/`)
- **`Remittance`** — Payment protocol for overlay services

### Identity (from `src/identity/`)
- **`Identity`** — Identity verification and discovery
- **`IdentityResolver`** — Lookup services

### Registry (from `src/registry/`)
- **`Registry`** — Protocol/certificate registration
- Overlay service discovery

### Compat (from `src/compat/`)
- **`fromUtxo(utxo)`** — Adapter to convert legacy UTXO format to SDK Input
- Backward compatibility helpers

### TOTP (from `src/totp/`)
- **`generateTOTP(secret)`** — Time-based one-time password for 2FA
- **`verifyTOTP(token, secret)`** — Validate TOTP token

### Overlay Tools (from `src/overlay-tools/`)
- **`TopicBroadcaster`** — Broadcast messages to topic-based overlay networks
- **`TopicListener`** — Subscribe to overlay topics
- Overlay service integration

## Real Usage Patterns

### 1. Create and sign a basic P2PKH transaction
```typescript
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const privKey = PrivateKey.fromWif('L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB')
const sourceTransaction = Transaction.fromHex('0200000001...')  // Previous tx hex

const tx = new Transaction(1, [
  {
    sourceTransaction,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey)
  }
], [
  {
    lockingScript: new P2PKH().lock(privKey.toAddress()),
    satoshis: 5000,
    change: true
  }
])

await tx.fee()
await tx.sign()
const broadcast = await tx.broadcast()
```

### 2. Work with wallet interface for multi-signature or hardware signing
```typescript
import { WalletClient, Transaction, CreateActionArgs } from '@bsv/sdk'

const wallet = WalletClient()  // Connect to browser/desktop wallet
const tx = new Transaction()
tx.addOutput({ satoshis: 1000, ... })

// Use wallet for signing instead of local key
const actionResult = await wallet.createAction({
  description: 'Payment transaction',
  outputs: tx.outputs.map(o => ({ ...o, outputDescription: 'payment' }))
})

const signResult = await wallet.signAction({
  actionReference: actionResult.signableTransaction.reference
})
```

### 3. Verify SPV with merkle proof
```typescript
import { MerklePath, Transaction } from '@bsv/sdk'

const tx = Transaction.fromHex('...')
const merklePath = MerklePath.fromHex('...')

if (merklePath.verify(tx.id, blockHeight, blockHeaderHash)) {
  console.log('Transaction is SPV-proven')
}
```

### 4. Encode token/data on-chain with PushDrop
```typescript
import { PushDrop, Script } from '@bsv/sdk'

const tokenFields = ['myAssetId', '100', JSON.stringify({ name: 'MyToken' })]
const tokenScript = PushDrop.createFromFields(tokenFields)
const output = { lockingScript: tokenScript, satoshis: 1 }
```

### 5. Handle chain state and fee estimation
```typescript
import { DefaultChainTracker, SatoshisPerKilobyte, Transaction } from '@bsv/sdk'

const tracker = new DefaultChainTracker()
const feeModel = new SatoshisPerKilobyte(1)  // 1 sat/byte

const tx = new Transaction()
// ... add inputs/outputs ...
const estimatedFee = await tx.fee(feeModel, tracker)
```

## Key Concepts

- **Private Key** — 256-bit value from which all wallet operations derive. Never exposed in network traffic.
- **Public Key** — Elliptic curve point derived from private key; used for address generation and signature verification.
- **Script** — Combination of operation codes and data that define spending conditions. Locking scripts constrain outputs; unlocking scripts unlock them.
- **Transaction** — Atomic unit of blockchain state change. Inputs reference previous outputs (UTXOs); outputs create new UTXOs.
- **UTXO** — Unspent Transaction Output; identified by (txid, outputIndex). Spending requires a valid unlocking script.
- **Signature** — ECDSA signature with sighash byte indicating which transaction fields are committed to.
- **Merkle Proof** — Proof of inclusion in a block; enables SPV without downloading full blocks.
- **BEEF** — BRC-62 envelope; atomic bundle of transactions with merkle proofs for offline verification.
- **Wallet Interface (BRC-100)** — Standardized interface for wallet RPC between apps and wallet services. Abstracts away key management.
- **Overlay** — Second-layer protocol using on-chain anchors (PushDrop) to build services without blockchain modifications.

## Dependencies

### Runtime
- **None** (SDK is intentionally standalone for browser and Node.js)
- Uses built-in Node.js crypto in server context, WebCrypto in browser

### Peer Deps (optional)
- `ws` — For WebSocket overlay connections (optional)
- `qrcode` — For QR code generation in wallet pairing (optional)

### Other ts-stack packages
- None (SDK is at the base; other packages depend on this)

## Common Pitfalls / Gotchas

1. **Sighash commit mismatch** — Unlocking script hash commits only to parts of the transaction. If you modify tx after signing, signature becomes invalid. Always sign last.

2. **Fee estimation timing** — `tx.fee()` may vary if mempool conditions change. Estimate early and buffer for volatility, or use live fee trackers.

3. **UTXO reuse across parallel transactions** — If two transactions reference the same UTXO, only one will confirm. Wallet implementations must track pending outputs.

4. **Script evaluation order** — Unlocking script is evaluated first, then locking script. Stack must be left with true atop for success.

5. **Broadcast endpoint differences** — ARC, WhatsOnChain, Teranode have different response formats and rate limits. Implement retry logic and fallback chains.

6. **Key derivation paths** — Different protocols (BRC-42, BRC-43) use different paths. Verify derivation matches wallet's expectations to avoid fund loss.

7. **Browser vs Node.js API** — Some transaction methods (broadcast, network calls) behave differently in browser due to CORS. Test both contexts.

8. **Merkle proof validity** — `MerklePath.verify()` requires exact block height and header hash. Off-by-one errors or header mismatch will fail verification.

9. **Input spending order** — Scripts are evaluated in input order. If an early input fails, later inputs aren't executed. Order matters for deterministic behavior.

10. **Satoshi precision** — Use `BigNumber` for satoshi arithmetic to avoid floating-point errors. Direct number arithmetic can lose precision above 2^53.

## Spec Conformance

- **BRC-18** — Signed messages
- **BRC-29** — Bitcoin Envelope (UTXO-addressed messages)
- **BRC-42, BRC-43** — Key derivation protocols
- **BRC-62** — BEEF (transaction envelope format)
- **BRC-100** — Wallet interface standard (exposed but not implemented)
- **SPV** — Full merkle proof verification support
- **Bitcoin Script** — Full consensus-rule-compliant interpreter

## File Map

- **`src/primitives/`** — Cryptographic primitives (keys, hashes, signatures)
- **`src/script/`** — Script classes and OP code definitions
- **`src/script/templates/`** — Standard script templates (P2PKH, P2SH, PushDrop, etc.)
- **`src/transaction/`** — Transaction building, signing, broadcasting
- **`src/transaction/fee-models/`** — Fee estimation strategies
- **`src/transaction/broadcasters/`** — Network integration (ARC, WhatsOnChain, Teranode)
- **`src/transaction/chaintrackers/`** — Blockchain state tracking
- **`src/transaction/http/`** — HTTP client abstractions
- **`src/messages/`** — Message signing and verification
- **`src/wallet/`** — BRC-100 wallet interface definitions
- **`src/auth/`** — Authentication and certificates
- **`src/storage/`** — Storage adapters
- **`src/kvstore/`** — KV store interface
- **`src/remittance/`** — Payment protocols
- **`src/identity/`** — Identity verification
- **`src/registry/`** — Protocol registry
- **`src/compat/`** — Legacy format adapters
- **`src/totp/`** — Two-factor authentication
- **`src/overlay-tools/`** — Overlay network integration
- **`mod.ts`** — Main entry point exporting all public APIs

## Integration Points

- **@bsv/wallet-toolbox** — Builds persistent wallet storage and signing on top of SDK; uses SDK's `WalletInterface` and transaction APIs
- **@bsv/btms** — Token issuance/transfer via PushDrop script encoding; uses SDK's Transaction and Script APIs
- **@bsv/btms-permission-module** — BTMS wallet integration; uses SDK's wallet interface
- **@bsv/wallet-relay** — Mobile wallet pairing protocol; uses SDK's cryptography and wallet interface
- **Direct app usage** — Any BSV app can import SDK directly for standalone transaction creation without wallet integration
