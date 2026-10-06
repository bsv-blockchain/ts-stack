---
id: revenue-listing-profile-lineage
title: 'Immutable Listing Lineage and Purchase Verification'
kind: guide
version: '0.1.0'
last_updated: '2026-10-05'
last_verified: '2026-10-05'
review_cadence_days: 30
status: draft
tags: [utxo, scripts, evidence, overlays]
---

# Immutable listing lineage and purchase verification

The current BRC-197 target is PR295 commit
`1b9a75e497b5856675af1ce01fd86843c37d07f9`. Select
`RevenueListingProfileLineageVerifier`, `RevenueListingProfilePurchaseVerifier`
and `parseRevenueListingProfileLineagePackage` from the optional
`@bsv/output-knowledge/revenue-listing` entry. These additive components use
the SDK's pinned two-stage `RevenueListingProfile`. Earlier names without
`Profile` retain their historical contract for compatibility; they do not
implement the replacement family. Other transaction domains do not require
this exemplar.

An owned lineage package contains the immutable descriptor, seller's BRC-77
`sale-genesis` authorization, exact target outpoint and sorted distinct listing
transactions with BEEF. The listing ID commits to the complete descriptor,
including expiry and every recipient/share. Parsing authenticates that packet
and representation; it does not verify Bitcoin or ancestry.

The lineage verifier follows input zero through each declared predecessor to
the authorized reserve-stage genesis. A split has one parent and two active
successors; either can be selected. There is no merge or amendment route. Every
active path includes activation, whose actual Script checks the public child
links and exact active output. Constructing an active lock alone is insufficient.
Missing declared history remains unresolved even when its raw bytes appear in
another BEEF. Unrelated declared listing transactions are refused.

Both frozen executables are recognized by complete bytes. The verifier binds
every consumed lock to the independently parsed descriptor, enforces reserve
and mandatory outputs, and verifies Bitcoin evidence in the installed immutable
chain view. It executes every actual input Script, including external funding
and mined transactions. Complete raw sources are required; a pruned proof alone
cannot establish the profile's own predicates. Route inspection uses the source
stage and output receipts, followed by actual Script execution. There is no
canonical scriptSig chunk-count requirement or extra rejection solely for
another Bitcoin-valid unlocking spelling.

```ts
import { RevenueListingProfile } from '@bsv/sdk/script/templates/RevenueListingProfile'
import {
  RevenueListingProfileLineageVerifier,
  RevenueListingProfilePurchaseVerifier
} from '@bsv/output-knowledge/revenue-listing'

const profile = new RevenueListingProfile(activationProgram, activeProgram)
const histories = new RevenueListingProfileLineageVerifier(profile, immutableChains)
const history = await histories.verify(originalLineage, context, signal)
if (history.status !== 'verified') throw new Error(history.status)
if (history.stage !== 'active') throw new Error('Listing has not been activated')

const purchases = new RevenueListingProfilePurchaseVerifier(profile, immutableChains)
const purchase = await purchases.verify(
  purchaseEvidence,
  { request: originalRequest, terms: originalSignedTerms, seller: selectedSeller },
  context,
  signal
)
if (purchase.status !== 'verified') throw new Error(purchase.status)
const commitment = purchase.purchaseCommitment
```

Supply a locally installed `ChainViewResolver`. A remote chain name or claimed
height is not authority. The context fixes chain view, generation, policy and
finite verification bounds. Limits can only be reduced. Timeout or cancellation
returns promptly while an uncooperative dependency retains its physical work
slot until settlement. Replacing an installed profile method or resolver fences
the operation. Verified observations apply to that exact context; they are not
permanent currentness claims.

The purchase verifier authenticates frozen BRC-196 terms against the original
request and independently selected seller, binds the exact prepared predecessor,
price increment and recipient receipt, then verifies the whole successor lineage.
Only afterward does it return the full 32-byte SHA256d input-zero `0x41` preimage
digest, before scalar reduction. Receiving or calculating a digest alone does
not authorize admission, private release, a License or another charge. Asset
authority, currentness, economic alias reservation and release remain separate
installed responsibilities.

Permissionless payout pays every fixed child in whole quanta and retains reserve
and remainder. Both retirement paths distribute the entire balance with exact
external top-up. A retirement receipt is not a live lineage target. Component
tests inspect and execute both retirement Scripts; unsigned retirement also
needs strict chain-height finality, first possible at `expiryHeight + 1`.
New-preparation expiry and retained delivery obligations belong to the separately
composed acquisition owner.

Evidence includes unchanged positive genesis/activation and both purchases,
complete signed split/payout histories, both retirement Scripts, original
minimum 300-run properties, ownership and bounded lifecycle checks. The chain
is disclosed synthetic easy-work evidence, not a live purchase or native wallet
containment proof. LCH collector integration, fixed-child remittance, durable
alias custody and complete qualification remain checkpoint-two work in the
[alignment inventory](../../specs/output-knowledge/SPEC-ALIGNMENT.md).
