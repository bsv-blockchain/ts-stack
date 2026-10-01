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
  default receipts and leaving older unbound provenance unresolved.
- An optional bounded Engine proposal-admission bridge, recovering original
  retained receipts and projecting only the selected topic. Actual Engine/Mongo
  restart and lost-response tests pass, and complete-source mutation passes
  96.88%; full HTTP/service composition remains required.
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
  fences, full service/admission composition and restart-aware expiry scheduling.
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

## Root intake and signing composition in qualification

The optional `RootEvictionService` now connects actual received-text intake,
original-contract recovery, separately authorized status reads and installed root
signing. It retains requests before signing, checks the original selected raw and
canonical request bounds, and rejects authentic signatures over changed observations.
It returns the observed revision for the separate native final-enqueue guard;
it does not mount HTTP routes or authorize automatic peer decisions. A shared
internal bounded-work primitive preserves the existing lookup constructor, defaults,
diagnostics and cancellation behavior. Cancelled callers retain physical capacity
until the installed authority/signing operation settles.

The complete runtime passes 1,222 cases across 92 suites, with 97.78% line and
94.76% branch coverage. The new service, contract records and lookup wrapper have
complete line/branch coverage. Thirty governance/selection/example regressions,
packed consumers, 25 compiled examples against 22 exact tarballs, browser checks,
root health/lint/format/types and 145 HTML pages pass. Two explicit mock type
annotations were added during the runtime run to fix portable test declarations;
a compiler comparison verifies their emitted JavaScript is identical. All other entries in the
233-file cohort stayed unchanged. Actual property/critical-target counts
are 86, with complete prior source/test selections and independent gates retained.

The original combined storage campaign passes 91.26% across 435 sites (395 killed,
38 surviving and two detected timeouts), zero uncovered/invalid and exact source
bytes, after one automatic worker recovery. This is the pre-partition campaign,
not a report for either new independent target. The database-only subset motivates
stronger exact capacity, inventory-recovery and pre-invocation callback assertions;
15 focused storage cases pass. Complete independent database/codec reports, the
changed 97-site coordination and 426-site records campaigns, service/lookup/journal
mutation and final hosted qualification remain required. No broader checkpoint or
complete root-service readiness is implied.

## Optional root coordination HTTP composition

The optional `@bsv/overlay-express/root-eviction` entry now composes the shared
bounded service with exact request/status routes and the actual BRC-103/104
handshake. It preserves received UTF-8 bytes, checks the selected raw byte limit,
retains work before signing, and uses the observed journal revision plus current
requester/auditor access at native enqueue after both signing stages. Public
credential-free CORS remains the default, with explicit exact-origin opt-in.
Legacy routes and startup remain unchanged. Capabilities, scheduling, all-path
serving/admission/GASP integration and native host configuration remain separate
unfinished obligations; the router alone does not claim the complete profile.

The production increment passes the complete Overlay Express suite (620 tests
across 24 suites); the subsequent test-only additions pass 42 focused cases,
including 300 generated packet/HTTP-signing schedules with bounded fixture
rotation. Packed ESM/CommonJS consumers and strict legacy SDK 2.8.9 consumers pass.
All 26 compiled examples pass against 22 exact tarballs; root health, lint,
formatting, types and the 145-page documentation build pass. The independent
full-source HTTP mutation campaign is still pending and the actual registry is
87 targets/properties at unchanged gates. No checkpoint or exact-head hosted-CI
completion is claimed by these local checks.

Completed independent root campaigns retain exact current production sources:
records 97.65% over 426 mutations (416 killed), coordination 91.75% over 97
(89 killed), and service 90.14% over 71 (64 killed), all with zero timeouts,
uncovered or invalid mutants. The coordination rerun replaces its earlier
29-timeout observation after test start barriers were made fail-fast. Automatic
worker recovery occurred three times in the records run and once in the
coordination run. The independent database, codec, journal, lookup and lineage
qualification work remains separate from these results.

## Native host integration and HTTP boundary qualification

`configureRootEviction` now installs the optional routes before generic host
parsing. It verifies the configured identity against the server wallet and shares
one authentication/session instance and request-capacity limit with authenticated
lookup and admin routes. The handshake is mounted once. Root origins inherit the
host policy unless explicitly overridden, and request/response byte limits are
clamped to the host ceilings. Injected journal and worker lifecycle remains with
the application. Stable structural declarations keep the lazy main entry usable
with older SDK peers; no peer floor or strict-consumer check was weakened.

