---
id: non-final-proposals
title: Authenticated Non-Final Proposals
kind: guide
version: '1.0.0'
last_updated: '2026-10-01'
last_verified: '2026-10-01'
review_cadence_days: 30
status: experimental
tags: [overlays, sdk, proposals, application-state]
---

# Authenticated Non-Final Proposals

The optional BRC-194 proposal service stores an author's signed application
intent in a separate private channel. Recording a proposal does not spend an
output, admit a transaction, authorize payment or establish Bitcoin finality.
An explicitly authenticated finalization request reserves one exact transaction
and recovers its ordinary topic admission. Applications display that lifecycle
separately from their verified output state.

## Compose the components

Install immutable proposal policy implementations in `ProposalPolicyRegistry`.
`AuthorDocumentPolicy` is the supplied concrete example: an author maintains a
small document for fixed recipients and may explicitly finalize it through the
specified PRP1 transaction relation. It does not enable arbitrary partially
signed transaction protocols. Another domain installs its own exact registered
policy and advertised parameters.

Construct `ProposalTransitions` with the selected chain, topic and finite clock
policy, then provision a dedicated `SQLiteProposalJournal`. Keep the journal,
service identity and installed policy configuration together. The host owns
storage creation, verified restart recovery, backups and worker shutdown. Losing
terminal channel fences requires retiring the namespace identity; recreating an
empty file under the old identity is not recovery. Capacity exhaustion never
permits deleting those fences or discarding unresolved admission obligations.

`ProposalService` receives the journal, original capability trust, current
manifest snapshot, clock, current access policy, evidence verifier and admission
adapter. `SDKProposalEvidence` verifies actual transaction evidence against an
installed immutable chain view. `OverlayProposalAdmission` from the optional
`@bsv/overlay/proposal-admission` entry recovers retained ordinary Engine receipts.
Configure Engine admission-history retention first. Legacy receipts without
original provenance remain unresolved; an empty duplicate STEAK is not proof
of rejection or a substitute for an original receipt.

Use `ProposalResponseDisclosure` with the same lifecycle, trust, clock and
current synchronous access policy. The service makes the durable decision; the
disclosure companion reconstructs the allowed response from a fresh record at
native enqueue. Every proposal writer shares the journal gate. Authorization
changes must use that same gate or an explicitly coherent local policy domain;
independent databases do not become atomic merely because both adapters expose
an asynchronous method.

## SQLite composition and rollback

The Node journal and lookup adapters share an internal synchronous transaction
implementation. Each ordinary constructor still owns its own connection and
preserves its existing namespace format. A journal and index opened separately,
even at the same file path, are not one compound writer.

Within an explicitly composed connection, SQL changes and private journal caches
follow the same transaction and savepoint boundaries. Cache publication follows
physical commit. Rolling back a nested session operation discards its staged
journal state as well as its SQL, while retaining the session's observed clock.
A failed rollback retires an uncertain connection; an acknowledged native
transaction boundary can distinguish a lost commit acknowledgement for recovery.
Final-send failures use the stricter connection-retirement rule because delivery
cannot be undone. These implementation ports are internal, synchronous, and not
an authorization mechanism or a public raw-SQL extension point.

The private current-channel query companion remains under construction. The
shared storage primitive alone does not install its writer, policy, lifecycle
timers, retention promises, visibility guards or current-channel projector.
Existing proposal and finite lookup routes retain their existing behavior.

## Add authenticated HTTP

Import `createProposalRouter` from `@bsv/overlay-express/proposals`. Supply the
service, disclosure companion, the **same** journal, the concrete HTTPS base,
the origin's BRC-103/104 middleware and a synchronous `authorizeControl` callback.
That callback permits only sanitized protocol errors. Current data access remains
the disclosure companion's responsibility. A missing record never grants access.

Mount the router at the application root before body parsers, compression,
caches and payload logging. It appends `/overlay/v1/proposals/put`, `/get` and
`/finalize` to the canonical selected base path. It can handle the shared
`/.well-known/auth` handshake; when another companion owns that route, set
`handleHandshake: false` and share its middleware instance. The host supplies TLS,
pre-authentication rate limits, server deadlines and bounded authentication and
signing. Public CORS is credential-free by default. An explicit origin array
selects an exact allowlist; it does not replace authentication.

