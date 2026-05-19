# CLAUDE.md — @bsv/wallet-helper

## Purpose (1-2 sentences)

Fluent transaction builder and wallet-compatible script templates for BSV. Provides high-level APIs for constructing multi-output transactions (P2PKH, ordinals, custom), managing inputs, and handling BRC-29 key derivation without exposing private keys.

## Public API surface

### TransactionBuilder
- `new TransactionBuilder(wallet: WalletInterface, description?: string)` — Fluent transaction builder
- `.addP2PKHOutput(params: AddP2PKHOutputParams): OutputBuilder` — Add pay-to-pubkey-hash output
- `.addOrdinalP2PKHOutput(params: AddOrdinalP2PKHOutputParams): OutputBuilder` — Add 1Sat ordinal with inscription/MAP metadata
- `.addCustomOutput(params: AddCustomOutputParams): OutputBuilder` — Add raw locking script output
- `.addChangeOutput(params: AddChangeOutputParams): OutputBuilder` — Auto-calculate change with fee deduction
- `.addP2PKHInput(params: AddP2PKHInputParams): InputBuilder` — Spend P2PKH UTXO
- `.addOrdLockInput(params: AddOrdLockInputParams): InputBuilder` — Spend OrdLock (marketplace listing)
- `.addCustomInput(params: AddCustomInputParams): InputBuilder` — Spend custom locking script
- `.options(opts: TransactionOptions): TransactionBuilder` — Set transaction-level flags (randomizeOutputs, trustSelf, etc.)
- `.build(params?: BuildParams): Promise<TransactionResult>` — Execute transaction or preview

### OutputBuilder
- `.basket(name: string): OutputBuilder` — Assign output to basket
- `.customInstructions(data: string): OutputBuilder` — Attach app-specific metadata
- Return type is both OutputBuilder and TransactionBuilder (chaining)

### Script Templates
- `WalletP2PKH` — P2PKH with wallet derivation or direct pubkey
  - `.lock(params: P2PKHLockParams): Promise<LockingScript>`
  - `.unlock(params: P2PKHUnlockParams): UnlockingTemplate`
- `WalletOrdP2PKH` — 1Sat Ordinal with inscription data and MAP metadata
  - `.lock(params: OrdinalLockParams): Promise<LockingScript>`
  - `.unlock(params: OrdinalUnlockParams): UnlockingTemplate`
- `WalletOrdLock` — Marketplace listing (seller cancel / buyer purchase paths)
  - `.lock(params: OrdLockLockParams): Promise<LockingScript>`
  - `.unlock(params: OrdLockUnlockParams): UnlockingTemplate`

### Utilities
- `makeWallet(chain, storageURL, privateKeyHex): Promise<WalletInterface>` — Create BRC-100 wallet from private key
- `calculatePreimage(tx, inputIndex, prevOutScript): Promise<number[]>` — Compute signature preimage
- `addOpReturnData(script: LockingScript, data: string[]): LockingScript` — Append OP_RETURN metadata
- `getDerivation(wallet, protocolID, keyID, counterparty): Promise<DerivationResult>` — Derive BRC-29 key
- `getAddress(publicKey): string` — Convert pubkey to P2PKH address
- `isP2PKH(script): boolean` — Identify P2PKH script
- `isOrdinal(script): boolean` — Check for ordinal inscription
- `hasOrd(script): boolean` — Has ord marker
- `hasOpReturnData(script): boolean` — Contains OP_RETURN
- `getScriptType(script): ScriptType` — Classify script (p2pkh, ordinal, custom, etc.)
- `extractOpReturnData(script): string[]` — Parse OP_RETURN payloads
- `extractMapMetadata(script): MAP` — Extract MAP (Magic Attribute Protocol) metadata
- `extractInscriptionData(script): InscriptionData` — Decode ordinal inscription

## Real usage patterns

```typescript
// 1. Build and send P2PKH transaction with metadata
import { TransactionBuilder } from '@bsv/wallet-helper'

const result = await new TransactionBuilder(wallet, "Payment with metadata")
  .addP2PKHOutput({
    publicKey: recipientKey,
    satoshis: 5000,
    description: "Payment to Bob"
  })
  .addOpReturn(['APP_ID', JSON.stringify({ memo: 'Thanks!' })])
  .build()

console.log(`Sent: ${result.txid}`)

// 2. Multi-output transaction with auto-calculated change
await new TransactionBuilder(wallet, "Multi-output with change")
  .addP2PKHOutput({ publicKey: alice, satoshis: 1000 })
  .addP2PKHOutput({ publicKey: bob, satoshis: 2000 })
  .addChangeOutput({ description: "Change" })
  .build()

// 3. Transaction with BRC-29 automatic derivation (no pubkey)
await new TransactionBuilder(wallet, "Auto-derived")
  .addP2PKHOutput({ satoshis: 1000 })  // Uses automatic derivation
    .basket("my-basket")
    .customInstructions("app-data")
  .build()

// 4. Spend UTXOs from previous transaction
await new TransactionBuilder(wallet, "Spend UTXO")
  .addP2PKHInput({ sourceTransaction, sourceOutputIndex: 0, description: "UTXO" })
  .addP2PKHOutput({ publicKey: recipient, satoshis: 500 })
  .build()

// 5. Create 1Sat ordinal with inscription and metadata
const ordResult = await new TransactionBuilder(wallet, "Mint ordinal")
  .addOrdinalP2PKHOutput({
    walletParams: { protocolID: [2, 'p2pkh'], keyID: '0', counterparty: 'self' },
    satoshis: 1,
    inscription: {
      dataB64: Buffer.from('Hello ordinals').toString('base64'),
      contentType: 'text/plain'
    },
    metadata: { app: 'gallery', type: 'greeting', author: 'Alice' }
  })
  .build()

// 6. Preview transaction before execution
const preview = await new TransactionBuilder(wallet)
  .addP2PKHOutput({ publicKey: someKey, satoshis: 5000 })
  .build({ preview: true })

console.log('Would send:', preview.estimatedFee)
```

