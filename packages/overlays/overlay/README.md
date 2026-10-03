# @bsv/overlay

The core engine and storage contracts for BSV Overlay Services. The engine admits
transactions through topic managers, maintains UTXO state, serves lookup
services, and supports SHIP, SLAP, GASP, and BASM synchronization.

Use [`@bsv/overlay-express`](../overlay-express/README.md) when you want the
standard HTTP server, operational endpoints, edge policy, and health checks.
Use this package directly when you are embedding the engine in another runtime
or implementing a custom transport.

Knex storage maps SQL `NULL` block heights to absent confirmation metadata. It never invents a confirmed height; malformed non-null values still fail engine validation.

## Requirements

- Node.js 22 or newer
- `@bsv/sdk` installed as a peer dependency
- A `Storage` implementation
- A `ChainTracker`, or the explicit `'scripts only'` validation mode

## Install

```bash
npm install @bsv/overlay @bsv/sdk
```

## Create an engine

```ts
import { Engine, KnexStorage } from '@bsv/overlay'
import type { LookupService, TopicManager } from '@bsv/overlay'
import knex from 'knex'

const database = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL
})

const topicManagers: Record<string, TopicManager> = {
  tm_example: exampleTopicManager
}

const lookupServices: Record<string, LookupService> = {
  ls_example: exampleLookupService
}

const engine = new Engine(
  topicManagers,
  lookupServices,
  new KnexStorage(database),
  chainTracker,
  'https://overlay.example'
)

await engine.submit({
  beef: transaction.toBEEF(),
  topics: ['tm_example']
})

const answer = await engine.lookup({
  service: 'ls_example',
  query: { txid }
})
```

The constructor also accepts SHIP/SLAP trackers, broadcasters, an advertiser,
sync configuration, a logger, a topic-anchor header resolver, and BASM/unproven
state controls. Type declarations document the complete configuration surface.

## Public API

The root entry point exports:

- `Engine`
- `KnexStorage` and `KnexStorageMigrations`
- the topic-manager, lookup-service, storage, advertisement, and sync contracts
- BASM utilities and types
- safe structured-log serializers

`@bsv/overlay/storage` exports the `Storage` contract. Existing supported deep
imports remain available through the documented package export map, but new
applications should prefer the root entry point wherever possible.

## Optional persistence capability

`AdmissionStorage` defines an additive v1 atomic admission contract for optional
adapters. `storageHasAdmission(storage)` reports whether the optional
`admission` field is present. `getAdmissionStorage(storage)` detects an explicit provider with both
commit and reconciliation methods. Existing Knex and injected legacy adapters
remain supported; their individual methods do not imply atomic submission.
When `getAdmissionStorage(storage)` observes a complete `overlay-admission-v1`
provider, `Engine.submit` builds an admission plan and returns the saved STEAK
only after majority commit. The SQL/Knex path and its early STEAK callback are
unchanged; that callback is not a durable commit receipt.

The contract separates local commit, index visibility and propagation. It binds
operation identity to verified transaction, topic/policy and off-chain context;
uses ready payload references and outbox intents; and fences recovery by both
chain epoch and topic history generation. Helper functions and shared fixtures
pin exact integers, deterministic identity, leases and cursor eligibility.
See the [persistence specification](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/overlay/persistence-v1.md).
No consumer migration, storage-default change or database migration is included
in this release candidate.

## Optional Mongo foundation

The package also contains an opt-in MongoDB foundation for schema bootstrap,
content-addressed payload publication, reference guards, payload collection,
and an explicit `AdmissionStorage` adapter. Mongo is not the default Engine
storage selection; importing `@bsv/overlay` alone does not load MongoDB.

Applications using a Mongo deep entry point install the optional peer first:

```sh
npm install @bsv/overlay mongodb@^7.5.0
```

The initial entry points are
`@bsv/overlay/storage/mongo/MongoSchema`,
`@bsv/overlay/storage/mongo/MongoPayloadStore`,
`@bsv/overlay/storage/mongo/MongoAdmissionStorage`, and
`@bsv/overlay/storage/mongo/MongoOverlayStorage`. They require an explicitly
operated unsharded replica set; the supported deployment profile is three
members. Payload publication makes GridFS bytes physically `published` before
the guarded payload row becomes `ready`; caller-session reference and GC
operations share that row guard. See the [Mongo v1
foundation](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/overlay/mongo-v1.md)
for operational bounds, recovery rules, and the opt-in admission path.

