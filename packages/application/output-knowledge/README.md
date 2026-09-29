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
adapters and optional scoped source currentness with durable expiry. Service
integrations, proposal processing and complete qualification evidence are still being connected before
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

## Local workflow control state

`@bsv/output-knowledge/operations` exports `OperationStateStore`,
`MemoryOperationStateStore` and `IndexedDBOperationStateStore`. The separate
`@bsv/output-knowledge/operations/sqlite` entry exports
`SQLiteOperationStateStore`. These bounded local cells retain workflow control
state separately from Bitcoin receipt journals. A cell does not verify a
transaction, implement a lookup session, authorize a payment or validate an
application's state transitions. Its caller implements those rules.

Each namespace binds an immutable configuration and capacity to one mutable JSON
object with an exact decimal U64 revision. The `configuration` getter returns owned
binding and limit copies; a workflow adapter must check them when accepting an
injected store. Memory is volatile. SQLite uses a
WAL/FULL transaction; IndexedDB uses a strict read/write transaction. A write
compares the previous revision and replaces the entire object atomically. An
exact retry against the immediately following identical state returns `replayed`.
Any later revision returns `conflict`, even if the same value appears again.
An uncertain write is not proof of rollback: reread the saved workflow identity
and reconcile it before deciding the next operation. Never blindly repeat an
external effect because a local acknowledgement was lost.

```typescript
import { SQLiteOperationStateStore } from '@bsv/output-knowledge/operations/sqlite'

// Application-owned, newly allocated identity and immutable binding.
const control = SQLiteOperationStateStore.create(path, workflowId, binding, {
  phase: 'reserved',
  job: '0'
})
const before = await control.read()
const result = await control.compareAndSwap(before.revision, {
  phase: 'response-pending',
  job: '0',
  response: validatedResponse
})
// A conflict requires a reread and workflow-specific reconciliation.
// Only a successful durable commit can authorize the corresponding next step.
await control.close()
const recovered = SQLiteOperationStateStore.open(path, workflowId, binding)
```

Use `create` only for a new workflow identity or an exact initialization retry.
Retrying initialization preserves the current state and rejects changed initial
values. `open` recovers an existing namespace; missing storage never creates a
replacement operation. Changed configuration or capacity fails. Separate workflows
use separate namespaces, whose count/lifecycle the application must bound. There
is no automatic deletion, compaction or remote write endpoint. Configuration and
state are independently bounded at 2 MiB and 4 MiB by default; callers may narrow
these limits. State values must be bounded JSON objects, and reads/writes own their
data. Checksums detect inconsistent persisted bytes and revisions; they do not
authenticate a malicious local writer or prove that an old backup is current.

Use a dedicated database name for `IndexedDBOperationStateStore.create/open`.
Browser eviction, rollback and private browsing can remove data. Retain an
independent application recovery expectation, request browser persistence where
available, and treat a missing expected namespace as a reset. Protect SQLite's
parent directory and backups; new files are owner-only. Restore a coherent backup
of the workflow cell and its associated receipt journal, including their WALs,
and enforce the workflow's cross-store recovery rules. Receipt and cursor must
still commit together in the receipt journal before a live cursor is used. This
storage primitive alone does not satisfy the complete BRC-193 client contract.

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
qualifies. The default produces local unknown/spent/conflicted/stale assessments. An explicit
`sourceCurrentness` policy can additionally retain scoped provider reports; no
source receives implicit authority to assert unspentness.

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

## Source equivocation and recovery

After the entire batch passes schema and trusted-session checks, `BitcoinKnowledge`
retains a changed observation identity, reused group identity or inconsistent
watermark as a quarantined **receipt**. The journal preserves the exact claim and
trusted provenance under its mutation key; its successful commit acknowledges
storage, not acceptance. No sibling in that receipt supplies new evidence,
membership, private context or currentness. The original observation remains
immutable. Independently accepted transaction facts and other providers survive.