The complete Overlay Express suite passes 667 tests across 25 suites, including
79 focused HTTP cases and generated schedules. Packed ESM/CommonJS and strict
SDK 2.8.9 legacy consumers pass, as do all 27 compiled examples against 22 exact
package tarballs, 23 governance/example regressions, root health/lint/format/types
and the 145-page documentation build. Exact route matching is performed by the
handler itself; redundant Express router matching options were removed without
changing accepted paths.

The first full HTTP mutation run failed its unchanged gate: 75.32% over 393 sites,
with 281 killed, 96 surviving, 15 detected timeouts and one uncovered site. Added
assertions now cover complete browser headers, parser-error distinctions, inclusive
byte ceilings, immutable access binding, cancellation and response/capacity
lifecycle. A fresh complete 390-site campaign is running; this is not yet passing
mutation evidence. Independent database and remaining runtime/client/adapter
qualification also remains outstanding. This increment does not advertise or
claim complete BRC-199 implementation or the second review checkpoint.

The strengthened complete HTTP run now passes 93.59% across 390 mutations:
348 killed, 25 surviving and 17 detected timeouts, with zero uncovered or invalid
sites. Both complete production source files match the saved report exactly.
This supersedes the failed 393-site run after the documented source simplification
and stronger boundary tests. Detected timeouts are retained explicitly; they are
not presented as assertion kills. Independent database qualification remains
active, and the SDK client and remaining root integration obligations are still
unfinished.

## Retained root client and shared finite HTTP exchange

The optional SDK root client owns one original signed request, original retained
capability and independently selected evaluation-policy digest. Submit retries
send that exact operation; status derives the original requester/request ID.
Both authenticate the selected root, prohibit payment, bind the signed response
to the original request/policy and retain physical capacity through cancellation.
This private profile requires HTTPS even when general development HTTP support
is enabled. No discovery, durable persistence, polling or eligibility decision is
performed by the transport.

The extracted internal finite exchange preserves existing lookup public classes,
error identities and diagnostics, anonymous lookup behavior, authentication,
header/body limits, redirect policy and cancellation behavior. Its complete source
remains in the original authentication mutation target and also participates in
the independent root-client target. Existing target ranges and tests were retained.

The root-client target passes 93 focused cases, including 39 unit cases, the 53
existing lookup regressions and 300 generated root result schedules. Its complete
224-site mutation run passes 93.75%: 203 killed, 14 surviving and seven detected
timeouts, with zero uncovered or invalid sites. Both production sources exactly
match the report. Earlier 228-site runs failed at 88.16% and 89.91%; stronger
inclusive-limit, handshake, encoding and cleanup assertions and removal of the
unreachable private-profile HTTP branch precede this passing run. The unchanged
gate remains 90%. A separate real BRC-103/104 and SQLite route integration passes
42 cases. The prior complete SDK run passes 8,131 tests across 247 suites, packed
ESM/CommonJS and browser consumers, and 28 compiled examples against 22 tarballs.
The final source revision is undergoing a fresh full SDK run; the complete shared
authentication campaign and exact-head hosted checks remain separate obligations.

The independent 305-site database campaign finished at 93.44% (278 killed,
20 surviving and seven detected timeouts), with an OOM recovery and a later
SIGABRT worker recovery. During that run, SDK `typecheck` emitted changes to its
compiled lookup dependencies. The report is retained as diagnostic evidence only,
not qualification against unchanged dependencies. A clean run against the final
fixed dependency cohort is still required. No complete root profile or second
review checkpoint is claimed.

The final SDK source now passes 8,139 tests across 247 suites, packed ESM/CommonJS
consumers, browser budgets and 28 compiled examples against 22 exact tarballs.
Overlay Express passes 668 tests across 25 suites, its packed consumers and the
strict legacy SDK 2.8.9 contract. The complete existing authentication target,
including the full extracted finite exchange, passes 86.79% across 757 mutations:
601 killed, 100 surviving and 56 detected timeouts, with zero uncovered or invalid
sites. All seven production sources match its saved report. Its existing 80% gate
and complete original source/test union were preserved; the separate new root
client retains its independently passing 90% gate. These local results do not
replace exact-head hosted qualification.

