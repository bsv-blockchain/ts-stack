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
- signed Assets, Offers, Demands, readiness leases, destination Authorizations,
  transaction evidence, Delivery acknowledgements, Licenses, Authorities, and
  receipts;
- explicit BRC-29/BRC-100 multilateral payment construction that matches
  finalized wallet outputs without assuming output order;
- deterministic-CBOR Fetch client/server bindings, typed acquisition builders,
  replay-safe Payee receipt handling, authorized-output fallback and late
  retrieval, an injectable acquisition transport, and a complete multipay
  buyer workflow across independently routed Payees and providers;
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
const buyer = await LCHMultipayBuyer.create(wallet, { endpointPolicy })
const request = await buyer.createRequest({
  offerId,
  assetId,
  action: 'play',
  selection: { type: 'all' },
  acceptedPolicyDigest,
  createdAt: BigInt(Math.floor(Date.now() / 1000))
})
const plan = await buyer.quote(acquisitionEndpoint, request, issuerIdentity)

// Display plan.totalSatoshis, plan.demands, action, Selection, and terms first.

// Application UI must obtain consent before this boundary.
const funded = await buyer.createPayment(plan)
await durableRecoveryStore.put(funded)

const receipts = []
const authorizedOutputs = []
for (const delivery of funded.deliveries) {
  const proof = await buyer.settleDelivery(funded, delivery)
  if (proof.type === 'receipt') receipts.push(proof.receipt)
  else authorizedOutputs.push(proof.evidence)
}
const license = await buyer.complete(funded, receipts, authorizedOutputs)
```

Wallets may add or reorder outputs. The implementation locates every Demand
output after finalization by its exact locking script and satoshi amount, and
fails if a match is missing or ambiguous. Retain `funded`, Receipts,
Authorizations, and provider evidence until completion or `recoveryUntil`;
retry with the same transaction after ambiguity and never create a replacement
automatically.

The issuer endpoint coordinates Quote, completion, and recovery. Every signed
Demand selects its own Payee endpoint and settlement profile.
`receipt-complete-v1` requires Payee wallet internalization and a Receipt.
`authorized-output-v1` permits a Payee to sign its exact BRC-29 destination,
accepted-transaction provider, and durable Delivery provider before payment.
The fallback releases a License only after all signed evidence verifies; the
Payee later retrieves and internalizes the same Delivery. Those endpoints can
be different origins and operators. `LCHAcquisitionTransport` defaults to the HTTP binding and
also gives applications a stable seam for an asynchronous inbox or message-box
adapter without changing signed objects or recovery behavior.

On the receiving side, `WalletPaymentReceiver` independently derives and
validates the Payee's BRC-29 output, atomically claims the Demand through a
`PaymentLedger`, calls that Payee wallet's BRC-100 `internalizeAction`, and
returns a signed Receipt. `LCHHttpServer` mounts that and the issuer handlers on
independent Fetch-compatible server surfaces. `WalletAuthorizedOutputPayee`
and `LCHSettlementService` expose the opt-in provider roles. Silence, a
finalized transaction, insufficient retention, or an unknown evidence policy
never satisfies a Demand. The executable reference
application also ships a Node server, creator wizard, player, wallet-module
contract, and collapsed, federated, container, and durable deployment examples.

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
than once. Trimming, time-warping, reversal, distortion, mixing, spatial
placement, and other editorial operations can be described in non-critical
application or C2PA metadata without changing permission or settlement
semantics. Whole placement conservatively activates the ingredient's complete
declared source selection. A separately registered critical mapping profile is
needed only for deterministic selective mapping or proportional allocation; a
consumer that does not implement one must fail closed.

Integer time windows are half-open: `notBefore` is inclusive and `notAfter` is
exclusive. Fractional edit values such as playback rates use exact integer
ratios because deterministic LCH CBOR prohibits floats.

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
- Keep the scoped `THIRD_PARTY_NOTICES.md` in the npm artifact. The package
  incorporates no third-party source and the authorized-output profile adds no
  dependency; peer packages retain their own notices.
- Prefer receipt-complete when a Payee does not accept disclosure of its exact
  destination, dependence on named providers, accepted-before-mined evidence,
  or License release before wallet internalization.
- Treat ODRL/C2PA mappings as evidence and policy description, not as a
  substitute for payment settlement or authority validation.

## Reference

- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/content/lch#readme)
- [Draft BRC-170 proposal](https://github.com/bsv-blockchain/BRCs/pull/236)
- [Reference application](https://github.com/bsv-blockchain/ts-stack/tree/main/apps/lch-reference)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/content/lch)
