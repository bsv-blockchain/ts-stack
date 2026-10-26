# WalletCore

`WalletCore` is the abstract base class that both `BrowserWallet` and `ServerWallet` extend. It provides wallet info, key derivation, payments, multi-output sends, and server wallet funding.

**Source:** `src/core/WalletCore.ts`

## Constructor

```typescript
constructor(identityKey: string, defaults?: Partial<WalletDefaults>)
```

| Parameter     | Type                      | Description                          |
| ------------- | ------------------------- | ------------------------------------ |
| `identityKey` | `string`                  | Compressed public key hex (66 chars) |
| `defaults`    | `Partial<WalletDefaults>` | Override default configuration       |

## Abstract Methods

### getClient()

```typescript
abstract getClient(): WalletInterface
```

Returns the underlying BSV SDK wallet client. Implemented by `BrowserWallet` (returns `WalletClient`) and `ServerWallet` (returns `ToolboxWallet`).

## Wallet Info

### getIdentityKey()

```typescript
getIdentityKey(): string
```

Returns the wallet's compressed public key hex string (66 characters).

### getAddress()

```typescript
getAddress(): string
```

Returns the P2PKH address derived from the identity key.

### getStatus()

```typescript
getStatus(): WalletStatus
```

**Returns:**

```typescript
{
  isConnected: boolean
  identityKey: string | null
  network: string
}
```

### getWalletInfo()

```typescript
getWalletInfo(): WalletInfo
```

**Returns:**

```typescript
{
  identityKey: string
  address: string
  network: string
  isConnected: boolean
}
```

## Balance

### getBalance()

```typescript
async getBalance(basket?: string): Promise<BalanceResult>
```

Basket balances are read through bounded pagination (up to 100,000 outputs). Every wallet page is schema-validated; duplicate outputs, changing totals, incomplete pages, invalid satoshi values, and oversized baskets fail closed instead of producing a partial or inflated financial result.

Get the wallet's balance. Works on both browser and server wallets.

| Parameter | Type     | Default     | Description                                                     |
| --------- | -------- | ----------- | --------------------------------------------------------------- |
| `basket`  | `string` | `undefined` | Optional basket name. If omitted, returns total wallet balance. |