Quarantine closes the affected source generation. Existing membership stays visible
as historical membership, with a generic reset diagnostic in `pendingGroups`;
configured currentness from that source becomes stale. The worker journals a local
reconciliation so watchers receive an accepted revision even when there is no new
proof work. Restart completes that pending reconciliation from retained local
material. Diagnostics never include the rejected private payload. The original
receipt remains accessible only through the partition's local journal inspection.
For a coverage-only reset without a group, the diagnostic uses a local
`continuity-reset:<generation>` identifier; a group-free equivocating claim uses
`quarantine:<mutation-key>`. These are diagnostic references, not remote group IDs.

Recovery uses a higher local source generation and a fresh snapshot. Publication
swaps only after that complete seed qualifies. Late work from the old generation
cannot publish, and changing generations does not permit rewriting an observation
identity in the same provider epoch. Other providers keep their own continuity.
Malformed or foreign-scope batches are rejected before receipt and cannot close a
trusted source's generation. An ordinary transient outage is not equivocation.

Quarantine retains at most 64 receipts and at most the configured `pendingBytes`
(16 MiB by default), also subject to the journal's overall retention limits. A
capacity failure returns `limited` before partial mutation; it never deletes a
claim, advances a cursor or calls evidence invalid. Recovery after exhaustion needs
an explicit new journal namespace with the old journal retained for audit. Custom
reducers may use `SourceMembershipLedger.receiveRetainingEquivocation` and its
bounded `quarantines()` diagnostics; the lower-level `receive` method retains its
strict rejection behavior. Both require already schema-checked, locally bound input.

## Scoped source currentness

An `output` observation means collection membership. To interpret a particular
source's named rules as an unspent report, explicitly configure `sourceCurrentness`
on `BitcoinKnowledge`. Select the chain, provider, service, query digest, rules
digest and access partition from trusted application configuration. The source's
rules must actually define that meaning; ordinary catalogue membership is not
sufficient. A different provider, query, rule digest or access partition receives
no authority from that selection.

```typescript
const { epoch, ...sourceIdentity } = configuredScope
const worker = new BitcoinKnowledge({
  journalId: journal.namespace,
  partition,
  nonFinal: false,
  verifier,
  sourceCurrentness: [
    {
      source: sourceIdentity,
      maximumAgeSeconds: '60'
    }
  ]
})
```

The configured identity spans provider epochs, but every assessment retains its
complete actual scope, including epoch. The currentness rule is local application
policy, not a new wire field or provider-selected option. Configuration is bounded
to 64 distinct rules and 4,096 retained observation identities from selected
sources. Exhaustion is an explicit limit requiring a new journal generation;
receipts and expiry decisions are never silently dropped.

A report requires accepted whole-group creation evidence under the active context,
visible membership and intact source continuity. Pending groups, quarantine,
replacement-generation staging, a changed chain context or a local conflicting or
spent assessment make that source report stale. Provisional selected spends also
prevent a usable unspent report. The independent local transaction assessment is
retained, so source data cannot reverse Bitcoin consumption. Two providers remain
two source assessments even when they report the same output.

Expiry is exclusive and starts at the observation's **first trusted receipt**.
Worker completion, duplicate delivery, local refresh and restart do not extend it.
A new observation identity can provide a new report. A source's accepted
`assessment-invalidated` observation affects only earlier reports in the same
complete scope and named context; it cannot invalidate local facts or another
source. A subsequent new report can qualify independently. Withdrawal removes that
source's report without inventing a spend.

`OutputKnowledge` schedules expiry even without incoming data. The worker journals
an `invalidate` mutation before publishing the next coherent snapshot, including
after restart. `KnowledgeStore.read` independently checks wall time and returns
`expired` if a delayed timer has not yet committed the invalidation. Resuming the
runtime or calling `flush` performs that durable work. Replay reconstructs the
recorded outcome without contacting the verifier and never grants a new lifetime.

