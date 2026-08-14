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

| Name                                    | Description                                          |
| --------------------------------------- | ---------------------------------------------------- |
| [OpReturn](./src/OpReturn.ts)           | Tag data in a non-spendable script                   |
| [Metant](./src/Metanet.ts)              | Create transactions that follow the Metanet protocol |
| [MultiPushDrop](./src/MultiPushDrop.ts) | Create data tokens with multiple trusted owners      |
| [P2MSKH](./src/P2MSKH.ts)               | Spend with an M-of-N public-key threshold            |
| [R1K1Wallet](./src/R1K1Wallet.ts)       | Use P-256 hardware normally and a K1 recovery key    |

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

The license for the code in this repository is the Open BSV License. Refer to [LICENSE.txt](./LICENSE.txt) for the license text.

Thank you for being a part of the BSV Blockchain Script Templates Project. Let's build the future of BSV Blockchain together!
