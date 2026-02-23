# WalletCore

`WalletCore` is the abstract base class that both `BrowserWallet` and `ServerWallet` extend. It provides wallet info, key derivation, payments, multi-output sends, and server wallet funding.

**Source:** `src/core/WalletCore.ts`

## Constructor

```typescript
constructor(identityKey: string, defaults?: Partial<WalletDefaults>)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `identityKey` | `string` | Compressed public key hex (66 chars) |
| `defaults` | `Partial<WalletDefaults>` | Override default configuration |

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

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `protocolID` | `[SecurityLevel, string]` | *required* | Protocol identifier (e.g., `[2, '3241645161d8']`) |
| `keyID` | `string` | *required* | Key identifier (e.g., `'invoice-001'`) |
| `counterparty` | `string` | `'anyone'` | Counterparty identity key |
| `forSelf` | `boolean` | `false` | Derive for self instead of counterparty |

**Returns:** Compressed public key hex string.

### derivePaymentKey()

```typescript
async derivePaymentKey(counterparty: string, invoiceNumber?: string): Promise<string>
```

Derive a BRC-29 payment key. Uses protocol ID `[2, '3241645161d8']`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `counterparty` | `string` | *required* | Recipient's identity key |
| `invoiceNumber` | `string` | random | Invoice/key identifier |

**Returns:** Compressed public key hex string.

## Payments

### pay()

```typescript
async pay(options: PaymentOptions): Promise<TransactionResult>
```

Send a BRC-29 payment to a counterparty via `PeerPayClient.sendPayment()`. The payment is constructed and delivered to the recipient in a single call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options.to` | `string` | Yes | Recipient's identity key |
| `options.satoshis` | `number` | Yes | Amount to send |
| `options.memo` | `string` | No | Optional memo |
| `options.description` | `string` | No | Transaction description |

**Returns:** [`TransactionResult`](types.md#transactionresult)

### send()

```typescript
async send(options: SendOptions): Promise<SendResult>
```

Create a transaction with multiple outputs of different types in a single transaction.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options.outputs` | `SendOutputSpec[]` | Yes | Array of output specifications |
| `options.description` | `string` | No | Transaction description |

**Returns:** [`SendResult`](types.md#sendresult) (extends `TransactionResult` with `outputDetails`)

**Output routing rules:**

| `to` | `data` | Result |
|------|--------|--------|
| Yes | No | **P2PKH** — Simple payment (`satoshis` required, > 0) |
| No | Yes | **OP_RETURN** — Data inscription (`satoshis` = 0) |
| Yes | Yes | **PushDrop** — Encrypted token (`satoshis` >= 1) |
| No | No | Error |

**`SendOutputSpec` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `to` | `string?` | Recipient public key |
| `satoshis` | `number?` | Amount (required for P2PKH, default 1 for PushDrop, 0 for OP_RETURN) |
| `data` | `(string \| object \| number[])[]?` | Data fields |
| `description` | `string?` | Output description |
| `basket` | `string?` | Track in a basket |
| `protocolID` | `[number, string]?` | PushDrop protocol ID |
| `keyID` | `string?` | PushDrop key ID |

### fundServerWallet()

```typescript
async fundServerWallet(
  request: PaymentRequest,
  basket?: string
): Promise<TransactionResult>
```

Fund a `ServerWallet` using a BRC-29 derived payment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `request` | `PaymentRequest` | Yes | Payment request from `ServerWallet.createPaymentRequest()` |
| `basket` | `string` | No | Track the funding output in a basket |

**Returns:** [`TransactionResult`](types.md#transactionresult)