## Key concepts

- **Fluent API** — Method chaining for readable transaction construction
- **BRC-29 Derivation** — Automatic hierarchical key derivation (protocolID, keyID, counterparty); omit publicKey to enable
- **Wallet-Compatible** — Never exposes private keys; always uses wallet's `createAction` / `signAction`
- **Change Calculation** — Auto-computes change = inputs - outputs - fees
- **Basket** — Logical grouping of outputs for wallet organization
- **CustomInstructions** — JSON metadata per output; auto-includes derivation info when BRC-29 is used
- **BEEF** — Broadcast-Everything-BEEF transaction format for secure input proofs
- **Lock/Unlock Consistency** — Must use same derivation params for both lock and unlock operations
- **MAP Metadata** — Magic Attribute Protocol for ordinal inscriptions (app, type, custom fields)
- **OrdLock** — Two-spend-path ordinal marketplace listing (seller cancel, buyer purchase)

## Dependencies

**Runtime:**
- `@bsv/sdk` ^2.0.14
- `@bsv/wallet-toolbox-client` ^2.1.18

**Dev:**
- TypeScript, Jest, ts-jest, ts-standard

## Common pitfalls / gotchas

1. **Lock/Unlock key mismatch** — If you lock with `{ walletParams: {...} }` but try to unlock with `{ publicKey: ... }`, it fails. Use matching derivation params.
2. **Omitting satoshis on P2PKH** — If you don't provide satoshis and no changeOutput, transaction will fail during build.
3. **UTXO input without outputs** — If you add inputs, you must add outputs; builder doesn't auto-create outputs.
4. **publicKey vs walletParams** — Choose one per output; don't mix. Wallet derivation (walletParams) is preferred for security.
5. **Derivation parameters stored separately** — Store derivation params alongside locking script if you need to spend later.
6. **MAP metadata encoding** — MAP fields must be key-value strings; nested objects are not standard.
7. **Randomized outputs** — By default, outputs are randomized to improve privacy; set `options({ randomizeOutputs: false })` for specific output ordering (e.g., OrdLock purchase).

## Spec conformance

- **BRC-29** — Hierarchical key derivation
- **BRC-42** — Public key derivation (from wallet)
- **BRC-100** — Wallet interface (createAction, signAction)
- **BRC-95** — PushDrop (tokens, ordinals)
- **MAP** — Magic Attribute Protocol for ordinal metadata
- **1Sat Ordinals** — Inscription format (dataB64, contentType)
- **OrdLock** — Marketplace listing standard

## File map

```
bsv-wallet-helper/
  src/
    index.ts                    # Main exports
    transaction-builder/
      index.ts                  # TransactionBuilder exports
      transaction.ts            # TransactionBuilder, OutputBuilder, InputBuilder classes
      types/
        build-params.ts         # BuildParams type
        output-config.ts        # Output configuration types
        input-config.ts         # Input configuration types
        params.ts               # Parameter type definitions
        type-guards.ts          # Type checking utilities
      __tests__/
        transaction.test.ts     # Transaction builder tests
    script-templates/
      index.ts                  # Script template exports
      p2pkh.ts                  # WalletP2PKH class
      ordinal.ts                # WalletOrdP2PKH class
      ordlock.ts                # WalletOrdLock class
      types/
        index.ts                # Template type exports
        params.ts               # Lock/unlock parameter types
      __tests__/
        p2pkh.test.ts           # P2PKH tests
        ordinal.test.ts         # Ordinal tests
        ordlock.test.ts         # OrdLock tests
    types/
      wallet.ts                 # WalletDerivationParams, Inscription, MAP types
    utils/
      index.ts                  # Utility exports
      derivation.ts             # BRC-29 key derivation
      opreturn.ts               # OP_RETURN parsing/building
      scriptValidation.ts       # Script type detection
      createPreimage.ts         # Signature preimage calculation
      mockWallet.ts             # Test wallet stub
      constants.ts              # Protocol constants
      __tests__/
        derivation.test.ts      # Derivation tests
        opreturn.test.ts        # OP_RETURN tests
        scriptValidation.test.ts # Validation tests
```

## Integration points

- **Depends on:** `@bsv/sdk` (Transaction, LockingScript, PublicKey), `@bsv/wallet-toolbox-client` (BRC-29 protocol ID)
- **Used by:** `@bsv/simple` (high-level wallet operations), applications building complex transaction workflows
- **Complements:** `@bsv/templates` (low-level script templates like P2MSKH), `@bsv/simple/server` (server-side wallet)
