# MessageBox & P2P

MessageBox enables peer-to-peer communication between BSV wallets. Through `@bsv/simple`, you can register an identity handle, send and receive payments, and look up other users — all without a central server knowing who you are.

## Identity Registration

Before using MessageBox, you need to register an identity handle and anoint a MessageBox host.

### Register a Handle

```typescript
const result = await wallet.certifyForMessageBox('@alice', '/api/identity-registry')

console.log('Handle:', result.handle)  // '@alice'
```

This does two things:
1. Anoints the MessageBox host (enables P2P messaging)
2. Registers the handle `@alice` in the identity registry

### Check Existing Handle

Check if the wallet already has a registered handle (use this on page load):

```typescript
const handle = await wallet.getMessageBoxHandle('/api/identity-registry')

if (handle) {
  console.log('Already registered as:', handle)
} else {
  console.log('Not registered yet')
}
```

### Revoke Registration

Remove all registered handles and stop being discoverable:

```typescript
await wallet.revokeMessageBoxCertification('/api/identity-registry')
```

## Sending Payments

Send BSV to another wallet via MessageBox P2P:

```typescript
const result = await wallet.sendMessageBoxPayment(
  recipientIdentityKey,
  1000  // satoshis
)

console.log('Amount:', result.amount)
console.log('Recipient:', result.recipient)
```

### How It Works

1. Creates a payment token using `PeerPayClient.createPaymentToken()`
2. Sends the token to the recipient's `payment_inbox` via MessageBox

## Receiving Payments

### List Incoming Payments

```typescript
const incoming = await wallet.listIncomingPayments()
console.log(`${incoming.length} payments waiting`)
```

### Accept a Payment

```typescript
// Into a named basket (recommended)
const result = await wallet.acceptIncomingPayment(
  incoming[0],
  'received-payments'   // basket name
)
```

When you pass a basket name, the payment is internalized using `basket insertion` protocol. This makes the output visible via `listOutputs` and stores derivation info in `customInstructions`.

```typescript
// Without a basket (uses PeerPayClient.acceptPayment)
const result = await wallet.acceptIncomingPayment(incoming[0])
```

Without a basket, the library uses `PeerPayClient.acceptPayment()` and checks for swallowed errors.

### Process All Incoming

```typescript
const incoming = await wallet.listIncomingPayments()

for (const payment of incoming) {
  try {
    await wallet.acceptIncomingPayment(payment, 'received-payments')
    console.log('Accepted payment from:', payment.sender)
  } catch (e) {
    console.error('Failed:', (e as Error).message)
  }
}
```

## Identity Registry

The identity registry is a simple API that maps handles to identity keys. You need to implement the registry as an API route in your application.

### Search for Users

```typescript
const results = await wallet.lookupIdentityByTag('alice', '/api/identity-registry')

for (const match of results) {
  console.log(`${match.tag} → ${match.identityKey}`)
}
```

### Register Additional Tags

```typescript
await wallet.registerIdentityTag('@alice_backup', '/api/identity-registry')
```

### List Your Tags

```typescript
const tags = await wallet.listMyTags('/api/identity-registry')

for (const tag of tags) {
  console.log(`${tag.tag} (created: ${tag.createdAt})`)
}
```

### Revoke a Tag

```typescript
await wallet.revokeIdentityTag('@alice_backup', '/api/identity-registry')
```

## Identity Registry API Specification

Your identity registry endpoint must support these operations:

| Method | Query | Body | Response |
|--------|-------|------|----------|
| `GET` | `?action=lookup&query=alice` | — | `{ success, results: [{ tag, identityKey }] }` |
| `GET` | `?action=list&identityKey=02abc...` | — | `{ success, tags: [{ tag, createdAt }] }` |
| `POST` | `?action=register` | `{ tag, identityKey }` | `{ success }` |
| `POST` | `?action=revoke` | `{ tag, identityKey }` | `{ success }` |

## Complete Example

```typescript
const wallet = await createWallet()
const REGISTRY = '/api/identity-registry'

// Register identity
const handle = await wallet.getMessageBoxHandle(REGISTRY)
if (!handle) {
  await wallet.certifyForMessageBox('@alice', REGISTRY)
}

// Find a recipient
const results = await wallet.lookupIdentityByTag('bob', REGISTRY)
const bob = results[0]

// Send payment
await wallet.sendMessageBoxPayment(bob.identityKey, 5000)

// Check inbox
const incoming = await wallet.listIncomingPayments()
for (const payment of incoming) {
  await wallet.acceptIncomingPayment(payment, 'received')
}
```