New journals use local verification frame version 3, sealing normalized currentness
rules (including an empty list) alongside the non-final setting. Assessments use
the BRC-192 canonical ID order, independent of whether source currentness is enabled.
Historical version-1 and version-2 journals retain their original encoding,
assessment presentation and accepted decisions when reopened or extended. In
particular, version 1 used outpoint order for its local assessments. Saved fixture
journals qualify that compatibility without contacting a verifier during replay.

Activating the canonical version-3 presentation for an older journal, or enabling,
disabling or changing currentness rules, requires an explicit new namespace. Keep
the previous journal for audit/recovery and populate the new one through authorized
sources; never copy old accepted mutations as new acceptance authority. A newer
frame cannot be mixed into an older namespace, and a version-3 journal cannot be
downgraded in place. Unknown versions fail explicitly. No saved history is silently
rewritten or interpreted under different presentation rules.

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

## Installed proposal policies

`@bsv/output-knowledge/proposals` is an optional entry for BRC-194 policy validation.
`ProposalPolicyRegistry` accepts only explicitly installed local validators and
their exact parameters. Its descriptions carry the registered policy digest for
capability negotiation. An unrecognized identifier or different parameter digest
fails closed; the registry never downloads executable policy code.

```typescript
import { AuthorDocumentPolicy, ProposalPolicyRegistry } from '@bsv/output-knowledge/proposals'

const policies = new ProposalPolicyRegistry([
  { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 4096 } }
])
const proposal = policies.validate(receivedEnvelope, { chain: configuredChain, service: topic })
```

`validate` checks closed envelope fields, the selected service and chain, critical
extensions supported by that specific policy, canonical policy payload and the
author's actual BRC-77 signature. It returns an owned copy. `permits` checks policy
authority for put, read or finalize; it is only one part of authorization. The host
must authenticate the caller and intersect this permission with current access at
each mutation, retry, read and response serialization. The registry has no wallet,
network, admission or storage effects.

The concrete `author-document-v1` policy permits canonical UTF-8 JSON `{text:string}`,
including empty text, bounded by 1–4096 text bytes. It requires 1–32 sorted recipients
including the author, zero or one chain-bound anchor, and no embedded transaction.
Revisions retain the author, recipient set and anchor. Only the author may update,
withdraw or finalize. Recipients may read only while the host still authorizes them.
Signing does not encrypt the document; private transport and storage remain required.

`successor` verifies the exact signed predecessor digest and next revision within
the complete channel namespace. This pure check does not reserve a revision: the
host must still serialize changes against its durable active head. `validateProposalWindow`
uses exact U64 seconds, finite maximum lifetime, bounded future-clock skew and
exclusive signed expiry. Hosts apply it to new mutations, and separately enforce
current-head expiry and terminal fences. It must not cancel or reject recovery of
an already committed finalization merely because the proposal has since expired.

`finalization` validates bounded, completely consumed raw transaction bytes and the
claimed txid. For author-document, output zero must contain exactly one satoshi and
`OP_FALSE OP_RETURN`, a minimal four-byte push of ASCII `PRP1`, then a minimal push
of the 32-byte proposal digest. An anchor additionally requires input zero to spend
that exact outpoint. The check adds no unrelated sequence or lock-time restriction.
It is a relation check, not evidence verification: the service must independently
verify complete BEEF and configured topic admission before reporting success.
Recording or validating a document never consumes an input or releases a secret.

`ProposalTransitions` implements the pure channel lifecycle. Each change returns a
whole-record compare-and-swap token, the next local record and the exact proposal
and/or proposal-state events to commit together. It does not write storage itself.
Storage must compare that token, claim a new `(caller, service, operationId)` binding
when applicable, retain the channel and job, and append its events atomically.
Terminal channel fences must survive compaction for the service identity's lifetime.
An identical signed-body retry retains the original signature, clock and state.

