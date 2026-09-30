# Output knowledge implementation qualification

This branch implements the proposed [BRC-192–199 packet](https://github.com/bsv-blockchain/BRCs/pull/284).
The specification checkpoint is approved for implementation. The implementation
checkpoint remains open; neither an initial package version nor passing foundation
tests announces completion, publication or production qualification.

The core contracts remain application-neutral. Application examples demonstrate
the contracts without defining their semantics. Existing wallet, overlay, lookup,
submission and GASP behavior remains available to applications that do not opt in.

## Implemented foundation

- Additive SDK wire codecs, canonical encodings, digest domains, signed capability
  profiles, observation schemas and bounded BRC-193 request/response schemas,
  plus closed BRC-194 put/get/finalize endpoint codecs.
- Bounded BRC-199 signed request/result and status contracts, direct authenticated
  root/requester/chain binding, exact decision IDs and independent restoration
  bases. New-request clock checks remain separate from retained-outcome recovery;
  this codec does not authorize or apply a suppression or guard serving paths.
- Optional SQLite BRC-199 root journal with permanent request fences, immutable
  terminal decisions, independent suppression bases and a durable projection
  outbox. Shared-process and cross-process transaction gates guard final synchronous
  enqueue; installed evidence/access policy and actual HTTP/index integration remain
  separate. Admission reserves result bytes and completion revisions before effects.
- Optional BRC-199 SDK evidence adapter for current SHIP/SLAP advertisements,
  advertiser withdrawal and exact consuming transactions. Actual Script/Merkle
  checks use one owned immutable chain view. Returned mined placements and operator
  references remain inputs to installed policy, not currentness or restore authority.
- Opt-in SDK BRC-197 exact locking-script and revenue-state codec, with pinned
  executable identity, canonical schedules and full descriptor binding. Its separate
  browser entry adds no program artifact to root imports. Recognition remains
  separate from lineage, transaction validation, consent and private fulfillment.
- Separate SDK six-route economic planning and funded transaction construction,
  exact mandatory outputs and unlocking ABI, explicit retirement top-up, per-input
  seller and all-old-recipient transaction signatures, owned preparation snapshots
  and final-layout checks. These low-level interfaces do not establish lineage,
  chain validity, wallet support or private entitlement.
- Optional bounded BRC-197 full-history verification with authorized genesis,
  collect-before-resolve BEEF, both merge histories, a visited DAG and explicit
  execution of every actual covenant input even for mined transitions. It binds
  Bitcoin verification to the installed immutable view; asset authority,
  currentness and acquisition/private delivery remain separate checks.
- Bounded common service errors, explicit capacity minimums and the specified
  BRC-193 HTTP status mapping, separate from local cancellation/storage failures.
- An additive AuthFetch automatic-payment opt-out for unpaid authenticated requests,
  preserved across authentication recovery without changing existing defaults.
- Reusable SDK capability retention/revalidation at the original selection time,
  independent of current authorization, operation deadlines and discovery changes.
- Bounded retained-contract BRC-193 client HTTP open/read/close, authenticated peer
  and signed selection checks, payment refusal, cancellation and fixed continuity
  validation. Cursor persistence remains the caller's separate atomic obligation.
  Actual signed local HTTP tests qualify the client component, not a durable feed.
- Memory, SQLite and IndexedDB receipt journals with atomic local replay material,
  exact U64 revisions, compare-and-swap and recovery after an uncertain append.
- Separate optional workflow control storage with immutable configuration, whole-state
  CAS, exact immediate-write recovery and Memory/SQLite/IndexedDB adapters. Recovery
  never silently initializes lost storage. These cells remain separate from atomic
  receipt/checkpoint commits in the core journal.
- Optional BRC-193 live source composing retained HTTP with durable capture and
  exact core receipt gates. Original opening identity, receipt time, whole groups
  and predecessor receipts survive restart. Separate generation, account and chain
  fences reject stale workers; fixed expiry and selected terminal service errors
  persist cursor-free continuity resets. The source never pays or opens a new
  generation automatically. Its separate browser entry preserves existing budgets.
- Optional BRC-193 provider composition with installed query rules, stable whole-change
  mapping, bounded physical request ownership, notification hints and cross-process
  polling. Snapshot and live continuation share one retained history boundary.
- SQLite provider indexes and sessions sharing an actual transaction: original Open,
  signed contract, first response, private cursor material, permanent original-request
  fence and history pin commit together. Explicit create/reopen, serving epochs,
  monotonic clocks, capacity, expiry, compaction and durable disclosure guards are
  separate from Bitcoin evidence acceptance.
- Opt-in Overlay Express lookup routes with BRC-103/104 authentication before strict
  JSON framing, signed capability/profile binding, explicit CORS, no-store responses,
  byte/work limits and disconnect cancellation. The lazy host integration and separate
  public entry preserve old root imports, routes and middleware defaults.
- Exact-target BEEF assembly, alternative cross-source evidence, actual SDK
  Script/SPV verification, historical readiness and deterministic spend selection.
- Whole-group acceptance, source membership order, generation replacement, context
  fences and projection publication independent of authorized wallet actions.
- Explicit source currentness policy, provider/epoch isolation, immutable first
  receipt lifetimes, durable timer-driven expiry and scoped remote invalidation.
- Bounded, durable equivocation quarantine with immutable original identities,
  source continuity invalidation, accepted reconciliation and snapshot recovery.
- Canonical assessment presentation in new version-3 journals with fixture-based
  offline replay and continuation compatibility for existing version-1/2 records.
- Explicit installed proposal policies, actual author signatures, canonical
  author-document payloads, exact successor and PRP1 finalization relations.
- Pure proposal lifecycle plans with whole-record CAS, exact admission jobs,
  terminal outcomes and serialized expiry/finalization.
- Separate bounded Memory/SQLite proposal journals, immutable service configuration,
  atomic private events/jobs/operation claims and recovery after actual process exit.
- Atomic bounded local context, compatible body-only replay, terminal receipt capacity
  reservations and a shared SQLite capacity seal across independent writers.
- Retained proposal contract binding to exact installed policy parameters/lifetimes,
  explicit per-contract policy enablement and indexed atomic record/context reads.
- Durable proposal service orchestration, current access checks before serialization,
  original publication/admission contract recovery and preflight receipt capacity.
- Optional owned verification-context retention in versioned proposal reservations,
  compatible legacy replay and original-context admission recovery after restart.
- Optional Mongo admission-history retention and exact scoped lookup, preserving
  default receipts and leaving older unbound provenance unresolved. This supplies
  history access; the concrete bounded Engine admission bridge remains required.
- Concrete SDK proposal evidence verification and signed PRP1/SQLite integration
  against pinned synthetic header ancestry, with ordinary admission kept separate.
- The default Bitcoin reducer/worker, including recovery of accepted decisions
  without network access and explicit sealing of the journal's non-final policy.
- All 32 approved reconciliation traces through the default worker and SQLite,
  with actual SDK verification, delayed proof completion and offline restart.
- Bounded wallet basket pages, finite provider-scoped lookup receipts and direct
  delivery with commit-before-acknowledgement. Optional adapters live under the
  separate `@bsv/output-knowledge/sources` entry.

## Remaining checkpoint-two work

Current wallet/domain work adds an opt-in local SQLite action-recovery controller,
atomic allocation records and exact prepared/final transaction retention. The
ordinary wallet route remains unchanged. The current complete wallet run passes
3,278 tests across 307 suites with the existing governed skip. Focused cases cover five actual process-termination boundaries,
all six wallet-funded covenant routes and ordinary allocation-failure compatibility.
Plan, the preceding combined byte-codec and controller mutation qualification
pass; the action-store campaign passes 96.24%/585. The later encoding/descriptor
refactor below requires fresh qualification of both complete modules. Core/client/mobile 2.15.0 source candidates
are coordinated; package publication remains a separate, unauthorized action.
These tests do not establish the
remaining same-seller genesis authority, selected-chain domain or private delivery
integration. The [local guide](../../docs/guides/local-action-recovery.md) documents
the opt-in schema, unsupported providers and whole-database backup requirement.

The SDK private-release boundary now has bounded release-evidence parsing,
independent selected-policy binding and registered processor BRC-77 verification.
Its 69 focused/compatibility cases include a 300-case generated property; mutation
passes 98% over 100 sites with zero uncovered/invalid. The purchase companion
adds closed status envelopes, original-request terms and separately signed
STEAK/POTATOES bindings. Its 30 focused/compatibility cases include a 300-case
property; full-source mutation passes 99.5% over 200 sites with zero uncovered/invalid.
The complete SDK including these additions passes 8,080 tests across 243 suites.
New BRC-195 publication and paid-lookup codecs add semantic protected-publication
fences and original-quote/result binding; twelve cases across four suites include
two generated properties and reach 100% lines/branches. Their full-source mutation
passes at 91.18% and 96.15%, respectively, with zero uncovered/invalid mutants.
The exact-payment funding helper additionally passes at 94.03%; the complete SDK
regression above includes these additions.
These codecs authenticate statements and bindings, not complete
acquisition, mining or decryption. Their [guide](../../docs/guides/private-overlay-release.md)
keeps the remaining service obligations explicit.

- Finish proposal contract configuration evolution, compaction preserving terminal
  fences, concrete durable admission bridges and restart-aware expiry scheduling.
- Finish provider qualification and connect live lookup to actual admission/projection
  producers and the reference application. Generic index publication requires all
  relevant producers and privacy writers to honor its atomic mutation/guard contracts;
  the provider alone does not retrofit those guarantees into existing topic managers.
- Bind BRC-101 capability selection to the authenticated transport and explicit
  non-final profiles while preserving finite legacy defaults.
- Exercise existing private off-chain values and lookup context, then implement
  acquisition, funding/recovery, STEAK/POTATOES readiness and secret release.
- Complete the BRC-100 wallet/domain integration above the BRC-197 lineage verifier for
  purchase, split, merge, payout, unanimous recipient-change and retirement.
  Low-level construction and final-layout checks do not establish those guarantees.
- Integrate BRC-198 LCH acquisition and playback without changing BRC-170 behavior.
- Implement BRC-199 root-host output eviction, all serving/replay/admission/GASP
  fences, restoration and multi-host consistency demonstrations.
- Extend the now-working live reference application with the remaining admission,
  private acquisition/release, covenant authority and root-serving integrations.
  Actual Chrome/native IndexedDB already exercises two authenticated hosts, live
  Script/SPV updates, tab-close recovery and independent source membership.
  The SQLite application also proves progressive populated snapshots.
- Finish API guides, operator guidance, conformance, property/mutation evidence,
  mobile/browser/packed-consumer checks and all exact-head remote quality gates.

Downstream application migrations follow the second review checkpoint. No package
publication, deployment or merge is authorized by this implementation checklist.

## Validation evidence and limits

The SDK foundation run passes 7,983 tests across 230 suites, including all proposal
endpoint variants and closed-envelope, canonical encoding and intrinsic-policy checks.
The provider increment's full output-knowledge run passes 836 tests across 54 suites,
with 97.46% line and 94.16% branch coverage. This includes the statement boundary,
independent retained-opening bindings and exact retained-byte quota cases;
final exact-head qualification remains required. Boundary tests cover durable assessment invalidation, exact replay
checkpoints, immutable source/context identities, partial storage histories and
projection publication/error isolation. Proposal tests also cover exact completion capacity,
concurrent-writer limit sealing, immutable local context and malformed SQLite
metadata/encodings. A signed capability and pending job recover together after
SQLite restart and manifest expiry. Service tests include current-access revocation,
original-selector recovery, proof-equivalent retries, concurrent SQLite expiry, lost
write acknowledgements and receipt capacity checked before admission. The concrete
evidence adapter runs actual SDK Script/Merkle checks on a signed PRP1 transaction.
The original journal-append target killed all 26 generated mutations. The expanded
receipt/workflow CAS target passes 93.87% over 212 mutations (197 killed, two
timeouts, thirteen surviving, zero uncovered/invalid) at the unchanged 90% gate.
The bounded BRC-193 client adds 53 unit tests and nine actual local HTTP tests
using SDK BRC-103/104 and the existing Express authentication middleware. They
cover signed snapshot/live/close responses, wrong peers, no authentication
downgrade, signed selection mismatches, corrupted signed bodies, unpaid errors
and cancelled-poll recovery. The complete middleware suite passes 217 tests.
These transport fixtures intentionally do not claim durable provider qualification.
The additional live source integration exercises actual loopback HTTP, SDK BEEF
verification and SQLite, including progressive pages and a missed live group
recovered after disconnect/reopen. Its 86 focused cases also cover five actual
process-exit stages, exact receipt substitution, reset persistence, physical
cancellation ownership, authenticated binding, timing and storage capacity.
The live-source mutation coverage is split into two independently gated campaigns
after the combined hosted job exceeded its 45-minute deadline. The original
operation/configuration/source-state target passes 90.27% over 586 mutations
(459 killed, 70 timeouts, 57 surviving); the framing/receipt/work-boundary target
passes 92.68% over 355 mutations (299 killed, 30 timeouts, 26 surviving). Both have
zero uncovered or invalid mutants and retain the unchanged 90% minimum. The same
six production files and complete focused test selection participate, with no
mutation/operator exclusions; governance tests enforce the exact union. Local
campaigns finished in 16m35s and 10m31s. These runs include the stronger latest-context
assertion and a 300-case property preserving original identity and receipt-gated
advancement. That published client increment has its own hosted evidence below.
The provider qualification and required live application remain open.
The new provider and actual authenticated HTTP adapter exercise SQLite snapshot/live
continuation with two clients, missed-change recovery, manifest rotation, immutable
original responses, current revocation, exact limits and cross-process writes.
Process tests terminate before and after opening commit, interrupt compaction, race
two independent writers and move the clock while another process holds the database
lock. These fixtures exercise membership/framing and provider recovery; they are not
claims of application-level Bitcoin spend acceptance or production deployment.

Eleven new mutation campaigns pass the unchanged 90% minimum with zero uncovered or
invalid mutants: codecs 94.44%, query mapping 96.43%, batch/wait composition 91.48%,
provider service/work 96.31%, session codec/disclosure 93.04%, index 91.38%, index
records 97.04%, session record/schema 93.42%, retained payloads 97.28%, session
response gates 92.54%, and HTTP transport 90.04%. Together these exercise 3,822
mutants. Independent cases cover authenticated headers, original request and
manifest bindings, exact retained-byte capacity, and the native statement boundary.
The complete session-record source is partitioned at the `saveOpening` responsibility
boundary to leave CI headroom. Both jobs keep every previous regression, the
300-case provider property and the 300-case SQLite record rollback/identity property.
The record/schema and payload runs finished in 27m41s and 26m40s. Governance checks
require a contiguous complete source union and identical test selection; no operator,
source or threshold is excluded. The complete Express suite passes 559
tests across 19 suites. Root lint/format and affected type checks pass. Exact packed
runtime and Express exports and clean consumers pass, including the legacy Express
root with registry SDK 2.8.9 in ESM/CJS and strict .mts/.cts TypeScript consumers.
The optional lookup feature requires SDK 2.9.0. Browser composition passes without
SQLite, and all eleven public-interface documentation examples compile against 22 exact
tarballs. The [provider guide](../../docs/guides/durable-live-lookup.md) covers initialization,
recovery, privacy writers, mounting, retention and operational limits.

The source tests include a held SQLite append, storage failure, finite pagination,
non-cancellable wallet I/O, independent fast/slow hosts and host-local refresh.
Observation identities remain immutable within their complete source epoch across
local refresh generations and SQLite restart.

The expanded SDK authentication mutation target passes 86.57% over 752 mutants
(594 killed, 57 timeouts, 101 surviving, zero uncovered/invalid) at its unchanged
gate. Workflow control storage adds 49 cases across three adapters, including
multiple connections, lost acknowledgement, SQLite process exit, changed binding,
corrupt revisions, missing storage, aborted IndexedDB transactions and late opens
after timeout. A 300-run property checks concurrent CAS winners and stale retries.
IndexedDB unit cases use a test implementation. A separate exact-tarball Chrome
consumer exercises native IndexedDB, strict CSP, page/browser restart, captured
batch replay, receipt-before-cursor ordering, cross-tab CAS and missing recovery
stores. Its empty-batch fixture isolates client storage; it is not authenticated
service, mobile or full application qualification. Its optional browser entry is separately
measured and bounded; no existing entry budget is raised.
Changed identities now retain the conflicting receipt in bounded quarantine,
publish a durable source continuity change, and recover through a new snapshot.
Offline restart reproduces the quarantine without additional verification; other
providers and already accepted Bitcoin facts remain unaffected.

Sequential driver work is explicit: synchronous adapters preserve immediate ownership
and CAS checks while returning rejected Promises for failures, and dependent
journal/transaction operations are pulled one at a time. Eleven runtime tests check
Promise behavior, pull-driven backpressure, iterator closure and non-assimilation
of host values; four additional focused SDK tests
check certificate-wait ordering, original error identity and the exact deadline.
The checkpoint metadata parser now admits valid maximally escaped strings within
a separate 64 KiB bound, without changing wire response limits. Original captured
journal fixtures are unchanged. Certificate-wait fixtures observe rejected work
before assertions and bound unexpected waits. The complete SDK and runtime
mutation targets pass without uncovered or invalid results. Explicit asynchronous
iterators preserve dependent write order without scheduling transaction writes
concurrently. Node-only Mongo iteration uses bounded object-mode streams; browser
code retains a portable iterator contract. No analyzer suppression or gate is changed.
Published live-source head `74cc115d720e42c3d7364060bdb9b2a12dd76107` passes 76 hosted
checks with two expected skips, including CodeQL and the exact-head Sonar gate.
Provider head `810f41ec06e5167faeaa773bf1692ecf9a1aa4bd` resolved all seventeen
previous Sonar findings, but its hosted run exposed two further analyzer findings
and newly reported dependency advisories. The follow-up fixes pass local gates;
their exact-head hosted qualification remains pending.

The revenue codec adds 56 deterministic cases and one generated property over at
least 300 schedules, including independently frozen genesis script bytes and
independent byte-offset assertions. Its full-source mutation campaign passes
93.51% over 154 mutants (144 killed, ten surviving, zero uncovered/invalid) at the
unchanged 90% gate. Exact ESM/CJS and strict TypeScript consumers and the separately
bounded Vite/esbuild entry pass. This is codec qualification, not completed spend,
lineage, consent, wallet or application qualification.

The route-construction increment passes 54 planner cases, 99 signing cases,
30 independent frozen rejection cases and two properties with at least 300 cases
each. All twelve accepted frozen transactions rebuild byte for byte and every
input executes under the SDK interpreter. Tests include eight-recipient consent,
maximum dimensions, exact signature authority, conservation, complete owned display
plans, funded snapshots and prepared/completed byte limits. After analyzer-driven
refactoring, planner mutation passes 97.71% over 262 mutants (256 killed, six
surviving, zero uncovered/invalid). Funded-construction mutation passes 94.13% over 409 mutants (385 killed,
24 surviving, zero uncovered/invalid), including complete owned display plans,
at the unchanged 90% gate. The campaign finished in 14m18s.
The complete SDK run passes 8,018 tests across 231 suites. Exact ESM/CJS/strict
packed consumers and all declared browser entries pass. Eleven compiled examples
pass against 22 exact tarballs and documentation validates 138 HTML routes. These
results do not establish full lineage, wallet, private fulfillment or application
qualification.

The bounded JSON parser builds own data fields through a Map and native
Object.fromEntries while preserving null prototypes, accepted keys and
writable/configurable/enumerable attributes.
Its 58 focused tests include a generated property with at least 300 cases. Full
source mutation passes 91.67% over 372 mutants (335 killed, 31 surviving, six
timeouts, zero uncovered/invalid). The two local authenticated HTTP fixtures use
the already governed express-rate-limit 8.6.1 development dependency; middleware
runtime behavior is unchanged. The manifest change carries patch candidate 2.2.9.
All 217 middleware tests and packed Express 4/5 consumers pass. Published head `0140b37ea8b620394ba4f26a0ea40ee63f4f3ba7` passes both CodeQL and
the exact-head zero-new-Sonar gate, with all four analyzer review threads resolved.
Its hosted spend mutation job reached the 45-minute deadline, so complete CI is
not qualified. The follow-up keeps every source line and original test while
partitioning funding, signature/ABI and public spend behavior into independently
checked jobs. Two additional 300-case properties and a no-gap/no-overlap partition
regression pass. The partitions retain the 90% gate and reject all uncovered or
invalid mutants: funding 93.63%/157, unlock 93.70%/127 and spend 95.20%/125.
Together they still mutate all 409 original sites. No source or gate was weakened.
The expanded SDK suite passes 8,020 tests across 233 suites; packed conditional
exports, strict consumers and every declared browser entry pass again.

Compatible dependency remediation advances the existing brace-expansion
substitution and affected lock resolutions without adding an override or relaxing
release-age policy. Workspace, four standalone service and codegen audits report
zero vulnerabilities. The four service suites pass 641 tests; affected wallet
rate-limit, CHIRP and AuthSocket checks pass 4, 150 and 50 tests. All affected builds,
frozen installs and deterministic codegen checks pass. The latest documentation
build validates 138 HTML routes and eleven examples against 22 exact tarballs.

Root health, lint, formatting and type checking pass. Packed-consumer resolution
and all declared browser entries pass. Core browser byte limits remain unchanged;
the optional adapter entry is independently measured and enforced. IndexedDB unit
tests use fake-indexeddb; the separate Chrome consumer qualifies native storage
and recovery. Full provider, application and mobile qualification remain required. The
journal-backed trace binding is documented alongside the unchanged approved
fixtures; selection-function tests remain an independent layer.

Installed-policy head `332cfd9f5` passed all 41 applicable
hosted checks; two infrastructure/dependent-test skips were accepted by merge-gate.
This includes CodeQL, zero new Sonar findings, external Codecov and the repository
coverage gate. Storage/context head `671d079ee` also passed every applicable
hosted check, including external patch coverage at 90.24%. Installed contract head
`e24e96bd2` passed all 41 applicable checks, with two expected scope skips. Subsequent
implementation increments require their own validation.

These are intermediate results. The PR remains draft until the entire
checkpoint and all required checks succeed on its exact final head. Remote CI,
CodeQL and Sonar evidence must be recorded in the PR before review.

The lineage increment passes 98 focused tests, including three generated properties
with at least 300 cases each, and the complete runtime passes 934 tests across
61 suites (97.56% lines, 94.35% branches). All three new lineage sources have
100% line and branch coverage. Full-source mutation passes at the unchanged 90%
minimum with zero uncovered/invalid mutants: package 97.26%/146 (141 killed,
four surviving, one timeout), graph 96.25%/320 (306 killed, twelve surviving,
two timeouts), and verifier 91.87%/123 (111 killed, ten surviving, two timeouts).
The frozen cases separately prove that a funded-copy merge can pass Script yet
fail shared-genesis provenance, and that a mining proof does not bypass explicit
covenant execution. Exact packed consumers and the optional Vite/esbuild entry
pass; existing entry budgets are unchanged. The compiled lineage example passes
against the exact candidate tarballs. These results qualify the historical
verifier, not the remaining wallet/domain/application integration. The broader
implementation checkpoint remains open.

Dedicated authority ports and a software adapter keep listing authority separate
from funding-wallet custody. The same seller identity authorizes genesis and
Script administration, with owned asynchronous signing requests and independent
verification of returned signatures. Six frozen routes execute and rebuild byte
for byte; 33 focused cases include a generated property with at least 300 runs.
Full-source mutation passes 98% over 150 mutants, with zero uncovered/invalid.
The complete current output runtime passes 967 tests across 63 suites (97.57%
lines, 94.38% branches). No hardware signer, private fulfillment or live-chain
integration is inferred from that adapter.

SDK paid-funding inspection bounds the complete header and Atomic BEEF, derives
the expected P2PKH script from an independently supplied BRC-29 public key, scans
all outputs and rejects duplicates or inexact amounts. Six tests cover generated
output positions and duplicate scripts, actual matching buyer/seller ProtoWallet
derivations, representation-independent funding IDs and owned snapshots.
Coverage is 100% lines/branches and mutation passes 94.03% over 67 sites with zero
uncovered/invalid. The complete current SDK passes 8,080 tests across 243 suites
(95.70% lines). The HTTP and durable acquisition layers still must authenticate,
derive that key independently, verify Bitcoin/release policy, reserve the globally
unique funding outpoint and reconcile wallet effects.

Action-recovery qualification passes plan mutation at 95.90%, owned-byte codec at
92.07% and controller at 96.46%, with zero uncovered/invalid mutants. The storage
campaign passed 96.23% before a subsequently reproduced installation-configuration
race: a caller could change the limits object while SQLite installation yielded.
Both new recovery stores now copy the limits before any asynchronous work.
Nineteen storage boundary cases pass; the final 585-mutant action-store campaign
passes 96.24% with zero uncovered/invalid after a passing 158-test dry run.
The complete current wallet regression passes 3,272 tests across 304 suites.

Local funding recovery retains intent, a unique funding claim, ownership, durable
monitor work and its terminal receipt in the same SQLite database. Its focused
cases include three properties of at least 300 cases, five actual SIGKILL/reopen
boundaries, a two-process duplicate-payment race, mined/cached proof reconciliation,
existing noSend and legacy ownership, and offline terminal replay. The 25-case
controller suite also passes the retained request to the ordinary TaskSendWaiting
worker with a local synthetic processor response, then verifies the unmined
transition, unchanged receipt and unchanged credit after retry. This makes no
public processor or settlement claim.

Funding-protocol mutation passes 94.83% over 58 sites and the combined controller
and optional hooks pass 91.88% over 271 sites, with zero uncovered/invalid. The
current funding-store campaign includes the owned-capacity fix and strengthened
receipt/ownership checks; its 58-test dry run and 92.09%/430 mutation campaign pass
with zero uncovered/invalid.
Both stores require whole-database and wallet-key backup; their auxiliary state
is not included in legacy entity snapshots or ordinary sync.

Packed wallet/runtime consumers and 14 compiled examples pass. A permanent
packed-consumer regression preserves root and existing deep wallet imports with
SDK 2.8.11, and the existing Overlay Express check remains on SDK 2.8.9. Both use
strict ESM/CJS TypeScript consumers with skipLibCheck disabled. An erased local
commit-hook interface prevents the optional SDK 2.9 funding types from leaking
into existing method declarations; its original new-module type export remains
available and the runtime emit is unchanged. These local results do not complete
the implementation checkpoint, qualify remote/mobile recovery or make CI green.

Quote issuance still needs a durable wallet-capacity guarantee integrated with
its protected-result and ledger reservations. The local funding adapter reserves
only when retaining a known funding operation; a prior free-space check cannot
make the complete BRC-195 readiness promise. Preserve this as an explicit service
integration requirement before advertising the profile.

The concrete app is in `apps/output-knowledge-reference`. Six application tests
and a production-bundle Chrome/native IndexedDB scenario pass. Two independent
providers and two clients demonstrate populated progressive snapshots, live
Script/SPV updates, offline replay, provider restart, page-close recovery and
independent source membership. Both desktop and narrow layouts were inspected.
The workbench uses public fixture identities and a pinned synthetic easy-PoW
chain; its trusted producer explicitly writes the read model. Ordinary topic
admission, private acquisition and native mobile qualification remain separate
work. The [workbench guide](../../docs/guides/output-knowledge-workbench.md)
provides reproducible commands and those boundaries.

CI's shared artifact now includes application browser and server bundles; an
actual archive-content regression preserves existing package outputs and excludes
application dependencies and mutation sandboxes. Five previously canceled full
mutation campaigns receive a 90-minute hosted job limit after reaching the old
45-minute deadline: lineage package/graph, SDK listing funding and lookup session
records/payloads. All other job limits and all test, mutant, worker and quality
thresholds remain unchanged. Exact-head hosted qualification is still required.

The action store's complete 585 mutation sites are now partitioned into
installation/binding (170), record/accounting (229) and operation transitions
(186). All partitions retain the complete 160-test selection and independent
90%/zero-uncovered/zero-invalid gates. Two additional generated properties each
run at least 300 cases; a regression enforces contiguous, non-overlapping source
coverage and identical runner/test configuration. The whole-file source passes
96.24%; independent partitions pass 98.82%/170, 95.63%/229 and 94.62%/186,
respectively, with zero uncovered/invalid mutants. Each report's source matches
the committed file. The installation campaign retried one crashed V8 worker;
its completed report contains no invalid mutant. Shared-host durations are not
controlled performance measurements or hosted CI qualification.

Core/client/mobile Wallet 2.15.0 artifacts pass their packed exports and strict
consumer checks. Core's permanent SDK 2.8.11 root/deep compatibility regression
passes. Client Vite/esbuild and mobile Metro/Hermes package compositions pass
unchanged platform budgets. These checks establish package compatibility, not
native device recovery or new SQLite capabilities in the wrappers. Candidate
notes and API pages retain that boundary, whole-database/key recovery and rollback
requirements. No npm publication, deployment or checkpoint approval follows
from these local results.

The BRC-199 codec passes 19 cases across two suites, including five frozen wire
vectors and two generated
properties of at least 300 cases each. Full-source mutation passes 97.07% over
239 sites with zero uncovered/invalid; source line/branch coverage is complete.
Tests distinguish pending partial results, saved action revisions, fresh serving
snapshots, independent blockers, exact expiry and authenticated selection. SDK
packed exports and strict ESM/CJS consumers pass, as do existing browser budgets.
Fifteen documentation examples compile against 22 exact tarballs and 145 HTML
pages validate. The [root guide](../../docs/guides/root-eviction-coordination.md)
documents the remaining durable service, evidence, local-policy and all-path
serving requirements. No root service readiness follows from codec qualification.

The subsequent complete SDK run passes 8,094 tests across 245 suites with 95.72%
line coverage, before adding the five frozen wire cases above. Those vectors also
pass their focused suite and the same full-source mutation gate. Independent
Python SHA-256 reproduces their request, result, advertisement and decision
digests. Their mock chain and opaque proof fixtures qualify wire contracts only.

Analyzer follow-ups preserve canonical recovery key order using an explicit
UTF-16 comparator, exact ASCII derivation bounds, and sequential wallet SQL/input
processing. The recovery suite passes 177 tests across 23 suites, and 63 ordinary
wallet action tests pass across five suites. The preceding source mutation requalification
passes plan 95.42%/131, codec 91.34%/439, transitions 94.54%/183, funding store
92.45%/424 and funding controller 91.88%/271, all with zero uncovered or invalid
mutants. The codec campaign recovered from one crashed V8 worker and completed in
72 minutes 30 seconds on the shared host. Six additional exact recovery targets
that reached their hosted 45-minute deadline receive the same bounded 90-minute
allowance in both workflows; thresholds and selected tests remain unchanged.
The coverage aggregator incorrectly classified three CommonJS
test helpers under the existing singular `__test` convention as production. A
classification regression now recognizes exact test directory names while keeping
similarly named production paths governed. Against the exact published CI LCOV,
the corrected gate passes at the unchanged target: 97.15% (13,020/13,402 points).
These local results do not establish a green hosted branch.

The root journal currently passes 130 tests across ten suites, including three
replayable properties with at least 300 cases each, two actual process-kill
boundaries and a separate writer excluded while an IPC response is queued.
Additional cases cover corrupted retained bindings, exact 1 MiB result budgets,
U64 completion reservations, native SQLite durability, full API limits and
immutable partial-batch retries. The first whole-source campaign exposed test
gaps (70.03%/981, five uncovered); that report is retained, and the expanded suite
has been requalified across three disjoint source groups with the same complete
test selection. Every original source file remains governed at 90%, zero
uncovered and zero invalid; no waiver or exclusion was added.
Before the checked-method increment below, the orchestration group passed 98.64% over 221 sites and the record group passes
96.73% over 428 sites; storage passes 95.18% over 332 sites. All three had zero
uncovered/invalid and exact source matches for that increment, preserving all 981
original sites. Records and storage remain unchanged; the extended orchestration
source is being requalified below. The orchestration runner recovered one V8 worker abort. Three additional
API cases independently verify request/target quotas, exact retries at capacity
and serving/reassessment binding to the original advertisement. These pass
without changing production source or its qualified mutation reports.

The preceding combined runtime passed 1,015 tests across 70 suites, 97.71% lines
and 94.60% branches, before the expanded journal tests. Journal history and
advertisement evidence properties also each passed 5,000 cases. The new complete
runtime run passes 1,111 tests across 75 suites in 268 seconds, with 97.71% lines
and 94.68% branches. Types, packed artifacts, browser/IndexedDB checks,
17 compiled examples against 22 tarballs and 145 HTML pages passed before the
new middleware integration. The root guide records same-host storage, consistent
backups, permanent fences, manual policy and incomplete service integration.

The root evidence component adds fourteen tests in two suites, including at least
300 generated signed request identities/actions, both advertisement formats, exact
consumption, independent proof variants and synthetic mined inclusion paths with
checked header links and proof of work. Source line/branch coverage is complete.
Full-source mutation passes 97.85% over 93 sites with zero uncovered or invalid.
The fixtures contain public synthetic keys and a labelled easy-work ancestry;
they do not qualify production chain currentness or operator policy.

The optional authenticated response queue now has eighteen actual HTTP cases,
22 additional boundary cases and expanded internal/legacy transport-failure and
native lifecycle cases.
Its generated property passes 5,000 authenticated exchanges. The complete
middleware suite now passes 310 tests across fourteen suites, with 97.54% lines and
94.27% branches, including native lifecycle, ownership, listener cleanup, legacy
error reporting and final HTTP-framing assertions. The queue companion
has complete line and branch coverage.
A signing-time invalidation discards the original response and
re-signs a bounded replacement for the same request. Disconnects, deadlines,
late/duplicate callbacks, malformed replacement and unsupported buffering fail
closed. Packed ESM/CJS and clean Express 4/5 consumers with old/current SDKs pass
both ordinary and new guarded response probes. Mutation qualification is recorded below; expanded
root-service wiring and final all-path demonstrations remain outstanding; this is
not a claim that every root-host serving path is guarded. All eighteen compiled
documentation examples pass against 22 exact tarballs, and 145 HTML pages validate.

The first four-worker middleware mutation dry run selected all 262 tests. It was
stopped for the framing correction before any final score. Its retained sandbox
exposed duplicate normal Jest discovery. Root-anchored generated-child ignore
patterns now preserve authored tests and the current mutation root, with a
regression; no sandbox deletion or authored-test exclusion substitutes for the
fix. Certificate tests use their actual assigned ephemeral port while retaining
all assertions and the existing server helper. The ordinary suite passes on the
corrected source. The first completed 387-site campaign failed at 74.29%, with one
uncovered mutation and two invalid worker results; the failed report is retained.
The expanded tests explicitly await internal builder completion so a bad legacy
failure path fails its test instead of crashing a worker afterward. The next campaign reached 97.13% over 387 sites but still failed with four invalid
worker results. Those failures exposed unawaited test promises, including two
existing legacy hardening cases; explicit completion capture now preserves and
awaits the original promises and all assertions. A separate production regression
rejects nonempty HTTP 205 bodies before signing, as required by RFC 9110, with an
actual authenticated empty-205 success case. Final full-source qualification passes at 97.42% over all 387 sites: 357 killed,
20 timeouts and ten survivors, zero uncovered/invalid. All 310 tests run in its
dry run; the report matches both current production sources exactly. Stryker
recovered one V8 worker crash and completed in 22 minutes 45 seconds. These are
shared-host qualification results, not performance guarantees or hosted CI.
Neither failed report is waived and every gate remains unchanged.

The optional Overlay Express root response guard connects actual BRC-104 signing
and native enqueue to the SQLite journal fence. Twenty focused cases have full
component line/branch coverage; mutation passes 97.59% over all 83 sites, with zero
uncovered/invalid and an exact source match. The complete Overlay Express suite
passes 579 tests across 22 suites. Packed ESM/CJS exports and the permanent legacy
SDK 2.8.9 strict consumer pass. Generated-child Jest discovery now excludes only
nested generated copies while retaining authored and current-sandbox-root tests.
All 19 compiled documentation examples pass against 22 tarballs, and all 145 HTML
pages validate. The guard does not yet mount the coordination service or retrofit
every cache, snapshot, live, finite-lookup and GASP serving path.

The separately coordinated Axios correction updates five standalone locks from
1.18.1 to 1.20.0, preserving manifests, other resolutions and lock formats.
Independent frozen installs, permitted native rebuilds, builds/lint, 645 service
tests and five zero-finding audits pass. Ten local GET/POST requests and five
pre-cancelled requests pass against the installed packages. Dependency evidence
retains the prior ip-address correction. No workstation publication or deployment
was performed.

The optional checked root methods sample a trusted clock after acquiring the
shared SQLite gate, recheck local authorization and the installed policy/context,
and return an owned observation of the resulting head. Existing deterministic
methods, persistence format and behavior remain available. Thirty-six focused
cases include a separate-process writer holding the actual gate, expiry at the
acquired decision boundary, denied access before effects and recovery of an old
completed action under a newer current policy. The complete commit-context helper
passes 100% over 30 mutation sites with zero uncovered/invalid. The complete changed
store passes 98.73% over all 237 sites (234 killed, three surviving), with zero
uncovered/invalid and an exact source match after its 166-test dry run.

At the checked-methods increment, the complete runtime passes 1,147 tests across 77 suites, with 97.72% line
and 94.68% branch coverage. Types and packed consumers pass, as do all 20 compiled
documentation examples against 22 exact tarballs, root health/lint/format and
145 HTML pages. The registry has 79 implemented properties and 79 critical targets.
Broader local blockers, the actual root coordinator and complete serving-path
installation remain required; checked ports alone do not supply them.

The portable root-contract component passes 16 focused cases and 100% line/branch
coverage, including a generated property of at least 300 signed selections. Its
first mutation run reached 87.50%; adding assertions that installation/selection
refusals include usable diagnostics brings the unchanged complete source to
93.75% over 32 sites, zero uncovered/invalid, with an exact source match. Original
selection survives manifest expiry, rejects a different digest, retains explicit
critical-extension support and honors narrower advertised limits.

The optional root entry passes measured and enforced exact-tarball browser
contracts: Vite 169,709/54,839/46,557 and esbuild 131,158/50,825/43,951 raw/gzip/Brotli
bytes, one chunk and two packages. Existing entry budgets are unchanged. Packed
exports and all 21 compiled examples against 22 tarballs pass. The registry now
has 80 actual properties and 80 critical targets at this increment. The helper does not yet add the
atomic request/contract persistence or mount the coordination service.

## September 30 corrective qualification in progress

The later complete runtime passes 1,163 tests across 79 suites, with 97.72% line
and 94.68% branch coverage. Analyzer corrections preserve lazy expiry priority,
serving-state precedence and projection revision checks. Process workers now use
fixed files in their isolated fixture directory; all cross-process gate and
crash assertions remain. The complete changed records source passes 97.65% over
426 mutations (416 killed, ten surviving), with an exact source match and zero
uncovered or invalid mutations. Authentication production sources are unchanged by the
remaining assertion-style correction; all 310 middleware tests pass.

The published combined wallet-codec campaign exceeded its 90-minute hosted limit
after a successful 163-test dry run. The internal refactor separates canonical
JSON/binary ownership from retained wallet descriptor validation while preserving
all existing Codec exports, encodings, errors and resource limits. Funding-root
membership now uses a set rather than a repeated input scan. The same maximum-input
fixture retains its exact 580,733 bytes and digest. Shared-host diagnostic medians
were 22.1 ms before and 10.5 ms after; these are not controlled performance results.
Both complete modules retain the same full recovery test selection and independent
90%/zero-uncovered/zero-invalid gates. No deadline or worker limit is raised. A
new descriptor property and partition regression bring actual registries to
81 properties and 81 mutation targets. Encoding passes 91.81% over all 171 sites
(157 killed,14 surviving), with zero uncovered or invalid mutations; the runner
recovered one worker crash. Its source matched exactly before removal of one
trailing blank line; executable code is unchanged. The descriptor campaign passes 90.91% over all 264 sites (240 killed,24 surviving),
with zero uncovered/invalid and an exact production source match. The partition
preserves the full 164-test dry-run selection. Fresh hosted reports remain required.

The refactor passes 57 focused cases and all 3,278 wallet cases across 307 suites,
with the existing governed skip. Core, client and mobile packed checks pass,
as do strict older-SDK consumers, Vite/esbuild browser and Metro/Hermes mobile
checks. All 21 compiled examples pass against 22 tarballs; 145 HTML pages validate.

The separate infrastructure audit correction changes only seven gRPC resolutions
and two IP resolutions, with 658 service tests, seven zero-finding audits and
ordinary gRPC/cancellation/IP checks. The root-response test fixture gains a
pre-authentication limiter using the already locked development dependency and
explicit store teardown. All 579 Overlay Express tests and packed/older-SDK
consumers pass. Fresh exact-head Sonar, CodeQL and complete CI remain required;
local corrections do not resolve a hosted review thread by themselves. The
published root-journal and root-record jobs also reached their 45-minute job caps
after successful 166-test dry runs. Only those two existing targets join the
existing bounded 90-minute CI allowance, covered by the exact orchestration
regression; source/test selections, workers, per-test deadlines and pass gates
remain unchanged. Their next exact-head hosted reports are still required. None of
these corrections completes atomic root contract/request storage, the full root
service or the remaining checkpoint-two integration work.

## Atomic root coordination storage in qualification

The opt-in coordinated journal binds original capability records to signed request
fences in one transaction, enforces all selected limits and reserves future result
capacity. Default format1 behavior is unchanged. Explicit format2 creation and
transactional `upgradeCoordination` preserve history; every operation fences
already-open older connections after upgrade. Legacy raw requests never acquire
invented initiation contracts.

The 16 focused cases pass, including generated capacity/retry/restart histories
and actual process kills before contract insertion and after the combined commit.
The complete runtime passes 1,179 cases across 83 suites, with 97.75% line and
94.74% branch coverage. The new contract records and changed root codec, database,
request records and store reach 100% line and branch coverage. Packed consumers,
all 22 compiled examples against 22 exact tarballs, browser artifact contracts,
all 579 Overlay Express cases, repository checks and 145 HTML pages pass.

Mutation qualification of the complete new and changed root sources and fresh
hosted evidence remain required. The registries contain 82 property suites and
82 critical mutation targets, preserving all previous targets, source/test unions,
worker limits and quality gates. This is not the complete coordinator, scheduler,
broader-ban layer or serving-path integration.

The strengthened coordination assertions bring the unchanged 77-site source to
96.10% (74 killed,three surviving), zero uncovered/invalid and an exact source
match. The rerun selects 184 root tests. Eighteen focused coordination cases now
pass; the preceding full 1,179-case report predates two additive boundary tests.
Complete changed storage, journal and records mutation runs remain required.

Upstream PR705 is integrated at local dd94cb850, retaining this branch's artifact
and bounded root deadline changes. All 21 CI orchestration/result regressions and
root health/lint/format/types/docs checks pass. This affects mutation launch
prerequisites only; no selected scope, threshold or failed gate is waived.

## Bounded root maintenance in qualification

The optional Node maintenance companion opens an existing sealed root journal,
scans bounded pending references and expires verified retained requests under the
same cross-process gate. It samples time and current maintenance authority inside
the gate, preserves completed outcomes and original capability records, and never
authorizes suppression, restoration or requester disclosure. The default APIs and
both existing storage formats remain unchanged. Hosts still install the bounded
startup/periodic scheduler and the complete coordinator.

Twelve focused cases pass across three suites, including at least 300 generated
scan/retry/restart histories, two actual process kills and a separate writer holding
the gate across the expiry boundary. Complete-source mutation kills all 61 sites (100%), with zero uncovered/invalid
and an exact source match; its dry run selects all 196 root cases. The full runtime
passes 1,193 cases across 86 suites with 97.76% line and 94.75% branch coverage;
the maintenance module has complete line and branch coverage. Packed exports and
strict consumers pass. Repository health/lint/format/types,
23 compiled examples against 22 exact tarballs and 145 HTML pages pass. The
remaining changed journal groups are tracked separately. The append-only registry now contains 83 actual properties
and critical mutation targets with all prior unions and quality gates preserved.

The subsequent original-contract worker recovery companion has five focused cases
passing across two suites, including an extended 300-case original-selection
property. It resolves the saved selector and current result by permanent digest
under local worker authority, without rediscovery or requester impersonation.
Absent legacy selection remains unavailable, and independent maintenance expiry
continues under revoked requester access or unavailable chain context. Existing
coordinated signatures and stored formats remain unchanged. Complete changed
contract/journal mutation qualification and final integration evidence are pending.
The preceding maintenance increment also passes all 579 Overlay Express cases.

Exact published head99 also reached its 90-minute limits for the 320-site lineage
graph and 332-site root storage campaigns after successful full dry runs. These
remain cancelled qualification, not passing evidence. The subsequent complete
435-site changed-storage campaign continues locally under its original captured
configuration and test selection; its eventual report must be recorded as that
combined campaign, not relabeled as a new partition.

The next governed configuration separates the complete RootEvictionCodec from
the remaining database/storage sources and partitions unchanged LineageGraph
source contiguously into layout/ABI/genesis checks and traversal/execution. Every
original source line and test remains selected; each partition keeps independent
90%/zero-uncovered/zero-invalid gates, the same workers and its existing/default
deadline. Two new generated properties pass at least 300 cases each, and 19
registry regressions prove the exact disjoint source union and full identical
test/additional-input selections. Actual registries now contain 85 properties and
85 critical targets. Fresh independent partition reports and hosted qualification
remain required; no implementation byte was changed merely for instrumentation.

The combined recovery/property increment passes all 1,199 runtime cases across
89 suites, with 97.76% line and 94.75% branch coverage. Changed contract records
and the SQLite journal have complete line/branch coverage. Packed exports and
strict consumers, all 24 compiled examples against 22 exact tarballs,
health/lint/format/types and 145 HTML pages pass. The source/test cohort remained
unchanged during this run. Complete mutation qualification remains in progress.
