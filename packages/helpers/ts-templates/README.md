# BSV Script Templates

BSV BLOCKCHAIN | Script Templates

A collection of script templates for use with the official BSV TypeScript SDK

## Overview

The goal of this repository is to provide a place where developers from around the ecosystem can publish all manner of script templates, without needing to update the core library. We're generally neutral and unbiased about what people contribute, so feel free to contribute and see what people do with your cool idea!

## Using

You can write code like this:

```ts
import { Transaction } from '@bsv/sdk'
import { OpReturn } from '@bsv/templates'

// Then, just use your template with the SDK!
const instance = new OpReturn()
const tx = new Transaction()
tx.addOutput({
  lockingScript: OpReturn.lock(...),
  satoshis: ...
})
```

## Current Templates

| Name                                    | Description                                           |
| --------------------------------------- | ----------------------------------------------------- |
| [Bsv21Binary](./src/Bsv21Binary.ts)     | Lock and decode BRC-162 (BSV-21 binary) token outputs |
| [OpReturn](./src/OpReturn.ts)           | Tag data in a non-spendable script                    |
| [Metant](./src/Metanet.ts)              | Create transactions that follow the Metanet protocol  |
| [MultiPushDrop](./src/MultiPushDrop.ts) | Create data tokens with multiple trusted owners       |
| [P2MSKH](./src/P2MSKH.ts)               | Spend with an M-of-N public-key threshold             |
| [R1K1Wallet](./src/R1K1Wallet.ts)       | Use P-256 hardware normally and a K1 recovery key     |

### Signing trust boundary

Signing templates validate the source transaction ID, output index, satoshi
amount, locking script, sequence, and signature scope before requesting a
wallet signature. When both a complete source transaction and explicit source
metadata are supplied, they must agree exactly. Treat validation failures as a
source-provenance or transaction-construction error; do not retry by discarding
one of the conflicting values.

`MultiPushDrop` signs only its complete canonical contract shape and supports
at most 120 distinct compressed locking keys. Its documented trusted-owner
model still applies: any one owner can spend or destroy the token.

`P2MSKH` signs only when the ordered public-key list hashes to the commitment in
the source locking script and the wallet-derived signing key belongs to that
list. Preserve the same ordered list while gathering incremental signatures;
an address, key list, or partial unlocking script from an untrusted party is
validated but is not itself proof that the intended payment policy is safe.

### BRC-162 tokens: `Bsv21Binary`