Reservation stores the exact raw transaction, original verified BEEF and admission
job before any external topic effect. The caller supplies raw bytes obtained from
its trusted complete-BEEF verifier; a relation check does not replace that verifier.
Expiry, updates and withdrawal compete with reservation on the same token. Once a
reservation wins, expiry cannot cancel the job. A retry with a different verified
BEEF encoding of the same raw transaction recovers the original job. Reusing the
same operation for other bytes conflicts. Another operation on that already bound
proposal resolves the original state and cannot start another transaction.

An uncertain topic result remains finalizing. A positive recovered result, including
an empty duplicate STEAK, links finalization. Definitive local rejection terminates
the channel as finalization-failed with global outcome unknown. Later callbacks and
timer expiry do not rewrite finalized or failed history. Reorganizations belong in
separate currentness assessments, not a reversal of the historical admission record.
The local replay parser rechecks signatures and record/job bindings offline; it is
not an API for accepting remote provider claims as locally completed admissions.

`MemoryProposalJournal` implements the atomic journal port with explicitly volatile
storage. `SQLiteProposalJournal` is available from
`@bsv/output-knowledge/proposals/sqlite` and requires Node 22.13 or newer. It uses
SQLite WAL and `synchronous=FULL`, creates new files owner-only, and commits each
transition as one immutable row with its revision and retained-byte accounting.
Channel heads, terminal fences, operation claims and pending jobs are derived from
that committed prefix. Independent connections take the same SQLite write lock
before replaying and comparing a head. Reads pin an immutable prefix by revision.

Both journals revalidate plans against the stored lifecycle. They preserve original
commit keys across retries, reject an operation reused for another proposal, retain
superseded signed heads for lookup, and expose bounded ordered journal reads.
`getProposal` explicitly labels whether a retained signed head is still current.
`appendProposalWithRecovery` looks up the exact original commit after an uncertain
write; absence surfaces the error and never creates a replacement transaction.
All storage reads, including event history, contain private data and require host
authorization before any external serialization.

An optional local JSON context is committed atomically beside the transition. The
`contextRetention` capability identifies adapters that support it. The storage
frame retains a domain-separated digest and charges the complete frame against
byte limits; it does not validate a capability contract or confer authority on its
contents. Hosts must validate that context before writing and again during
recovery. Existing body-only entries keep their bytes and transition commit keys.
An identical retry recovers the original context; a different supplied context
fails rather than replacing it. A body-only commit cannot acquire context later.
The SDK's `retainOutputCapability` and `restoreOutputCapability` helpers capture
and revalidate a signed selection at its original time. A host can include that
bounded local record in the journal context; it still must bind the selected
proposal policy to its installed lifecycle, retain the operation's actual deadline
and recheck current authorization. A remote caller cannot supply trusted local
recovery context.

`ProposalCapabilityContracts` binds SDK selection and retention to an installed
`ProposalTransitions` configuration. It requires a confidential topic proposal
profile for the configured endpoint, identity, chain and service. Every advertised
policy must match an installed identifier, digest and parameter object exactly;
the advertised maximum lifetime must match the installed lifecycle. A host may
advertise a subset of its installed policies, but `requirePolicy` rejects a signed
head's policy when that particular retained selection omitted it. This check must
precede committing the lifecycle plan. It does not replace the plan's signature
and policy validation, current caller access, deadlines or complete-BEEF checks.

Both reference journals implement the optional `getProposalEntry` indexed read.
It returns one owned copy of that proposal's latest committed transition, events
and local context together, including for a superseded signed head. A host need
not scan private history or combine a record with context from a different
revision. Hosts must carry the required original contract forward in each new
transition's context; an absent context is an operational recovery failure, never
permission to substitute today's discovery result.

The `completionReservation` capability holds one maximum-sized entry and its byte
budget for every newly accepted finalizing job. Other writes cannot consume that
space. A terminal receipt releases the reservation. Hosts must bound the complete
terminal entry, including the retained job, STEAK and local context, to `entryBytes`
before starting admission. This reserves storage capacity, not admission success
or availability of the disk. Earlier journals replay without retroactively
requiring reservations; previously accepted jobs may already exceed the available
completion capacity. Recover those obligations before promising the new guarantee.

