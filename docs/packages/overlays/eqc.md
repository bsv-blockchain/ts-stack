---
id: eqc
title: '@bsv/eqc'
kind: package
domain: overlays
npm: '@bsv/eqc'
version: '0.1.0'
last_updated: '2026-09-18'
last_verified: '2026-09-18'
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
- The transport never pays HTTP 402 challenges.
- BEEF returned with an overlay lookup is outside the content hash and must be verified by SPV.
- Message box servers cannot yet serve this market from several hosts; see the design document.

## Reference

- [Design and protocol decisions](../../superpowers/specs/2026-09-18-eqc-brc178-design.md)
- [BRC-178](https://bsv.brc.dev/overlays/0178), [BRC-136](https://bsv.brc.dev/overlays/0136)
- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/eqc#readme)
