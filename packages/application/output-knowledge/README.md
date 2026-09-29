# Application output knowledge

`@bsv/output-knowledge` implements the opt-in application state ports in the
proposed BRC-192–199 packet. It sits above `@bsv/sdk`: sources report observations,
the runtime verifies evidence and reconciles spends, and an application projector
interprets the resulting state. Signing, payments and wallet actions remain
explicit application workflows.

This implementation branch is in progress. Shared SDK wire types, the journal
adapters, evidence verification and dependency planning, spend selection, source
membership reduction, the default Bitcoin protocol worker and runtime orchestration
are implemented, together with wallet, finite per-host lookup and direct-delivery
adapters. Service integrations, scoped source-currentness policy, proposal
processing and complete qualification evidence are still being connected before
checkpoint-two review. The package version does not
indicate a published or production-qualified release.

## Getting started

This package is an unpublished implementation candidate. From this TS Stack
workspace, run `pnpm --filter @bsv/sdk build:ts`, then
`pnpm --filter @bsv/output-knowledge build`. Workspace consumers declare
`@bsv/output-knowledge` with `workspace:^`; external installation waits for the
separately authorized package publication. The composition example below uses
existing application-owned storage, chain verification and source configuration.

## Durable receipt journal

`MemoryJournal` is explicitly volatile. `IndexedDBJournal` uses a strict
read/write transaction for receipt bytes, idempotency identity and both revisions.
`SQLiteJournal`, imported from `@bsv/output-knowledge/sqlite`, uses SQLite WAL with
`synchronous=FULL`. The Node-only entry is separate from browser imports. Node
22.13 or newer is required for that adapter; Node 24 is used for development.

Revisions use exact decimal U64 strings. SQLite and IndexedDB indexes store
fixed-width hexadecimal positions so lexical ordering covers the entire unsigned
range. A received batch advances `received`; it does not advance `accepted` until
its whole source group passes the runtime's acceptance barrier. The low-level
journal stores already validated local mutations; it is not itself a transaction
verifier or domain policy.

Every append compares the expected received revision. Identical mutation replay
returns its saved result before checking the expected revision. Reusing a mutation
key with different bytes returns equivocation without changing the prior record.
An uncertain append is recovered by its original key. `appendJournalWithRecovery`
returns a saved committed result if present; absence rethrows the original failure
so the caller can decide whether to retry that exact operation. It never assumes
rollback and never creates a replacement payment or action.

Adapters bound entry bytes, total retained bytes and entry count. Reaching a bound
returns an explicit limit; it does not silently evict pending work or reset revision
ordering. Browser storage is subject to browser quota and eviction: applications
must request persistence where available and preserve the expected generation and
checkpoint so lost storage triggers a reset. SQLite files newly created by this
adapter are owner-only; the application must also protect the parent directory,
backups and its existing database permissions. Use SQLite's online backup facility
to include committed WAL state.

The journal can atomically retain locally generated verification replay material
alongside a mutation. That material has a versioned storage frame and integrity
digest, shares the entry and retention budgets, and survives the same commit as
the body, key, revisions and source checkpoint. It is not a provider attestation
or a new wire field. The BRC mutation body and its idempotency key remain unchanged;
a replay returns the original saved material. Older body-only journal records
remain readable. The protocol reducer owns validation of its local frame profile.
The default Bitcoin reducer requires a policy frame on every context transition;
an older body-only context requires an explicit reset instead of silently adopting
the current spend policy.

## Protocol work and application projection

`KnowledgeStore` owns compare-and-swap, bounded coherent replay, mutation recovery
and accepted-revision watches. Its trusted `KnowledgeReducer` checks protocol
transitions and deterministic Bitcoin reconciliation. The optional `prepare` port
can validate new cryptographic work and return the local replay material that must
be saved atomically. `reduce` reconstructs previously committed state. These ports
are local authority boundaries and must never be exposed as generic remote write
endpoints. `inspect` provides bounded, lossless local journal replay for a protocol
worker; it contains private application data and is not a public diagnostics API.

`BitcoinKnowledge` supplies the default `KnowledgeReducer` and
`OutputKnowledgeWorker`. Bind one instance to one journal namespace, partition and
explicit `nonFinal` policy, then pass it to both `KnowledgeStore` and
`OutputKnowledge`. It validates assertions against actual transaction inputs,
retains proof checks atomically, and reconstructs committed decisions without
network access. Source groups publish only after all their required evidence
qualifies. The default currently produces local unknown/spent/conflicted/stale
assessments; no source receives implicit authority to assert unspentness.

