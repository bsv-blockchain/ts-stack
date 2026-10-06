---
id: revenue-listing-lineage
title: 'Verifying Revenue Listing Histories'
kind: guide
version: '1.1.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
review_cadence_days: 30
status: experimental
tags: [utxo, sdk, scripts, revenue, evidence]
---

# Verifying Revenue Listing Histories

This page preserves the historical pre-replacement family and its original
interfaces. Its merge and revision rules do not describe the current BRC-197.
New installations select the [immutable profile verifiers](./revenue-listing-profile-lineage.md).
Keeping the older exports available preserves compatibility; it does not
qualify them for the replacement family.

A matching locking script does not prove that an output belongs to an authorized
listing. The optional @bsv/output-knowledge/revenue-listing entry verifies the
proposed BRC-197 full-history profile: seller-authorized genesis, every listing
predecessor through both sides of every merge, Bitcoin evidence under an installed
immutable chain view, and every actual covenant invocation. It uses the exact
authenticated [SDK executable codec](./revenue-listing-codec.md).
Existing root imports, journals and lookup behavior remain unchanged.

This is a historical lineage verdict. Asset authority, selection of the desired
listing, current unspentness, acquisition/request/recipient association and
private delivery remain separate checks. Compare the returned target with the
outpoint selected for the operation; a valid history for a different output does
not authorize spending the selected one.

## Installed dependencies and owned context

Supply the exact frozen program to RevenueListing; its constructor authenticates
the bytes. Supply a ChainViewResolver whose returned view, headers and tracker
describe the configured, independently validated header ancestry. A remote
assertion that a transaction exists, a latest-height lookup or an unchecked
Merkle root is not a substitute for that dependency.

```typescript
import { RevenueListing } from '@bsv/sdk/script/templates/RevenueListing'
import {
  RevenueListingLineageVerifier,
  type ChainViewResolver
} from '@bsv/output-knowledge/revenue-listing'

function installHistoryVerifier(program: Uint8Array, chains: ChainViewResolver) {
  return new RevenueListingLineageVerifier(new RevenueListing(program), chains, {
    concurrentRequests: 2
  })
}
```

Reuse a verifier for the installed family and resolver so its capacity bound
applies across callers. Construct the verification context from trusted local
account, generation, policy and chain-view configuration. A remote package does
not choose those values. The verifier snapshots context and package before
asynchronous work; returned verified data is independently owned.
Call its verify method with the package, context and AbortSignal.

The input can be a plain JSON value, JSON text or UTF-8 bytes. Its closed
version-one envelope contains descriptor, the signed sale-genesis packet,
target, and unique transactions sorted by txid. Each transaction entry carries
canonical base64 BEEF with its exact target raw transaction. Serialize with
the SDK's canonicalOutputJSON. The parseRevenueListingLineagePackage function
checks bounded representation and genesis authorization only; it never
substitutes for the verifier.

## Evidence and merge semantics

The verifier collects all entry bindings before resolving dependencies. An
individual BEEF may be partial when another entry supplies missing raw
transactions or proofs. Sorting by txid therefore does not impose dependency
order. Every listing predecessor must also have its own declared entry;
embedding its bytes in another entry does not establish a complete declared
lineage. Missing history remains unresolved, and unrelated declared listing
entries are rejected. A visited outpoint graph deduplicates shared ancestors
and checks both actual merge parents.

Every transition receives Bitcoin evidence verification in the selected view.
The verifier additionally executes each fixed-family listing input, including
when the transaction has a mining proof. It checks the complete minimal-push
spending arguments, exact family/state bytes, genesis anchor and layout,
successor positions and actual Script conditions. An amendment derives its state
from its real predecessor and verified recipient consents.

A separately funded copy can have the same script and real satoshis. Its
seller-authorized merge can conserve value and pass Script while failing the
common-genesis requirement. Such a merge is invalid as listing history; it does
not demonstrate invented satoshis or bypassed recipients. It grants no purchase
entitlement or fulfillment authority. The frozen boundary fixture demonstrates
both outcomes.

If that transaction actually spends a genuine predecessor, domain rejection
does not restore the predecessor's unspentness. Keep Bitcoin spend reconciliation
separate from catalogue eligibility. Validate both histories before requesting
administrative merge signatures. A profile-ineligible successor may still retain
its Script-enforced payout and retirement routes; an explicitly authorized
recovery workflow must not confuse catalogue ineligibility with loss of those
routes. Historical valid purchases retain their rights.

## Results, limits and recovery

A verified result contains the owned context, descriptor, signed genesis,
target, revenue state, exact satoshi amount, base64 raw target transaction and
sorted distinct listing transaction IDs. It does not reserve an output, submit a
transaction, contact a wallet or release a secret.

An unresolved result identifies missing outpoints. Gather evidence through an
installed bounded resolver and retry with the same intended descriptor, genesis
and target. There is no implicit fetch of an arbitrary URL or extension identifier.
Invalid means validation failed. Context-changed requires a newly selected context
and reassessment. Limited is a resource/dependency outcome, not a validity verdict.
Cancelled stops publication of a successful result for that attempt.

