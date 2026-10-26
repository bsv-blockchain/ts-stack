# Inscriptions Module

The inscriptions module creates OP_RETURN data inscriptions on the BSV blockchain. Each method writes data as an `OP_FALSE OP_RETURN <data>` output.

**Source:** `src/modules/inscriptions.ts`

## Default Baskets

Each inscription type has a default basket name:

| Type         | Default Basket    |
| ------------ | ----------------- |
| `text`       | `'text'`          |
| `json`       | `'json'`          |
| `file-hash`  | `'hash-document'` |
| `image-hash` | `'hash-image'`    |

## inscribeText()

```typescript
async inscribeText(
  text: string,
  opts?: { basket?: string; description?: string }
): Promise<InscriptionResult>
```

Create a text inscription on-chain.

| Parameter          | Type     | Default              | Description                                    |
| ------------------ | -------- | -------------------- | ---------------------------------------------- |
| `text`             | `string` | _required_           | Text content to inscribe (maximum 1 MiB UTF-8) |
| `opts.basket`      | `string` | `'text'`             | Basket to store the output                     |
| `opts.description` | `string` | `'Text inscription'` | Transaction description                        |

**Returns:** [`InscriptionResult`](types.md#inscriptionresult)

```typescript
const result = await wallet.inscribeText('Hello blockchain!')
// { txid: '...', type: 'text', dataSize: 17, basket: 'text' }
```

## inscribeJSON()

```typescript
async inscribeJSON(
  data: object,
  opts?: { basket?: string; description?: string }
): Promise<InscriptionResult>
```

Serialize an object to JSON and inscribe it on-chain. Serialization and the 1 MiB UTF-8 size check complete before the wallet is called, so unsupported data cannot produce a transaction followed by a local reporting error.

| Parameter          | Type     | Default              | Description                      |
| ------------------ | -------- | -------------------- | -------------------------------- |
| `data`             | `object` | _required_           | Object to serialize and inscribe |
| `opts.basket`      | `string` | `'json'`             | Basket to store the output       |
| `opts.description` | `string` | `'JSON inscription'` | Transaction description          |

**Returns:** [`InscriptionResult`](types.md#inscriptionresult)

**Throws:** `TypeError` if the value is not JSON serializable, or `RangeError` if the encoded JSON exceeds 1 MiB.

```typescript
const result = await wallet.inscribeJSON({ title: 'Document', version: 1 })
// { txid: '...', type: 'json', dataSize: 33, basket: 'json' }
```

## inscribeFileHash()

```typescript
async inscribeFileHash(
  hash: string,
  opts?: { basket?: string; description?: string }
): Promise<InscriptionResult>
```

Inscribe a SHA-256 file hash on-chain.

| Parameter          | Type     | Default                   | Description                   |
| ------------------ | -------- | ------------------------- | ----------------------------- |
| `hash`             | `string` | _required_                | 64-character hex SHA-256 hash |
| `opts.basket`      | `string` | `'hash-document'`         | Basket to store the output    |
| `opts.description` | `string` | `'File hash inscription'` | Transaction description       |

**Returns:** [`InscriptionResult`](types.md#inscriptionresult)

**Throws:** `Error` if hash is not a valid 64-character hex string.

```typescript
const result = await wallet.inscribeFileHash('a1b2c3d4...') // 64 hex chars
// { txid: '...', type: 'file-hash', dataSize: 64, basket: 'hash-document' }
```

## inscribeImageHash()

```typescript
async inscribeImageHash(
  hash: string,
  opts?: { basket?: string; description?: string }
): Promise<InscriptionResult>
```

Inscribe a SHA-256 image hash on-chain.

| Parameter          | Type     | Default                    | Description                   |
| ------------------ | -------- | -------------------------- | ----------------------------- |
| `hash`             | `string` | _required_                 | 64-character hex SHA-256 hash |
| `opts.basket`      | `string` | `'hash-image'`             | Basket to store the output    |
| `opts.description` | `string` | `'Image hash inscription'` | Transaction description       |

**Returns:** [`InscriptionResult`](types.md#inscriptionresult)

**Throws:** `Error` if hash is not a valid 64-character hex string.

```typescript
const result = await wallet.inscribeImageHash('e5f6a7b8...') // 64 hex chars
// { txid: '...', type: 'image-hash', dataSize: 64, basket: 'hash-image' }
```

## Implementation Notes

All inscription methods use `send()` internally with a single OP_RETURN output:

```typescript
core.send({
  outputs: [{ data: [text], basket, description }],
  description
})
```

This creates an `OP_FALSE OP_RETURN <data>` script with 0 satoshis. The output is tracked in the specified basket and can be queried via `listOutputs()`.

`dataSize` is the exact UTF-8 byte count written to the output, not JavaScript string length.
