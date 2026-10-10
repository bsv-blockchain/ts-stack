---
id: revenue-listing-profile-authority
title: 'Protected Immutable Listing Signing'
kind: guide
version: '0.1.0'
last_updated: '2026-10-06'
last_verified: '2026-10-06'
review_cadence_days: 30
status: experimental
tags: [utxo, scripts, revenue, signing, custody]
---

# Protected immutable listing signing

The optional `RevenueListingProfileAuthority` adapter implements the signing
selection for the current BRC-197 exemplar at BRC PR295 commit
`1b9a75e497b5856675af1ce01fd86843c37d07f9`. It uses a BRC-100 wallet's
`getPublicKey` and `createSignature` methods. Applications supply the independently
selected seller identity, explicit originator and synchronous authorization fence.
No private scalar crosses that interface. Other transaction domains may install
their own signing adapters; the general output architecture does not require this
exemplar.

The descriptor identifies a public identity root. Seller split and early
retirement signatures use its fixed public child: protocol `[2, '3241645161d8']`,
key ID `brc197 authority`, counterparty `anyone`. Public key lookup explicitly
sets `forSelf: true`. The root does not sign transactions or receive payouts.
Genesis authorization instead uses the BRC-77 `message signing` child with a fresh
random key ID. The older `RevenueListingAuthority` and software adapter retain
their separately documented [historical contract](./revenue-listing-authority.md).

Call the asynchronous `RevenueListingProfileAuthority.create(...)` before
allocating genesis funds. It checks the actual wallet identity and fixed child,
then requests and verifies a child signature over a fresh, domain-separated
challenge. This exercises actual protected signing rather than merely accepting
an advertised capability. It allocates no funds and creates no transaction.
A failed preflight prevents that authority from becoming usable. Wallet permission
approval remains part of the installed wallet; the adapter does not grant it.
The remaining creation preflight must also validate the pinned activation program,
all recipient child links, complete planned layout and fee/resource requirements.

```ts
import type { WalletInterface } from '@bsv/sdk'
import { RevenueListingProfileAuthority } from '@bsv/output-knowledge/revenue-listing'

declare const wallet: WalletInterface
declare const selectedSeller: string
declare const originator: string
declare function assertInstalledSigningAuthorization(): void

const authority = await RevenueListingProfileAuthority.create({
  wallet,
  identity: selectedSeller,
  originator,
  checkCurrent: assertInstalledSigningAuthorization
})
```

Approve the complete economic plan, genuine predecessor lineage, signing role
and actual funded transaction independently before calling `signTransaction`.
Pass the request returned by `RevenueListingProfileSpend.prepare(...).signingRequests()`.
Activation, purchase, proportional payout and unsigned expiry retirement produce
no seller signing request. Split and early retirement produce one input-zero
request. The adapter owns the approved preimage and digest, checks the active
program, fixed key selection and `ALL|FORKID` scope, and verifies returned
canonical low-S DER against those retained bytes. It does not normalize a
noncanonical protected result into an accepted signature.

Pass the returned lowercase DER-plus-`41` hex to `prepared.complete({ seller })`.
The funding wallet signs its own inputs separately. Recheck final layout and
execute all actual input Scripts before treating the resulting transaction as
valid. Signature verification alone does not establish current unspentness,
approved economics, asset rights, topical admission, private delivery or a License.
The [lineage and purchase verifiers](./revenue-listing-profile-lineage.md) and
installed application policy own those separate decisions.

For genesis, call `authority.signGenesis(descriptor, genesisOutpoint)` only after
independently approving the actual reserve-stage transaction. It checks seller,
chain and output zero, constructs the exact `sale-genesis` body and verifies the
returned BRC-77 authorization. Retain this packet with the exact descriptor and
transaction. The method authorizes a reference; it does not inspect the
transaction or prove its mining, activation or asset authority.

Every asynchronous wallet step checks the synchronous fence before and after
awaiting. A changed fence prevents disclosure of a result, and a fence that
accidentally returns a Promise is refused. This cannot undo a signature already
produced by a wallet while an await was pending. The wallet must enforce its own
authorization at the signing effect. The adapter does not retry, fund, finalize,
broadcast or reconcile wallet actions, and retains no cross-call approval cache.

The source includes whole-request ownership, changed identity/fence, malformed and
high-S signature, originator and generated asynchronous-port tests. Native seller
signing, creation resource preflight and all transaction routes require separate
qualification in the [alignment inventory](https://github.com/bsv-blockchain/ts-stack/blob/codex/utxo-application-runtime/specs/output-knowledge/SPEC-ALIGNMENT.md).
An export or passing type check alone is not that qualification.