## Bounded root recovery scheduler

The optional root scheduler now performs startup and periodic durable scans, with
coalesced wake hints and independent expiry/evaluation cursors. Manual mode only
expires retained pending work. Automatic evaluation requires an explicitly
installed policy identity and digest, retained contract recovery and current
authority/context/revision checks inside the actual journal gate. An unavailable
evaluator cannot prevent expiry. Physical jobs retain their digest and capacity
until their callbacks actually settle, including after logical cancellation or
timeout. Shutdown prevents new work, aborts outstanding jobs and waits for the
observer and physical jobs before the caller closes its database. The scheduler
does not own database closure or implicitly install a peer-requested policy.

The complete production revision passes 1,248 tests across 94 output-runtime
suites, packed consumers, exact-tarball browser checks including actual IndexedDB
restart/CSP behavior, and all 29 compiled examples against 22 package tarballs.
Root health, lint, formatting, types and the 145-page documentation build pass.
Seven subsequent test-only additions bring the focused scheduler suite to 32
cases, plus 300 generated schedules; all 33 mutation dry-run tests pass.

The first complete 164-site mutation run failed at 85.37% (132 killed, 24 surviving
and eight detected timeouts). Added tests cover repeated starts, wake hints during
active work, expiry between discovery and evaluation, stopping between storage
calls, missing checked-commit support and duplicate physical work while capacity
remains available. The unchanged complete production source now passes 93.90%:
144 killed, ten surviving and ten detected timeouts, with zero uncovered or
invalid sites. The report source matches the current file exactly. All existing
source/test unions and gates remain; the new critical target uses the unchanged
90% threshold and the actual registry contains 89 properties and 89 targets.

This supplies reusable recovery lifecycle, not a complete deployed root profile.
Installed evidence/currentness policy, broader local-rule coverage, all serving
and admission/GASP fences, host lifecycle demonstration and clean final database
and exact-head hosted qualification remain outstanding.

## Independent lineage partition qualification

The exhaustive layout/graph and traversal partitions now both pass against the
exact current full source and identical original test selection. The layout/graph
partition passes 97.97% across 246 mutations (241 killed, five surviving, no
timeouts); the traversal partition passes 90.54% across 74 (66 killed, seven
surviving and one detected timeout). Both have zero uncovered or invalid sites.
Each ran all 99 dry-run tests. The graph campaign recovered worker failures and
finished in 30m28s; traversal finished in 7m21s. These are local qualification
results, not controlled performance claims or exact-head hosted results. The
previous unpartitioned hosted timeout remains recorded; no source, test or gate
was excluded to obtain the separate results.

## Explicit local-rule history and complete serving assessments

Opt-in SQLite format3 now retains immutable, attributable local rule descriptors,
complete active-rule inventory, a monotonic rule epoch and per-target match
coverage. Install and lift operations share the journal's cross-process gate and
invalidate serving eligibility and projections atomically. Independent peer
suppression bases remain separate. A trusted local evaluator must assess every
active rule against the target; unknown rules or unavailable facts remain
unresolved. Legacy assessments cannot grant eligibility in format3. Rule lifting
never establishes currentness, restores an unrelated peer basis or skips a fresh
complete assessment and projection acknowledgement.

The explicit format2-to-format3 migration preserves retained request/action
history, fences connections using the old configuration seal and invalidates
previous serving assessments. Default format1 and format2 configurations remain
unchanged. Rule history and descriptor bytes are bounded. Capacity accounting
reserves future lift history, epochs and revisions, including withdrawal
acknowledgements, so ordinary assessment traffic cannot consume the capacity
needed to retire an active rule. No peer-accessible administration or implicit
matcher installation is introduced.

The production revision passes the full output-runtime suite: 1,278 tests across
97 suites. Root health, lint, formatting and type checks, packed consumers,
actual browser/IndexedDB restart and CSP checks, and 30 compiled examples against
22 tarballs pass. Documentation compilation initially found duplicate imported
type names in the combined example; distinct aliases corrected that failure.
The repaired examples, seven documentation tests, 140 source-page validations
and the 145-page build pass. Actual test governance passes with 90 properties,
90 mutation targets and every prior source/test union retained.

