# Tokens Module

The tokens module provides encrypted PushDrop token creation, listing with decryption, on-chain transfer, redemption, and MessageBox-based P2P transfer.

**Source:** `src/modules/tokens.ts`

## createToken()

```typescript
async createToken(options: TokenOptions): Promise<TokenResult>
```

Create an encrypted PushDrop token.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `options.data` | `any` | *required* | Token data (object or string, will be JSON-serialized) |
| `options.to` | `string` | self | Recipient public key |
| `options.basket` | `string` | `'tokens'` | Basket to store the token |
| `options.protocolID` | `[number, string]` | `[0, 'token']` | PushDrop protocol ID |
| `options.keyID` | `string` | `'1'` | PushDrop key ID |
| `options.satoshis` | `number` | `1` | Satoshis locked in the token |

**Returns:** [`TokenResult`](types.md#tokenresult)

**What happens:**
1. Serializes `data` to JSON string
2. Encrypts using `client.encrypt()` with the specified protocol/key
3. Creates a PushDrop locking script with the ciphertext
4. Creates the transaction via `createAction()`
5. Stores `{ protocolID, keyID, counterparty }` in `customInstructions` for later decryption

```typescript
const result = await wallet.createToken({
  data: { type: 'loyalty', points: 100 },
  basket: 'my-tokens',
  satoshis: 1
})
```

## listTokenDetails()

```typescript
async listTokenDetails(basket?: string): Promise<TokenDetail[]>
```

List tokens in a basket with automatic decryption.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `basket` | `string` | `'tokens'` | Basket to query |

**Returns:** Array of [`TokenDetail`](types.md#tokendetail)

```typescript
interface TokenDetail {
  outpoint: string     // "txid.vout"
  satoshis: number
  data: any            // Decrypted token data
  protocolID: any
  keyID: string
  counterparty: string
}
```

**Behavior:**
- Fetches outputs with locking scripts and custom instructions
- Decodes PushDrop fields from each output
- Reads `protocolID`, `keyID`, `counterparty` from `customInstructions`
- Decrypts the PushDrop field using `client.decrypt()`
- Falls back to `counterparty: 'anyone'` if `'self'` decryption fails
- Skips non-PushDrop outputs silently

## sendToken()

```typescript
async sendToken(options: SendTokenOptions): Promise<TransactionResult>
```

Transfer a token to another key via on-chain transaction.

| Parameter | Type | Description |
|-----------|------|-------------|
| `options.basket` | `string` | Basket containing the token |
| `options.outpoint` | `string` | Token outpoint (`"txid.vout"`) |
| `options.to` | `string` | Recipient's public key |

**Returns:** [`TransactionResult`](types.md#transactionresult)

**What happens (two-step signing):**
1. Lists outputs with `include: 'entire transactions'` to get BEEF data
2. Finds the target token by outpoint
3. Decodes the PushDrop fields from the source script
4. Creates a new PushDrop locking script for the recipient with a new `keyID`
5. Calls `createAction()` with the token as input — returns a `signableTransaction`
6. Signs the input using `PushDrop.unlock()` template
7. Calls `signAction()` with the unlocking script to finalize

## redeemToken()

```typescript
async redeemToken(options: RedeemTokenOptions): Promise<TransactionResult>
```

Spend/destroy a token (reclaims the locked satoshis).

| Parameter | Type | Description |
|-----------|------|-------------|
| `options.basket` | `string` | Basket containing the token |
| `options.outpoint` | `string` | Token outpoint (`"txid.vout"`) |

**Returns:** [`TransactionResult`](types.md#transactionresult)

**Behavior:** Same two-step signing flow as `sendToken()`, but with no new output — the token is consumed.

## sendTokenViaMessageBox()

```typescript
async sendTokenViaMessageBox(options: SendTokenOptions): Promise<TransactionResult>
```

Transfer a token to another key via MessageBox P2P messaging.

| Parameter | Type | Description |
|-----------|------|-------------|
| `options.basket` | `string` | Basket containing the token |
| `options.outpoint` | `string` | Token outpoint |
| `options.to` | `string` | Recipient's public key |

**Returns:** [`TransactionResult`](types.md#transactionresult)

**Behavior:**
1. Same two-step signing as `sendToken()`
2. After signing, sends the transaction via `PeerPayClient.sendMessage()` to the `simple_token_inbox` message box
3. Message body contains: `{ transaction, protocolID, keyID, sender, outputIndex }`

## listIncomingTokens()

```typescript
async listIncomingTokens(): Promise<any[]>
```

List tokens waiting in the MessageBox inbox.

**Returns:** Array of incoming token messages:

```typescript
{
  messageId: string
  sender: string
  transaction: number[]
  protocolID: any
  keyID: string
  outputIndex: number
  createdAt: string
}
```

## acceptIncomingToken()

```typescript
async acceptIncomingToken(token: any, basket?: string): Promise<any>
```

Accept an incoming token from the MessageBox inbox.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `token` | `any` | *required* | Token object from `listIncomingTokens()` |
| `basket` | `string` | `'tokens'` | Basket to store the accepted token |

**Returns:** `{ accepted: true, basket: string, sender: string }`

**Behavior:**
1. Internalizes the transaction using `basket insertion` protocol
2. Stores `{ protocolID, keyID, counterparty }` in `customInstructions`
3. Acknowledges the message to remove it from the inbox