The profile caps decoded UTF-8 package bytes at 2 MiB and declared listing
transactions at 256. Local defaults also cap the BEEF union at 4,096 transactions
and 16,384 inputs, Script memory at 128 MiB, request duration at 60 seconds and
concurrent requests at four. Constructor limits may only reduce these maxima.
The context's byte, transaction, dependency and exclusive deadline bounds can
reduce them further. A dependency that ignores cancellation retains its physical
capacity slot until it settles. Checks and event-loop yields bound work between
transitions; a synchronous Script invocation is not forcibly interrupted midway.

Do not reinterpret an exhausted ancestry budget as a trusted checkpoint. A
different trust profile must name that choice. When a live listing can no longer
fit the full-history profile, stop offering purchases and use an explicitly
authorized superseding lineage while preserving withdrawal and historical rights.

## Qualification and next layer

The corpus is pinned to BRC commit 9dade70dd17d48efb087a2c5da56bb53c164383e.
It uses public synthetic keys and a checked easy-work header chain, not
production-chain inclusion. End-to-end cases cover full merge histories, partial
BEEF union, missing evidence, a funded copy, covenant execution despite mining
evidence, cancellation and expiry. Generated properties exercise representations,
exact bounds, owned context and authorized genesis layouts. All three full-source mutation campaigns pass the unchanged 90% gate with zero
uncovered or invalid mutants. The full runtime suite and exact packed/browser
entry checks also pass; detailed evidence remains in the implementation tracker.

Combine the result with the [transaction constructor](./revenue-listing-spends.md)
only after the remaining domain and currentness checks. BRC-100 funding,
explicit supported seller/recipient signing authorities, durable wallet recovery,
private fulfillment and application demonstrations remain separate work. A wallet
identity key is not automatically available for raw transaction signatures through
its derived-key signing API.

## Internal validation boundaries

The reference verifier keeps complete script-layout and minimal-push ABI checks in
`LineageLayout`, genesis and successor/transition inspection in `LineageTransition`,
and DAG traversal plus actual covenant execution in `LineageGraph`. Existing public
imports, accepted packages and validation decisions are unchanged. The extraction
retains every original function body; it does not replace Script execution with
shape checks or weaken the requirement to inspect both merge parents.

The graph mutation gate aggregates both complete helper files, with the same full
canonical unit/property tests in each execution part. Traversal retains its own
complete source and critical gate. Both remain required before qualification; no
partial report or earlier cancelled run establishes acceptance.

## Exact prepared purchases

`RevenueListingPurchaseVerifier` composes a frozen BRC-196 preparation with the
full history verifier. Supply the independently selected seller, original complete
Prepare and original signed PurchaseTerms, plus purchase evidence selecting output
zero and the trusted local verification context. The verifier authenticates the
terms against that exact request and seller. It requires the registered purchase
profile and exact UTF-8 JCS lineage-package schema bytes, with the prepared target,
chain, seller, asset and terms matching the immutable descriptor.

It checks the actual input-zero predecessor, operation-one ABI, byte-identical
successor script and current revenue schedule, exact price increment and one-satoshi
receipt committing to acquisition, request and recipient. It extends the declared
history with this purchase, then independently verifies Bitcoin evidence and every
covenant through the authorized genesis. A mining proof cannot skip the additional
family execution. Another valid recipient or another preparation may produce a
Script-valid purchase, but cannot satisfy this acquisition. An administrative merge
is not a purchase or a license fulfillment, including a value-conserving funded-copy
merge. Missing declared ancestry remains unresolved even if incidental raw ancestor
bytes occur inside purchase BEEF.

The result includes independently owned original request/terms, purchase evidence,
prepared history, complete verified successor history, predecessor/successor points,
old value and price increment. It has the history verifier's bounded physical work
and negative statuses. Local installation changes across asynchronous verification
return context-changed. Caller limits apply before assembling candidate dependency
unions. The complete extended package, including the new purchase entry, must fit
the existing history profile; preparation must reserve enough space before a wallet
is asked to fund a purchase.

This is a domain verification boundary. Asset authority and content/key/license
validation, output currentness, explicit wallet authorization and durable action
recovery, actual topical admission, release-policy assessment and POTATOES issuance
are still separate owners. A historically valid purchase need not be the winning
current spend. The verifier deliberately does not reject an old prepared obligation
merely because the Offer or purchase cutoff has since expired; the durable service
owns the original reservation and late-first-delivery rules. A verified result alone
never authorizes key disclosure or a second purchase.

The disclosed synthetic tests construct and sign fresh actual purchase receipts,
including a purchase after unanimous amendment, and execute the complete ancestry.
They also verify independent recipient/request refusals and an invalid covenant with
a valid synthetic mining proof. Three hundred generated valid preparations test
association refusal before chain I/O. These are local component evidence; a complete
wallet/host/LCH purchase demonstration and the final full mutation campaign remain
checkpoint requirements.
