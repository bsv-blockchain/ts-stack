# Payments

## Simple Payment

Send BSV to a recipient using their identity key:

```typescript
const result = await wallet.pay({
  to: recipientIdentityKey,
  satoshis: 1000
})

console.log('TXID:', result.txid)
```

The `pay()` method uses `PeerPayClient.sendPayment()` from `@bsv/message-box-client` under the hood, which constructs and delivers a BRC-29 payment to the counterparty in a single call.

## Multi-Output Send

The `send()` method is the core primitive that lets you combine multiple output types in a single transaction.

### Output Routing Rules

| Fields | Output Type | Satoshis |
|--------|------------|----------|
| `to` only | P2PKH payment | Must be > 0 |
| `data` only | OP_RETURN inscription | Always 0 |
| `to` + `data` | PushDrop token | Must be >= 1 |

### Example: Three Output Types in One Transaction

```typescript
const result = await wallet.send({
  outputs: [
    // P2PKH payment
    { to: recipientKey, satoshis: 1000, basket: 'payments' },

    // OP_RETURN data
    { data: ['Hello blockchain!'], basket: 'text' },

    // PushDrop token
    {
      to: wallet.getIdentityKey(),
      data: [{ type: 'receipt', amount: 1000 }],
      satoshis: 1,
      basket: 'receipts'
    }
  ],
  description: 'Payment with receipt'
})

// Check what was created
for (const detail of result.outputDetails) {
  console.log(`Output #${detail.index}: ${detail.type} (${detail.satoshis} sats)`)
}
// Output #0: p2pkh (1000 sats)
// Output #1: op_return (0 sats)
// Output #2: pushdrop (1 sats)
```

### Data Fields

The `data` array in output specs accepts multiple types:

```typescript
{ data: ['text string'] }                        // String → UTF-8 bytes
{ data: [{ key: 'value' }] }                     // Object → JSON string → UTF-8 bytes
{ data: [[0x48, 0x65, 0x6c, 0x6c, 0x6f]] }     // number[] → raw bytes
{ data: ['field1', { field2: true }, [0x00]] }   // Mixed types
```

## Funding a Server Wallet

See the [Server Wallet Guide](server-wallet.md) for the complete funding flow.

```typescript
// Get payment request from server
const res = await fetch('/api/server-wallet?action=request')
const { paymentRequest } = await res.json()

// Fund using browser wallet
const result = await wallet.fundServerWallet(
  paymentRequest,
  'server-funding'
)
```

## PaymentOptions Reference

```typescript
interface PaymentOptions {
  to: string              // Recipient identity key (required)
  satoshis: number        // Amount in satoshis (required)
  memo?: string           // Optional memo
  description?: string    // Transaction description
}
```

## TransactionResult Reference

```typescript
interface TransactionResult {
  txid: string            // Transaction ID
  tx: any                 // Raw transaction bytes (AtomicBEEF)
  outputs?: OutputInfo[]  // Output details
}
```
