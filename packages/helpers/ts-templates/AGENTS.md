# CLAUDE.md — @bsv/templates

## Purpose (1-2 sentences)

Low-level BSV script templates library. Provides reusable locking/unlocking script implementations (OpReturn, MultiPushDrop, P2MSKH) for common and advanced Bitcoin SV patterns without abstracting away control.

## Public API surface

### OpReturn
- `new OpReturn()` — Factory; stateless
- `.lock(data: string | string[] | number[], enc?: 'hex' | 'utf8' | 'base64'): LockingScript` — Create non-spendable OP_RETURN script
- `.unlock()` — Throws: OpReturn is read-only
- `OpReturn.decode(script: Script): string[]` — Static method; decode OP_RETURN data to UTF-8 strings

### MultiPushDrop
- `new MultiPushDrop()` — Factory
- `.lock(fields: number[][], protocolID: WalletProtocol, keyID: string, counterparties: string[], reasonabilityLimit?: boolean): Promise<LockingScript>` — Create encrypted data token with multiple trusted owners
- `.unlock(protocolID: WalletProtocol, keyID: string, counterparties: string[], redeemPath?: string): UnlockingTemplate` — Spend MultiPushDrop (sign + estimateLength)

### P2MSKH (Pay-to-Multisig-Key-Hash)
- `new P2MSKH(m: number, n: number, wallet?: WalletInterface)` — Create m-of-n multisig template
- `.lock(params: LockParams): Promise<LockingScript>` — Create multisig locking script
- `.unlock(params: UnlockParams): UnlockingTemplate` — Spend multisig (requires m signatures)

### Types (from @bsv/sdk)
- `LockingScript` — Serializable script object
- `UnlockingScript` — Script that unlocks a locked output
- `UnlockingTemplate` — `{ sign(tx, inputIndex), estimateLength() }`
- `ScriptTemplate` — Interface with `lock()` and `unlock()` methods
- `Transaction`, `Script`, `OP` — Core SDK types

## Real usage patterns

```typescript
import { Transaction, PrivateKey } from '@bsv/sdk'
import { OpReturn, MultiPushDrop, P2MSKH } from '@bsv/templates'

// 1. Create OP_RETURN transaction
const tx = new Transaction()
const opReturn = new OpReturn()
tx.addOutput({
  lockingScript: opReturn.lock(['APP', JSON.stringify({ action: 'vote' })]),
  satoshis: 0
})
await tx.sign()
console.log(tx.id())

// 2. Decode OP_RETURN data
const decodedData = OpReturn.decode(tx.outputs[0].lockingScript)
console.log(decodedData)  // ['APP', '{"action":"vote"}']

// 3. Create MultiPushDrop token with 2 trusted owners
const pushDrop = new MultiPushDrop()
const lockingScript = await pushDrop.lock(
  [[1, 2, 3], [4, 5, 6]],  // Two fields
  [2, 'token'],            // protocol
  'key-1',
  ['owner1-pubkey', 'owner2-pubkey'],  // Both can unlock
  true                     // reasonableness limit
)

const tx2 = new Transaction()
tx2.addOutput({ lockingScript, satoshis: 1 })

// 4. Spend MultiPushDrop
const unlocker = pushDrop.unlock(
  [2, 'token'],
  'key-1',
  ['owner1-pubkey', 'owner2-pubkey']
)
const unlockingScript = await unlocker.sign(tx2, 0)  // Sign input 0

// 5. Create 2-of-3 multisig
const p2mskh = new P2MSKH(2, 3)
const multiSigLock = await p2mskh.lock({
  publicKeys: [pubkey1, pubkey2, pubkey3]
})

const tx3 = new Transaction()
tx3.addOutput({ lockingScript: multiSigLock, satoshis: 10000 })

// Spend 2-of-3 (need signatures from 2 keys)
const multiSigUnlocker = p2mskh.unlock({
  publicKeys: [pubkey1, pubkey2, pubkey3],
  signingKeys: [privkey1, privkey2]  // Supply 2 of 3 private keys
})
const unlockingScript2 = await multiSigUnlocker.sign(tx3, 0)
```

## Key concepts

- **ScriptTemplate Interface** — Implements `lock()` to create locking script and `unlock()` to sign/spend
- **OP_RETURN** — Immutable, non-spendable data storage; standard for metadata
- **PushDrop** — Encrypted data format with multi-trusted-owner support; fields are encrypted
- **Multisig** — M-of-N threshold signing; requires m private keys to unlock
- **Wallet Integration** — Templates accept WalletInterface for wallet-compatible key derivation (BRC-29, BRC-42)
- **Direct Key Mode** — Can also use raw public/private keys without wallet
- **Protocol ID** — Identifier for script family; used in wallet derivation contexts
- **Reasonableness Limit** — Anti-DoS measure for PushDrop templates

## Dependencies

**Runtime:**
- `@bsv/sdk` ^2.0.14 (Transaction, Script, OP, LockingScript, etc.)

**Dev:**
- TypeScript, Jest, ts-jest, ts-standard

## Common pitfalls / gotchas

1. **OP_RETURN is read-only** — Cannot spend OP_RETURN outputs; used for data only
2. **Lock/Unlock consistency** — Lock and unlock must use same protocol ID, key ID, and counterparty parameters
3. **Wallet context required** — Some templates (MultiPushDrop, P2MSKH) require WalletInterface if using wallet derivation; pass explicitly or as constructor arg
4. **Signature generation async** — All `unlock().sign()` calls are async; use await
5. **OP_RETURN encoding** — Data is UTF-8 by default; if you need binary, encode as hex first and specify `enc: 'hex'`
6. **Script serialization** — LockingScript must be converted to hex before adding to transaction (`script.toHex()`)
7. **Multisig key order** — Public keys must be in exact order when constructing; different order = different script hash

## Spec conformance

- **OP_RETURN** — Standard Bitcoin data format
- **BRC-95** — PushDrop token format
- **BRC-29** — Hierarchical key derivation (in wallet context)
- **BRC-42** — Public key derivation (in wallet context)
- **Bitcoin Script** — All scripts are valid Bitcoin SV scripts

## File map

```
ts-templates/
  src/
    OpReturn.ts                 # OP_RETURN template
    MultiPushDrop.ts            # PushDrop multi-owner template
    P2MSKH.ts                   # Pay-to-Multisig-Key-Hash template
  mod.ts                         # Main entrypoint (re-exports)
  tests/ (if present)            # Unit tests for each template
```

## Integration points

- **Depends on:** `@bsv/sdk` (core types and utilities)
- **Used by:** `@bsv/wallet-helper` (higher-level abstraction over these templates), `@bsv/simple` (wallet-level operations)
- **Complements:** Applications building custom script workflows; developers needing low-level script control