## Optional retained admission history

Construct `MongoOverlayStorage` (or its admission adapter) with
`{ retainAdmissionHistory: true }` to preserve the original immutable admission
identity with **new** durable receipts. The default remains false.
`getAdmissionHistory(storage)` detects the separate
`overlay-admission-history-v1` capability; `history.read({ scope, txid, topic,
policyId, contextDigest })` follows retained applied history to the original
committed operation. It checks scope, transaction, policy and private-context
digest against that operation's retained identity. A topic appearing only as a
duplicate in STEAK is insufficient.

A committed result contains `{ state: 'committed', admission: { identity,
receipt } }`, retaining the original mode, exact STEAK JSON and index/propagation
observation. Missing, pending, mismatching or older unbound history returns
`{ state: 'unresolved' }`. Corrupt storage, invalid selectors and I/O failures
throw. The reader does not retry admission, broadcast, resolve pending commit
attempts or claim rejection. History survives serving eviction and output
spending; it does not establish current unspentness, chain assessment, visibility
or authorization.

This is a **trusted local** interface. Its full receipt and identity can include
other private topics admitted by the same operation. Authorize and project a
response before exposing it to a client. One reader belongs to one node/chain
scope; select that scope's adapter explicitly. Each of its two primary-majority
reads has a five-second database deadline.

The extra provenance uses a versioned member within the existing 1 MiB binary
receipt field. The complete encoded record is bounded before operation claims
or database effects; new collection fields, validators and schema migration are
unnecessary. Default writes retain exact legacy bytes and every public receipt
keeps its existing shape. Older readers ignore the added private member. Enabling
retention does not rewrite or certify old receipts, even when a retry succeeds.
Disable the option to return to default writes without erasing retained history.
This capability is a building block for proposal/admission recovery; it does not
by itself implement a BRC-194 service or durable negative admission decisions.

## Optional proposal admission bridge

`@bsv/overlay/proposal-admission` exports `OverlayProposalAdmission`, an optional
Node adapter for `ProposalServiceAdmission` from `@bsv/output-knowledge/proposals`.
This entry requires SDK 3.0 or newer. The existing root entry, SDK peer floor,
ordinary submit signature and storage defaults are unchanged.

Construct the bridge with an actual `Engine`, retained-history storage, the
installed ordinary topic, proposal service name, provider identity and exact
service-rules digest. The proposal service must authenticate the caller, verify
the author's proposal and policy-specific transaction relation, completely
verify BEEF/Script, and durably reserve the exact job and original verification
context before recovery. This bridge is a trusted local component, not a public
request handler or a replacement for those checks.

Recovery first reads original topic admission history. If it is absent, the
bridge checks the complete possible result against its reserved capacity before
ordinary Engine submission, then reads history again even if submission throws.
Only an original committed receipt whose identity includes the selected topic
and ordinary Engine policy can finalize the proposal. Without that provenance,
duplicate STEAK, missing legacy history and submission errors remain unresolved.
Empty instructions do not override a valid retained identity in either direction.
The bridge does not
invent a durable rejection from an exception; an operator must reconcile such
jobs through retained evidence.

The result exposes only the selected topic's STEAK. Its assessment identifier
binds the original admission identity, operation and selected instructions;
later reservations, index visibility and propagation observations cannot
relabel that assessment. Historical admission survives serving eviction and
spending, without asserting present visibility, unspentness or mining finality.
Proposal payloads are not silently submitted as private off-chain values.

The canonical job and retained record each have a 1 MiB bound. Configure evidence
acceptance so the combined BEEF, raw transaction and job metadata fit that job
bound. `maximumOutcomeBytes` defaults to 1 MiB (128 bytes through 1 MiB), and the
proposal service reserves that exact outcome budget before effects. Size both
the journal entry limit and selected response limits to include their enclosing
records in addition to this result budget. A result
that cannot fit is rejected before new ordinary submission. The default four
physical recovery calls can be configured from one through 64; stalled calls
retain their capacity until they actually settle. Excess calls return retryable
`limited` errors rather than accumulating a queue. The host owns recovery
scheduling and transport deadlines.

Drain recovery work before replacing the Engine's storage, admission/history
provider, topic manager or scope. The bridge detects installation changes across
history reads; configuration mutation during Engine execution is unsupported.
Create a new bridge for an explicitly installed replacement. No database
migration or retroactive certification of old receipts is performed.

