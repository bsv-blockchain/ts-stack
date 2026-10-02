---
id: private-overlay-release
title: 'Private Overlay Release Evidence'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: experimental
tags: [overlays, sdk, privacy, evidence]
---

# Private Overlay Release Evidence

Private acquisition separates the payment transaction, the seller's admission
decision, and the private result the recipient can actually use. The unpublished
SDK candidate implements the shared BRC-195/196 release representations under
`@bsv/sdk/overlay-tools/OutputReleaseProtocol`. These helpers are part of the
reference implementation in progress; they do not implement an acquisition store,
payment internalization, secret delivery or the complete STEAK/POTATOES service.

## Payment output inspection before wallet effects

`@bsv/sdk/overlay-tools/OutputPaidLookupFunding` parses the BRC-105 payment header
under BRC-195's 96 KiB JSON and 64 KiB decoded Atomic BEEF limits. Its closed
header contains only the exact prefix, suffix and transaction. Both derivation
strings are bounded ASCII; a selected wallet may impose additional representation
requirements that must be checked before construction. The HTTP adapter must
also enforce the 128 KiB bound on all decoded header fields together.

After authenticating the buyer and binding the saved quote, derive the expected
seller payment key through BRC-29 using protocol `[2, "3241645161d8"]` and key ID
`derivationPrefix + " " + derivationSuffix`. A seller wallet uses the buyer as
counterparty and `forSelf: true`; the buyer derives the seller's public child with
the seller as counterparty and the default `forSelf: false`. Check the installed
wallet's identity against the separately selected seller. The test fixture checks
that actual ProtoWallet implementations on both sides derive the same key.

`inspectOutputPaidLookupFunding(payment, quote, { chain, sellerPaymentKey })`
uses that independently derived key to construct the exact standard P2PKH script.
It requires the quote's prefix, one Atomic BEEF dependency graph and raw target
bytes, scans every output, and requires exactly one matching script with exactly
the quoted satoshis. Duplicate matching scripts fail even when their amounts
differ. The supplied chain must come from the verified original listing, not the
payment header. No derived key is trusted merely because the request supplied it.

The result contains the raw target and the proposed `OutputWalletFundingOperation`
with its exact chain/txid/output identity and `wallet-funding` operation digest.
Different BEEF proof representations of that same transaction preserve the
operation identity. This is output inspection, not a Bitcoin or release-policy
verdict, a durable reservation, wallet internalization or permission to disclose
private material. Verify the full transaction under the selected evidence policy,
then atomically reserve acquisition and funding before invoking a qualified
idempotent wallet adapter. A plain BRC-100 internalizeAction call is insufficient
for that recovery claim. Invalid candidates do not create replacement invoices.

`parseOutputReleasePolicy` accepts the three selected modes: local admission,
acceptance by a named processor under a named policy, and mining with a positive
confirmation count. `parseOutputReleaseEvidence` takes an owned, bounded snapshot
and validates the corresponding closed envelope. Local admission permits neither
processor nor block evidence. Processor acceptance requires its evidence bytes
and forbids block evidence. Mining requires the complete block-evidence record
and forbids processor evidence. Unknown fields and payload claims such as
`verified` or `paid` are rejected.

The mined representation uses exact U64 arithmetic to check its declared height
and confirmation depth, including heights that cannot be represented exactly by a
JavaScript number. A containing block at the declared tip must have the same
hash. These are intrinsic consistency checks. Even a well-formed record remains
unverified until an installed chain verifier checks its actual BEEF inclusion,
authenticated headers, difficulty/work, contiguous ancestry and selected chain
view. The application must recheck that same context before committing a release.
No parser fetches a header or treats a displayed height as chain evidence.

`bindOutputReleaseEvidence(response, expected)` additionally matches the complete
chain, exact transaction ID and full release policy against independently selected
values. Derive `expected` from the retained authenticated acquisition terms and
local selection policy. Copying those fields out of the response defeats the
purpose of the binding. The returned record still carries no verification verdict.

`verifyOutputProcessorAcceptance(response, expected)` verifies the registered
`https://bsv.brc.dev/overlays/0196#processor-attestation-v1` format. Its evidence
must be UTF-8 canonical JSON containing an anyone-verifiable BRC-77 packet in the
`processor-acceptance` signature domain. The signer must be the independently
selected processor identity. The signed chain, transaction, policy IRI and
acceptance time must match the enclosing record exactly. Other processor formats
require separately installed verifiers; this function reports unsupported rather
than treating arbitrary bytes as equivalent evidence.

A valid processor statement means that processor asserted acceptance under that
policy. The application must explicitly trust it for that purpose. It does not
prove mining, universal availability or economic finality. Local admission is a
different, seller-attributed decision; signature verification of a processor is
not a substitute for linking admission to the exact retained acquisition.

Release authorization and recipient usability also remain distinct. The complete
acquisition layer must bind the release evidence digest to the seller's signed
POTATOES and verify acquisition, request, recipient, asset, terms and transaction.
The recipient then checks the private payload's installed schema, content/key
relationship and licensing evidence. A signed wrong key is still unusable.
Recovery preserves the original delivery event and accepted rights even when
today's public chain assessment changes.

## Purchase preparation and the private result

