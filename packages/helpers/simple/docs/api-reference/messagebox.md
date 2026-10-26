# MessageBox Module

The messagebox module provides P2P payment messaging, identity registration, and discovery through the BSV MessageBox infrastructure and an identity registry API.

> **Security warning:** the legacy identity-registry API is unauthenticated. Its mutation requests contain a public identity key but no signature or proof of control. Treat all tag mappings as untrusted discovery hints, never as certificates or sufficient payment-recipient authentication. Confirm keys independently, and protect any exposed registry mutation route with an application authorization layer.

**Source:** `src/modules/messagebox.ts`

## Internal State

The module lazily creates and reuses a single `PeerPayClient` instance per wallet:

```typescript
const peerPay = new PeerPayClient({
  walletClient: client,
  messageBoxHost: core.defaults.messageBoxHost, // default: 'https://messagebox.babbage.systems'
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

Anoint a MessageBox host and add a handle to the legacy unauthenticated identity directory. The returned `txid` does not authenticate the separate directory entry.

| Parameter     | Type     | Default                   | Description                            |
| ------------- | -------- | ------------------------- | -------------------------------------- |
| `handle`      | `string` | _required_                | Display name/handle (e.g., `'@alice'`) |
| `registryUrl` | `string` | `defaults.registryUrl`    | Identity registry API endpoint         |
| `host`        | `string` | `defaults.messageBoxHost` | MessageBox host to anoint              |

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

| Parameter     | Type     | Default                | Description                    |
| ------------- | -------- | ---------------------- | ------------------------------ |
| `registryUrl` | `string` | `defaults.registryUrl` | Identity registry API endpoint |

**Returns:** The registered handle string, or `null` if not registered.

### revokeMessageBoxCertification()

```typescript
async revokeMessageBoxCertification(registryUrl?: string): Promise<void>
```

Request removal of all directory handles that name this wallet's public key. The legacy endpoint does not authenticate the requester.

| Parameter     | Type     | Default                | Description                    |
| ------------- | -------- | ---------------------- | ------------------------------ |
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

| Parameter  | Type     | Default    | Description              |
| ---------- | -------- | ---------- | ------------------------ |
| `to`       | `string` | _required_ | Recipient's identity key |
| `satoshis` | `number` | _required_ | Amount to send           |

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

**Returns:** At most 1,000 schema-validated incoming payments. Sender identity
comes from the authenticated MessageBox envelope; malformed senders,
transactions, derivation metadata, amounts, output indexes, and message IDs are
discarded.

### acceptIncomingPayment()

```typescript
async acceptIncomingPayment(payment: any, basket?: string): Promise<any>
```

Accept an incoming payment.

| Parameter | Type     | Default    | Description                                                           |
| --------- | -------- | ---------- | --------------------------------------------------------------------- |
| `payment` | `any`    | _required_ | Payment object from `listIncomingPayments()`                          |
| `basket`  | `string` | —          | If provided, uses `basket insertion`; otherwise uses `wallet payment` |

Only `payment.messageId` selects the payment. Immediately before changing the
wallet, Simple reloads the bounded authenticated inbox and requires exactly one
matching message. All sender, transaction, derivation, amount, and output data
comes from that fresh record, not the caller-supplied object.

**Behavior depends on `basket` parameter:**

**With basket (recommended):**

- Internalizes using `basket insertion` protocol
- Stores derivation info in `customInstructions`
- Acknowledges the message
- Returns `{ payment, paymentResult: 'accepted' }`

**Without basket:**

- Internalizes using the `wallet payment` protocol
- Requires the wallet to return `accepted: true`

Both paths acknowledge only after successful internalization. A subsequent
acknowledgement failure is recoverable and does not misreport funds already in
local custody as an internalization failure.

## Identity Registry

These methods interact with the legacy unauthenticated HTTP identity registry API (typically at `/api/identity-registry`). They do not establish key ownership.

Tags and queries are control-free strings of at most 128 characters, identity
keys are canonical compressed public keys, and client responses are bounded to
256 entries and 256 KiB. A non-boolean success verdict, malformed row,
non-canonical timestamp, HTTP error, redirect, timeout, or oversized response
fails closed. `revokeMessageBoxCertification()` reports list/revoke failures
instead of claiming that revocation completed.

By default, registry requests require public HTTPS and use DNS-address checking
and connection pinning to prevent private-network SSRF and DNS rebinding. A
controlled local or private deployment must opt in with
`WalletDefaults.registryFetch`; that callback is an explicit transport trust
boundary and must not be selected from untrusted input.

### registerIdentityTag()

```typescript
async registerIdentityTag(tag: string, registryUrl?: string): Promise<{ tag: string }>
```

Register an identity tag (without anointing a MessageBox host).

| Parameter     | Type     | Default                | Description                        |
| ------------- | -------- | ---------------------- | ---------------------------------- |
| `tag`         | `string` | _required_             | Control-free tag, 1–128 characters |
| `registryUrl` | `string` | `defaults.registryUrl` | Registry API endpoint              |

### lookupIdentityByTag()

```typescript
async lookupIdentityByTag(
  query: string,
  registryUrl?: string
): Promise<{ tag: string; identityKey: string }[]>
```

Search the identity registry for matching tags.

| Parameter     | Type     | Default                | Description                          |
| ------------- | -------- | ---------------------- | ------------------------------------ |
| `query`       | `string` | _required_             | Control-free query, 1–128 characters |
| `registryUrl` | `string` | `defaults.registryUrl` | Registry API endpoint                |

**Returns:** Array of `{ tag, identityKey }` matches.

### listMyTags()

```typescript
async listMyTags(registryUrl?: string): Promise<{ tag: string; createdAt: string }[]>
```

List all tags registered by this wallet.

| Parameter     | Type     | Default                | Description           |
| ------------- | -------- | ---------------------- | --------------------- |
| `registryUrl` | `string` | `defaults.registryUrl` | Registry API endpoint |

### revokeIdentityTag()

```typescript
async revokeIdentityTag(tag: string, registryUrl?: string): Promise<void>
```

Remove a specific tag from the identity registry.

| Parameter     | Type     | Default                | Description                        |
| ------------- | -------- | ---------------------- | ---------------------------------- |
| `tag`         | `string` | _required_             | Control-free tag, 1–128 characters |
| `registryUrl` | `string` | `defaults.registryUrl` | Registry API endpoint              |
