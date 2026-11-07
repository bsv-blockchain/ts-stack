---
id: verified-private-publication
title: 'Verified Private Publication'
kind: guide
version: '1.0.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
review_cadence_days: 30
status: experimental
tags: [overlay, custody, recovery, wallet]
---

# Verified private publication records and native lookup binding

This optional Node composition implements the publication part of BRC-195: original
signed capabilities, exact Bitcoin evidence, protected publication records, native
lookup binding, bounded recovery and authenticated publisher-facing status.
Installed publisher/schema validation and current authority remain explicit host
policies. Calling a storage method does not authenticate a publisher or prove a
decryption key matches its content. Paid acquisition and purchase fulfillment are
separate owners, still required for the full private-overlay program.

## Keep each authority explicit

`SDKPrivatePublicationEvidence` checks the requested Bitcoin output with the real
SDK Script/SPV verifier and an immutable host-selected chain view. It retains the
complete verification context and the exact raw target transaction. It also
requires that the BEEF's default transaction is the requested target; finding the
requested transaction elsewhere in an aggregate cannot redirect Engine submission.
Incomplete ancestry remains unresolved. Cancellation, deadline and changed-view
outcomes are not acceptance. Private bytes never become chain-resolver input.

The installed domain validator must independently authorize the publisher and
bind the asset, public output, schema, private values and key/content relationship.
Its immutable identifier and digest are retained with the verification result.
Neither the caller's claim nor a schema identifier downloads or installs code.
Current authorization and the validity of the verification premises must be
checked again before reservation, admission, binding and disclosure.

`PrivatePublicationContracts` owns the installed seller, chain, endpoint, topic,
service, rules and allowed schema/capacity configuration. New work selects a signed
BRC-101 capability at the current time. Recovery replays its original retained
selection and freshness policy. Manifest expiry prevents new selection but does
not erase an existing obligation. A new discovery result cannot overwrite the
original contract. Retained contract parsing proves those structural and signed
relations; it does not assert present-day authority or Bitcoin unspentness.

## Reserve the complete operation before its effect

The optional third argument to `SQLitePrivatePublicationStore` installs verified
publication semantics. Its original two-argument construction and `stage`, `load`
and `advance` behavior remain available. The verified path is explicit:
`stageVerified` atomically reserves a protected blob, a versioned request fence
with the original contract, and an inactive lookup binding. The binding address
uses a separate HMAC purpose and the exact blob plus installed lookup service and
rules. It is not selected by an incoming record key.

A `private-publication-fence/2` owns the original signed capability, exact target
transaction, complete verification context and immutable validation-policy
reference. A version-1 fence remains readable through the original storage path.
The verified path cannot invent its missing original verification history. A
future migration must preserve the permanent semantic fence and explicitly
reconcile that history; it cannot silently restart the publication.

Preflight reserves the whole future binding and progress envelope, including
admission evidence, the lookup receipt, maximum timestamp and escaped reason
bytes. It separately reserves native record bytes and completion revisions.
Insufficient capacity rejects all initial records together, before admission.
Exact retries preserve the saved contract and material. Two request IDs can share
byte-identical material and a binding while keeping independent fences. Changed
private values for the same exact blob identity conflict.

## Retain admission and commit readiness together

After an admission reservation is durably committed, the private Engine bridge
submits or recovers the same operation. The bridge's original retained receipt
binds the selected topic and output. A duplicate submit's empty STEAK is not that
receipt. Public admission reuse is a separately configured migration policy and
requires independent private validation.

Positive membership moves the publication to binding-pending. `bindVerified`
activates the exact protected lookup binding and commits ready progress in one
native transaction. Its receipt binds the publication ID, semantic request,
shared blob and lookup service/rules, as well as the original admission. An
already active identical binding can support a second request fence, but the
receipt remains specific to that publication. An arbitrary caller-provided
receipt cannot make a version-2 fence ready.

Definitive negative selected-output membership is retained as an internal
`excluded` outcome and projects to BRC-195's existing `rejected` status. It keeps
the original assessment rather than claiming the transaction had no public
effects. Uncertain admission remains pending. A deadline can expire work before
an external-effect reservation; it cannot assert rollback after that reservation.

