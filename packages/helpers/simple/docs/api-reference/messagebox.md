# MessageBox Module

The messagebox module provides P2P payment messaging, identity registration, and discovery through the BSV MessageBox infrastructure and an identity registry API.

**Source:** `src/modules/messagebox.ts`

## Internal State

The module lazily creates and reuses a single `PeerPayClient` instance per wallet:

```typescript
const peerPay = new PeerPayClient({
  walletClient: client,
  messageBoxHost: core.defaults.messageBoxHost,  // default: 'https://messagebox.babbage.systems'
  enableLogging: false
})
```

## Identity & Certification

### certifyForMessageBox()

```typescript
async certifyForMessageBox(
  handle: string,
  registryUrl?: string,
  host?: string
): Promise<{ txid: string; handle: string }>
```

Register a handle on the identity registry and anoint a MessageBox host.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `handle` | `string` | *required* | Display name/handle (e.g., `'@alice'`) |
| `registryUrl` | `string` | `defaults.registryUrl` | Identity registry API endpoint |
| `host` | `string` | `defaults.messageBoxHost` | MessageBox host to anoint |

**Returns:** `{ txid: string, handle: string }`

**Throws:** `Error` if `registryUrl` is not provided and not in defaults.

**What happens:**
1. Calls `PeerPayClient.anointHost()` to register with the MessageBox host
2. POSTs `{ tag: handle, identityKey }` to the registry's `?action=register` endpoint

### getMessageBoxHandle()

```typescript
async getMessageBoxHandle(registryUrl?: string): Promise<string | null>
```

Check if the wallet has a registered handle.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `registryUrl` | `string` | `defaults.registryUrl` | Identity registry API endpoint |

**Returns:** The registered handle string, or `null` if not registered.

### revokeMessageBoxCertification()

```typescript
async revokeMessageBoxCertification(registryUrl?: string): Promise<void>
```

Remove all registered handles for this wallet from the identity registry.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `registryUrl` | `string` | `defaults.registryUrl` | Identity registry API endpoint |

**Behavior:** Lists all tags for this identity key, then revokes each one.

## Payments

### sendMessageBoxPayment()

```typescript
async sendMessageBoxPayment(
  to: string,
  satoshis: number
): Promise<any>
```

Send a payment via MessageBox P2P messaging.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `to` | `string` | *required* | Recipient's identity key |
| `satoshis` | `number` | *required* | Amount to send |

**Returns:**

```typescript
{
  txid: string
  amount: number
  recipient: string
}
```

**What happens:**
1. Creates a payment token via `PeerPayClient.createPaymentToken()`
2. Sends the token to `payment_inbox` message box

### listIncomingPayments()

```typescript
async listIncomingPayments(): Promise<any[]>
```

List payments waiting in the MessageBox inbox.

**Returns:** Array of incoming payment objects from `PeerPayClient.listIncomingPayments()`.

### acceptIncomingPayment()

```typescript
async acceptIncomingPayment(payment: any, basket?: string): Promise<any>
```

Accept an incoming payment.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `payment` | `any` | *required* | Payment object from `listIncomingPayments()` |
| `basket` | `string` | — | If provided, uses `basket insertion`; otherwise uses `PeerPayClient.acceptPayment()` |

**Behavior depends on `basket` parameter:**

**With basket (recommended):**
- Internalizes using `basket insertion` protocol
- Stores derivation info in `customInstructions`
- Acknowledges the message
- Returns `{ payment, paymentResult: 'accepted' }`

**Without basket:**
- Delegates to `PeerPayClient.acceptPayment()`
- Checks for the silent failure string (see [Gotchas](../gotchas.md#2-peerpayclientacceptpayment-silently-fails))

## Identity Registry

These methods interact with an HTTP identity registry API (typically at `/api/identity-registry`).

### registerIdentityTag()

```typescript
async registerIdentityTag(tag: string, registryUrl?: string): Promise<{ tag: string }>
```

Register an identity tag (without anointing a MessageBox host).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tag` | `string` | *required* | Tag to register |
| `registryUrl` | `string` | `defaults.registryUrl` | Registry API endpoint |

### lookupIdentityByTag()

```typescript
async lookupIdentityByTag(
  query: string,
  registryUrl?: string
): Promise<{ tag: string; identityKey: string }[]>
```

Search the identity registry for matching tags.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | *required* | Search query |
| `registryUrl` | `string` | `defaults.registryUrl` | Registry API endpoint |

**Returns:** Array of `{ tag, identityKey }` matches.

### listMyTags()

```typescript
async listMyTags(registryUrl?: string): Promise<{ tag: string; createdAt: string }[]>
```

List all tags registered by this wallet.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `registryUrl` | `string` | `defaults.registryUrl` | Registry API endpoint |

### revokeIdentityTag()

```typescript
async revokeIdentityTag(tag: string, registryUrl?: string): Promise<void>
```

Remove a specific tag from the identity registry.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tag` | `string` | *required* | Tag to revoke |
| `registryUrl` | `string` | `defaults.registryUrl` | Registry API endpoint |
