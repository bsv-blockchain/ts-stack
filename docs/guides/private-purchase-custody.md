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
`SQLitePrivatePurchaseStore` for the proposed BRC-196 companion. Compose them with
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
candidate; another transaction conflicts. New proof variants require an
explicit evidence/reconciliation owner and cannot overwrite these first bytes.

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
