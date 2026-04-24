# Utilities

Helper functions and utilities for working with BSV transactions and scripts.

## Wallet Creation

### `makeWallet(chain, storageURL, privateKey)`

Creates a BRC-100 compatible wallet for testing or backend use.

```typescript
import { makeWallet } from '@bsv/wallet-helper';

const wallet = await makeWallet(
  'test',                    // Chain: 'test' or 'main'
  'https://storage-url.com', // Storage provider URL
  privateKeyHex              // Private key as hex string
);
```

**Parameters:**
- `chain`: `'test' | 'main'` - Blockchain network
- `storageURL`: `string` - Storage provider URL
- `privateKey`: `string` - Private key as hex string

**Throws:** `Error` if parameters are invalid or wallet creation fails

## Transaction Signing

### `calculatePreimage(tx, inputIndex, signOutputs, anyoneCanPay, sourceSatoshis?, lockingScript?)`

Calculates the transaction preimage for signing.

```typescript
import { calculatePreimage } from '@bsv/wallet-helper';

const { preimage, signatureScope } = calculatePreimage(
  transaction,
  0,          // Input index
  'all',      // Sign outputs: 'all' | 'none' | 'single'
  false,      // anyoneCanPay flag
  1000,       // Optional: source satoshis
  script      // Optional: locking script
);
```

**Parameters:**
- `tx`: `Transaction` - Transaction to sign
- `inputIndex`: `number` - Index of input being signed
- `signOutputs`: `'all' | 'none' | 'single'` - Signature scope
- `anyoneCanPay`: `boolean` - SIGHASH_ANYONECANPAY flag
- `sourceSatoshis?`: `number` - Optional satoshi amount (or use input.sourceTransaction)
- `lockingScript?`: `Script` - Optional locking script (or use input.sourceTransaction)

**Returns:** `{ preimage: number[], signatureScope: number }`

**Throws:** `Error` if parameters are invalid or required data is missing

## Script Utilities

### `addOpReturnData(script, fields)`

Appends OP_RETURN data fields to any locking script for adding metadata.

```typescript
import { addOpReturnData } from '@bsv/wallet-helper';

// Add plain text metadata
const scriptWithMetadata = addOpReturnData(lockingScript, [
  'MY_APP',
  'action',
  'transfer'
]);

// Add JSON data
const metadata = { user: 'Alice', amount: 100 };
const scriptWithJson = addOpReturnData(lockingScript, [
  'MY_APP',
  JSON.stringify(metadata)
]);

// Add hex hash
const documentHash = 'a'.repeat(64); // 32-byte SHA256 hash
const scriptWithHash = addOpReturnData(lockingScript, [documentHash]);

// Mix types: text, hex, and byte arrays
const scriptMixed = addOpReturnData(lockingScript, [
  'APP_ID',           // Plain text (auto-converted to hex)
  'deadbeef',         // Hex string (detected and preserved)
  [0x01, 0x02, 0x03]  // Byte array (converted to hex)
]);
```

**Parameters:**
- `script`: `LockingScript` - The base locking script to append OP_RETURN data to
- `fields`: `(string | number[])[]` - Array of data fields. Each field can be:
  - Plain text string (auto-converted to hex)
  - Hex string (detected by even length and valid hex chars, normalized to lowercase)
  - Byte array (converted to hex)

**Returns:** `LockingScript` - New locking script with OP_RETURN data appended

**Throws:** `Error` if no fields are provided

**Note:** This works with any script type (P2PKH, ordinals, etc.) and provides a generic way to add metadata without protocol-specific overhead.

## Script Validation and Analysis Helpers

Helper functions to validate, identify, and extract data from different Bitcoin script types.

### Validation Functions

#### `isP2PKH(script | hex): boolean`

Checks if a script is a standard Pay-to-Public-Key-Hash (P2PKH) script.

```typescript
import { isP2PKH } from '@bsv/wallet-helper';

if (isP2PKH(lockingScript)) {
  console.log('This is a P2PKH script');
}
```

#### `isOrdinal(script | hex): boolean`

Checks if a script contains both a BSV-20 Ordinal inscription envelope AND a P2PKH script.

```typescript
import { isOrdinal } from '@bsv/wallet-helper';

if (isOrdinal(lockingScript)) {
  console.log('This is a BSV-20 Ordinal with P2PKH');
}
```

#### `hasOrd(script | hex): boolean`

Checks if a script contains a BSV-20 Ordinal inscription envelope.

```typescript
import { hasOrd } from '@bsv/wallet-helper';

if (hasOrd(lockingScript)) {
  console.log('This script contains a BSV-20 ordinal inscription');
}
```

#### `hasOpReturnData(script | hex): boolean`

Checks if a script contains OP_RETURN data.

```typescript
import { hasOpReturnData } from '@bsv/wallet-helper';

if (hasOpReturnData(lockingScript)) {
  console.log('This script has OP_RETURN data');
}
```

### Type Detection

#### `getScriptType(script | hex): ScriptType`

Determines the type of a Bitcoin script.

Returns one of: `'P2PKH'` | `'Ordinal'` | `'OpReturn'` | `'Custom'`

```typescript
import { getScriptType, type ScriptType } from '@bsv/wallet-helper';

const type = getScriptType(lockingScript);

switch (type) {
  case 'P2PKH':
    console.log('Standard P2PKH script');
    break;
  case 'Ordinal':
    console.log('BSV-20 Ordinal inscription');
    break;
  case 'OpReturn':
    console.log('OP_RETURN only script');
    break;
  case 'Custom':
    console.log('Custom/non-standard script');
    break;
}
```

