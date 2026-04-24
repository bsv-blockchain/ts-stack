# Tokens

Tokens in `@bsv/simple` are PushDrop outputs with encrypted payloads. They can hold any JSON-serializable data, be transferred between wallets, and be sent peer-to-peer via MessageBox.

## Creating a Token

```typescript
const result = await wallet.createToken({
  data: { type: 'loyalty', points: 100, tier: 'gold' },
  basket: 'my-tokens',
  satoshis: 1
})

console.log('Token created:', result.txid)
console.log('Basket:', result.basket)
console.log('Encrypted:', result.encrypted)  // true
```

### How Token Creation Works

1. Your data is serialized to JSON
2. The JSON is encrypted using the wallet's key derivation (`counterparty: 'self'`)
3. The ciphertext is locked in a PushDrop script
4. The output is stored in the specified basket with `customInstructions` containing the decryption parameters

### TokenOptions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `data` | `any` | *required* | JSON-serializable data to encrypt |
| `to` | `string` | self | Recipient identity key |
| `basket` | `string` | `'tokens'` | Basket to store the token in |
| `protocolID` | `[number, string]` | `[0, 'token']` | PushDrop protocol ID |
| `keyID` | `string` | `'1'` | PushDrop key ID |
| `satoshis` | `number` | `1` | Satoshis locked in the token |

## Listing Tokens

```typescript
const tokens = await wallet.listTokenDetails('my-tokens')

for (const token of tokens) {
  console.log('Outpoint:', token.outpoint)
  console.log('Satoshis:', token.satoshis)
  console.log('Data:', token.data)
  // { type: 'loyalty', points: 100, tier: 'gold' }
}
```

The `listTokenDetails` method:

1. Fetches all outputs from the basket with locking scripts and custom instructions
2. Decodes each PushDrop locking script
3. Reads the `customInstructions` to get decryption parameters
4. Decrypts the payload and parses it as JSON
5. Falls back to `counterparty: 'anyone'` if `'self'` decryption fails (for compatibility with older tokens)

### TokenDetail

| Field | Type | Description |
|-------|------|-------------|
| `outpoint` | `string` | Transaction ID and output index (`txid.vout`) |
| `satoshis` | `number` | Satoshis locked in the token |
| `data` | `any` | Decrypted payload (or `null` if decryption failed) |
| `protocolID` | `any` | Protocol ID used for encryption |
| `keyID` | `string` | Key ID used for encryption |
| `counterparty` | `string` | Counterparty used for encryption |

## Sending a Token (On-Chain)

Transfer a token to another wallet directly on-chain:

```typescript
await wallet.sendToken({
  basket: 'my-tokens',
  outpoint: tokens[0].outpoint,
  to: recipientIdentityKey
})
```

### How Token Send Works

This is a two-step signing flow:

1. The original token output is fetched with its full transaction (BEEF format)
2. The PushDrop fields are decoded from the original locking script
3. A new PushDrop output is created with a fresh key, locked to the recipient
4. `createAction()` is called with the old token as input and new token as output
5. The SDK returns a `signableTransaction` (since we need to provide the PushDrop unlock)
6. The unlock template signs the transaction
7. `signAction()` completes the transaction

The token stays in the same basket but with updated `customInstructions` reflecting the new key and counterparty.

## Redeeming a Token

Spend a token and recover its satoshis:

```typescript
await wallet.redeemToken({
  basket: 'my-tokens',
  outpoint: tokens[0].outpoint
})
```

This uses the same two-step signing flow as `sendToken`, but creates no outputs — the token's satoshis return to the wallet as change.

## Sending a Token via MessageBox

Transfer a token to another wallet using MessageBox P2P messaging:

```typescript
// Sender
await wallet.sendTokenViaMessageBox({
  basket: 'my-tokens',
  outpoint: tokens[0].outpoint,
  to: recipientIdentityKey
})
```

This creates the token transfer transaction on-chain, then sends the transaction bytes to the recipient via the `simple_token_inbox` MessageBox.

### Receiving Tokens via MessageBox

```typescript
// Check for incoming tokens
const incoming = await wallet.listIncomingTokens()
console.log(`${incoming.length} incoming tokens`)

// Accept each token
for (const token of incoming) {
  const accepted = await wallet.acceptIncomingToken(token, 'received-tokens')
  console.log('Accepted from:', accepted.sender)
}
```

`acceptIncomingToken` internalizes the token using `basket insertion` protocol and acknowledges the message to remove it from the inbox.

### Incoming Token Structure

| Field | Type | Description |
|-------|------|-------------|
| `messageId` | `string` | MessageBox message ID |
| `sender` | `string` | Sender's identity key |
| `transaction` | `number[]` | Transaction bytes |
| `protocolID` | `any` | PushDrop protocol ID |
| `keyID` | `string` | PushDrop key ID |
| `outputIndex` | `number` | Output index in transaction |
| `createdAt` | `string` | Timestamp |

## Complete Example

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()

// Create a token
const created = await wallet.createToken({
  data: { type: 'ticket', event: 'BSV Conference', seat: 'A12' },
  basket: 'event-tickets'
})

// List all tokens
const tickets = await wallet.listTokenDetails('event-tickets')
console.log('My tickets:', tickets.map(t => t.data))

// Send to someone (on-chain)
await wallet.sendToken({
  basket: 'event-tickets',
  outpoint: tickets[0].outpoint,
  to: friendIdentityKey
})

// Or send via MessageBox (P2P)
await wallet.sendTokenViaMessageBox({
  basket: 'event-tickets',
  outpoint: tickets[1].outpoint,
  to: friendIdentityKey
})
```
