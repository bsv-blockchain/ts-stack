---
id: lch
title: '@bsv/lch'
kind: package
domain: content
npm: '@bsv/lch'
version: '0.2.1'
last_updated: '2026-09-18'
last_verified: '2026-09-18'
review_cadence_days: 30
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/content/lch'
status: experimental
tags: ['content', 'licensing', 'brc-170', 'odrl', 'c2pa', 'chirp', 'uhrp']
---

# @bsv/lch

This source candidate declares SDK peer `^2.4.1 || ^3.0.0`. SDK3 remains
a coordinated proposal; see the [qualification and migration limits](../../guides/identity-did-vc-migration.md)
before adopting it.

> Browser- and Node-compatible reference implementation of published BRC-170
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
- canonical-literal and DNS-pinned HTTPS endpoint policy plus failover-capable
  UHRP and CHIRP content source and sink adapters;
- browser IndexedDB and in-memory license stores; and
- whole-placement composition records with cycle, shared-DAG, depth, and total
  traversal checks.

## Acquisition is explicit

Reading a header never spends money. Applications inspect an Offer, preflight
the exact selection and price, show a user confirmation, ask the wallet to
construct payment, deliver the Demand and remittance to the Payee, then store
the returned signed License and key grants. Recovery is available for the
Offer's exact declared recovery period.

