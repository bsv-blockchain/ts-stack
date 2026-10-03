---
id: private-purchase-custody
title: 'Original Covenant Purchase Custody'
kind: guide
version: '1.0.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
review_cadence_days: 30
status: experimental
tags: [utxo, private-overlays, purchase, custody, recovery]
---

# Original covenant-purchase custody

The optional `@bsv/output-knowledge/private/node` entry provides
`PrivatePurchaseContracts`, `PrivatePurchaseCoordinator`, `PrivatePurchaseAccess`,
`PrivatePurchaseDisclosure`, the purchase progress functions and
`SQLitePrivatePurchaseStore` and `SQLitePrivatePurchaseEvidence` for the proposed BRC-196 companion. Compose them with
independent domain and release verification, the actual topic admission owner and
optional authenticated HTTP routes. Installing the native components alone does
not enable an endpoint or change ordinary overlay submission.

Unlike paid lookup acquisition, the purchase workflow pays through an actual
listing covenant transaction. It does not reserve a seller wallet credit or
charge an HTTP fee. A preparation retains the independently selected host and
topic, authenticated capability, complete original request, seller-signed terms,
domain evidence and disclosed release policy. The acquisition ID permanently
identifies that original request and recipient; a retry cannot select new terms
or replace an uncertain transaction.

## Prepare before the buyer funds

Install `PrivatePurchaseContracts` with explicit seller, chain, canonical base
URL, topic, rules digest, domain profile/schema, release policy, byte ceilings
and purchase/recovery intervals. `retain` checks a fresh authenticated BRC-101
capability. `restore` recovers the original retained selection without renewing
its promise or rejecting it merely because the catalogue has since expired.

An independently installed domain supplies verified listing authority, eligible
terms, private readiness and bounded material. `prepare` creates an owned
unsigned body; `authenticate` requires the exact original body signed by the
selected seller. Neither method establishes Bitcoin, domain or currentness
premises. For the BRC-197 profile, compose full genesis/lineage verification and
`RevenueListingPurchaseVerifier` as described in the
[lineage guide](./revenue-listing-lineage.md).

Before disclosing a payable preparation, `SQLitePrivatePurchaseStore.prepare`
atomically reserves the original signed terms and protected material, a
permanent request fence, the future candidate and complete delivered-result
slots, and every progress completion revision. It bounds the future complete
envelope, including the allowed STEAK and release evidence. It records the
actual native reservation observation and checks the construction cutoff again
inside commit. Insufficient capacity produces no payable preparation. An early
terminal outcome retains unused promised capacity; it cannot silently return
that capacity to another obligation.

Use `discloseTerms` to enqueue the original signed preparation. It restores the
protected original, rechecks current recipient authority and refuses an already
pinned or no-longer-payable preparation at the exclusive cutoff. Mutating a
previously returned local snapshot cannot substitute new terms at this boundary.

## Preserve one purchase and one result

`pin` is an internal effect reservation. Its caller must independently validate
the exact transaction, complete lineage, Script, original request association
and installed domain before calling it. A representation parser or valid seller
signature is insufficient. The store atomically retains one candidate and its
deterministic admission operation. Same-transaction retries recover the first
candidate; another transaction conflicts. New proof variants use the separately installed cumulative evidence owner and
cannot overwrite these first bytes.

An admission intent is not STEAK. Only actual retained topical processing may
advance it to `admitted-delivery-pending`. Save the original selected-topic
STEAK, assessment context and provider's original durable acceptance time. The
optional timed retained-history helper requires this provenance. Mongo derives
the time from the server timestamp atomically saved with the original committed
operation; later recovery cannot manufacture it. Ordinary receipt bytes remain
unchanged. A legacy provider without that time remains usable for its existing
profile but cannot establish the stronger timed premise.

