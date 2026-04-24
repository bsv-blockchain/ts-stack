# Script Validation Helper Functions

This document provides examples of how to use the new script validation helper functions.

## Functions

### `isP2PKH(script | hex): boolean`

Checks if a script is a standard Pay-to-Public-Key-Hash (P2PKH) script.

```typescript
import { isP2PKH } from '@bsv/wallet-helper';
import P2PKH from '@bsv/wallet-helper/script-templates/p2pkh';

// Using with LockingScript
const p2pkh = new P2PKH();
const script = await p2pkh.lock({ publicKey: '02...' });

if (isP2PKH(script)) {
  console.log('This is a P2PKH script!');
}

// Using with hex string
const hex = '76a914' + 'ab'.repeat(20) + '88ac';
if (isP2PKH(hex)) {
  console.log('This hex represents a P2PKH script!');
}
```

### `isOrdinal(script | hex): boolean`

Checks if a script contains both a BSV-20 Ordinal inscription envelope AND a P2PKH script.

The BSV-20 standard uses the envelope format: `OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0`

```typescript
import { isOrdinal } from '@bsv/wallet-helper';
import OrdP2PKH from '@bsv/wallet-helper/script-templates/ordinal';

const ordP2PKH = new OrdP2PKH();
const script = await ordP2PKH.lock({
  publicKey: '02...',
  inscription: {
    dataB64: Buffer.from('Hello World').toString('base64'),
    contentType: 'application/bsv-20' // BSV-20 standard
  }
});

if (isOrdinal(script)) {
  console.log('This is a BSV-20 Ordinal inscription with P2PKH!');
}
```

### `hasOrd(script | hex): boolean`

Checks if a script contains a BSV-20 Ordinal inscription envelope (regardless of what else is in the script).

The BSV-20 envelope starts with: `OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0`

```typescript
import { hasOrd } from '@bsv/wallet-helper';

// This checks for the presence of the BSV-20 ordinal envelope only
if (hasOrd(script)) {
  console.log('This script contains a BSV-20 ordinal inscription!');
}

// Works with hex strings too
const hex = '0063036f726451126170706c69636174696f6e2f6273762d323000...'; // BSV-20 envelope
if (hasOrd(hex)) {
  console.log('This hex contains a BSV-20 ordinal envelope!');
}
```

### `hasOpReturnData(script | hex): boolean`

Checks if a script contains OP_RETURN data.

```typescript
import { hasOpReturnData, addOpReturnData } from '@bsv/wallet-helper';
import P2PKH from '@bsv/wallet-helper/script-templates/p2pkh';

const p2pkh = new P2PKH();
const baseScript = await p2pkh.lock({ publicKey: '02...' });

// Add OP_RETURN data
const scriptWithData = addOpReturnData(baseScript, [
  'Hello',
  'World',
  '{ "type": "message" }'
]);

if (hasOpReturnData(scriptWithData)) {
  console.log('This script contains OP_RETURN data!');
}

// Check P2PKH without OP_RETURN
if (!hasOpReturnData(baseScript)) {
  console.log('This P2PKH script has no OP_RETURN data');
}
```

## Combined Usage Example

```typescript
import {
  isP2PKH,
  isOrdinal,
  hasOrd,
  hasOpReturnData
} from '@bsv/wallet-helper';

function analyzeScript(script: LockingScript) {
  console.log('Script Analysis:');
  console.log('- Is pure P2PKH:', isP2PKH(script));
  console.log('- Is Ordinal + P2PKH:', isOrdinal(script));
  console.log('- Has Ordinal envelope:', hasOrd(script));
  console.log('- Has OP_RETURN data:', hasOpReturnData(script));
}

// Analyze different script types
const p2pkhScript = await p2pkh.lock({ publicKey: '02...' });
analyzeScript(p2pkhScript);
// Output:
// - Is pure P2PKH: true
// - Is Ordinal + P2PKH: false
// - Has Ordinal envelope: false
// - Has OP_RETURN data: false

const ordinalScript = await ordP2PKH.lock({
  publicKey: '02...',
  inscription: { dataB64: '...', contentType: 'image/png' }
});
analyzeScript(ordinalScript);
// Output:
// - Is pure P2PKH: false
// - Is Ordinal + P2PKH: true
// - Has Ordinal envelope: true
// - Has OP_RETURN data: false
```

## Notes

- All functions accept both `LockingScript`/`Script` objects and hex strings
- Functions return `false` for scripts that don't match the expected pattern
- **Functions throw errors for invalid input types** (null, arrays, numbers, invalid hex strings)
- `isP2PKH()` checks for the exact P2PKH pattern (50 hex characters)
- `isOrdinal()` checks for BOTH BSV-20 ordinal envelope AND P2PKH (stricter than `hasOrd()`)
- `hasOrd()` only checks for the BSV-20 ordinal envelope presence
- `hasOpReturnData()` uses ASM parsing when possible to avoid false positives

## Runtime Validation

All validation functions include runtime type checking and will throw errors for invalid inputs:

```typescript
// ❌ These will throw errors
isP2PKH(null);              // Error: Input cannot be null or undefined
isP2PKH([1, 2, 3]);         // Error: Input cannot be an array
isP2PKH(123);               // Error: got number
isP2PKH('xyz');             // Error: String must be a valid hexadecimal string
isP2PKH('abc');             // Error: Hex string must have even length
isP2PKH({ foo: 'bar' });    // Error: Object must have toHex() and toASM() methods

// ✅ These are valid and return false (valid input, but doesn't match pattern)
isP2PKH('deadbeef');        // false - valid hex but not P2PKH
isP2PKH('');                // false - empty string
```

## Pattern Matching

The functions use these hex patterns:

- **P2PKH**: `76a914[20 bytes]88ac`
  - `76` = OP_DUP
  - `a9` = OP_HASH160
  - `14` = push 20 bytes
  - `[20 bytes]` = pubkey hash
  - `88` = OP_EQUALVERIFY
  - `ac` = OP_CHECKSIG

- **BSV-20 Ordinal Envelope**: `0063036f726451126170706c69636174696f6e2f6273762d323000...`
  - `00` = OP_0
  - `63` = OP_IF
  - `03` = push 3 bytes
  - `6f7264` = 'ord' in hex
  - `51` = OP_1
  - `12` = push 18 bytes
  - `6170706c69636174696f6e2f6273762d3230` = 'application/bsv-20' in hex
  - `00` = OP_0 (marks start of data section)

- **OP_RETURN**: `6a`
  - `6a` = OP_RETURN opcode
