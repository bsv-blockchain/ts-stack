---
id: root-eviction-coordination
title: 'Root Advertisement Coordination'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: experimental
tags: [overlays, sdk, discovery, evidence]
---

# Root Advertisement Coordination

BRC-199 coordinates a root's decisions about serving individual SHIP and SLAP
advertisements. It separates a Bitcoin spend, local serving suppression, broader
operator policy and retention of public history. Each root decides under its own
installed policy. An authenticated peer request supplies attribution and evidence;
it does not grant administrative access or create agreement among roots.

The SDK 2.9.0 source candidate includes the request, status and result contracts in
`@bsv/sdk/overlay-tools/OutputRootEvictionProtocol`, also exported from the root SDK.
The output-knowledge source candidate also supplies a durable local decision journal.
HTTP routes, installed evidence policy and complete serving integration remain under implementation. Importing
these helpers does not enable the profile or modify existing discovery behavior.

## Preserve the selected coordination contract

`RootEvictionContracts`, from `@bsv/output-knowledge/root-eviction`, validates the
exact BRC-194 coordination service `root-advertisements` and BRC-199 profile. Its
trusted configuration supplies the approved HTTPS base, root identity, chain,
finite freshness policy and installed immutable rule validators. It copies the
configuration and registry. A rule IRI names installed code; the helper never
downloads or grants authority from that IRI.

`retain(manifest, selector, now)` verifies the signed manifest at initiation and
returns its owned local retention record, selected service/profile and effective
limits. Sample `now` inside the actual intake decision gate. The manifest may
narrow the fixed maximums of 64 targets, 86,400 seconds and 1 MiB per request/result;
its larger values cannot expand them. Admission must check those selected bounds
and reserve a complete future result, including the maximum permitted blockers,
before accepting the operation. A valid manifest with an impractically small
response budget does not entitle a caller to create an unreportable decision.

Persist the returned record atomically with the original request, frozen decision
policy and capacity reservations. `restore(record, selector)` revalidates that
original selection at its recorded initiation time, even after manifest expiry.
It requires the exact retained digest; a current discovery manifest cannot silently
replace it. Keep original rule validators and authenticated recovery identity
available while obligations remain. Caller/auditor authorization and request expiry
are separate current checks; restoring a contract alone does not authorize effects.

The helper performs no persistence or network calls. The optional coordinated
journal below supplies atomic request/contract persistence. The complete service,
its scheduler and all serving adapters remain required before advertising the
full profile. Never fill a missing historical selection from today's manifest.

## Atomic original-contract storage

`RootEvictionCoordinatedStorage` is an optional companion to the checked journal
port. `SQLiteRootEvictionStore` implements it when configured with
`coordination: { contractBytes: 67108864 }`; an empty coordination object selects
that default. The sealed total may be narrowed to any positive integer up to
64 MiB. Every original retention record is separately bounded to 512 KiB of
canonical UTF-8 JSON. This budget is independent of the existing signed-request
budget, and is a logical data bound rather than the SQLite file size.

`retainCoordinated(request, authenticatedRequester, selection, contracts, guard)`
checks current access, clock, installed policy and external context inside the
shared gate. `selection` contains the current signed `manifest`, exact `selector`
and `futureClockSeconds`. The host supplies that finite clock tolerance from its
own installed policy; it must never copy a client-provided tolerance into this
argument. `contracts` is the trusted local `RootEvictionContracts`
instance, never a callback or saved record supplied by a remote caller. A new
request authenticates its signature and journal identity, selects the original
contract, checks target count, canonical request bytes and lifetime, and reserves
a complete future result under the selected response bound. It commits the
request, frozen evaluation policy and original selection in one SQLite transaction.
If either capacity or persistence fails, neither record is accepted.

Exact retries authenticate the request and compare its immutable body before
recovering the saved contract. They ignore a replacement discovery manifest and
still require the original selector. `resultCoordinated(requester, requestId,
selector, contracts, guard)` returns the owned retained request/contract and current
result with the sampled time and observed head. Request expiry can terminate
pending actions without erasing the original selection or changing completed
actions. Current access still applies, including to any installed auditor role.
These methods neither grant automatic suppression nor evaluate topic evidence.
The HTTP adapter must additionally bound the actual transmitted body, including
whitespace, and sign and queue its response under the final durable fence.

