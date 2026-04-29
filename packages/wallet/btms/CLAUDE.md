# CLAUDE.md — @bsv/btms v1.0.1

## Purpose
BTMS (Basic Token Management System) is a modular library for issuing, sending, receiving, and burning UTXO-based tokens on the BSV blockchain. It provides high-level APIs for token operations (issue, send, accept, burn) while handling low-level details like PushDrop encoding, UTXO selection, transaction construction, and overlay service integration. Tokens are first-class on-chain objects identified by canonical asset IDs derived from transaction output references.

## Public API Surface

### Main Class
- **`BTMS`** — Core token management class; constructor: `new BTMS(config?: BTMSConfig)`; methods:
  - `issue(amount: number, metadata?: BTMSAssetMetadata)` → `Promise<IssueResult>` — Create new token with amount and optional name/description/iconURL
  - `send(assetId: string, recipientKey: string, amount: number)` → `Promise<SendResult>` — Transfer tokens to recipient's identity key
  - `accept(payment: IncomingToken)` → `Promise<AcceptResult>` — Accept incoming token payment
  - `burn(assetId: string, amount?: number)` → `Promise<BurnResult>` — Permanently destroy tokens
  - `getBalance(assetId: string)` → `Promise<number>` — Query token balance
  - `listAssets()` → `Promise<BTMSAsset[]>` — List all owned assets with balances
  - `listIncoming()` → `Promise<IncomingToken[]>` — List pending token receipts
  - `getSpendableTokens(assetId: string)` → `Promise<BTMSTokenOutput[]>` — Get UTXO list for asset
  - `proveOwnership(assetId: string, amount: number, verifierKey: string)` → `Promise<OwnershipProof>` — Create cryptographic proof of token ownership
  - `verifyOwnership(proof: OwnershipProof)` → `Promise<VerifyOwnershipResult>` — Validate ownership proof

### Token Encoding/Decoding
- **`BTMSToken`** — Static utility class for token serialization; methods:
  - `decode(lockingScriptHex: string)` → `BTMSTokenDecodeResult` — Extract token fields from locking script
  - `isIssuance(decoded: DecodedBTMSToken)` → `boolean` — Check if token is an issuance (field 0 === "ISSUE")
  - `isValidAssetId(id: string)` → `boolean` — Validate asset ID format (txid.vout)
  - `computeAssetId(txid: string, vout: number)` → `string` — Derive canonical asset ID

### Configuration & Types
- **`BTMSConfig`** — Options object with:
  - `wallet?: WalletInterface` — BRC-100 wallet for transactions (defaults to WalletClient())
  - `networkPreset?: 'local' | 'mainnet' | 'testnet'` — Overlay network endpoint selection
  - `comms?: CommsLayer` — Optional communications layer (e.g., MessageBoxClient for delivery)

### Type Definitions
- **`BTMSAsset`** — Asset representation: `{ assetId, name?, balance, metadata?, hasPendingIncoming? }`
- **`BTMSAssetMetadata`** — Asset metadata: `{ name?, description?, iconURL?, [key: string]: unknown }`
- **`IssueResult`** — Issuance outcome: `{ success, txid, assetId, vout, amount, error? }`
- **`SendResult`** — Send outcome: `{ success, txid, tokenForRecipient, changeAmount?, error? }`
- **`AcceptResult`** — Acceptance outcome: `{ success, amount, assetId, error? }`
- **`BurnResult`** — Burn outcome: `{ success, txid, assetId, amountBurned, error? }`
- **`IncomingToken`** — Pending receipt: `{ assetId, amount, from, txid, vout, metadata? }`
- **`BTMSTokenOutput`** — Spendable token UTXO: `{ txid, vout, amount, satoshis, script }`
- **`OwnershipProof`** — Proof of token ownership with signature and amount
- **`ProveOwnershipResult`**, **`VerifyOwnershipResult`** — Proof outcomes

### Constants
- **`BTMS_TOPIC`** — Topic ID for overlay broadcast
- **`BTMS_LOOKUP_SERVICE`** — Overlay lookup service endpoint
- **`BTMS_PROTOCOL_ID`** — Protocol namespace for discovery
- **`BTMS_LABEL_PREFIX`** — Prefix for wallet action labels
- **`BTMS_BASKET`** — Default basket for token outputs
- **`DEFAULT_TOKEN_SATOSHIS`** — Default satoshi value per token UTXO
- **`ISSUE_MARKER`** — Field 0 value for new issuances: `"ISSUE"`