For native Overlay Express integration, call `configureProposals` before `start`
and supply the matching serving wallet identity. The host loads the optional
adapter lazily, verifies that identity and shares one authentication instance,
handshake and request-capacity layer with other enabled companions. It inherits
host origin policy unless explicitly overridden and clamps adapter byte ceilings
to host limits. Existing `/lookup`, `/submit` and default startup remain unchanged.

Advertise only installed capabilities whose request and response budgets the
entire host path can honor. This router permits at most one MiB per request and
four MiB per data response; the original selected contract may require smaller
bounds. Requests carry the exact capability digest/profile headers and
`Cache-Control: no-store`. Responses echo the selection under BRC-104 and use
`private, no-store`. The adapter does not publish a manifest or enable a profile
automatically. No proposal endpoint charges through BRC-105.

## Recover exact operations and disclose current state

Persist the signed proposal and selected capability before dispatching a put.
An acknowledgement means the proposal was durably recorded. Identical retries
can recover an older retained acknowledgement even after a newer revision has
become the channel head, under current authority and the original retention
promise. They never replace that newer head or consult new discovery to invent
a replacement contract.

Get reads the current authorized channel. Response signing happens outside the
journal lock. Immediately afterward, the disclosure validator checks the actual
signed body against the fresh record under the writer lock and enters the native
response queue before releasing it. A concurrent revision, expiry or revocation
withholds stale data. At most one sanitized replacement error is signed, then
its current control authorization is checked again under the same gate.

An active get is invalid at signed expiry even if a timer has not fired. The
ordinary get path commits expiry on retry. Run bounded startup and periodic
expiry work independently so private projections also stop showing expired
proposals without a new request. Reconcile retained finalizing jobs by their
original identity. Finalization reservations survive proposal expiry and caller
disconnect; neither condition proves that ordinary admission rolled back.

The router bounds transport requests and physical service operations separately,
including per-principal work. Disconnect and deadline stop response delivery;
stalled service work retains its slot until it settles. A native enqueue attempt
may have delivered even if a later acknowledgement fails. Never send a replacement
or create a new transaction to repair that uncertainty: recover the original
operation and its durable admission result.

## Explicit startup and bounded recovery

Use `SQLiteProposalJournal.create` during an intentional installation and
`SQLiteProposalJournal.open` for subsequent starts. Creation rejects an existing
namespace. Opening requires the file, namespace, service identity, lifecycle
configuration, capacity seal and retained history to agree; it does not initialize
missing service state or repair a missing seal. The existing constructor preserves
its create-or-open behavior for compatibility. A failed startup is an operational
failure requiring investigation, never a reason to delete or replace the journal.

`ProposalJournalMaintenance` adapts the private durable journal to the portable
`ProposalMaintenanceSource` interface. Each bounded page contains current channel
and proposal identifiers and an active/finalizing state hint. It does not expose
the signed proposal, private context or transaction. Its local continuation binds
the namespace and service identity and captures the journal's high-water revision
so concurrent appends cannot extend a pass forever. Updates discovered during a
pass are re-read through the current indexes; a changed index is retried on a
later pass. Missing retained history or required indexes fails explicitly. These
identifiers remain private operational metadata and must not be published as an
unauthenticated inventory API.

The optional `ProposalScheduler` takes that source and the existing service's
`expire` and `reconcile` ports. It has no method for creating a finalization,
signing a transaction or funding a wallet action. Constructing it starts no work.
`runOnce` processes one bounded page; `start` performs startup and periodic passes,
and `wake` is only a coalesced hint. Lost hints are recovered by the next scan.
Each service call independently reads and validates the retained state. Inventory
entries and cursors never grant authority to perform a new action.

Defaults are 64 journal entries per page, four outstanding recovery calls and a
one-second interval. Hosts can configure up to 256 entries, 64 recovery calls and
a 60-second interval. The scheduler deduplicates each physically outstanding
proposal recovery and keeps its slot until the call actually settles. Pending
recovery calls do not block expiry scans. Reports distinguish expiry checks,
newly owned recovery jobs, settled calls, still-retained jobs and individual failures;
a settled recovery call does not by itself prove admission or Bitcoin finality.
Inspect the service's durable state for the actual result.

Observe the `start` promise. An inventory or observer failure stops intake rather
than manufacturing an empty successful pass. An expiry failure is reported while
other independent items continue. Recovery failures remain queued until a valid
pass or shutdown report can return them, including if the next inventory read
fails. A host observer must not await `stop` from within its own callback.