The first complete local-rule mutation run failed the unchanged 90% gate at
76.45% (250 killed, 77 surviving). Eight additional tests cover closed shapes,
strict inventory bounds, persisted accounting, complete retry effects, canonical
local decision identity, missing retained installation records and closure. The
production source was unchanged. All 28 focused unit tests plus two actual
process-termination tests and 300 generated schedules pass. The full 327-site
rerun passes 92.66% (303 killed, 24 surviving), with zero uncovered or invalid
sites and no detected timeouts. Both executable sources exactly match the saved
report. The 1,803-file compiled SDK dependency inventory is unchanged. The full
1,278-test run preceded the eight test-only additions; it is not presented as a
later full-suite run.

Codec, serving-record, journal and clean database qualification remain separate
obligations. Installed advertisement/currentness evaluation, coherent host context
transitions, all serving/admission/GASP paths and exact-head hosted CI are still
unfinished. This component result does not establish complete root-profile or
second-checkpoint readiness.

## Direct local advertisement evidence

The existing evidence entry now additionally exports
`SDKRootAdvertisementEvidence` for local admission and reassessment. Its closed,
bounded input is an exact serving target and original advertisement evidence.
It checks current SHIP/SLAP authentication, the exact output and script digest,
and Bitcoin evidence against an owned immutable verification context. It returns
raw advertisement facts and optional placement without manufacturing a peer
request, currentness assertion or serving decision.

`SDKRootEvictionEvidence` composes those same checks with its existing signed
request, withdrawal-authority and exact consuming-transaction checks. One bounded
transaction verifier remains shared across each complete peer evaluation. The
existing critical mutation target includes both complete production modules and
retains its full original test selection and unchanged 90%/zero-uncovered/
zero-invalid gates. The fresh complete 132-site campaign passes at 98.48%:
130 killed, two surviving, and zero timeouts, uncovered or invalid sites. All 69
mutants in the new direct-evidence module were killed. Both production modules
exactly match the saved report; the former single-module result is not reused.

All 22 focused tests pass, including 300 generated local/peer equivalence
schedules. Tests cover closed nested fields, exact service/output/digest binding,
caller mutation during a blocked chain dependency, mined ancestry, missing
history, resource limits, wrong context and cancellation during authentication.
The full output runtime now passes 1,294 tests across 98 suites, including the
eight strengthened local-rule cases added after its preceding full run. Strict
package type checks, lint, 25 governance regressions, packed exports and all
31 compiled examples against 22 tarballs pass. Root health, lint, formatting and
the 145-page documentation build pass. Exact-tarball browser checks also pass,
including strict CSP, native IndexedDB, browser/page restart, receipt-before-cursor,
cross-tab compare-and-swap, missing-store recovery and the lost-core fence.
A subsequent test-only addition brings the focused selection to 23 passing cases:
it verifies cancellation after the second independent peer proof check, before
publishing the result. The full 1,294-test run preceded this additional test.
Remaining component mutation campaigns, complete root-host context, currentness,
admission/serving integration and exact-head CI remain outstanding.

The format-3 root codec's independent complete 182-site campaign also passes:
97.80%, with 175 killed, four surviving and three timeouts, zero uncovered or
invalid sites. It ran the full 280-test dry selection in 136 seconds and completed
in 50m05s. Source bytes match its report, and all 1,803 compiled SDK dependency
files remain unchanged. A bounded workflow allowance is being integrated under
the same source/test/score requirements; this is not a performance improvement
claim. Serving records, journal and clean database qualification remain separate.

The subsequent full 475-site serving-records campaign passed its 288-test dry
run, but exceeded the existing 90-minute execution bound after six worker
out-of-memory restarts. It was stopped without a final report and supplies no
mutation qualification. All five remaining owned processes exited, and the
1,803 compiled SDK dependency files remained unchanged. The next campaign will
use exhaustive file-based execution parts with the original combined gate;
neither incomplete evidence nor previous-source results can qualify it.

## Ordinary Engine admission for reserved proposals