### Utilities
- **`parseCustomInstructions(message: string)`** → `ParsedCustomInstructions` — Parse app-specific instructions from envelope

## Real Usage Patterns

### 1. Issue a new token
```typescript
import { BTMS } from '@bsv/btms'

const btms = new BTMS({ networkPreset: 'mainnet' })

const result = await btms.issue(1000000, {
  name: 'GOLD',
  description: 'Represents 1 gram of gold',
  iconURL: 'https://example.com/gold.png'
})

console.log('Asset ID:', result.assetId)  // 'abc123...def.0'
console.log('Tx:', result.txid)
```

### 2. Send tokens to recipient
```typescript
const recipientIdentityKey = '03abc123...'  // Recipient's public key
const sendResult = await btms.send(
  'abc123...def.0',  // Asset ID from issuance
  recipientIdentityKey,
  100  // Amount
)

console.log('Txid:', sendResult.txid)
console.log('Change:', sendResult.changeAmount)
```

### 3. Accept incoming token payment
```typescript
const incoming = await btms.listIncoming()
for (const payment of incoming) {
  console.log(`Incoming: ${payment.amount} of ${payment.assetId}`)
  const result = await btms.accept(payment)
  console.log(`Accepted ${result.amount} tokens`)
}
```

### 4. Check balance and list assets
```typescript
const balance = await btms.getBalance('abc123...def.0')
console.log('Balance:', balance)

const assets = await btms.listAssets()
for (const asset of assets) {
  console.log(`${asset.name}: ${asset.balance} (${asset.assetId})`)
  if (asset.hasPendingIncoming) {
    console.log(`  (Has pending incoming transfers)`)
  }
}
```

### 5. Burn tokens
```typescript
// Burn specific amount
const result = await btms.burn('abc123...def.0', 100)
console.log('Burned:', result.amountBurned)

// Burn entire balance
const resultAll = await btms.burn('abc123...def.0')
```

### 6. Prove token ownership (for collateral, escrow, etc.)
```typescript
const verifierKey = '03def456...'  // Party to prove to
const proof = await btms.proveOwnership(
  'abc123...def.0',
  500,  // Amount to prove
  verifierKey
)

// Send proof to verifier...
// Verifier validates:
const verified = await btms.verifyOwnership(proof)
if (verified.valid) {
  console.log(`Verified ${verified.amount} tokens from ${verified.prover}`)
}
```

### 7. Decode token from raw locking script
```typescript
import { BTMSToken } from '@bsv/btms'

const scriptHex = '76a9...'  // Token output locking script
const decoded = BTMSToken.decode(scriptHex)

if (decoded.valid) {
  console.log('Asset:', decoded.assetId)
  console.log('Amount:', decoded.amount)
  console.log('Metadata:', decoded.metadata)
  
  if (BTMSToken.isIssuance(decoded)) {
    console.log('This is a new issuance')
  }
}
```

## Key Concepts

- **Asset ID** — Canonical token identifier: `{txid}.{vout}` where output 0 of the issuance tx is the first token mint. All transfers reference this ID.
- **UTXO-based tokens** — Each token lives as a separate output on-chain. Spending a token UTXO is like spending Bitcoin — requires unlocking script from previous owner.
- **PushDrop Schema** — 3-field encoding in locking script:
  - Field 0: `"ISSUE"` (new token) or asset ID (transfer)
  - Field 1: Amount as UTF-8 string
  - Field 2: Metadata as JSON string (optional)
- **Issuance** — When field 0 is `"ISSUE"`, the output is a new token mint. Asset ID becomes the txid and vout after confirmation.
- **Transfer** — When field 0 contains an asset ID, tokens are being moved. TopicManager enforces conservation: output amounts ≤ input amounts.
- **Metadata** — JSON object with asset properties (name, description, icon URL, custom fields). Carried through transfer and burn operations.
- **Incoming Token** — Pending receipt of tokens from another user. Must be explicitly accepted to be added to wallet's balance.
- **Ownership Proof** — Cryptographic proof using key linkage that proves prover owns a given amount of tokens without revealing private key. Used for collateral, escrow, access control.