```typescript
import {
  BitcoinKnowledge,
  KnowledgeStore,
  OutputKnowledge,
  SDKEvidenceVerifier
} from '@bsv/output-knowledge'

// journal is MemoryJournal, IndexedDBJournal or the separate SQLiteJournal adapter.
// partition and headerViews are trusted application configuration, never source input.
const worker = new BitcoinKnowledge({
  journalId: journal.namespace,
  partition,
  nonFinal: false,
  verifier: new SDKEvidenceVerifier(headerViews)
})
const store = new KnowledgeStore(journal, worker, { partition })
const runtime = new OutputKnowledge({ store, worker, projector })
await runtime.setContext(verificationContext)
const subscription = runtime.attach(source, sourceRequest)
await subscription.done
await runtime.flush()
```

`headerViews` must resolve immutable, validated configured-chain views. A chain
context identity cannot be reused with different contents. The worker stores the
original context, receipt frontier and exact proof references; a historical recheck
uses a fresh local work deadline without extending any external authorization or
currentness deadline. The `nonFinal` setting is sealed in local replay metadata;
changing it requires an explicit new journal generation instead of reinterpreting
old replacements. The current reference implementation uses a new journal namespace
for that reset and retains the old journal for audit/recovery.

Complete-but-unfinished evidence blocks its input conflict/dependency component.
Other components can progress. Readiness uses the earliest valid complete support
set, including indivisible source-group prerequisites, and not worker completion.
A later context's missing evidence does not erase the earlier replacement journal.
Verification and source-ingress commits use bounded contention retries. Exhausted
verification, replay, retention or contention budgets remain explicit retryable
limits; applications can schedule another `flush` when resources are available.

`OutputKnowledge` coordinates sources, a protocol worker and an optional domain
projector. It advances a source iterator only after receipt commits, bounds pending
ingress, and keeps source generations separate from the partition's verification
generation. A slow source cannot retain the ingress commit queue indefinitely:
protocol operations have explicit deadlines and capacity. Source adapters must
honour their cancellation signals and transport deadlines.

Domain projection has no wallet action port. The runtime snapshots its input,
validates its output, and checks the active partition, generation, context and
both revisions immediately before publication. Failed, cancelled and superseded
projection work cannot become current. Projection records are currently materialized
in memory and rebuilt from the durable journal; application projectors must be pure
or supply their own explicitly authorized, durable idempotent effects. Runtime
events are a bounded local notification feed, not a BRC-193 replay transport.

`SDKEvidenceVerifier` uses the SDK's existing Script and SPV verifier with an
application-supplied immutable validated header view. It verifies the asserted
transaction in aggregate BEEF, treats missing bytes as unresolved, and distinguishes
backend unavailability from cryptographic invalidity. `EvidencePool` can assemble
bounded alternative proofs from separately received dependencies. Each alternative
retains all supplying receipts and whole-group prerequisites and still requires
verification. A txid-only entry never supplies a raw-transaction arrival position.

`SourceMembershipLedger` retains provider scopes independently, stages replacement
snapshots, fences retired generations, and applies live membership in source order.
`reconcileOutputSpends` applies actual transaction input edges, historical non-final
replacement rules and current-view dependency closure. Membership is not a spend
edge, and a newly reported output cannot undo a known spend.

## Source adapters

Import optional adapters from `@bsv/output-knowledge/sources`. The core entry
does not import wallet result validation or the legacy lookup transport on behalf
of applications using different sources. Both browser entries are independently
checked from the same packed artifacts against their declared size budgets.

Every adapter binds an application-configured scope before opening transport. The
scope includes chain, provider, service, query and rules digests, access and epoch.
The caller supplies the account partition and monotonically increasing refresh
generation. Reusing a completed finite generation for changed data is an error;
retry identical observations or start a new generation. Finite adapters reject
durable replay cursors instead of pretending to resume a BRC-193 session.

`WalletOutputSource` requests BRC-100 `listOutputs` with `include: 'entire
transactions'`. `walletOutputQueryDigest(service, query)` computes the scope's
query binding. The adapter validates the response through the existing SDK wallet
validator, retains each row's explicit txid and output index, and carries the
aggregate BEEF as received. It never selects an arbitrary last transaction from
that bundle. `WALLET_OUTPUT_CONTEXT_SCHEMA` identifies UTF-8 JSON containing the
original wallet output row, including requested tags and custom instructions.
That metadata stays inside the account/access partition and is not executable
authority or evidence of Bitcoin validity.