The release owner independently verifies the disclosed policy and rechecks its
premises inside the final native commit. Local admission does not prove mining.
The mined verifier preserves its existing 131072-byte complete-evidence ceiling
and the caller's BEEF byte budget; it accepts a larger actual covenant BEEF only
when both fit. A processor attestation requires the independently selected
identity and registered format. The domain separately validates and issues the
recipient-bound secret or licence.

`complete` atomically saves the exact first signed POTATOES envelope and delivered
state. Recovery returns those original bytes. A newly signed equivalent body is
not a replacement for the first signature. Only delivered results contain
POTATOES and release evidence. A private delivery failure retains the already
accepted STEAK. A local rejection never establishes a global Bitcoin outcome.
An unconstructed preparation may expire; a pinned or admitted obligation remains
recoverable after its original deadline.

## Retain cumulative proof separately

For the complete BRC-196 reference profile, install `SQLitePrivatePurchaseEvidence`
on the same original `PrivateServiceDomain` and contracts, and supply it as the
coordinator's `evidence` option before the first preparation. Explicitly configure
`maximumCandidateBytes`, `maximumUpdates`, `maximumTransactions` and
`maximumDependencies`. The byte ceiling is at most 4194304; updates are 1 through
64, including the first retained proof. The transaction and dependency ceilings
are at most 4096 and 16384. Choose limits that fit the original advertised request
and the native domain's aggregate reserved capacity. A representation ceiling
alone does not establish sufficient physical storage.

Preparation reserves a native encrypted header and enough bounded chunks for
all future candidate bytes and update revisions before any payable terms leave
the host. Each data chunk reserves 197632 bytes and the header reserves 8192;
the number of chunks is `ceil(ceil(maximumCandidateBytes / 3) * 4 / 196608)`.
Include these reservations alongside the immutable purchase store's own originals,
candidate, result and completion capacity. Reservation and original preparation
are staged native transactions. A failure between them may leave a reserved proof
slot without an exposed preparation; do not silently reclaim it or substitute new
signed terms. Preserve its original identity for explicit operator reconciliation.
A database or configuration that cannot hold the complete promise refuses work.

Submission independently verifies the incoming complete evidence, proposes a
bounded union with the retained proof, and independently verifies that combined
view under the original domain and selected chain. It then pins the first immutable
financial candidate and retains the proof. Same-transaction proof variants must
name byte-identical target and shared raw transactions. The union preserves newly
supplied BEEF transactions and shared Merkle rows; it may use plain BEEF with the
same explicit target transaction ID. This does not make added rows truthful:
independent complete Script, genesis, chain and domain checks remain required.
Exact duplicates use no additional reserved update. Exhaustion refuses new proof
without discarding an already retained valid view.

Admission, release assessment and issuance receive the current durable combined
candidate, while financial intent, operation IDs and the first signed delivered
result retain their original bytes. The exact native proof revision is checked
again at the admission effect, after asynchronous release/issuance work and at
result commit. A changed view fails closed. Once delivered, additional valid proof
never repeats admission or issuance or replaces the first result.

A lost financial-pin reply can leave the original reserved proof empty. Recovery
may populate that existing slot only from the exact already retained financial
candidate, after independent incoming and combined validation. A lost proof-commit
reply recovers the original committed view without consuming another duplicate
update. Reads, preparation retries and recovery never create a missing namespace.
Close or reopen both owners with the same persistent identity and limits. The
optional owner is additive: omitted-companion calls preserve the earlier behavior,
but do not claim cumulative-proof support. Existing obligations require their
original custody owner; installing a new empty owner is not an automatic upgrade.

Native storage and coordinator tests exercise large multi-chunk evidence, richer
same-target proofs, native reopening, competing writers, exhausted capacity and
updates, lost replies at both stages, immutable delivered results and proof changes
across admission/release/signing. Their controlled lifecycle domain ports establish
these orchestration boundaries; they do not establish chain truth or real topical
admission. The separate complete domain and host demonstration supplies those
premises.

## Native disclosure and recovery

