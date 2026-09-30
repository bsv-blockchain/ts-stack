---
id: revenue-listing-spends
title: 'Planning and Signing Revenue Listing Transactions'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: experimental
tags: [utxo, sdk, scripts, revenue, wallet]
---

# Planning and Signing Revenue Listing Transactions

The unpublished SDK candidate separates the BRC-197 locking-script codec,
economic plan, funded transaction, and signing authority. Applications explicitly
import `RevenueListingPlan` or `RevenueListingSpend` under
`@bsv/sdk/script/templates/`. The default SDK exports and bundles are unchanged.
Read the [codec guide](./revenue-listing-codec.md) for the immutable program source.

The low-level constructor accepts a codec, immutable descriptor, one or two
predecessors, and a closed action. Each predecessor supplies its complete
`rawTransaction` as canonical lowercase hex and its `outputIndex`. A purchase
action has `operation: 'purchase'`, `acquisitionId`, `requestDigest` and `recipient`.
Split uses `operation: 'split'` and `firstAmount`. Payout uses `operation: 'payout'`
and `units`. Merge and retirement need only `operation: 'merge'` or `'retire'`.
Amendment uses `operation: 'amend'` and `state`, the complete new revenue schedule.
Amounts, payout units and revisions are canonical decimal strings.

```typescript
import { RevenueListing } from '@bsv/sdk/script/templates/RevenueListing'
import { RevenueListingSpend } from '@bsv/sdk/script/templates/RevenueListingSpend'

function preparePlan(program: Uint8Array, descriptor: unknown, previous: unknown, action: unknown) {
  const spend = new RevenueListingSpend(new RevenueListing(program), descriptor, previous, action)
  return {
    spend,
    display: spend.plan(),
    unlockingScriptLengths: spend
      .plan()
      .inputs.map((_, index) => spend.estimateUnlockingLength(index))
  }
}
```

`plan()` returns owned JSON data with the exact ordered listing inputs and
mandatory outputs, old and successor revenue schedules, receipt position, payout,
retirement top-up, minimum external funding before fees, and required signers.
It has no wallet, fee estimator or broadcast effect. `planRevenueListingSpend`
provides the same pure planning operation without retaining a spend object.
Neither operation proves that the inputs are genuine, unspent listings. A caller
must first validate the descriptor's authority, both histories through every
merge, chain evidence and the application's acquisition binding. The
[full-history verifier](./revenue-listing-lineage.md) supplies the lineage and
Bitcoin checks. The eventual high-level wallet/domain adapter must also enforce
the remaining authority, currentness and acquisition checks before signatures.

All six routes preserve the exact specified economic rules. Purchases add the
price to the listing and bind the receipt to the acquisition and recipient.
Split and merge conserve the listing balance. Payout distributes an integer
number of complete revenue quanta, retaining the reserve and remainder.
Retirement includes the old reserve in an exact proportional distribution and
reports its externally funded top-up, which is smaller than one quantum.
Amendment advances the revision once, preserves the balance, and requires the
seller plus every old recipient, including removed recipients, for that input.
It does not change unconsumed siblings. An administration value of `none` permits
only purchase and has no withdrawal or amendment route.

Use BRC-100 two-phase funding with `signAndProcess: false` and
`randomizeOutputs: false`. Pass the estimated unlocking lengths for foreign
listing inputs. Require all listing inputs first in the plan's order, the
mandatory outputs exactly as planned, at least one external funding input, and
at most one final standard P2PKH change output. The wallet must preserve version
1 or 2, zero locktime and final sequences on every input. Show the price,
payout, both schedules when amending, retirement top-up, fee and change before
requesting authorization. No generic wallet support is inferred from this guide:
the actual createAction/signAction adapter remains separately tracked work.

Attach complete source transactions from the funded wallet result's BEEF to
all funding inputs, then call `spend.prepare(transaction)`. Preparation takes
owned snapshots, checks every prevout against its source, rejects duplicate or
reordered listing inputs, additional family listings used as funding, altered
mandatory outputs and unsupported change. It checks input/output conservation
before exposing any signing request. A source transaction's hash authenticates
its bytes, not its mining, lineage or unspentness.

`signingRequests()` returns the exact input index, public identity, role, scope
65, full preimage and `data = SHA256(preimage)`. The authority must produce a
raw Bitcoin transaction signature over `SHA256(data)`; an API that hashes its
message once receives `data`. A digest-signing API receives `SHA256(data)`.
Do not insert a signed-message envelope, derive an unrelated identity, or extract
a wallet identity secret. Each administrative merge input has its own seller
request. Amendment recipient requests follow the old schedule's canonical order.
The module never invokes the authority or obtains a private key.

Supply one `{seller?, recipients: []}` record per listing input to
`complete(signatures)`. Signatures are lowercase hex containing strict DER,
low-S and the final `41` byte. Purchase has no seller signature and an empty
recipient array. Administrative routes require the seller; amendment additionally
requires every old recipient signature in order. The method verifies each
signature against its required key and exact input preimage, then produces the
fourteen-argument minimal-push unlocking script. It returns an owned transaction;
external funding signatures still belong to the wallet's finalization phase.

After `signAction`, call `assertFinalLayout(finalTransaction)` using the retained
prepared object and source transactions. It checks every input, output, sequence,
version and locktime committed by the original preimages. It deliberately allows
unlocking scripts to change: this check is not signature or full transaction
verification. Verify the finalized transaction and all its Script invocations
against the configured chain/evidence policy before submitting it. A layout
failure must not be treated as a successful purchase or consent. Retain the
original descriptor, action, source evidence and wallet operation identity for
recovery; reconstructing a new transaction is a new signing decision.

Local resource bounds are explicit. Each predecessor is at most 1 MiB decoded,
and the one/two-listing predecessor JSON envelope is at most 4 MiB. Genesis and
listing predecessors have the profile's one-to-eight inputs and one-to-eleven
outputs. Funded transactions have at most eight inputs, eleven outputs and
4 MiB serialized bytes. Every supplied funding predecessor is at most 1 MiB.
The size estimate includes the maximum eight-input prevout vector and all
applicable consent and counterpart bytes. A wallet or node may have smaller
script, size or fee limits; unsupported policy must be surfaced before signing.

The tests reconstruct all twelve accepted frozen BRC transactions byte for byte
and execute every input with the SDK interpreter. They include both merge
invocations, complete consent, retained remainders and exact retirement top-up.
Thirty frozen rejection transactions independently check interpreter agreement.
Generated properties cover payout conservation, top-up bounds, snapshot ownership
and final-layout binding. The copied-script merge remains Script-valid in this
corpus but is not genuine lineage. No fixture or construction test substitutes
for the remaining lineage, BRC-100 wallet, private fulfillment, browser application
or miner-policy qualification.
