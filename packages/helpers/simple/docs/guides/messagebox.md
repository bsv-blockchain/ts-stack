# MessageBox & P2P

MessageBox enables peer-to-peer communication between BSV wallets. Through `@bsv/simple`, you can send and receive payments and use a compatibility identity-handle directory.

> **Security warning:** the bundled identity-registry request format is unauthenticated. Register and revoke requests contain a public identity key but no signature, nonce, or proof that the caller controls that key. Anyone can claim an unused tag for any public key or revoke a known key's tag. Directory results are untrusted discovery hints—not certificates—and must never be used alone to choose a payment recipient. Confirm the identity key through an independent authenticated channel. Do not expose `createIdentityRegistryHandler()` publicly unless a separate application authorization layer protects every mutation.

## Identity Registration

MessageBox host anointment and legacy directory registration are distinct. The handle operation below does both, but only host anointment has its own protocol evidence; the directory entry is not proof of identity.

### Register a Handle

```typescript
const result = await wallet.certifyForMessageBox('@alice', '/api/identity-registry')

console.log('Handle:', result.handle) // '@alice'
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
  1000 // satoshis
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

The list is bounded to 1,000 records and rejects malformed payment fields. The
sender always comes from the authenticated MessageBox envelope.

### Accept a Payment

```typescript
// Into a named basket (recommended)
const result = await wallet.acceptIncomingPayment(
  incoming[0],
  'received-payments' // basket name
)
```

When you pass a basket name, the payment is internalized using `basket insertion` protocol. This makes the output visible via `listOutputs` and stores derivation info in `customInstructions`.

```typescript
// Without a basket (uses wallet-payment internalization)
const result = await wallet.acceptIncomingPayment(incoming[0])
```

For both forms, the supplied object contributes only its message ID. Immediately
before internalization, Simple reloads the authenticated inbox and requires one
unique matching record, then uses only that fresh record's transaction, sender,
derivation, and output metadata. The message is acknowledged only after the
wallet returns `accepted: true`; a later acknowledgement failure does not undo
or misreport completed custody.

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

The identity registry is a legacy unauthenticated API that maps handles to identity keys. It is suitable only as a local/demo directory or behind an application-owned authorization layer. A public deployment must not present its mappings as verified identity.

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

| Method | Query                               | Body                   | Response                                       |
| ------ | ----------------------------------- | ---------------------- | ---------------------------------------------- |
| `GET`  | `?action=lookup&query=alice`        | —                      | `{ success, results: [{ tag, identityKey }] }` |
| `GET`  | `?action=list&identityKey=02abc...` | —                      | `{ success, tags: [{ tag, createdAt }] }`      |
| `POST` | `?action=register`                  | `{ tag, identityKey }` | `{ success }`                                  |
| `POST` | `?action=revoke`                    | `{ tag, identityKey }` | `{ success }`                                  |

Simple validates all directory responses at runtime: `success` must be the
boolean `true`, keys must be compressed public keys, timestamps must be
canonical ISO strings, collections and response bytes are bounded, and HTTP
errors, redirects, timeouts, and malformed JSON fail closed. The bundled
server additionally caps tag/query lengths, per-identity and total entries,
lookup results, and JSON request bytes. These content and resource controls do
not repair the ownership limitation described above.

Registry clients use public HTTPS with DNS-address checking and connection
pinning by default. For an intentional local/private registry, configure an
explicitly trusted transport rather than weakening the default boundary:

```typescript
const wallet = await createWallet({
  registryUrl: 'http://127.0.0.1:3000/api/identity-registry',
  registryFetch: globalThis.fetch
})
```

Treat `registryFetch` as trusted application configuration; never choose it or
its destination from request data.

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
declare const independentlyVerifiedBobKey: string // obtained through an authenticated channel

// Never pay solely from a registry match. First compare bob.identityKey with a
// key confirmed through an authenticated channel, certificate, or local trust record.
if (bob.identityKey !== independentlyVerifiedBobKey) throw new Error('Unverified recipient')
await wallet.sendMessageBoxPayment(independentlyVerifiedBobKey, 5000)

// Check inbox
const incoming = await wallet.listIncomingPayments()
for (const payment of incoming) {
  await wallet.acceptIncomingPayment(payment, 'received')
}
```