Use the same explicitly created or reopened `PrivateServiceDomain`, persistent
index/encryption custody, immutable validation policy and sealed limits. Native
records share its encrypted ledger and permanent namespace. Opening a missing
database, missing custody or a surviving fence without its original record does
not create replacement state. Whole-database rollback, physical quota and
independent backups remain operator obligations.

`disclose` checks current recipient authority, native head/record revisions,
original request binding and complete selected response capacity while holding
the writer gate through synchronous enqueue. Prepare and sign HTTP response
bytes first, then recheck the same retained record at physical enqueue. Never
send decrypted `PrivatePurchaseLoaded` material directly from an earlier read.
Current guards and enqueue ports must be synchronous. Drain physical verifier,
admission and issuer work before closing the native domain.

## Compose the optional workflow

`PrivatePurchaseCoordinator.prepare` independently validates the installed domain,
private readiness and current recipient, signs exact preparation terms, and commits
their protected reservation. `submit` verifies the complete candidate before
pinning it. `recover` consults the same original intent and advances only justified
stages. Domain validation returns a locally installed synchronous `checkCurrent`
guard; a caller-supplied boolean or serialized verdict cannot implement this port.
The admission port receives an original-intent guard which it must check before
external effects. Cancellation leaves physically outstanding work counted until it
settles; `stop` aborts new work and drains those physical operations.

`@bsv/overlay/purchase-admission` exports `OverlayPurchaseAdmission`. Install the
Engine, seller, canonical base URL, topic, immutable rules, domain profile and
required successor index explicitly. The bridge restores the original selected
capability, checks exact target BEEF and topic association, reads actual retained
history first and submits only the public transaction when needed. It never sends
protected material to topic/lookup callbacks. A lost submit reply triggers a read
of original history. Missing original commit time or an unknown operation leaves
admission unresolved. This bridge requires prior independent covenant/domain
verification and a reserved private intent; it does not supply those premises.

`@bsv/overlay-express/private-purchase` supplies `createPrivatePurchaseRouter`.
`OverlayExpress.configurePrivatePurchase` installs it using the host's shared
authentication wallet and body ceilings. Mount a standalone router before body
parsers. The explicitly selected routes are `POST /overlay/v1/purchases/prepare`,
`submit` and `recover`, under the configured base path. Prepare returns the signed
terms; submit/recover return the purchase envelope. Each response is authenticated
and its exact bytes are rechecked through `PrivatePurchaseDisclosure` immediately
before enqueue. Current recipient permission shares the native writer gate.
Wrong recipients and missing custody use fixed not-found controls. Basic malformed
transport can be refused before authentication and cannot begin private work.

These endpoints reject HTTP payment headers, never return a BRC-105 challenge, and
expose only authentication/selection headers through credential-free private CORS.
Acquisition, publication and purchase can share one handshake owner; legacy routes
remain available. The application owns closing the coordinator before its native
domain and must preserve unknown public effects for original-operation recovery.

These components have focused signature, progress, SQLite reopen, lost commit
reply, reservation, stale-writer and disclosure tests, plus 300 generated native
interruption histories. Lifecycle fixtures deliberately contain unproved
candidate bytes; they establish custody behavior, not a Bitcoin or admission
verdict. The authenticated HTTP suites use actual BRC-103 middleware and native
custody, with controlled domain/admission fixtures. They establish transport,
recipient checks, staged responses and revoked physical disclosure, not chain
truth. The complete reference covenant/domain/LCH and buyer demonstrations remain
separate checkpoint requirements.

## One original buyer and native wallet action

`@bsv/output-knowledge/private/purchase-buyer` supplies the portable
`PrivatePurchaseBuyer`, its installation-binding helper and initial control value,
and interchangeable payment/validation ports. The independent
`@bsv/output-knowledge/private/purchase-wallet` entry supplies
`WalletToolboxPurchasePayment`, separating native Script/lineage-aware transaction
construction from authenticated HTTP orchestration. Neither entry imports a native
wallet or Node storage implementation. A native host
may supply the existing Wallet Toolbox `RecoverableActionController`; a browser
needs a durable owner exposing the same original-action semantics. A plain
BRC-100 wallet interface cannot establish recovery of a lost action reply.

