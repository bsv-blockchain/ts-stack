# Overlay Networks

Overlay networks let you broadcast transactions to topic-specific services and query lookup services for data. `@bsv/simple` wraps the BSV SDK's `TopicBroadcaster` and `LookupResolver` into a clean API.

## Core Concepts

| Concept | Prefix | Description |
|---------|--------|-------------|
| **Topic** | `tm_` | A category of transactions (e.g., `tm_payments`, `tm_tokens`) |
| **Lookup Service** | `ls_` | A query endpoint for finding data (e.g., `ls_payments`) |
| **SHIP** | — | Protocol for advertising topic hosting |
| **SLAP** | — | Protocol for advertising lookup services |

> **Important:** Topics must start with `tm_` and lookup services must start with `ls_`. The library enforces these prefixes and throws if they're missing.

## Creating an Overlay

```typescript
import { Overlay } from '@bsv/simple/browser'

const overlay = await Overlay.create({
  topics: ['tm_payments', 'tm_tokens'],
  network: 'mainnet'
})
```

### Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `topics` | `string[]` | *required* | Topics to broadcast to (must start with `tm_`) |
| `network` | `string` | `'mainnet'` | `'mainnet'`, `'testnet'`, or `'local'` |
| `slapTrackers` | `string[]` | SDK default | Custom SLAP tracker URLs |
| `hostOverrides` | `Record<string, string[]>` | — | Override hosts for specific topics |
| `additionalHosts` | `Record<string, string[]>` | — | Add extra hosts for specific topics |

## Managing Topics

```typescript
// Get current info
const info = overlay.getInfo()
// { topics: ['tm_payments', 'tm_tokens'], network: 'mainnet' }

// Add a topic
overlay.addTopic('tm_invoices')

// Remove a topic
overlay.removeTopic('tm_tokens')
```

## Broadcasting

Submit a pre-built transaction to overlay topics:

```typescript
import { Transaction } from '@bsv/sdk'

const tx = Transaction.fromAtomicBEEF(txBytes)
const result = await overlay.broadcast(tx)

if (result.success) {
  console.log('Broadcast TXID:', result.txid)
} else {
  console.log('Failed:', result.code, result.description)
}
```

### Broadcast to Specific Topics

```typescript
// Override the default topics for this broadcast
const result = await overlay.broadcast(tx, ['tm_payments'])
```

## Querying

### Raw Query

```typescript
const answer = await overlay.query('ls_payments', { tag: 'recent' })
console.log('Answer type:', answer.type)
```

### Get Parsed Outputs

```typescript
const outputs = await overlay.lookupOutputs('ls_payments', { tag: 'recent' })

for (const output of outputs) {
  console.log('BEEF:', output.beef.length, 'bytes')
  console.log('Output Index:', output.outputIndex)
}
```

## Wallet-Integrated Methods

### Advertise SHIP (Topic Hosting)

Tell the network that you host a specific topic at a domain:

```typescript
await wallet.advertiseSHIP(
  'https://myserver.com',
  'tm_payments',
  'ship-tokens'     // optional: basket to store the token
)
```

### Advertise SLAP (Lookup Service)

Tell the network that you provide a lookup service at a domain:

```typescript
await wallet.advertiseSLAP(
  'https://myserver.com',
  'ls_payments',
  'slap-tokens'     // optional: basket
)
```

### Broadcast Action

Create a transaction and broadcast to overlay in one step:

```typescript
const { txid, broadcast } = await wallet.broadcastAction(
  overlay,
  {
    outputs: [{
      lockingScript: scriptHex,
      satoshis: 1,
      outputDescription: 'Overlay output'
    }],
    description: 'Overlay broadcast'
  },
  ['tm_payments']   // optional: specific topics
)

console.log('TXID:', txid)
console.log('Broadcast success:', broadcast.success)
```

### Double-Spend Retry

Wrap an operation with automatic retry on double-spend:

```typescript
const result = await wallet.withRetry(async () => {
  return await wallet.broadcastAction(overlay, { outputs: [...] })
}, overlay, 3)  // max 3 retries
```

## Advanced: Raw SDK Access

For operations not covered by the simple API:

```typescript
const broadcaster = overlay.getBroadcaster()  // TopicBroadcaster
const resolver = overlay.getResolver()        // LookupResolver
```

## Complete Example

```typescript
import { createWallet, Overlay } from '@bsv/simple/browser'

const wallet = await createWallet()

// Create overlay
const overlay = await Overlay.create({
  topics: ['tm_my_app'],
  network: 'mainnet'
})

// Advertise our services
await wallet.advertiseSHIP('https://myapp.com', 'tm_my_app')
await wallet.advertiseSLAP('https://myapp.com', 'ls_my_app')

// Broadcast a transaction
const { txid, broadcast } = await wallet.broadcastAction(
  overlay,
  {
    outputs: [{ lockingScript: '...', satoshis: 1, outputDescription: 'Data' }],
    description: 'Store data in overlay'
  }
)

// Query data
const outputs = await overlay.lookupOutputs('ls_my_app', { type: 'recent' })
console.log('Found', outputs.length, 'outputs')
```