Tests include real Engine submission against a local three-member Mongo replica
set, receipt recovery after adapter restart and serving eviction, concurrent
submission, and loss of the response after actual commit. Synthetic header
fixtures and disabled broadcast/advertising isolate this evidence from a public
network; they do not certify a deployed service or the full BRC-194 HTTP path.

## Runtime and package formats

The package supports both module systems:

```ts
import { Engine } from '@bsv/overlay'
```

```js
const { Engine } = require('@bsv/overlay')
```

ES modules load from `dist/esm`; CommonJS loads from `dist/cjs`. Each condition
has matching declarations. Published artifacts contain compiled output, the
README, and the license only—tests, compiler caches, workspace source, and lock
files are excluded.

## Security and operations

The engine is transport-neutral. Authentication, CORS, CSP, body limits,
timeouts, rate or concurrency controls, and administrative authorization belong
at the HTTP or application boundary.

Overlay endpoints are commonly public protocol services used by browsers,
mobile wallets, WUI, and applications on previously unknown origins. A wrapper
should therefore remain public-by-default unless an operator deliberately
configures an exact-origin allowlist. CORS is not an authentication mechanism,
and CSP for a hosted UI should be configured independently.

For production deployments:

- validate all untrusted request data before invoking the engine;
- use a durable storage implementation and tested database migrations;
- configure transaction broadcast and proof providers;
- protect administrative and callback routes with explicit credentials;
- avoid logging raw secrets, authorization headers, or unbounded payloads;
- monitor readiness, proof acquisition, synchronization, and unproven state.

Run every `KnexStorageMigrations` migration before serving traffic. The topical
uniqueness migration deliberately stops when duplicate `(txid, outputIndex,
topic)` output rows or `(txid, topic)` applied-transaction rows already exist;
operators must inspect and reconcile those records rather than letting a
migration discard security-relevant state. The engine serializes submissions
inside one process, while database uniqueness and conditional unspent updates
enforce the same spend/admission boundary across processes.

Prefer roll-forward after these migrations. Older package versions do not know
their migration names, so a bare image rollback can fail migration-list
validation. To restore an older version, stop writes and either use the new
migration source to reverse `spentBy` and topical uniqueness in reverse order
after exporting and reconciling every `spent`/`spentBy` association, or restore
coordinated pre-migration SQL and lookup-store backups. Never drop `spentBy` or
restore only one store without preserving that spend evidence.

Submission is intentionally not a single all-or-nothing transaction across
primary storage and external lookup indexes. The Engine validates before
mutation, propagates failures, and never invokes the success callback until all
attempted writes complete, but a late failure does not roll back an earlier
committed write or third-party index update. A rejected submission therefore
does not assert rollback. Operators and custom adapters must detect and
reconcile partially applied work before replaying or exposing affected state.

GASP v1 bidirectional `submitNode` omits the `spentBy` parent outpoint. A
receiver must already have the relevant parent, request it in a subsequent
sync round, or reject the graph; it must never infer the edge from the child
alone. Pull-only operation avoids that assumption. The Overlay pull adapter
binds topic, graph, raw transaction, output, parent edge, proof, resource
limits, and historical spend state before finalization.

Remote GASP/BASM peers and propagation/header providers are separate network
authorities. Production adapters accept credential-free public HTTPS, pin DNS
addresses to the requested origin, reject redirects, bound streamed bodies and
deadlines, and correlate every transaction, topic, height, index, and proof to
its request. Private or HTTP targets belong only in explicit isolated local
development configurations.

Reorg event streams are hints rather than independent chain-state authority.
Before demoting a proven admission for a reported orphaned block, the Engine
requires the configured canonical header resolver to return a different hash
for that exact height. An unavailable resolver or a hash that is still
canonical rejects the event before any durable mutation.

SHIP tracker answers are discovery hints, not trusted routing authority. Before
using a discovered endpoint for GASP, the Engine now requires a canonical
identity-linked advertisement signature, a one-satoshi token, exact BEEF/TXID
correlation, and the requested topic. The endpoint still passes through the
same public-HTTPS and DNS-pinning controls as an explicitly configured peer.

Custom `Storage`, `LookupService`, `TopicManager`, advertiser, chain-tracker,
and header-resolver implementations are trusted local components, but their
runtime results are still checked before the Engine mutates or returns state.
Storage queries must return only records bound to the requested outpoint,
topic, height, block hash, and score window. Lookup formulas use a default
1,000-result limit and an unconditional 100,000-result safety ceiling; history
depth, context bytes, stored BEEF, graph fan-out, and aggregate traversal work
are also bounded. `maxLookupResults: -1` disables the operator-selected lower
limit, not the hard safety ceiling. BASM anchor stores must return strictly
ordered, request-bound, canonical hash records.