Shutdown calls `stop`, observes its final report, and only then closes the service's
journal and admission dependencies. The returned promise drains the real scan and
recovery calls; there is no pretend cancellation of an admission that might
already have committed. A dependency that never settles keeps shutdown pending,
so hosts must supply bounded I/O and an operational shutdown policy without
releasing its ownership early. Multiple workers may observe the same reservation;
the journal's compare-and-swap and the admission adapter's idempotent recovery
remain responsible for safety across processes.

The reference journal continues retaining its full history, terminal channel
fences and operation identities. This scheduler does not implement compaction,
configuration migration, a remotely resumable private subscription, or a new
protocol profile. Reaching capacity must remain explicit until a qualified
retention/compaction adapter preserves those contracts.

## Receive proposals in an application journal

Install `ProposalSourcePolicy` from `@bsv/output-knowledge/proposals` and pass it
as the optional `proposals` setting of `BitcoinKnowledge`. Each rule selects one
exact chain, provider, service, query digest, rules digest and access partition,
plus the installed proposal policy, maximum signed lifetime and permitted future
clock skew. The configured reader must be permitted by that policy. Epoch remains
part of each received observation's identity; changing an epoch does not silently
select a different policy. Current provider authorization is still enforced by
the authenticated source and private service.

The current observation contract requires the lookup source's service name and
the proposal service name to agree. A capability may advertise the same name for
different service kinds. The core rejects a different-name mapping before opening
proposal state; it does not reinterpret an existing wire contract. A later query
profile may define richer relationships through an explicit compatible extension.

Receipt and acceptance are separate commits. Receipt retains the exact signed
envelope variant and its first local receipt time, independently of the provider's
reported arrival time. Bounded worker passes check signatures and installed
permission under the same count, cancellation and deadline budget as Bitcoin
verification. Each retained result binds the source group, observation and exact
envelope. Replaying a committed result checks those bindings without repeating
signature verification. Invalid, unsupported or unauthorized proposals quarantine
the whole group, including any Bitcoin observations alongside them. Operational
failures remain failures rather than becoming negative signature results.

Accepted snapshots expose `input.proposals` alongside the existing Bitcoin facts
and assessments. `heads` contains authenticated signed variants with their source,
generation, first local receipt time, lifetime and continuity. The name does not
mean that any variant is the channel's current head. Historical lookups may return
earlier proposals. `states` and `removals` remain attributable provider reports;
each must refer to an authenticated proposal in the same source generation,
either within its atomic group or an already published accepted group. Acceptance
behind an unresolved membership gap does not establish that supporting publication.
Contradictory signed withdrawal or expiry assertions quarantine the group.

This generic view selects no global winner, reconstructs no complete predecessor
history and authorizes no wallet, admission or private-release effect. A current
channel view requires a separately installed query contract that defines its
snapshot, ordering, replacement and removal semantics. Applications must not infer
currentness from lexical ordering of IDs or from a provider reporting `active`.

Proposal-enabled journals use a distinct local frame version 4 containing the
unchanged version-3 Bitcoin frame, sealed source/reader/policy configuration,
receipt times, verification results and a monotonic evaluation time. Use a new
journal namespace when adopting this mode or changing that installation. Retain
the old journal for audit and recovery; neither enabling nor disabling this option
silently rewrites existing history. Omitted `proposals` retains the existing local
formats and behavior, including leaving proposal groups unaccepted.

Signed expiry is exclusive. A durable accepted reevaluation changes `unexpired`
to `expired`; a backward clock adjustment cannot revive it. `KnowledgeStore.read`
and `watch` reject stale current or historical publication until that reevaluation
commits. Raw journal inspection remains available for audit. The runtime schedules
the worker's earliest deadline, and allows one bounded recovery pass if expiry
crosses between worker completion and the read. A worker that cannot establish a
fresh view fails explicitly; it does not trigger an unbounded retry loop. Expiry
never cancels an already reserved finalization or converts a provider report into
a locally verified admission result. Applications must also retire activity that
they have already rendered when its displayed deadline passes.

