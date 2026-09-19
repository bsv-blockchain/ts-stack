---
id: eqc
title: '@bsv/eqc'
kind: package
domain: overlays
npm: '@bsv/eqc'
version: '0.1.0'
last_updated: '2026-09-19'
last_verified: '2026-09-19'
review_cadence_days: 30
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/eqc'
status: experimental
tags: ['overlay', 'message-box', 'payments', 'brc-178', 'brc-136']
---

# @bsv/eqc

> Economic Query Client for BRC-178 race-settled collection markets: hosts compete to answer a query and the client pays the fastest that agree.

## Install

```bash
npm install @bsv/eqc @bsv/sdk
```

## Quick start

```ts
import { EQC } from '@bsv/eqc'

const eqc = new EQC(wallet)
const answer = await eqc.lookup({ service: 'ls_example', query: { key: 'value' } })
```

```ts
import { createEconomicQueryHost, overlayLookupProvider } from '@bsv/eqc/host'

createEconomicQueryHost({ wallet, providers: [overlayLookupProvider({ engine })] }).mount(router)
```

The host `wallet` internalizes payouts, so it needs a storage provider. On `@bsv/overlay-express`, do not pass the `wallet` a `registerRouter` factory receives: that is the BRC-103 authentication wallet, which has no storage provider and cannot create or internalize actions. Build a storage-backed wallet from the same root key as the node, so its identity equals the BRC-103 session key and the SLAP-advertised key:

```ts
const hostWallet = await buildStorageBackedWallet(serverPrivateKey)

server.registerRouter('/', ({ engine }) => {
  const router = express.Router()
  createEconomicQueryHost({
    wallet: hostWallet,
    providers: [overlayLookupProvider({ engine })]
  }).mount(router)
  return router
})
```

`buildStorageBackedWallet` is a function the operator supplies.

## What it provides

- **`EQC`** — discovers hosts from SLAP trackers, fans one BRC-103 authenticated query out to all of them, ranks BRC-77 attestations by local arrival time, pays the top `K` hosts that attested the same content hash from one Fibonacci-weighted BRC-29 transaction, and returns bytes whose hash it verified.
- **`@bsv/eqc/host`** — `GET /economic/params`, `POST /economic/query`, and `POST /economic/collect` handlers with providers for overlay lookups, message box listings, and arbitrary byte reads.
- **Protocol core** — canonical JSON query identifiers, canonical payload encodings, wallet-based BRC-77 signatures, and the payout split.

## How the market works

1. Discovery is free: an `ls_slap` lookup on the ordinary `/lookup` route names the hosts.
2. Every host attests a content hash. The client stamps each arrival with its own clock.
3. When at least `threshold` hosts attest one hash, the client pays the fastest `topK` of them. Below the threshold nobody is paid and no wallet call is made.
4. Each paid host receives the transaction in a collect request, internalizes its own output, and returns the bytes.

A host that withholds data from its peers ends up alone with its hash and earns nothing. For overlay lookups, attestations carry BRC-136 topic anchors, and the result reports whether the winning hosts agree on the topic's confirmed history.

## Operational and security notes

- The default minimum fee is 1000 satoshis and the default budget is 2000 satoshis per query.
- The client pays when it dispatches collect requests; loss is bounded by `maxFeeSats` per query, and hosts that take payment without delivering are excluded for ten minutes.
- The threshold counts identity keys, not operators. Identity keys are free: a tracker, or anyone who publishes SLAP tokens, can mint `threshold` keys that agree on a fabricated answer. For reads that carry value, pin the hosts you trust with `hostOverrides`.
- Every identity key a SLAP token advertises for a URL is kept, and the host's BRC-103 session key must be one of them. A third party's token cannot evict an honest host, and a mismatch skips the host for that query without a cooldown.
- The transport never pays HTTP 402 challenges and never answers a host's certificate request: the wallet it authenticates with forwards only `getPublicKey`, `createSignature`, `verifySignature`, `createHmac`, and `verifyHmac`.
- Authenticated responses are buffered by `AuthFetch` before this package can apply its 16 MiB cap, and cannot be cancelled. This is an `@bsv/sdk` limitation; `maxHosts` and `hostTimeoutMs` bound the exposure.
- A host is held to the fee it quoted: at rank `i` of `k` it requires `floor(quotedFeeSats × weight(i) / S)`, so the enforceable minimum per delivery is `max(minPayoutSats, share at rank K of K)`, not `floorFeeSats`. The advertised `topK` is the largest a host accepts.
- A host attests only answers whose estimated encoded delivery fits `maxPayloadBytes` (default 2 MiB). Keep it below the response limit of the server the routes are mounted on; the default fits the smallest `@bsv/overlay-express` profile (4 MiB).
- A host wallet that throws while internalizing is logged with the query ID, rank, client key, and payout `txid`, and the collect answers 500 rather than 402.
- BEEF returned with an overlay lookup is outside the content hash and must be verified by SPV.
- Message box servers cannot yet serve this market from several hosts; see the design document.

## Reference

- [Design and protocol decisions](../../superpowers/specs/2026-09-18-eqc-brc178-design.md)
- [BRC-178](https://bsv.brc.dev/overlays/0178), [BRC-136](https://bsv.brc.dev/overlays/0136)
- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/eqc#readme)
