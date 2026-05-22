# @bsv/did-client

[![npm version](https://img.shields.io/npm/v/@bsv/did-client)](https://www.npmjs.com/package/@bsv/did-client)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/did-client)](https://www.npmjs.com/package/@bsv/did-client)

Client library for the BSV Decentralized Identifier (DID) overlay. Mint, resolve, and revoke DID tokens that anchor a serial number to a subject's identity key, broadcast as PushDrop outputs through the `tm_did` topic manager and queried via the `ls_did` lookup service.

## Install

```bash
npm install @bsv/did-client
```

Peer dependency: `@bsv/sdk`.

## Quick start

```ts
import { DIDClient } from '@bsv/did-client'

const client = new DIDClient({ networkPreset: 'mainnet' })

// Mint a DID token bound to the subject's public key.
const result = await client.createDID(
  'serial-123',                                           // serialNumber
  '02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc' // subject pubkey
)

// Look it up later.
const records = await client.findDID({ serialNumber: 'serial-123' })

// Revoke.
await client.revokeDID({ serialNumber: 'serial-123' })
```

## Use cases

### Issue a DID for a newly enrolled user

```ts
const client = new DIDClient()
await client.createDID(user.serial, user.pubKey)
```

### Resolve a DID record by serial number

```ts
const [record] = await client.findDID({ serialNumber: 'serial-123', limit: 1 })
if (record) console.log(record.subject, record.serialNumber)
```

### Revoke a stale or compromised DID token

```ts
await client.revokeDID({ serialNumber: 'serial-123' })
```

## Configuration

```ts
const client = new DIDClient({
  overlayTopic: 'tm_did',          // default
  overlayService: 'ls_did',        // default
  networkPreset: 'mainnet',        // 'mainnet' | 'testnet' | 'local'
  wallet: myWallet,                // optional, defaults to new WalletClient()
  acceptDelayedBroadcast: false,   // default
})
```

## API

| Method | Purpose |
|--------|---------|
| `createDID(serialNumber, subject, opts?)` | Mints a new DID token via PushDrop and broadcasts it to the DID overlay |
| `findDID(query)` | Looks up DID records by serial number, outpoint, date range, etc. |
| `revokeDID(opts)` | Spends an existing DID UTXO, removing it from the overlay |

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