Wallet pages are pulled after the preceding page's receipt commits. Page count,
page size, total bytes and the whole invocation's deadline are bounded. Offset
pagination is not an atomic snapshot: concurrent wallet changes may duplicate or
omit rows. Reconcile again in a new generation as needed. A complete finite scan
means only that invocation reached its end. An empty later scan removes that
source's membership after its accepted boundary; it does not establish a spend.
Wallet calls without cancellation support retain their occupied adapter capacity
until they actually settle, even after the subscriber cancels or times out.

`LookupOutputSource` wraps the existing `LookupResolver.query$` and its pre-union
`onEvidence` receipts, with exactly one configured host per source. Use
`lookupOutputQueryDigest(question)` and set `scope.provider` to the canonical host
base, including any path prefix. Attach several instances concurrently within the
runtime's source capacity to obtain progressive federated results:

```typescript
import { LookupOutputSource } from '@bsv/output-knowledge/sources'

const subscriptions = configuredHosts.map(({ host, scope, generation }) => {
  const source = new LookupOutputSource({
    id: `catalogue:${host}`,
    host,
    scope,
    question
  })
  return runtime.attach(source, {
    partition,
    generation,
    scope,
    limits: runtime.limits
  })
})
await Promise.all(subscriptions.map(subscription => subscription.done))
await runtime.flush()
```

Host selection/discovery is trusted application configuration for this adapter;
it does not silently follow new endpoints or claim BRC-193 continuity. Each host
keeps its own membership and provenance even when another supplies the same
outpoint. A successful empty result, failed request, freeform response, deadline
and truncated intake have distinct outcomes. Legacy context is retained as opaque
JSON under `LEGACY_LOOKUP_CONTEXT_SCHEMA`, without becoming a new protocol field.
An explicit txid hint remains the asserted target; absent hints use the existing
BRC-24 final-entry target convention. Actual evidence verification remains the
worker's responsibility. Ordinary lookup, submission and resolver semantics are
unchanged.

`DirectDeliverySource` is a bounded bridge for an application-owned authenticated
transport such as MessageBox, NFC or peer exchange. Configure one source per peer
and access scope, attach it, then call `deliver({ id, observations })` with stable
sender-scoped identities. A transport may acknowledge its sender only after that
promise resolves. The runtime advances the source iterator only after receipt
commits; evidence verification can still be pending or later fail. Returning or
cancelling the iterator before the next pull rejects the unconfirmed
acknowledgement. A caller consuming the source manually must honor that same
commit-before-next contract.

Direct delivery requires a durable store by default. Tests or explicitly volatile
applications can select `allowVolatileReceipts: true`; this does not promise restart
recovery. Queue overflow fails the bridge with `limited`, rejects unacknowledged
deliveries and requires reconciliation/retry with the original identities. It
never silently drops a receipt while acknowledging it. Direct delivery supplies
partial finite coverage, never an exhaustive collection or a replay cursor. The
adapter does not discover peers, decrypt participant data, or grant transport
authentication to a sender's own payload.

## Compatibility boundary

The new protocols require explicit capability selection. Existing `/lookup`,
`/submit`, Topic Manager and Lookup Service methods retain their finite and legacy
semantics. Receiving an output does not establish unspentness; withdrawing a source
membership does not establish a spend. A proposal remains separate from verified
Bitcoin state. No journal receipt, replay, projection or reorganization authorizes
a wallet action.

## Validation during implementation

Run `pnpm --filter @bsv/sdk build:ts`, then this package's `build`, `typecheck`,
`lint` and `test` commands. Journal contract tests exercise all three adapters,
parallel compare-and-swap, equivocation, replay, retention, independent partitions
and commit-before-reply recovery. The SQLite test exits an actual child process
immediately after commit and recovers that receipt after reopening the database.
Browser adapter unit tests use fake-indexeddb; actual browser qualification is a
separate required checkpoint test and is not implied by those unit tests.

The concrete reconciliation fixtures exercise the selection function using actual
Script and inclusion checks. The knowledge-store and runtime orchestration tests
also use an explicitly empty protocol reducer to isolate persistence, cancellation,
backpressure and publication semantics. The default-worker integration tests separately use actual SDK Script/SPV
verification and the durable journal: they cover SQLite recovery with the network
disabled, cross-source predecessor completion, whole-group quarantine, live
withdrawals, source re-entry after spending, partial verification, and historical
replacement preservation during context changes. They do not replace the full BRC
trace corpus, actual-browser recovery, authenticated service transport or application
demonstrations required before checkpoint-two approval. Test sources are in-process
fixtures; they are not evidence of a deployed BRC-193 transport.

## License

See the package-local [LICENSE.txt](./LICENSE.txt) and
[third-party notices](./THIRD_PARTY_NOTICES.md) for distribution terms.