Independent connections use native global and record revisions. A stale worker
or authorization revoked at the physical commit cannot activate only half the
binding/readiness pair. `loadVerified` reloads the fence, blob and binding in one
current view and checks their relations with the installed contracts. Readiness
loss retains the original evidence; restoration must recover that same material
and binding. A currently readable private key does not itself prove a listing is
unspent or that a paid acquisition is authorized.

## Recovery and disclosure are separate duties

A bounded reconciler discovers stored work, reloads its current revision and
continues the original operation. It must wrap enumeration so that insertions
behind an earlier cursor are eventually visited. A missing blob, key, original
contract or binding cannot become ready through public GASP reconstruction.
Private replication needs its own receiver authorization and protected transport.

Publisher-facing status is only the bounded BRC-195 publication result. The
internal native loader returns protected material to trusted local service code;
it is not a remotely callable status operation. Authenticated routes must return
not-found for inaccessible records and recheck current authority, original
selection and exact response bytes at the physical network enqueue after signing.
A result prepared earlier is not permission to send it later.

Protected lookup availability supports new quotes only when the corresponding
material and binding are available. A funded or reserved acquisition has its own
frozen terms, retained material and recovery obligation. Catalogue withdrawal,
publication eviction and public-output garbage collection do not authorize
removing that material. Paid acquisition and purchase/POTATOES owners will use the
same authoritative seller/chain domain while keeping their state and funding
fences separate.

## Validation boundary

The local native tests cover independent reopen, full original-contract retention,
shared material, conflicting bytes, retained selection on retry, stale-worker
conflicts, commit-time denial, exact readiness restoration and excluded admission.
Actual SIGKILL tests reopen staged, admitting, binding, ready and unavailable
states. Generated restart/revocation schedules exercise all native transition
boundaries. The complete legacy publication suites remain part of qualification.
Real Script/SPV evidence tests use signed synthetic Bitcoin transactions and an
immutable chain fixture. No funded operation or live deployment is involved.

Actual Engine/Mongo and authenticated HTTP tests additionally exercise retained
admission after a lost reply, original-contract recovery after restart and manifest
expiry, private off-chain values, compatibility with an ordinary lookup route,
and revocation or readiness changes during response signing. Generated native and
HTTP schedules retain a minimum of 300 cases. This evidence qualifies individual
composition behaviors; complete mutation, platform, package and exact-head CI
qualification remain required before the checkpoint is complete.

## Install the service and transport explicitly

The optional `@bsv/output-knowledge/private/node` entry exports the Node custody,
publication store, contracts, evidence adapter, coordinator, disclosure and
reconciliation components. The separate
`@bsv/overlay-express/private-publication` entry exports
`createPrivatePublicationRouter` and its structural service/disclosure options.
Both are opt-in. Existing package roots, finite lookup routes and ordinary
submission behavior remain unchanged. This composition requires the SDK 3.3.0
candidate and authentication middleware 2.3; it adds no SDK requirement to
ordinary legacy Overlay Express imports.

Use one protected `PrivateServiceDomain` for the authoritative seller and chain.
Its creation is an explicit provisioning decision. Restart with `open` and the
same retained index-key identity, domain configuration and payload custody;
opening missing state fails. Back up the database and protected custody together.
An independent database does not share funding uniqueness or obligations merely
because it uses the same seller key. Private replication must preserve the
original records and enforce receiver authorization separately from public GASP.

`PrivatePublicationCoordinator` accepts structural storage, evidence, admission
and worker ports. A replacement adapter must preserve the semantic request fence,
complete original contract, native multi-record atomicity, exact revisions,
capacity reservations and current-authority checks. These are behavioral
requirements, not satisfied just by implementing TypeScript method names.
`PrivatePublicationDisclosure` is the SQLite reference final-response owner: every
writer and policy change affecting visibility must participate in its shared
native transaction domain. Another backend needs an equivalent atomic disclosure
owner as well as storage methods.