`@bsv/overlay/proposal-admission` supplies `OverlayProposalAdmission` as a
structurally compatible `ProposalServiceAdmission` port. The optional leaf
requires SDK 2.9 or newer; no new root export or old peer-floor change is made.
It binds the installed provider, service, topic, rules digest and chain to the
original signed selection and author proposal. The exact durably reserved raw
transaction must match both the BEEF's default target and transaction ID. The
host still owns policy-specific transaction relation checks, complete evidence
verification, current access and durable reservation.

The adapter reads retained ordinary topic history first. When absent, it checks
the complete possible STEAK result against the service's reserved outcome budget
before submitting through the real Engine. It rereads the same history even
after submission throws. Only an original atomic receipt whose identity includes
the exact topic, ordinary policy and off-chain context can finalize the proposal.
Unknown history, legacy provenance and partial failure remain unresolved.
Empty STEAK alone cannot establish either success or failure; a valid retained
identity is the evidence of ordinary admission. Only the selected topic's instructions leave the adapter;
the original multi-topic receipt is not disclosed. A stable assessment identifier
binds the actual original operation and instructions, independently of a newer
reservation or changing index/propagation observation.

Canonical input/result bounds and a finite physical concurrency limit apply.
Stalled calls retain capacity until actual settlement; configuration replacement
requires draining work and installing a new bridge. Original-context requirements
do not synthesize missing legacy verification material. Private publication and
durable negative topic decisions remain separate contracts.

The full Overlay run passes 899 tests across 43 suites, with its one existing
governed skip unchanged. The bridge has full statement/function/line coverage
and 99.09% branch coverage in that run. Its real local three-member Mongo fixture
exercises historical multi-topic admission, adapter restart, serving eviction,
concurrent calls and a response lost after actual Engine commit. The synthetic
chain tracker and absent broadcaster/advertiser isolate these tests from public
network or funded effects. The full run includes owned critical-extension support, independently bound
selection/signature checks and valid empty retained receipts. Two subsequent
test-only cases cover missing advertised services/profiles, independent selection
identities, exact error contracts and preflight capacity; 65 focused cases now
pass, including a 300-case property. The full 899-test run preceded those
additional cases.

Strict production and new test compilation are part of the package typecheck.
Lint, packed ESM/CJS exports and consumers, existing strict SDK 2.8.9 consumers,
and 32 compiled examples against 22 exact tarballs pass. The compiled example
returns this bridge through the actual proposal-service port type. The complete
source and generated property are registered with the unchanged critical
90%/zero-uncovered/zero-invalid gate. Both Overlay property suites pass, as do
all 34 governance regressions and repository health checks. The complete
321-mutant bridge campaign passes at 96.88%: 311 killed and 10 survived, with
zero uncovered or invalid results, in 4 minutes 33 seconds. One native worker
SIGSEGV was recovered; its diagnostic remains retained. The earlier complete
84.42% failed run is also preserved. Stronger independent contract assertions
closed its test gaps without changing production source, thresholds or scope.
Full HTTP/lifecycle composition remains pending; these results do not establish
checkpoint-two readiness.

## Proposal responses at native enqueue

The optional `ProposalJournalSend` companion is implemented by the durable
`SQLiteProposalJournal`. It accepts a trusted local selector for a current
channel, retained proposal or sanitized control response. After hydration and
response signing, it obtains the same `BEGIN IMMEDIATE` lock used by proposal
writers, refreshes committed state, supplies owned record/body copies to a
synchronous validator and performs the actual native enqueue before releasing
the lock. Unrelated channel appends do not invalidate a selected record. Missing
records and control selectors confer no permission. The validator must bind the
exact response to the original contract and retained record and recheck current
access; the storage primitive cannot infer these application semantics. Access
writers must participate in this gate or an explicitly coherent policy domain.

Bodies are bounded to four MiB, matching the SDK response framing; selected
contract limits may be smaller. Existing methods and persisted bytes are unchanged. Read, write and close
reentry is rejected while sending. Signing remains outside the lock. A failure
after native enqueue cannot undo disclosure; callers track that fact and must
not send a replacement. If transaction completion is uncertain and rollback
fails, the connection is retired and recovery uses a new connection. Ordinary
memory journals do not advertise this durable companion.