The companion `@bsv/sdk/overlay-tools/OutputPurchaseProtocol` entry provides the
BRC-196 preparation, signed terms, submission, uncharged recovery and result
envelopes. `verifyOutputPurchaseTerms(terms, originalRequest, selectedSeller)`
authenticates the seller and binds every frozen request field, including the
listing, asset, recipient and opaque application request. It checks acquisition
and request digests and the minimum one-day recovery promise with exact integer
arithmetic. It does not select an acceptable domain or release policy for the
buyer, verify the supplied domain evidence, or authorize funding. Complete those
checks and persist the exact request and verified terms before constructing a
transaction. A new purchase must respect the original creation deadline.

After authenticating the complete response with BRC-103/104 and independently
retaining that original contract, use
`verifyOutputPurchaseEnvelope(response, retainedTerms, expectedTxid)` for its
status-dependent signature and binding checks. The wrapper's STEAK and pending,
rejected or failed status are not authenticated by the POTATOES signature.
Supply the exact transaction constructed for this
acquisition; any status after reservation requires that independent expected ID.
The preparation and expiry states do not claim a transaction outcome. Admission
rejection and delivery failure retain a local decision whose global outcome is
explicitly unknown. A local rejection cannot establish that a signed transaction
will never settle elsewhere or authorize an automatic replacement payment.

Only admitted states contain STEAK, and it must include the selected topic.
STEAK keeps its original object shape; POTATOES lives beside it in the opt-in
wrapper. Exactly the delivered state contains signed POTATOES and release
evidence. The parser checks their transaction, acquisition, recovery deadline,
release policy and evidence digest. The verifier additionally authenticates the
seller's POTATOES and binds its request, recipient, topic, asset and terms to the
original contract. An empty duplicate submission receipt does not establish the
missing original topical admission; a service still needs its durable admission
record and recovery coordinator.

These functions do not compare old terms to today's clock during recovery.
Historical delivery keeps its original basis, and an explicit recovery extension
may lengthen but never shorten the original promise. Verification of a response's
signature and bindings remains separate from satisfying its release policy or
checking whether its secret actually works. The complete service must atomically
retain acquisition and transaction association, admission evidence, protected
delivery intent and replay fences before claiming delivery.

These additive helpers preserve legacy STEAK, lookup context and BRC-100 behavior.
Applications select the new profile explicitly. The tests use disclosed fixture
keys, real SDK BRC-77 signing and verification, and synthetic block identifiers.
They establish representation and processor-attribution behavior, not mined
release qualification or a deployed private service.

## Private publication and paid lookup

`OutputPrivatePublicationProtocol` parses BRC-195 requests and publication status
without accepting caller-supplied authentication or payment claims. Private values
are limited to 1 MiB inside the bounded complete request. An installed domain
validator must still prove publisher authority, output/asset binding and that the
private value works for the content. `outputPrivatePublicationRequestDigest`
excludes only `evidence.beef`; it includes the exact target, private values, schema
and extensions. An alternate proof may share that fence only after verifying the
same actual transaction and output. A parsed `ready` response does not establish
atomic protected storage, topical admission or lookup readiness.

`OutputPaidLookupProtocol` parses acquisition requests, quotes, uncharged recovery
and all seven acquisition states. Amounts must be positive and fit BRC-100's
SatoshiValue range. Deadlines use exact U64 arithmetic and require at least one day
between payment creation cutoff and recovery expiry. The service must additionally
honor any larger selected offer/profile recovery period. ASCII derivation prefixes
are bounded to 128 characters and are not restricted to base64; BRC-105 permits
other representations such as hex. Check the selected wallet's support before
constructing payment, and never silently change the prefix used for derivation.

Quotes have no standalone signature in this profile. Authenticate the complete
BRC-103/104 response, then use `bindOutputPaidLookupChallenge` with the independently
retained original request and selected seller/rules. Retain that exact quote before
funding. The binder checks acquisition and request digests and frozen asset/terms;
it does not choose an acceptable price, release policy, current offer or deadline.
The BRC-105 payment headers must independently match the authenticated quote.

After authenticating a response, `bindOutputPaidLookupAcquired` compares its saved
quote and purchased output to those original values. Funding identity and release
evidence must agree on chain, transaction and policy. `quoted` and `expired` cannot
claim funding; accepted states require release evidence; only `delivered` carries
private context. A local failure remains separate from global payment settlement.
The binder deliberately does not expire historical rights against today's clock
or replace the purchased output with the current catalogue successor.

These helpers do not implement the seller's durable acquisition state machine or
the wallet's `internalizeOnce` capability. That composition must scan all payment
outputs for exactly one derived BRC-29 script, enforce the exact amount, verify
transaction and release eligibility, reserve funding globally once, reconcile an
uncertain wallet result and retain the protected delivery obligation. Parsing a
funded or delivered claim alone proves none of those effects. Existing generic
AuthFetch automatic-payment retries are not a durable acquisition coordinator.

The [local funding recovery guide](./local-funding-recovery.md) describes the
opt-in SQLite wallet adapter for `internalizeOnce` and durable receipt lookup.
It commits ownership and its receipt together, leaving acquisition authorization,
release eligibility and protected delivery with the seller service.

The internal [protected private-service ledger](./protected-private-service-storage.md)
provides encrypted native records, atomic capacity/completion reservations and
current authorization at response enqueue. It is a foundation for the separate
publication and acquisition state machines; it does not make an arbitrary
legacy lookup or topic submit a conforming private-sale endpoint.
