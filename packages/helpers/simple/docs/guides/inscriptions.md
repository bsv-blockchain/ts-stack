# Inscriptions

Inscriptions write data permanently to the blockchain using OP_RETURN outputs. They cost 0 satoshis (beyond the transaction fee) and are immutable once confirmed.

## Text Inscription

```typescript
const result = await wallet.inscribeText('Hello blockchain!')

console.log('TXID:', result.txid)
console.log('Type:', result.type)       // 'text'
console.log('Size:', result.dataSize)   // 17
console.log('Basket:', result.basket)   // 'text'
```

## JSON Inscription

```typescript
const result = await wallet.inscribeJSON({
  title: 'My Document',
  author: 'Alice',
  created: Date.now()
})

console.log('Type:', result.type)       // 'json'
console.log('Basket:', result.basket)   // 'json'
```

## File Hash Inscription

Inscribe a SHA-256 hash of a file for proof-of-existence:

```typescript
// Compute the hash (browser example)
const buffer = await file.arrayBuffer()
const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
const hash = Array.from(new Uint8Array(hashBuffer))
  .map(b => b.toString(16).padStart(2, '0'))
  .join('')

// Inscribe the hash
const result = await wallet.inscribeFileHash(hash)

console.log('Type:', result.type)       // 'file-hash'
console.log('Basket:', result.basket)   // 'hash-document'
```

The hash must be a 64-character hexadecimal string (SHA-256). The method validates the format and throws if invalid.

## Image Hash Inscription

Same as file hash, but stored in a separate basket for organization:

```typescript
const result = await wallet.inscribeImageHash(imageHash)

console.log('Type:', result.type)       // 'image-hash'
console.log('Basket:', result.basket)   // 'hash-image'
```

## Custom Baskets

All inscription methods accept an optional basket override:

```typescript
await wallet.inscribeText('Hello!', { basket: 'my-custom-basket' })
await wallet.inscribeJSON(data, { basket: 'documents', description: 'Contract v1' })
```

## Default Baskets

| Method | Default Basket |
|--------|---------------|
| `inscribeText()` | `'text'` |
| `inscribeJSON()` | `'json'` |
| `inscribeFileHash()` | `'hash-document'` |
| `inscribeImageHash()` | `'hash-image'` |

## InscriptionResult

```typescript
interface InscriptionResult {
  txid: string           // Transaction ID
  tx: number[]           // Raw transaction bytes
  type: InscriptionType  // 'text' | 'json' | 'file-hash' | 'image-hash'
  dataSize: number       // Size of the inscribed data in bytes
  basket: string         // Basket the inscription was stored in
  outputs: OutputInfo[]  // Output details
}
```

## Under the Hood

Inscriptions use the `send()` method internally with a `data`-only output:

```typescript
// inscribeText('Hello!') is equivalent to:
await wallet.send({
  outputs: [{ data: ['Hello!'], basket: 'text' }]
})
```

The output script is: `OP_FALSE OP_RETURN <data_bytes>`
