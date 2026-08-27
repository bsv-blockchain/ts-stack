---
id: lch
title: '@bsv/lch'
kind: package
domain: content
npm: '@bsv/lch'
version: '0.1.0'
last_updated: '2026-08-27'
last_verified: '2026-08-27'
review_cadence_days: 30
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/content/lch'
status: experimental
tags: ['content', 'licensing', 'brc-170', 'odrl', 'c2pa', 'chirp', 'uhrp']
---

# @bsv/lch

> Browser- and Node-compatible reference implementation of the draft BRC-170
> Licensed Content Header protocol.

## Install

```bash
npm install @bsv/lch @bsv/sdk
# Add @bsv/chirp when using chirp: ciphertext locators.
```

## What it provides

- strict deterministic CBOR, typed object identifiers, and `.lch` framing;
- segmented AES-256-GCM with authenticated range decryption and key periods;
- BRC-77 public signatures and BRC-78 peer-specific key envelopes;
- signed Assets, Offers, Demands, Quotes, Licenses, Authorities, and receipts;
- explicit BRC-29/BRC-100 multilateral payment construction that matches
  finalized wallet outputs without assuming output order;
- bounded authority chains with fresh, network-scoped revocation observations;
- HTTPS endpoint policy plus UHRP and CHIRP content source and sink adapters;
- browser IndexedDB and in-memory license stores; and
- whole-placement composition records with cycle and depth checks.

## Acquisition is explicit

Reading a header never spends money. Applications inspect an Offer, preflight
the exact selection and price, show a user confirmation, ask the wallet to
construct payment, deliver the Demand and remittance to the Payee, then store
the returned signed License and key grants. Recovery is available for the
Offer's exact declared recovery period.

```typescript
const acquisition = issuer.preflight(offer, {
  selection: { type: 'all' },
  units: 1n
})

// Application UI must obtain consent before this boundary.
const payment = await createMultipayTransaction(wallet, acquisition.demands)
const license = await deliverDemand(payment)
await licenseStore.put(license)
```

Wallets may add or reorder outputs. The implementation locates every Demand
output after finalization by its exact locking script and satoshi amount, and
fails if a match is missing or ambiguous.

## Storage and media

`UniversalContentSource` resolves `chirp:`, `uhrp:`, and bounded HTTPS
locators. `CHIRPContentSink` and `UHRPContentSink` publish encrypted bytes
through the existing storage libraries. No LCH API changes the existing UHRP
uploader, downloader, routes, or identifiers.

Media players and DAWs remain application code. The package supplies verified
bytes and selection/composition semantics; it does not choose codecs, decode
media, draw waveforms, build catalogues, or define recommendation behavior.

## Composition boundary

The core profile supports repeated whole-placement ingredients. Each placement
is independently attributable even when the same source asset appears more
than once. Trim, stretch, mix weighting, spatial placement, timeline edits,
dataset batching, and derivative royalty allocation need separately registered
critical profiles. A consumer that does not implement a claimed mapping profile
must fail closed.

Training alone does not create a composition claim. A creator may identify
specific source works individually; dataset roots and batch attestations remain
future profiles.

## Security notes

- Verify every signed object and recompute every identifier before use.
- Reject stale, unknown, wrong-network, spent, or reorg-affected revocation
  observations.
- Permit local HTTP endpoints only through an explicit development override.
- Resolve DNS again for redirects and connections, and use the endpoint
  policy's address-pinning connector to prevent rebinding; do not forward
  credentials across origins.
- Authenticate every segment before exposing plaintext. Whole-asset grants
  must include every key period intersecting the licensed selection.
- Treat ODRL/C2PA mappings as evidence and policy description, not as a
  substitute for payment settlement or authority validation.

## Reference

- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/content/lch#readme)
- [Draft BRC-170 proposal](https://github.com/bsv-blockchain/BRCs/pull/236)
- [Reference application](https://github.com/bsv-blockchain/ts-stack/tree/main/apps/lch-reference)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/content/lch)