The full runtime passes 1,317 tests across 101 suites before the send ceiling
was aligned from one to four MiB. All 29 focused send/disclosure tests pass
after that bound change, including its exact boundary. The earlier focused
63-case journal/send/process/property selection passes, including
300 generated schedules, two real SQLite connections and child-process
termination while the native enqueue gate is held. Tests exercise stale channel
heads, historical proposal responses, revocation, byte/record ownership,
contention, callback failure and lost commit acknowledgement. Whole-journal
coverage in this selection is 98% statements and 97.46% branches; the complete
journal/service selection is retained in the new whole-module mutation target.
Strict production/test types, lint, artifact checks, 27 governance regressions
and all 33 compiled examples against 22 exact package tarballs pass. The new
mutation registration is additive, with unchanged 90%/zero-uncovered/zero-invalid
gates. The first complete 313-site campaign failed at 83.39%, with 261 killed,
50 survived and two uncovered sites, in 16 minutes 35 seconds. Its failed report
is retained. Additional integrity tests cover independent persisted metadata and
encoding corruption, actual WAL mode, hexadecimal revisions beyond 15, native
lock-error identities, input ownership, reentry and uncertain connection closure.
The strengthened 36-case integrity/send selection passes; fresh whole-journal
qualification remains required. This primitive alone does not establish profile readiness.

## Service-owned proposal response binding

The optional `ProposalResponseDisclosure` companion adds synchronous response
semantics above the native journal gate. It binds actual request bytes and
caller to an immutable wire body and exact record selector. A fresh journal
record supplies the original capability, current policy/access decision,
exclusive retention boundary and exact response state. Publication ACKs survive
new revisions; get/finalize responses reject changed state. Active get stops at
signed expiry without depending on a timer. No asynchronous callback, discovery
refresh or new effect runs inside the journal lock.

All 14 focused tests pass with full statement, branch, function and line coverage,
including a 300-case property and real SQLite enqueue. Cases include original
publication/admission selectors, changed discovery, signed expiry, unresolved
finalization, current revocation, unrelated writes, restart, actual request/response
budgets and byte ownership. The complete 205-site mutation campaign passes at
91.22%: 187 killed, 18 survived and zero uncovered or invalid, in 1 minute
48 seconds. This is local source-bound evidence, not hosted qualification of the
whole registry. The companion adds an optional public interface without changing
existing service methods or persisted formats.

## Authenticated non-final proposal HTTP

The optional `@bsv/overlay-express/proposals` entry exposes put/get/finalize
through the existing proposal service, disclosure companion and same durable
journal. Strict raw framing precedes authentication, with exact profile/contract
selection, credential-free public CORS, no-store responses and bounded transport
and physical service work. The host's lazy `configureProposals` integration
shares one authentication instance, handshake and capacity layer; existing
finite routes and root imports retain their defaults. A disconnected operation
keeps its physical work slot until settlement. No automatic payment is introduced.

After response signing, the guard validates exact data or sanitized control bytes
under the journal writer lock and enters the native queue. Current authorization,
record state and original retention are checked together. A stale candidate may
produce one newly signed error, with independent current control permission;
an uncertain native enqueue never authorizes another attempt. The replacement
signer receives its own bytes, separate from the retained authorization oracle.

Publication retries now recover an older retained acknowledgement after a
successor has become the current channel head, preserving that newer head and
the original contract. The 26-case service regression selection passes, including
discovery outage, current revocation and exclusive retention expiry.

The complete Overlay Express run passes 708 tests across 29 suites, including
24 real authenticated HTTP cases, the generated 300-case property, native-guard
drivers and host integration. Eighteen subsequent transport lifecycle driver
cases also pass with strict types. Actual HTTP uses real signing and SQLite storage with
synthetic service evidence/admission ports; separate Engine/Mongo tests do not
yet establish the complete HTTP-to-Engine composition. Packed ESM/CJS export and
strict consumers pass, including the existing SDK 2.8.9 default host. All 35
compiled examples against 22 exact tarballs and the 146-page documentation build
pass. The additive full-source HTTP target brings the local registry to 94;
29 governance regressions pass. Its mutation execution remains pending.

The [proposal guide](../../docs/guides/non-final-proposals.md) describes composition,
recovery and lifecycle ownership. Explicit startup recovery/expiry, configuration
evolution, retained-fence compaction, projection integration, SDK client and full
checkpoint-two qualification remain open.
