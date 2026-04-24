# createAction → sign → signAction Flow

A reference guide for creating and signing BSV transactions using the BRC-100 wallet pattern.

---

## The 3-Step Pattern

All BSV transactions follow this pattern:

1. **createAction** — Prepare the transaction with estimated unlocking script lengths
2. **sign** — Generate actual unlocking scripts using BSV SDK
3. **signAction** — Finalize the transaction with the actual unlocking scripts

---

## Basic Example

```typescript
import { Transaction } from '@bsv/sdk';

// STEP 1: Create Action (Prepare Transaction)
const unlockTemplate = yourScriptTemplate.unlock(wallet, 'all', false);
const unlockingScriptLength = await unlockTemplate.estimateLength();

const actionRes = await wallet.createAction({
  description: 'Transaction description',
  inputBEEF: inputTx,  // Source transaction BEEF
  inputs: [
    {
      inputDescription: 'Input description',
      outpoint: 'txid.vout',
      unlockingScriptLength,  // Estimate only
    }
  ],
  outputs: [
    {
      outputDescription: 'Output description',
      lockingScript: lockingScript.toHex(),
      satoshis: 1,
    }
  ],
  options: {
    randomizeOutputs: false,  // Keep deterministic ordering
  }
});

// STEP 2: Sign (Generate Unlocking Scripts)
const reference = actionRes.signableTransaction.reference;
const txToSign = Transaction.fromBEEF(actionRes.signableTransaction.tx);
const sourceTransaction = Transaction.fromBEEF(inputBEEF);

// Attach templates and source to inputs
txToSign.inputs[0].unlockingScriptTemplate = unlockTemplate;
txToSign.inputs[0].sourceTransaction = sourceTransaction;

// Generate actual unlocking scripts
await txToSign.sign();

const unlockingScript = txToSign.inputs[0].unlockingScript;
if (!unlockingScript) {
  throw new Error('Missing unlocking script after signing');
}

// STEP 3: Sign Action (Finalize Transaction)
const action = await wallet.signAction({
  reference,  // From Step 1
  spends: {
    '0': { unlockingScript: unlockingScript.toHex() }  // From Step 2
  }
});

if (!action.tx) {
  throw new Error('Failed to sign action');
}

// Broadcast transaction
const tx = Transaction.fromAtomicBEEF(action.tx);
const broadcast = await broadcastTX(tx);
const txid = broadcast.txid;
```

---

## Multiple Inputs Example

```typescript
// STEP 1: Create with multiple inputs
const actionRes = await wallet.createAction({
  description: 'Multi-input transaction',
  inputBEEF: mergedBeef.toBinary(),
  inputs: [
    { outpoint: 'txid1.0', unlockingScriptLength: lengthA },
    { outpoint: 'txid2.0', unlockingScriptLength: lengthB },
    { outpoint: 'txid3.0', unlockingScriptLength: lengthC },
  ],
  outputs: [...],
});

// STEP 2: Sign all inputs
const txToSign = Transaction.fromBEEF(actionRes.signableTransaction.tx);
for (let i = 0; i < txToSign.inputs.length; i++) {
  txToSign.inputs[i].unlockingScriptTemplate = templates[i];
  txToSign.inputs[i].sourceTransaction = sources[i];
}
await txToSign.sign();

// STEP 3: Provide all unlocking scripts
const spends: Record<string, { unlockingScript: string }> = {};
for (let i = 0; i < txToSign.inputs.length; i++) {
  spends[String(i)] = {
    unlockingScript: txToSign.inputs[i].unlockingScript!.toHex()
  };
}

const action = await wallet.signAction({
  reference: actionRes.signableTransaction.reference,
  spends,
});
```

---

## Key Points

### Step 1: createAction
- Uses **estimated** unlocking script lengths
- Returns `signableTransaction` with `reference` and `tx` BEEF
- `reference` links the prepared transaction to Step 3

### Step 2: sign
- Generates **actual** unlocking scripts using BSV SDK
- Must attach `unlockingScriptTemplate` to each input
- Must attach `sourceTransaction` from the input BEEF
- `txToSign.sign()` generates the unlocking scripts

### Step 3: signAction
- Finalizes with actual unlocking scripts from Step 2
- `reference` links back to Step 1
- `spends` provides unlocking scripts keyed by input index (`'0'`, `'1'`, etc.)
- Returns the final signed transaction in Atomic BEEF format

---

## Error Handling

```typescript
try {
  // Step 1
  if (!actionRes.signableTransaction) {
    throw new Error('Failed to create signable transaction');
  }

  // Step 2
  await txToSign.sign();
  const unlockingScript = txToSign.inputs[0].unlockingScript;
  if (!unlockingScript) {
    throw new Error('Missing unlocking script after signing');
  }

  // Step 3
  if (!action.tx) {
    throw new Error('Failed to sign action');
  }

  // Broadcast
  if (!broadcast.txid) {
    throw new Error('Failed to get transaction ID');
  }

} catch (error) {
  console.error('Transaction error:', error);
  throw error;
}
```