**Returns:** [`BalanceResult`](types.md#balanceresult)

**Behavior:**

- **Without basket:** Uses the wallet-toolbox `specOpWalletBalance` special operation for an optimized query — the balance is computed at the storage layer without fetching individual outputs. Returns the total spendable change balance. `totalOutputs` and `spendableOutputs` are `0` (output-level counts are not available in this mode).
- **With basket:** Calls `listOutputs({ basket })` and iterates over the returned outputs to compute total/spendable satoshis and output counts.

**Example:**

```typescript
// Overall wallet balance (optimized)
const balance = await wallet.getBalance()
console.log(`Balance: ${balance.totalSatoshis} sats`)

// Balance for a specific basket
const tokenBalance = await wallet.getBalance('tokens')
console.log(
  `${tokenBalance.spendableOutputs} spendable token outputs worth ${tokenBalance.spendableSatoshis} sats`
)
```

## Key Derivation

### derivePublicKey()

```typescript
async derivePublicKey(
  protocolID: [SecurityLevel, string],
  keyID: string,
  counterparty?: string,
  forSelf?: boolean
): Promise<string>
```

Derive a public key for any protocol.

| Parameter      | Type                      | Default    | Description                                       |
| -------------- | ------------------------- | ---------- | ------------------------------------------------- |
| `protocolID`   | `[SecurityLevel, string]` | _required_ | Protocol identifier (e.g., `[2, '3241645161d8']`) |
| `keyID`        | `string`                  | _required_ | Key identifier (e.g., `'invoice-001'`)            |
| `counterparty` | `string`                  | `'anyone'` | Counterparty identity key                         |
| `forSelf`      | `boolean`                 | `false`    | Derive for self instead of counterparty           |

**Returns:** Compressed public key hex string.

### derivePaymentKey()

```typescript
async derivePaymentKey(counterparty: string, invoiceNumber?: string): Promise<string>
```

Derive a BRC-29 payment key. Uses protocol ID `[2, '3241645161d8']`.

| Parameter       | Type     | Default    | Description              |
| --------------- | -------- | ---------- | ------------------------ |
| `counterparty`  | `string` | _required_ | Recipient's identity key |
| `invoiceNumber` | `string` | random     | Invoice/key identifier   |

**Returns:** Compressed public key hex string.

## Payments

### pay()

```typescript
async pay(options: PaymentOptions): Promise<TransactionResult>
```

Send a BRC-29 payment to a counterparty via `PeerPayClient.sendPayment()`. The payment is constructed and delivered to the recipient in a single call.

| Parameter             | Type     | Required | Description              |
| --------------------- | -------- | -------- | ------------------------ |
| `options.to`          | `string` | Yes      | Recipient's identity key |
| `options.satoshis`    | `number` | Yes      | Amount to send           |
| `options.memo`        | `string` | No       | Optional memo            |
| `options.description` | `string` | No       | Transaction description  |

**Returns:** [`TransactionResult`](types.md#transactionresult)

### send()

```typescript
async send(options: SendOptions): Promise<SendResult>
```

Create a transaction with multiple outputs of different types in a single transaction.

| Parameter             | Type               | Required | Description                    |
| --------------------- | ------------------ | -------- | ------------------------------ |
| `options.outputs`     | `SendOutputSpec[]` | Yes      | Array of output specifications |
| `options.description` | `string`           | No       | Transaction description        |

**Returns:** [`SendResult`](types.md#sendresult) (extends `TransactionResult` with `outputDetails`)

**Output routing rules:**

| `to` | `data` | Result                                                                                          |
| ---- | ------ | ----------------------------------------------------------------------------------------------- |
| Yes  | No     | **P2PKH** — Simple payment (`satoshis` required, > 0)                                           |
| No   | Yes    | **OP_RETURN** — Data inscription (`satoshis` = 0)                                               |
| Yes  | Yes    | **PushDrop** — Token locked under a key derived with `to` as the counterparty (`satoshis` >= 1) |
| No   | No     | Error                                                                                           |

**`SendOutputSpec` fields:**

| Field         | Type                                | Description                                                             |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `to`          | `string?`                           | Recipient public key                                                    |
| `satoshis`    | `number?`                           | Amount (required for P2PKH, default 1 for PushDrop, 0 for OP_RETURN)    |
| `data`        | `(string \| object \| number[])[]?` | Data fields (dense bytes/JSON, at most 256 fields and 1 MiB per output) |
| `description` | `string?`                           | Output description                                                      |
| `basket`      | `string?`                           | Track in a basket                                                       |
| `protocolID`  | `[number, string]?`                 | PushDrop protocol ID                                                    |
| `keyID`       | `string?`                           | PushDrop key ID                                                         |

`send()` accepts at most 1,000 outputs, requires safe integer satoshi amounts, and validates the wallet's completed action result against the exact requested outputs. A malformed or missing completion claim is rejected rather than surfaced as an empty transaction ID.

### fundServerWallet()

```typescript
async fundServerWallet(
  request: PaymentRequest,
  basket?: string
): Promise<TransactionResult>
```

Fund a `ServerWallet` using a BRC-29 derived payment.

| Parameter | Type             | Required | Description                                                |
| --------- | ---------------- | -------- | ---------------------------------------------------------- |
| `request` | `PaymentRequest` | Yes      | Payment request from `ServerWallet.createPaymentRequest()` |
| `basket`  | `string`         | No       | Track the funding output in a basket                       |

**Returns:** [`TransactionResult`](types.md#transactionresult)

Payment requests must contain a canonical compressed server identity key, bounded Base64 derivation values, a positive safe-integer satoshi amount, and a memo of at most 2,000 UTF-8 bytes. The request is copied before asynchronous wallet calls so caller mutation cannot redirect the payment.