Existing configurations retain the exact `root-eviction/1` seal and behavior.
Explicit coordination configuration creates new files as `root-eviction/2`.
`open` never upgrades a file. For an existing format1 file, preserve a consistent
backup and explicitly call `SQLiteRootEvictionStore.upgradeCoordination(path,
configuration)` with the same root, chain and old capacities plus the coordination
budget. Creation of the contract table, validation of retained inventory and the
seal change commit together. An exact retry validates the already-upgraded file;
a missing format2 table is an error, not permission to create empty replacement
state. Failed migration rolls back the new table and seal.

Every operation checks the configuration inside the transaction, so already-open
format1 connections reject subsequent reads, writes and response queueing after
upgrade. Update all instances before resuming service. The migration preserves
request fences, decisions, bases, assessments, projections and revision values.
Legacy raw requests remain available to the deterministic local methods; they
cannot become protocol operations by attaching a newly discovered contract.
A missing original selection is reported as unavailable. Reverting only the seal,
dropping the contract table or silently rolling back to a stale database is not a
supported downgrade. Broader local-policy enforcement remains a separate layer.

## Validate before evaluating

`parseOutputRootEvictionRequest` owns a complete signed packet, bounds it to 1 MiB,
requires 1–64 sorted unique exact targets and checks closed nested fields. Each
target names `ls_ship` or `ls_slap`, the request's chain and mandatory advertisement
evidence selecting that output. A restore names exactly one suppression basis.
All signed bytes, including BEEF proofs, remain part of the request digest.
Additional proof data needs a new signed request ID or a configured bounded resolver;
it cannot silently replace bytes under an existing request identity.

The optional `SDKRootEvictionEvidence` adapter is available from
`@bsv/output-knowledge/root-eviction/evidence`. Construct it with the installed
immutable chain-view resolver, then call `verify(packet, targetIndex, context,
signal)`. It verifies the request signature, exact advertisement BEEF, current
SHIP/SLAP field signature and derived locking key, service format and complete
locking-script digest. Owner withdrawal also requires the advertiser's identity
and independently verifies both supplied proof variants against the same raw
transaction. Spent evidence must verify and consume the exact advertised output.

The returned owned context, raw transactions and optional mined placements are
facts for the installed policy. They do not grant requester access, prove current
unspentness, authorize lifting a basis or establish a root's acceptance threshold.
An operator-policy reference is returned as a reference; this adapter neither
interprets its text as a URL nor authorizes it. The service must also bind the
authenticated caller and selected capability, retain the policy under which it
evaluates, and fence asynchronous verification against intervening root decisions.
Use the returned placement to enforce the installed chain-acceptance policy;
successful verification of a non-final transaction does not opt the service into
accepting non-final suppression evidence.

Call `verifyOutputRootEvictionRequest(packet, { root, chain, requester })` with the
configured root and chain, and the requester obtained from authenticated transport.
The signature signer must equal that requester. Never fill trusted context from
the same untrusted packet. The helper implements direct submission; a relay needs
separate installed policy, authenticated relay identity and preserved original
requester attribution. Root advertisements alone grant no relay or operator power.

For a new request, `validateOutputRootEvictionWindow` checks the selected maximum
lifetime, future-clock allowance and current time, all expressed as decimal U64
seconds. The protocol lifetime is positive and no more than 86,400 seconds. At
exact expiry a new decision cannot be created under the request. A retained exact
retry instead recovers its existing outcome; do not expire that recovery by
rerunning the new-request clock check. Current access checks still apply.

Evidence bytes remain opaque to the representation parser. Verify the actual
advertisement script and topic rules before using `outputRootAdvertisementDigest`.
Owner withdrawal requires the declared advertiser's authority; spent evidence
requires actual consumption under the selected chain-acceptance policy; operator
policy requires an installed local rule. A descriptive reason never supplies that
authority. Do not fetch requester-provided URLs while interpreting policy evidence.

## Keep the action and serving assessment separate

`parseOutputRootEvictionResult` retains an immutable action outcome separately
from the current serving snapshot. Applied actions have a decision ID and one
affected basis; pending and rejected actions have neither. Blockers are unique and
sorted and keep their original policy digests. An eligible output has no blockers;
a suppressed output has at least one. Unresolved currentness is not eligibility.

`verifyOutputRootEvictionResult(result, originalSignedRequest, retainedPolicyDigest)`
verifies both signatures and the exact request, root, target order and evaluation
policy. Each applied ID binds the root, request digest, service, outpoint and saved
revision through `outputRootEvictionDecisionId`. A suppression affects its new ID.
A restoration affects only the ID named by its request; an already lifted basis
can return no-op with no new decision. The independently retained policy digest
comes from the selected request-evaluation contract, not an unchecked response.