Public component metadata is copied through a bounded own-data-property schema;
names, descriptions, versions, and HTTP(S) links that are malformed, accessor
backed, or oversized fall back to a minimal local registry description.
Component Markdown documentation is limited to 1 MiB before it crosses the
Engine/HTTP boundary.

`@bsv/overlay-express` supplies these standard HTTP controls while preserving
public protocol access by default.

### BASM peer validation and current recovery limits

BASM uses the current BRC-136 ordered admitted subset and block-anchored TAC.
The five existing JSON POST routes remain compatible; empty tips remain
`{ topic, blockHeight: -1, tac: <zero hash> }`. Unsupported storage capabilities
are errors, not empty histories. The remote client validates response shape,
topic/height/hash binding, ordered unique admitted positions, contiguous
returned ranges, and complete proof/raw response ID sets before use.

`BASMRemote` retains its injectable third `fetch` argument and accepts optional
limits as a fourth argument. Defaults are 64 MiB per decoded response, 8 MiB
per proof, 32 MiB per raw transaction, 100,000 admitted entries, 1,000 requested
txids, 1,024 requested anchor heights, and 30 seconds per request including its
body. Aggregate response limits also apply to hex-encoded transactions. These
are configurable local acceptance limits, not consensus rules. Standard fetch
bodies are bounded while streaming; legacy injected `text()` implementations
are checked after buffering. Classified errors expose `code`, including
`BASM_UNSUPPORTED`, `BASM_RESOURCE_LIMIT`, and `BASM_TIMEOUT`.

Reconciliation requires a canonical header resolver as well as a ChainTracker.
An optional `TopicAnchorHeader.blockTransactionCount` must come independently
from the trusted canonical provider and refer to that exact `blockHash`.
It enables full-block count/index bounds and odd-duplication checks. The sync
report's `positionValidation` is `canonical-count` only when that evidence was
available for every checked proof; legacy providers yield `encoded-offset-only`.
A Merkle root plus an encoded offset alone cannot disambiguate Bitcoin's
duplicate-last-leaf position ambiguity. No provider is required to add the
field, and the engine does not download full blocks to infer it.

Forward sync pages now contain at most 1,000 anchors to fit the standard HTTP
server. Proof height, requested original index, canonical hash/root, raw byte
identity, TAC continuity, and repeated peer anchors are checked before historical
submission. Claimed admitted-list indices are bound to the compound path whenever
a remote list is used as evidence, including when every remote txid is already
local. Inclusion uses the chain tracker root/height check rather than
`MerklePath.verify`, which also enforces coinbase 100-block spendability.
Because inclusion is proven independently, admission submits in the
`historical-tx-no-spv` mode so `Transaction.verify` does not re-apply that
coinbase rule; the public `historical-tx` mode keeps full SPV verification.
Admission still applies the local TopicManager, and because every admitted
transaction carries its extracted Merkle path, neither network broadcast nor
overlay propagation occurs. Automatic BASM sync remains disabled by default.

This is bounded protocol hardening, not durable recovery. An empty local node
whose topic genesis precedes the recent bootstrap window now refuses the
untrusted TAC prefix; this intentionally replaces the old unchecked tail
behavior. A block above 1,000 admitted entries reaches a request-limit error
until proof/raw chunking is implemented. Equal-height/local-ahead divergence,
whole-target bootstrap, durable cursors/leases, atomic revision fencing, and
truthful per-topic agreement status remain required follow-up work. A successful
legacy report does not establish global completeness, current unspentness, or
durable recovery completion. See [BASM details](./docs/BRC-136-BASM.md).

## Development

From the repository root:

```bash
pnpm --filter @bsv/overlay format:check
pnpm --filter @bsv/overlay lint
pnpm --filter @bsv/overlay typecheck
pnpm --filter @bsv/overlay test
pnpm --filter @bsv/overlay test:coverage
pnpm --filter @bsv/overlay pack:check
```

`pack:check` verifies the actual npm tarball with publint, strict type
resolution, and clean ESM/CommonJS consumer projects.

## License

