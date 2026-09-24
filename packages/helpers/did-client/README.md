# @bsv/did-client

[![npm version](https://img.shields.io/npm/v/@bsv/did-client)](https://www.npmjs.com/package/@bsv/did-client)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/did-client)](https://www.npmjs.com/package/@bsv/did-client)

Client library for the legacy BSV Decentralized Identifier (DID) overlay. Mint, resolve, and revoke PushDrop records through the `tm_did` topic manager and `ls_did` lookup service.

## Trust model and legacy wire limitation

The v1 on-chain token contains only a serial-number field and an opaque
counterparty-derived field signature. It does **not** encode the issuer or
subject. Consequently, an overlay lookup proves only that a canonical token
exists at an outpoint; it does not, by itself, prove who issued it or which
identity the serial names. Applications must establish that relationship using
an authenticated enrollment record, certificate, local trust decision, or
another independent channel. Never treat an arbitrary `findDID()` result as an
identity credential.

New tokens are locked to the issuing wallet's derived key so that the issuer
can revoke a token even when the named subject differs. Distinct-subject tokens
created by older releases used a subject-owned lock but did not persist enough
wire metadata for either party to reconstruct the documented revocation flow;
those legacy outputs require a coordinated protocol migration rather than a
client-side repair.

## Install

```bash
npm install @bsv/did-client
```

Peer dependency: `@bsv/sdk`.

## Quick start

```ts
import { DIDClient } from '@bsv/did-client'

const client = new DIDClient({ networkPreset: 'mainnet' })

// Mint a revocable issuer-owned token that names this subject out of band.
const result = await client.createDID(
  'serial-123', // serialNumber
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
if (record) console.log(record.txid, record.serialNumber)
```

### Revoke a stale or compromised DID token

```ts
await client.revokeDID({ serialNumber: 'serial-123' })
```

## Configuration

```ts
const client = new DIDClient({
  overlayTopic: 'tm_did', // default
  overlayService: 'ls_did', // default
  networkPreset: 'mainnet', // 'mainnet' | 'testnet' | 'teratestnet' | 'local'
  wallet: myWallet, // optional, defaults to new WalletClient()
  acceptDelayedBroadcast: false // default
})
```

## API

| Method                                    | Purpose                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `createDID(serialNumber, subject, opts?)` | Mints an issuer-owned legacy token and retains the subject in wallet metadata |
| `findDID(query)`                          | Looks up DID records by serial number, outpoint, date range, etc.             |
| `revokeDID(opts)`                         | Spends an existing DID UTXO, removing it from the overlay                     |

`subject` participates in wallet key derivation and is retained in the
issuer's authenticated wallet metadata, but it is not present in the v1 public
wire token. `findDID()` therefore cannot return or authenticate a subject from
the overlay alone.

## License

TS Stack first-party material is under the [Open BSV License Version 6](./LICENSE.txt).
The UMD bundle incorporates separately licensed SDK material; keep
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and [LICENSES/](./LICENSES/)
with the bundle.

## Next dependency release candidate

This candidate refreshes the packed first-party dependency ranges for the next
wallet interoperability release. It adds no independent API or wire-format
change. Adopt after the new dependency graph is published; current wallet
releases retain their existing published pins.