`Bsv21Binary` builds and reads [BRC-162](https://brc.dev/162) (BSV-21 binary)
token outputs. A token output is a fixed prefix on an ordinary locking script:

```
<token id | OP_0> <amount> OP_2DROP [<payload> OP_DROP] OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG
```

```ts
import { PrivateKey } from '@bsv/sdk'
import { Bsv21Binary, encodeStrictCbor, tokenIdFromString, tokenIdToString } from '@bsv/templates'

const owner = PrivateKey.fromRandom()
const pubKeyHash = owner.toPublicKey().toHash() as number[]

// A deploy output has a null token id; its payload is a strict-CBOR map.
const template = new Bsv21Binary()
const deployScript = template.lock(null, 0n, pubKeyHash, encodeStrictCbor({ sym: 'USD', dec: 2n }))
console.log(Bsv21Binary.decode(deployScript).role) // 'deploy'

// Later outputs name the token by `<deploy txid, 64 lowercase hex>_0`.
const tokenId = `${'ab'.repeat(32)}_0`
const lockingScript = template.lock(tokenId, 1_000_000n, pubKeyHash) // amounts are bigint

const decoded = Bsv21Binary.decode(lockingScript)
console.log(decoded.role) // 'value' ('authority' when the amount is 0n)
console.log(decoded.amount) // 1000000n
console.log(decoded.tokenId !== undefined && tokenIdToString(decoded.tokenId) === tokenId) // true
console.log(tokenIdFromString(tokenId).length) // 32 wire bytes, natural order
```

Every value has exactly one accepted encoding, so every engine that reads the
same bytes reads the same token output:

- **Token id:** a direct push of exactly 32 bytes (the deploy txid in natural
  byte order), or `OP_0` on a deploy. `OP_PUSHDATA*` is not accepted.
- **Amount:** `bigint`, `0` to `2^64 - 1`. `0` is `OP_0`, `1` to `16` are
  `OP_1` to `OP_16`, anything larger is a direct push (`0x01` to `0x09`) of the
  minimal little-endian script number. Policy caps below `2^64 - 1`, aggregate
  arithmetic and conservation across inputs and outputs belong to the caller.
- **Role:** `deploy` (no id), `authority` (id, amount `0`) or `value`.
- **Invalid vs. not a token:** `isTokenShaped(script)` tells a script that
  starts `<push> <push> OP_2DROP` from any other script. `Bsv21Binary.decode`
  throws `Bsv21BinaryError` for a token-shaped script that is not canonical
  (for example amount `5` pushed as `01 05`), so it is never silently read as
  "not a token".

### Strict CBOR payloads

Payload attributes are read from a small, dependency-free subset of
[DAG-CBOR](https://ipld.io/specs/codecs/dag-cbor/spec/), so two decoders cannot
read different attributes from the same bytes. `encodeStrictCbor` writes it,
`decodeStrictCbor` throws `StrictCborError` and `tryDecodeStrictCbor` returns
`undefined` for anything outside it:

- the top level is a map with text keys, strictly increasing by encoded bytes
  (no duplicates);
- values are unsigned integers up to `2^64 - 1` (`bigint`), byte strings
  (`Uint8Array`), strict UTF-8 text, `null`, booleans and nested maps;
- headers are definite and minimal-length;
- nesting depth is at most `STRICT_CBOR_MAX_DEPTH` (4), the encoding is at most
  `STRICT_CBOR_MAX_BYTES` (4096) and there are no trailing bytes.

Floats, tags (including 42), negative integers, arrays and indefinite lengths
are refused.

Version 2.0.0 removes `MandalaToken`, `MandalaAdmin` and `ADMIN_PROTOCOL`;
BRC-162 `Bsv21Binary` outputs replace them and are not wire-compatible.

### R1-K1 hardware wallet

`R1K1Wallet` commits to `HASH160(compressedR1PublicKey || privateSalt)` and a
separate secp256k1 public-key hash. The salt hides reuse of a PIV public key
until an R1 spend reveals both values. Keep every 32-byte salt backed up with
the wallet metadata; losing it disables that output's R1 path but not K1
recovery.

```ts
import { Hash, type PrivateKey, Utils } from '@bsv/sdk'
import { R1K1Wallet } from '@bsv/templates'

declare const compressedP256PublicKeyHex: string
declare const k1RecoveryPrivateKey: PrivateKey
declare const signWithYubiKeyPiv: (digest: Uint8Array) => Promise<Uint8Array>

const template = new R1K1Wallet()
const r1PublicKey = Utils.toArray(compressedP256PublicKeyHex, 'hex')
const salt = crypto.getRandomValues(new Uint8Array(32))
const lockingScript = await template.lock(
  Hash.hash160([...r1PublicKey, ...salt]),
  Hash.hash160(k1RecoveryPrivateKey.toPublicKey().encode(true) as number[])
)

const normalSpend = template.unlock({
  path: 'r1',
  publicKey: r1PublicKey,
  salt,
  // Submit this 32-byte digest unchanged to PIV GENERAL AUTHENTICATE.
  // Return the YubiKey DER ECDSA signature (or raw 64-byte r || s).
  signDigest: digest => signWithYubiKeyPiv(digest)
})

const recoverySpend = template.unlock({
  path: 'k1',
  privateKey: k1RecoveryPrivateKey
})
```

The synthesized P-256 verifier produces a 959,632-byte locking script after
constructor commitments are baked. This exceeds common 500 KB miner policy;
confirm the target miner's limits before funding an output.

An R1 unlocking script also pushes the BIP-143 preimage, whose `scriptCode`
contains roughly 960 KB of the contract after `OP_CODESEPARATOR`. The R1 path
therefore involves about 2 MB of locking-plus-unlocking script material, and
the witness alone adds roughly 960 KB to the spending transaction. Account for
the resulting fees and confirm any maximum-transaction policy; `estimateLength`
includes this preimage push. The K1 unlocking script remains small.

PIV proves that the hardware key signed the supplied digest, but a YubiKey
does not display or independently validate the Bitcoin transaction. A PIN or
touch policy protects key use, not transaction intent; review transactions on
a trusted host before approving them.

## Contribution Guidelines

We're always looking for contributors to add the coolest new templates. Whatever kinds of scripts you come up with - all contributions are welcome.

1. **Fork & Clone**: Fork this repository and clone it to your local machine.
2. **Set Up**: Run `npm i` to install all dependencies.
3. **Make Changes**: Create a new branch and make your changes.
4. **Test**: Ensure all tests pass by running `npm test`.
5. **Commit**: Commit your changes and push to your fork.
6. **Pull Request**: Open a pull request from your fork to this repository.
   For more details, check the
   [repository contribution guidelines](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md).

For information on past releases, check out the [changelog](./CHANGELOG.md). For future plans, check the [roadmap](./ROADMAP.md)!

## Support & Contacts

Project Owners: Ty Everett

Development Team Lead: Ty Everett

For questions, bug reports, or feature requests, please open an issue on GitHub or contact us directly.

## License

Current TS Stack changes are licensed under the Open BSV License Version 6; see
[LICENSE.txt](./LICENSE.txt). This package also retains pre-uniformization code
under the Open BSV License Version 4. Redistributors must preserve
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and the applicable text in
[`LICENSES/`](./LICENSES/).

Thank you for being a part of the BSV Blockchain Script Templates Project. Let's build the future of BSV Blockchain together!