## Dependencies

### Runtime
- **`@bsv/sdk`** (peer dependency) ^2.0.14 — Transaction building, scripting, wallet interface

### Dev (from package.json)
- **`jest`** ^30.3.0 — Test framework
- **`ts-jest`** ^29.4.9 — TypeScript support for Jest
- **`typescript`** ^5.2.2 — Compiler
- **`ts-standard`** ^12.0.2 — Linter
- **`ts2md`** ^0.2.0 — Documentation generator

### Other ts-stack packages
- **`@bsv/sdk`** — Core dependency (peer dep)
- **`@bsv/wallet-toolbox`** — Used in apps that integrate token signing (not a runtime dep of btms itself)

## Common Pitfalls / Gotchas

1. **Asset ID format** — Asset IDs must be in format `{txid}.{vout}` (lowercase hex txid, dot, vout number). Typos will cause asset not found.

2. **Issuance not confirmed** — Immediately after `issue()`, the asset ID returned uses the pending txid. The canonical asset ID is only guaranteed after the tx is mined. Store results carefully.

3. **Amount precision** — Token amounts are always positive integers (no decimals). Metadata can store divisibility info (e.g., "8 decimal places means divide by 10^8 for display"), but on-chain amounts are always whole numbers.

4. **Incoming not auto-accepted** — Received tokens stay in `listIncoming()` until explicitly `accept()`ed. Apps must prompt users or auto-accept based on policy.

5. **Metadata changes not tracked** — If you transfer tokens with different metadata than the original issuance, the TopicManager may reject the transaction. Always preserve original metadata through transfers.

6. **Burn is permanent** — Once burned, tokens cannot be recovered. No undo mechanism. Apps should confirm with users before burning.

7. **Recipient key format** — `send()` requires the recipient's identity public key (33-byte compressed format: `03...` or `02...`). If using a different key format, conversion will fail silently.

8. **No fractional transfers** — You cannot split a token UTXO into smaller amounts. Each UTXO is atomic. To send 50 of 100 tokens, you must create a new UTXO with 50 and return 50 as change.

9. **Wallet interface required** — BTMS needs a `WalletInterface` (BRC-100) to create transactions. If no wallet is provided, it defaults to `WalletClient()` which only works in browser/desktop with installed wallet.

10. **Overlay service latency** — Topic manager confirmation may take seconds to minutes. Apps shouldn't assume tokens are immediately transferable after send succeeds; they may fail spend until overlay confirms.

11. **Address reuse** — All token operations use derivation paths from the wallet. Address reuse is handled by wallet's key derivation; no action needed from app.

## Spec Conformance

- **PushDrop** — 3-field token encoding per spec
- **BTMSTopicManager** — Validates token transactions on overlay
- **BTMSLookupService** — Indexes tokens for discovery
- **BRC-100** — Uses standard wallet interface for signing
- **BRC-98/99** — Permission hooks for wallet integration (via btms-permission-module)

## File Map

- **`src/index.ts`** — Public API exports and module factory
- **`src/BTMS.ts`** — Main class with token operations
- **`src/BTMSToken.ts`** — Static encoding/decoding utilities
- **`src/BTMSAdvanced.ts`** — Advanced features (marketplace listings, etc.)
- **`src/types.ts`** — TypeScript interfaces and type definitions
- **`src/constants.ts`** — Protocol constants (topic, markers, defaults)
- **`src/utils.ts`** — Utility functions (custom instruction parsing)
- **`src/__tests__/`** — Test files (BTMS.test.ts, BTMSToken.test.ts)

## Integration Points

- **@bsv/sdk** — Uses Transaction, Script, PushDrop, WalletInterface for all operations
- **@bsv/wallet-toolbox** — Apps using wallet-toolbox for signing can use BTMS directly (wallet is injected)
- **@bsv/btms-permission-module** — Adds BTMS token spend gating via BRC-98/99 hooks in wallet-toolbox
- **Overlay services** — TopicManager validates token invariants; LookupService indexes assets
- **MessageBoxClient** — Optional comms layer for encrypted token delivery between users