Suppose A and B independently suppress X. Restoring A records that action while
X remains suppressed by B. Replaying that restoration returns the saved action ID
and revision, together with a fresh serving assessment. Even after B is lifted,
the replay must not claim that restoring A also lifted B. A historical signed
result records what that root reported at its issue time; it does not prove
today's serving state, unspentness, finality or compliance by another root.

## The durable journal component

Import the portable journal types from `@bsv/output-knowledge/root-eviction` and
`SQLiteRootEvictionStore` from `@bsv/output-knowledge/root-eviction/sqlite`.
The SQLite implementation uses an ordinary owner-only file, WAL and FULL durability.
This entry requires Node 22.13 or later; the portable type entry does not import
SQLite. Keep the database and its WAL on a local filesystem supported by SQLite,
with all serving instances on that same host. Do not coordinate independent hosts
through a copied database or a shared network filesystem. Each independent root
retains its own decisions and identity.
`create(path, configuration, initialPolicyDigest)` requires a new file. `open(path,
configuration)` recovers an existing identity and rejects missing storage or changed
root, chain or capacities. Use one database file and its shared transaction gate
for every instance serving that root. Separate copies do not coordinate each other.

The default maximums are 4,096 retained requests, 64 MiB of signed request bytes,
65,536 request targets, 64 active suppression bases per output and 4,096 local
assessments. Configuration can narrow these bounds. Target views and pending
projection intents are independently bounded by the target limit. These are logical
record bounds, not a maximum SQLite file size; allow space for pages, indexes and WAL.
Request fences, action history and assessment operation IDs are permanent for the
service identity. The component does not silently collect them. Exhaustion fails
before effects and requires an explicit storage migration or separately identified
replacement service, never deletion and reuse of old request IDs.
Back up the complete database using a consistent SQLite backup or after closing
every writer; copying the main file while a WAL is active is insufficient. Preserve
the signing identity separately. Restoring an older backup can lose request fences
and suppression decisions, so recovery must reconcile that history before serving;
it must never silently initialize an empty replacement under the old identity.

`retain` authenticates the signed request against the supplied authenticated
requester, then applies the new-request clock only when no request fence exists.
A valid signature is still not permission to suppress: the installed service must
check current requester access before calling this port. A changed body under a
retained ID conflicts, including different recipient or evidence bytes. A valid
resignature of the identical body returns the original retained packet. Capacity
admission reserves enough result space for every target, all configured blockers,
maximum revisions and worst-case JSON-escaped status strings. Some large batches
therefore need a smaller configured blocker limit or separate request IDs.

`get`, `basis` and `result` are trusted local reads. They are not unauthenticated
HTTP endpoints. Check current requester/auditor access first, returning the same
not-found response for absence and denial. `basis` exposes the original requester,
request, policy and exact advertisement to the installed restoration policy.
`evaluate` accepts only that policy's completed local evaluation, with an expected
root revision. The evaluator independently verifies advertisement bytes, ownership,
Bitcoin evidence, topic rules and authority to lift the specific basis. The journal
checks the revision and commits all selected outcomes, bases and projection intents
atomically. It does not infer any of those permissions from a request's reason.

Initial pending outcomes retain their original revision. A partial evaluation
allocates one checked U64 revision for its changed targets; later partial work gets
a later revision. Terminal actions are inserted once and cannot be overwritten.
Admission also reserves revision space for every pending target's completion and
possible index acknowledgement. All writers preserve those reservations, including
local assessments and policy changes. Counter exhaustion therefore fails before
accepting work whose recorded outcome could no longer be completed. Stored actions
are checked against their deterministic decision ID, original target and allowed
revision interval before being returned; malformed retained history fails closed.
A result read or evaluation expires still-pending targets at their exact deadline.
The host must schedule these reads/evaluations for outstanding requests; the journal
has no unattended background timer. `changePolicy` rejects remaining pending work
under its frozen old digest, preserves completed decisions and invalidates old
serving eligibility. Fresh local assessment and projection are required under the
new policy.

`assess` records a root-authorized admission, currentness, expiry or reorganization
assessment under a permanent operation ID and evidence digest. It never removes a
suppression basis. The host owns the selected chain context, fresh evidence and
expiry scheduling. Changing the meaning of an assessment ID conflicts. A new
advertisement outpoint is independent; a restored old outpoint still needs valid
currentness and all remaining local policy checks.