```typescript
const buyer = await LCHMultipayBuyer.create(wallet, {
  endpointPolicy,
  agreementEvaluator: evaluateAcceptedAgreement
})
const request = await buyer.createRequest({
  offerId,
  assetId,
  action: 'play',
  selection: { type: 'all' },
  acceptedPolicyDigest,
  createdAt: BigInt(Math.floor(Date.now() / 1000))
})
const plan = await buyer.quote(selectedOffer, request, sellerIdentity, {
  type: 'segmented',
  encryption: inspected.representation.encryption,
  delivery: selectedOffer.keyDelivery.mechanism
})

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

The final `quote` argument is required buyer-side License context taken from
the verified Asset and selected Offer. `complete` binds the returned License to
the request and Quote, matches every fulfillment to the exact submitted proof,
and checks that every and only the selected encryption key periods use the
Offer's chosen delivery mechanism. Use `{ type: 'none' }` only for a profile
that genuinely returns no key grants; it is not a shortcut around encrypted
Asset validation.

The returned License Agreement is a distinct ODRL document rather than the
accepted Offer Policy bytes. Applications must supply a profile-aware
`agreementEvaluator` when constructing
`LCHMultipayBuyer`. The buyer retains the verified signed Offer in the payment
plan and invokes the evaluator before completion or recovery returns a License.
The callback receives the Offer, License Request, Quote, License, pinned Offer
Policy reference, and pinned Agreement reference. It must affirm that the
Agreement grants the requested action and Selection while preserving every
accepted constraint, Prohibition, and Duty; an issuer signature alone never
authorizes substituted post-payment terms. Signed encryption descriptors,
ciphertext lengths, and optional Quote segment ranges are validated before the
wallet boundary. Duplicate Demand IDs and intrinsically ambiguous destinations
fail before `createAction`.

`validateOffer` requires the signed payment endpoint to be absolute HTTPS and
rejects literal private or loopback destinations. A creator using a local
loopback fixture must opt into that exact origin explicitly when creating and
validating the Offer; never derive that allowance from a remotely supplied
Offer.

All versioned signed-object validators require version 1 and reject unknown
top-level `critical` identifiers. Applications that implement a registered
extension pass the same exact `supportedCriticalIdentifiers` set through every
buyer, issuer, Payee, settlement, and recovery validator; retaining or
recognizing an unknown field is not sufficient to accept its semantics.
`LCHReader` enforces the same policy for Header and Asset critical identifiers,
and extension-map keys must be absolute identifiers.

Endpoint policy applies a finite default deadline to DNS, connection, and
response work in addition to public-address validation, connection pinning,
redirect limits, and cross-origin credential stripping. Custom connectors must
honor the supplied abort signal; the client also races non-returning connector
and resolver promises against that deadline.

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

Treat durable settlement stores as untrusted persistence boundaries. Every
cached Receipt or Authorization is reverified and rebound to the current
Demand, transaction, identities, output, amount, and validity window before a
retry returns it; storage lookup success alone is never settlement evidence.

`LCHMultipayBuyer.recover(payment, receipts, authorizedOutputs)` requires the
complete persisted funded acquisition and settlement proofs and applies the
same License and Agreement-policy validation as completion. The lower-level
`recoverUnverified(endpoint, requestId)` APIs return an explicit
`UnverifiedLicenseResponse` for transport integration only. A Request ID alone
does not establish the expected issuer or bind the Asset, Offer, subject,
Agreement, Selection, settlement, or key grants. Never unwrap the low-level
response for key storage, content access, or authorization.

The issuer is a coordinator, not an implicit payment custodian. Every Demand
names the Payee identity, amount, BRC-29 derivation, settlement profile, and
endpoint. A drummer, composer, label, or publisher can each run an independent
wallet, endpoint, Payment Ledger, and availability provider. The Quote binds
their signed Demands into one buyer-authorized transaction without moving
those wallets into the issuer service.

## Storage and media

`UniversalContentSource` resolves `chirp:`, `uhrp:`, and bounded HTTPS
locators. `CHIRPContentSink` and `UHRPContentSink` publish encrypted bytes
through the existing storage libraries. No LCH API changes the existing UHRP
uploader, downloader, routes, or identifiers. A `uhrp:` read tries each unique
resolved host in order without bypassing bounded-response, redirect, SSRF, or
address-pinning checks.

Media players and DAWs remain application code. The package supplies verified
bytes and selection/composition semantics; it does not choose codecs, decode
media, draw waveforms, build catalogues, or define recommendation behavior.

For large licensed media, use `CHIRPContentSink` with a `CHIRPUploader` and
configure `UniversalContentSource` with a `CHIRPDownloader`. CHIRP validates
Merkle objects, logical length, and the complete-stream content hash; LCH then
independently validates the exact ciphertext length and digest before segment
authentication and decryption. Storage hosts see ciphertext and do not become
LCH issuers or Payees.

The 0.1 LCH publisher and reader use bounded `Uint8Array` representations and
assemble the complete resolved ciphertext in memory. Configure
`maximumBytes` for assets using this path. CHIRP supports verified streaming,
but a progressive LCH player additionally needs a segment-aware adapter that
authenticates complete encryption records and enforces the licensed Selection;
raw CHIRP chunks are ciphertext, not authenticated playable plaintext.

Range adapters are exact contracts: CHIRP must return precisely the requested
byte count, while HTTPS must return the exact `206 Content-Range`, declared
length, and body length. Ignored, shifted, expanded, truncated, or unsolicited
partial responses fail closed. Deterministic CBOR enforces its aggregate
100,000-item and 16 MiB limits during encoding and at direct decode entry, so
callers cannot bypass the wire budget by nesting individually legal
containers.

Retain one `LCHPublisher` for its publication lifetime. It keeps bounded
Encryption-ID and Key-ID duplicate detectors and refuses cross-Asset reuse from
a broken or injected random source; constructing a new instance per Asset
discards that defense-in-depth history.

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

`walkComposition` retains every directly declared placement, expands an
identical `(Asset ID, Selection)` provenance node once, and rejects cycles,
unsupported depth, or an excessive flattened traversal. Applications still
evaluate and aggregate ODRL Duties by their UIDs and policy rules; matching a
Payee or provenance node alone does not deduplicate payment obligations.

`validateC2PAComposition` compares the C2PA and Composition Record ingredient
sets in both directions, including relationship, source Asset, hashed URI, and
hash. Graph loaders must return the exact requested Asset ID and normalized
Selection; extra C2PA inputs and substituted nodes fail closed.

The small `permits()` helper returns `true` only for a bare, unconditional ODRL
rule with exactly `action` and `target`. Constraints, Duties, assignee/assigner
scope, and extension fields require a profile-aware evaluator and return
`false`; they must never be ignored to obtain an authorization decision.

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
  credentials across origins. Public redirects cannot enter an allowlisted
  local-development origin; local access must be selected explicitly. Test the URL parser's canonical hexadecimal
  spelling of IPv4-mapped and transition IPv6 literals, not only dotted input
  spellings, and fail closed for non-global IANA special-purpose ranges.
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

## Production readiness

Replace every fixture wallet and in-memory content, issuer, license, Payment
Ledger, Authorization, evidence, and Delivery store before real purchases.
Persist finalized Atomic BEEF and signed Deliveries before fan-out; retry and
recover the same transaction through `recoveryUntil`; keep every endpoint
independently routable; and validate restart, duplicate, conflict, offline,
provider-outage, and lost-response cases. The
[production CHIRP and LCH guide](../../guides/chirp-lch-production.md) includes
copyable combined-layer flows, role ownership, a failure matrix, server and
wallet topology, rollout/rollback guidance, observability, and an agent
implementation contract.

## Reference

- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/content/lch#readme)
- [Published BRC-170](https://bsv.brc.dev/apps/0170)
- [BRC-170 source](https://github.com/bsv-blockchain/BRCs/blob/master/apps/0170.md)
- [Production CHIRP and LCH guide](../../guides/chirp-lch-production.md)
- [Reference application](https://github.com/bsv-blockchain/ts-stack/tree/main/apps/lch-reference)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/content/lch)
