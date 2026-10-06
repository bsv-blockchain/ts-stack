---
id: revenue-listing-profile
title: 'Immutable Two-Stage Listing Profile'
kind: guide
version: '3.1.0'
last_updated: '2026-10-05'
last_verified: '2026-10-05'
review_cadence_days: 30
status: experimental
tags: [utxo, sdk, scripts, revenue]
---

# Immutable two-stage listing profile

The optional sale-listing exemplar in BRC PR295 has two literal Bitcoin Script
programs. A reserve-only genesis creates an activation-stage output. A separate
funded activation verifies the public seller and recipient child-key links and
creates the active output. Purchase, split, proportional payout and retirement
operate on that active output. The portable SDK codec covers the exact locks
and descriptor. Separate planning and funded-witness interfaces construct these
transactions; independent Script and lineage verification authorize their use.

Import `RevenueListingProfile` from
`@bsv/sdk/script/templates/RevenueListingProfile`. Pass the activation program
and active program separately to its constructor. It owns each byte array and
checks the frozen lengths and SHA256 digests before encoding anything. No
compiler, network fetch, filesystem reader or private key is implicit. The
activation program is 33406 bytes and the active program is 4906 bytes. Their
complete locks are 34127 and 5627 bytes respectively. Supply the literal programs
from the agreed immutable specification baseline; a different executable cannot
be substituted under the same family identity.

`lock('activation', descriptor)` and `lock('active', descriptor)` make the stage
choice explicit. Both encode `4dcd02`, the same 717 metadata bytes, `OP_DROP`
and the selected executable. `decode(scriptBytes, descriptor)` compares the
entire lock with the separately supplied descriptor and returns an owned
descriptor plus the recognized stage. Constructing or recognizing an active
lock does not prove that its activation occurred or that the seller authorized
its genesis.

`parseRevenueListingProfileDescriptor` requires `expiryHeight` from 1 through 499999999. `initialRevenue` has only a sorted, unique array of one through eight
recipients, each with a compressed root identity and positive integer weight.
Weights sum to at most 10000; their sum is the payout quantum. This profile has
no administration mode or revenue revision. A changed price, seller, expiry,
recipient or weight requires a new descriptor and signed lineage. Obsolete
revision/administration fields are rejected rather than silently ignored.

`encodeRevenueListingProfileSchedule` writes the count and eight fixed 70-byte
root/child/weight slots, for exactly 561 bytes. `decodeRevenueListingProfileSchedule`
re-derives each public child, checks exact integer weights and rejects nonzero
unused slots. `encodeRevenueListingMetadata` adds the descriptor's listing and
terms digests, price, reserve, expiry, seller root and seller child. All monetary
fields retain exact satoshi integers; no proportion is rounded here.

The child profile uses protocol `[2, '3241645161d8']`, key ID
`'brc197 authority'` and counterparty `anyone`. Its root-to-child link is public.
The codec performs only public point arithmetic and returns no private scalar.
Protected wallet signing and fixed-child remittance remain separate mandatory
interfaces. A leaked child scalar compromises the identity root because its
tweak is public; this profile makes no privacy claim.

`RevenueListingProfilePlan` exposes `planRevenueListingProfileSpend(profile,
descriptor, previous, action)`. Supply exactly one bounded raw predecessor and
its output index. Activation requires a reserve-only stage output and produces
one active reserve output without a receipt. Purchase adds exactly the price
and a one-satoshi recipient-bound receipt. Split preserves all value in two
active outputs, each at least reserve. Permissionless payout pays integer
quanta to the fixed child of every recipient, retaining reserve and remainder.
Retirement distributes the entire balance, including reserve, with an externally
funded top-up smaller than one quantum. Choose `authority: 'seller'` for early
retirement or `authority: 'expiry'` with a committed height lock for the
permissionless route. There is no merge or amendment action.

The plan contains exact mandatory outputs, receipt position, minimum external
contribution before fees, locktime, listing sequence and the protected seller
request when needed. The amount labelled `minimumExternalFunding` includes a
receipt and final top-up where required; activation still requires an external
input even when its minimum contribution is zero. The listing never pays the
fee. Construct a complete funded transaction with two through eight inputs and
at most one additional final P2PKH change output. Only input zero may consume a
listing from either frozen stage. Supply a complete raw source transaction for
every funding input; a claimed outpoint and amount alone are insufficient.

`RevenueListingProfileSpend` takes the same inputs and owns the parsed plan.
Its `estimateUnlockingLength()` bounds the full activation ABI, including all
eight recipient proof slots, or the active ABI. Funding and fee selection remain
caller responsibilities. `prepare(fundedTransaction)` owns and checks source
transactions, exact input-zero identity, all required outputs, amounts, input
count, optional change and route finality before requesting any signature.
Activation, purchase, split, payout and early retirement use zero locktime and
final sequences on every input. Expiry retirement authenticates a height at
least the descriptor expiry and below 500000000, with a nonfinal listing
sequence. Strict Bitcoin height finality first permits inclusion at lockHeight
plus one; Script construction is not a chain-finality assessment.

`signingRequests()` returns only the seller's fixed-child request for split and
early retirement. Use a protected BRC-100 `createSignature` implementation with
its exact protocol, key ID, counterparty and `data`. That data is SHA256 of the
complete input-zero preimage; the normal wallet signing operation hashes it once
more. Check the wallet's public child against the request. Pass its low-S DER
signature with the `0x41` scope byte as `{ seller: hexSignature }` to `complete`.
All other routes require `{}`. The builder verifies the child signature and
computes the public binder and activation-link proofs locally, returning no
root or child private scalar. It generates exactly 114 activation witness values
or 15 active values. Unused proof and route fields are canonical zero/empty values.

The prepared purchase's `purchaseCommitment` is the full 32-byte SHA256d of the
input-zero preimage, before scalar reduction. It describes construction, not
successful verification or an entitlement. `assertFinalLayout(finalTransaction)`
rechecks the retained preimage, mandatory outputs and source/header bindings
following wallet finalization. Independently execute every final input, validate
seller-authorized genesis and activation ancestry, and assess the exact selected
chain before acquisition admission or release. The witness constructor accepts
one predecessor for planning; it cannot establish those histories. Historical
release txids and separately verified current aliases remain acquisition-domain
responsibilities.

Tests reproduce unchanged activation and purchase transactions from the current
positive wire corpus byte for byte. They also execute every input of connected
normal eight-recipient activation/purchase/payout construction and complete
seller-child split, payout and both retirement paths. Each of the eight
recipients spends its exact fixed-child P2PKH payment through the protected
wallet signing interface. The full 300-run profiles
exercise immutable value conservation for one through eight recipients and
complete funded active routes with varied fees, quanta, split amounts and height
locks. The test signer uses only publicly disclosed offline toy identities; no
private scalar crosses into the builder. These component receipts do not qualify
native wallet remittance, signed lineage, miner policy, chain-currentness or
private-release recovery. The
[alignment record](https://github.com/bsv-blockchain/ts-stack/blob/codex/utxo-application-runtime/specs/output-knowledge/SPEC-ALIGNMENT.md) tracks that
remaining integration. The superseded single-program planner and witness builder
must not be selected for this replacement profile.