`projections` returns durable, revision-bound include/withdraw intents. An adapter
applies an intent idempotently to its actual serving index and coherent live
membership stream, then calls `projected`. A false return means the intent was
superseded. Suppression blocks immediately, even when index removal fails.
Restoration stays unresolved until its include intent is acknowledged. Replaying
an acknowledged intent has no second effect; an old include acknowledgement cannot
clear a newer suppression. The application projector must keep Bitcoin spend
knowledge separate from these source membership changes.

`enqueue` checks a hydrated candidate's root revision, current synchronous
authorization and every exact advertisement under the same SQLite transaction gate
used by decision writers. It then invokes a trusted synchronous callback that queues
all already-signed transport bytes before releasing that gate. Async callbacks are
rejected. The callback must perform the actual final transport enqueue, with no
later signing or buffering wrapper that can postpone it. The included separate-process
IPC test validates this component boundary. A stale cache, snapshot or retained live-log response receives reset-required,
not a filtered response pretending to preserve exact continuity.

## Checked decision observations

The optional `RootEvictionCheckedStorage` interface extends the original journal
port without changing its deterministic methods. The SQLite implementation adds
`retainChecked`, `evaluateChecked`, `assessChecked` and `resultChecked`. Use these
ports when evidence or request preparation happens outside the database lock.

Supply a trusted `RootEvictionCommitGuard` with the selected evaluation policy,
a clock returning U64 seconds, current access authorization, and a check that
the selected external context is still current. These callbacks run synchronously
after the physical SQLite gate has been acquired. Sampling time immediately before
calling an ordinary method is insufficient: lock acquisition may cross the request
deadline. The checked methods sample the clock once inside the gate, check access
before looking up a request key, and reject changed policy or context before effects.
Denial is `not-found`; a stale selected policy or context is `context-changed`.

The callbacks receive an owned, frozen head and the sampled time. They cannot
await, resolve evidence, sign, enter another journal method or mutate policy.
Every access/context writer must share this gate or provide an independently
proven coherent local port. An unrelated permission cache is insufficient.
Bind `contextCurrent` to the same immutable context used for the asynchronous
evidence evaluation; a constant success callback does not establish currentness.

Each successful call returns `{ value, head, observedAt }`. The head is captured
after the operation's own durable effects, including expiry rejection. An exact
assessment retry retains its original action revision while returning the current
head. A result's `issuedAt` uses the sampled time. A stale evaluation revision
cannot prevent an already expired pending request from receiving its terminal
rejection. If external context prevents evaluation, the coordinator must still
perform an authorized current result read or scheduled expiration; it must not
retry an old evidence selection indefinitely.

These are local service ports. They do not authenticate a network caller, select
operator policy, validate chain currentness themselves or sign a result. After
signing, use the observed head in the final transport fence. Passing the commit
checks does not authorize a later response after serving policy has changed.

## Authenticated HTTP response companion

The optional `@bsv/overlay-express/root-eviction-response` entry exports
`guardRootAdvertisementResponse`. It connects the journal's final send gate to
`guardAuthenticatedResponse` in auth middleware 2.3.0. Install it in an authenticated
handler before sending, with the revision captured **before** reading or hydrating
the response and an owned inventory of every advertisement it will disclose.
References in headers count too. It does not discover this inventory from a query
or assume that a response contains only its first output. The journal bounds a
candidate to 1,024 selectors and 4 MiB of body bytes.

Supply `authorize(identityKey, kind)` for a fresh synchronous policy check under
the same journal gate. `kind: 'data'` authorizes the original complete response;
`kind: 'control'` authorizes only a sanitized empty-target error. All access-policy
writers must use this shared gate or a separately proven coherent policy port.
Reading an unrelated asynchronously updated permission cache is insufficient.
The companion's structural journal port accepts `SQLiteRootEvictionStore` without
making this dual-format HTTP package depend on a particular storage runtime.

Suppression during hydration or BRC-104 signing discards the original body and
headers. The companion prepares a complete `reset-required` replacement, captures
a fresh root revision, and rechecks both that revision and control access after
the replacement has been signed. Access denial is represented as `not-found`.
An unavailable journal can produce a bounded retryable service error. Supply all
safe CORS and capability/profile headers through `controlHeaders`; private
candidate headers are never inherited. Another policy change, cancellation or
denied control access closes the response rather than starting an unbounded retry.
A journal failure after native enqueue cannot append another response.

Actual authenticated HTTP tests exercise independent connections to the SQLite
journal, suppression during hydration/signing, access revocation, replacement
churn and recovery errors. Their supplied advertisement facts are trusted synthetic
fixtures; these transport tests do not qualify chain evidence or an installed
root policy. The companion alone does not mount coordination routes, retrofit
existing finite lookups, or guard every cache/snapshot/live/GASP path. Those
integrations remain separate requirements below.

