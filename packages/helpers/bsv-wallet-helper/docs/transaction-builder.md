# TransactionBuilder - Complete Documentation

A fluent transaction builder for creating BSV transactions with a clean, chainable API that works seamlessly with BRC-100 wallets.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
- [Examples](#examples)
- [Advanced Usage](#advanced-usage)

## Overview

`TransactionBuilder` provides a builder pattern for constructing BSV transactions without needing to directly handle private keys or low-level transaction details. It handles:

- Output creation (P2PKH, Ordinal P2PKH, custom scripts, explicit change destinations)
- Input management (spending UTXOs)
- Wallet-backed fee calculation and change handling
- OP_RETURN data attached to individual outputs
- Transaction-level options
- Preview mode for inspection

### Why Use TransactionBuilder?

**Before (Manual Transaction Building with 3-Step Workflow):**
```typescript
// Complex, error-prone, hard to read - especially with inputs!
const p2pkh = new WalletP2PKH(wallet);

const walletParams = {
  protocolID: [2, 'p2pkh'],
  keyID: '0',
  counterparty: 'self'
};

// Build the output locking script
const outputLockingScript = await p2pkh.lock({ publicKey: recipientPublicKey });
const scriptWithMetadata = addOpReturnData(outputLockingScript, ['data']);

// Create unlock template for input
const unlockTemplate = p2pkh.unlock(walletParams);
const unlockingScriptLength = await unlockTemplate.estimateLength();

// Step 1: createAction (Prepare Transaction)
const actionRes = await wallet.createAction({
  description: "My transaction",
  inputBEEF: sourceTransaction.toBEEF(),
  inputs: [
    {
      inputDescription: "Input",
      outpoint: `${sourceTransaction.id('hex')}.0`,
      unlockingScriptLength: unlockingScriptLength,
    }
  ],
  outputs: [
    {
      outputDescription: "Output",
      lockingScript: scriptWithMetadata.toHex(),
      satoshis: 1000,
    }
  ],
  options: {
    randomizeOutputs: false,
  }
});

// Step 2: Sign (Generate Unlocking Scripts)
const reference = actionRes.signableTransaction.reference;
const txToSign = Transaction.fromBEEF(actionRes.signableTransaction.tx);

txToSign.inputs[0].unlockingScriptTemplate = unlockTemplate;
txToSign.inputs[0].sourceTransaction = sourceTransaction;

await txToSign.sign();

const unlockingScript = txToSign.inputs[0].unlockingScript;

if (!unlockingScript) {
  throw new Error('Missing unlocking script after signing');
}

// Step 3: signAction (Finalize Transaction)
const action = await wallet.signAction({
  reference: reference,
  spends: {
    '0': { unlockingScript: unlockingScript.toHex() }
  }
});

if (!action.tx) {
  throw new Error('Failed to sign action');
}

const tx = Transaction.fromAtomicBEEF(action.tx);
```

**After (TransactionBuilder):**
```typescript
// Clean, fluent, self-documenting - handles all the complexity!
const result = await new TransactionBuilder(wallet, "My transaction")
  .addP2PKHInput({
    sourceTransaction,
    sourceOutputIndex: 0,
    walletParams: { protocolID: [2, 'p2pkh'], keyID: '0', counterparty: 'self' },
    description: "Input"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 1000, description: "Output" })
    .addOpReturn(['data'])
  .options({ randomizeOutputs: false })
  .build();
```

TransactionBuilder handles all the complexity:
- ✅ Building unlocking script templates
- ✅ Creating temporary transactions for signing
- ✅ Fee calculation and signing
- ✅ Extracting signed scripts
- ✅ BEEF generation and merging (for multiple inputs)
- ✅ Proper createAction parameter formatting

## Quick Start

### Installation

```bash
npm install @bsv/wallet-helper
```

### Basic Transaction

```typescript
import { TransactionBuilder, makeWallet } from '@bsv/wallet-helper';
import { WalletClient } from '@bsv/sdk';

// Create wallet or use WalletClient
const wallet = await makeWallet('test', storageURL, privateKeyHex);
const wallet2 = new WalletClient("auto")
const recipientAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX';

// Build and execute transaction
const result = await new TransactionBuilder(wallet, "Payment to Alice")
  .addP2PKHOutput({ address: recipientAddress, satoshis: 5000, description: "Payment" })
  .build();

console.log(`Transaction ID: ${result.txid}`);
```

## Core Concepts

### Builder Pattern

TransactionBuilder uses the builder pattern with method chaining:

```typescript
new TransactionBuilder(wallet, "Description")
  .addP2PKHOutput(...)        // Returns OutputBuilder
    .addOpReturn([...])        // Returns OutputBuilder (same output)
  .addOrdinalP2PKHOutput(...)  // Returns OutputBuilder
    .outputDescription("...")  // Returns OutputBuilder (same output)
  .options({...})              // Returns TransactionBuilder
  .build();                    // Executes transaction
```

### Return Types

- **TransactionBuilder methods** → Return `TransactionBuilder` (add more outputs, set options)
- **OutputBuilder methods** → Return `OutputBuilder` (configure current output) or `TransactionBuilder` (next output)
- **InputBuilder methods** → Return `InputBuilder` (configure current input) or `TransactionBuilder` (next input)

### Preview Mode

Inspect what will be sent to `wallet.createAction()` without executing:

```typescript
const preview = await builder.build({ preview: true });

console.log(preview);
// {
//   description: "My transaction",
//   outputs: [{ lockingScript: "...", satoshis: 1000, outputDescription: "..." }],
//   options: { randomizeOutputs: false }
// }
```

## API Reference

### Constructor

```typescript
new TransactionBuilder(wallet: WalletInterface, description?: string)
```

**Parameters:**
- `wallet` - BRC-100 compatible wallet interface (required)
- `description` - Optional transaction description (default: "Transaction")

**Throws:** `Error` if wallet is not provided

**Example:**
```typescript
const builder = new TransactionBuilder(wallet);
const builderWithDesc = new TransactionBuilder(wallet, "Payment to Bob");
```

---

### Output Methods

#### `addP2PKHOutput()`

Add a Pay-to-Public-Key-Hash output.

```typescript
addP2PKHOutput(params: AddP2PKHOutputParams): OutputBuilder
```

**Parameters:**
- `params` - Named parameter object with one of:
  - `{ publicKey: string, satoshis: number, description?: string }` - With public key
  - `{ address: string, satoshis: number, description?: string }` - With BSV address
  - `{ walletParams: WalletDerivationParams, satoshis: number, description?: string }` - With wallet derivation
  - `{ satoshis: number, description?: string }` - With automatic BRC-29 derivation for a self-controlled output

**Returns:** `OutputBuilder` for configuring this output

**Example:**
```typescript
// With public key
builder.addP2PKHOutput({ publicKey: publicKeyHex, satoshis: 1000, description: "Payment" });

// With address
builder.addP2PKHOutput({
  address: '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX',
  satoshis: 1000,
  description: "Payment"
});

// With wallet derivation parameters
builder.addP2PKHOutput({
  walletParams: {
    protocolID: [2, 'p2pkh'],
    keyID: '0',
    counterparty: 'self'
  },
  satoshis: 1000,
  description: "Payment"
});

// With automatic BRC-29 derivation for outputs this wallet controls later
builder.addP2PKHOutput({ satoshis: 1000, description: "Wallet-controlled output" });
// Derivation info automatically added to output.customInstructions
```

Use a recipient's payment address or ordinary payment public key for recipient outputs. Omitting `address`, `publicKey`, and `walletParams` derives with counterparty `self`, so it is for outputs the same wallet should unlock later.

---

#### `addChangeOutput()`

Add an explicit change destination. Normal wallet-funded actions can calculate and manage change through `createAction` / `signAction` without this method; use it when you want the builder to specify the change locking script.

```typescript
addChangeOutput(params?: AddChangeOutputParams): OutputBuilder
```

**Parameters:**
- `params` - Named parameter object with one of:
  - `{ publicKey: string, description?: string }` - With public key
  - `{ walletParams: WalletDerivationParams, description?: string }` - With wallet derivation
  - `{ description?: string }` - With automatic BRC-29 derivation for a self-controlled change destination

**Returns:** `OutputBuilder` for configuring this output

**Important:** Explicit change outputs require at least one input to be added first.

**How it works:**
- During transaction building, the explicit change locking script is created but satoshis are left undefined
- When the transaction is signed, fees are calculated and the remaining balance goes to explicit change outputs
- The calculated satoshis are automatically extracted and used in the final transaction

**Important: Spending Change Outputs**
- Change outputs are standard P2PKH outputs under the hood
- To spend them later, use `addP2PKHInput()` with the **same wallet derivation parameters** you used when creating the change output
- Store the derivation parameters with your UTXO to unlock it correctly later

**Example:**
```typescript
import { TransactionBuilder } from '@bsv/wallet-helper';
import { Transaction } from '@bsv/sdk';

// Create an explicit change destination with wallet derivation
const walletParams = {
  protocolID: [2, 'p2pkh'],
  keyID: '0',
  counterparty: 'self'
};

const result = await new TransactionBuilder(wallet, "Payment with explicit change")
  .addP2PKHInput({
    sourceTransaction,
    sourceOutputIndex: 0,
    walletParams,
    description: "Input"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 1000, description: "Payment" })
  .addChangeOutput({ walletParams, description: "Change" }) // Explicit destination; satoshis are calculated
  .build();

// Later: Spend the change output using the SAME parameters
// Note: result.tx is atomic BEEF data, convert to Transaction first
const changeTx = Transaction.fromAtomicBEEF(result.tx);

const spendResult = await new TransactionBuilder(wallet, "Spending change")
  .addP2PKHInput({
    sourceTransaction: changeTx,
    sourceOutputIndex: 1,
    walletParams,
    description: "Spending change"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 500, description: "Next payment" })
  .build();
```

---

#### `addOrdinalP2PKHOutput()`

Add a 1Sat Ordinal output with optional inscription and MAP metadata.

```typescript
addOrdinalP2PKHOutput(params: AddOrdinalP2PKHOutputParams): OutputBuilder
```

**Parameters:**
- `params` - Named parameter object with one of:
  - `{ publicKey: string, satoshis: number, inscription?: Inscription, metadata?: MAP, description?: string }` - With public key
  - `{ walletParams: WalletDerivationParams, satoshis: number, inscription?: Inscription, metadata?: MAP, description?: string }` - With wallet derivation

**Returns:** `OutputBuilder` for configuring this output

**Example:**
```typescript
builder.addOrdinalP2PKHOutput({
  publicKey,
  satoshis: 1,
  inscription: { dataB64: imageBase64, contentType: 'image/png' },
  metadata: { app: 'gallery', type: 'art', artist: 'Alice' },
  description: "NFT Creation"
});

// Reinscription (metadata only, no file)
builder.addOrdinalP2PKHOutput({
  publicKey,
  satoshis: 1,
  metadata: { app: 'gallery', type: 'art', owner: 'Bob' },
  description: "NFT Transfer"
});
```

---

#### `addOrdLockOutput()`

Add an OrdLock output (used for marketplace-style ordinal listings).

```typescript
addOrdLockOutput(params: AddOrdLockOutputParams): OutputBuilder
```

**Parameters:**
- `params` - Named parameter object:
  - `ordAddress: string` - Address that can cancel the listing (typically the seller)
  - `payAddress: string` - Address that must receive the payment on purchase (typically the seller)
  - `price: number` - Satoshis that must be paid to `payAddress` on purchase
  - `assetId: string` - Arbitrary asset identifier for application indexing
  - `metadata?: MAP` - Optional MAP metadata
  - `satoshis: number` - Satoshis locked in the OrdLock output itself (typically `1`)
  - `description?: string`

**Returns:** `OutputBuilder` for configuring this output

**Example:**
```typescript
const result = await new TransactionBuilder(sellerWallet, 'Create listing')
  .addOrdLockOutput({
    ordAddress: sellerAddress,
    payAddress: sellerAddress,
    price: 1000,
    assetId: 'my-asset-1',
    metadata: { app: 'marketplace', type: 'listing' },
    satoshis: 1,
    description: 'OrdLock listing'
  })
  .options({ randomizeOutputs: false })
  .build()
```

---

#### `addCustomOutput()`

Add an output with a custom locking script.

```typescript
addCustomOutput(params: AddCustomOutputParams): OutputBuilder
```

**Parameters:**
- `params` - Named parameter object:
  - `{ lockingScript: LockingScript, satoshis: number, description?: string }`

**Returns:** `OutputBuilder` for configuring this output

**Example:**
```typescript
import { LockingScript } from '@bsv/sdk';

const customScript = LockingScript.fromASM('OP_TRUE');
builder.addCustomOutput({ lockingScript: customScript, satoshis: 1000, description: "Custom script output" });
```

---

### OutputBuilder Methods

These methods configure the current output and are available after calling any `add*Output()` method.

#### `addOpReturn()`

Add OP_RETURN metadata to the current output. This does not create a separate output; it uses `addOpReturnData` on the locking script for the output returned by the previous `add...Output` call.

```typescript
addOpReturn(fields: (string | number[])[]): OutputBuilder
```

**Parameters:**
- `fields` - Array of data fields. Each can be:
  - Plain text string (auto-converted to hex)
  - Hex string (detected and preserved)
  - Byte array (converted to hex)

**Returns:** `OutputBuilder` for configuring the same output, adding another output, or building

**Throws:** `Error` if fields is empty or not an array

**Example:**
```typescript
// Plain text
builder.addP2PKHOutput({ publicKey, satoshis: 1 })
  .addOpReturn(['APP_ID', 'action', 'transfer']);

// JSON data
builder.addP2PKHOutput({ publicKey, satoshis: 1 })
  .addOpReturn(['APP_ID', JSON.stringify({ user: 'Alice', amount: 100 })]);

// Mixed types
builder.addP2PKHOutput({ publicKey, satoshis: 1 })
  .addOpReturn([
    'APP_ID',           // Text
    'deadbeef',         // Hex
    [0x01, 0x02, 0x03]  // Byte array
  ]);
```

---

#### `basket()`

Set the basket for the current output. Baskets are used to organize and track outputs in your wallet.

```typescript
basket(value: string): OutputBuilder
```

**Parameters:**
- `value` - Basket name/identifier (non-empty string)

**Returns:** `OutputBuilder` (same output, can chain more output methods)

**Throws:** `Error` if value is empty or not a string

**Example:**
```typescript
builder.addP2PKHOutput({ publicKey, satoshis: 1000, description: "Payment" })
  .basket("merchant-payments");

// Chain with other methods
builder.addP2PKHOutput({ publicKey, satoshis: 5000 })
  .basket("savings")
  .addOpReturn(['note', 'This is savings']);
```

---

#### `customInstructions()`

Set custom instructions for the current output. This field can contain application-specific data in string format.

**Note:** If using automatic BRC-29 derivation (by omitting `address`, `publicKey`, and `walletParams`), the derivation information will be automatically appended after your custom instructions.

```typescript
customInstructions(value: string): OutputBuilder
```

**Parameters:**
- `value` - Custom instructions string (non-empty)

**Returns:** `OutputBuilder` (same output, can chain more output methods)

**Throws:** `Error` if value is empty or not a string

**Example:**
```typescript
// Set custom application data
builder.addP2PKHOutput({ publicKey, satoshis: 1000 })
  .customInstructions(JSON.stringify({ orderId: 12345, customerId: 'abc' }));

// With BRC-29 auto-derivation for a self-controlled output - derivation info is appended
builder.addP2PKHOutput({ satoshis: 1000 })  // Uses counterparty 'self'
  .customInstructions('app-data')
  .basket("payments");
// Result: customInstructions = 'app-data' + '{"derivationPrefix":"...","derivationSuffix":"..."}'

// Chain with other output methods
builder.addChangeOutput()  // Explicit self-derived change destination
  .customInstructions('{"changeType":"explicit"}')
  .basket("change-outputs");
```

---

#### `outputDescription()`

Set or update the description for the current output.

```typescript
outputDescription(desc: string): OutputBuilder
```

**Parameters:**
- `desc` - Description string

**Returns:** `OutputBuilder` (same output, can chain more output methods)

**Example:**
```typescript
builder.addP2PKHOutput({ publicKey, satoshis: 1000 })
  .outputDescription("Updated description")
  .addOpReturn(['metadata']);
```

---

### Input Methods

#### `addP2PKHInput()`

Add a P2PKH input (for spending a UTXO).

```typescript
addP2PKHInput(params: AddP2PKHInputParams): InputBuilder
```

**Parameters:**
- `params` - Named parameter object:
  - `sourceTransaction: Transaction` - Transaction containing the UTXO (required)
  - `sourceOutputIndex: number` - Output index in source transaction (required)
  - `walletParams?: WalletDerivationParams` - Wallet derivation parameters (defaults to BRC-29 derivation scheme with counterparty 'self')
  - `description?: string` - Optional input description
  - `signOutputs?: 'all' | 'none' | 'single'` - Signature scope: 'all' (default), 'none', 'single'
  - `anyoneCanPay?: boolean` - SIGHASH_ANYONECANPAY flag (default: false)
  - `sourceSatoshis?: number` - Optional satoshi amount
  - `lockingScript?: Script` - Optional locking script

**Returns:** `InputBuilder` for configuring this input

**Example:**
```typescript
builder.addP2PKHInput({
  sourceTransaction,
  sourceOutputIndex: 0,
  walletParams: { protocolID: [2, 'p2pkh'], keyID: '0', counterparty: 'self' },
  description: "Spending UTXO"
});
```

---

#### `addOrdinalP2PKHInput()`

Add an Ordinal P2PKH input (works same as P2PKH for unlocking).

```typescript
addOrdinalP2PKHInput(params: AddP2PKHInputParams): InputBuilder
```

**Parameters:** Same as `addP2PKHInput()` - named parameter object with:
- `sourceTransaction: Transaction` (required)
- `sourceOutputIndex: number` (required)
- `walletParams?: WalletDerivationParams`
- `description?: string`
- `signOutputs?: 'all' | 'none' | 'single'`
- `anyoneCanPay?: boolean`
- `sourceSatoshis?: number`
- `lockingScript?: Script`

**Returns:** `InputBuilder` for configuring this input

---

#### `addCustomInput()`

Add an input with a custom unlocking script builder.

```typescript
addCustomInput(params: AddCustomInputParams): InputBuilder
```

**Parameters:**
- `params` - Named parameter object:
  - `unlockingScriptTemplate: any` - Pre-built unlocking script template (required)
  - `sourceTransaction: Transaction` - Transaction containing the UTXO (required)
  - `sourceOutputIndex: number` - Output index in source transaction (required)
  - `description?: string` - Optional input description
  - `sourceSatoshis?: number` - Optional satoshi amount
  - `lockingScript?: Script` - Optional locking script

**Returns:** `InputBuilder` for configuring this input

---

#### `addOrdLockInput()`

Add an OrdLock input.

OrdLock supports two spend paths:
- **Cancel**: seller cancels their own listing using a wallet signature.
- **Purchase**: buyer purchases the listing; the unlocking script commits to the final transaction outputs.

```typescript
addOrdLockInput(params: AddOrdLockInputParams): InputBuilder
```

**Parameters:**
- `params` - Named parameter object:
  - `sourceTransaction: Transaction` (required)
  - `sourceOutputIndex: number` (required)
  - `kind?: 'cancel' | 'purchase'` (default: `'cancel'`)
  - `walletParams?: WalletDerivationParams` (used for `kind: 'cancel'`)
  - `signOutputs?: 'all' | 'none' | 'single'` (used for `kind: 'cancel'`)
  - `anyoneCanPay?: boolean` (used for `kind: 'cancel'`)
  - `sourceSatoshis?: number` (optional preimage hints)
  - `lockingScript?: Script` (optional preimage hints)
  - `description?: string`

**Returns:** `InputBuilder` for configuring this input

**Important:** For `kind: 'purchase'`, the unlocking script size depends on the final outputs of the transaction (see [OrdLock Mechanics](#ordlock-mechanics)).

---

### InputBuilder Methods

#### `inputDescription()`

Set or update the description for the current input.

```typescript
inputDescription(desc: string): InputBuilder
```

**Parameters:**
- `desc` - Description string

**Returns:** `InputBuilder` (same input, can chain more input methods)

---

### Transaction-Level Methods

#### `transactionDescription()`

Set the transaction-level description.

```typescript
transactionDescription(desc: string): TransactionBuilder
```

**Parameters:**
- `desc` - Description string

**Returns:** `TransactionBuilder`

**Example:**
```typescript
builder.transactionDescription("Payment to multiple recipients");
```

---

#### `options()`

Set transaction options (passed to `wallet.createAction()`).

```typescript
options(opts: CreateActionOptions): TransactionBuilder
```

**Parameters:**
- `opts` - Transaction options object with any of:
  - `randomizeOutputs?: boolean` - Randomize output order
  - `trustSelf?: 'known' | 'all'` - Trust level for non-verified BEEFs
  - `signAndProcess?: boolean` - Sign and process immediately
  - `acceptDelayedBroadcast?: boolean` - Accept delayed broadcast
  - `returnTXIDOnly?: boolean` - Return only TXID
  - `noSend?: boolean` - Don't broadcast
  - `knownTxids?: string[]` - Known transaction IDs
  - `noSendChange?: string[]` - Outpoints not to send change for
  - `sendWith?: string[]` - Transaction IDs to send with

**Returns:** `TransactionBuilder`

**Throws:** `Error` if options are invalid

**Example:**
```typescript
builder.options({
  randomizeOutputs: false,
  trustSelf: 'known',
  signAndProcess: true
});
```

---

#### `build()`

Build and execute the transaction (or preview it).

```typescript
build(params?: BuildParams): Promise<CreateActionResult | any>
```

**Parameters:**
- `params` - Optional build parameters:
  - `preview?: boolean` - If true, return createAction args without executing

**Returns:**
- If `preview: false` or omitted: `Promise<CreateActionResult>` with `{ txid, tx }`
- If `preview: true`: Promise resolving to the createAction arguments object

**Throws:** `Error` if no outputs configured or validation fails

**Example:**
```typescript
// Execute transaction
const result = await builder.build();
console.log(result.txid, result.tx);

// Preview without executing
const preview = await builder.build({ preview: true });
console.log(preview.outputs, preview.options);
```

---

#### `pay()`

Create a minimal P2PKH payment to a public key (hex) or base58 address, then call `build()`.

```typescript
import { getAddress, TransactionBuilder } from '@bsv/wallet-helper'

const addressRes = await getAddress(wallet)
const address = addressRes[0].address
const walletParams = addressRes[0].walletParams
console.log(`   State receive address: ${address}`)
console.log('   State walletParams:', walletParams)

const amount = 1

const payRes = await new TransactionBuilder(serverWallet)
  .pay(stateAddress, amount)

console.log('Pay txid:', payRes.txid)
```

---

## Examples

### Simple Payment

```typescript
const wallet = await makeWallet('test', storageURL, privateKeyHex);

const result = await new TransactionBuilder(wallet, "Payment")
  .addP2PKHOutput({ publicKey: bobPublicKey, satoshis: 5000, description: "To Bob" })
  .build();

console.log(`Sent 5000 satoshis to Bob: ${result.txid}`);
```

---

### Payment with Metadata

```typescript
const metadata = {
  timestamp: Date.now(),
  memo: 'Payment for services',
  invoice: '#12345'
};

const result = await new TransactionBuilder(wallet, "Payment with memo")
  .addP2PKHOutput({ publicKey: vendorPublicKey, satoshis: 10000, description: "Vendor payment" })
    .addOpReturn(['MY_APP', JSON.stringify(metadata)])
  .build();
```

---

### Multiple Outputs

```typescript
const result = await new TransactionBuilder(wallet, "Multi-payment")
  .addP2PKHOutput({ publicKey: alice, satoshis: 1000, description: "To Alice" })
  .addP2PKHOutput({ publicKey: bob, satoshis: 2000, description: "To Bob" })
  .addP2PKHOutput({ publicKey: charlie, satoshis: 3000, description: "To Charlie" })
  .build();
```

---

### Multiple Outputs with Independent Metadata

```typescript
const result = await new TransactionBuilder(wallet, "Multiple payments")
  .addP2PKHOutput({ publicKey: alice, satoshis: 1000, description: "Payment 1" })
    .addOpReturn(['APP_ID', 'payment', 'alice'])
  .addP2PKHOutput({ publicKey: bob, satoshis: 2000, description: "Payment 2" })
    .addOpReturn(['APP_ID', 'payment', 'bob'])
  .addP2PKHOutput({ publicKey: charlie, satoshis: 3000, description: "Payment 3" })
    .addOpReturn(['APP_ID', 'payment', 'charlie'])
  .build();
```

---

### Creating an NFT (Ordinal)

```typescript
const imageData = fs.readFileSync('artwork.png');
const imageBase64 = imageData.toString('base64');

const result = await new TransactionBuilder(wallet, "NFT Mint")
  .addOrdinalP2PKHOutput({
    publicKey: artistPublicKey,
    satoshis: 1,
    inscription: { dataB64: imageBase64, contentType: 'image/png' },
    metadata: {
      app: 'my-gallery',
      type: 'artwork',
      artist: 'Alice',
      title: 'Sunset Over Mountains',
      year: '2025'
    },
    description: "NFT Creation"
  })
  .build();

console.log(`NFT created: ${result.txid}`);
```

---

### Transferring an NFT (Reinscription)

```typescript
// Transfer without re-uploading file data
const result = await new TransactionBuilder(wallet, "NFT Transfer")
  .addOrdinalP2PKHOutput({
    publicKey: newOwnerPublicKey,
    satoshis: 1,
    metadata: {
      app: 'my-gallery',
      type: 'artwork',
      artist: 'Alice',
      title: 'Sunset Over Mountains',
      owner: 'Bob',  // New owner
      transferred: Date.now().toString()
    },
    description: "NFT Ownership Transfer"
  })
  .build();
```

---

### OrdLock (Marketplace Listing)

OrdLock is a script template intended for marketplace-style ordinal listings.

It has two spend paths:

- **Cancel**: the seller cancels their own listing (wallet signature path).
- **Purchase**: the buyer purchases the listing. The unlocking script commits to the final transaction outputs.

#### Output ordering requirements (purchase)

When spending an OrdLock listing with `kind: 'purchase'`, the contract expects the transaction outputs to be ordered as:

- **Output 0**: the ordinal (typically 1 sat) to the buyer
- **Output 1**: the payment to the seller (must equal the listing `price`, to the listing `payAddress`)
- **Output 2+**: optional additional outputs (including change)

For deterministic results, set `randomizeOutputs: false`.

If the wallet adds a change output implicitly, that changes the final outputs set and can change the purchase unlocking script size. If you want the output set to be explicit, include an `.addChangeOutput(...)`.

#### Example: create listing, cancel, purchase

```typescript
import { TransactionBuilder } from '@bsv/wallet-helper'
import { PublicKey, Transaction } from '@bsv/sdk'

// Seller creates a listing
const sellerAddress = PublicKey.fromString(sellerPubKey).toAddress().toString()

const listing = await new TransactionBuilder(sellerWallet, 'Create OrdLock listing')
  .addOrdLockOutput({
    ordAddress: sellerAddress,
    payAddress: sellerAddress,
    price: 1000,
    assetId: 'my-asset-1',
    metadata: { app: 'marketplace', type: 'listing' },
    satoshis: 1,
    description: 'Listing output'
  })
  .options({ randomizeOutputs: false })
  .build()

const listingTx = Transaction.fromAtomicBEEF(listing.tx)

// Seller cancels the listing (spend the OrdLock output)
await new TransactionBuilder(sellerWallet, 'Cancel OrdLock listing')
  .addOrdLockInput({
    sourceTransaction: listingTx,
    sourceOutputIndex: 0,
    kind: 'cancel',
    walletParams: { protocolID: [0, 'ordlock'], keyID: '0', counterparty: 'self' },
    description: 'Spend OrdLock listing (cancel)'
  })
  .addP2PKHOutput({ publicKey: sellerPubKey, satoshis: 1, description: 'Return ordinal to seller' })
  .options({ randomizeOutputs: false })
  .build()

// Buyer purchases the listing
await new TransactionBuilder(buyerWallet, 'Purchase OrdLock listing')
  .addOrdLockInput({
    sourceTransaction: listingTx,
    sourceOutputIndex: 0,
    kind: 'purchase',
    description: 'Spend OrdLock listing (purchase)'
  })
  .addP2PKHOutput({ publicKey: buyerPubKey, satoshis: 1, description: 'Buyer receives ordinal' }) // Output 0
  .addP2PKHOutput({ publicKey: sellerPubKey, satoshis: 1000, description: 'Payment to seller' }) // Output 1
  .options({ randomizeOutputs: false })
  .build()
```

---

### Using Wallet Derivation

```typescript
const params = {
  protocolID: [2, 'p2pkh'] as WalletProtocol,
  keyID: '0',
  counterparty: 'self' as WalletCounterparty
};

// Self-controlled wallet-derived output
const result = await new TransactionBuilder(wallet, "Derived wallet output")
  .addP2PKHOutput({ walletParams: params, satoshis: 1000, description: "Output for this wallet" })
  .build();

// With an explicit change destination
const result2 = await new TransactionBuilder(wallet, "Payment with explicit change")
  .addP2PKHInput({
    sourceTransaction,
    sourceOutputIndex: 0,
    walletParams: params,
    description: "Input"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 1000, description: "Payment" })
  .addChangeOutput({ walletParams: params, description: "Change" }) // Controls where change goes
  .build();
```

---

### Preview Mode

```typescript
// Build the transaction structure without executing
const preview = await new TransactionBuilder(wallet, "Preview test")
  .addP2PKHOutput({ publicKey, satoshis: 5000, description: "Test output" })
    .addOpReturn(['APP_ID', 'test-data'])
  .options({ randomizeOutputs: false })
  .build({ preview: true });

// Inspect what would be sent
console.log('Transaction description:', preview.description);
console.log('Number of outputs:', preview.outputs.length);
console.log('First output satoshis:', preview.outputs[0].satoshis);
console.log('Options:', preview.options);

// Decide whether to execute
if (userConfirms) {
  const result = await builder.build(); // Execute for real
}
```

---

### With Custom Options

```typescript
const result = await new TransactionBuilder(wallet, "Complex transaction")
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 10000, description: "Payment" })
  .options({
    randomizeOutputs: false,  // Preserve output order
    trustSelf: 'known',       // Trust input beef
    signAndProcess: true,     // Sign immediately
    noSend: false            // Broadcast to network
  })
  .build();
```

---

### Spending a UTXO with Explicit Change Destination

```typescript
// Assume we have a UTXO from a previous transaction
const utxoTx = ...; // Previous transaction
const utxoIndex = 0;
const utxoParams = {
  protocolID: [2, 'p2pkh'] as WalletProtocol,
  keyID: '0',
  counterparty: 'self' as WalletCounterparty
};

const result = await new TransactionBuilder(wallet, "Spending UTXO")
  .addP2PKHInput({
    sourceTransaction: utxoTx,
    sourceOutputIndex: utxoIndex,
    walletParams: utxoParams,
    description: "Input from previous tx"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 4500, description: "Payment" })
  .addChangeOutput({ walletParams: utxoParams, description: "Change" }) // Controls where change goes
  .build();
```

---

## Advanced Usage

### Chaining Pattern

TransactionBuilder supports complex chaining patterns:

```typescript
const builder = new TransactionBuilder(wallet, "Complex transaction");

// Add first output with metadata
const afterOutput1 = builder
  .addP2PKHOutput({ publicKey: alice, satoshis: 1000, description: "Payment 1" })
    .addOpReturn(['data1']); // Returns OutputBuilder

// Add second output with description and metadata
const afterOutput2 = afterOutput1
  .addP2PKHOutput({ publicKey: bob, satoshis: 2000 }) // No description yet
    .outputDescription("Payment 2") // Add description
    .addOpReturn(['data2']); // Returns OutputBuilder

// Set options and build
const result = await afterOutput2
  .options({ randomizeOutputs: false })
  .build();
```

### Error Handling

```typescript
try {
  const result = await new TransactionBuilder(wallet, "Transaction")
    .addP2PKHOutput({ publicKey, satoshis: 1000 })
    .build();

  console.log(`Success: ${result.txid}`);
} catch (error) {
  if (error.message.includes('At least one output')) {
    console.error('No outputs configured');
  } else if (error.message.includes('Wallet is required')) {
    console.error('Invalid wallet');
  } else {
    console.error('Transaction failed:', error.message);
  }
}
```

### Preview for Debugging

```typescript
async function buildAndDebugTransaction() {
  const builder = new TransactionBuilder(wallet, "Debug transaction")
    .addP2PKHOutput({ publicKey, satoshis: 1000, description: "Test" })
    .addOpReturn(['debug', 'data']);

  // Preview first
  const preview = await builder.build({ preview: true });
  console.log('Preview:', JSON.stringify(preview, null, 2));

  // Validate
  if (preview.outputs.length !== 1) {
    throw new Error('Expected 1 output');
  }

  // Execute
  return await builder.build();
}
```

### Conditional Building

```typescript
let builder = new TransactionBuilder(wallet, "Conditional transaction")
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: baseAmount, description: "Base payment" });

// Add bonus if applicable
if (includeBonus) {
  template = builder.addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: bonusAmount, description: "Bonus" });
}

// Add metadata if requested
if (includeMetadata) {
  template = template
    .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 1 })
      .addOpReturn(['APP_ID', JSON.stringify(metadata)]);
}

const result = await builder.build();
```

### Type-Safe Wallet Derivation

```typescript
import { WalletDerivationParams, WalletProtocol, WalletCounterparty } from '@bsv/wallet-helper';

const derivationParams: WalletDerivationParams = {
  protocolID: [2, 'p2pkh'] as WalletProtocol,
  keyID: '0',
  counterparty: 'self' as WalletCounterparty
};

// Store these with your UTXO for later spending
interface StoredUTXO {
  txid: string;
  outputIndex: number;
  satoshis: number;
  derivationParams: WalletDerivationParams;
}

const myUTXO: StoredUTXO = {
  txid: result.txid,
  outputIndex: 0,
  satoshis: 1000,
  derivationParams
};

// Later, spend using the stored params
const spendResult = await new TransactionBuilder(wallet, "Spending stored UTXO")
  .addP2PKHInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: myUTXO.outputIndex,
    walletParams: myUTXO.derivationParams
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: myUTXO.satoshis - 100 })
  .build();
```

---

## Best Practices

### 1. Always Store Derivation Parameters (Critical for Wallet-Derived Outputs!)

When using wallet derivation, store the parameters with your UTXO. This is especially important for explicit change outputs and any output created with counterparty `self`:

```typescript
import { TransactionBuilder } from '@bsv/wallet-helper';
import { Transaction } from '@bsv/sdk';

// ✅ Good: Store params for later spending
const params = { protocolID: [2, 'p2pkh'], keyID: '0', counterparty: 'self' };

const result = await new TransactionBuilder(wallet)
  .addP2PKHInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: 0,
    walletParams: params,
    description: "Input"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 1000, description: "Payment" })
  .addChangeOutput({ walletParams: params, description: "Change" })
  .build();

// Store with UTXO for later spending
const changeUTXO = {
  txid: result.txid,
  outputIndex: 1, // Change output index
  derivationParams: params // MUST store these!
};

// Later: Spend the change using SAME params
// Note: result.tx is atomic BEEF data, convert to Transaction first
const changeTx = Transaction.fromAtomicBEEF(result.tx);

await new TransactionBuilder(wallet)
  .addP2PKHInput({
    sourceTransaction: changeTx,
    sourceOutputIndex: changeUTXO.outputIndex,
    walletParams: params,
    description: "Spending change"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 500 })
  .build();

// ❌ Bad: Use different params when spending
const wrongTx = Transaction.fromAtomicBEEF(result.tx);
await builder.addP2PKHInput({
  sourceTransaction: wrongTx,
  sourceOutputIndex: 1,
  walletParams: { protocolID: [2, 'p2pkh'], keyID: '1', counterparty: 'self' } // WRONG!
}); // Won't unlock the change output!
```

### 2. Use Descriptive Names

```typescript
// ✅ Good: Clear descriptions
await new TransactionBuilder(wallet, "Payment to vendor for invoice #12345")
  .addP2PKHOutput({ publicKey: vendorPublicKey, satoshis: 10000, description: "Vendor payment" })
  .build();

// ❌ Bad: Generic descriptions
await new TransactionBuilder(wallet, "Transaction")
  .addP2PKHOutput({ publicKey: vendorPublicKey, satoshis: 10000, description: "Output" })
  .build();
```

### 3. Preview Before Large Transactions

```typescript
// ✅ Good: Preview expensive transactions
const builder = buildComplexTransaction();
const preview = await builder.build({ preview: true });
console.log(`Will create ${preview.outputs.length} outputs`);
const confirmed = await getUserConfirmation(preview);
if (confirmed) {
  await builder.build();
}
```

### 4. Use Per-Output Metadata

```typescript
// ✅ Good: Each output has its own metadata
template
  .addP2PKHOutput({ publicKey: alice, satoshis: 1000 }).addOpReturn(['payment', 'alice'])
  .addP2PKHOutput({ publicKey: bob, satoshis: 2000 }).addOpReturn(['payment', 'bob']);
```

### 5. Handle Errors Gracefully

```typescript
try {
  const result = await builder.build();
  await logSuccess(result.txid);
} catch (error) {
  await logError(error);
  await notifyUser('Transaction failed');
  throw error; // Re-throw if needed
}
```

---

## Common Patterns

### Payment with Wallet-Managed Change

```typescript
const myParams = {
  protocolID: [2, 'p2pkh'] as WalletProtocol,
  keyID: '0',
  counterparty: 'self' as WalletCounterparty
};

// No need to manually calculate change and fees.
// createAction/signAction can manage normal wallet change.
await new TransactionBuilder(wallet, "Payment with wallet-managed change")
  .addP2PKHInput({
    sourceTransaction,
    sourceOutputIndex: 0,
    walletParams: myParams,
    description: "UTXO"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 7000, description: "Payment" })
  .build();
```

### Explicit Change Output with Metadata

```typescript
// Use addChangeOutput when you need to control the change script.
// Explicit change outputs support OP_RETURN just like regular outputs.
await new TransactionBuilder(wallet, "Payment with tracked change")
  .addP2PKHInput({
    sourceTransaction,
    sourceOutputIndex: 0,
    walletParams: myParams,
    description: "Input"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 5000, description: "Payment" })
  .addChangeOutput({ walletParams: myParams, description: "Change" })
    .addOpReturn(['APP_ID', JSON.stringify({ changeType: 'explicit', timestamp: Date.now() })])
  .build();
```

---

### Multiple Explicit Change Outputs

```typescript
// You can add multiple explicit change outputs to split change across wallet-derived scripts.
const changeParams1 = { protocolID: [2, 'p2pkh'], keyID: '1', counterparty: 'self' };
const changeParams2 = { protocolID: [2, 'p2pkh'], keyID: '2', counterparty: 'self' };

await new TransactionBuilder(wallet, "Split change")
  .addP2PKHInput({
    sourceTransaction,
    sourceOutputIndex: 0,
    walletParams: myParams,
    description: "Input"
  })
  .addP2PKHOutput({ publicKey: recipientPublicKey, satoshis: 3000, description: "Payment" })
  .addChangeOutput({ walletParams: changeParams1, description: "Change 1" })
  .addChangeOutput({ walletParams: changeParams2, description: "Change 2" })
  .build();
```

---

### Multi-Recipient Payment

```typescript
const recipients = [
  { publicKey: alice, amount: 1000, name: "Alice" },
  { publicKey: bob, amount: 2000, name: "Bob" },
  { publicKey: charlie, amount: 3000, name: "Charlie" }
];

let builder = new TransactionBuilder(wallet, "Multi-recipient payment");

for (const recipient of recipients) {
  template = builder.addP2PKHOutput({
    publicKey: recipient.publicKey,
    satoshis: recipient.amount,
    description: `Payment to ${recipient.name}`
  });
}

const result = await builder.build();
```

### Data Storage Pattern

```typescript
await new TransactionBuilder(wallet, "Document hash")
  .addP2PKHOutput({ publicKey: myPublicKey, satoshis: 1, description: "Document proof" })
    .addOpReturn([
      'DOC_HASH',
      documentHash,
      JSON.stringify({
        filename: 'contract.pdf',
        timestamp: Date.now(),
        author: 'Alice'
      })
    ])
  .build();
```

---

## Troubleshooting

### "At least one output is required"

You must add at least one output before calling `build()`:

```typescript
// ❌ Error
await new TransactionBuilder(wallet).build();

// ✅ Fixed
await new TransactionBuilder(wallet)
  .addP2PKHOutput({ publicKey, satoshis: 1000 })
  .build();
```

### "Wallet is required"

Constructor requires a valid wallet:

```typescript
// ❌ Error
new TransactionBuilder(null);

// ✅ Fixed
const wallet = await makeWallet('test', storageURL, privateKeyHex);
new TransactionBuilder(wallet);
```

### "Change outputs require at least one input"

Change outputs need inputs to calculate remaining balance:

```typescript
// ❌ Error: No inputs
await new TransactionBuilder(wallet)
  .addP2PKHOutput({ publicKey, satoshis: 1000 })
  .addChangeOutput({ walletParams: myParams }) // ERROR: no inputs!
  .build();

// ✅ Fixed: Add at least one input first
await new TransactionBuilder(wallet)
  .addP2PKHInput({
    sourceTransaction,
    sourceOutputIndex: 0,
    walletParams: myParams,
    description: "Input"
  })
  .addP2PKHOutput({ publicKey, satoshis: 1000 })
  .addChangeOutput({ walletParams: myParams, description: "Change" }) // Now works!
  .build();
```

### "Script already contains OP_RETURN"

You can only add OP_RETURN once per output:

```typescript
// ❌ Error
builder.addP2PKHOutput({ publicKey, satoshis: 1 })
  .addOpReturn(['data1'])
  .addOpReturn(['data2']); // Can't add second OP_RETURN to same output

// ✅ Fixed: Put all data in one call
builder.addP2PKHOutput({ publicKey, satoshis: 1 })
  .addOpReturn(['data1', 'data2']);

// ✅ Or: Use separate outputs
template
  .addP2PKHOutput({ publicKey, satoshis: 1 }).addOpReturn(['data1'])
  .addP2PKHOutput({ publicKey, satoshis: 1 }).addOpReturn(['data2']);
```

---

## See Also

- [Main README](../README.md) - Overview and installation
- [P2PKH Tests](../src/script-templates/__tests__/p2pkh.test.ts) - Working examples
- [Transaction Tests](../src/transaction-builder/__tests__/transaction.test.ts) - Complete test suite