The reference limits are 64 MiB retained bytes, 4 MiB per transition, 4,096 entries,
1,024 channels and 128 channels per author. Callers may lower these bounds. Reads
return at most 256 entries and stop at the configured entry-byte budget. Terminal
channels continue counting toward capacity. This version retains full history and
does not compact or delete it; exhaustion is an explicit limit, never permission to
forget an operation, pending job or terminal fence. Further compaction and contract
evolution are part of the service integration work.

SQLite seals the provider identity, chain/service, installed policies, clock
configuration and capacity limits in its namespace. Independent connections must
use identical limits. An older database gains a separate capacity seal without
rewriting its entries; stop older writers before relying on the reservation
guarantee. Reopening a sealed journal with different limits requires an explicit
future migration; deleting its seal is not a supported capacity change.
It refuses to reinterpret an existing journal or
open the same service identity under a fresh namespace in that database. Protect
the containing directory and backup through SQLite's online backup facility. Do
not point an existing service identity at an empty replacement database: loss of
terminal fences requires retiring that identity, while existing finalization and
recovery obligations still need recovery from the original retained storage.

### Durable proposal service composition

`ProposalService` composes the lifecycle and durable journal behind an authenticated
transport. Its `put`, `get` and `finalize` methods accept the BRC-194 bodies and an
already verified caller identity and capability digest. Those two values must come
from the BRC-103/104 transport's verified request, including the authenticated
selection headers. Copying identity or selection fields from an unverified body is
not authentication. The service does not implement HTTP or enable a legacy route.

```ts
import { ProposalService } from '@bsv/output-knowledge/proposals'

const service = new ProposalService({
  lifecycle,
  storage: durableProposalJournal,
  trust: configuredProviderTrust,
  manifest: () => signedCurrentCapabilities,
  now: () => Math.floor(Date.now() / 1000).toString(),
  access: currentHostAccessPolicy,
  evidence: completeTransactionEvidenceVerifier,
  admission: durableOrdinaryTopicAdmission
})
```

The constructor requires durable storage with atomic context retention, terminal
capacity reservations, `getLimits`, `getChannelEntry` and `getProposalEntry`.
The reference SQLite journal implements these ports; the Memory journal remains a
volatile test adapter and cannot be used by this service. Capacity reads and
current-channel reads return owned snapshots. Existing journal consumers do not
need the newly optional methods.

An installed policy and current host access must both authorize a request. Reads
hide missing and unauthorized records behind the same `not-found` error, and
permissions are checked again immediately before returning data. Recording a
proposal performs neither evidence verification nor admission. Expiry is a
durable channel transition; call `expire(channelKey)` from a bounded host timer,
including after restart. Reads also apply due expiry. Timers never cancel a
previously reserved finalization.

Finalization verifies complete transaction evidence and the policy's exact raw-byte
relation before durably reserving the job. The evidence port must perform actual
BEEF, Script and chain verification; the lifecycle's transaction parsing alone is
insufficient. `SDKProposalEvidence` implements that port using `SDKEvidenceVerifier`,
an installed immutable `ChainViewResolver`, a synchronous verification-context
provider and bounded SDK work limits. It verifies the exact target transaction
and returns its raw bytes only after success. It rejects incomplete dependencies,
invalid Script and mismatched views; it does not assert unspentness or replace the
proposal policy's relation and ordinary topic rules. Output zero selects the
target transaction for verification, not a claim about its application meaning.
`SDKProposalEvidence.verifyWithContext` additionally returns the owned original
`VerificationContext`; its existing `verify` method still returns raw bytes.
`ProposalService` selects the richer method when installed and saves the exact
context with the reservation in local `proposal-service/2` material, covered by
the same atomic journal commit, integrity digest and completion-capacity budget.
The context includes the original chain view, policy digest, generation, partition
and verification bounds. Its chain must match the proposal. It describes the
completed verification; replay does not turn an expired verification deadline
into fresh proof of unspentness.