The component's tests cover independent bases, permanent retries, partial batches,
expiry, policy change, divergent local root decisions, result capacity, two actual
process-kill boundaries and exclusion of a separate writer during final enqueue.
The full service still needs the evidence adapter connected to authenticated
HTTP/status policy, broader local blocking-decision records, scheduled reassessment
and every real lookup/cache/snapshot/live/GASP adapter. These remain explicit work
in the implementation tracker; the journal alone is not a complete BRC-199 service.

## Pending recovery and expiry maintenance

The Node entry also exports `SQLiteRootEvictionMaintenance`. Open it against an
existing root database with exactly the same configuration as the journal. It
uses a separate connection to the same cross-process gate, never creates a missing
file, and never upgrades its format. An already-open old maintenance connection
is fenced by an explicit coordination upgrade just like every old serving writer.
The portable optional `RootEvictionMaintenanceStorage` interface does not add
requirements to existing `RootEvictionStorage` implementations.

`pendingPage({ maximum, after }, guard)` returns at most 64 permanent request
digests in strictly increasing order. Its optional `next` is an exclusive local
cursor. It reads bounded references, not proof bodies, and includes requests with
at least one pending target. Completed requests disappear from subsequent pages.
This is a changing worker scan, not a signed snapshot or a new BRC wire endpoint.
When a pass reaches its end, restart without a cursor. New digests before an
in-progress cursor then appear on the next pass. The journal's permanent finite
request capacity bounds a complete pass. A lost cursor or notification is safe:
restart at the beginning and replay idempotently.

`expirePending(digest, guard)` verifies the retained signed request and rejects
only its still-pending targets when its deadline has arrived or its original
policy no longer applies. It reports the indices that expired and those still
pending, with the head and time observed inside that transaction. Completed actions,
original capability records and request fences remain unchanged. Each changed
request gets one decision revision; an exact completed retry allocates none.
A missing retained request is an error, never permission to create a new one.

The maintenance guard supplies a trusted clock and installed root maintenance
authorization. Both run synchronously after acquiring the actual journal gate;
access is checked before disclosing pending references or record existence.
These callbacks cannot sign, await, perform network I/O or reenter the journal.
Maintenance authority is distinct from a requester's current status access.
Revoking the requester does not remove the root's obligation to expire pending
work. Expiry does not need a current chain view: it rejects work and cannot
establish eligibility, apply suppression or restore membership. A broken or
missing original capability does not justify replacing it from discovery and
need not block this separate expiry operation.

A host must run bounded passes on startup and periodically while serving, with
its own scheduling, cancellation and resource policy. Durable intake precedes
any wake notification; an ephemeral lost wake cannot be the only recovery path.
The compiled example performs one bounded page and returns the next cursor to the
host. This companion does not start an unattended timer, process peer decisions,
reassess chain currentness, sign results or install the full coordinator. Those
remain separate integrations. Tests cover generated scan/retry histories, partial
batch expiry, current maintenance authority, format migration, two real process-kill
boundaries and clock sampling after another process releases the SQLite gate.

## Durable service obligations

A complete root implementation must durably retain request fences, independent
decision bases, revisions and audit outcomes. Suppression commits its tombstone
and index-removal intent together. Evidence can remain available for verification
and GASP history while the serving view excludes the output. Never repurpose an
existing permanent-erasure callback as reversible suppression.

Every lookup, cache, snapshot, retained live-log replay and reindex path needs the
same current serving guard. Hydrate the candidate, then under the read guard check
current authorization and every row and queue the complete response bytes. A
suppression takes the corresponding write guard. Bytes already queued cannot be
recalled, but later responses cannot disclose newly prohibited rows. A replay
that would reveal one must reset; silently filtering it cannot preserve its old
continuity claim. These are integration requirements, not guarantees made by the
SDK validators.

Restore only after fresh evidence/currentness and topic-policy checks. Lifting
one decision cannot undo another active block or make a genuinely spent output
current. Policy expiry or reorganization triggers recorded reassessment rather
than blind cache restoration. The initial requester policy remains advisory or
manual until an operator explicitly installs narrower automatic authority.

The [implementation tracker](https://github.com/bsv-blockchain/ts-stack/blob/codex/utxo-application-runtime/specs/output-knowledge/IMPLEMENTATION.md)
records outstanding service and adapter qualification. Existing token formats,
finite lookup, GASP and local administration retain their current behavior.