The installed domain validator checks publisher authorization, asset/schema
binding and the private value's relationship to the content. The real SDK evidence
adapter verifies the exact output under the selected immutable chain view.
`PrivatePublicationVerificationLeases` retains that complete checked context for
the actual Engine operation and exposes only a bounded local reference to the
admission bridge. A lease is not a wire credential, an authentication substitute,
or independent verification. Its currentness callback must check the retained
premises, including policy changes, on every use.

The Engine bridge must use retained admission history and the same selected topic,
service and rules. It carries existing off-chain values through the ordinary
topic-manager interface. Its public-history reuse setting is an explicit local
migration policy. Public STEAK and protected lookup readiness are retained
separately; a repeated submission's empty receipt cannot replace the original
admission assessment. The
[compiled installation examples](compiled-package-examples.md#compose-verified-private-publication)
compose the actual Engine bridge, native store, coordinator and response owner.

## Recover without the original request staying connected

`PrivatePublicationWork` provides a finite private work inventory under explicit
local-worker authority. `PrivatePublicationReconciler.runOnce` processes one
bounded page and wraps the cursor so later passes discover inserts behind it.
`start` is an explicit optional loop with an observable completion promise and
sanitized per-publication outcomes. It reuses original reservations after manifest
expiry and uncertain Engine responses. It neither impersonates the publisher nor
requests a new capability for an existing obligation. Missing original history
remains unresolved.

HTTP callers and reconciliation have bounded work ownership. Cancellation or a
deadline stops caller waiting and prevents further authorized effects, but does
not release a physical slot while the underlying call is still running. Stop
accepting requests, stop and await the reconciler, drain `coordinator.stop()`, then
close storage and custody. Swapping callbacks or closing the database under a
live operation is not a supported reconfiguration procedure.

## Report protected-material loss truthfully

A ready publication must have its exact protected material and active binding.
The store's metadata-only `loadStatus` path reports an unchecked internal view;
that method alone never establishes readiness. Coordinator and disclosure first
authorize the original publisher and selector, then verify the complete ready
records. When the material or its decryption key is unavailable, they durably
advance the original fence to unavailable under revision and authority guards.
The original request, contract, admission, lookup receipt and remaining recovery
obligations remain retained. No key or payload is recreated automatically.

Separating metadata custody from material custody permits an authorized unavailable
status when only the material key is lost. If metadata itself cannot be decrypted
or authenticated, the service fails closed; it cannot invent an unavailable
record from a caller's assertion. Opening the protected ledger still checks the
complete retained inventory and requires its payload keys. This metadata-only
status fallback applies to an already opened owner; missing startup custody fails
startup instead of creating a new namespace. Wrong publishers and wrong selectors cannot
trigger a state transition or receive protected details. Explicit restoration
must recover the same material and binding before the original publication can
return to ready. Existing funded acquisitions have separate retention duties.

## Bind the authenticated response to its native enqueue

Mount the router before generic body parsing, compression, caches and response
transformations, using the origin's single BRC-103/104 authentication instance.
It strictly decodes received UTF-8, enforces the selected raw request limit and
profile maximum, binds the publisher to the authenticated peer, and requires the
exact signed capability/profile headers. Public cross-domain credential-free
CORS remains the default; explicit origins are optional. Unknown paths pass to
the host without changing existing routes.

Publish and status results contain only the bounded BRC-195 projection. The
disclosure companion reloads the original contract and current state after HTTP
signing and keeps its native gate through the single synchronous enqueue. Changed
authority or readiness withholds the prepared body. At most one sanitized fixed
control replacement may then be signed, with fresh control authority checked
before sending. After any native enqueue attempt, an error closes the operation
without retrying delivery. Deferred, asynchronous or repeated enqueue callbacks
are rejected. Domain-validator exception text and protected payloads are never
serialized into public errors.

This router does not install a catalogue, paid lookup, purchase/POTATOES owner or
playback implementation. Those owners compose the same authoritative domain while
retaining their own terms, payment fences and fulfillment obligations. Publisher
status is not an entitlement to receive a song key or other protected value.