Current TS Stack changes are licensed under the Open BSV License Version 6; see
[LICENSE.txt](./LICENSE.txt). This package also retains pre-uniformization code
under the Open BSV License Version 4. Redistributors must preserve
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and the applicable text in
[`LICENSES/`](./LICENSES/).

## Optional private publication admission bridge

`@bsv/overlay/private-publication-admission` exports
`OverlayPrivatePublicationAdmission`, an optional SDK3 adapter using the existing
private off-chain values argument and original retained topic receipts. The caller
first verifies publisher, schema and Bitcoin evidence and durably reserves the
original request, contract/context and protected bytes. The adapter returns
selected-output admission, definitive exclusion or unresolved work; none alone
establishes a private lookup binding or ready publication. Explicitly configured
reuse of an existing public admission still requires independent private validation.

The [private publication admission guide](../../../docs/guides/private-publication-admission.md)
covers exact contract binding, current guards, finite work/result limits, original
receipt recovery, the public reuse policy and native Engine/Mongo validation.
Existing root exports, public submissions, retained receipt bytes and proposal
assessment identities remain unchanged. Installations that do not import or
configure the new entry retain their existing behavior.

## Optional selected-host purchase admission

`@bsv/overlay/purchase-admission` exports `OverlayPurchaseAdmission` for the
proposed BRC-196 companion. Configure the seller/topic/rules, base URL, domain
profile and admitted successor index. It checks original selected contract and
exact public transaction, recovers selected-topic retained history and its
original commit time, then submits only when that history is absent. A duplicate
or lost reply cannot substitute its later clock or empty duplicate STEAK for the
original admission. No protected material enters Engine or GASP.

Its caller must independently verify the full covenant/domain and reserve the
original private intent before invoking the adapter. It does not issue POTATOES
or establish mining. See [purchase custody and composition](../../../docs/guides/private-purchase-custody.md)
for current guards, required time provenance, staged release, private disclosure
and shutdown. Ordinary Engine submission and root exports remain unchanged.

## Optional public BEEF ancestry and historical GASP reads

Construct `MongoOverlayStorage` with
`{ retainedBEEF: { maximumBytes: 4194304 } }` when the installed topic/history
profile needs original raw ancestors after a leaf acquires a Merkle proof.
The byte budget is an owned, sealed-in-the-instance positive safe integer at most
4 MiB. Ordinary configurations keep their original admission payload and hydration
behavior. This option adds a bounded `beef-manifest` to new atomic Engine admissions,
checked before any payload publication. Hydration binds it to the exact stored raw
subject and attaches a separately retained current leaf proof. It retains available
raw ancestors below that proof and excludes unrelated transactions, using the
existing BRC-95 Atomic header and BEEF encoding. It does not change SDK serialization
defaults. Original off-chain values and lookup context are absent from this public
manifest. Script, SPV, selected-chain and currentness verification remain separate.

A missing manifest on an older transaction preserves the older read behavior;
missing ancestry cannot be invented. A present but missing, malformed, oversized or
contradictory manifest fails closed when BEEF is requested. Keep the selected budget
and original payload custody available through recovery. This is an explicit
storage profile, not an automatic migration of old transactions or a promise that
alternate proofs have been independently verified.

`Storage.findHistoricalOutput` is an optional separate audit/history port.
`MongoOverlayStorage` implements it for an exact node/chain/topic/outpoint, including
retained consumed or evicted rows. Its `spent` field reflects recorded spend
knowledge; serving eviction alone does not become a spend. Ordinary output, UTXO
and lookup queries still exclude evicted rows. Do not use a historical read as a
current-membership or unspentness oracle.

Construct `OverlayGASPStorage(topic, engine, maxNodes, maxBytes,
{ historicalOutputs: true })` to use that installed port explicitly. Construction
refuses a missing port; hydration pins and rechecks its owner and method and retains
all original topic/raw/output binding checks. The original four-argument/default
construction continues using ordinary `findOutput`. Public GASP nodes contain raw
transaction/proof evidence without private context. Resynchronization still applies
ordinary topic/spend validation and the host's independent root serving fences;
retaining a historical node cannot reintroduce a spent or suppressed discovery row.

The native SHIP/SLAP composition in Overlay Express exercises admission, physical
lookup, spend, restart and public GASP replay together. Separate native Mongo tests
cover ordinary defaults, bounded manifests, damaged custody, node/topic isolation
and the difference between an evicted unspent row and a recorded spend. The
[root integration guide](../../../docs/guides/root-eviction-coordination.md)
describes the required pre-effect writer fence and projection acknowledgement.