Admission adapters receive that saved context as an optional fourth `recover`
argument. The reservation's evidence check and the durable topic assessment are
separate: a recovered receipt may predate the reservation. The admitted result's
`assessmentContextId` must name that actual topic assessment, not be relabeled
with the supplied verification context's ID. The concrete admission adapter must
validate this receipt binding; the generic service cannot infer it from raw bytes.
Set `requiresVerificationContext: true` when the adapter needs this material.
A missing rich evidence port is then rejected before work; a legacy reserved job
without original context cannot be recovered through that adapter by inventing
one or rerunning discovery. The worker passes owned copies, so neither the
original evidence provider nor the admission adapter can mutate saved material.
An alternative BEEF retry can establish exact raw-byte equivalence but cannot
replace the reservation's original context.

Legacy string-returning evidence ports retain `proposal-service/1` bytes and the
three-argument admission call. Existing v1 records remain readable and recoverable
through a compatible adapter. V2 records require a valid verification context and
an admission job; missing, misplaced, foreign-chain and unknown-version material
fails closed. Older readers must be upgraded before opening a namespace that has
written v2 records. No wire format changes or rewriting of existing records are
required.

The admission port's `recover` must idempotently admit or reconcile
the exact stored job, including concurrent callers and restart. Its success must
refer to durable ordinary topic processing. A legacy early callback or an empty
duplicate STEAK does not independently prove that processing committed. An
uncertain result retains `finalizing`; a definitive local rejection records
`finalization-failed` with globally unknown outcome.

The admission port declares `maximumOutcomeBytes` and must enforce that bound
before committing effects. The service reserves room for the complete terminal
journal entry and checks both selected contracts' response capacities before
starting admission. It checks the actual outcome again before linkage. A port
that commits an oversized result has violated its contract; rejection at linkage
does not undo that external effect. Request limits include transmitted whitespace.

The original signed publication contract and, when present, the signed admission
contract are retained together. Either original selector can recover the resulting
head; unrelated new discovery does not replace them. Exact persisted evidence can
recover offline after manifest expiry. An alternative BEEF encoding is equivalent
only after verification of the same raw transaction. Reusing an operation ID for
different bytes or another proposal conflicts. A different authorized operation
for an already bound proposal returns the original binding without starting work
or claiming the new ID.

`reconcile(proposalId)` is a trusted recovery-worker entry for previously reserved
jobs. It may complete that committed work after caller access is revoked, while
reads and responses still apply current access. Pending jobs remain recoverable;
terminal results retain the longer of the existing deadline and each original
contract's interval after expiry or completion. Full retained history and terminal
fences remain in this bounded reference journal; reaching capacity never resets
the namespace.

Authenticated HTTP, concrete ordinary-admission adapters, scheduling and end-to-end
qualification are still being connected. Service orchestration tests use explicit
injected port outcomes. Separate evidence integration tests run actual SDK Script
and Merkle checks on a signed PRP1 transaction against pinned synthetic header
ancestry, then reserve its verified raw bytes in SQLite. They deliberately leave
ordinary admission unresolved and do not substitute for HTTP or topic integration.
Do not advertise the complete BRC-194 profile based on these components alone.

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
replacement preservation during context changes. The full 32-scenario BRC trace corpus also runs through the default worker and
SQLite, including delayed verification, generation fencing, snapshot page order
and offline restart. The binding is described in `test/fixtures/README.md`.
Actual-browser recovery, authenticated service transport and application
demonstrations remain required before checkpoint-two approval. Test sources are in-process
fixtures; they are not evidence of a deployed BRC-193 transport.

## License

See the package-local [LICENSE.txt](./LICENSE.txt) and
[third-party notices](./THIRD_PARTY_NOTICES.md) for distribution terms.