### Data Extraction Functions

#### `extractOpReturnData(script | hex): string[] | null`

Extracts OP_RETURN data fields from a script.

Returns an array of base64-encoded strings, or `null` if no OP_RETURN found. Base64 encoding supports arbitrary binary data including images, videos, and other file types.

```typescript
import { extractOpReturnData } from '@bsv/wallet-helper';

const data = extractOpReturnData(script);
if (data) {
  // Decode text data
  const text = Buffer.from(data[0], 'base64').toString('utf8');
  console.log('First field (UTF-8):', text);

  // Decode binary data (e.g., image)
  const imageData = Buffer.from(data[1], 'base64');
  fs.writeFileSync('image.png', imageData);
}
```

#### `extractMapMetadata(script | hex): MAP | null`

Extracts MAP (Magic Attribute Protocol) metadata from a script.

Returns a `MAP` object with `app` and `type` fields (plus any additional fields), or `null` if no MAP data found.

```typescript
import { extractMapMetadata, type MAP } from '@bsv/wallet-helper';

const metadata = extractMapMetadata(ordinalScript);
if (metadata) {
  console.log(`App: ${metadata.app}`);
  console.log(`Type: ${metadata.type}`);
  console.log(`Author: ${metadata.author}`); // Custom field
}
```

**MAP Type:**
```typescript
type MAP = {
  app: string;    // Required
  type: string;   // Required
  [key: string]: string;  // Additional custom fields
};
```

#### `extractInscriptionData(script | hex): InscriptionData | null`

Extracts inscription data from a BSV-20 Ordinal script.

Returns an object with `dataB64` (base64-encoded data) and `contentType` (MIME type), or `null` if not found.

```typescript
import { extractInscriptionData, type InscriptionData } from '@bsv/wallet-helper';

const inscription = extractInscriptionData(ordinalScript);
if (inscription) {
  console.log(`Content type: ${inscription.contentType}`);

  // Decode the data
  const data = Buffer.from(inscription.dataB64, 'base64');

  if (inscription.contentType === 'text/plain') {
    console.log('Text:', data.toString('utf8'));
  } else if (inscription.contentType.startsWith('image/')) {
    // Save image data
    fs.writeFileSync('image.png', data);
  }
}
```

**InscriptionData Type:**
```typescript
type InscriptionData = {
  dataB64: string;      // Base64 encoded inscription data
  contentType: string;  // MIME type (e.g., 'text/plain', 'image/png')
};
```

### Validation and Error Handling

**Features:**
- All functions accept both `LockingScript`/`Script` objects and hex strings
- Validation functions return `false` for scripts that don't match the expected pattern
- Extraction functions return `null` when data is not found
- **All functions throw errors** for invalid input types

**Throws:** `Error` if input is:
- `null` or `undefined`
- An array (`number[]`, `string[]`, etc.)
- A primitive type (`number`, `boolean`, etc.)
- A plain object without `toHex()` and `toASM()` methods
- A string with invalid hex characters or odd length

📖 **[Detailed Script Validation Examples](../SCRIPT_VALIDATION_EXAMPLES.md)**

## Key Derivation

### `getDerivation()`

Generates a random BRC-29 key derivation with protocolID and keyID.

```typescript
import { getDerivation } from '@bsv/wallet-helper';

const derivation = getDerivation();
// { protocolID: [array], keyID: 'randomPrefix randomSuffix' }
```

**Returns:** `{ protocolID: [2, 'BRC29'], keyID: string }`
- `protocolID`: BRC-29 protocol identifier array
- `keyID`: Random derivation string (base64 prefix + space + base64 suffix)

### `getAddress(wallet, amount?)`

Generates multiple unique BSV addresses with their complete wallet parameters using parallel wallet key derivation. Each result includes the address and all the wallet parameters needed to later unlock UTXOs sent to that address.

```typescript
import { getAddress } from '@bsv/wallet-helper';

// Generate a single address (default)
const results = await getAddress(wallet);
// [{
//   address: '1ABC...',
//   walletParams: {
//     protocolID: [2, 'BRC29'],
//     keyID: 'xyz123 abc456',
//     counterparty: 'anyone'
//   }
// }]

// Generate multiple addresses in parallel
const results = await getAddress(wallet, 5);

// Use the walletParams directly in P2PKH unlocking
const p2pkh = new WalletP2PKH(wallet);
const unlockingScript = p2pkh.unlock(results[0].walletParams);
```

**Parameters:**
- `wallet`: `WalletInterface` - BRC-100 compatible wallet
- `amount?`: `number` - Number of addresses to generate (default: 1)

**Returns:** `Promise<AddressWithParams[]>` - Array of objects containing:
- `address`: `string` - BSV address derived from the public key
- `walletParams`: `object` - Complete wallet parameters for unlocking:
  - `protocolID`: `WalletProtocol` - BRC-29 protocol identifier
  - `keyID`: `string` - Random derivation keyID
  - `counterparty`: `string` - Counterparty identifier (set to 'anyone')

**Throws:**
- `Error` if wallet is not provided
- `Error` if amount is less than 1
- `Error` if wallet key derivation fails

**Performance Note:** Uses parallel execution for efficient batch address generation.

**Use Case:** Perfect for generating receiving addresses where you need to store the wallet parameters alongside each address to later unlock and spend UTXOs.