Compute `privatePurchaseBuyerBinding` from the independently selected retained
capability, original request, installed wallet payment configuration and independent
validation identity. Create protected control and object owners with that exact
binding. Explicit initialization reserves six immutable objects: request,
contract, signed terms, wallet plan, complete signed candidate and delivered result.
The control journal needs at least 16384 bytes; the object installation needs six
slots and a maximum object ceiling of 4194304 bytes. Request/candidate and
terms/result reservations use the original advertised request/response ceilings
within that upper bound. Protect the encryption keys and original store identity,
account for aggregate reserved storage, and back up the owners together.

`initialize` creates only a deliberately selected new operation. `open` checks
the exact original binding, every reservation and retained request/contract; it
does not initialize missing custody or discover a replacement seller. Large
signed lineage and BEEF reside in separate protected objects, rather than the
small control value. Successful retention proves custody only. The application
must supply independent preflight, delivered-material verification and current
usability, for example the covenant LCH domain. A seller signature or STEAK
cannot supply those premises.

Use `recover` for status and lost-reply reconciliation. It never requests new
preparation, allocates or signs wallet funding, or submits a transaction. It can
consult the seller's original recovery endpoint; delivered rights already retained
locally remain readable without another wallet query. Use `advance` only when
the user has explicitly authorized finishing that original purchase. Before new
preparation or funding/signing, it checks current recipient permission, selected
domain, original cutoff and a nondecreasing clock. An already finalized retained
transaction may be submitted after the construction cutoff under the original
recovery promise. This does not authorize constructing a replacement transaction.

`WalletToolboxPurchasePayment` installs the original wallet/storage/chain/originator
and independently selected seller, actual covenant family, chain-view resolver,
verification identity and synchronous current-context guard. It authenticates the
signed complete genesis package and independently checks lineage before creating
a wallet plan and before new native allocation/signing. The permissionless purchase
uses the actual predecessor, required successor/recipient receipt and native
`noSend` action with stable output order. Stored plan BEEF is base64, while native
wallet arguments receive the original bytes. It requests no seller signature and
never broadcasts. Fees and native funding signatures remain wallet obligations.

The current script profile permits at most one native P2PKH change output. Install
the existing Wallet Toolbox managed-change policy with
`maxOutputsPerAction: 1` and `migrationInputsPerAction: 0` for this owner, and preserve
that installation through reopen. Native commission, migration or additional
outputs that do not fit the exact covenant layout are refused. This configuration
does not change wallet defaults or ordinary actions. Before new signing, the
adapter bounds complete BEEF plus the remaining P2PKH unlocking scripts against
its declared `maximumCandidateBytes`, which must fit the originally selected
request ceiling. A refused already prepared action remains an original reserved
intent. The application must report it and use the native wallet's explicit
recovery/abort policy; a timeout or failed capacity check is not an automatic
refund, cancellation or authorization for another payment.

Call `validate` after delivered bytes are retained, then `usableResult` only when
the independent domain has established usability. Reads recheck current permission
and owner identity. Guards must complete synchronously; Promise-valued guards are
refused and rejected promises are drained. `stop` prevents new work, cancels logical
requests and waits for physically outstanding owners to settle. Stop the buyer
before closing protected stores or the wallet, and preserve uncertain original
intents through restart.

Native buyer lifecycle tests cover committed object/control replies lost after
SQLite commit, concurrent owner completion, original cutoff, physical cancellation
drain and rights retained while the original wallet is offline. Separate actual
Wallet Toolbox tests construct and sign the permissionless covenant, recover its
byte-identical transaction after native reopen and verify the complete Script,
authorized genesis and selected synthetic header history independently. Public
synthetic keys and isolated databases are used; no live chain or broadcast is
claimed. Actual authenticated HTTP, retained topic admission and LCH playback
composition remain distinct end-to-end qualification requirements.