The [compiled client example](./compiled-package-examples.md#receive-authenticated-proposal-observations)
shows this composition with injected source selection, storage and Bitcoin
verification. A registered private query, its projection producer and native
disclosure bridge are separate host integrations.

## Validation and remaining integration

The reference tests use actual authenticated local HTTP, the durable SQLite
journal and real response signing. They exercise revocation, expiry and revisions
during signing, current error authorization, independent readers, cancellation,
framing limits, retained acknowledgements and unchanged finite lookup behavior.
Generated schedules vary these boundaries together. Separate Engine/Mongo tests
qualify ordinary admission receipt recovery.

Complete checkpoint-two qualification, configuration evolution,
retained-fence compaction and application projection
integration are tracked in the [implementation record](https://github.com/bsv-blockchain/ts-stack/blob/codex/utxo-application-runtime/specs/output-knowledge/IMPLEMENTATION.md).
The endpoint adapter alone does not complete those service obligations. The
[compiled examples](./compiled-package-examples.md) verify public package wiring.

## Recover a saved operation from the SDK

`OutputProposalTransport` is an optional SDK3 client for one saved `put`, `get`
or `finalize` request. First select a fresh capability under independently
installed provider identity, HTTPS endpoint, chain and service rules. Save its
`retainOutputCapability` record together with the complete request before the
first dispatch. Reconstruct the client from that integrity-protected local
record after a restart. `send(signal)` always uses the same owned request; it
never discovers a replacement provider, changes an operation ID, polls, signs
a proposal or transaction, funds a wallet action, or persists a result.

The client authenticates the selected provider and exact profile/contract
headers, disables automatic BRC-105 payment, and bounds request bytes, response
bytes, headers and total time. Cancellation releases the caller but retains
physical I/O ownership until the underlying request settles. An uncertain send
can have committed on the server. Retry its original request to recover that
outcome; do not create a new operation to work around uncertainty. HTTPS provides
confidentiality independently of BRC-103/104 message authentication.

A publication acknowledgement must match the original proposal digest and signed
expiry. Retrieval verifies the author's signature, selected service/chain/policy,
queried channel and lifetime limit. An active result is unusable at its exclusive
signed expiry according to the caller's trusted clock. Terminal history can remain
available afterward. An authenticated response is still separate from application
policy acceptance, Bitcoin verification and current authority.

Finalization returns `{ response, matchesRequest }`. A provider may already have
reserved finalization for the same proposal under another authorized operation.
The client reports that original reservation, with `matchesRequest: false` when
its operation ID or transaction ID differs from the saved request. Show and
reconcile that outcome; do not treat it as fulfillment of the caller's requested
transaction. Even a matching `finalized` response records historical topic
admission and does not establish mining, current unspentness or entitlement to
private delivery.

A validated provider error is `OutputProposalServiceError`, carrying its bounded
`packet`. Local framing, byte-limit, authentication, cancellation and transport
errors remain distinguishable; for example, response-body overflow preserves
`LookupResourceLimitError`. None are a successful empty result. Restoring an old
selection permits original recovery only. It never authorizes a new effect under
an expired manifest or bypasses the provider's current access and retention rules.

The HTTP integration tests use this client with real mutual authentication,
native SQLite disclosure, post-signing access changes and serialized original
operation recovery after discovery changes. The evidence/admission ports in that
component fixture are synthetic. The separate reference application's
`test/proposalPipeline.test.ts` composes the public client and HTTP adapter with
actual SDK Script/SPV verification, a real Topic Manager and Engine, retained
Mongo admission history, SQLite proposal state and the recovery scheduler.

The pipeline first puts and reads a private signed document without invoking
ordinary admission. It rejects another authenticated identity and invalid Script
evidence. A valid explicit finalization then commits through Engine; an injected
loss boundary prevents the returned receipt from reaching the proposal journal.
After closing and reopening both adapters, the scheduler finds the retained
reservation and recovers the original Engine history without another submit.
It does so after proposal/manifest expiry, with current caller access revoked and
discovery/evidence resolution unavailable. This is completion of an existing
reservation, not authority to start a new one. Once caller access is restored,
the saved original SDK request retrieves the same admission result and assessment
identity.

Run this example using the [workbench instructions](./output-knowledge-workbench.md).
It uses public synthetic keys and a pinned test chain, not live funds or a
consensus node. The HTTP fixture maps the selected HTTPS origin to an owned
loopback listener while preserving actual BRC-103/104 authentication; it does
not qualify TLS termination or production deployment. Interactive private
subscriptions and admission-driven lookup projection remain separate work.
