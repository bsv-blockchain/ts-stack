---
id: non-final-proposals
title: Authenticated Non-Final Proposals
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

## Validation and remaining integration

The reference tests use actual authenticated local HTTP, the durable SQLite
journal and real response signing. They exercise revocation, expiry and revisions
during signing, current error authorization, independent readers, cancellation,
framing limits, retained acknowledgements and unchanged finite lookup behavior.
Generated schedules vary these boundaries together. Separate Engine/Mongo tests
qualify ordinary admission receipt recovery.

Complete checkpoint-two qualification, startup recovery/expiry scheduling,
configuration evolution, retained-fence compaction and application projection
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
fixture are synthetic, so this does not yet establish the complete Engine-backed
pipeline or production deployment readiness.
