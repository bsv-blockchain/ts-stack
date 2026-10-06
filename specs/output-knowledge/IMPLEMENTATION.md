# Output knowledge implementation qualification

This branch implements the application-neutral [BRC-192–199 packet](https://github.com/bsv-blockchain/BRCs/pull/284)
with current amendments in [BRC PR295](https://github.com/bsv-blockchain/BRCs/pull/295)
at `1b9a75e497b5856675af1ce01fd86843c37d07f9`. The specification checkpoint is
approved for implementation. The implementation
checkpoint remains open; neither an initial package version nor passing foundation
tests announces completion, publication or production qualification.

The core contracts remain application-neutral. Application examples demonstrate
the contracts without defining their semantics. Existing wallet, overlay, lookup,
submission and GASP behavior remains available to applications that do not opt in.

## Current contract alignment

[The alignment inventory](./SPEC-ALIGNMENT.md) tracks the replacement reference
family, stable purchase commitments, alias recovery and route-specific finality.
BRC-197 is one optional transaction domain exercising the shared architecture.
Its earlier program, signing and economic-route receipts do not qualify the
replacement. Full current-source integration and hosted qualification remain open.

The first alignment batch extends closed purchase envelopes with commitments and
separate current-alias evidence. It binds the full commitment in POTATOES without
changing historical release txids, calculates the complete SHA256d input preimage
digest, and returns it after purchase verification succeeds. It also provides
the fixed public child derivation for subsequent Script/wallet integration. These
calculations do not themselves establish Bitcoin validity, authorized activation,
selected-chain settlement, secret usability or native alias recovery.

The LCH alignment batch adds the full commitment to the closed, signed C
settlement and binds it to reserved results/POTATOES and independent buyer/seller
purchase-verifier results. Owned synchronous assessments pin both the digest and
guard through asynchronous issuance. Historical entitlement fingerprints exclude
unverified current-alias transport fields; those fields neither grant new rights
nor impose an online dependency on previously verified offline playback.

Local evidence includes the complete LCH suite (38 suites, 252 tests), original
300-run property profiles, its unchanged coverage gate, packed exports and
unchanged browser budgets. The new assessment module has complete statement,
branch, function and line coverage. Four compiled LCH examples use four exact
package tarballs. Workspace typechecks include the native HTTP proof adapter's
new return field. This is component evidence: the two-stage Script, immutable
collector terms, child-wallet and durable multi-alias integration remain open.

The replacement portable codec now owns and pins both literal programs and
encodes their exact shared 717-byte metadata. Stage choice is explicit; the
schedule is immutable and its public child slots and mandatory height expiry
are fully checked. Both output-zero locks match the unchanged PR295 positive
wire corpus byte for byte. Codec/property tests cover complete ownership,
descriptor commitments, padding, recipient counts and exact numeric bounds;
the new profile and extracted public-key modules have complete coverage. This
composes with the separately selected current planner, witness and lineage
interfaces below; native adapter integration remains open.
Packed/browser contracts and compiled examples exercise the new portable entry,
without qualifying activation, protected signing or private release.

The SDK now also has separately selected immutable profile planning and funded
witness construction. Its normal activation and purchase witnesses reproduce
unchanged specification bytes, and complete positive split, permissionless
payout, early retirement and expiry retirement execute every input. An
activation/purchase/payout example exercises all eight recipients. Protected
BRC-100 requests select only the seller child for split and early retirement;
other routes need no seller signature. Full purchase commitments and final-layout
bindings are construction evidence, not independent lineage or release authority.
Original 300-run controls cover immutable conservation and fully funded active
route execution. This construction component leaves native wallet, collector and durable alias
integration open; the independent current-lineage verifier is described below.

The optional output-knowledge revenue entry now separately exports current-profile
lineage and purchase verifiers. They authenticate reserve-stage genesis, require
child-link activation on each active path, inspect immutable route economics,
verify bounded chain evidence and execute every actual input Script even for
mined transitions. Full purchase commitments are returned only after independent
original-term association and complete successor history succeed. Complete raw
funding is mandatory; missing declared ancestry remains unresolved. Route inspection
has no canonical scriptSig ABI requirement. Positive unchanged genesis/activation
and both wire purchases, protected-child split, permissionless payout, both
retirement Scripts and original 300-run properties are component evidence.
The combined current and historical regression profile passes 118 tests, with
99.7% statements and 96.8% branches over the five changed boundary modules.
Packed exports, all browser entries under unchanged budgets and 67 compiled
examples against 24 exact tarballs pass; full campaign and integration evidence
remain separate.
Historical exports remain compatible and are explicitly identified as superseded.
Native wallet/alias ownership, collector/currentness integration and complete
checkpoint qualification remain open.

The optional LCH covenant entry now also exposes exact current collector decoding,
complete descriptor binding and a strict new-preparation stage/height predicate.
Every CBOR field and all eight recipient slots are checked with the current SDK
schedule/descriptor validators. Superseded revisions and mutable rule labels are
refused by this interface; the historical decoder retains its earlier contract.
The complete LCH suite passes 257 tests in 39 suites with its original coverage
and 300-run property controls; the current helper has complete coverage. A further
positive eight-recipient case and the original/current codec properties pass in
the focused seven-test profile. Packed exports and original browser budgets pass.
These helpers neither authenticate Offers nor provide native currentness/alias
custody; full current buyer/seller integration remains open.

The separately selected current standing-Offer terms interface now authenticates
the exact immutable collector and descriptor, signed individual consent,
capability, policy and content commitments. The shared consent pipeline retains
the historical wrapper's public interfaces and behavior. Frozen promise checks
remain distinct from new-work time windows and installed-height checks. These
interfaces establish no lineage, role, unspentness or release authority and
perform no wallet action; buyer/seller and native alias integration remain open.

The controlled complete LCH profile passes 263 tests in 40 suites with minimum
300 generated cases and seed 3242026. Current terms and the historical wrapper
have complete coverage; the shared pipeline has 99.05% statements and 94.04%
branches. Independent pinned-engine instrumentation proves all 525 canonical
terms cases occur exactly once across the same seven semantic partitions,
preserving all original runner settings and the complete 390-row matrix. This
is inventory evidence, not a completed mutation campaign. The prior stale-wrapper
mapping failure is retained. The SDK source-quality refactor also preserves
programs, witnesses and public APIs: 414 SDK tests and 100 selected lineage tests
pass under the original controls; final hosted analysis remains separate.
Clean LCH and SDK packed exports and every existing browser entry pass unchanged
budgets. All 69 compiled documentation examples pass against 24 exact tarballs.
The example compiler caught a duplicate local import name in the combined
consumer; the corrected example uses a distinct local alias.

The current covenant settlement interface now binds the entire immutable
descriptor and original signed consent/promise, purchase commitment, settlement,
historical release and POTATOES. Its bounded evidence decoder checks the seller's
genesis authorization while leaving complete reserve-stage/activation history,
actual input Scripts, currentness, role and release verification to installed
independent verifiers. The historical public interfaces and all original binding
checks remain; both interfaces share one settlement pipeline.

The complete controlled LCH profile passes 268 tests in 41 suites in 111.019
seconds, including original and additive 300-case properties. The current wrapper,
historical wrapper and shared settlement pipeline have complete statement, branch,
function and line coverage. Existing packed/browser budgets and all 70 compiled
examples against 24 exact tarballs pass. The registry retains its complete source
unions, 143 targets and 390 execution rows. The preceding pushed terms/source-quality
batch at `337692aefbb088d2f9ccfcb520675432baac37eb` passes the strict hosted Sonar
gate with zero new findings and zero unreviewed hotspots; that result does not
qualify later source or complete the full checkpoint.

The current immutable buyer is now separately selected as
`LCHOverlayCovenantProfileDomain`. The complete buyer pipeline is shared with the
historical wrapper while its original public interfaces, installation adapter
identity, protected custody, defaults and License/role/proof checks remain.
The current funding boundary returns a retained synchronous same-view guard over
owned active stage, canonical installed height and the accepted time window.
The financial owner must recheck it immediately before effects. Actual complete
original funded and released subjects require independent proof and their same
full purchase commitment. Retained delivery, reopen and offline playback do not
repeat a new-preparation height/time predicate.

This buyer component passes the full 274-test/42-suite controlled LCH profile in
134.312 seconds, including every original property and the additive 300-case
current funding-window property at seed3242026. Current and historical wrappers
have complete statement, branch, function and line coverage; the shared buyer
core has 97.93% statements, 93.02% branches, 94.11% functions and 100% lines.
The new tests construct actual reserve-only authorized genesis, externally funded
activation and purchase with pinned current programs, execute complete independent
Bitcoin/chain proofs, and use encrypted SQLite custody and actual licensed
ciphertext playback. They do not construct a native wallet action or perform
live topical admission. Missing explicit program bytes, incorrect fixture calls
and the compiled-guide duplicate import failure remain recorded as failed runs;
corrections retain every original source/test/control and program pin.
Packed and all browser entries pass without increasing budgets. All 71 compiled
examples pass against 24 exact package tarballs, and the full original mutation
registry/partition controls pass with whole new buyer sources and both required
current fixture support paths. Native action/alias custody, the current seller,
combined admission/HTTP examples and final complete qualification remain open.

The separately selected `LCHOverlayCovenantProfileSeller` now shares the complete
original issuance pipeline with the historical seller. All five original public
interfaces are retained, as are its installation adapter identity, protected
material and full proof/role/CEK/License checks. The distinct current installation
binds immutable C terms and prevents historical custody reinterpretation. New
preparation retains/rechecks owned active stage, installed height and same-view,
Offer and bounded preparation-time guards before promising material. Retained
issuance continues verifying the actual original admitted subject, full commitment
and release without turning recovery into new funding.

The complete LCH profile passes 280 tests in 43 suites in 150.650 seconds with
all original and additive 300-case properties at seed3242026. Current/historical
seller wrappers have complete statement, branch, function and line coverage;
the complete shared seller core has 100% statements/functions/lines and 98.66%
branches. Current fixtures execute the exact immutable reserve/activation/purchase
programs and complete selected-chain/BEEF proofs, then use actual licensed
ciphertext and protected buyer custody/playback. Stage/height/Offer/preparation
cutoffs, wrong original candidate, incomplete admission, custody identity and
retained catalogue-withdrawal/expiry are covered. Historical seller tests remain.
Full original registry/partition controls, packed consumers and every browser
entry pass under unchanged controls/budgets; all 72 compiled examples pass
against 24 exact package tarballs.

The native immutable-identity component adds an explicitly selected
`SQLitePrivatePurchaseCommitmentStore`, sharing the complete native pipeline with
the historical owner. The original constructor, pin method and version-one state
declarations remain unchanged. New custody seals version-two state and its
candidate profile; neither reader implicitly adopts the other profile. The
coordinator retains independently verified own commitment/method identities
through awaited verification, admission and issuance and rechecks them in native
writer guards. Every pinned status and the signed first POTATOES packet contain
the same full digest. The component still pins an exact submitted txid.

Component evidence includes all 16 new commitment unit cases and the complete
28-suite regression union. Its first run passed 485 cases and failed one new
generated fixture setup that attempted admission twice. After correcting only
that setup, both cases in the complete state property file pass, retaining all
original and additive 300-run profiles at seed3242026. The full package typecheck
and all 121 registry controls pass. Independent complete canonical inventory
proofs retain every mutant exactly once: state1065, coordinator580 and
native-clock1550, with the original143 targets and390 execution rows. These
inventory checks are not an executed mutation campaign.

The SDK now provides an explicit local full-commitment transport binding and a
separate envelope verifier. It authenticates the historical result/release txid
against the matching signed domain and full identity while sharing every existing
signature, original-term, recipient, policy, STEAK and POTATOES check. The original
exact-txid verifier and omitted transport behavior remain unchanged. Submit and
recovery retain the complete original funded candidate; preparation cannot select
the companion and request bodies never carry the local binding. Bitcoin/alias
verification and native buyer/wallet custody remain separate integration work.
Both complete original target test sets pass under their original module profiles:
38 protocol cases in three CommonJS suites and271 HTTP cases in13 ESM suites,
including all original and added300-run properties at seed3242026. An initial
mixed-module invocation and two new negative-signature fixture expectations failed
and remain recorded; neither source controls nor corpus bytes were weakened.
The complete SDK build, packed ESM/CJS/UMD API checks and original browser
profile also pass (3.537,40.031 and39.941 seconds respectively).

Hosted source889 fails six native HTTP integration assertions because its
historical owner omits the mandatory listing purchase commitment. Selecting the
new owner locally exposed a further integration gap: actual access guards recognize
only version-one custody and refuse the new state before funding. The native
six-case composition therefore remains failed pending an explicitly selected
matching access profile and requalification; passing mock-access component results
do not establish a hosted fix. Durable
one-economic-purchase/per-alias custody, protected child-wallet integration and
the combined current admission/HTTP/workbench also still require work.
The own wallet property command now runs its installed-Jest selector preflight
and preserves all eleven original action/funding suites. The complete actual
command passes12 generated cases across all11 suites in18.759 seconds, retaining
min300/seed3242026. A cold root regression checks selector interpretation. No
other branch's snapshot/schema tests or qualification are imported.

The final selected core packed-consumer and original browser profiles pass
in9.499 and60.267 seconds; all75 compiled examples pass against24 exact package
tarballs in10.090 seconds. All121 original/additive registry controls pass in
3.370 seconds. These consumer and inventory checks do not replace the final
complete mutation campaign or current-family integration.
No previous hosted or mutation receipt qualifies these new components.

## Historical foundation and qualification record

The following milestones describe earlier source and contract versions. They
preserve engineering provenance, not a support claim for superseded reference
programs or a current checkpoint certification. Current acceptance is governed
by the alignment inventory and final exact-source qualification.

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
- Optional client proposal acceptance with exact source/reader/policy selection,
  first local receipt times, signed-envelope verification and whole-group quarantine.
  A distinct local frame4 namespace preserves accepted decisions and monotonic
  expiry; default Bitcoin journals retain their existing formats and behavior.
  Authenticated intent and provider reports remain separate from Bitcoin facts,
  current-channel selection, full predecessor history and authorized effects.
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
  96.88% on that historical component source. The reference app composes this
  bridge with actual SDK verification, HTTP/service/SQLite state and Engine/Mongo
  admission recovery. Its native client and private-state browser profile exercise
  admission-driven live projection, expiry, finalization and restart. Complete
  final-source qualification remains required.
- Concrete SDK proposal evidence verification and signed PRP1/SQLite integration
  against pinned synthetic header ancestry, with ordinary admission kept separate.
- The default Bitcoin reducer/worker, including recovery of accepted decisions
  without network access and explicit sealing of the journal's non-final policy.
- All 32 approved reconciliation traces through the default worker and SQLite,
  with actual SDK verification, delayed proof completion and offline restart.
- Bounded wallet basket pages, finite provider-scoped lookup receipts and direct
  delivery with commit-before-acknowledgement. Optional adapters live under the
  separate `@bsv/output-knowledge/sources` entry.

## Earlier checkpoint-two work inventory

The entries in this section record the earlier implementation progression. The
[current acceptance inventory](./CHECKPOINT2.md) tracks the integrated workflows
and reproducible selectors. Those reference compositions are implemented and
demonstrated; the remaining checkpoint requirement is complete qualification on
one final published commit. Historical component results below do not satisfy
that final gate.

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
  fences and full service/admission/projection composition. Explicit restart-aware
  inventory, expiry and recovery scheduling is implemented below; full qualification
  remains required.
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

## Source95c proposal qualification and upstream reconciliation

The strengthened complete 313-site proposal journal run passes at 97.76%:
306 killed, seven survived, zero uncovered or invalid, in 18 minutes 12 seconds.
Two recovered native worker crashes remain in its diagnostic record. The earlier
83.39% failure is preserved; no exclusions, lowered threshold or waiver were added.

The complete 416-site proposal HTTP run at the same frozen source failed its
90% gate at 84.62%: 342 killed, 64 survived and ten timeout detections, with zero
uncovered or invalid, in 26 minutes 55 seconds. The 207-test dry run passed.
This failure remains open and requires stronger meaningful lifecycle, capacity
and exact response assertions before requalification. All 9208 frozen source and
compiled dependency inputs remained unchanged throughout both runs.

Main20c independently retires the obsolete serial-DID module and advances SDK3
and topics2. This branch preserves those migration requirements while carrying
its additive output helpers into the same unpublished candidates. Existing SDK2
peer floors remain available for legacy paths; optional new output features now
require the SDK3 candidate. The new output-knowledge package has no published SDK2
compatibility promise. All original mutation targets remain and the four upstream
DID targets bring the combined registry to 98. Neither component scores nor main's
prior qualification establish green CI for this combined source.

## Retained-operation proposal client

The optional SDK `OutputProposalTransport` owns one original put/get/finalize
request and retained contract. Publication binds its exact proposal digest and
expiry; get authenticates the author, policy/channel and active lifetime;
finalize distinguishes a previously reserved operation using `matchesRequest`.
No discovery, persistence, automatic polling, wallet effect or new-operation
freshness is inferred. The provider's current authorization and native disclosure
gate remain independent.

All 26 focused client tests pass with 100% statement, branch, function and line
coverage, including the 300-case generated property. The complete shared finite
client selection passes 119 tests across five suites. All four new SDK files
also pass a strict no-emit compiler check. Actual HTTP tests compose the SDK
client with mutual authentication, SQLite service/disclosure, serialized original
request recovery after discovery changes and post-signing access revocation.
Their evidence/admission ports remain synthetic. The strengthened HTTP/host
selection passes 224 tests across six suites with 100% lines/functions and
98.72% branches. The prior failed HTTP mutation run remains open.

SDK packed ESM/CJS consumers, declarations, all wildcard entries, browser
bundlers/ESM and UMD qualification pass without a budget increase. The SDK has no
separate mobile test command; no mobile-run success is claimed. All 37 compiled
examples against 22 exact package tarballs and the 147-page documentation build
pass. Root health, lint and formatting pass; SDK and Overlay Express types pass.
The new complete client/shared-finite-HTTP mutation target preserves every prior
target and brings the registry to 99. Both client and updated HTTP mutation
qualification remain pending, as do whole-branch hosted checks and the remaining
storage lifecycle, projection and full Engine-backed composition work.

## Explicit proposal startup, inventory and recovery

At source cc9ad06c6, the strengthened complete 416-site HTTP campaign passed at
91.35%: 371 killed, 36 survived and nine timeout detections, zero uncovered or
invalid, in 27 minutes 39 seconds. The earlier failed report remains retained.
All 9324 tracked and compiled inputs were verified unchanged before lifting the
freeze. The complete 319-site SDK client campaign failed at 86.83% (270 killed,
42 survived, seven timeout detections). Seventeen meaningful follow-up cases now
bring its focused selection to 43 passing tests with strict test compilation;
requalification is still required.

The additive SQLite `create` and `open` factories separate intentional namespace
installation from ordinary restart while preserving the original constructor.
Existing-state open validates retained identity, configuration, capacity and
history and never initializes absent service state. `ProposalJournalMaintenance`
provides a finite high-water inventory of current active/finalizing identifiers,
with bounded pages and explicit missing-history failures. It preserves the full
journal and terminal fences. Its hints are private and confer no service authority.

`ProposalScheduler` owns bounded physical recovery calls, deduplicates outstanding
proposal identities and allows independent expiry scans. Startup, periodic scans
and coalesced wake hints compose the existing service's `expire` and `reconcile`
ports. It never initiates a new finalization. Shutdown drains actual outstanding
calls before dependencies may close, and returns late failures even when inventory
was temporarily unavailable. A hung dependency remains owned; there is no inferred
rollback or pretend cancellation.

Native tests reopen real SQLite state after an uncertain admission, recover the
exact reserved operation with discovery/evidence unavailable and access revoked,
expire an independent unreserved proposal, and verify retained terminal identity
after another reopen. Evidence/admission results in this scheduler test remain
injected ports. The full SDK Script/SPV-to-Engine-to-HTTP path is a separate open
integration obligation. Generated cases exercise 300 native inventory/restart
schedules and 300 bounded physical-recovery/drain schedules. Additional timer tests
exercise periodic scans, wake-up, coalesced start and stop before queued dispatch.

The complete new modules are registered as `proposal-maintenance` under the same
90%/zero-uncovered/zero-invalid gates. Existing targets and selections remain;
create/open and recovery cases extend the entire SQLite journal target. The
registry now contains 100 targets. Mutation execution of the changed journal and
new maintenance pair remains pending. Packed exports, strict consumers, all 38
compiled examples against 22 tarballs, root health/lint/format/type checks and the
147-page documentation build pass. These local component results do not establish
whole-branch hosted qualification or checkpoint-two completion.

The subsequent complete output-knowledge package run passes 1401 tests across
109 suites in 493.884 seconds. Both new maintenance modules have 100% statements,
branches, functions and lines; the focused native/lifecycle selection passes 50
cases. The SDK's full shared finite/proposal selection passes 136 tests across
five suites. Whole-workspace strict types and the final root lint pass. The
canonical mutation runs below still need to qualify these current inputs.

## Proposal pipeline and recovery qualification

At source 0be75f48f, the full SDK client target passes 92.16% over 319 sites
(286 killed, 25 survived, eight timeout detections), zero uncovered or invalid,
in 3 minutes 43 seconds. The full changed SQLite journal target passes 97.45%
over 353 sites (343 killed, nine survived, one timeout detection), zero uncovered
or invalid, in 22 minutes 8 seconds. Stryker recovered one worker SIGSEGV and one
out-of-memory restart; those diagnostics remain retained. All 9337 tracked and
compiled inputs were verified unchanged through the campaigns.

The initial complete maintenance target failed its 90% gate at 87.04% over
324 sites (265 killed, 42 survived, 17 timeout detections) in 30 minutes
14 seconds. Its report is retained. Follow-up assertions distinguish protocol
failures from accidental exceptions, check byte limits with multibyte text,
accept full bounded pages and verify one physical shutdown across repeated calls.
The same complete five-suite selection now passes 60 tests, including both
300-case properties, in 96.895 seconds; both modules retain 100% statements,
branches, functions and lines. The subsequent complete rerun at f75ce86f4 passed
98.77%, as recorded below; no source, test, operator, deadline or threshold was
excluded or weakened.

The reference app's `proposalPipeline.test.ts` now uses public SDK and package
interfaces throughout: retained authenticated proposal requests, real author
signatures, Script/SPV verification against pinned synthetic headers, a Topic
Manager and ordinary Engine, retained admission history in a three-member
MongoDB 8.2.6 replica set, SQLite proposal reservations, and the bounded recovery
scheduler. Put/get does not admit ordinary topic state; an unauthorized identity
cannot read, and invalid Script evidence creates no finalization reservation.

An explicit valid request commits Engine admission, then an injected loss prevents
receipt linkage in the proposal journal. Closing and reopening both adapters
recovers the same admission and assessment identity after proposal/manifest expiry,
with discovery and evidence resolution unavailable and caller access revoked.
Assertions require zero new Engine submissions or verification calls. Restoring
caller access permits the serialized original SDK request to retrieve its result.
The test does not restart Mongo processes, supply production TLS, use real funds,
broadcast, or establish currentness/private entitlement. The browser lookup
producer and admission-driven private projection remain separate integrations.

The repository app suite passes seven tests across three files in 22.16 seconds;
the existing Chrome/native IndexedDB two-provider/two-client live recovery check
also passes. The Engine bridge's 64 focused cases, app and whole-workspace strict
types, root health/lint/format, and 147-page documentation/link build pass. The only
dependency change is the existing workspace overlay package in the private app
and its lockfile importer; all other resolutions remain. These component results
do not establish exact-head remote CI or completion of checkpoint two.

## Maintenance qualification and lookup native enqueue follow-up

The complete proposal-maintenance second campaign at `f75ce86f49ce6ce959aef873857baac8b42357bc`
passed 98.77% over 324 mutations: 303 killed, four survived, 17 timed out,
zero uncovered and zero invalid. Its 60-test dry run passed; the campaign took
28 minutes 55 seconds. All 9,338 frozen tracked and compiled inputs were verified
unchanged after termination at 2026-10-01T08:35:32Z. The original 87.04% failure
remains part of the review evidence; no source, gate or exclusion was changed to
remove it. This qualifies that recorded source, not a later branch head or CI.

The next opt-in increment adds a portable lookup disclosure companion, a shared
SQLite native-enqueue port and an Overlay Express post-signing guard. It owns
response bytes and identity, restores the original contract, bounds physical
reauthorization work and rechecks durable guards/session deadlines at actual
enqueue. The workbench installs it on both authenticated hosts. Existing wire,
storage and omitted-option behavior remain unchanged. Complete source is included
in the new lookup-response-disclosure target and the existing full SQLite session
and HTTP target selections, retaining the prior tests and gates. Qualification
of this increment is underway; no new mutation or exact-head CI pass is claimed.

Focused lookup qualification passes 27 native/service cases (including 300 generated
SQLite schedules), with 100% statements/branches/functions/lines for the new
portable disclosure module. The complete four-suite HTTP selection passes 66
cases; the new response guard has 100% coverage in all four measures. All 766
Overlay Express tests pass. Seven actual reference-app tests and the two-host
Chrome/native IndexedDB demonstration pass with the gate installed. Both package
artifact checks, strict ESM/CJS consumers, the unchanged SDK2.8.9 default host,
38 compiled examples from 22 tarballs and 147 HTML documentation pages pass.
Repository health, lint, formatting, strict workspace types and the security audit
pass. The full output-knowledge regression and complete affected mutation campaigns
are separately pending; these local checks do not establish exact-head hosted CI.

The full output-knowledge suite at a73f6c37c subsequently passed 1,436 tests across
111 suites in 542.003 seconds. The first complete disclosure campaign failed its
90% gate at 82.54% over 189 sites (156 killed, 33 survived), with zero uncovered
or invalid, in 5 minutes 52 seconds. The full HTTP target failed at 88.70% over
664 sites (554 killed, 75 survived, 35 timed out), zero uncovered or invalid,
in 6 minutes 34 seconds. Both reports are retained. All 10,118 frozen tracked
and compiled inputs were verified unchanged at 2026-10-01T09:08:03Z before edits.

Follow-ups preserve runtime source and every target/gate. Thirty-three native
and disclosure cases, including 300 generated schedules, now cover the exact
installed authorization context, inclusive byte limits, equivalent reordered
multi-guard sets and mismatches, and malformed alternate-store headers. Seventy-one
HTTP cases also cover complete safe CORS headers, changed second-attempt bindings,
owned same-length bytes, exact queue capacity release and client cancellation
before binding prepared data. Complete mutation reruns remain pending; no failure
has been waived or replaced by a partial selection.

### Native lookup delivery qualification after strengthened regressions

On b9a0641a7 the complete 189-site disclosure campaign passes at 97.35%
(184 killed, 5 survived), with zero uncovered and invalid mutants, in 5m42s.
The complete 664-site HTTP campaign passes at 90.36% (560 killed, 40 timeout,
64 survived), with zero uncovered and invalid mutants, in 7m00s. These use all
registered sources, 300 property runs, the original seed and four workers per
campaign. No source exclusion, threshold or deadline was changed.

The first campaign failures (82.54% disclosure and 88.70% HTTP) remain recorded.
The second attempts failed because the local disk filled: the disclosure report
could not be written, and the HTTP runner recorded 193 invalid mutants from
ENOSPC. Neither is passing evidence. Both terminated before cleanup; all 10,118
tracked and compiled inputs matched their frozen hashes. Only derived Jest cache
groups whose recorded tests belonged exclusively to this checkout were removed.
The successful third attempts used the unchanged source and test inputs.

The complete 488-site SQLite session campaign also passes at 92.42%
(450 killed, 1 timeout, 37 survived), with zero uncovered and invalid mutants,
in 17m19s; all 148 initial tests passed. Every campaign is terminal, and all
10,118 tracked/compiled inputs still match the frozen hashes.
These local results do not establish complete checkpoint-two integration or
exact-head hosted qualification.

## Runtime publication deadlines and owned delivery bytes

An optional pure `OutputKnowledgeWorker.nextInvalidation` supplies the earliest
exclusive U64 epoch-second deadline for additional accepted state. The runtime
combines it with Bitcoin assessment expiry, uses bounded timers, suppresses late
asynchronous projection results and requires the worker to commit invalidation
before publishing current state again. Default workers and persisted/wire formats
remain unchanged. Invalid clocks and malformed installed deadlines fail closed;
an unresolved deadline cannot create a tight automatic retry loop. A projection
read also retains its publication gate across asynchronous storage access, so a
concurrent context change cannot return the old projection before its new context
commit finishes. A focused regression fails without this last read gate.

Proposal acceptance, durable proposal validity and clearing already displayed UI
state remain separate integrations. The generated deadline tests use a controlled
in-memory context transition to exercise the scheduling contract; they do not
claim to implement those integrations or prove a physical database restart.
Thirty-seven runtime/property cases pass, including 300 exact deadline schedules,
with 100% line/function and 95.55% branch coverage for the whole runtime module.
The complete-source mutation target is registered with the existing 90%, zero
uncovered and zero invalid requirements; its execution remains pending.

Proposal/root native delivery and authenticated response replacement now make
independent Uint8Array copies for Buffer inputs as well. Three synthetic ownership
regressions fail without their corresponding copy changes. Existing HTTP intake
already supplies plain owned byte arrays; these tests do not establish a deployed
incident. The complete middleware suite passes 311 tests, Overlay Express passes
771, and seven reference-app cases plus the two-host native Chrome demonstration
pass. Packed middleware consumers include Express 4/5; all 39 documentation
examples compile against 22 exact tarballs, and all 147 built HTML pages pass
link validation. Full output-knowledge and complete affected mutation campaigns,
remaining architectural integrations and exact-head hosted CI are still required.

### Complete first runtime campaign and context-publication follow-up

On `00fc94c68`, the full output-knowledge suite passes 1,469 tests in 112 suites
in 532 seconds. The complete 385-site authenticated-response queue campaign
passes 97.40% (356 killed, 19 timeout, 10 survived), with zero uncovered or
invalid mutants, in 22m43s. A worker SIGSEGV was recovered by the runner and
remains in the retained log. The whole 396-site runtime campaign fails at 71.97%
(223 killed, 62 timeout, 107 survived, four uncovered, zero invalid) in 5m15s.
It supplies no passing qualification. All 10,119 tracked/compiled inputs match
their frozen hashes after all runs terminate. Only owned, terminal temporary
directories and inactive generated sandboxes were cleaned; reports are retained.

The follow-up holds publication closed while any requested context commit is
pending. It covers both an already-running worker and an asynchronous projector,
including overlapping context requests. Two initial regressions fail on the
preceding implementation. Additional tests observe autonomous timer invalidation
before any explicit flush, unordered competing assessment/companion deadlines,
each checkpoint field, exact source/byte bounds, diagnostic identities and real
SQLite receipt acknowledgement/reopen. These changes preserve source selections,
property runs, seed, workers, deadlines and the 90%/zero-uncovered/zero-invalid
gate. Qualification of the follow-up and remaining native journals is pending.

The integrated follow-up passes 71 runtime/property cases, including 300 generated
deadline schedules, with 100% line/function and 99.31% branch coverage for the
whole runtime. Repository health, lint, formatting and strict workspace types
pass. All 39 examples compile against 22 exact tarballs; 147 generated HTML pages
pass link checks. Seven reference-app cases and the native two-host Chrome
demonstration pass. These are local component checks; complete mutation and
exact-head hosted qualification remain required.

Runtime lifecycle follow-up (2026-10-01): the complete second whole-runtime
campaign on `289764f69` reached 89.10% across 422 mutations (299 killed, 77
detected timeouts, 46 survivors, zero uncovered/invalid), below the unchanged
90% gate. Its report and recovered mutated-worker failure remain negative
evidence. Added assertions exercise completed-operation cancellation cleanup,
no worker/projector activity on an early timer wake, retryable exclusive expiry,
and automatic publication recovery after a pending context write fails during
either worker or projector work. These test observable lifecycle behavior; they
do not relax the source selection or gate. Seventy-four isolated runtime cases
and strict draft compilation passed before integration; complete current native
and mutation qualification follow.

The independent whole SQLite proposal-journal campaign on the same head passed
97.44% across 352 mutations (343 killed, 9 survivors, zero uncovered/invalid) in
20m18s. One recovered worker SIGSEGV remains recorded. All 10,119 tracked and
compiled inputs matched the pre-run hashes after both campaigns terminated.
This qualifies the retained native proposal send boundary, including owned Buffer
bytes; it does not establish the still-unimplemented proposal client acceptance,
new replay profile, private query bridge, or complete checkpoint-two readiness.

The runtime lifecycle follow-up is qualified locally on `cb8f96c51`: all 1,507
native tests across 112 suites pass, with 97.67% statement, 95.50% branch, 99.13%
function and 98.12% line coverage. The runtime itself has 100% function/line and
99.31% branch coverage. The complete 422-site mutation rerun passes 91.71%
(301 killed, 86 detected timeouts, 35 survivors, zero uncovered/invalid) in 6m37s.
Its recovered mutated-worker exit remains in the execution log; prior failing
results remain retained. All 10,119 tracked/compiled inputs matched after both
campaigns terminated. Root health, lint, full formatting and strict workspace
types passed for the batch. The README now groups root/proposal component details
with their owning sections, keeps License last, and distinguishes existing native
service/workbench evidence from remaining complete-profile and application work.
This is local component qualification, not exact-head remote CI or checkpoint-two
completion.

### Final native root qualification for the current batch

On `189bed0c3a69d4af129db2cbbdda053f85091d7d`, the complete 255-site root-journal
campaign passes 98.82% (250 killed, two detected timeouts, three survivors), with
zero uncovered or invalid mutants, in 37m17s. The root-records request partition
passes 99.08% over 218 sites (216 killed, two survivors) in 57m08s. Its serving
partition passes 93.77% over 257 sites (241 killed, 16 survivors) in 38m51s.
The repository's pinned canonical inventory and partition combiner verify the
exact 475-site union at 96.21% (457 killed, 18 survivors), with zero uncovered
or invalid mutants. Every original test, source, property budget, seed, worker
limit and score gate is retained. These are explicitly local component receipts;
they do not impersonate hosted execution or a repository-wide qualification.

The recovered worker failures remain in the execution logs. All 10,119 frozen
tracked and compiled inputs matched their original hashes after the last campaign
finished, at 2026-10-01T12:39:50Z. Together with the preceding runtime, proposal,
HTTP, middleware and reference-app evidence, this closes the current native
delivery validation batch. Proposal client acceptance and its replay profile,
private query and projection composition, remaining application integrations,
and exact-head remote CI still require implementation or qualification before
checkpoint two can be approved.

### Opt-in proposal client and analyzer follow-up

The client increment composes installed source policy, bounded exact-envelope
verification, local frame4 replay and the existing Bitcoin worker/store. Its first
integrated run passes 286 tests across 20 suites, including 300 generated client
receipt histories and 300 generated core/restart/expiry histories. The core property
retains four real signed fixture bodies and copies them per generated schedule;
signature verification still runs through the actual core for each case. This
avoids repeatedly signing identical test inputs without reducing schedules or
verification. The isolated property passes in 86.2 seconds.

The exact packed Chrome test now also commits a proposal receipt to native
IndexedDB, closes the browser before acceptance, recovers it, accepts the signed
intent without Bitcoin verification, persists exclusive expiry and reopens with
a rolled-back clock. Its original lookup/cursor and cross-tab tests remain. The
first three browser builds exceeded the unchanged 140,000-byte gzip limit. Moving
optional state construction behind the proposal policy entry keeps the default
graph at 137,250 gzip bytes; complete browser artifact and native tests now pass.
The final entry refactor also passes 83 focused core/client cases and strict types.
Forty examples compile against 22 exact tarballs. The new client guide distinguishes
historical signed variants from current-channel interpretation and documents the
new namespace requirement. Private query/projection composition remains separate.

Hosted analysis of pushed `2d4379c86` reports missing proposal-guide metadata,
35 Sonar findings and two CodeQL findings in malformed-input test construction.
The metadata correction passes all 142 frontmatter/link checks. Local follow-ups
preserve validation while extracting response/reference checks, declaring actual
helper dependencies and expressing serial maintenance work explicitly. A first
scheduler refactor introduced an extra yield before an expiry callback; its
existing queued-recovery shutdown regression failed. The corrected iterator yields
only at real expiry work boundaries and all 30 scheduler tests pass. The failed
242-case run remains recorded alongside its 241 passing cases; it is not a complete
qualification. New whole-source mutation registrations cover the client and core,
and the existing runtime selection gains its cross-layer expiry regressions.
The exact 104-target inventory preserves all previous 102 source/test unions and
all original score, coverage, worker, seed and deadline gates. Complete current
package, mutation and exact-head hosted qualification remain pending.

The complete current native run passes 1,592 tests across 120 suites in 599 seconds,
with 97.61% statement, 95.43% branch, 99.11% function and 98.06% line coverage.
All 4,791 authored source/configuration hashes match the frozen inputs afterward.
The complete Overlay Express suite passes 771 tests across 32 suites. Both changed
packages pass their packed-consumer checks, including legacy SDK 2.8.9 with optional
features disabled. The documentation site validates 147 built HTML pages, the
security audit reports no known vulnerabilities, and all seven reference-app tests
plus its two-host native browser demonstration pass.

Subsequent focused regressions exercise isolated proposal journals sharing an
installation, multiple installed policy selections, retained transition boundaries,
provider removals without erasing signed history, bounded journal watches, stable
mutation lookup, cancelled/concurrent workers and recoverable CAS contention.
The selected client/core diagnostic passes all 309 tests in 19 suites, but its
package-wide coverage command exits unsuccessfully because unrelated suites were
not selected; that result is retained as diagnostic evidence, not a replacement for
the complete package gate. Additional malformed-policy, quarantine and lookup
regressions pass 63 tests in three suites. No mutation threshold, test selection,
runtime budget or coverage requirement was lowered. The new complete mutation
campaigns and exact-head hosted analysis remain pending.

The client verification qualification at `8b60ee8f0` passes all 530 mutations
at 94.72% (502 killed, 28 surviving, zero uncovered or invalid). The complete
four-module target and 300-case property budget remain unchanged. All 9,896
frozen input hashes matched after the 245-second run. Four recovered worker
memory failures remain in the local log; this is component evidence, not an
exact-head hosted or checkpoint-two qualification. Earlier failed reports remain
available. Client fixtures now construct mutated policies during test execution,
and independent envelope-digest, exact quota, negative-status, replay-header and
error-identity assertions cover the previously missed boundaries.

Core follow-up isolates the existing ancestor-publication traversal for direct
bounded-DAG testing without changing its 16,384-work-unit limit, cryptographic
qualification or wire formats. Shared-ancestor edges still consume work even
when a retained vertex has already been visited. Public store tests preserve
empty-revision rejection and cancellation during an already-waiting watch; the
private duplicate empty-history check and post-abort wake loop are redundant
with their callers. Actual SDK evidence tests cover spend-only currentness.
Fresh complete core mutation and broader compatibility qualification are pending.

### Shared SQLite transaction foundation

The implementation now extracts the existing native journal and index code into
internal connection-owned stores. Public constructors, exports, configurations,
namespace formats and default behavior remain unchanged. The common transaction
domain stages private cache copies, publishes only after physical commit and
coordinates cache rollback with nested session SQL savepoints. Journal forks
retain exact history, operation identities and pending completion reservations.
Duplicate cache owners on one domain are rejected. Failed pre-commit rollback
retires the connection before uncommitted state can become a readable prefix;
a lost commit acknowledgement never publishes unacknowledged memory. Final native
send retains its stricter retirement behavior.

The separately compiled prototype passes 221 native composition and compatibility
cases; the exact adopted-source run follows. Two additional journal-fork cases
cover independently evolving successors and completion reservations. The provider
query mapper/complete-group grammar (23 tests), source order metadata (two tests)
and read-feed facade (20 tests) remain outside-checkout drafts, not advertised
features. BRC amendment 295 defines the neutral private current-channel query;
its complete JS/Python corpora and six hosted checks pass at `82136f465`.

Prior component qualification at `9cbfa06c4` passes client verification (532 mutants,
94.92%) and proposal maintenance (325 mutants, 98.77%), each with zero uncovered or
invalid cases. The full 1,778-mutant proposal-core campaign reached its 45-minute
local bound without a final score; it is not passing evidence. All 9,896 frozen
inputs and HEAD remained unchanged. Its worker failures and timeout receipt are
retained. Main `6600211e3` is reconciled at `efd15187f` while preserving this branch's
newer brace-expansion 5.0.12 resolution. Complete current-head qualification,
current-channel provider/client integration and the broader checkpoint-two
requirements remain unfinished.

The adopted-source selection passes 223 tests in eight suites. A subsequent legacy
savepoint failure regression initially exposed a rollback error being wrapped as
ordinary rejected work; the correction lets it escape so the outer transaction
cannot commit that work. Both legacy rollback cases and all transaction-domain/
composition tests pass (28 cases). Root health, lint, formatting and strict
workspace types pass for the refactor, and the dependency inventory tests preserve
complete extracted source registration. The full native package run at `d9d2234b8` passes 1,703 tests in 123 suites,
with 98.08% statement, 96.23% branch, 99.14% function and 98.45% line
coverage. All 9,908 frozen authored/compiled inputs and HEAD matched after the
638-second run. The existing Overlay Express suite passes all 771 tests in
32 suites; packed output-knowledge consumers and all 40 documentation examples
across 22 exact tarballs pass. These component results do not establish a
current-head hosted quality gate or checkpoint-two completion.

The acknowledged application execution maps split whole files only: proposal core
into worker/state/store/proposal, and native proposal storage into journal/state/
domain. Every part retains the same canonical test/configuration inputs and
thresholds. Source inventory, execution-union and selected-artifact-download
regressions guard the final aggregate. These maps do not convert the earlier
partial run into qualification or establish a score for the adopted sources.

Native browser qualification at `6299d841f` passes exact packed entry contracts,
Chrome/native IndexedDB replay and durable proposal expiry; documentation builds
and all 147 built HTML page links pass. The transaction-domain mutation part
completed 260 mutants in 1,031 seconds but failed qualification: three uncovered
callable-state mutations and two runner errors while Jest formatted a thrown
internal rollback object after SQLite closed. Its 84.88% partial score is not a
canonical target pass. The same run's broad freeze receipt also detects 147
regenerated documentation outputs; authored and package-runtime inputs and HEAD
match, but the failed broad freeze must not be reported as unchanged. The report
and receipt remain retained. Follow-up covers callable/primitive forks, nearest
ancestor staging, direct write/read gates and foreign/poisoned rollback paths,
and represents intentional rollback as a normal Error so diagnostics do not
traverse native connection getters. A complete fresh run is required.

### Current-channel query and accepted projection

The query mapper, complete-group contract, durable authenticated source wrapper
and current-channel projector are adopted. Core input now includes optional owned
source-generation metadata and retained observation order, including empty
completed generations. The projector keeps providers independent, verifies exact
installed successor rules, rejects an inconsistent whole group and distinguishes
unresolved predecessor history, provider lifecycle and local exclusive intent
expiry. A narrower provider read/time feed is additive; old mutable index options
remain assignable. Existing wire and journal formats are unchanged.

The adopted selection passes 133 tests across 11 suites. An actual BRC-103/104
HTTP reference test passes progressive snapshot pages, exact durable core receipts,
live replacement after native restart without reopening the session, atomic
replacement groups and network-independent expiry. Its explicit index producer
is a fixture: the compound journal/index/session writer, future-event capacity,
private visibility guards and coherent proposal timer floor are still required.
Two generated properties additionally cover ordered histories and all-or-nothing
multi-channel rejection; complete package and source mutation qualification follow.

The transaction-domain rerun at `d40b01f84` ended after 1,018.58 seconds when two
workers exhausted memory/aborted. All 9,905 frozen inputs and HEAD matched, but
there is no final mutation report. A shell exit of zero is not qualification.
The negative log and execution receipt are retained. Upstream `022f1a250` merged
cleanly at `3143f37c2`, with all 12 knownTxids regressions passing. These changes
and prior component evidence do not complete the checkpoint or hosted CI gate.

The full native run at `d0c58a1e` completed 1,777 tests across 133 suites:
1,775 passed and two older exact-view assertions failed because they omitted the
new retained order metadata. All 9,934 frozen inputs and HEAD matched throughout
the 688-second run. The corrections retain the prior history comparisons while
explicitly checking the newly ordered fields. Hosted CI also found one unformatted
policy registration and 12 maintainability findings; those are corrected without
suppressions or changes to qualification thresholds. The complete affected
journal/current-query/current-projection and legacy-view selection now passes
366 tests across 28 suites, including both 300-case generated properties. The
authenticated HTTP progressive/live/restart integration, package types, root lint
and complete root/workspace formatting pass. The prior full-run failure remains
negative evidence; fresh complete qualification is required for this follow-up.

### Atomic private channel owner

Full native qualification at `4ec3c560a` passes 1,777 tests / 133 suites in
679.845 seconds, with all 9,934 frozen inputs and HEAD unchanged. Its preceding
metadata assertion, formatting and maintainability failures remain recorded
above; this is a fresh source-bound success, not a reinterpretation of those runs.

The optional `SQLiteProposalChannelStore` factory, restricted journal/feed/session
facets, atomic session bootstrap, indexed proposal timers and retained visibility
fences are now adopted locally. Active heads reserve their future expiry event;
finalizing heads retain native completion reservations and matching index capacity.
Sealed row/group bounds and conservative complete-wire bounds prevent accepting
an unrepresentable future event. Shared observed time survives rejected work;
partial expiry cannot advance complete snapshot coverage. Content edits preserve
sessions under the installed stable read descriptor; readership changes reset
previously visible and invisible sessions before native enqueue.

The isolated compiled implementation passes 167 tests / nine suites, including
300 native rejection, replay, partial-expiry and restart schedules, plus complete
legacy session/journal compatibility. An additional wire-bound regression is
adopted. The canonical adopted selection passes 251 tests / 14 suites, including
the 300 native schedules; package types, root lint and 69 governance checks pass.
The actual BRC-103 HTTP demonstration now commits through the compound journal,
reopens provider storage and resumes the durable client session without reopening
it. Atomic live replacement and locally derived intent expiry still pass. Public
packed consumers and complete package/mutation qualification follow. The new
critical complete-source target retains 90% and zero uncovered/invalid gates;
whole-file factory/writer/inventory/contract execution parts preserve the canonical
union and original inputs. These component changes do not complete checkpoint two.

The adopted compound batch passes all 1,834 native tests / 139 suites in 795.129
seconds: 97.98% statements, 96.14% branches, 99.2% functions and 98.33% lines.
All 9,961 frozen inputs and HEAD match. Packed public exports, 42 compiled examples
against 22 exact tarballs, eight reference-app tests and complete root health,
lint, formatting and workspace types pass. The generated API facts change only
the output-knowledge entry after whitespace normalization.

A subsequent review found that unsuccessful native proposal delivery rolled back
its sampled clock. Three regressions confirm the earlier behavior. The correction
runs only the opt-in compound send inside a savepoint after retaining time; the
legacy journal's transaction behavior is preserved. The isolated correction passes
89 journal/compound tests across four suites. The real Engine/Mongo pipeline now
runs in both standalone and compound modes and verifies that publication,
reservation and recovered finalization update the current feed without manual
index writes. Both isolated pipeline modes and their application types pass.
These follow-up edits require fresh adopted-source qualification.

Hosted head `4ec3c560a` reached the 45-minute wallet-recovery-encoding job bound
without a final report. The cancellation is retained as negative evidence. Its
prior local complete campaign took 27m53s, with 171 mutants and 91.81%; that older
result does not replace terminal successful qualification of the current head.

The follow-up canonical compound selection passes 269 tests / 14 suites, including
its full 300-case native property. All eight complete target modules reach 100%
statements, functions and lines, with 99.6% branches in a diagnostic coverage run.
A further local-context regression checks owned recovery retention and exclusion
from lookup payloads. The adopted reference application passes nine tests across
four suites, including both native storage modes. Mutation qualification and the
fresh complete native run remain pending; line coverage is not mutation evidence.

### Compound qualification and recovery encoder follow-up

At local `612092dd39050cd05a926d42880ff46d87e53c4b`, complete output-knowledge
native coverage passes 1,853 tests/139 suites in 860.392 seconds. All 9,961
captured source/build inputs and HEAD match. This run used Node 25.9.0, within
the repository Node >=24.11 requirement; subsequent isolated checks explicitly
use Node 24.19.0. The complete 431-mutant contract part had 270 passing initial
tests, then a worker SIGABRT after about 37 minutes; the campaign subsequently reached its 45-minute bound without a final report.
All 9,961 captured inputs and HEAD still matched. The SIGABRT and timeout are
negative evidence, and no mutation score is claimed.

The wallet action-recovery encoding extraction preserves the original JSON and
binary function bodies, limits, error identity and exports. Its strict isolated
codec compile and 57 focused tests pass. After correcting only the isolated test
fixture layout and transpiling existing legacy test utilities, all 164 canonical
recovery tests/16 suites pass in 71.548 seconds, including actual child-process
termination/recovery. That isolated run is not a whole-wallet typecheck or a
replacement for adopted-source, packed, mutation and hosted validation. The
preceding isolated-layout failures are retained. Complete JSON and binary/bounds
execution reports plus their canonical aggregate remain required.

A bounded positive-signature cache prototype passes 103 tests/seven suites.
Under Node 24.19.0, the identical native 300-case property with seed 3242026 took
87.671 seconds without caching and 45.667 seconds with the cache; these are
sequential local observations, not a portable performance promise. The cache
stores only 256 full-envelope SHA-256 identities. Policy, scope, ownership,
current authorization and lifecycle checks are not cached. Fresh signed variants,
modified bytes, failed signatures, FIFO eviction, separate registries and changed
policy decisions are exercised. No canonical test, property budget, seed, timeout
or validation threshold is reduced.

The adopted follow-up passes complete native coverage: 1,859 tests/140 suites in
641.528 seconds under Node 24.19.0, with all 9,964 captured inputs and HEAD
unchanged. The actual adopted wallet canonical selection passes 164 tests/16
suites in 70.185 seconds; public packs, preserved SDK 2 wallet consumers, all nine
reference-app tests and root health/lint/format/types pass. These results do not
replace pending mutation or hosted qualification.

The subsequent application-only worker-recycling setting preserves all canonical
work and restarts a runner after eight executions. Source discovery also ignores
only nested generated Stryker directories, preventing an abandoned crashed
sandbox from colliding with the live package name. The rooted pattern does not
exclude a running mutation sandbox's own sources/tests. Existing authored test
selection, transforms, coverage gates and runtime behavior are unchanged.

Hosted 4ec3 subsequently reported six root-eviction failures at the five-minute
initial-test deadline: service, maintenance, coordination, commit, requests and
serving. None produced a mutation score. Their logs are retained and their
canonical native-test costs require remediation before complete CI acceptance.

### Protected-storage and root-verification follow-up

The complete compound contract campaign at 826bc359d finished in 43 minutes
7 seconds, covering all 431 mutants: 390 killed, 32 survived and nine runtime
errors, with no uncovered mutants. The valid-mutant score was 92.42%, but the
zero-invalid gate failed. All 9,964 captured inputs and HEAD were unchanged.
The nine errors came from importing a shared registry fixture before tests were
registered. Registry/lifecycle construction now happens in explicit fixture calls
or test lifecycle hooks, preserving all canonical cases. All nine exact runtime
negative controls now produce ordinary failing tests with zero runtime-error
suites; each runs the entire 270-case selection. New complete qualification is
still required; the former failed result is not a successful gate. The four complete contract files now have separate
capacity, records, privacy and policy execution parts with the same canonical
test/configuration union and final aggregate requirements.

A bounded exact-packet/selection root-authentication cache was profiled and
tested outside the checkout before adoption: all 295 canonical root tests across
30 suites passed, followed by seven focused cache and large-envelope cases. The
identical seeded 300-case history took 28.657 seconds before and 16.225 seconds
after the change in that local comparison. The cache stores only positive
cryptographic identities; current policy, clocks, persisted bindings and native
serving authorization remain live. This local comparison does not establish a
hosted performance guarantee.

The protected-ledger foundation adds local Node custody framing, complete record
codecs and one native SQLite transaction owner. It protects private bodies,
authenticates inventory, preserves immutable configuration, reserves bytes and
completion revisions and rechecks local authorization under the enqueue gate.
It deliberately provides no automatic initialization, fence deletion or
compaction. The installed-codec capacity is checked before creation. Its 75
isolated tests include 300 native restart schedules, actual process loss,
independent-process CAS, key rotation, corruption, malformed input and the final
reserved completion revisions. A newly added fault regression first reproduced
a metadata-sealing rollback error; moving metadata and records into the same
savepoint fixed it and the complete isolated suite passed. This is an internal
foundation: typed private publication/acquisition state machines, permanent
keyed identity mappings, actual wallet/admission composition and usable delivery
remain unfinished. Source adoption includes a critical complete-source mutation
target and all required execution-part aggregation; no gate was weakened.

After adoption, strict package types and build passed, followed by all 82 native
protected-ledger/payload and root-cache tests across four suites. This includes
the actual compiled package in the process-loss and independent-process cases.
Root health, lint, formatting and workspace types passed. The first root health check
identified the new property's missing standard configuration hook; the test now
uses the governed seeded hook and retains its 300-case minimum and replay path.
Package artifact validation and all 42 compiled examples against 22 exact
tarballs also passed. Existing repository maintenance advisories remain visible
in the successful health report; this batch does not waive or extend them.
Full native coverage, mutation aggregates and exact-head hosted qualification
remain required for this batch.

### Native completion and protected-codec follow-up

The pushed c344d22b3 passes complete output-knowledge native coverage: 1,941 tests
across 144 suites in 595.487 seconds, with all 9,979 captured inputs and HEAD
unchanged. Root health/lint/format/types, public packed consumers and all 42
compiled examples against 22 exact tarballs passed before that push.

The first complete protected-ledger codec execution part finished in 5 minutes
23 seconds: 274 mutants, 188 killed, 86 surviving, no uncovered or invalid
mutants. Its 68.61% score is not a complete target acceptance result: the store
part and canonical aggregate remain required. Every captured input and HEAD
stayed unchanged. New direct codec regressions cover inclusive reservation
limits, invalid numeric representations, independent inventory framing,
configuration/plaintext bounds and failure classifications. Independent native
AES-GCM opening checks the documented HKDF/AAD/envelope format; separate label
and custody tests avoid relying on a missing-key error to detect a malformed
label. The expanded canonical private selection passes 120 tests across four
suites. No source/test union or threshold was reduced.

Hosted c344d22b3 reported three Sonar maintainability findings in the compound
privacy/inventory implementations and protected-ledger test fixture. The local
follow-up simplifies the optional guard comparison, names the expected expiry
before comparison, and creates the fixture default inside its body. These
changes preserve runtime behavior. All 270 canonical compound-provider tests
across 14 suites pass, with no runtime-error suites. Root health, lint, formatting
and workspace types also pass after the expanded test registration and explicit
lineage execution-setting assertion. A first direct Jest invocation from the
repository root failed to resolve the package's TypeScript configuration before
running any tests; the corrected package-directory invocation is the 120-case
result above, not a waiver of that setup failure.

The previous hosted 4ec3 lineage graph job lost a worker to memory exhaustion
after about 79 minutes and reached its 90-minute job bound without a report.
The coordinated graph-only worker-reuse setting now recycles after eight mutant
executions. All original source ranges, 99 canonical tests, property budgets,
workers, deadlines and score/coverage/invalid gates remain; the union regression
permits exactly this one explicit execution-setting difference from traversal.
Fresh complete execution and final exact-head CI are still required.

### Protected-store integrity and boundary qualification

The complete local b4b96d772 protected-ledger target did not meet its unchanged
90% requirement. The codec part killed 258 of 274 mutants (94.16%); the store
part killed 237 of 335 (70.75%). Both completed with zero uncovered or invalid
mutants, identical 9,980 captured inputs and unchanged HEAD. Their complete,
disjoint three-file union therefore scored 81.28% across 609 mutants. This is a
failed local aggregate, not hosted qualification or checkpoint approval.

The follow-up retains every original source and canonical test and adds native
restoration and boundary cases. Synthetic custody-authorized restoration verifies
that authenticated ciphertext still requires valid head, inventory, revision,
UTF-8, canonical JSON and declared-length semantics. Exact error classifications
distinguish unavailable restoration, limited capacity and stale-revision conflicts.
Other cases exercise inclusive 64-record batches, exact payload reservations,
updates at full slot capacity, reservation-delta accounting, atomic rollback,
and rejection of async callbacks before their bodies can execute. No gate,
threshold, property budget, source range or prior test was removed.

The expanded private selection passes all 168 tests across six suites in 9.702
seconds with the canonical 300-case property budget and seed 3242026. The first
new restoration run exposed three fixture cases rejected by the shared numeric
JSON parser before reaching head validation; the corrected cases use valid JSON
values with invalid field types to test that distinct boundary. One initial
runner invocation used an absent root Jest path and ran no tests; the successful
run uses the package-local installation. All 29 mutation-registry/partition
regressions, root health/lint/format/types and strict package types pass. Complete
fresh mutation parts and their unchanged-policy aggregate remain required.

Fresh complete qualification on eaef85bb1 passes the unchanged protected-ledger
policy. The store part finished all 335 mutants in 7m33s (314 killed, 21 survived,
93.73%); the codec part finished all 274 in 5m59s (258 killed, 16 survived,
94.16%). The disjoint complete three-file union scores 93.92% across 609 mutants,
with zero uncovered and invalid outcomes. Both ran the same 168 canonical tests,
kept all 9,983 captured inputs and HEAD unchanged, and passed the local aggregate
using the repository's actual metric/policy functions. This is complete local
storage qualification; it is not a hosted execution receipt or final program CI.
One remaining meaningful survivor suggests a further full-inventory boundary
case: reject another insertion after a separately committed full store. That
case belongs in the next native publication/work-discovery integration batch;
no source condition was weakened or excluded to obtain this score.

### Native publication owner and bound private identity

This batch adopts five internal modules for retained private
identity/domain configuration, shared blob/request binding, ordered publication
progress and the native SQLite publication owner. They expose no public package
entry or HTTP mutation route. Current Bitcoin/schema/publisher validation and
actual admission/binding durability remain installed service duties. The domain
factory binds the indexing-key commitment into protected storage; it does not
initialize missing state during open or pretend separate databases share a
funding uniqueness domain.

Staging stores a shared protected blob and independent request fence atomically.
It reserves the full future progress representation before accepting work.
Explicit record/global revisions, current guards and commit-time deadlines
protect phase changes. Reserved admission stays pending past staging expiry;
original admission and exact lookup binding are retained before ready. Readiness
loss/restoration preserves that original evidence. Generic bounded work discovery
returns current metadata pages, never a snapshot/completeness claim. The additional
full-inventory regression rejects an insertion after a separately committed full
64-record store.

The complete new/retained native selection passes 266 tests across 13 suites in
45.267 seconds with both canonical 300-case property campaigns and seed3242026.
Four separate child processes are killed at staged, admission-reserved,
admission-retained and ready boundaries, then independently reopened. The native
publication property varies bytes, shared-blob requests, restart positions and
commit-guard denial while checking the independent expected phase/record history.
All prior protected-storage tests remain. Full new-source mutation qualification
and final exact-head CI are still outstanding. See the internal
[storage guide](../../docs/guides/private-publication-storage.md) for the precise
boundary and required next service composition.

Hosted336bf9fd1 has an infrastructure failure in the unchanged authenticated CHIRP
upload suite: its 4 MiB upload and following altered-byte rejection reached their
30/15-second test deadlines. A missing local Jest installation initially ran no
tests; after the pinned npm installation and the existing approved native rebuild,
all112 tests/20 suites pass locally with two workers in20.983 seconds. This is
local diagnosis, not a waiver or a successful hosted rerun. No assertion, payload
size or deadline was changed. The eight current PR review threads are resolved;
there is no additional review page.

The adopted batch also passes root health/lint/format/types, its strict build and
all output-knowledge packed consumers/exports/type resolution. Initial governance
validation caught the missing package-level property-script selection; that command
now retains every previous test and includes the new property suite. The new
critical target109 covers all five complete modules with identical canonical tests
in four disjoint execution parts. The existing protected-ledger target adds native
enumeration and retains every original test. Complete full-native coverage and
mutation aggregates remain pending.

The unchanged UHRP service also passes its default-worker command locally: all112
tests/20 suites in28.620 seconds. GitHub rejected the job-only rerun because its
containing workflow is still running (HTTP403); no rerun occurred and the hosted
failure remains unresolved. No workflow or service source was changed for this
diagnosis. The permitted package installation used ignored scripts followed by the
existing named better-sqlite3 rebuild.

### Private publication admission and native boundary follow-up

The full application native suite on14a4750bb passes2132 tests across154 suites
in601.188 seconds. All10007 captured inputs and HEAD remained unchanged. The
new publication mutation target completed all four whole-file parts with those
same inputs: identity71/87, progress294/338, records101/117 and store102/149.
The complete691-mutant union scores82.20%, with zero uncovered and invalid
outcomes. This fails the unchanged90% gate. No part exit status substitutes for
that aggregate result, and that source freeze is now complete.

The follow-up preserves all original tests and adds exact reservation-envelope,
extension, typed failure, commit-guard, retained-record relationship and native
revision-capacity cases. Its isolated current-source selection passes137 tests
across five suites, including actual process-loss recovery. These tests count the
future progress framing independently and accept the exact capacity while
rejecting one byte less; missing protected blobs and correctly authenticated
records stored at a different publication address remain unavailable. Fresh
complete mutation qualification is required; individual negative controls do
not establish the target score.

The optional private-publication admission entry uses actual retained Engine
history and the existing off-chain-values argument. It requires a separately
verified and durably reserved publication, exact original signed capability and
installed current-context guard. Its result distinguishes selected-output
admission, definitive exclusion and unresolved work. Exclusion does not mean
transaction-wide rollback. Reusing original public admission requires explicit
installation policy and independent private validation. The shared retained
receipt validator preserves the proposal adapter's original assessment identity
and existing behavior.

Before adoption, the private adapter and preserved proposal regressions passed
107 tests across five suites, including two canonical300-case properties and
three actual Engine/Mongo replica-set integration cases. The native cases
exercise private-value delivery, lost-reply recovery, explicit public history
reuse and retained history after serving eviction; their pinned public BRC-62
proof roots do not replace the full service's independent header policy. Initial
fixture corrections and successful strict compilation are retained in the local
execution record. The new public subpath includes ESM, CJS, modern declarations
and legacy TypeScript resolution; root exports and existing public submission
behavior stay compatible. Full service/lookup/HTTP composition, complete new
source qualification and terminal exact-head CI remain outstanding.

The adopted selection passes all138 publication tests with the canonical300-case
property budget, all107 private/proposal Engine tests including actual Mongo,
strict builds and declarations, ESM/CJS packed consumers, and root health/lint/
format/types. The first root format pass caught the appended README formatting;
that formatting was corrected and the full check rerun successfully. All27 exact
survivor controls (including14 native store controls) fail ordinary assertions,
not import or compilation setup; complete qualification is still required.

The first complete overlay test run also discovered an abandoned nested Stryker
sandbox and attempted to execute its copied StorageContract test with an invalid
fixture-relative path. That run was stopped and is not counted as validation.
The Engine Jest configuration now excludes only nested generated children and
retains the active mutation root; a regression checks real source/property tests,
generated children, a similarly named real directory and node_modules. No live
suite or mutant is excluded. The complete overlay suite must be rerun after this
source-owned discovery correction.

After the discovery fix, the complete overlay suite passes950 tests in46 suites
in202.723 seconds. The existing opt-in Go localhost interop case remains skipped
unless its separately governed external checkout is configured; no new skip was
introduced. Root health/lint/format rerun successfully after the correction, and
the previously completed root typecheck remains applicable (the correction only
changes Jest discovery and its governance test). Complete mutation reports and
hosted validation are the next acceptance boundary, not implied by these passes.

The initial private-admission mutation attempt on e5624c0fc began with all104
canonical tests passing and362 generated mutants. Repeated injected early failures
revealed an unobserved first promise in the new concurrency test, terminating
workers before ordinary assertions. The run was explicitly stopped after180.687
seconds with all10014 captured inputs and HEAD unchanged; it produced no complete
qualification report and is not an accepted score. The test now attaches both
settlement handlers immediately and releases the stalled read in a finally block.
A deliberately inverted contract-identity check reaches one ordinary failed Jest
assertion with a complete report. Production code and all canonical tests/gates
are unchanged; a fresh complete campaign is required.

The corrected complete private-admission campaign on8317369c9 finished all362
mutants in315.137 seconds, with10014 unchanged captured inputs and HEAD:
276 killed,86 survived,76.24%,zero uncovered and invalid. This remains a failed
90% gate, with no worker-crash waiver. The next test-only batch independently
exercises signed service/profile selection, every retained header/digest, current
storage/admission/history/scope identity, explicit public reuse configuration,
critical extensions, HTTPS, complete request/context bounds, full result framing
and a fixed original assessment vector. Production source and gates are unchanged.

The expanded complete canonical selection passes145 tests in four suites in
12.023 seconds with both300-case properties and seed3242026. Its first136-test
run had one fixture failure: the scope accessor returns an owned copy, so the
corrected replacement test changes actual installed storage scope. Initial strict
types also prevented direct assignment to readonly history; the malformed-host
fixture now uses explicit runtime property replacement. One initial chain control
still survived because its fixture also had a conflicting derived publication ID.
The revised fixture recomputes that ID to isolate the original-chain check.
Eight exact former survivors then reach ordinary failed assertions in an isolated strictly compiled
harness, including installed rules, scope, history ownership, capability headers,
original chain, result framing, critical extensions and assessment digest. Fresh
complete qualification, rather than these controls, determines acceptance.

### Complete private foundation qualification and root-worker follow-up

On local0b4f983bc the private-admission target completes all362 mutants:
354 killed, eight survived,97.79%,zero uncovered and invalid. Its145 canonical
tests include both300-case properties with seed3242026. All10014 captured inputs
and HEAD stayed unchanged. One V8 GC worker SIGSEGV was recorded; Stryker recovered,
and its complete final report accounts for all362 valid outcomes. No invalid-result
waiver was used. Earlier failed and interrupted runs remain preserved above.

The same head completes all four private-publication-state execution parts with
identical10014 captured inputs and HEAD. The complete five-file aggregate has
691 valid mutants, 672 killed, 19 survived and 97.25% detected, with zero uncovered and invalid.
The complete source union and identical canonical test/configuration inputs were
checked before applying the unchanged critical90%/zero-uncovered/zero-invalid
policy. These local results are not final exact-head hosted acceptance.

Hosted336bf9fd1 remains incomplete. Its root-eviction-coordination job passed all296
canonical tests but reported worker memory exhaustion, then reached the existing
45-minute bound without a complete97-mutant result. It remains cancelled/failed
evidence. The narrow follow-up recycles only that target's workers after eight
executions, preserving all three complete source files, all canonical tests,
property budgets, four workers and every deadline/gate. Exact assertions preserve
all other root and wallet defaults. Complete replacement qualification is pending.

The next verified native publication layer remains outside this branch: its combined
207tests/13suites pass in174.142 seconds with both300-case properties, five actual
SIGKILL phases,10014 unchanged checkout inputs and86 unchanged outside source/build
inputs. This is draft evidence, not adoption or qualification of a complete private
service. Actual domain validation, authenticated HTTP, bounded reconciliation,
paid lookup/purchase/wallet composition and final hosted CI remain outstanding.

The same hosted336bf9fd1 also reached the revenue-lineage-graph90-minute bound
with the prior worker-reuse8 change, all99 initial tests passing and246 generated
mutants; no new workerOOM appears in that log. The complete local246-mutant
241-killed/five-survivor report is historical evidence, not acceptance of this
cancelled run. The next behavior-preserving extraction retains every original
layout/ABI, genesis/successor and traversal function body in three private modules,
with the existing public type and verifier entry forwarded unchanged. Its isolated
strictly compiled complete99-test/eight-suite selection passes in57.882 seconds
with canonical300-case properties and seed3242026. The coordinated registry now
covers every complete module and divides graph execution into two disjoint whole-file
parts with exact canonical aggregation. Target counts, other source/test entries,
critical gates, workers, seeds and deadlines are unchanged. Full adopted build,
packed-consumer, complete mutation and exact-head hosted qualification remain
required before this execution repair is accepted.

The adopted extraction passes all99 canonical tests in eight suites in57.108
seconds, including the unchanged300-case properties and seed3242026. A TypeScript
scanner comparison confirms unchanged signatures and bodies for all ten original
functions, ignoring only whitespace/comments; no source function was dropped.
All88 targeted governance/orchestration/partition tests pass. Package build and
packed-consumer checks pass, including ESM, conditional/wildcard exports, declaration
resolution and source maps. Root health, lint, format and type checks pass. The
release-document generator changes only the output-knowledge summary/migration
content; the wider table diff is formatting. Complete frozen mutation campaigns
for both graph parts, traversal and root coordination remain the next boundary.

### Complete root coordination and lineage extraction qualification

On local7fb637172, one sequential four-worker pipeline completes root coordination,
lineage layout, lineage transition and traversal. All four runs preserve the same
10020 captured inputs and HEAD; the source freeze ends only after traversal settles.
Root coordination accounts for97 mutants:89 killed/eight survived,91.75%,zero
uncovered/invalid,688.073 seconds within its unchanged2700-second bound. Both graph
parts retain all99 canonical tests and all300-case property budgets/seed3242026:
layout has125 mutants (123 killed/two survived) in865.741 seconds; transition has119
(116 killed/three survived) in845.156 seconds. Their complete disjoint two-file
aggregate is244 mutants,239 killed/five survived,97.95%,zero uncovered/invalid.
The independent complete traversal file has76 mutants:68 killed,one timeout and
seven survived,90.79%,zero uncovered/invalid,417.236 seconds. The unchanged policy
counts timeout as detected; it is reported separately from killed. No source file,
canonical test or invalid result is omitted. These are local qualification receipts,
not final exact-head hosted CI acceptance.

The earlier pushed336bf9fd1 hosted run also cancels root journal, record requests,
record serving, codec and storage at their90-minute bounds after all296 baseline
tests pass. They generate255,227,257,182 and357 mutants respectively, but no complete
reports. These logs show no workerOOM. Bounded worker recycling for those targets
is a separately coordinated measurement proposal, not an established cause or fix.
The UHRP infrastructure failure and incomplete hosted run also remain unresolved.

Outside-checkout service drafts now additionally include current publisher guards,
full-context admission leases, bounded publication orchestration, original-contract
reconciliation and a native final response gate. The207-test verified native draft,
32 authority tests and37 coordinator/disclosure/reconciler tests pass separately.
One actual SDK/Engine/three-member Mongo/SQLite integration passes in10.223 seconds;
three actual BRC103/104 HTTP integrations pass in11.247 seconds. They demonstrate
lost Engine reply recovery, original context after restart/manifest expiry, current
access after signing, fixed public error messages and existing public lookup/CORS.
HTTP's initial strict media-type check incorrectly omitted Express's UTF-8 charset;
the corrected guard requires its exact emitted value. A following test wrongly
looked for cache headers on AuthFetch's reconstructed response; actual wire-header
capture verifies the server's no-store/CORS behavior. Both earlier failures remain
recorded. A300-schedule native coordination property passes in120.045 seconds.
These drafts are not yet adopted or fully qualified, and they do not complete
private acquisition/purchase/wallet composition or the remaining demonstrations.

### Adopted verified private-publication foundation

The five complete verified-publication modules and the additive version-2 native
store path are now adopted. The original two-argument store construction and
version-1 operations remain covered. The canonical thirteen-suite selection
passes all207 tests in150.743 seconds, including both300-case properties with
seed3242026 and five actual SIGKILL recovery phases. The bounded execution took
152.494 seconds and retained10045 unchanged captured inputs and HEAD c1405d317.
An initial invocation from the repository root failed before executing tests
because ts-jest resolves its configuration relative to the package directory;
that invocation is retained as a harness failure, not test evidence. The corrected
run uses the application package working directory and the same canonical suites.

All91 governance, partition and orchestration tests pass. Package build and
packed-consumer checks pass, and root health, lint, format and type checks pass.
Health reports zero contract findings/control errors and separately retains the
existing expired-exception maintenance notices. Generated API documentation changes
only this package's release content plus deterministic table alignment. Registration
now contains111 targets/properties. The new service target covers every complete
new module in five disjoint whole-file execution parts; the existing state target
retains all five original source files and adds the verified native tests. Complete
fresh state/service mutation qualification and exact-head hosted CI are pending.
The authenticated coordinator, reconciler and HTTP drafts remain outside checkout;
this foundation does not claim a finished private service or the second checkpoint.

The separately acknowledged root journal/records/codec/storage runner follow-up
now recycles workers after eight executions, retaining every canonical input,
existing records partition, budget, worker bound, deadline and critical gate.
This is a measurement change, not a claim about the cause of the five hosted
cancellations or acceptance of those targets. Complete frozen-source reruns follow.

### Integrated private publication service and HTTP composition

The optional `@bsv/output-knowledge/private/node` entry now exposes the protected
seller/chain domain, contracts, exact SDK evidence, bounded verification leases,
structural coordinator/storage/admission ports, native disclosure and restart
reconciliation. The separate Overlay Express `private-publication` entry mounts
publish/status explicitly with the existing origin authentication instance.
Ordinary root imports and routes retain their behavior. These publication owners
do not implement paid lookup, purchase/POTATOES or playback entitlement.

Protected metadata can retain an original publication when its material key is
unavailable. Authorized status first checks the original selector, then commits
ready-to-unavailable under native revision/current-authority guards. Metadata
alone never asserts readiness. Missing metadata fails closed; explicit restoration
must recover the same material and binding. Deferred or repeated HTTP enqueue is
rejected, with no replacement after an actual native send attempt.

Before adoption, the coherent composition passed325 tests across25 suites in
337.732 seconds: actual SDK Script/SPV, three-member Mongo/Engine, SQLite, mutually
authenticated HTTP, full legacy publication cases, authority/recovery cases and
minimum300-case native and HTTP properties. All10,045 captured checkout inputs and
163 outside candidate/build inputs stayed unchanged on895dfa2fb. Two public
installation examples strictly compile. These are local composition observations,
not complete checkpoint or hosted qualification.

The critical private-publication-coordination and private-publication-http targets
raise the registry count from111 to113. They retain all complete modules and
canonical native/property/cross-package tests in disjoint whole-file execution
parts. State/service targets additionally retain material-loss cases. No score,
coverage, invalid-mutant, seed/budget, worker or deadline gate is relaxed.

The earlier895dfa service parts measured evidence28/36killed(77.78%),
contracts57/76killed(75%), original70/97killed(72.16%), all zero uncovered/invalid.
Every input stayed unchanged. These partial scores prompted additional boundary
tests; the full canonical target was incomplete. The repository intentionally
applies its90% score gate to the complete combined target, while each execution
part must have zero uncovered/invalid mutants. A successful partial invocation is
not whole-target qualification. The queued campaign was stopped only after its original
part completed; unrun service/state/root jobs remain unqualified. Additional
contract boundary tests and fresh complete-source campaigns are required.

The pushed336bf9fd1 CI also cancelled proposal-journal-send journal/state and
proposal HTTP at their45-minute bounds after full baselines, and lookup-index
finished89.04% with five uncovered compound-owner paths. Native lookup composition
regressions now cover atomic append/head/row ownership and rollback, distinct
retained composition identity and closed compaction bounds. The cancelled and
failed hosted evidence remains open until complete successful reruns.

Integrated source qualification then passes337 tests across25 suites using the
registered canonical source-based native configuration, including all actual
Engine/HTTP integrations, in336.121 seconds. All10,088 captured checkout/build
inputs and HEAD895dfa2fb remained unchanged. The separate strengthened lookup and
contract suites pass81 cases;97 governance tests pass. All four required root
checks and both packed packages pass, including legacy Overlay Express SDK2.8.9
ESM/CJS and strict declaration consumers. All44 documentation examples compile
against22 exact tarballs. Complete source mutation and terminal hosted acceptance
remain open; none of these passing checks converts prior failures into success.

### Paid acquisition foundation and canonical execution follow-up

Five internal modules now define paid-acquisition progress, recipient-safe result
projection, original quote/capability ownership, actual SDK funding evidence, and
a protected seller/chain funding uniqueness index. The quote's original terms
survive discovery changes. The first complete candidate must reach durable intake
before the recovery deadline; processing may finish later. Exact retries retain
the candidate and original invoice. Indeterminate wallet credit cannot authorize
delivery, and a funded undelivered acquisition retains its recovery obligation.
Funding slots reserve capacity before payment and require a single native commit
with the progress transition at the observed global revision.

The modules have no new public entry or route. Full paid-service composition still
requires the atomic quote/material/result owner, current buyer authorization,
bounded wallet reconciliation, domain release policy, final disclosure guard and
HTTP integration. A material reservation is distinct from payment-dependent result
issuance; for example, a result may bind a subsequently verified funding identity.
Neither SDK evidence nor a wallet receipt alone establishes the release verdict.

The new critical private-acquisition-foundation registration adds one target and
property (113 to 114), with five complete, disjoint execution parts and the same
full native/property/process selection on each. The separately coordinated
proposal journal/store and HTTP partitions preserve their complete source/test
unions. Only the selected proposal and lookup-session runner entries gain reuse8;
other lookup defaults remain absent. Seeds, budgets, workers, deadlines, aggregate
score and zero-uncovered/invalid gates are unchanged. Complete fresh target
qualification and exact-head hosted CI remain required.

On197caf0a0, the previous service campaign completed evidence31 (30 detected),
contracts76 (73 detected), and original105 (95 detected, nine survived and one
uncovered private-helper default). Every captured input and HEAD stayed unchanged.
The uncovered default prevented continuation; binding and records did not run, so
there is no complete-target acceptance. The redundant private default is removed
while both public defaults remain. Native cases explicitly preserve those defaults
and reject changed retained private values. Fresh complete qualification is pending.

The adopted canonical acquisition selection plus the publication-contract
regression passes294 tests across15 suites in19.368 seconds, including the real
separate-process funding race and both300-case properties. All99 governance
regressions and four root checks pass. An earlier direct Jest invocation omitted
the package's required VM-module flag: four suites passed, three failed at
TypeScript setup. The corrected native command uses the package's actual Node
entry and flag; the earlier setup failure is not counted as test evidence.

### Native paid-acquisition owner

The internal four-module state layer now reserves the original signed contract,
complete future envelope allowance, immutable material and future result slots
in one native transaction with permanent invoice/funding capacity. Funding fences
advance atomically with payment progress, and delivery bytes with delivered state.
Retained originals survive catalogue/manifest expiry. Current native reads,
revisions, complete capacity, fixed missing-principal behavior and synchronous
disclosure gates remain separate from application-domain and release verdicts.
The optional larger local ledger plan preserves default four-MiB behavior and all
SDK wire bounds. There is no public route, new public export or format migration.

The draft native qualification includes 300 generated histories and six actual
SIGKILL/reopen boundaries. Full canonical mutation/hosted qualification and paid
service composition remain required; these checks are not a completed acquisition,
POTATOES or application-integration claim. The current-buyer, native wallet,
release/coordinator and HTTP integrations are tracked as subsequent layers.

### Internal acquisition coordination and recovery

Nine complete internal modules now compose buyer authorization, owned domain
preparation, SDK release evidence, exact native wallet receipts, acquisition
progress, guarded disclosure and bounded local workers. The portable native
wallet tests use public CJS exports with disposable synthetic SQLite storage and
no broadcast. Generated interruption histories preserve the original quote and
single funding operation through recovery. Worker authority is distinct from
current buyer/domain permission; final HTTP authentication remains a separate
boundary. The following HTTP layer exposes those entries and provides native
transport tests; concrete domain/LCH adapters and complete mutation/hosted
qualification remain open.

### Authenticated acquisition HTTP and host composition

The explicit Node-only public entry now exposes acquisition custody, contracts,
coordination, release checks, wallet adaptation, disclosure and recovery workers.
The opt-in acquisition router binds both challenge and recovery to the original
seller/buyer, preserves payment headers only on an unpaid challenge and repeats
native authority checks after signing. Overlay Express lazily composes private
publication/acquisition with existing authentication and host policy. Native
HTTP tests include one actual SQLite wallet credit through repeated recovery;
host and generated signing tests cover composition and changing permissions.
The full mutation/hosted gates, durable buyer client, concrete domain/LCH adapters
and purchase/POTATOES implementation remain open.

The current local HTTP batch passes the complete 85-test/11-suite canonical
acquisition/private-publication selection, all 156 legacy host tests and 102
mutation/property/governance assertions. Native wallet/recovery tests pass ten
cases after an explicit CJS type import and NodeNext Node-test resolution;
production portable compilation is unchanged. Packed application ESM and host
ESM/CJS consumers, strict SDK-2.8.9 legacy host consumers, 29 compiled examples
from ten exact package tarballs, and the four required root checks pass. These
are local batch results, not complete mutation or exact-head hosted acceptance.

### Finite buyer transport and protected control state

The SDK paid-lookup transport implements an immutable authenticated quote,
explicit paid request or original recovery operation. Actual HTTP tests cover
lost replies, bounded payment framing and one native seller-wallet credit.
Protected operation state composes selected-wallet self-encryption above the
existing native/browser atomic CAS stores, with explicit initialization, complete
ciphertext capacity and original revision recovery. Native process-kill and
packed browser tests exercise durable state, browser restart and concurrent tabs.
The native action recovery controller's optional synchronous authority callback
guards new signing while retaining exact-first-final reconciliation after expiry.

These additions do not complete the durable buyer: full delivered-result custody,
its orchestration, application material validation and end-to-end reference flows
remain required. They neither widen the four-MiB wire bounds nor alter existing
AuthFetch payment defaults, operation-store schemas or unguarded wallet callers.

### Immutable original-operation object custody

The protected control-state target is locally qualified at `012def997`: 410 of
430 mutants detected (95.35%), zero uncovered/invalid and all 10,213 frozen inputs
unchanged. The preceding failures remain retained. The 166 canonical tests also
verify cleanup on rejected decrypted buffers; the two regressions fail before
that fix. This local result does not replace final hosted qualification.

The new operation-object owner retains large original requests, selected
contracts and delivered results with distinct role bindings, complete logical
reservation and immutable first bytes. Native storage composes the existing
protected ledger; browser storage uses a dedicated encrypted inventory and atomic
chunk commits. Canonical integration passes all 402 selected tests across 16
suites, including 300 generated histories for each backend and four native
process kills. The exact packed browser fixture passes four-MiB wallet
encryption, whole-browser restart and cross-tab arbitration. Packed exports and
types, all 49 compiled examples from 22 exact tarballs, all existing and new
browser-entry budgets, and root health/lint/format/type checks pass. Complete
mutation and exact-head hosted qualification remain unfinished.
Existing operation and protected-control exports, budgets and formats are
unchanged. The durable buyer, material adapters and full acquisition demonstration
remain separate unfinished work.

### Boundary qualification follow-up

An independent generated run exposed an oracle error for a retry of the initial
protected workflow value: the exact value already retained at revision one must
be recovered as `replayed` from revision zero. The implementation behaves correctly.
The generated model now distinguishes this exact replay from other stale writes,
with an explicit deterministic example. The original failing seed
`-273856364`, path `12:2:2:2:2:2:0`, passes after the model correction. The earlier
object mutation campaign was stopped with unchanged inputs; it remains incomplete
and does not establish qualification.

Additional object framing and custody tests exercise retained headers, chunk
bounds, exact digests, inventory ordering, full capacity, capability drift and
plaintext cleanup. Complete byte equality for large binary fixtures uses native
byte comparison, preserving every byte and the existing deadlines.

Current-channel parsing has explicit head and removal paths with the same wire
grammar, plus independent maximum-size, policy, chain and state-binding cases.
Runtime work creation and its awaited race share one lifecycle scope. The previously
crashing block-removal mutation now produces ordinary test failures in an isolated
run, while normal behavior passes. Complete canonical mutation and hosted
qualification for these changes remains required.

Canonical follow-up validation passes 618 tests across 24 suites, the complete
112-test UHRP suite, and root health, lint, formatting and strict types. The UHRP
suite completed in 21.3 seconds locally with the original test deadlines. This
local result does not establish hosted Linux completion. Mutation qualification
will use the corrected replay model and preserve all prior targets and gates.

## Durable buyer composition, 2026-10-02

The optional `private/buyer` entry now retains original capability/request/suffix,
reserves five complete protected immutable objects before financial effects, and
uses separate encrypted workflow control. `open` verifies existing originals;
`recover` reconciles only original wallet and unpaid seller status. Explicit
`advance` authorizes the original payment and rechecks its deadline/current access.
First delivery is retained before independent evidence/material validation;
received, validated and usable stages remain distinct. Current usability and
control revision are rechecked before material is returned to an application.

`WalletToolboxBuyerPayment` composes the existing durable local noSend action
controller through an additive read-only configuration descriptor. The installed
wallet/storage/network/originator and derivation wallet must match independently
selected bindings. One stable action ID retains exact signed BRC-105 payment
bytes; recovery never prepares or signs, and neither adapter broadcasts. A lost
prepared/finalized reply remains the same action. Current authority is checked at
new preparation/signing boundaries, while existing finals remain recoverable
following expiry. The actual wallet controller's existing behaviors remain intact.

Native checks passed 21 controller tests and 11 buyer/payment tests, including
cancellation holding physical capacity, shutdown drain, changed capability refusal,
revoked validation access, retained prepared allocation and exact-final recovery.
The governed buyer model passed 300 histories with seed 3242026 plus three encrypted
CAS lost-ack boundaries (four property tests, 78.728 seconds). Its earlier generated
counterexample exposed an overly narrow test expectation after an already usable
result was advanced again; the corrected model and deterministic regression
require usability to remain preserved. The production stage behavior was unchanged.

The complete `PrivateBuyerHTTP.integration.test.ts` uses native buyer and seller
wallets, actual authenticated HTTP and encrypted custody, loses the first delivery
reply after one credit, reopens, recovers unpaid after expiry and independently
checks the listing/payment through Script/SPV before usability. This is synthetic
loopback evidence, not TLS, broadcast, mining, LCH playback or covenant acquisition.
The generic domain policy fixture is explicitly synthetic. Concrete BRC-198
material and covenant/POTATOES flows remain subsequent integration work.

The optional browser entry excludes Node/native storage and seller coordination.
Exact-tarball graphs measure Vite 532712/139158/116367 and esbuild
412901/127650/109218 raw/gzip/Brotli bytes, with independent rounded limits retaining
at least 10% headroom. All previous budgets are preserved. Packed conditional
exports and 50 compiled examples pass. The additive critical whole-source target
`private-lookup-buyer` and its property registration increase this branch's inventory
from 120 to 121; complete aggregate 90%/zero uncovered/invalid qualification remains
required. The peer #757 acknowledged the exact shared registry and wallet descriptor
ownership. Preserve the final union when reconciling its independent wallet targets.

Four guides now carry required site metadata. Overlay Express scripts now launch
Jest with its required ESM runtime flag, addressing hosted suite compilation failures;
complete host coverage is being verified. Hosted head 0431bdb62 still has unresolved
Sonar findings and failed package coverage. Main advanced through dependency PR #734,
which must be reconciled without weakening any existing gates or first-party contracts.
This increment is not checkpoint-two completion; the acceptance inventory remains
its explicit end-to-end authority.

Full host coverage exposed legacy hoisted CommonJS mocks alongside private ESM
fixtures. A shared project factory now partitions the unchanged complete selected
suite union into ordinary CommonJS execution and private ESM execution. Both use
the original TypeScript import-resolution settings; their extension/runtime modes
preserve the respective mock semantics. Ordinary scripts and all host mutation
registrations use those same projects. Discovery lists 45 distinct suites, each
exactly once. A no-cache smoke run passed 163 tests across legacy Overlay Express,
lookup properties and the complete native private buyer HTTP flow. The expanded
root inventory checks passed 83 tests. Full host coverage remains in progress;
the earlier failed runs remain diagnostic evidence and are not qualification.

The first full mixed-project run also exposed transform-cache collisions between
ESM and CommonJS source executions. Independent project cache directories now
keep their emitted module formats separate. The six affected ordinary/private
suites passed 214 tests with coverage using independent caches. A repeated warm
cache run checks that cached compilation preserves the same actual constructors,
SDK mocks and private HTTP behavior. Full campaign evidence remains pending.

### October 2 upstream reconciliation and host module qualification

The branch reconciles main `226e82e4a` (dependency maintenance and PostgreSQL
wallet storage) without replacing the independently owned wallet work. The
existing brace-expansion 5.0.12, OpenSSL package 3.5.9-r0 and DOMPurify 3.4.16
floors remain. pnpm generated the lock, including the main toolchain's peer
resolution and the reference application's matching Vitest 5 runner. To select
the existing DOMPurify remediation within Mermaid 12's allowed range, pnpm
temporarily selected it as a direct development dependency, then regenerated
the lock after restoring the incoming manifest. No direct dependency or new
override remains. The retained bundle inventory and its evidence digest agree.
Frozen installation, high-severity advisory audit and third-party license
validation pass.

The complete Overlay Express coverage run passes 45 suites and 862 tests
against the final installed graph, after repeated focused warm-cache runs of
214 tests. The upstream ts-jest 29.4.12 compiler fixes its changed-module-kind
program reuse; the legacy CommonJS and private ESM projects retain separate
caches, all selected tests, assertions and type diagnostics. The updated Jest
types require correctly typed public-key mock signatures. No tests, assertions,
coverage gates or mutation gates were removed. Wallet-toolbox and Overlay
Express builds and 58 dependency/container/mutation/release contract tests
also pass. This reconciled step does not complete checkpoint two's domain,
covenant, root and workbench integration or exact-head hosted qualification.

### October 2 buyer domain preflight and BRC-198 codec foundation

Buyer policies now provide mandatory original-domain/challenge preflight before
new quotes, wallet planning/preparation and paid dispatch. Arguments are owned
copies; current installation, access and deadline checks repeat after each await.
Recovery of original already-funded obligations does not depend on new Offer
eligibility. Sixteen buyer/native tests, actual buyer/seller HTTP recovery, and
300 generated interruption histories with lost-CAS acknowledgements pass.

The optional LCH overlay-acquisition entry adds exact CBOR/JCS codecs and
BRC-197 collector state checks. It preserves ordinary BRC-170 imports and
CORE_CAPABILITIES. Context remains explicitly unverified: representation and
budget checks alone do not authenticate a License or authorize playback. Full
domain preflight, typed role/authority verification, independent settlement and
content/key validation, issuer composition and end-to-end playback remain next
steps, together with the other unchecked checkpoint-two workflow rows.

The subsequent optional fixed-render/direct-collector paid domain authenticates
complete original consent and finite role authorities, concrete ODRL compensation,
independent buyer-side BRC-29 Script/SPV funding, selected listing/release evidence,
exact License rights and recipient-bound BRC-78 grants. Two protected native SQLite
slots retain original terms and the positive verification receipt. Actual licensed
playback survives close/reopen and Offer expiry; equivalent License reissues retain
the same rights, Agreement and settlement basis while using new signatures and key
encryption randomness. Later playback reauthenticates the representation without
repeating online proof calls. Fingerprints alone never authenticate a License.
The new public entry uses a minor LCH candidate and a whole-source mutation target;
ordinary imports and CORE_CAPABILITIES remain unchanged. Complete seller issuance,
HTTP/workbench and covenant demonstrations and final campaigns remain open.

The complete LCH package passes 24 suites/188 tests and its unchanged coverage
gate (96.74% lines, 89.23% branches). Strict types, lint, clean packed ESM/CLI
consumers and both exact-tarball browser entries pass. The optional acquisition
graph measures Vite 274296/81388/69343 and esbuild 230529/77657/68092
raw/gzip/Brotli bytes, one chunk and only LCH/SDK, with separately rounded 12%
headroom. The ordinary entry's limits remain unchanged. Buyer/funding regression
qualification passes 28 tests across four suites, including 300 generated
interruption histories. The actual authenticated HTTP test now independently
derives and verifies the funding output with the buyer wallet, without seller
private-key access. These local checks do not complete full mutation or exact-head
hosted qualification.

### October 2 concrete LCH seller and authenticated native recovery

The optional LCH seller implements the protected acquisition coordinator's domain
port with complete original consent, finite authority and CEK validation before
money. Its bounded private material is retained with the quote. Issuance checks
actual accepted funding, independently reconciled original native credit and live
release assessment, then signs the settlement, derived Agreement and persistent
recipient-bound License. Public output context contains encrypted BRC-78 grants,
never raw CEKs. Original funded rights survive catalogue withdrawal and Offer
expiry; unresolved credit or reversed issuance chronology refuses delivery.

The full disposable HTTP integration passes with mutual BRC-103 authentication,
actual native buyer allocation/signing and seller credit, buyer-side Script/SPV
verification and AES-GCM playback. It loses the paid reply after seller commit,
reopens native buyer action recovery plus protected control/object/LCH custody,
then recovers unpaid after expiry and catalogue withdrawal. Exactly one payment
header and one native seller credit remain. The fixture never broadcasts and does
not qualify TLS or production funding. A shared 256-actual-signature assessment
budget now covers original terms, delegation and License, with separate preimage
and signature commitments so ambiguous concatenation cannot share a cache entry.

The prior published head fa0eb52db has no pull-request Actions run because GitHub
reports a conflict with the subsequently updated main. Exact-head qualification
and the remaining checkpoint inventory remain open; older successes and deferred
mutation checks are not completion evidence.

The completed local seller batch passes 26 LCH suites/195 tests and the unchanged
coverage gate, four seller issuance/recovery regressions, both actual authenticated
native HTTP flows, strict LCH/host types, clean packed ESM/CLI consumers and both
exact-tarball browser entries. Seller funding verification uses the seller wallet;
the buyer independently verifies with its own wallet. The optional graph now
exercises both domain exports within its original limits (Vite 291340/85112/72576;
esbuild 244336/81043/70961 raw/gzip/Brotli). The ordinary entry limits are unchanged.
All eleven optional source modules and their complete test union remain in one
whole-source mutation region; the current branch registry remains 122. Main
2d64fcd3d is reconciled locally, retaining the branch's actually generated bundle
evidence hash. Full mutation, zero-new source findings and exact-head hosted
qualification remain pending.

### October 2 source-quality and complete recovery qualification

The next quality batch extracts the existing new-signing guard and guarded
unlocking-template wrapper into local helpers, preserving every guard invocation,
script result, async boundary and telemetry span. The buyer and acquisition
coordinator retain serial phase execution, exact BigInt times, immutable first
results, unknown credit outcomes and bounded CAS retries. Protected SQLite methods
perform native work and input ownership synchronously while preserving Promise
rejection semantics. IndexedDB ciphertext work remains outside the transaction;
abort/quota outcomes retain their prior meanings. Canonical ordering explicitly
uses code units, independent of host locale.

Native process fixtures receive bounded jobs over IPC and refuse non-fixture
locations, alternate filenames, symlink escapes and oversized input before opening
a database. The six actual SIGKILL phase cuts remain. Local qualification passes
139 recovery regressions, 70 boundary/property tests including the complete
300-case buyer, coordination and object histories, 22 authenticated HTTP cases and
ten actual process/input-boundary cases. These are component evidence, not final
checkpoint or mutation evidence.

The published 92825f86 source passes hosted build/policy/conformance, packed
consumers, native wallet and browser jobs, but has 107 new Sonar findings and a
host publication property timeout under full parallel coverage. Local quality
changes address those findings without removing cases or extending deadlines.
A complete two-worker host coverage measurement passes all 46 suites/863 tests
in 82.064 seconds; the same complete serial union passes in 150.743 seconds.
Coverage now runs in one process to isolate the authenticated 300-case property
from competing coverage workers. This trades total local wall time for consistent
per-test access to the runner; all suites, cases, coverage collection and 90-second
property deadlines remain unchanged. Exact-head hosted proof is still required.

Detached seller source qualification adds actual source reads before quotation,
retained-material validation and issuance, followed by independent buyer License
verification and authenticated playback. The same complete LCH coverage campaign
now passes 26 suites/201 tests. Five negative source schedules refuse a new quote
before credit. The native signing/recovery suites pass 42 tests, and the exact
packed browser runtime passes real Chrome IndexedDB/page/process restart,
cross-tab CAS, protected custody and immutable four-MiB object retention. These
changes preserve ordinary embedded-content behavior.

Main 5c92262e4 (#629) is reconciled, preserving its MessageBox payment-outcome
contracts, tests, release notes and maintenance baseline. The sole generated API
migration conflict is rebuilt from the combined manifest/release registry instead
of choosing one branch's text. All four mandatory root gates and the clean packed LCH/CLI/browser checks pass.
Exact-head hosted quality and full mutation remain required.

### October 2 serial work and exact JSON fences

Published ca935dc98418d7f9ad7e28143ad5fd2fed9df17b passes conformance,
container validation and CodeQL. Sonar reports 34 remaining source findings;
its zero-new gate fails. Host coverage still times out in the complete 300-case
private-publication signing property under its existing 90-second deadline,
even with serial execution. Neither result is a completed checkpoint.

The next batch replaces synchronous-collection `for await` loops with explicit
serial Promise chains. Each original validation, physical await and current-owner
check remains. Acquisition CAS conflicts continue at the next bounded attempt;
unknown money outcomes still stop progression. Both reconciliation workers use
a genuinely asynchronous, abortable timer iterator that starts the next delay
only after the prior pass drains. No queued interval ticks accumulate.

Browser transaction aborts preserve the original local Error and retain a
foreign-realm Error as the cause of a local rejection. Twenty object-store cases
pass, including whole-transaction rollback, absence of a phantom reservation and
subsequent retry. Complete native buyer/coordination/object property and boundary
qualification passes 70 tests in five suites (192.051 seconds), with every
300-case history retained. The native process, wallet and recovery regression
union passes 112 tests in ten suites. The complete LCH union still passes 201
tests in 26 suites. Actual packed Chrome qualification passes strict CSP,
native IndexedDB, page/browser restart, cross-tab CAS and protected immutable
four-MiB custody after the serial-work changes.

A CPU profile of the full private-publication property identifies repeated
canonical JSON checks and UTF-8 array allocations as major work. The SDK JSON
implementation now avoids allocating encoded arrays for printable ASCII chunks
and detects lone surrogates with a Unicode-mode range: a valid surrogate pair is
one code point outside that range. The wire bytes, exact UTF-8 limits, duplicate
key checks, own-data restrictions and signature verification remain unchanged.
Additional independent TextEncoder-oracle properties cover scalar boundaries
and escaped controls; all 2,048 lone high/low surrogate code units are refused,
while valid boundary pairs remain accepted. The complete local host coverage
campaign passes 46 suites/863 tests in 139.252 seconds, preserving the original
90-second publication property deadline. Exact-head hosted qualification must
still verify this batch. No deadline, source union, case floor, coverage threshold
or mutation requirement is changed.

Main 729ad70e0 (#764) is reconciled before the next reference integration. Its
full-campaign parallelism, zero-test survivor rejection, scoped Vitest 4.1.11
holds and protected same-run release orchestration remain intact. The only merge
conflict is this branch's older container-guide metadata; the current main
version/date is retained with both branches' substantive guide content. This
reconciliation does not authorize a release or claim full mutation qualification.

### October 2 admission-backed two-host reference workbench

The reference application now optionally installs a real topic manager, Engine
and retained Mongo admission history. Engine verifies the fixed public synthetic
transactions with Script/SPV before the producer projects their stored outputs
into its durable lookup index. The producer binds each stored subject transaction,
script and value to its original complete fixture ancestor closure and independently
verifies that closure. A point output read alone is not a complete BEEF guarantee.
The fixture publishes two bounded live groups, preserving the clients' negotiated
two-observation maximum rather than splitting an atomic commit during delivery.

An original command is saved before admission. Retained admission is recovered
after an uncertain Engine reply; projection is repaired after an uncertain SQLite
reply without choosing another command or repeating a committed live group.
Separate majority Mongo and WAL/FULL SQLite commits are explicitly not atomic.
Physical work drains before its owner releases the command store, including every
started projection read after one fails. Opening a missing command namespace or
Mongo ownership marker refuses replacement custody. The explicit loopback-only
installer creates no broadcast, payment or GASP traffic.

All five application suites pass 18 tests, including nine real Mongo/SQLite
admission, recovery, bounded ownership and progressive/live restart cases. Both
native Chrome profiles pass: the original direct-fixture producer and the actual
admission producer. Each starts two authenticated hosts and two clients, verifies
live Script/SPV evidence, closes an offline client's tab, resumes its committed
IndexedDB cursor, and preserves verified spend knowledge while source-local
membership changes independently. Actual admission refuses resurrection of the
known spent predecessor. Both wide and narrow application views are captured and
the narrow view has no horizontal overflow. These public fixed-chain workflows do
not qualify production TLS, funding, private purchase or non-final proposal UI.

The optional LCH authority validator delegates each existing controller/path check
to a local helper, reducing nested callback depth while preserving sequential
signature/revocation validation. Its 20 authority, paid-domain and seller regressions,
strict types and clean packed ESM/CLI consumers pass. The previous published
84656bbe6 head has one remaining new Sonar finding addressed by this extraction;
the new batch still requires exact-head hosted qualification and complete mutation.

### October 2 exact prepared purchase composition

The additive `RevenueListingPurchaseVerifier` composes the complete BRC-196
original request and authenticated seller terms with BRC-197's executable family,
authorized genesis, both-parent lineage and Bitcoin evidence. The prepared domain
uses the exact registered profile/schema and JCS lineage bytes. A purchase must
consume the selected predecessor at input zero and reproduce the exact successor
and recipient/acquisition/request-bound receipt. Independent verification runs
the covenant even when the purchase carries a mining proof. A signed preparation
for another recipient or request cannot turn a valid payment into its entitlement.

The complete verifier union passes 19 tests, including 300 generated valid
alternate-preparation refusals. Coverage measures 100% statements, functions and
lines and 97.14% branches. An actual purchase after unanimous revenue amendment
passes; missing declared genesis remains unresolved, and a wrong prepared receipt
fails before chain I/O. The fixtures use disclosed synthetic funding, actual
transaction signatures and Script validation. They do not establish a native
wallet-funded purchase, admission, release, current unspentness or playback.

The clean package check includes the new optional export and its declarations;
all 30 compiled examples pass against eight exact tarballs. The verifier has one
complete critical mutation target, preserving score 90, zero uncovered/invalid/
unexecuted requirements, four workers, the 300-case floor, replay controls and the
complete-campaign-only policy. Named local mutation feedback and hosted checks
remain pending qualifications rather than completed checkpoint evidence. The
three new analyzer findings on published 4f1a57515 are addressed without altering
the workbench's input, ownership or shutdown semantics.

### October 2 original private purchase custody and admission time

The native private-service entry now exposes the BRC-196 preparation contracts,
progress model and AEAD SQLite purchase store. It reserves the original signed
request, terms, policy/material custody, permanent request fence and future
candidate/result capacity before returning payable terms. Guarded preparation
and result disclosure read protected originals while the physical ledger gate
is held. Late disclosure cannot issue new payable terms after the original
exclusive cutoff. One transaction remains pinned across retries; a lost commit
reply, expiry or absent database cannot select a replacement obligation.

The complete application batch passes 132 tests in eight suites in 117.871
seconds, including three separate 300-case property suites. The native state
property actually closes and reopens SQLite across generated interruptions.
The focused store and complete purchase-verifier union passes 54 tests with
100% statement, branch, function and line coverage for both modules. Preparation
and progress primitives were also measured with complete coverage. These are
component results, not a completed topic-submission/release coordinator.

The purchase verifier now returns bounded local protocol diagnostics while
preserving its qualified result status and dependencies. Specific tests exercise
original request/recipient/terms binding, executable purchase routes, complete
classic BEEF, missing ancestors, caller work limits and cancellation. The previous
whole-source mutation diagnostic failed at 61.68% with 62 surviving and two
uncovered mutants; it remains failed evidence. Its workers have drained. The
stronger assertions still require a fresh complete-source diagnostic and the
final complete campaign; no gate or source selection is relaxed.

Actual revenue purchases exposed an arbitrary 64-KiB inner decoding limit in
release validation. Removing that inner limit preserves the selected caller
byte budget and the existing 131072-byte complete release envelope. An actual
signed covenant purchase larger than 64 KiB now verifies against independently
checked synthetic headers, while a smaller caller budget and changed context
remain refused. These fixed public fixtures do not establish live mining.

Retained Mongo admission now supplies optional original server-commit time as
local metadata. Ordinary receipt bytes and legacy projection stay unchanged.
The stronger timed projection requires this provenance and binds its assessment
to that original time; a later recovery clock cannot manufacture it. The complete
proposal/private-admission and native Mongo receipt/history union passes 181
tests, including both complete shared-helper consumers. Neither admission time
nor STEAK establishes a release condition or permission to disclose a key.

The clean package consumer check passes for the new native exports; all 52
compiled documentation examples pass against 22 exact package tarballs. The two
new complete critical registrations bring this branch's inventory to 125,
retaining full source/test unions, 300-case floors and full-campaign-only policy.
All checkpoint-two end-to-end rows remain open pending their own composition
and final published-head qualification.

### October 2 staged purchase coordination and authenticated transport

The complete whole-source listing-purchase diagnostic now passes 93.60%: 161
killed and 11 surviving mutants, with zero uncovered, invalid or unexecuted
mutants. It ran all 42 selected tests and all 172 mutants in 34m36s. The earlier
61.68% receipt remains failed evidence. This named diagnostic is component
feedback; final qualification still requires the complete current campaign.

The native coordinator separates preparation, independent candidate verification,
one admission intent, actual retained admission, separate release assessment and
first-result issuance. Current original-intent guards reach the admission port
before external effects. Private access matches recipient ownership before
reading original chunks. Physical disclosure checks the current native head,
exact signed response, original selector and current permission after HTTP
signing. Outstanding canceled work occupies its physical slot until it settles.

The native coordinator/disclosure/property union passes 32 tests including two
300-case histories in 67.408s with targeted coverage: 97.11% statements, 95.20%
branches, 94.36% functions and 98.26% lines. Three further tests pass for a
concurrent native admission writer and returned authority promises. The actual
selected-host admission adapter passes its complete 19 tests/300-case retained
history suite. Actual BRC-103 HTTP middleware and native custody pass 21
purchase/host tests, including 300 generated malformed request/selector refusals,
delayed release, revoked physical disclosure and legacy route preservation.
Lifecycle/domain fixtures remain controlled and do not establish Bitcoin truth.

Four explicitly acknowledged complete critical source/property registrations
bring this branch's inventory to 129. All previous unions, zero uncovered/invalid/
unexecuted requirements, score90, four workers, seed3242026, deadlines and the
300-case floor remain. Optional package exports and compiled composition examples
are being qualified. No checkpoint-two acceptance row is completed by these
component results alone.

Successful BRC-77 mathematics and valid canonical curve points now have bounded
process-local caches. Packet schemas, canonical preimages, full signatures and
selected signers are still checked on every call. Private bodies and authorization,
expiry, policy or chain-currentness verdicts are never retained. Protocol/retained
capability tests pass 63 cases. The previously failing 300-case acquisition
property completes in 60.647s under coverage without changing its deadline; the
partial-only coverage invocation itself does not meet whole-package percentage
thresholds. Full package/hosted coverage and exact-head CI remain required.

## Standing Offer consent and frozen covenant terms, 2026-10-03

Published native/HTTP purchase composition at `79807477c` after all four root
gates passed; remote SHA matches. The exact-head hosted run is blocked by the
new high braces advisory in the unchanged mobile Metro graph. The dependency
owner is qualifying a narrowly scoped removal of that closure; no audit waiver
or dependency mutation was applied here.

The optional LCH entry now authenticates the critical E/C/S standing Offer,
individual signed Request, exact seller/anchor/Asset/Offer/initial revenue,
registered family and administrative rules, installed topic mechanisms and
release policy. Its derived Agreement binds the individual buyer while the
Offer and descriptor remain unchanged. Frozen original purchase promises retain
the maximum of one day, advertised recovery and the Offer recovery period.
Paid and covenant adapters share accepted-policy/human-term/mechanism and exact
Request-byte checks; ordinary BRC-170 imports and capabilities remain unchanged.
These terms stages do not substitute for complete Script/lineage, role,
release, License or key validation.

The complete LCH coverage selection passes 211 tests/29 suites in 23.106s,
with 96.30% statements, 89.96% branches, 94.69% functions and 97.26% lines.
The complete optional cryptographic selection passes 54 tests/11 suites,
including two 300-case properties; new terms/consent measured coverage is
99.12% statements, 94.05% branches and 100% functions/lines. The initial focused
selection lacked human-term/mechanism coverage and failed its function floor;
meaningful consent and mutation-during-await tests now cover those paths. A
foreign-realm structuredClone test fixture was corrected to use real decoded
CBOR ownership. The initial property registration used the wrong replay names;
its corrected test honors all governed FAST_CHECK controls and the 300 floor.
No score, source union, deadline or coverage threshold changed.

All 55 compiled examples pass against 24 exact tarballs; the LCH packed ESM,
strict types, referenced maps, publint and installed executable pass. Its
ordinary browser graph remains byte-identical; the optional entry, including
all covenant terms exports, measures Vite 304150/88392/74500 and esbuild
254925/84162/72781 raw/gzip/Brotli bytes. Both retain one LCH/SDK chunk and pass
every existing byte ceiling unchanged. No Node/native custody enters the graph.
The exact ACKed critical inventory is now 130, with complete prior LCH, wallet
and host source/test unions retained. Named/full mutation qualification remains
required; these unit/coverage/browser receipts do not establish it.

Complete application coverage v2 exercised 3062 tests/213 suites in 888.867s
with 97.93% statements, 96.26% branches, 98.17% functions and 98.60% lines. One
legacy repeated-mathematics assertion failed. It now checks reopened native
request bindings and rejects persisted signature tampering, including repeated
negative checks; all 13 cache-boundary regressions pass. The complete current
application gate is being rerun. The earlier failure remains a failed receipt,
not a qualified whole-package result. Covenant licensing/buyer orchestration,
actual complete reference flows and the final campaign/hosted C2 gate remain open.

The first covenant-terms mutation invocation failed before its test dry run:
Stryker parses its build command without a shell and passed the literal `&&`
to TypeScript. Both LCH target registrations now invoke one package script
that sequentially builds the application prerequisite and LCH. The complete
source/test union and every qualification gate remain unchanged. This failed
startup establishes no mutation coverage or score; the complete campaign remains
required after the remaining implementation is composed.

### Portable covenant settlement, exact License and protected buyer entitlement

The next optional LCH increment implements the full buyer-side standing-collector
C domain in a separate `@bsv/lch/overlay-covenant` entry. The portable decoder owns
closed JCS lineage packages, authenticates their signed genesis commitments and
binds original seller-signed preparation, exact descriptor, buyer, request,
predecessor/successor, price and release evidence to the signed settlement and
STEAK/POTATOES context. Representation and collector signatures remain separate
from actual Bitcoin and authority verification. Paid and covenant domains share
the original complete License, Agreement, historical role, typed authority and
recipient-key checks; the paid profile and ordinary core capabilities are unchanged.
Internal BRC78 recipient recovery is extracted from the existing delivery class
without changing its constructor, delivery, recovery or cryptographic rules.

`LCHOverlayCovenantDomain` retains complete original consent and a protected local
positive verification receipt. Preparation requires independently installed full
lineage verification before wallet construction. Purchase material requires actual
full Script/lineage and selected release verification before License/key checks and
receipt commit. Guards must be owned synchronous functions and remain current after
key recovery. Public preflight and verification own their input bytes before the
first asynchronous boundary. Playback checks current access before decoding private
material and can reopen verified original rights after Offer expiry without a new
purchase or online proof. Equivalent signed reissue changes neither rights nor the
historical settlement; encrypted grants are authenticated again on each use.

The complete LCH run passes 234 tests in 35 suites in64.165seconds, with96.65percent
statements,90.40branches,95.71functions and97.56lines. Covenant domain, both
entitlement implementations, common License and recipient recovery have no uncovered
statements. Tests execute complete disclosed synthetic genesis and purchase
transactions using the actual family and easy-work chain, actual signed settlement,
License/Agreement/BRC78 grants, encrypted SQLite reopen and real AES-GCM playback.
They cover separate issuer/key-releaser delegations and retained role assessments,
wrong signed commitments, changed custody and installations, invalid asynchronous
verification guards, detached ciphertext limits and access loss, and mutable caller
inputs. Three separately registered properties each exercise at least300seeded
settlement substitutions, signed License substitutions or native entitlement histories.

Initial native fixture attempts failed because the funding snapshot lacked explicit
empty unlocking scripts, genesis incorrectly began above reserve, and a signing
transaction accessor omitted the anchor's actual merkle proof. The corrected fixture
satisfies the unchanged verifiers; no Script or evidence guard was weakened. A
source-boundary test initially used embedded ciphertext and therefore did not invoke
its source. It now uses detached ciphertext and changes the response only after
read-only reopen. The first lifecycle property hit its150second ceiling at195cases;
complete retained-receipt histories and fast currentness refusal now preserve the
300case floor and original deadline, with explicit authenticated endpoint playback
and separate reissue/corruption cases. No temporary shared mathematical cache was
retained. Failed and superseded runs are not current qualification evidence.

The exact shared registry ACKs retain all prior source/test selections and add three
whole-source critical settlement, License and covenant-buyer regions. Actual branch
inventory is133. Complete existing key-delivery tests and imported revenue fixture
archives are appended to the inherited LCH unions. No thresholds, deadlines, case
floors, worker limits or complete-campaign requirements change.39registry regressions
pass. Packed payload, conditional exports, source maps, strict consumer types, CLI,
all56compiled examples against24exact tarballs and the independent browser entries
pass locally. The reference app adds only the existing LCH/wallet workspace links;
structural lock comparison preserves every unrelated importer, resolution and setting,
and the frozen offline installation passes.

These buyer tests construct disclosed synthetic funding directly. Complete native
wallet purchase ownership, concrete seller issuance, actual topic-admission/release
recovery and the combined operator/application demonstrations remain required. So do
all root/non-final/contradiction workflows, the complete affected mutation campaign
and successful exact-head hosted qualification. Checkpoint two remains open.

### Concrete covenant seller and retained candidate issuance

The optional `LCHOverlayCovenantSeller` implements the installed private purchase
seller port. It owns complete private Header/Offer/Request, finite authority paths
and committed content keys before promising delivery. It requires independent
complete genesis/lineage verification at preparation and complete actual purchase
Script verification before admission or issuance. A separate locally installed
release verifier supplies the selected release guard. Settlement, License,
Agreement and BRC78 recipient grants are issued only under those still-current
proofs. Catalogue withdrawal and Offer expiry do not erase the original recovery
obligation. The coordinator passes an owned copy of its exact retained candidate
as an optional fifth issuer argument; existing four-argument issuers remain
compatible. No transient candidate cache or reconstructed payment is used.

Preparation derives complete finite future response capacity from advertised
request bounds, retained lineage, authority paths, Agreement and keys. It refuses
an installation that cannot deliver within the selected response and protected
secret bounds before any financial effect. The concrete example advertises a
512KiB request and4MiB response; it does not claim that every4MiB request can fit
inside a2MiB private context. Repeated recovery returns the coordinator's exact
first retained result, rather than asking the issuer to create a replacement.

Full current LCH coverage passes244tests/37suites in76.261seconds. The entire
seller has191/191 statements,46/46 functions and74/75 branches exercised. Its
unit/property coverage includes real disclosed synthetic genesis/purchase Script,
independent release validation, original capacity reservation, changed installations
and mutable inputs, historical roles, access loss, Promise-guard refusal and
actual encrypted native buyer playback. The initial governed property check
rejected missing replay controls; the corrected suite supports FAST_CHECK_PATH,
seed and the minimum300cases under its unchanged60second ceiling and passes.
All84 combined registry/dependency governance tests pass at the exact ACKed134
inventory, retaining every prior133 source/test union and qualification gate.

Coordinator units and its complete300case native lifecycle property pass22tests
in44.269seconds, including mutation of the owned fifth argument without modifying
original native custody. The existing actual wallet demonstration independently
passes all six covenant routes in32.106seconds, with exact remainder retention,
all-recipient amendment consent and final payout top-up. It uses an isolated local
wallet and no broadcast; that component result is not selected-chain/SPV proof of
the combined wallet/host composition. Source typing/lint, LCH packed exports and
strict consumers, browser ceilings and57compiled examples against24exact tarballs
pass. Five hosted fixture style findings are corrected without changing ordering.
Complete mutation, durable wallet-backed C buyer, actual admission/HTTP/release
composition and remaining full reference demonstrations still remain required.

The separately reviewed exact Metro-file-map0.87.1 paired watcher repair is
incorporated froma7ceefb86 without adopting unrelated wallet capture or mapper
changes. Independent graph comparison preserves all43 current importers/settings
and1631 retained package records, adds no version, removes only five unused matcher
packages, and changes only file-map/Metro snapshots. The patch hash is
28741c2833798bbfda1432bd62f13f338d31f12a6161f4268a6cc6f01022018b.
Frozen offline installation and a fresh unexcluded high-severity audit pass;
all1120 actual installed watcher/path/event/stat oracle cases pass. The current
packed mobile gate passes unchanged ceilings at Metro2328360/616783/471694 and
Hermes4793129/2003779/1563017 raw/gzip/Brotli bytes. An initial standalone watcher
invocation resolved from the mobile package instead of Metro and failed before
validation; the corrected actual Metro resolver and full platform gate pass.
No audit exception, lowered threshold, release, deployment or device qualification
is implied. Checkpoint two and successful exact-head CI remain open.

### Durable covenant buyer and native purchase ownership

The optional SDK `OutputPurchaseTransport` owns the original selected capability,
request, terms and submitted candidate across finite authenticated prepare, submit
and recovery calls. Recipient identity checking runs inside the existing finite
HTTP deadline. HTTPS, mutual authentication and original seller/chain/topic
bindings apply; these requests never initiate an HTTP payment. Existing finite
lookup, paid lookup and proposal/root transport behavior remains compatible. The
complete prior and new transport union passes 225 tests; its separate 300-case
property suite and strict declarations pass.

`PrivatePurchaseBuyer` retains six pre-reserved protected objects and a bounded
control journal. It reconciles the original wallet action before permitting new
work, retains the signed transaction through the original recovery promise, and
separates receipt, independent validation and current usability. Unknown or
unsupported wallet outcomes remain unresolved. Lost object and control replies,
concurrent completion, asynchronous guard refusal and physical cancellation drain
are exercised. Retained usable rights can be read while the wallet is unavailable.
A missing original owner never causes a replacement request or transaction.

`WalletToolboxPurchasePayment` independently verifies complete genesis and lineage
before original native allocation and signing. It constructs the permissionless
covenant purchase using the real recoverable action controller with `noSend`,
checks the entire future submission capacity before signing, and recovers the
original finalized bytes after native restart. The original declared capacity and
wallet/storage/chain configuration cannot be widened by mutating public fields.
The native example explicitly installs the existing one-change-output policy and
disables migration funding; older examples and wallet defaults are unchanged.
Unsupported layouts leave a recoverable prepared action, requiring the documented
explicit operator policy rather than automatic abort, refund or broadcast.

Both full implementations have 100 percent focused statement, branch, function
and line coverage across 31 tests. The current protected buyer property passes
300 generated native interruption histories in 90.3 seconds. A separate property
independently verifies one actual signed purchase, then exercises 300 freshly
reopened native recovery histories in 70.146 seconds, requiring exact original
bytes and one allocation/signature without broadcast. Earlier attempts to create
a new funded fixture per history exceeded the unchanged 150-second limit at
145 and 156 cases; those runs are failures. The final property changes its
meaningful subject to original-operation recovery and retains its 300-case floor,
seed/path replay and original deadlines. These disclosed synthetic-chain tests
establish native ownership and Script/history behavior; topical admission and
authenticated LCH playback composition remain separate acceptance work.

The original `private/buyer` entry is byte-identical to the preceding commit.
Generic covenant orchestration and native construction have separate optional
`private/purchase-buyer` and `private/purchase-wallet` entries. Combining them in
the old or new single namespace initially exceeded the unchanged 590000-byte
ceiling at 625705 and 592837 bytes. Separate complete packed browser graphs now
pass the existing ceilings without a budget increase and exclude Node and paid
owners. All conditional exports, source maps, publint and strict clean consumers
pass. The guides compile 59 examples against 24 exact packed tarballs.

Exact peer registration agreement adds two whole-source critical regions at the
derived 137 inventory, preserving every earlier source/test union and wallet
maintenance part. The complete new C unit/property/native fixture closure joins
the original paid buyer selection. The complete original paid and new C buyer union passes 53 tests across seven
suites in 215.047 seconds, retaining all three independent 300-case properties.
No source partitions, threshold changes,
case-floor reductions, deadline increases or campaign-policy exceptions are used.

### Reviewed standalone dependency repairs

The independently reviewed watcher repair is incorporated from a646d3cc3 only in
its 22 watcher, governance and documentation paths. The unrelated wallet-client
test is excluded, and the application branch's prior dependency history is
preserved. Source-owned adapters retain glob-aware ignore semantics, TypeScript
and env changes, manual restart, preloads and graceful shutdown. Fresh isolated
frozen installs, unexcluded audits, builds, lint, all six native watcher checks
and the original 100, 112 and 202 service tests pass. WAB's first test attempt
failed because its SQLite3 native driver had not been rebuilt after the
script-disabled install; an explicit driver rebuild fixes setup and the full
original suite passes. Production startup and public APIs are unchanged.

MessageBox adopts only the existing Busboy 3.2.2 and ip-address 10.7.1 nodes'
version, URL and integrity fields. The initial Busboy-only audit passed its high
gate but reported a remaining moderate ip-address finding; it is not recorded as
an all-clear. After the separately reviewed compatible row update, the fresh
frozen install, native rebuild, build, lint and 227 original tests pass, and the
unexcluded audit reports zero findings. The reviewed Metro String.raw correction
preserves the installed watcher oracle. These source repairs do not publish or
deploy images.

Checkpoint two remains open. This component batch originally retained only its
first candidate after verifying alternate BEEF; the following implementation
adds the required separate cumulative custody. Actual retained Engine/Mongo
admission, authenticated native-wallet and LCH playback composition, the remaining
reference workflows, complete affected mutation campaign and successful exact-head
hosted qualification also remain required.

### Cumulative purchase proof custody

`SQLitePrivatePurchaseEvidence` is a separate optional native owner on the original
private domain. It reserves complete future encrypted chunks and update capacity
before preparation leaves the host. It binds the complete original signed request,
terms and capability, and retains a bounded same-raw-transaction BEEF union. Shared
raw transaction bytes must agree; the explicit target remains fixed. Plain BEEF
serialization preserves added shared proof rows that target-only Atomic BEEF
serialization discarded in the first test attempt. That initial failed assertion
is retained; neither the fixture nor the verifier claims chain truth from structure.

The optional coordinator independently checks incoming and combined views, pins
the first financial candidate, then retains proof. Recovery can populate an
already reserved empty slot from that exact original candidate after validation.
It never creates missing custody. Native proof-generation guards protect admission,
release, issuance and result commit. All first original candidate, operation,
STEAK and delivered-result bytes remain immutable; duplicate proof consumes no
update and delivered replay issues nothing again. Missing or changed configuration,
exhausted reservation and competing writers fail closed. The guide describes staged
reservation failure and explicit operator reconciliation rather than automatic
repair or replacement payment. Omitted-companion behavior remains compatible.

The complete prior contract/state/coordinator/disclosure union plus the new native
unit and 300-case property passes127 tests across11 suites in95.787 seconds. Both
complete implementations have100 percent statement, branch and line coverage;
the evidence implementation also has100 percent function coverage. The coordinator
retains its pre-existing unused initialization no-op. Tests cover large encrypted
multi-chunk storage, richer shared-Merkle proof, native reopen, full reservation,
capacity/update exhaustion, lost financial/proof replies, stale proof at every
physical boundary and first-result replay. Lifecycle ports in these tests are
controlled premises, not actual Script, selected-chain or topical-admission proof;
the complete reference composition remains an acceptance requirement.

The exact coordinated whole-source registration derives138 targets, preserves all
prior unions and appends complete proof coverage to the existing coordinator target.
All previous thresholds,300-case floor, seed/path controls, workers, test/campaign
bounds and full-campaign-only policy remain. The three owned SDK analyzer fixes
preserve finite deadlines and existing request selection. Their full old/new HTTP
union passes225 tests across13 suites. The nine scoped watcher analyzer corrections
still await the active owner's acknowledgement or qualified handoff; no analysis
waiver is used.

### Scoped watcher analyzer correction

The active source owner acknowledged the nine findings repeated across the three
standalone watcher copies. The canonical adapter retains its existing global
regular expressions and uses `replaceAll`; native polling uses an equivalent
bounded asynchronous retry with all400 predicates and the final25ms failure wait;
graceful stop uses the optional child guard. The existing synchronizer copies both
files to the other two services. All six isolated native watcher assertions and
all three service lints pass on the unchanged frozen installed graphs. No analysis
setting, dependency, startup recipe or acceptance threshold changes. Hosted
qualification of the resulting published commit remains a separate requirement.

### Native observation and complete reference compositions

Actual simultaneous host work exposed a timestamp conflict: a private purchase
progress plan used an earlier read, then owning and sealing its large payload
advanced the real clock before commit. The existing exact guard correctly refused
that stale plan. No retry budget, cutoff, authority check or clock was relaxed.
The additive `commitPrepared` derives an owned synchronous plan from its native
transaction observation, freezes the view and call-time limits, rechecks current
authority, then applies the original CAS, reservation and rollback rules. The
private purchase store selects this behavior only through the authenticated,
installation-bound `native-observation-v1` fifth argument. Existing defaults,
methods and obligations retain their prior behavior; profile mismatch refuses
reopen. Signed terms and financial identity are unchanged.

The full protected-ledger and purchase union passes 314 tests in 21 suites in
128.097 seconds, with 100 percent statements, branches, functions and lines in
both complete native implementations. This includes the original properties and
an additional 300 clock-advancing native interruption histories under unchanged
case floors, seed/path replay and deadlines. The new test callbacks were then
split for analysis clarity without dropping assertions. The final changed union
passes 14 tests, including the complete 300-history property and six native routes,
in 74.578 seconds; all 16 changed/new authored TypeScript/JavaScript files have
zero local analysis findings. The final five actual native HTTP/admission/LCH
scenarios also pass again in 118.684 seconds.

The actual Wallet Toolbox/BRC-103/104 HTTP/Engine-Mongo/protected custody/LCH
composition passes the complete original host union: 878 tests in 49 suites,
225.226 seconds. Five native scenarios demonstrate actual original noSend funding,
full genesis and Script checks, retained admission and real encrypted playback;
reply cuts cover preparation, actual wallet finalization and delivery, including
concurrent original buyers and fresh native wallet connections. Seller restart
reopens its private SQLite owner while its listener, Engine and Mongo remain
running. Both roles independently read the selected local host's retained history.
The selected synthetic chain and explicit HTTPS-to-loopback fixture adapter make
no mainnet, TLS termination, mining, remote evidence or current unspentness claim.
Original LCH 244 tests and native wallet 8 tests, including its 300-history property,
pass without changing their defaults.

The reference app passes all 19 tests and both actual Chrome/IndexedDB direct and
Engine-Mongo admission profiles. Its new native two-host case completes progressive
pages and live updates together, preserves source-local withdrawal, verifies a
spend, durably rejects a contradictory raw-BEEF report and reopens the same
journals/cursors. No public fault-injection endpoint was added.

The separate six-route native wallet demonstration passes in 42.342 seconds. Each
purchase, split, merge, payout, unanimous amendment and retirement recovers its
original prepared action after connection reopen, then independently verifies the
full transaction and complete authorized lineage where a listing remains. It
carries original noSend change references and compacts declared ancestors under
existing covenant limits. Payout retains a 12-satoshi remainder; retirement after
an approved schedule change supplies the explicit two-satoshi top-up and pays the
new recipients exactly. The one-satoshi receipt remains a separate required output.
Initial assertions omitted that receipt and incorrectly demanded fresh recipient
signatures for retirement; the final assertions match the approved family and
check exact recipient scripts. Economic corpus negatives independently re-sign
mutations; this integration's altered-output negatives also execute actual Script.
No fixture extracts the funding wallet's root key for revenue authority.

The 59 compiled examples pass against 24 exact packed tarballs. Existing root
mutation registrations retain all whole modules, selectors, inputs, 138 targets
and every previous gate; exact coordinated additions cover native observation and
its complete dependent tests. The final literal-backslash watcher correction is
adopted from the acknowledged source-owner handoff, synchronized deterministically,
and passes all six native checks and three lints on unchanged frozen graphs.
Checkpoint two remains open: the richer same-raw-proof actual composition, complete
private/public-serving and root/GASP demonstrations, full affected mutation
campaign, review and exact-head hosted qualification remain required.

The first coherent native batch passed lint, format and type checks, but the health
gate correctly rejected the new property as unregistered. A superseding exact
source-owner agreement adds one critical native-clock property and one whole-source
mutation target, deriving 139 from the previous 138. Its three complete modules
and full ledger/purchase test and input unions preserve every previous target,
selector, threshold, case floor and deadline. The six-route unit demonstration
joins both existing native-payment dependent selections. This repairs registration;
it does not qualify the full campaign or weaken its zero-uncovered/invalid/
unexecuted requirements.

### Same-raw proof composition and hosted follow-up, October 3

The complete application suite at published bfd3a15452036ea357a1f47d691e6f01a488d335
passes 3,132 tests in 223 suites, 1,042.188 seconds. Both complete native ledger
and purchase-store implementations retain 100 percent statements, branches,
functions and lines. This receipt predates the following explicit-target fix.

The genuinely richer-proof host composition exposed domain checks that inferred
a plain BEEF subject from its last record. Revenue purchase, lineage assembly
and LCH wallet material now select the declared explicit txid and require that
exact raw transaction. Any Atomic BEEF marker must still match it. Existing empty,
txid-only, mislabeled-marker, capacity, dependency, economic, Script and authorized
genesis refusals remain. New complete plain-BEEF tests retain all original raw
and proof records while placing the proved declared subject before other rows.
No Bitcoin verification or listing-history predicate is replaced by this assembly.

The first new inclusion fixture incorrectly used leaf zero at the new tip. The
existing SDK correctly enforced its coinbase-position maturity requirement. The
corrected fixture uses ordinary position one and the matching synthetic tree root
in its separately hash/link/work checked selected header view. Its disclosed
sibling is not a consensus-validated block body or evidence of real mining.
The richer transaction is independently verified through the actual authenticated
HTTP, Script/domain, retained admission and cumulative native custody composition.
The cumulative owner retains the checked proof across seller restart; the first
financial candidate, delivered bytes, licence and local-admission policy remain
unchanged. Actual admission, issuance and wallet-action counters never advance.
The focused revenue union passes 54 tests, LCH covenant 12, and the complete six
native host scenarios pass under coverage in 146.655 seconds.

Hosted bfd3 qualification found a genuine test scheduling issue: the concurrent
buyer held the first physical response through additional validation and exhausted
its unchanged 30-second deadline under coverage. The scenario now releases that
response immediately after the second buyer recovers it. If the deadline has
already fired, only that specific unavailable outcome is accepted and it must
recover the same original delivered result without a second financial effect.
All other failures remain failures. No deadline, retry, policy or capacity changes.
The same hosted head reports one new Sonar S7737 fixture-default finding; an
optional timeline with an internal per-call default preserves its previous
semantics. All 11 authored TypeScript files have zero local analysis findings.

The complete updated application suite passes 3,134 tests across 223 suites
under coverage in 1,179.320 seconds. The full LCH suite passes 245 tests across
37 suites in 82.236 seconds, including the mismatched Atomic-marker refusal.
The complete host suite subsequently passes 879 tests across 49 suites under
coverage in 158.872 seconds. The resulting published head's hosted gates remain
required. Root/public serving compositions and the full
canonical mutation campaign remain open; this batch does not complete checkpoint 2.

### Native root serving and primitive private lookup context

The optional protected publication lookup reader now maps owned private bytes to
recipient-authorized legacy lookup context, using durable entitlement records in
its native protected ledger view. A request-local Engine hydrates the original
outpoint without changing the public lookup registry. The actual authenticated
host test revokes the reader's grant from a separate native connection after
response signing, requires identifier-free refusal, restores the explicit grant
and reopens the original protected custody without another admission. Ordinary
public finite lookup, progressive/live withdrawal and replay, and GASP return
public evidence without context. The classic off-chain-values hook profile is
exercised separately; atomic Mongo retains a notification intent, and the test
makes no claim that a generic outbox dispatcher has run it.

`RootAdvertisementServing` and `RootLookupServingDisclosure` compose complete
owned response bytes, positive SHIP/SLAP inventory, native root eligibility and
current provider/session authority through one physical synchronous enqueue.
The provider gate precedes the root gate. Existing asynchronous root enqueue and
ordinary lookup contracts remain available. Opaque extensions require a separately
installed complete inventory; a supported-extension identifier alone is refused.
The complete native SHIP and SLAP pipelines pass two scenarios in21.362seconds
(`/private/tmp/utxo-root-native-host-v10.log`). They use actual SDK advertisement
and spend Script/SPV verification on the selected public synthetic chain,
Engine/Mongo admission, two independent SQLite root journals and native lookup
sessions, BRC-103/104 response authentication, caches/snapshots/live/replay,
independent suppression bases, restoration pending projection, stale projection
acknowledgements, post-signing refusal, pre-effect spend invalidation and restart.
GASP history replay cannot recreate a spent query row.

That composition exposed two evidence-retention gaps: leaf-only hydration lacked
raw ancestry, and ordinary current-output reads correctly hid consumed/evicted
rows. The explicit bounded Mongo retained-BEEF profile stores public ancestor
history without off-chain values. Its history serializer walks raw inputs below
a proven leaf, retains available parents and excludes unrelated branches. Ordinary
SDK Atomic serialization and default storage behavior are unchanged. A separate
node/topic/outpoint historical port and opt-in pinned GASP reader expose retained
history for verification without granting current membership or unspentness.
The full73-case structural/default/GASP union passes with100statement/function/line
and97.22branch coverage of the complete retained module before the final traversal
simplification (`/private/tmp/utxo-retained-whole-coverage-v2.log`). The first
CommonJS Mongo selection failed during driver startup before assertions; the same
complete native three-suite17-case selection passes30.148seconds under ESM
(`/private/tmp/utxo-retained-native-mongo-v1.log`). The larger native baseline and
canonical runtime correction remain under qualification; neither focused receipt
completes a mutation campaign or final package qualification.

Exact published9da31fb hosted coverage interrupted the original buyer property at
its150second bound after208cases, then the35minute job was cancelled. These failures
remain retained. A bounded public synthetic test-fixture signature memo now keys
actual signed packets by complete canonical domain/signer/body and returns fresh
copies. It changes no production verification, case floor, financial history or
deadline. The original300-case buyer property passes84.631seconds under focused
coverage (`/private/tmp/utxo-purchase-buyer-signing-cache-coverage-v1.log`), and its
complete two-suite25-case union passes113.647seconds. Exact final-head hosted
qualification remains necessary.

Shared whole root/native fixture registration is acknowledged at18728707; one
additional complete retained-BEEF property/critical module is acknowledged at 18729051. Local inventory becomes141 when installed, preserving all previous140
profiles, wallet22whole/20parts and unchanged thresholds/deadlines/full-campaign
requirements. Separately owned wallet branch additions remain outside this branch;
future combined inventories must derive the complete key union, preserving every
wallet and application target. No local component receipt establishes checkpoint
two readiness, production operation, publication or merge.

The complete native Mongo ESM baseline now passes 270 cases across all 19 original
suites in 195.837 seconds. Explicit Jest imports preserve the existing mock
behavior in ESM; the earlier driver-handshake and fixture-global failures remain
recorded. Canonical package runner adoption still awaits the separately requested
shared-scope acknowledgement; this receipt is not a successful default package
campaign. The complete retained-public-BEEF module now has 100 percent statements,
branches, functions and lines with 73 passing cases across five suites. All 62
compiled examples pass against 24 exact package tarballs. These source-level
receipts do not complete the final mutation campaign or exact-head hosted gates.

The canonical core runner now uses disjoint legacy-commonjs and native-mongo-esm
projects under ACK18729140. Discovery preserves all 52 ordinary suites exactly
(33 legacy plus 19 native). Each of the five core mutation profiles also retains
its full pre-split set without duplicates: 27, 31, 29, 28 and 25 suites respectively.
Their native selections include all original Mongo tests and the actual root host
integration. All 83 companion governance assertions pass. The required strict
typecheck exposed undeclared direct Jest globals imports. A proposed importer-only
addition was rejected by semantic graph comparison because pnpm also changed a
transitive edge. Instead, the native test sandbox installs Jest's documented
`import.meta.jest` object for shared contract fixtures, and native Mongo tests use
that same object directly. The existing declared Jest types describe the original
mock contracts. Strict core compilation now passes without any dependency or lock
change. The initial typing and resolver failures remain retained. The native setup
fixture belongs to every core target's complete fixture fingerprint closure.

The reference application's compound proposal profile now composes its actual
Engine/Mongo admission with the reusable opt-in proposal client, authenticated
lookup provider and native session/disclosure owner. It observes active and
finalizing states, reopens the client and host stores after a lost admission reply,
then receives the original finalized state without another Open after intent and
capability expiry. Both original pipeline cases pass in 20.57 seconds, including simultaneous
connection attempts joining the same original operation, and the
two changed TypeScript files have zero local analysis findings. Initial composed
authentication-owner, signed-service-scope and closed authorization-return-shape
failures are retained; the example corrects the adapters without changing the
protocol, production defaults or existing assertion/deadline requirements.
The same live client also observes a separately submitted active proposal expire
at its exclusive lifetime boundary, with no Engine submission or evidence resolver
call. The reusable client retains its live source across reconnects, preserving
physical request ownership and limits. Strict application typing and both changed
TypeScript files pass local analysis without findings. Interactive/browser proposal
demonstration and final published-source qualification remain required before
checkpoint two.

### Native private-state browser composition (2026-10-03)

The additional opt-in private-state page now installs the composed proposal client
with native IndexedDB, durable exact-request outbox, authenticated HTTPS lookup,
compound SQLite private journal/feed/sessions, current recipient policy, real Mongo
admission port and bounded expiry/recovery scheduler. It keeps the existing
final-output page unchanged. The isolated Chrome profile passes automatic private
live delivery, offline catch-up through the original session, hidden-tab intent
retirement, page-close reopening and provider-process restart. It retains exactly
two Opens and reports zero browser exceptions. The first reopening attempt exposed
an outbox caller using default capacities rather than its sealed creation limits;
the caller now reopens with the original limits, without changing schemas or tests.

Public fixture author keys, payloads and synthetic chain are examples only. Each
15-second publication creates a new channel and makes no financial effect. Actual
finalization/lost-admission recovery remains demonstrated by the separate compound
native pipeline. Screenshots accompany protocol/custody assertions; they are not
qualification substitutes. Complete existing browser regressions, full mutation
campaigns and final exact-head hosted gates are still required before checkpoint two.

The new multi-entry production browser build preserves both original producer
modes; both pass their complete authenticated two-host/two-client native IndexedDB,
live Script/SPV, offline replay, reload and independent-membership assertions. The
ordinary `test:browser` command now runs all three profiles without dropping either
original selector. The additional private profile passes exactly two Opens and zero
page exceptions. The private provider shares one physical work budget between
lookup preparation and native disclosure, rechecks its local serving lifetime at
physical data enqueue, and coalesces repeated close calls through the same drain
promise. A new native regression holds physical custody close pending and proves
that a second close cannot settle early; all ten admission-suite cases pass. Local
new TypeScript analysis reports zero findings, strict typing and application format
pass, and the docs-site validates all 153 documents/links. Final build/platform,
complete mutation and exact-head hosted qualification remain required.

Published `0f993801df5cc35aa2f69d01d3bfe785e0150349` hosted coverage job
[111186508800](https://github.com/bsv-blockchain/ts-stack/actions/runs/37117151558/job/111186508800)
now completes successfully within the unchanged job bound. Output-knowledge passes
all 3,158 cases in 226 suites; complete new `PrivatePublicationLookupContext`,
`RootAdvertisementServing` and `RootLookupServingDisclosure` modules measure 100%
statement/branch/function/line coverage. The original 300-case purchase-buyer
property completes in 100.787 seconds under its unchanged 150-second deadline.
Earlier timeout receipts remain retained. This is coverage qualification for that
published source, not final-head or full mutation qualification. Four identified
CI findings remain queued for the next coherent source batch: two async fixture
arrows, two fixture listener rate limiters, one documentation link and the root
entry browser graph (the analyzer findings are separate checks). The newly
introduced serving helpers will move into an explicitly selected portable entry
with an independently measured budget, preserving the original small coordination
entry and every earlier limit, under shared-region ACK18729907.

The same head's aggregate patch check measures 97.03% (29,961/30,879 changed
line/branch points) above the unchanged 90% floor, but fails two missing-LCOV
configuration modules: the new core and Express `jest.projects.mjs` factories.
Their runner configuration executes before instrumentation. The planned correction
uses the existing canonical `*.config.mjs` naming convention without changing the
coverage classifier or adding exclusions. It must preserve both factories' behavior,
complete native/legacy selection, original input fingerprints through their renamed
paths and all policy controls. Exact shared-control coordination is pending before
that edit. Coverage collection success therefore does not imply aggregate or final
CI success.

### Final package and source checks for the private-state browser batch

The original overlay union passes 1,036 tests in 51 suites with its one governed
skip (207.762 seconds). Discovery independently reproduces the original five
critical selection digests and their 27/31/29/28/25 suite counts, with disjoint
legacy/native projects and no duplicate execution. The two renamed project
configuration factories retain byte-identical contents; every former fingerprint
path is replaced by the canonical configuration filename, without changing the
coverage classifier or any selection. All 101 control companions pass.

All six browser artifact profiles and the native browser runtime pass. The new
explicit serving entry measures Vite 372956/101595/85345 and esbuild
285255/92599/79824 raw/gzip/Brotli bytes. Its separate rounded ceilings retain at
least ten percent headroom; the complete original root budget, its eight
additional entries and every original ceiling are unchanged. Packed conditional
exports, strict clean consumers and all 62 documentation examples against 24
exact package tarballs pass. The security audit finds no known vulnerabilities;
conformance parses all vector files successfully.

The retained-BEEF local whole-target attempt on published 0f993801d stops with
exit 124 at its original 2700-second deadline. Its initial full 345-test run
passes, but no complete mutant score or qualification receipt exists. The own
process group and Mongo children drain before covered source corrections. This
failed attempt is retained as local feedback, not full hosted evidence. No
selector, static mutant, property floor, seed, concurrency, reuse limit or
deadline is relaxed. Complete exact-head hosted qualification remains open.

The final rendered-site check catches two repository-only README links. Those
links now identify the published implementation branch explicitly, so the
repository and rendered documentation have the same usable destination. Both
failed rendered-site outputs remain retained; a passing source-link check alone
is not claimed as a successful site build.

### Exact-head analyzer follow-up

Published 93b946ea7 passes hosted conformance and rendered documentation. Sonar
reports two new findings: explicit comparison for the two fixture writer keys
(S2871) and optional chaining in the owned browser-child stop guard (S6582).
Both are corrected directly, without suppressions or changed protocol behavior.
The writer comparator specifies English collation for the fixed lowercase hex
keys; the stop guard still returns for an absent or already exited child.

Full hosted campaign 37120402535 selected the complete 141-target inventory and
its partitions, but is stopped before superseding that head. Its retained
partial results are not final qualification. The corrected source requires a
new complete campaign and successful exact-head analyzer/CI checks.

### Shared build artifact completeness

On 1e281c1ff, hosted Sonar verifies the exact revision with zero new findings and
zero unreviewed hotspots. CodeQL completes successfully and the PR has no open
alerts. The browser platform lane then fails because the real shared archive
contains `dist` and `dist-server`, but omits the newly built `dist-proposals`.
The prebuilt runner correctly cannot start the absent proposal server.

The actual shell/tar regression is expanded with the proposal server and its
license payload. The original archive fails that regression, preserving the
missing-output error. The archive now adds only the explicit `dist-proposals`
directory, keeping every old output and node_modules/sandbox prune. The app's
existing notice copier supplies the identical governed notice files to all three
bundles; this also supplies notices for the original server bundle. Neither
change rebuilds behind the prebuilt runner or relaxes an artifact/platform gate.

The acceptance inventory now separates demonstrated integration workflows from
immutable final qualification conditions. Its integration marks describe the
actual runnable reference compositions. Final readiness remains governed by
complete full-campaign receipts and applicable exact-head checks recorded in the
PR; the source document cannot certify its own future commit or test run.

### Purchase contract boundary qualification

Published da3c3026a completes ordinary CI with 54 successful checks and two
governed skips accepted by the merge gate. Changed coverage is 97.03 percent.
The separate complete hosted mutation campaign 37122451630 finds a
private-purchase-contract failure: 183 killed and 56 surviving mutations,
76.57 percent against the unchanged 90-percent requirement. That original
report remains retained; passing ordinary CI does not qualify the campaign.

Additional tests exercise complete seller-signed originals with independently
changed installation semantics and reservation intervals, exact request and
signed-response capacity, signature framing, critical capability extensions,
several advertised release policies, and the last U64 recovery deadline. The
preparation chain-mismatch fixture now owns its changed chain instead of also
changing the manifest's shared fixture object. It therefore checks request
association independently of capability selection.

The resulting full unit/property selection passes 46 tests, retaining the
300-case property floor and replay seed. Local whole-module mutation feedback
passes at 95.40 percent: 228 killed and 11 surviving mutations, with no
uncovered, invalid or unexecuted mutations. Runtime code, wire formats,
selection, coverage treatment, thresholds and deadlines are unchanged. This
local receipt is diagnostic evidence; final readiness still requires the
complete hosted campaign and all applicable checks on the new published head.

## Private disclosure, proof boundaries and native expiry follow-up

The immutable DA3 full campaign found private contract, disclosure and proof scores
below the existing 90 percent floor. The original reports remain retained. The
published contract boundary batch reaches 95.40 percent in complete local feedback.
Additional actual-native disclosure tests now reach 92.61 percent across the same
284 mutants, with no uncovered, invalid or unexecuted mutants. Complete proof
follow-up reaches 92.31 percent across the same 338 mutants: 311 killed, 26
surviving and one timeout, with no uncovered, invalid or unexecuted mutants.
It covers exact error codes, callable native proof readers and complete original
signed-preparation association, including equal semantic digests with different
signed lifetimes.
These working-tree diagnostics do not qualify a hosted commit or checkpoint.

The private Chrome expiry scenario could observe the visibility handler's safe
interim inactive labels before the two proposal cutoffs. Its original 25-second
wait now requires both exact timestamps and inactive cards together. Actual Chrome,
IndexedDB and owned HTTPS pass with the same two original Opens, no browser errors,
missed-state reconnect, page-close recovery and provider restart. Bounded failure
metadata exposes status and lifecycle timing without private payloads.

Complete root diagnostics preserve all 32 original suites and 308 cases. The
fixture now acknowledges the release command's asynchronous IPC receipt before
the parent enters a synchronous SQLite wait. Complete ordinary tests pass in
111.634 seconds, and complete local root-commit feedback kills all 30 mutants,
with no uncovered, invalid or unexecuted mutants. The two failed CPU-profiled
runs and initial setup failures remain retained separately; the unprofiled
passing run does not reinterpret them as qualification. Original lock duration,
observation assertions and time limits remain unchanged. Production database
behavior is unchanged; exact-head hosted qualification remains required.

The hosted campaign also exposed legacy mock semantics in the Overlay Express
mutation environment. Its declared legacy CommonJS project still requested an ESM
transform. The shared factory now uses the existing legacy `tsconfig.cjs.json`
and applies caller source mappings to each child project. Private ESM remains
unchanged. BotBoard acknowledgements 18731353, 18731561 and 18731614 cover the
correction and complete strict test typing, including both historical test
directory spellings. All 141 target inventories, source/test/input unions and
bounds remain unchanged. Complete ordinary Overlay Express validation passes
51 suites and 882 cases; 48 shared configuration regressions and all eight
affected target discovery comparisons preserve full selection.

Additional journal boundary tests cover exact fork capacities, original request
association and principal accounting. Fourteen additive native wallet signer
tests cover custom input guards, exact byte and sequence boundaries, synchronous
callbacks, and real single-key derivation when the optional bulk port is absent.
Complete wallet recovery validation passes the original 223 cases plus these
14 cases. Production wallet code and cryptographic behavior are unchanged.

The purchase adapter supplies the SDK's already-supported owned `Uint8Array`
atomic BEEF representation to the native wallet. It retains the identical
canonical base64 recovery plan, bytes, schema and transaction identity. The
native regression checks both representations independently, mutates the
caller's owned argument, and verifies original-plan recovery and Script validity.
Sequential reopened native-wallet and buyer histories now close superseded
owners. The buyer property asserts one active owner; tests that intentionally
exercise simultaneous owners retain their behavior. Both properties retain
all 300 histories, their replay seed, operations, assertions and 150-second
interruption limit. No database durability or cryptographic work is substituted.

These results are local working-tree feedback. Checkpoint 2 still requires the
complete hosted campaign and all applicable checks on the final published head.
No threshold, deadline, case floor, dependency, wire, authorization or production
contract is relaxed.

### Sequential mutation builds and legacy session coverage

The complete immutable campaign exposes a harness error before private consumer
tests run: Stryker 9.6.1 calls `execaCommand` without a shell, so compound build
commands pass `&&` and subsequent commands as arguments to the first build.
The sequential helper replaces only the six affected compound commands. It
retains their ordered dependency builds and final instrumented sandbox build,
uses explicit child arguments, and stops on a child error, nonzero exit or signal.
Single-command targets remain unchanged. Each affected input closure includes
the helper, and changing that shared control selects the complete inventory.
BotBoard acknowledgement 18731850 covers this exact region.

Eight helper regressions, including actual child success, failure and signal
handling, plus 49 configuration regressions pass. The actual
Wallet Toolbox, output-knowledge and Overlay Express dependency/build sequence
also passes. Existing 141 target identities, source/test unions, partitions,
property settings, worker/reuse limits and deadlines remain unchanged.

The full session target's three uncovered mutations belong to the supported
legacy bridge without an optional savepoint hook. Additive real SQLite tests
exercise successful savepoint release before outer commit, failed opening
rollback, exact retry, retained observed clock and independent reopen. All
63 original and additive session tests pass. The purchase admission tests now
also exercise exact capacity bounds, missing declarations, synchronous context
identity across awaits, original signed preparation and manifest alternatives,
explicit BEEF targets and installed history identities; all 58 unit cases pass.
These local checks remain feedback pending complete exact-head qualification.

### Bounded JSON processing and independent native readers

The sequential-build/admission batch is published at `808ea43d6`. Its complete
purchase-admission baseline passes 551 tests across 31 suites in 223.177 seconds.
Local full-module lookup-session mutation feedback then passes 92.84%
(467 killed, 36 survived), with all 503 mutations executed and zero uncovered or
invalid mutations. The legacy bridge's three previously uncovered cases are
exercised by the actual SQL savepoint/rollback tests. Reports and execution
receipts are retained separately from hosted qualification.

The verified-publication property CPU profile spans the actual 64-second
process. Repeated bounded JSON work is a material cost. A source-external
comparison checks 40,028 string/UTF-8 outcomes and 16,016 explicit-limit outcomes
against the original implementation, including exact errors and null-prototype
maps. The implementation now scans quote/backslash delimiters using native
matching, while `JSON.parse` continues validating escapes and control characters.
Decoded Unicode validation, duplicate decoded keys, canonical bytes and every
byte/depth/array/map fence remain unchanged. Only the already frozen default
limits are reused; custom limits retain every original validation and one-time
getter read. Function arity and public declarations remain compatible.

Four additive tests exercise long strings, escape parity, differently encoded
duplicate keys, raw controls, unfinished escapes, exact UTF-8 limits and custom
limit behavior. The original complete JSON selection passes 66 tests; its full
361-mutation target passes 92.24% (328 killed, 28 survived, 5 timeouts), with zero
uncovered, invalid or unexecuted mutations. The complete SDK suite passes all
8,285 tests in 256 suites. The first local invocation used an incompatible ESM
mode for an existing `__dirname` fixture; the retained retry uses the unchanged
governed SDK profile. No transform, dependency, selector or test is weakened.

The native publication fixture now closes independently opened temporary readers
after both successful and failed reads. Every original reopen, actor connection,
authorization schedule, durability setting and assertion remains. This lifecycle
change alone establishes no speed-up. With the current parser and fixtures, the
complete publication-service selection passes 263 tests/16 suites in 108.495
seconds, including all three original 300-history properties. Its verified
property takes 54.389 seconds locally; hardware, profiling and contention limit
comparison with earlier measurements and do not establish hosted performance.

Nine additive acquisition-state cases independently check the original digest,
opaque address domains, default extension path, exact refusal identities and
retained-state byte ceiling. All 21 state-file tests pass. Eight changed code
files have zero local analysis findings. The two hosted `String.raw` findings in
the sequential helper's registry are corrected with identical command bytes;
all eight helper and 49 configuration regressions still pass.

The complete native buyer/payment selection passes all 55 tests in eight suites
in 240.879 seconds, including its original three 300-history properties. The
complete runtime mutation replay passes 91.18% (310 killed, 38 survived, 83
timeouts), with all 431 mutations accounted for and zero uncovered, invalid or
unexecuted mutations. Its unchanged original cancellation guard is exercised;
this local result does not establish a universal resolution of the earlier
hosted interrupted-work diagnostic.

Twenty-three additive access cases cover synchronous policy/context declarations,
strict-true authority before any ledger read, rejected promise observation,
independent retained topic and publication bindings, malformed ownership state,
exact identity diagnostics and owned critical-extension semantics. All 31 access
tests pass. Damaged-port tests begin with genuine native records and complement
the unchanged actual SQLite staging/read/rollback tests; they do not substitute
for them. Initial local attempts exposed fixture typing and invocation errors,
which remain recorded rather than presented as passing evidence.
The complete publication-coordination selection then passes all 363 tests in
25 suites in 230.237 seconds, including the original native and authenticated
HTTP integrations and every property history. Required root health, lint,
formatting and strict typing checks also pass for the coherent batch.

These receipts remain local feedback. Checkpoint two requires the final
exact-head hosted checks and complete 141-target campaign;
previous heads, partial runs and component scores cannot certify it. Every
original union, case floor, seed, worker/reuse bound, deadline and quality gate is
preserved.

### Protected browser custody and relocated dependency feedback

The bounded JSON/native-custody batch is published at `4d2dce002`. Its exact-head
Sonar gate and independent read-back pass with zero new findings and zero
unreviewed hotspots; CodeQL and conformance also pass. All 40 ordinary CI jobs pass at that exact head. Complete final mutation
qualification remains a separate obligation.

The prior full campaign's protected-object browser partition reports 63.31%
with 29 uncovered mutations. Forty additive cases exercise declared
database capabilities and open deadlines, synchronous opener failures, version
change, late blocked initialization, whole-database/table schemas, sorted
multi-object inventory, raw row capacity, authenticated completion, transaction
abort/quota/missing-result behavior and outgoing byte clearing. Existing tests
and their exact inputs remain. Tests use `fake-indexeddb`'s actual transactional
port and AES-GCM synthetic custody; controlled provider faults complement the
separately retained real Chrome demonstrations rather than establishing a new
Chrome result. The new file passes all 40 cases and strict application typing. Additional
cases cover strict transaction durability, exhausted reservations, independent
object writers, same-head row/key drift, synchronous read quota/retry and pinned
opener ownership across asynchronous custody.
Local analysis has zero findings. An empty-selection bug in the external local
analysis helper initially scanned the whole checkout after staging; that owned
process was stopped, and the corrected helper explicitly includes staged inputs
and refuses an empty selection.

The initial unchanged browser execution partition's complete baseline passes
all 502 tests in 35 seconds with the first 28 additive cases. Its complete 357
mutation replay reports 85.99% (285 killed, 50 survived, 22 timeouts), with zero
uncovered, invalid or unexecuted mutations. The subsequent 12 cases address meaningful surviving boundaries. Their complete
514-test baseline passes in 34 seconds and the full 357-mutation replay reports
92.44% (309 killed, 27 survived, 21 timeouts), with zero uncovered, invalid or
unexecuted mutations. The replay completes in 473.594 seconds locally.
All replays retain the original four-worker, reuse, floor, seed and deadline
contracts. Exact staged patches and input receipts are retained as local
diagnostic inputs. Partition execution does not enforce the complete target
threshold independently and cannot qualify the final campaign.

The prior campaign's six LCH overlay targets fail before mutation execution on
the same relocated relative application-source import. After explicit peer acknowledgement, an ordered mapper on only those six
existing targets resolves the independent application source before the
unchanged generic relative `.js` fallback. The complete original LCH selection
passes all 89 tests in 20 suites in 78.511 seconds, including all property
histories. All 58 configuration/helper tests pass. Independent comparison of
all 141 target definitions confirms only those six new mapper fields differ;
every original source/test/input union, part and quality bound remains. The
actual governed sandbox then builds and passes its complete 89-test baseline in
77 seconds. Its original 495-mutation replay exhausts a worker heap, restarts
that worker and ultimately reaches the unchanged 2,700-second local supervisor
limit without a complete report. This failure is retained; it establishes no
mutation score or production-memory diagnosis. The exact six-target finite
runner-reuse cap of eight is acknowledged again on the fresh handle and applied
after both owned pools drain. A complete comparison of all 141 target definitions
permits only those six ordered dependency mappings and six reuse caps; every
original source/test/input/partition and remaining runner field is unchanged.
All 58 configuration/helper tests pass with the explicit cap assertions. A fresh
complete governed replay remains required.

Thirty-three additive purchase transport cases bring that file to 44 passing
tests. They check constructor authority, signed domain/release/recovery promises,
exact deadlines, selected request/physical response capacity, payment/status and
response contracts, encoding/redirect/URL/header guards, held identity work and
post-response wallet capability. They retain the original controlled physical
fetch path and complement the separately retained native authenticated HTTP
demonstrations. The initial negative recovery fixture was itself invalid before
the selected-service check; the corrected fixture signs valid one-day terms and
advertises one additional second, so it exercises exactly that promise. All four
changed code files have zero local analysis findings after extracting an
existing nested test expectation without changing its bytes or assertions.
An external strict SDK test compiler check identifies one inferred empty-header
union; an explicit `Record<string, string>` annotation retains exactly the same
physical response bytes, and strict typing then passes. The original attempts
are retained. The complete original six-selector SDK purchase HTTP selection
passes all 259 tests in 13 suites in 11.87 seconds. All 58 helper/control tests
still pass and all four changed code files have zero local analysis findings.
The complete 413-mutation purchase HTTP replay then passes 91.53% (370 killed,
35 survived, eight timeouts), with zero uncovered, invalid or unexecuted
mutations, in 361.855 seconds locally. Its actual governed baseline retains all
259 tests and passes in 11 seconds. These local results are not final hosted
qualification.

### Publication test ownership on failed assertions

Three existing publication tests deliberately hold non-cooperating validation
or admission work while checking capacity, cancellation and physical shutdown.
Previously, their release calls followed assertions, so a failed assertion
could leave held work or a reconciliation loop unsettled. Each original test
and assertion remains. The tests now release the barrier in `finally`, stop
the owner and await its physical settlement. Entry checks also observe
premature publication completion or a completed reconciliation pass rather
than silently waiting for a boundary that the failed operation never enters.
The reconciliation observer is a synchronous report callback; loop rejection
is observed separately through `done`.

All 29 original tests in both files pass with strict application typing and
zero local analyzer findings. A separate copied-fixture diagnostic deliberately
throws before each of the three releases. All three expected failures are
observed; the runner exits normally in 1.283 seconds, with zero open handles
and without `forceExit`. The initial diagnostic selected only two test names;
that incomplete attempt is retained, and the corrected three-case diagnostic
provides the cleanup evidence. The diagnostic changes no authored production
source and is not qualification.

The previous access partition passes its complete 363-test baseline in 224
seconds but has no terminal mutation result. Its owned process group is stopped
and verified drained when the BotBoard lease expires; the lease is recovered
as expired and a fresh handle acquires the ongoing work. This interrupted run
is retained without a score or qualification claim. After these test-only
lifecycle corrections, the complete original publication selection passes all
363 tests in 25 suites, with zero failed tests. Its observed completion is
195.875 seconds. A fresh governed access replay remains required, preserving all
original histories, selectors, quality thresholds and bounds.

Final self-review applies the same unconditional barrier release to the new
SDK held-identity test while preserving every assertion. The complete original
purchase HTTP selection again passes all 259 tests in 13 suites, and the explicit
strict SDK fixture compiler check passes. The reference application also passes
all 20 tests in five files, retaining the progressive/live lookup, native
admission, proposal recovery and Bitcoin evidence demonstrations. These results
are local feedback for the authored batch; fresh exact-head remote checks and
the complete canonical mutation campaign remain mandatory.

### Complete workload bounds after the pushed follow-up

The authored follow-up is pushed as `6d7005f18771f57e8184b1f8ae830119c3899bdd`.
Its CodeQL workflow passes. Ordinary CI stops at the original 35-minute
coverage-other deadline; the native buyer property reports interruption after
252 of its required 300 histories at its unchanged 150-second limit. This is a
failed qualification, not a smaller accepted property workload. The original
seed, replay support, case floor and interruption-as-failure remain mandatory.

The new exact-head local LCH terms and publication-access replays also stop at
the original 2,700-second bounds. Their complete 89- and 363-test baselines
pass in 77 and 213 seconds, but neither produces a complete mutation report.
Both owned process groups are drained, and their receipts and logs are retained.
Finite worker reuse and held-test cleanup alone did not resolve these limits.
The complete hosted campaign continues on that immutable head; cancelled jobs
remain failures, and an individual passing target never qualifies the campaign.

One additional acquisition test formerly released held wallet work only after
its assertions. Its corrected `finally` path releases, stops and observes the
same physical operation while retaining all original assertions. All 15 original
cases pass. A controlled copied-fixture comparison proves the old forced failure
also times out its teardown hook, while the corrected forced failure exits
without that hook timeout or open handles. The positive copied fixture also
passes all 15 cases. Production wallet behavior is unchanged.

Ordinary package coverage now uses two Jest workers and a 1 GB idle-worker
recycling limit. Original and new discovery both enumerate exactly the same
227 suites. The configuration retains every original transform, source selector,
exclusion and global coverage threshold. Ordinary serial tests and governed
mutation settings remain independent. The complete actual run passes all 3,347 tests in all 227 suites in 568.65
seconds. Global statements, branches, functions and lines are 98.17%, 96.56%,
98.44% and 98.78%, preserving their original thresholds. Every native property
retains its 300-case floor, seed 3242026, replay support and unchanged interruption
limit. All 3,691 package and dependency/configuration input hashes remain
unchanged through terminal drain. Fresh exact-head hosted validation is still
required; this local result does not establish the cause of the hosted deadline
or a production-memory diagnosis.

Five previously whole mutation targets now have source-range execution plans:
LCH covenant terms, purchase state, purchase coordination, native purchase clock
and revenue purchase verification. Boundaries fall between complete functions
or class members. Every original line selection is intersected with consecutive
source bands, and future source files retain a complete fallback. The target
registry, its 141 identities and every original whole source/test/input union
remain unchanged. All prior file-based partition plans remain unchanged.

Pinned Stryker 9.6.1 replay verifies exact canonical inventories of 495, 989,
521, 1,428 and 173 mutants across those five targets, without a missing or
repeated tuple. Each execution part retains the entire original test selection,
property settings, concurrency, baseline and supervisor bounds. The complete
matrix has 236 execution entries, below the existing 256-entry platform limit.
Same-file reports aggregate only when their full source bytes agree. All raw
receipts remain bound to source/run/configuration and property settings; the
final global gate still requires exact complete canonical inventory and the
original denominator and score. Duplicate or missing tuples cannot be hidden
by part IDs. These changes require actual full-part and final campaign execution;
inventory replay and synthetic aggregate regressions alone establish no score.

### Preserve module partitions through mutation-runner normalization

The complete immutable hosted campaign exposes additional Overlay Express
baseline failures. The actual governed proposal guard baseline reproduces the
same missing CommonJS Jest globals on Node 24.18. The direct file-configured
driver passes, but that is not a substitute for the mutation runner.

Pinned Jest normalization explains the difference: Stryker passes its combined
configuration as serialized JSON, which overwrites each child project's ignore
selectors with a redundant parent selector. This makes ordinary CommonJS tests
also execute in the private ESM project. Removing only the redundant parent
selector preserves both complete child projects, all original module semantics,
full source/test unions and every root coverage setting. No production
authentication, queue or disclosure check changes.

The existing shared-control regression now exercises actual pinned serialized
Jest normalization for every Overlay Express target. It fails on the original
configuration and passes with the correction, including both disjoint selectors,
complete caller selections and Stryker's coverage environment. A copied corrected
full guard run passes all 224 baseline cases and all 86 mutants with 84 killed,
two surviving, 97.67% score and zero uncovered, invalid or unexecuted mutants in
138.765 seconds. The original failure and an ineffective undefined-option draft
are retained. That external copied configuration is diagnostic; the corrected
actual governed execution and final exact-head campaign remain required.

All five new semantic target artifact streams are explicitly downloaded before
ordinary CI's canonical aggregation. Every previous downloader, condition and
gate remains. Complete repository health passes all 458 then-current controls
with zero contract or control findings. The extended orchestration file
initially has the same 59 full-file local analyzer findings as the last pushed
head. Comparing against the intended PR base identifies 15 findings in earlier
additions from this program; the last-head comparison alone is not zero-new
evidence. Equivalent whitespace quantifiers and two explicit archive executable
paths correct those owned test findings while preserving all assertions and the
actual archive command body. The final file has 44 findings already present on
`origin/main`, with zero introduced findings against the intended base; all ten
other authored code files have zero full-file findings. No findings are
suppressed or accepted. The discovery companion retains all original cases and
checks the unchanged common ignores in both child projects. All 459 repository
controls and required root health, lint, formatting and strict types pass.
Hosted zero-new Sonar and CodeQL remain required.

The actual governed corrected proposal guard execution also completes: all 224
baseline cases pass and its complete 86-mutant execution part produces 84 killed,
two surviving and 97.67%, with zero uncovered, invalid or unexecuted mutants in
142.002 seconds. The entire root response guard target separately completes all
83 mutants with 81 killed, two surviving and 97.59% in 56.104 seconds. Complete
ordinary Overlay Express coverage passes all 882 tests in 51 suites in 285.359
seconds, preserving every original source/coverage selector; its process group
is independently verified drained. These working-tree diagnostics do not replace
final exact-head hosted qualification or the complete proposal target aggregate.

The hosted lookup-service target initially produces 248 mutants and 97.15%, but
two invalid runtime results are unqualified. A pending physical operation can
reject on its timer after an earlier test assertion fails. The revised held-work
fixtures attach rejection ownership immediately, race operation entry against
early completion, and release/observe all physical operations in `finally`.
Every original assertion, all 18 cases and the 300-case generated cancellation
property remain. No production work, quota, deadline or cancellation behavior
changes. A copied negative comparison preserves the original failure: the old
fixture leaks its timer and exits after 30.438 seconds with a late unhandled
rejection, while the revised identical assertion failure exits in 0.605 seconds.
The revised copied full selection passes all 18 original cases.

After the complete coverage reader drains, the authored lookup-service union
passes all 68 tests in four suites. The actual governed complete 248-mutant target
then passes in 69.125 seconds, with 234 killed, six timeouts, eight survivors,
96.77% and zero uncovered, invalid or unexecuted mutants. The active LCH semantic
measurement does not consume this independent lookup-work test: its entire
original declared source/test/input union plus complete LCH and SDK packages
contains 936 hashed inputs, verified unchanged before and after this test-only
edit. Its broader initial diagnostic snapshot also contains unconsumed
application tests; that extra path change must remain visible and must not be
misrepresented as a changed consumed LCH input or exact-head qualification.

The earlier complete 227-suite package coverage result predates this independent
lookup-work cleanup. Its application implementation and coverage configuration
remain unchanged; the new complete affected union and mutation result supply
additional feedback. Final-head complete hosted coverage, all 141 canonical
mutation targets and every execution part remain required. The largest new LCH
295-mutant part is still under its original bounded measurement; the immutable
hosted campaign also retains wallet-codec and wallet-JSON deadline failures.
Neither partial progress nor a cancelled target completes checkpoint two.

### Installed-tool controls retain their required execution stage

The hosted peer feedback exposed a separate ordering problem before this
follow-up was pushed: the early repository-health job deliberately has no
installed dependencies. The new actual pinned-instrumenter inventory regression
and actual serialized Jest normalization regression require the frozen installed
tools. Both complete test blocks were relocated unchanged to
`scripts/mutation-partitions-engine.integration.mjs`; a before/after SHA-256
receipt confirms byte-for-byte preservation. Their execution is unconditional in
CI prepare immediately after the existing frozen, scripts-disabled installation,
before audited rebuild or workspace build. A required orchestration control
proves that ordering and rejects conditional or non-blocking execution. The cheap
controls retain all previous checks and additionally prove the complete source
line union, every original configuration setting and future-file fallback
without loading installed engines. No dependency was added to the early gate.

An isolated 5,207-file authored-source fixture with no `node_modules` passes all
459 cheap controls with zero skips. The first fixture attempt lacked Git metadata
required by existing repository inventory tests and failed eight such controls;
that initial result is retained. Adding isolated detached read-only base/main
references and an isolated index, backed by a read-only object-store alternate,
made the full original discovery runnable without changing the source checkout
or installing dependencies. The complete four-file installed/control union
passes all 96 tests, including both unchanged actual-tool regressions. Strict
application test-fixture compilation and explicit new-file formatting also pass.
These checks address execution ordering; they do not replace final-head hosted
qualification.

The immutable `6d7005f` full campaign additionally reached the existing
five-minute baseline limit for `private-publication-service/binding` and the
existing execution limit for `overlay-proposal-admission/whole` after its
complete baseline passed. Those failures remain unqualified. The unchanged
actual local binding part has passed its complete 263-test baseline in 118
seconds and continues under its original supervisor bound. No causal claim is
made from the difference between local and hosted elapsed times.

### Actual remote analyzer profile correction

The pushed `c67a14e13` head passes hosted cheap health and the mandatory
installed-tool integration step, but its actual Sonar profile reports four
findings in the new installed regression file: three explicit awaits inside
loops and one default lexical sort. The remote PR analysis and all four
findings are retained. The prior local recommended-rule comparison did not
include every remote rule and was not a substitute for that gate.

The correction uses serial async generators consumed with `for await` for
target inventories, execution-part inventories and serialized Jest project
reads. A generator waits for each yielded promise before invoking the next
read; instrumentation and configuration normalization remain serial. Explicit
UTF-16 lexical comparison with nonmutating `toSorted` preserves the original
stable tuple order. Every original count, complete-union, settings-identity,
future-source, matrix and child-project assertion remains. A typed 102-source
JavaScript analysis independently reproduces all four original findings under
the corresponding actual rules and reports zero on the corrected file. The
complete four-file installed/control suite passes all 96 tests without skips.
Final-head remote reanalysis and complete campaign evidence remain required.

### Complete covenant stages and remaining bounded execution

The original 295-mutant covenant execution part reaches its unchanged 45-minute
limit without a complete report. All 936 declared consumed inputs remain
unchanged through termination; no score or qualification is inferred. The
private-publication binding part separately completes all 146 mutants in
1,733.455 seconds: 134 killed, twelve survived, 91.78% and zero uncovered, invalid
or unexecuted mutants. All 1,145 consumed source/configuration hashes remain
unchanged. Its immutable hosted baseline failure remains recorded independently.

The covenant terms validator now separates standing mechanism checks,
authenticated Offer, individual consent and listing binding, selected capability
and accepted policy, and content resolution. The original validation expressions,
order, public signature, returned fields and error codes remain. Its new helper
blocks introduce eight additional mutants; the new canonical inventory is 503,
not a relabeled 495. Exact pinned-engine replay covers every new tuple once,
across parts of 68, 82, 47, 96, 78, 65 and 67. The complete original 89-test union
in twenty suites passes in 77.599 seconds with the original 300-case properties,
seed, replay and interrupt limits; all 1,250 recorded source/configuration hashes
remain unchanged.
The largest 96-mutant part completes in 1,266.515 seconds within the original
45-minute bound: 76 killed and twenty survived, 79.17%, with zero uncovered,
invalid or unexecuted mutants. All 1,250 recorded inputs remain unchanged. This
partial report does not enforce or satisfy the original full-target minimum
score of 90%; the complete 503-mutant aggregate is still required.

Additional execution subdivisions preserve every original wallet recovery codec
and proposal admission mutant: 264 and 336 respectively. Only the existing
private-publication access part is refined from 104 to 95 and nine; every other
publication part remains identical. Its prior complete-file selector remains a
diagnostic alias, while canonical aggregation requires both refined parts.
All 141 canonical target definitions and every original source, test, additional
input, configuration, property, runner, worker and budget setting are unchanged.
An independent before/after comparison confirms the 137 unaffected execution
plans and every non-access publication part are identical. The full derived
matrix has 246 rows. Both additive pinned artifact downloaders run before
canonical aggregation, with the original selection guards.

The initial complete controls reject source boundaries shifted by canonical
formatting and downloaders placed after aggregation; those failures are retained
and corrected. The complete installed/control union passes all 96 tests, and
workspace health, lint, full formatting and strict type checks pass. LCH build
and lint also pass. Actual-rule typed analyzer comparison retains the four
original remote findings and reports zero for the correction. Main-base
comparison across the five changed code files introduces zero recommended-rule
findings, without calling inherited findings a clean full-file scan.

The older immutable full campaign exposes further original deadline and baseline
failures. Smaller complete execution parts do not repair a five-minute baseline
timeout; original-profile reproduction and performance measurement remain
required. If the necessary derived execution inventory exceeds GitHub's single
matrix limit, its dispatch must be partitioned without losing canonical rows,
increasing concurrency or weakening any original receipt or final gate. That
follow-on design is separately coordinated before shared controls change. All
failures remain visible. A final blank-selector campaign must still independently
qualify every canonical target and execution part on the exact published source.

The exact published `26b0963f` head passes hosted Sonar and CodeQL, but its full
application coverage run remains red: 226 of 227 suites and 3,346 of 3,347 tests
pass, while the native purchase-buyer property reaches the original 150-second
interrupt after 227 of 300 cases. The complete run finishes in 1,305.244 seconds
within the existing coverage supervisor allowance. The failed property and
all original limits remain; 227 cases do not substitute for 300. A full
300-case native buyer CPU profile without coverage passes in 79.981 seconds,
with every recorded input unchanged. JSON parsing and durable JSON handling
are the measured major costs. A first outside-only plain-string parser candidate
preserves 40,028 tested string/UTF-8 outcomes but is slower in all five paired
rounds and is not adopted. Microbenchmarks and individual property profiles do
not qualify the full package or final hosted head.

Complete LCH package coverage, including every original suite beyond the
covenant target's 89-test union, passes all 245 tests in 37 suites in 80.398
seconds with the original global thresholds and 300-case properties. All 1,250
recorded inputs remain unchanged. Exact-tarball browser and public export/bin
checks also pass. An earlier coverage diagnostic selected the covenant-only
89-test union against package-wide thresholds and correctly failed those
thresholds; that incomplete package run is retained and does not count as
package qualification. A separate original native buyer property with coverage
enabled completes all 300 cases in 79.177 seconds, while appropriately failing
the unrelated package-wide coverage threshold because it selects only one
suite. It is a performance profile, not package qualification. The full
227-suite coverage profile is separately measured with serial workers to
isolate contention while retaining every case, deadline and global gate.

### Complete serial coverage and immutable execution batches

The complete original application coverage selection passes all 3,347 tests in
227 suites with one worker, the original global thresholds, 300-case properties,
seed `3242026`, empty replay path and unchanged 150-second property interruption.
Jest completes in 1,028.073 seconds within the existing 2,100-second supervisor.
All 2,208 recorded source/configuration hashes remain unchanged. Native buyer,
native wallet and acquisition coordination properties complete in 73.526, 59.503
and 52.072 seconds. The canonical coverage configuration now uses this measured
serial scheduling while retaining complete discovery and its worker memory
boundary; mutation runner settings remain separate. This local diagnostic does
not qualify the final hosted commit.

The preceding published `a59b5856` run retains two coverage failures: original
native publication and purchase-buyer properties interrupt after 297 and 270
of 300 cases. That full run passes 3,345 of 3,347 tests and 225 of 227 suites in
1,146.22 seconds; 49 other hosted checks pass and four checks are explicitly
skipped. These partial properties remain failures. A fresh hosted complete run
must establish the effect of serial scheduling on the eventual candidate.

The runtime held-worker fixture now checks that close has actually aborted the
active signal before waiting for work to finish. Its `finally` block releases and
awaits the already-observed work before closing the observer. Every prior lifecycle
assertion remains. With an isolated empty-close counterexample, the original case
times out after five seconds and leaves work active; the strengthened case fails
immediately and drains that work. The complete original runtime selection passes
all 117 tests in 5.689 seconds with unchanged recorded inputs. This demonstrates
fixture cleanup and the missing abort assertion; it does not independently
reproduce or resolve the earlier Stryker runtime error. The complete 431-mutant
runtime replay remains required.

Scheduling now supports execution inventories larger than one GitHub matrix.
`mutationExecutionMatrix` remains the canonical flat inventory. The additive
planner creates ordered slices of at most 256 rows and verifies their exact union.
Outer batches execute serially; the reusable executor preserves inner concurrency
of six for ordinary CI and twenty for qualification, both fail-fast settings,
every original 45/90-minute target allowance, four mutation workers, frozen
installation, original baseline/property limits and all score/coverage/validity
requirements. The current 141-target, 246-row inventory is unchanged. Further
source subdivisions require their own complete inventory proof and coordination.

Each invocation checks out the original caller SHA and binds the original run,
attempt, uploaded build artifact ID/name, archive SHA-256 and complete flat-matrix
digest. Verification rederives the selected matrix and exact batch before archive
extraction or test execution. A moving branch cannot supply later batches. Both
new execution controls participate in the original affected-target selection and
final configuration fingerprint. Existing artifact names and independent
canonical partition aggregation remain; the final issuer still requires every
canonical target, exact original source/settings and same-run complete receipts.
Missing, failed, cancelled, repeated, stale or diagnostic evidence cannot produce
`qualifiedSha`. Empty scope retains the existing explicit skip rule. Boundary and
negative controls exercise the actual required CI gate as well as the planner;
synthetic multi-batch controls do not substitute for a full hosted campaign.

Outside-only JSON/string and private-binding cache experiments remain unadopted.
Preserving sampled outcomes or improving one profile does not establish complete
compatibility or qualification. All failures and original budgets remain visible;
checkpoint two remains open pending a clean exact-source complete hosted campaign.

The workflow-governance companion follows only the real `mutation-tests` job's
exact local executor call, an existing `workflow_call` declaration and the actual
mutation runner in the execution job. Missing or changed callers, executor files,
commands, comments-only substitutes and external workflow paths fail; original
inline execution remains compatible. Required caller fields remain on the caller.
Combined pinned-engine, scheduling, selection, receipt and governance
controls pass all 153 tests without skips. All four required root checks pass;
main-base recommended-rule comparison across eleven changed code files introduces
zero findings, with 45 inherited baseline findings and 41 current findings.
Typed actual-rule analysis covers 907 source files and finds zero in the new
planner and its controls; inherited whole-file findings remain recorded. A final
runtime fixture rerun passes all 117 tests in 5.429 seconds with unchanged recorded
inputs and no open handles. These checks make the corrective batch reviewable;
fresh hosted source qualification remains mandatory.

### Remaining complete execution ranges and installed workflow controls

Six further execution plans divide root request/serving records, root journals,
root database storage, private publication admission, publication state and
publication service records at complete function or class-member boundaries.
All 141 canonical target definitions remain identical, as do the other 135 plans.
The unchanged publication identity, evidence, contracts and service-record parts
retain their original complete modules. The storage interface module accompanies
the first nonempty database part in its entirety, including any future executable
content; it cannot form an empty standalone job or lose its destination. Unknown
future files remain included once. Existing complete file-part CLI selections
remain diagnostic aliases, while canonical aggregation requires every refined part.

The actual pinned instrumenter verifies the exact mutant tuple union for all six
plans, with 484, 463, 357, 374, 943 and 456 mutants respectively. Every execution
part is nonempty, and original test selections, input fingerprints, runner options,
property strength, deadlines and canonical score gates remain unchanged. The full
execution matrix now contains 274 rows in two ordered batches of 256 and 18.
Both new root plans have guarded artifact collection before their canonical
verification; a successful part alone cannot qualify its target.

Hosted CI at `c7cbc139f` exposed three failures in the additional installed
`scripts/ci-integration/*.test.mjs` directory. The preceding 153-control local run
included the installed engine integration but omitted that separate directory.
Its original workflow assertions still expected inline mutation job steps and
concurrency and did not supply the new batch environment to the actual CI gate.
These are retained failures, not successful qualification. Complete discovery of
that installed directory, preservation of its original positive and negative
cases against the actual reusable executor, and a fresh exact-head hosted run
are required before checkpoint two can close.

The installed companion now follows only the actual local reusable executor and
checks both serial outer batches and the original six/twenty inner concurrency,
unchanged 45/90-minute routing, profiles, same-run build archive, whole-target
receipts and final raw-part recheck. Every original publisher and selection case
remains, with derived batch input and additional missing/stale/malformed rejection
cases. All 167 combined controls pass without skips, including complete discovery
of the twelve installed CI tests. Recommended-rule comparison introduces zero
findings in the four changed code files. Typed analysis covers 146 source files;
the only finding is the publisher control's unchanged complexity of 21, whose
complete source is identical to `main`. Authored partition comparisons now use
explicit comparators without removing their original union assertions.

The complete hosted runtime diagnostic at `c7cbc139f`, run `37155872712`, retains
431 mutants: 322 killed, 69 timeouts, 38 survivors and two runtime errors, for a
valid-mutant score of 91.14 percent. The two invalid mutants correctly fail the
zero-invalid policy. The abort assertion and cleanup counterexample therefore
have not resolved complete runtime qualification; both reports require further
diagnosis. This partial diagnostic cannot issue full-registry qualification.

### Held-projector and pending-context fixture cleanup

The two reported guard tuples are killed normally by a local, isolated
pinned-engine diagnostic over their source region with the original full
117-test baseline and runner settings. That twelve-mutant diagnostic does not
reproduce the hosted late runtime error and cannot qualify the whole target.
It is retained separately from the complete hosted failure.

A standalone full-selection counterexample with the guard forced false exposes
a cleanup gap. It finishes the test suites in 5.665 seconds with 23 failing and
94 passing tests, but the process takes 16.880 seconds and warns about open
asynchronous handles. The held-projector case creates an unobserved flush and
can fail before releasing it or closing the runtime. The corrected fixture
observes rejection immediately, retains every assertion, checks the successful
outcome explicitly, and releases and drains the work in `finally` before closing
the observer and runtime. Held projection reads and pending context changes also
have immediate outcome observation and unconditional draining. The observer
fixtures pull the same existing iterator with `for await`, retaining event order
and their final success assertions.

The same false-guard counterexample still fails the same 23 tests after the
change, but exits promptly without the open-handle warning. The outside draft
exits in 5.785 seconds; the canonical correction exits in 4.572 seconds. The
unmodified runtime passes all 117 tests with original 300-case property strength,
seed, replay and time limits, and unchanged recorded source/configuration inputs.
Production code, mutation inventory and runner settings are unchanged. This
establishes meaningful fixture cleanup; a complete hosted replay of all 431
mutants must still establish that no late error contaminates another mutation.

### Owned protocol values and unchanged wire parsing

The subsequent exact-source runtime replay at `71be7336f` passes the complete
431-mutant hosted report: 313 killed, 80 timeouts, 38 survivors, 91.18 percent
and zero uncovered, invalid or unexecuted mutants. Hosted run `37158761804`
retains the original complete baseline, source union and runner settings. The
complete lookup-service replay `37159067332` also passes all 248 mutants at
96.77 percent with the same zero gates. These are component receipts; the
blank-selector campaign and complete final-source qualification remain required.

Ordinary hosted CI `37158529525` remains failed. The full covenant-buyer
property completed 247 of its required 300 cases before the original 150-second
interruption, and the application coverage shard reached its original
35-minute deadline after 202 of 227 suites passed. Full mutation campaign
`37159615740` also retains deadline failures after successful initial baselines.
No cancelled job, partial report or older component receipt qualifies that
campaign or the final branch.

Measured profiles identify redundant value-to-text-to-parser ownership work in
the application and SDK schema paths. The additive SDK `ownOutputJSON` helper
performs every existing canonical representation and resource check, parses
only its own generated canonical text, and recursively gives the resulting
owned records null prototypes. Arrays remain ordinary arrays; data descriptors,
canonical text and separate copies of repeated caller references match the
existing composition. Raw incoming text and bytes continue using the unchanged
duplicate-aware parser. Packet schemas, fresh permission and capability checks,
ciphertext, scripts, transaction bytes and persisted records remain unchanged.
Application value-ownership compositions and the central SDK schema value path
use the helper without adding a cache or reusing external authority.

The original SDK JSON tests and properties remain. A complete schema test module
and a 300-case nested ownership property add independent value, byte, prototype,
descriptor and alias checks, all resource boundaries, invalid representation
refusals and preserved raw duplicate evidence. The original `sdk-output-json`
mutation target adds the whole schema source and test module; it retains the
original JSON source and both full test selections, canonical target count,
workers, reuse, strength, seed, replay, deadlines and qualification gates.

The focused canonical SDK selection passes 97 tests in three suites. The clean
original complete buyer baseline passes 55 tests in eight suites in 258.906
seconds. The owned-value candidate also passes that complete selection, all
native wallet routes and all 300-case properties in 297.588 seconds, with every
recorded consumed input unchanged. Its profile shows reduced raw parsing time
but substantially increased SQLite transaction wall time. The whole-selection
result therefore does not demonstrate a runtime improvement. Both receipts
remain diagnostic; full coverage, mutation, platform and exact-head hosted
validation are still required, with all original durability and timing controls.

The whole local SDK JSON mutation replay covers 498 mutants and all 97 baseline
tests: 453 killed, six timeouts and 39 survivors, 92.17 percent, with zero
uncovered, invalid or unexecuted mutants. The first complete run retained one
Jest formatter runtime error when a deliberately wrong array prototype reached
a direct Node assertion. The direct schema oracle now uses Node's independent
strict comparison as a boolean assertion; the same complete 498 canonical
mutants are retained and that tuple is killed normally. Production code and
qualification settings are unchanged between those two runs. Both reports
remain available; a passing retry does not erase the earlier invalid report.

Complete local SDK coverage passes all 8,350 tests in 257 suites with its
original thresholds. Complete application coverage passes all 3,347 tests in
227 suites in 1,086.873 seconds: 98.17 percent statements, 96.56 branches,
98.44 functions and 98.78 lines. Its original published serial configuration,
300-case properties, seed, blank replay and time bounds remain unchanged. Each
reader records unchanged consumed inputs through actual process drain. The SDK
coverage reader uses serial local scheduling; it does not establish hosted
worker qualification. These dirty-source local receipts validate the candidate
batch and do not replace complete final-source hosted CI or the same-run full
canonical mutation campaign.

Exact-tarball SDK and application checks pass all existing conditional/wildcard
exports, source maps, publint, strict type resolution and clean consumers. The
SDK check additionally asserts the helper at root and the complete JSON entry.
All original browser entry budgets and runtime checks pass. The complete native
reference selection and all three original Chrome profiles pass on this batch:
two final-output host profiles, including actual Engine/Mongo admission, and
the private non-final profile. They demonstrate progressive and live updates,
offline replay, source membership, reload, durable spent state, native IndexedDB
reopen, provider restart and expiry with zero browser exceptions. The private
profile retains exactly two original Opens. Each bounded reader records unchanged
consumed inputs through actual drain.

All 62 documentation examples compile against 24 exact package tarballs. The
conformance runner parses 6,700 vectors in 77 files without structure errors;
this structural check does not independently execute their cryptography or
Script semantics. The unexcluded advisory audit finds no known vulnerabilities.
Changed-code recommended and raw typed comparisons introduce zero findings.
Fresh pinned inventories also catch moved function boundaries and three changed
factual counts. Execution ranges are reconciled to complete function starts,
with every current canonical tuple required exactly once. All original test,
source, settings, nonempty, uniqueness and qualification assertions remain.
The earlier failed inventory control remains evidence; neither its factual
correction nor these local component results establishes final hosted readiness.

### Complete recovery ownership and native fixture lifecycle refinement

The compatible owned-value batch was committed and pushed as
`ab1a161bb6e3671e2c0ff8d556af87576427d159`; local, origin and PR #674 heads were
read back as identical. Its complete installed controls pass 491 tests with no
skips, and the final four required root gates drained at
2026-10-04T01:23:29.470498Z with unchanged inputs. The fresh hosted ordinary run
37168039858 has successful SDK/wallet coverage, packing, documentation,
browser/mobile and unchanged zero-new-Sonar gates. CodeQL 37168039680,
conformance 37168039677 and container contracts 37168039660 are terminal success;
the PR alert query reports zero open CodeQL alerts. Application-related coverage
was still pending at this observation. This is an intermediate published head,
not final checkpoint-two qualification.

The next local structural batch extracts wallet recovery scalar/array/record
ownership into a fresh call-local internal context. The public encoder invokes
one new context per call, retains its exact final UTF-8 byte check, and preserves
all existing depth, item, Unicode, prototype, descriptor, cycle, key ordering,
undefined-value and error rules. The whole helper is appended to the existing
canonical encoding target; existing consuming recovery input globs include it.
The original full source and test union is retained. Private purchase progress
and native-record restoration use smaller internal helpers with the same ordered
checks, local observation requirements and error identities. No authority is
cached, no financial effect is introduced, and no wire or stored schema changes.

Execution bands use unique source anchors at complete functions/class methods.
Explicit old numeric plans remain supported. Ambiguous starts/markers, missing
or repeated anchors and invalid bands fail closed. Full pinned-engine inventories
prove every current canonical tuple appears once and every part is nonempty:
141 canonical targets now produce 357 execution rows, scheduled as 256 and 101.
Private purchase state has 996 mutants, native-clock composition 1435, and wallet
recovery encoding 167. Other existing whole-source inventories and every original
source/test/property/runner/reuse/deadline/score/zero/same-run gate remain. Moving
source cannot borrow any earlier score. One factual overlapping-range assertion
failed after the methods moved; the retained failure was corrected to the actual
new boundaries. The full focused control set then passed 113 tests with no skips.

The adopted complete native wallet baseline passes 237 tests in 21 suites and
actually drained at 2026-10-04T01:37:31.994155Z in 65.863 seconds, with every
consumed input unchanged. All original six selection patterns, 300-case strength,
seed 3242026, blank replay and original limits remain. The independent outside
candidate and the earlier harness failures remain separate diagnostic records.
The recommended analyzer comparison covers 15 changed code files and introduces
zero findings; root strict typecheck passes. Complete package and hosted final
source qualification still follow these component results.

Retained failed reports identify native root cleanup exceptions in a shared
`afterAll` hook. Each complete SHIP/SLAP workflow now creates and closes its own
fixture inside its original ordinary test and 90-second limit. Cleanup attempts
every owned resource sequentially and reports all failures rather than abandoning
later handles or swallowing errors. The full original root baseline passes
308 tests in 32 suites, including both native Engine/Mongo/SQLite/authenticated
serving compositions, and actually drained at 2026-10-04T01:39:36.071640Z in
80.978 seconds with unchanged inputs. An additional real SQLite regression proves
that a failed close acknowledgement still closes the reopened journal and removes
its directory while retaining the failure. Every earlier workflow assertion is
preserved. Independent signing of all 257 FIFO test packets is fixture preparation
under the unchanged hook limit; its test still performs all original retains and
258 real signature verifications. The complete baseline includes preparation cost;
the FIFO body took 845 milliseconds. Neither a test limit nor a supervisor was
increased.

The retained proposal-admission report and private-publication retained-history
report identify the same Mongo teardown cause: one rejected concurrent recovery
made `Promise.all` return before the other requests settled. The fixture now
unconditionally awaits all original requests before native teardown, preserving
the original failure and every original assertion. The private-publication archive
11290031644 has verified SHA-256
`777e2075d940253f14c2aa5a885f86364be72125aeccabc03a3e82d62d61cb46`;
its 16 runtime errors all point to that same teardown. No additional production
admission change is inferred from this report. Full fresh affected mutation
execution must still prove the correction; a failed receipt is not qualification.

The complete unchanged serial application coverage command started at
2026-10-04T01:42:41.790448Z with the full original selection plus the new native
cleanup regression, original 300-case properties, seed, blank replay,
150-second interruption and 2100-second supervisor. Its consumed source and
controls remain frozen until actual drain. Its eventual outcome is recorded
separately; this entry does not claim that pending coverage passed. Final hosted
qualification, complete same-run canonical mutation and all reference/platform
profiles remain mandatory before checkpoint-two review.

The complete application coverage reader actually drained at
2026-10-04T02:00:43.917129Z in 1082.005 seconds: all 3,348 tests across
228 suites pass, with zero skips or runtime errors and all 2,523 captured
inputs unchanged. Coverage is 98.17 percent statements, 96.56 branches,
98.45 functions and 98.78 lines. After that drain, static feedback identified
one introduced `no-await-in-loop` finding in the owned test-fixture cleanup
helper. An equivalent ordered promise chain replaces that loop; it still
attempts every resource and preserves every failure. The outside candidate
introduces zero recommended/static findings. Fresh complete native-root and
final source validation follow; the prior coverage receipt remains evidence
for its exact earlier input bytes and does not certify this changed fixture.

Type-aware analysis exposed two inherited wallet ownership findings on the
new helper: mixed return sites and a redundant null comparison after the
explicit null branch. A single result return and the logically equivalent
object/cycle condition remove those findings while preserving the ordered
validation, JSON value ownership and every stored byte/error rule. The
outside helper passes strict checking across 641 program files and all raw
recommended rules. Its initial compiler-host harness failed to resolve
package-local Node/Jest types; that failed harness is retained, and the
corrected host uses the original wallet package directory. The fresh pinned
whole inventory has 167 encoding mutants (50 scalar/object-dispatch, 21 array,
41 record, six wrapper and 49 binary), all present once across the same five
nonempty parts. No canonical target or operator exclusion changes. The
original complete native wallet selection and final type-aware comparison
are rerun on this source before publication.

The fresh canonical wallet selection passed all 237 tests in 21 suites and
actually drained at 2026-10-04T02:09:03.007951Z; the fresh complete native root
selection passed 309 tests in 33 suites and drained at
2026-10-04T02:11:27.233452Z. The original full publication selection passed
363 tests in 25 suites and drained at 2026-10-04T02:15:01.089925Z. Each
receipt records unchanged inputs and original bounds. These component results
remain separate from final whole-branch qualification.

Published head `ab1a161` passed 49 hosted checks and four expected scope skips,
but the application coverage shard failed its 150-second purchase property
interruption after 270 of 300 cases and subsequently reached its 35-minute
supervisor. The failed logs remain retained. No test strength or deadline changes.
The updated native ledger still authenticates the current SQL head and inventory,
checks current permission, and performs every original active-key seal, even for
unchanged reads and rejected work. It avoids only a redundant SQL head update
when the transaction's authenticated canonical plaintext and custody key label
both match the newly sealed head. Rotation always writes; missing custody still
fails; advancing observations remain durable on refusal. Comparison metadata
exists only inside that one transaction. Locks, savepoints, FULL synchronization,
commits, schemas and external-effect rules remain unchanged.

Independent native SQLite regressions prove unchanged ciphertext after unchanged
reads, fresh authorization and another handle's writes, durable refusal clocks,
pure-read rotation of an unchanged empty head, and refusal when the active write
key disappears. The outside full original buyer selection passed all 55 tests in
eight suites, including both 300-case properties, and drained at
2026-10-04T02:31:15.116378Z in 247.815 seconds. The outside complete native
selection plus all three new regressions passed 54 tests in two suites and drained
at 2026-10-04T02:33:07.438432Z. The earlier wrong SDK-entry harness failure and
initial outside-root selection omission remain retained as failed/partial
feedback. Compiled child implementations remained canonical in these outside
checks and cannot qualify the changed native source. No causal or hosted speed
improvement is claimed. Whole-branch validation on the adopted source follows.

The final pinned engine inventories include every current tuple exactly once,
with all parts nonempty: 141 canonical targets produce 358 execution rows
(256 plus 102), and the updated native-clock composition has 1471 mutants.
Only its complete new private method anchor and derived counts change; every
existing canonical source and qualification setting remains.

The original complete 650-mutation HTTP candidate passed all 109 original
baseline tests, then reached the unchanged 2700-second supervisor. It ended at
2026-10-04T04:03:25.677694Z with exit 124 and no final mutation report. Every
captured source and configuration input remained fixed. Six native Mongo
children briefly outlived the parent; its whole owned process group was observed
absent at 2026-10-04T04:03:51.075724Z before any source edit. This is retained as
failed qualification. Its baseline establishes ordinary initialization and the
original selection, without establishing a mutation score or checkpoint readiness.

The pinned sandbox copies inputs, builds and then links node_modules. Three
incremental TypeScript metadata paths formerly created node_modules during that
build, preventing the link. Only those metadata files move to .cache; all
compiler and emit options remain unchanged. Both Jest projects use the installed
default cache root and retain independent project identities and their original
CommonJS/ESM transforms. Actual serialized normalization verifies original
selections, ignores, instrumentation, exact peer aliases and local mutable
sandbox routing. SDK, core Overlay and LCH peer modules stay independent captured
inputs. Existing application and Mongo aliases precede the generic local-module
fallback. Additive fixture and LCH fingerprints include dependencies already
imported by the unchanged HTTP selections.

The complete purchase HTTP target now has 15 complete-method execution parts
with unchanged tests, properties, workers, reuse, original bounds and score and
zero-error gates. The type-only ports remain in a nonempty part; future canonical
files join the remaining full-source part. Independent pinned-engine replay
passes at 2026-10-04T04:17:22.967260Z: every original 650 tuple appears exactly
once and every part is nonempty. Fresh adopted installed controls pass all
494 tests with zero skips at 2026-10-04T04:18:31.210556Z, in 4.452 seconds.
They retain all 15 prior semantic inventories and add this complete HTTP inventory,
with 141 canonical targets and 372 execution rows (256 plus 116). This schedules
complete qualification; it does not substitute for the final same-run aggregate
or final hosted checks.

Fresh ordinary native recovery and reconciler boundaries pass all 72 cases at
2026-10-04T04:14:47.409991Z in 3.895 seconds. Disclosure passes all 33 cases at
2026-10-04T04:15:11.023744Z in 3.309 seconds. These preserve all original cases
and cover synchronous authority, pinned methods, record classification,
unavailable projections, retained funding phases, absent work, observer failures,
bounded cursor wrap and native send ownership. An initial 71-of-72 run correctly
rejected a fixture's reused invoice prefix. Only the second fresh quote's prefix
was corrected; that failed receipt remains retained. No production fence changed.

The retained prior SDK campaign also has a distinct failure: its core part had
five runtime errors from an initial-response waiter timing out while transport
send remained pending, and the known aggregate is below the original 90 percent
gate. Immediate rejection observation still awaits the original response and
preserves the original deadline, transport failure and exact session/listener
cleanup. All six original-plus-slow-send cases pass at
2026-10-04T04:15:22.581566Z in 1.735 seconds. The complete original lookup
transport selection plus eight compatibility cases passes 61 cases at
2026-10-04T04:16:44.253122Z in 3.907 seconds. Observable refusal reasons,
identity encoding and inclusive checkpoint boundaries are exercised. Nullish fetch
retains its platform fallback, and opening may omit its optional rules selector.
An initial 60-of-61 attempt asserted a detailed reason on the outer authentication
error. The corrected test observes the bounded fetch-stage reason while preserving
the original normalized outer code; the initial failed receipt remains retained.
No production transport policy, wire encoding, deadline or threshold changes.

Every successful component receipt above records unchanged captured inputs and
an independently empty owned process group before adoption. Complete adopted-source
SDK/application coverage, native/platform/packed consumers, documentation, all
three browser references and final exact-head security/source checks follow.
No earlier receipt or ordinary component pass qualifies checkpoint two by itself.

The coherent batch passed all four required root checks in 56.721 seconds at
2026-10-04T04:22:56.667929Z. Additional raw analyzer feedback identified ten
new test issues, then one callback-return issue. The tests now use explicit
pinned-owner and refusal-message maps and separate observer functions. Assertions,
cases, authority behavior and original limits are unchanged; no suppression or
baseline alteration was introduced. Both failed analyzer receipts remain retained.
Fresh raw recommended analysis reports zero introduced findings across 25 files
at 2026-10-04T04:26:40.883625Z; typed analysis reports zero introduced findings
across 17 files at 2026-10-04T04:26:17.502527Z.

On the actual canonical source after those corrections, complete recovery and
disclosure files pass all 105 cases in two suites at
2026-10-04T04:29:36.603294Z, in 5.656 seconds. Complete SDK handshake-boundary
and lookup-transport files pass all 67 cases in two suites at
2026-10-04T04:29:50.140639Z, in 2.352 seconds. Original package configurations,
deadlines and test unions remain; neither run skips a case. Captured inputs stayed
unchanged and both process groups were verified empty. Required root checks are
repeated on this final coherent authored batch before pushing. Whole-source,
platform, documentation, browser-reference and exact-head hosted campaign gates
remain pending, without transferring qualification from earlier source versions.

The coherent batch was committed and pushed as `010d97eee4429c90d27e6a0c00e76a5723968d39`.
All four SDK, wallet, application and Overlay Express builds pass on that source.
Complete SDK coverage passes 8,360 tests in 257 suites at
2026-10-04T04:36:58.084296Z, in 218.712 seconds: 94.66 percent statements,
88.58 branches, 96.26 functions and 95.74 lines. Complete application coverage
passes 3,442 tests in 228 suites at 2026-10-04T04:54:24.226915Z, in
998.734 seconds: 98.34 percent statements, 96.81 branches, 98.63 functions
and 98.86 lines. Neither skips a case. Original source unions, global thresholds,
300-case properties, seed, blank replay, 150-second property interruption and
35-minute application supervisor remain unchanged. Both readers retain unchanged
captured inputs and independently empty process groups; no causal performance
claim is made.

Hosted analysis of that exact commit reports one new `javascript:S7780` finding
in the installed normalization control. The corrected transform key uses
`String.raw`, with independently identical UTF-16 and UTF-8 values. It changes
neither a selection nor an assertion. The correction was prepared outside the
frozen source and adopted only after the application reader's actual drain.
The failed hosted result remains retained. Package source and compiled dependency
bytes are unchanged by this control-only correction; final hosted verification
still follows the next pushed commit.

The complete reference application passes all 20 native tests in five suites
and all three actual Chrome profiles at 2026-10-04T04:56:39.186248Z, in
80.168 seconds. The private non-final profile reports exactly two Opens,
zero browser exceptions, native IndexedDB, owned HTTPS, provider restart and
proposal expiry. Wallet/application packing, strict consumers, actual wallet
browser and Metro/Hermes mobile profiles pass at
2026-10-04T04:58:29.465010Z, in 59.075 seconds. Complete SDK and application
browser checks retain every original budget and pass at
2026-10-04T05:00:34.575452Z, in 90.914 seconds. Compiled documentation
examples pass at 2026-10-04T05:01:09.688553Z, in 9.694 seconds.

These composition receipts additionally fingerprint all 4,424 actual compiled
dependency files in seven roots. Every captured byte and the complete runtime
file set remain unchanged; each process group is separately verified absent.
The single control-literal correction remains distinct from final complete
hosted qualification. The old failed campaign was cancelled after its complete
275-job metadata was retained. Current exact-source SDK client and transport
mutation parts pass; their complete core/aggregate and the final blank-selector,
same-run 141-target campaign remain pending. No component score, ordinary pass
or earlier source identity is substituted for those gates.

### Hosted performance and complete SDK execution follow-up, 4 October

The retained `010d97eee` hosted application log interrupted the original buyer
history property at 286 of 300 after its unchanged 150-second limit. The full
local application coverage pass did not qualify hosted performance. The full
original buyer selection was profiled without narrowing: 55 tests/eight suites,
both 300-case native properties, seed 3242026, blank replay, and original limits.
It passed in 233.139 seconds; the buyer property took 79.921 seconds.

An outside candidate retained the independently parsed value and validated
canonical text from the current protected-ledger decode. Head comparison and
record shape/byte-length checks reuse those owned results. Every later call
still decrypts and validates afresh. Fresh custody and sealing, rotation,
authenticated inventory, authorization, clock/refusal persistence, record
bounds, errors, schema, locks, savepoints and FULL synchronization are preserved.
No private value or authority is cached across calls. The identical buyer
selection passed in 219.643 seconds, with its buyer property at 65.764 seconds;
this local comparison is not a hosted performance qualification. The complete
original native selection also passed 277 tests/16 suites. All consumed bytes
and all 4,424 compiled dependency paths were fixed, and groups 44036/45397 were
absent before adoption. An initial outside native harness omitted the original
TypeScript transform and ran zero tests; that failure is retained separately.
Five additional authenticated-restoration cases now check null, array, string,
number and boolean records against the original refusal/error contract.

SDK diagnostic run 37177374408 on `010d97eee` passed the client and transport
parts: 240 of 250 detected (96%) and 86 of 91 (94.51%), with zero invalid or
uncovered mutants. Verified archive digests bind those reports to that run,
attempt and source. Its oversized core part passed the full 381-test baseline,
then reached the original 45-minute hosted limit without a completed report.
The failed terminal log remains retained; no complete SDK score is claimed.

The SDK target now separates message validation, lookup and finite HTTP into
complete file parts alongside the original client, transport and remaining
Peer/future-core part. Every part keeps the same full test selection and all
original settings; every original mutation tuple appears exactly once. The
canonical aggregate still requires 90% and zero invalid/uncovered mutants. The
complete matrix contains 141 canonical targets and 375 execution rows, in
ordered batches of 256 and 119. Current pinned inventories contain 1,483 native
clock mutations and 890 SDK authentication/HTTP mutations. Method anchors stay
unique, exact and ordered; ambiguity or a missing method still fails closed.
The earlier 372-row evidence describes the preceding plan and cannot qualify
the new complete campaign. Adopted builds, full coverage, installed controls,
reference compositions and exact-head hosted qualification follow before C2.

### Final local boundary and reference validation, 4 October

Hosted run 37178889968 on `b21aba89d` retained two application-suite
failures and reached its unchanged 35-minute lane deadline. Its buyer history
property stopped at 273 of 300 under the original 150-second limit. The
publication recovery comparison also exposed a test-clock assumption: its
fixture record could precede the independently verified accepted record by one
second. The test now snapshots that accepted original immediately after first
publication, then compares every field after recovery. No timestamp is excluded,
clock bound relaxed or production behavior changed. The complete affected file
passes all 21 tests on the adopted bytes.

Four additional SDK authentication cases retain exact malformed-message errors
under default, delegated and finite payload policies, and verify that nested
payload-shaped metadata still obeys the original message byte budget. The full
SDK coverage selection passes 8,364 tests/257 suites, zero skips, in 196.547
seconds (94.65% statements, 88.59% branches, 96.26% functions, 95.74% lines).
The original coverage thresholds, seed, replay and 1,800-second supervisor remain.
Group 56325 is absent after the actual 06:03:24.969411 UTC receipt.

The adopted production bytes also pass full application coverage: 3,447 tests/
228 suites, zero skips, in 1,012.259 seconds (98.34/96.81/98.63/98.86%).
All original 300-case properties, seed 3242026, blank replay, 150-second property
and 2,100-second supervisor bounds remain. The buyer history property completes
in 65.672 seconds locally; this does not qualify hosted performance. Group 51437
is absent after the actual 05:53:48.150433 UTC drain, before the subsequent
publication-test oracle adjustment. That test-only adjustment is covered by its
fresh full 21-test file; final-head full hosted coverage is still required.

The complete reference application passes 20 tests/five suites plus all three
actual Chrome profiles in 79.911 seconds. Private-state delivery records exactly
two Opens, zero browser exceptions, native IndexedDB, owned HTTPS, provider
restart and proposal expiry. Complete wallet/application exact packs and strict
consumers, wallet browser and actual Metro/Hermes profiles pass in 58.591 seconds.
Complete SDK/application browser contracts pass all original budgets in 90.479
seconds. Documentation compiles 62 examples against 24 exact tarballs in 9.524
seconds. Their receipts fingerprint all 4,424 compiled dependency files across
seven complete roots; bytes and path sets remain fixed. Groups
57142/57167/57438/59714/61127 are independently absent before subsequent edits.

Recommended and typed raw comparisons against the pushed `b21aba89d` introduce
zero findings, with the unchanged pre-existing finding retained rather than
suppressed or reclassified. The complete 494 installed controls and required
root checks pass on the adopted production/partition changes; fresh final
checks follow this evidence update. These local receipts do not replace complete
exact-head hosted coverage/security or the one blank-selector, same-run,
all-141 canonical/375-execution-row mutation qualification. C2 remains open.

### 2026-10-04 serialized protected-envelope follow-up

The pushed c159 hosted SDK diagnostic qualifies its complete890 canonical mutations at818 detected (91.91percent), with no invalid/uncovered/unexecuted entries; six parts, aggregate and hosted independent replay succeed. Fresh exact-head conformance/container/CodeQL and direct Sonar zero-new/zero-unreviewed gates also pass. These component receipts do not qualify checkpoint two: CI37182128560 retains the buyer property failure at289/300 within150seconds and application35-minute cancellation after208 passing suites. No clock expectation, selection, deadline, score or error gate is weakened.

A fresh full55-test/8-suite buyer CPU baseline passes in237.008seconds with both original300-case properties and seed3242026/blank path. An outside serialized-envelope candidate removes only redundant canonical copying/parsing after strict bounded text ownership; the existing object API and authenticated decrypt body remain. Its first outside harness cannot resolve the SDK; that failed receipt is retained. After correcting only modulePaths, the identical full selection passes55/8 in223.862seconds; buyer property66.009seconds versus72.239baseline. Additional all-selected protected-storage and original publication-availability regressions plus five new serialized boundary/compatibility cases pass486/21 in30.508seconds. Duplicate decoded keys, exact byte ceilings, malformed-shape error parity, provider refusal, fresh custody, tamper and binding changes are exercised. All6558 captured authored/compiled inputs and all4424 compiled paths are fixed; groups77459 and78488 are physically absent before adoption. These are local component measurements, not hosted performance or final mutation qualification.

The additive Node-only serialized method and ledger call are adopted together with their documentation and boundary cases. Fresh exact-source builds, coverage, package/platform/reference demonstrations, raw lint, required root checks and complete hosted qualification remain required before readiness. No wire encoding, SQLite schema, persisted format, authority, key retention, trusted clock, durability or transaction boundary changes.

The adopted pinned-engine replay observes1482 native-clock mutations (one redundant parser-call tuple disappears naturally), unchanged890 SDK tuples and141canonical/375execution rows. The expected native count follows the exact current instrumenter inventory; no source range or mutant is excluded. All five existing explicit protected-payload target selections additionally include the new serialized boundary file, and installed controls pass494/52 with the original settings retained. Four affected builds pass6.426seconds; recommended and typed raw comparisons introduce zero findings, retaining the one unchanged pre-existing typed finding. Complete final-source assurance remains open.

Compatibility review identifies existing virtual object-reader dispatch in the ledger. The first adopted coverage reader is deliberately stopped at721.788seconds for this concrete follow-up, unchanged6948 inputs/all4424 compiled paths; group80880 is physically absent before edits. Its interrupted result is retained and does not qualify coverage. The first new outside one-file harness has a module-mapper escape error and runs zero tests; that failure is retained. The canonical-config six-case regression then fails exactly at the subclass reader call count (five other cases pass), demonstrating the bypass before the fix. The serialized method now captures the current reader once before parsing and delegates custom subclass/instance/prototype readers with the original receiver and owned envelope. Only the original default reader uses the optimized decrypt path. The cached reference is a function identity, not a private result, custody or authentication decision. Tests additionally cover getter timing, original receiver and prototype interception. Fresh complete-source validation follows; no interrupted run is promoted.

Final adopted-source local follow-up: all four builds pass6.248seconds; six serialized boundary/virtual-reader cases pass with subclass, instance getter and prototype interception preserved. Complete selected protected/availability regressions pass487/21 in29.749seconds. Raw recommended and typed comparisons introduce zero findings, retaining the one prior typed finding; installed controls pass494/52 in4.409seconds. Complete original application coverage passes3453/229/no failures or skips in983.160seconds,98.34/96.82/98.63/98.86, all original300/seed3242026/blank-path/150/2100 controls unchanged. Buyer property66.018seconds; native wallet property60.295seconds.

Native20 and all three actual Chrome reference profiles pass79.520seconds. The private profile records exactly2Opens, zero exceptions, nativeIndexedDB, ownedHTTPS, provider restart and proposal expiry. Wallet/application exact packs and strict consumers plus walletbrowser and actualMetro/Hermes pass58.009seconds. Complete SDK/application browser budgets pass91.154seconds. Documentation passes62compiled examples against24exact tarballs in9.502seconds. Every consumed authored input and all4424compiled paths across seven roots stay fixed; process groups86778/90567/91060/94034/95240 are independently absent before subsequent consumed-source edits. These local receipts still do not qualify hosted performance, exact-head CI/security or the final blank-selector same-run141canonical/375execution campaign. Final root gates and fresh published-source qualification follow.

## Explicit serialized-envelope regression fixtures

The published `98a70ea435cde2d801d4c391fb64bd421360125e` CodeQL analyses report three incomplete-string-escaping findings (318–320) at first-opening-brace replacement expressions in the new synthetic duplicate-key regression fixtures. The inputs were intentionally malformed JSON, but their construction now directly prepends the added member to the original object text after its opening brace. This preserves the ordinary and escaped duplicate-key inputs, custody-before-parse refusal, one-capture virtual reader dispatch, all six cases and all original assertions. No finding is dismissed or reclassified; production codec and ledger bytes are unchanged.

The complete original protected-storage and publication-availability selection passes 487 tests in 21 suites with no failure, cancellation or skip after this test-only correction. Its complete authored inputs and all 4,424 compiled runtime paths remain fixed through the independent physical process-group drain. Final root checks and a fresh exact-head hosted analysis/coverage/campaign remain required. The previous-head hosted SDK coverage also passes all 8,364 tests in 257 suites, while its application coverage is still running; these current observations do not qualify the following source head.

## Required private ledger insertion flag

Published `34cc2f8ce0087ce5b4d8254459fc3ab2f1406060` passes complete CI, conformance, container contracts, strict Sonar and CodeQL. Its blank-selector mutation campaign `37190660296`, attempt one, nevertheless fails the uncovered-mutation guard in `private-purchase-native-clock/ledger-9`: 24 killed, two survived and one uncovered. The uncovered mutation changes the unused `insert = false` initializer of private `saveHead`. All three callers already pass an explicit flag: initialization passes `true`; both transactional updates pass `false`. Removing the unreachable initializer makes that private choice required without changing any caller, SQL operation, public interface, custody, authority, durability, Script, wire or persisted format. The failed immutable partition archive is retained; this campaign cannot qualify the corrected source.

The actual pinned engine observes 1,481 native-clock mutations after this removal, exactly one fewer. Its expected inventory follows that measured source change. SDK authentication/HTTP remains 890 mutations; 141 canonical targets and all 375 execution rows, in batches of 256 and 119, remain. No source, mutation operator, test selection or original qualification setting is excluded or weakened. Complete installed governance, scheduling, engine and inventory controls pass all 494 tests across 52 test files.

The complete original native-clock selection passes 288 tests in 17 suites in 60.151 seconds, with all original 300-case properties, seed 3242026, blank replay and 150-second property bounds. An initial outside diagnostic configuration incorrectly read the ESM configuration namespace and omitted its default export: zero tests executed and all 17 suites failed to parse TypeScript. That failed receipt is retained. Correcting only the outside configuration restores the unchanged canonical ESM/ts-jest settings and the full original selection.

The original focused ledger partition then reports all 26 remaining mutations: 24 killed, two survived and zero uncovered, invalid or unexecuted entries, in 184.136 seconds. The original 288-test selection, four workers and 45-minute ceiling remain. Its log also retains three recovered native-worker SIGSEGV diagnostics; they are not investigated by further crash reproduction or represented as clean hosted evidence. The successful controller result and complete report are local component evidence; final published-source qualification still requires the complete fresh hosted campaign.

Complete original application coverage passes all 3,453 tests in 229 suites, with zero failures or skips, in 986.520 seconds: 98.34% statements, 96.83% branches, 98.63% functions and 98.86% lines. All original property strength, seed/replay controls and the 35-minute application limit remain. Application build and installed controls also pass. Every captured authored/configuration byte and all 4,424 compiled paths across seven runtime roots stay fixed through each reader; each owned process group is independently verified absent before subsequent consumed-input changes. Required coherent-batch root checks and fresh exact-head CI/security, reference/platform profiles and one blank-selector same-run full campaign follow. No failed-run score borrowing or checkpoint completion is claimed.

## Bounded native scalar metadata ownership

Current-head application CI `37195017159` retains a timing failure: the original buyer property completes 293 of 300 cases before its unchanged 150-second deadline, and the application lane reaches its unchanged 35-minute ceiling. Passing component checks do not qualify that head. Two outside SDK parsing/serialization experiments were rejected because their complete original workloads did not improve; their diagnostic receipts remain retained and their source was never adopted.

The native metadata correction captures each SQLite header's kind and key exactly once. A currently supported, bounded lowercase ASCII kind and a 64-character lowercase hexadecimal key form an independently owned two-field address without a redundant general JSON ownership round trip. The original hexadecimal validator still runs. This is a conservative implementation shortcut, not a new kind restriction: every other representation uses the original ownership, resource and error path. Revision, capacity, inventory, sealed-record integrity, fresh custody, authenticated metadata, trusted observation and transaction checks remain. No private value, key, authority or authorization decision is cached.

Action-recovery byte ownership delegates numeric index conversion to native property lookup. Every byte still requires its own enumerable data descriptor and an integer from zero through 255 before entering the owned buffer. Array holes, accessors, coercion, out-of-range values and oversized inputs retain their existing rejection path; wire bytes and schemas remain unchanged.

The outside complete original buyer workload passes all 55 tests in eight suites with the same order, source transformation, 300-case properties, seed, blank replay path and deadlines. Its sampled header work falls from 8.418 to 1.597 seconds and byte-encoder work from 13.228 to 9.522 seconds; total wall time is 225.371 versus 226.861 seconds. These are component measurements, not a broad wall-time or hosted-performance claim. Compatibility review additionally retains the original hexadecimal call in the adopted path. Both affected original builds pass, and the original native selection plus four regressions passes 292 tests in 17 suites. The regressions cover ownership, representation/error parity, ordered field captures and getter failures, current kind membership, Unicode, byte fences and forbidden coercion. All original test selections and qualification settings remain. Complete adopted-source coverage, mutation, root and exact-head hosted qualification follow.

The complete original protected-ledger codec partition runs all 252 selected tests successfully, but does not complete its 358 mutations within the unchanged 45-minute ceiling. Its timeout and physical drain are retained; it does not qualify the source. Execution now separates the two complete codec files rather than truncating ranges or changing the tests. The actual pinned instrumenter observes 843 mutations in the canonical protected-ledger target: 485 in its complete store file, 167 in its complete scalar-codec file and 191 in its complete payload-codec file. The installed-engine contract compares every mutation identity against the original canonical union and checks duplicate-free coverage and unchanged target settings.

This complete-file subdivision adds one execution row: the registry remains 141 canonical targets, now scheduled as 376 execution rows in batches of 256 and 120. All original mutation operators, additional inputs, runner options, property cases, deadlines, workers, canonical aggregate score and zero-error/uncovered/unexecuted gates remain. The previous 375-row campaigns are historical evidence only. The corrected source still requires one complete blank-selector campaign on its published head.

## Joined Mongo replica-fixture startup

Published `cc492c03d4f8fd0274051b5629f0da85ed7a22cb` passes all 3,457 original application tests in 229 suites, with no failures or skips, in 962.684 seconds. The four new codec regressions remain in the existing selection. All original 300-case properties, seed, blank replay and 150/2,100-second bounds remain. The full input closure and all 4,424 compiled paths stay fixed; owned group 74954 is independently absent before this follow-up. Installed controls and all four required repository checks also pass.

Its hosted reference application nevertheless fails Mongo replica startup: an owned member reports port 44441 already in use, and cleanup masks that failure because another member is still starting. The pinned dependency starts all members concurrently after releasing temporary port probes. This fixture now starts each of its three isolated, unauthenticated members only after the previous original startup promise resolves. A failed start therefore settles before replica cleanup, with no unstarted sibling allocated or outstanding sibling startup. Existing members restart serially with their original force-same-port option.

All three real members, Mongo 8.2.6, WiredTiger, loopback binding, original per-member 60-second launch bounds, election settings, majority/journal writes, hook deadlines and complete test selections remain. There is no production API, dependency, persisted format or replication-policy change, and no startup retry or swallowed failure. Three deterministic regressions cover a blocked first member, exact second-member failure and original-member restart. Full real native and Chrome compositions, host coverage and fresh final-head qualification follow.

The obsolete full mutation campaign 37204952974, attempt one on cc492, is cancelled after this concrete hosted failure. Its blank selector, shared-build archive identity and partial terminal results are retained; it supplies no final-source score. The corrected source still requires one new complete blank-selector, same-run campaign for all 141 canonical targets and all 376 execution rows, with every original score and zero-error/uncovered/unexecuted requirement unchanged.

The first local replay passes all 20 native reference tests but fails the browser build because the dependency declares member count optional. The default now follows the dependency's one-member fallback; the configured fixture remains three members. A second replay passes all 20 native cases and the original direct-producer Chrome profile, then refuses the new sibling `.js` helper path when a direct Node TypeScript consumer loads the fixture. Both failed receipts, complete immutable input closures and physical drains are retained. The small startup class now resides in the existing fixture file, preserving direct-source and bundled consumer resolution without another loader or production export.

The final inline variant passes all three startup regressions, all 20 native reference tests in five files and all three actual Chrome profiles in 83.254 seconds. The private profile records exactly two Opens, zero exceptions, native IndexedDB, owned HTTPS, producer restart and proposal expiry. The preceding whole core coverage replay passes 1,079 tests and retains only its one pre-existing skip, in 201.877 seconds. Final-head hosted coverage must independently rerun that complete union. Every consumed authored input and all 4,424 compiled paths stay fixed; each actual owned process group is independently verified absent before subsequent edits. Required final root checks, committed-source equality and fresh exact-head hosted qualification remain necessary.

The published inline fixture passes its native-reference CI lane, conformance and container contracts, but strict Sonar reports two S9382 findings for `await` inside the deliberate startup loops. The fixture now expresses the same dependency as a promise chain: each original native start must fulfill before the next member is allocated, and rejection skips every later allocation while retaining the exact error. Restart chains likewise retain the original members and force-same-port option. No finding is dismissed, classified as accepted or suppressed; no concurrency, deadline or failure rule is weakened. The local scalar-codec diagnostic is deliberately interrupted for this concrete consumed-source follow-up after its 252 original initial tests pass and all 167 mutations are instrumented; actual group 85954 is independently absent, every consumed byte and all 4,424 compiled paths fixed. That interrupted replay supplies no score. Fresh complete reference and exact-head qualification follow.

The promise-chain correction passes the same three ordering/failure/restart regressions and the complete 20 native tests/five files plus all three actual Chrome profiles in 84.168 seconds. Exactly two Opens, zero browser exceptions, native IndexedDB, owned HTTPS, provider restart and proposal expiry remain. Captured authored inputs and all 4,424 compiled paths are unchanged through the independently verified physical drain. The original sequence, failure identity, member count, ports, tests, property strength and deadlines remain; only the expression of serial startup changes. Fresh root checks and exact-head security/coverage/campaign qualification follow.

## Complete application coverage scheduling

Published `63ed4ca72b205ff20be4fc2f5ad5dbd52fe4a96c` passes strict exact-head Sonar with zero new findings/hotspots, CodeQL, conformance, container contracts, SDK coverage, both host coverage profiles, native reference, all three actual Chrome profiles, wallet browser/mobile and package/documentation consumers. Its application job `111453512379` in CI `37207892362` nevertheless exhausts the original 35-minute limit after 217 of 229 suites pass; no case failure is reported before cancellation. The cancelled lane and failed aggregate remain unqualified. These passing components cannot qualify this or a subsequent source head.

The application suite is therefore scheduled as two isolated complete Jest shards, each preserving the original serial native worker, discovery, property histories, 300-case minimum, seed/replay and per-test controls. The ordinary package coverage command and its original global thresholds remain unchanged. A required aggregate independently discovers the original full suite and rejects missing, duplicate, extra, failed, pending, todo or skipped execution, and source/run/attempt/configuration mismatches. It merges matching complete Istanbul source inventories and enforces all four original global thresholds before the existing 90% patch gate. Both shard jobs retain the original 35-minute ceiling. No partial report, earlier-head success or diagnostic score qualifies the complete selection.

The reporting libraries are declared directly at their exact versions already present in the frozen graph. A broad first lock regeneration introduced unrelated optional peer bindings; that output was rejected. Root-filtered generation retains only the nine importer lines for the three existing reporting libraries, with no new package versions or snapshots. The first unit launch caught CommonJS named-import incompatibility; default imports correct that tooling-only error. The complete scheduling/negative/aggregation controls pass 31 tests with zero failure or skip. Complete local shard execution, coherent-batch root checks and fresh exact-head hosted qualification remain required.

The first root loop retains one failure in the existing patch-coverage bootstrap regression: changing the installer step title and rendering its root filter through an array broke that explicit control check. Preserve the original compiler step title and explicit root filter, adding only the application runner filter. All 482 other controls pass; actual group 2260 is independently absent and every consumed byte/all 4,424 compiled paths remain fixed before the correction. No existing assertion is removed or weakened.

Complete local staged-source coverage passes both original suite shards: 1,703 tests/115 suites in 324.457 seconds and 1,754 tests/114 suites in 666.892 seconds, with no failure, pending case or skip. The independently rediscovered disjoint union is exactly all 3,457 tests/229 suites. The complete matching-source Istanbul merge passes the original thresholds at 98.34% statements, 96.83% branches, 98.63% functions and 98.86% lines. Total serial local execution is 991.701 seconds; this is scheduling evidence, not a whole-workload speedup claim. Every captured authored/configuration byte and all 4,424 compiled paths remain fixed through the independently verified physical drain of group 7214. The local manifests use an explicit synthetic run identity and cannot qualify hosted CI. Original root health, lint, format and type checks also pass in 64.290 seconds with group 4111 independently absent. Final source/root proof and fresh exact-head hosted validation plus one complete blank-selector campaign remain required.

The subsequent published `4ed5e555e28853b15ece719d21a8a2c6171360b7` CI catches a real validation-placement gap before build: zero-install repository-health job `111466865344` cannot import Istanbul from the new test's module startup. Local installed controls did not model that early environment. Separate the unchanged dependency-free inventory/result/threshold validators from reporting orchestration; keep the first three unit controls in early health and execute the unchanged actual Istanbul merge/threshold integration unconditionally after frozen installation, before build. The source fingerprint includes the extracted validator module. The isolated no-node_modules fixture passes all three early controls, and all 31 scheduling/library/negative controls pass installed. An initial added placement assertion used an incorrect installer title; checking the actual frozen install command corrects that regression without weakening ordering. Application source, test discovery, shard selection, cases, properties, merge logic, thresholds and budgets remain unchanged. Fresh source/root/installed proofs and hosted final qualification remain required; no passing result is inferred from suppressed lanes on the failed head.

Exact published-head Sonar for `0d06a9c06caf81ddf2385af7446a28f9059cbbfd` reports six new tooling findings: implicit/mutating array sorts and bare `NaN`. Correct them without classifying, accepting or suppressing findings. An explicit comparator preserves the original ECMAScript UTF-16 code-unit ordering across locales; `toSorted` preserves the caller's array. A regression pins punctuation, case, Unicode/surrogate and equal-value ordering plus original-array ownership. Coverage source inventories, test selection and all metric/threshold semantics remain unchanged; the negative metric fixture uses `Number.NaN`. Both current hosted application shards continue against their immutable source so their terminal execution/aggregation can be observed before the next source qualification; passing components cannot qualify the failed analyzer head.

### Complete recovery-plan execution after the final-source CI gate

Published source `778fe54b97499c230ce8f8c376465bba4e5650e4` passes CI
`37215049525` with 42 successful jobs and only the two expected unselected/deferred
jobs skipped. Sonar, CodeQL `37215049365`, conformance, container contracts,
reproducible code generation, SDK 8,364/257, native reference 20, wallet mobile
46/6, packed/documentation consumers and all three reference Chrome profiles
pass. The private-state browser reports two Opens, no exceptions, native
IndexedDB, owned HTTPS, producer restart and proposal expiry. Application
coverage passes all 3,457 tests/229 suites, its original global thresholds and
97.23% patch coverage against the unchanged 90% gate. All 13 review threads are
resolved; final security reconciliation has no open CodeQL alerts and no new
dismissal or classification.

Full blank-selector mutation campaign `37216923166`, attempt 1, retains that
source and the complete original 141-target/376-row inventory. Its build artifact
`11308882407` has ZIP digest
`895564034c9af018a1f08dae43b9bf05645c00046ea46a8efdc6043cb67d79c1`, internal
archive digest `cde1911086ed9b7d63669f9efcde7325d6155d8ffaf2810400481585bc6d0b6f`
and matrix digest `4f2e1edf42a02b0c9b3d4ab36b6faed52447316fb037d8a2801174c475e10961`.
It is not qualified: job `111479481128`, the whole recovery-plan target, is
cancelled at its original 45-minute limit after the initial 237 tests pass in
138 seconds. There is no final mutation report or score. The terminal log and
job receipt are retained; other partial passing rows do not supply qualification.

The correction schedules the existing recovery-plan module and construction
ranges in three parts, with a boundary at the existing complete failure-handler
function. It changes no production source, canonical range, test selection,
property case/seed/replay control, operator, worker, timeout, runner-reuse or
score/invalid/uncovered/unexecuted rule. The complete module retains 62 mutants;
the original construction and failure bands retain 35 and 34. Their independent
pinned-engine replay must reproduce every original mutant tuple exactly once.
The original call-only range with zero mutants remains attached to a nonempty
construction part; it is not removed. Future companion sources remain selected.
The complete source-line union and every original configuration setting remain
covered by the controls. Global qualification independently replays and aggregates
all three parts under the same original source/run/attempt before acceptance.

The original inventory diagnostic passes with 131 canonical mutants and an exact
duplicate-free union in 0.678 seconds. Its owned group 50934 is independently
absent, and all captured authored inputs and 4,424 compiled paths remain fixed
through drain. This is instrumenter evidence, not a passing mutation score or a
runtime performance claim. The revised registry has 141 canonical targets and
378 execution rows in ordered batches [256,122]. The original 45-minute execution
budget and all full-campaign gates remain unchanged. Final-source CI and a new
complete blank-selector campaign are required after the coherent correction is
qualified and published; the preceding campaign cannot qualify changed source.

The same campaign also cancels revenue-purchase job `111479481169` at its original
45-minute limit. Its complete `extend` method has 69 mutants and the initial
43 tests pass in 119 seconds. The reporter finishes at the boundary with
62 killed/seven survived (89.86% for this part), but final qualification is
cancelled. The retained report artifact `11310172292` has digest
`9c564df5a181fb4778833b3835315d4a5e12a44ee9960769f13e9a82c05e47d6`.
This does not establish either a passing global score or full target qualification.
No survivor is reclassified and no score requirement is reduced.

The private verifier method is decomposed into history extension and transaction
binding. The existing evidence parsing/association, sorted unique history,
assembly, layout, operation, predecessor and mandatory-output checks execute in
the same order with the same arguments and errors. Full Script/history validation
and installed family/resolver change guards remain in the existing public
verification path. The public result still returns the same package and original
predecessor value. There is no new cache, authority shortcut, public export or
wire/persistence change. Complete original tests and 300-case property controls
remain required. Complete-method scheduling now isolates the orchestration and
two smaller validation methods; it does not split or discard a parent mutant.

Independent pinned-engine replay of the revised complete source passes all 175
canonical mutants exactly once across eight method bands, with inventories
3/38/14/21/2/36/33/28. This is a new source inventory: the old 173-mutant result
cannot qualify the refactor. Group58412 is independently absent and all captured
inputs and 4,424 compiled paths remain fixed through drain. The preceding
wallet-only coherent batch passes all root checks and501 installed controls in
64.875 seconds; its receipts are retained separately. The final combined source
requires fresh complete tests/root checks/compiled consumers and hosted gates.
Its complete registry now has141 canonical targets/380 execution rows in ordered
batches[256,124]. Original45/90-minute budgets, test/property/worker controls and
all global/canonical gates remain unchanged. No runtime speedup or completed
checkpoint is claimed by the instrumenter or decomposition evidence.

The refactored package compiles through its original `tsc` build. The complete
original purchase unit/property files and all six native economic routes pass
44 actual Jest tests/three suites in93.345 seconds, with the original300-case
minimum, seed3242026, blank replay and case timeouts. No test selection or
assertion is changed. Build group58741 and test group58838 are independently
absent; all captured authored inputs and, for the test reader,4,424 compiled
paths remain fixed through drain. These local tests establish the unchanged
purchase and economic behavior; complete final-source hosted profiles and the
new full mutation campaign remain required.

### Recovery-store complete scheduling follow-up — 2026-10-04

Published source9aff has successful ordinary CI, strict Sonar, CodeQL,
conformance, container and codegen checks, including native20 reference tests,
all three actual Chrome profiles, mobile46 tests, compiled documentation and
packed consumers. Its complete application aggregate passes3457 tests/229
suites with97.24% patch coverage. Thirteen review threads are resolved, with no
new open CodeQL findings. One external nonblocking Codecov reporting job
initially exceeds its unchanged five-minute wait while the external upload is
still started; rerunning only that same-source reporting job succeeds. No
source, test, timeout, classification or quality gate is changed for that retry.

The full blank-selector mutation campaign37223480110/attempt1 remains a
separate requirement. Its recovery-plan parts and all eight purchase-verifier
parts succeed. The complete wallet-recovery-store job111498613163 starts at
18:13:35Z and ends cancelled at19:43:52Z under the original90-minute job limit.
The engine instruments229 mutants and passes all237 initial tests in123
seconds; there is no final mutation report or inferred passing score. That
campaign cannot qualify the checkpoint and supplies no score for a new head.

The store's existing canonical interval is now divided at complete methods and
helpers into nine execution parts. The production store bytes, installation
and transition intervals, complete original test selection, property300/seed
3242026/blank replay, operators, workers, deadlines and global score/zero-error
gates remain unchanged. A pinned-engine replay independently proves the exact
229-tuple duplicate-free union with nonempty inventories44/9/14/16/20/10/93/13/10.
Its local group4231 is physically absent; all authored inputs and4424 compiled
paths stay fixed. Ordinary CI additionally downloads the previously missing
recovery-plan parts and the new recovery-store parts before canonical
aggregation. Its first complete local control run catches two other missing
downloads, for private-publication admission and private-purchase HTTP. Those
downloads are added too; that initial control run remains failed, with its
group4312 physically absent and all authored/4424 compiled inputs unchanged.
The workflow regression now checks every actual partitioned
target's exact download predicate and destination, instead of three examples.
The registry retains141 canonical targets with388 rows in batches[256,132].
Complete final-source root/installed controls and a new full same-run published
campaign remain required; checkpoint two is still open.

### Standalone proposal read ownership — 2026-10-04

Published head d331 passes all 42 applicable ordinary CI jobs, strict security
reconciliation and the native, browser, mobile, packed and documentation profiles.
Its full blank-selector campaign 37229910345/attempt1 does not qualify. The
proposal-journal-send/store job passes all 232 initial tests, then reports native
worker terminations and two invalid mutants against the unchanged zero-invalid
gate. The report ZIP digest and terminal job log are retained outside published
package artifacts; the campaign is stopped and terminal cancelled. No partial
score or previous-head result qualifies this source.

Ordinary source review finds a separate concrete ownership gap: standalone reads
replay installed policy while the SQLite transaction domain appears idle. A
harmless nested-read regression fails the old source with an invalid-history
error because nested replay changes the cache under the outer replay. This
regression does not close an executing native connection or reproduce the
unknown worker fault.

Standalone reads now pin metadata and its immutable prefix to one synchronous
read transaction. Installed policy replay therefore shares the physical-owner
gate; harmless reentry is rejected before replay can change the cache. A second
regression verifies gate release after an ordinary JavaScript policy refusal and
subsequent durable replay. Every original proposal test remains selected. The
complete 234-test/13-file unit, native process, composition and 300-case property
union passes locally in 19.047 seconds with seed3242026 and blank replay. Its
owned group72706 is physically absent and all authored/2275 consumed runtime
paths remain fixed. No API, persisted schema, permission, payment or admission
authority changes. The guide and generated release/migration documentation
describe the synchronous ownership rule.

This source-level correction does not establish the cause of the native worker
terminations. Complete original local controls, published-source platform gates
and one new full same-run mutation campaign remain required. Checkpoint two is
still open; invalid mutants, cancelled rows and incomplete scores are not waived.

### Bounded standalone proposal replay — 2026-10-05

Published head d3d8ac94 passes the required ordinary CI gate and the native,
browser, mobile, packed and documentation profiles. The external nonblocking
Codecov reporting job fails verified TLS certificate validation, including its
same-source retry; no TLS check is bypassed. Full campaign 37250572731/attempt1
does not qualify. Its proposal-journal-send/store job passes all 234 initial
tests, then reports four native worker terminations and one invalid mutant
against the unchanged zero-invalid gate. The failed report archive and terminal
log are retained outside published artifacts; the stopped campaign is terminal
cancelled. Its 212 passing execution rows are partial evidence only.

Ordinary source review observes installed application policy running while the
SQLite entry iterator is active. A harmless valid-data regression records active
cursor ownership and fails the old source with observations [1,1,1] through an
ordinary JavaScript assertion. It does not close an executing connection,
inspect an unknown mutant trigger or reproduce a native fault.

Standalone replay now reads bounded pages of at most 128 entries. Each native
read completes before policy runs, while all pages share the existing physical
read transaction and pinned target revision. The first query still runs for an
empty delta, preserving missing-entry-table rejection. No public API, persisted
schema, payment, admission, disclosure or ownership authority changes.

Three additive regressions cover completed native reads before policy, a
129-revision prefix followed by a later append, and missing storage with no new
revision. Initial candidate checks retain their ordinary failures: an incorrectly
constructed multi-channel fixture reaches the unchanged author quota, and a
while-loop candidate misses the empty-delta storage check. The corrected fixture
uses one channel and the implementation always performs the first query. Every
original test and limit remains intact.

The corrected source passes all 237 proposal unit/native/property tests in 13
suites and the complete 560-test proposal/current-channel/scheduler/property
union in 43 suites, with 300 cases, seed3242026 and blank replay. Both original
bounded runs drain physically and retain all captured authored and 2275 compiled
runtime paths. The final strengthened zero-active-cursor assertion passes in the complete
560-test/43-suite run in 129.363 seconds. Group81540 is physically absent and all
captured authored and 2275 compiled paths remain fixed. The owning package's
original build passes in 1.301 seconds and group81436 is physically absent with
fixed authored inputs. Root controls, packed consumers and published-source
gates retain their separate fresh-receipt requirements. This correction does
not establish the native worker fault's cause or qualify the checkpoint; one
complete same-source, same-run campaign remains required.

### Mutation runtime and original compatibility — 2026-10-05

Published source 0a735bc7 passes required CI, native/browser/mobile/reference,
packed-consumer and documentation profiles. Full campaign 37262942899/attempt1
is terminal cancelled and unqualified. Its proposal-journal-send/store job
111614062315 passes all 237 initial tests before native worker crashes and two
invalid mutants against the unchanged maximum of zero. The failure archive
11330305202 has independently verified SHA256
`e588c1a4c0dfae6191d3c94c1b7c98e59cc1520a42886c9a3d5d64d820e49b32`;
the retained log SHA256 is
`466691b7ff671dfd01857d973afade9f4c0d1170cd21e56d670a26005b0a6df4`.
Neither partial successes nor the preceding bounded-read correction establish
native-fault resolution. No unknown trigger was inspected or reproduced.

The full mutation workflow now uses Node 24.19.0 for build, aggregation and
final verification. Its [official release notes](https://nodejs.org/en/blog/release/v24.19.0)
include supported SQLite lifecycle corrections. This patch validation is not a
claim that a particular upstream correction caused or fixes the observed worker
failures. The shared executor selects the exact Node version from its original
caller's immutable identity. Preflight validates the selected runtime; the
closed identity decoder rejects any malformed declared version before archive
extraction. Original six-field identities retain their exact Node 24.18.0 selection;
new build identities add the canonical captured runtime, independently verified
against the actual executing process before archive extraction. Ordinary CI
continues using its original Node 24.18.0 build runtime.
Release, service, package and public runtime contracts are unchanged.

One additive installed workflow control checks full-stage runtime agreement,
exact caller-version binding, unchanged ordinary CI pins and malformed-version
refusals. All original controls, source/test unions, operators, target inventory,
property cases/seed/replay, deadlines, workers, score and zero-invalid requirements
remain unchanged. A fresh complete same-source, same-run, same-attempt campaign
and independent final raw-report reconciliation remain required. Old or peer
receipts cannot qualify the new source; checkpoint two remains open.

Published source 7da41722 exposed a producer/consumer startup mismatch in full
campaign 37277512489/attempt1: the executor expected a runtime field omitted by
the actual six-field build-identity producer. The campaign failed preflight and
was cancelled before mutation execution; it provides no qualification or native
fault evidence. The additive runtime capture and exact six-or-seven-field
decoder correct that interface. A regression now invokes the actual producer
and consumer with a clean Git fixture, checks recorded runtime and legacy
acceptance, and rejects mismatched runtime, malformed versions, extra fields
and altered original identity fields. Every original control remains intact.

## Native statement preparation qualification follow-up

The final proposal-journal campaign reported native test-runner exits during
statement preparation rather than assertion failures. The journal now requires
nonempty statement text before invoking the native driver. This is an internal
preparation invariant; all installed SQL, parameter bindings, public interfaces,
persisted formats and original driver errors remain unchanged.

Deterministic regressions exercise missing text through a JavaScript driver stub,
verify that native preparation is never reached, and retain valid native binding,
driver-error identity and subsequent journal recovery. The original governed
mutation scope, operators, workers, property budget, seed, timeouts and quality
limits remain unchanged. The focused integrity suite passes all 29 cases; full
exact-source qualification remains required before checkpoint readiness.
The complete original proposal profile also passes all 244 cases in 13 suites,
including its original 300-case property campaign and seed. Root health, lint,
format, strict types and the unexcluded security audit pass.

The preparation helper remains outside the exported class hierarchy. An
application-subclass regression retains its own preparation method without
intercepting journal SQL. Public journal declarations and subclass behavior
remain compatible with the original implementation.

## Native buyer same-view funding companion

The optional `PrivatePurchaseBuyerValidation.fundingPreflight` carries a signed-term
assessment into the buyer rather than discarding its synchronous guard. The buyer
pins the installed method, including its absence; captures an owned, stable,
synchronous data-method guard; rechecks after asynchronous planning and protected
custody writes; and combines that guard with the original cutoff/currentness
callback passed to the native financial owner. Unsigned discovery retains the
original preflight path. Omitted companions retain all prior behavior, and recovery
of an already finalized original candidate does not repeat new-work expiry.
The installation identity must bind the complete selected domain contract.

The first regression run exposed an accidental required-method pin for the optional
hook: 25 historical tests failed while the nine new cases passed. Making only that
pin optional restores the original path. The final complete selected buyer run
passes 36 tests in three suites (71.782 seconds), retaining the original 300-case
recovery property, seed 3242026. Cases cover async planning and final wallet-effect
fence changes, inherited/accessor/async/Promise/changed/missing guards, changed
installed hooks and absence, and retained recovery after expiry. The three original
native wallet suites, including their original 300-case property and historical
route exercise, pass all ten tests (106.918 seconds). That historical route evidence
does not qualify the replacement Script family.

Original registry/partition controls pass. The exact packed output-knowledge
exports and complete browser budgets/runtime pass unchanged, including browser
restart and protected original custody. Seventy-three compiled examples across
24 exact tarballs pass, including the new funding-companion public type example.
This component neither manufactures a purchase commitment nor implements native
alias/action reconciliation. Coordinator commitment persistence, replacement-family
native composition, all per-txid admission/release facts and complete final-head
qualification remain open checkpoint-two requirements.

## Explicit purchase-commitment companions

The explicitly selected `SQLitePrivatePurchaseCommitmentStore` seals version-two
state and retains the independently verified full purchase commitment through
native reservation, admission and first signed delivery. The original store's
five-argument constructor, version-one declarations and exact-txid pin remain
compatible. The separately selected SDK envelope verifier and transport binding
retain the signed domain and original funded candidate while authenticating
recovered release representation. Complete Bitcoin equivalence and private
entitlement verification remain installed domain responsibilities.

Component qualification for the preceding published `d6b2c754` batch includes
all 38 original SDK purchase protocol cases, all 271 complete SDK transport cases,
the original property budgets/seed, and all six historical native authenticated
Engine/Mongo/LCH composition cases (139.211 seconds). These historical Script
composition results do not qualify the current two-stage exemplar or aliases.

The buyer now explicitly selects `candidateProfile: "full-purchase-commitment-v1"`
with an independently installed complete candidate verifier. It reserves a
seventh bounded protected object before preparation or funding, owns the full
commitment and synchronous guard across awaits, and binds the retained identity
to the exact original funded bytes and signed domain. A lost protected-write reply
recovers that same object without another verifier/financial operation. Omitted
selection retains the original six objects, installation binding, wire formats
and exact-txid authentication. Inherited, accessor, missing, changed and
asynchronous guards are refused. Authentication cannot substitute for independent
original/released transaction, License and key checks; historical recovery and
playback never apply a new-preparation expiry predicate.

The complete original nine-file buyer cohort passes all 76 cases in 343.836
seconds, including all original properties and the new 300-run protected-identity
recovery property. The full original state/native-clock union passes all 301 cases
in 19 suites (74.069 seconds). Both ran serially on Linux arm64 Node 24.19.0 with
pnpm 10.33.2, the original 300-run minimum, seed 3242026 and unchanged deadlines.
The runtime closure was frozen at SHA256
`5a417e5536af33d6aeb9af581c4160744c0e3cfb1c9e96ddaadfacff30b5fd6e`
with source and built-artifact rechecks, known healthy public SQLite drivers,
network withdrawal before tests and verified container/volume removal afterwards.
The driver receipt hashes its actually loaded packaged binding; earlier failed
setup attempts are not qualification. Later documentation clarification is
qualified separately by the package/example/root documentation controls.

Two actual strict Sonar findings on `d6b2c754` prompted behavior-preserving fixes:
the complete pin transition moves to one helper retaining ordered checks and the
duplicate's original early return; the historical constructor explicitly fixes
the internal legacy mode. Independent canonical inventories prove the complete,
duplicate-free original source unions: state 1071, coordination 580 and native
clock 1556 mutants. Only the two changed inventory goldens are updated. All 143
targets, 390 execution rows, original selectors, thresholds and controls remain.
Registry/partition regression controls pass all 121 cases. This is inventory and
ordinary-regression evidence, not a mutation-execution campaign or a hosted
zero-finding claim.

The retained historical codec, authority and six-route spend guides are now
explicitly labeled and linked to the current profile. The current profile's
native wallet, durable per-txid alias admission/release records, selected-chain
recovery, full current HTTP composition, final complete mutation campaign and
exact-head hosted gates remain open checkpoint-two requirements.

### Owned original terms normalization — 2026-10-05

The published `d6b2c754` application coverage shard failed when its original
300-case buyer history property reached the unchanged 150-second interrupt
after 297 cases. No assertion or counterexample was reported. That run is
failed; its partial execution does not qualify the property or this revision.
The two exact-head Sonar findings are addressed by the preceding complete
progress helper and explicit historical store mode described above.

The additive SDK `OutputPurchaseTermsVerifier` owns the normalized original
request and selected seller. Every call parses the complete returned terms,
recomputes the full original-request association and invokes BRC-77 signature
verification. It retains no response or verification verdict. The existing
function forwards the same ordered checks and keeps its signature and errors.
The buyer creates and pins this verifier while retaining its separate domain,
access, funding, release and rights checks. A tentative returned-terms cache was
removed before native qualification; no such cache remains in the source.

The complete original SDK protocol selection passes 39 tests in three suites;
the complete original transport selection passes 271 tests in thirteen suites.
The original property controls remain at least 300 cases with seed 3242026.
Regressions check original-request ownership, detached returned packets, fresh
signature and association refusal, and selected-seller binding. Core typecheck,
build and the full duplicate-free state/coordination/native-clock inventories
pass with the original 1,071/580/1,556 sites, 143 targets and 390 rows.

Core packed exports pass, and the complete browser suite passes in 63.320 seconds
under its original bundle ceilings and test controls. The new compiled snippet
first exposed duplicate import names in the combined consumer. Aliasing only
that snippet's imports corrects the error; all 77 compiled examples then pass
against 24 exact package tarballs. The failed attempt is retained separately.
The three changed historical guides are reviewed as compatibility documents and
link the current immutable profile; their review dates now describe that actual
review, not current-family runtime qualification.

The complete original Linux buyer/wallet selection now passes all 79 cases in
nine suites under the original complete coverage instrumentation (350.660
seconds). The full original state/native-clock selection passes all 301 cases
in nineteen suites (76.061 seconds). Both retain the 300-case minimum, seed
3242026 and original property/test deadlines. The frozen 2,011-file runtime
closure is SHA256
`7f32060b12bb68b5efc74b10e96b52a0a552ce2a9cb008b6f8c9ffb067b1d7af`;
the complete 5,281-file source manifest is SHA256
`b52bd1c277a06225b483fb09d460d7aa3d9a8e0a4f234b153cca60c26d0adb2f`.
Source files are rechecked before and after builds and after both selections.
The Linux arm64 Node 24.19.0 runtime uses the healthy packaged SQLite 13.0.3
binding SHA256
`8ba771f284dfd9430e3ef8e2ffc373ed7cc5a92fc7c4c0c7baf39dd672863485`;
network access is withdrawn before tests. Physical container and volume removal
is verified afterwards. Coverage from this selection is component evidence,
not proof of the final aggregate coverage gate. Later documentation review
dates and this evidence text are outside that frozen source snapshot and need
the separate committed documentation/root checks.

The replacement-family native wallet and alias custody, full current HTTP
composition, complete final mutation campaign and exact-head hosted gates
remain required. These component results do not complete checkpoint two or
qualify a later source head.

## Selected current native wallet and fixed-child intake preparation

The selected `WalletToolboxProfilePurchasePayment` companion retains the complete
ordinary native funding pipeline and historical entry point. Its format-2 durable
snapshot binds the frozen program pair, complete activation ancestry, active stage,
exclusive expiry and the same installed chain view and eligibility guard across
allocation, awaits and the final side effect. Finalized recovery reads original
bytes without allocating again or renewing expired authority. The internal store
mode is required and nullable while the historical public getter remains unchanged;
this also removes the redundant optional `undefined` flagged by Sonar.

The first frozen current-wallet run executed the complete original nine-file
coverage-instrumented selection: 83 cases passed and eight new current fixture
cases failed before allocation because the genesis signature did not match the
checkpoint owner. All captures passed bounded native-fault marker triage; the
owned container and volume were physically removed. The later profile and
state-clock selections were not run. The corrected fixture uses a fresh disclosed
public funding checkpoint, consistent mock headers and its funding actor's P2PKH
signature. Independent portable execution validates every genesis and activation
input and verifies the complete active lineage. This diagnosis and semantic type
check are component evidence; a new frozen native run is still required.

The additive local fixed-child intake has an explicit profile and recipient,
independent public child matching, complete AtomicBEEF verification and the full
existing signer, authorized-writer and transactional provider ownership pipeline.
Ordinary BRC-29 Base64 validation, historical methods, database schema and remote
BRC-100 wire behavior retain their previous contracts. The original native managed
change suite now includes wrong-recipient, wrong-Script, idempotence and unsupported
writer cases plus eight independent recipient receipt/reopen/protected-spending
cases. A genuine generated property is appended to the existing controller suite
under the original minimum 300 runs, seed and deadlines. Those tests await native
qualification. The complete source union has 936 distinct canonical mutation sites,
including both factored cores, old and selected wrappers, fixed-field helper and
new public method ranges. All three original funding targets retain their original
selectors and controls; no target or execution row is removed. This is an inventory
proof, not mutation-campaign evidence.

The current hosted wallet shard's 17 Chaintracks tests collided on fixed port
33066 before their assertions. The fixture now requests the existing server's
supported ephemeral port, preserving the full assertions and deadlines. Its
original complete cohort also awaits the new frozen qualification. These source
corrections, guides and compiled API example do not finish Checkpoint 2; full current
alias custody, native profile routes and activation gates, HTTP composition, final
whole mutation reconciliation and exact published-head hosted gates remain open.

The subsequent coherent frozen run started with the complete original ten-file
funding selection. It passed 60 cases and failed four new selected-intake cases
in 19.202 Jest seconds, before the later buyer/profile/state/Chaintracks cohorts.
Every capture had negative bounded fault-marker triage and no timeout; bounded
resource removal and independent inventories proved the container and volume
absent. The public-key API defaults to the counterparty side of BRC-42 derivation,
whereas this recipient intake needs the identity owner's child. The selected
capability and signer now explicitly request `forSelf: true`; ordinary defaults
remain unchanged. Independent pure SDK mathematics compares eleven disclosed
synthetic actors against both the wallet helper and normative child calculation,
and confirms the default counterparty point differs. This is a source correction
and mathematical component check, not native receipt or spending qualification.
The refreshed whole canonical wallet inventory has 938 distinct sites, retaining
all original selectors, source/support unions, thresholds and property controls.

### Exact-head source findings and recipient-side correction

The `76c5853df` hosted run passed the Chaintracks wallet shard after the original
fixture selected an ephemeral port. Its separate zero-new Sonar gate reported
sixteen findings: twelve serial awaits in the newly factored storage intake core
and four no-await asynchronous synthetic tracker methods. The storage core now
uses one private serial iterator, preserving write order, early skips and original
errors during iterator closing. The fixture returns explicit resolved or rejected
promises, retaining its original synthetic headers and chain checks. No test,
property count, deadline, selector, assertion or quality rule changed. Full wallet
and application type checks and repository lint pass for this working source.

Together with the explicit recipient-side child selection described above, the
complete canonical funding inventory contains 946 distinct sites, including both
entire intake cores and their wrappers. The original 143 targets, 390 execution
rows, full ten-suite funding and nine-suite payment cohorts remain unchanged;
the payment inventory remains 408 sites. These are inventory and source-preparation
receipts, not a mutation campaign or native qualification. Frozen native v4 was
superseded before admission or execution. A new source/controller agreement and
complete ordinary Linux qualification are required before crediting these changes.

The next complete frozen Linux funding run (`v5`) passed 63 of 64 tests in the
original ten suites (nine passing suites, one failing suite; 20.391 Jest seconds,
20.781 captured seconds). Every captured step stayed within its bound without a
native-fault marker or supervisor timeout. The container and volume were actually
removed and independently absent; the coordination resource calendar was removed
and read back. Buyer nine, current-profile three, state-clock nineteen and
Chaintracks seventeen remained unrun after the ordinary assertion failure.
These receipts remain failed and unrun evidence, respectively.

The explicit recipient-side `forSelf: true` correction passed the positive credit,
negative ownership and original generated remittance tests. The new eight-recipient
example stopped at its first actor after receipt, reopen, idempotent intake, exact
protected-child input selection and independent Script verification succeeded.
Its final assertion prematurely expected the stored output to be spent after a
default automatic-batch `noSend` action. The established action-batch implementation
instead reserves that output, excludes it from the wallet's public spendable
view, and persists its spent flag when the batch commits.

The source correction exercises all eight disclosed recipients separately in
default automatic and explicit legacy modes. It checks the actual reservation
and public output view, completes the original action through public `sendWith`
using the existing mocked post service, retains the stored spent-output and
transaction assertions, and reopens again to check persisted literal metadata and
spend ownership. No production batch behavior, ordinary wallet default, test
budget, selector or mutation setting changed. This expanded example is source
prepared and remains unqualified until a fresh complete frozen run passes.
Actual fresh peer860 source division ACK `DC_kwDOSLqBrM4BHnd8` covers these owned
source changes only; a new full source/runtime/controller tuple and actual
runtime ACK are still required before execution. No held569 private source or
qualification was adopted.

### Complete selected-wallet functional qualification

The fresh frozen `v6` Linux run passed all five complete cohorts: original
funding (10 suites, 65 tests), buyer payment (9 suites, 91 tests), current
Script profile (3 suites, 31 tests), application state and clock (19 suites,
301 tests), and Chaintracks (1 suite, 17 tests). In total, 42 suites and 505
tests passed. Both original 300-history recovery properties retained their
minimum runs, seed and deadlines. All eight disclosed recipient actors completed
receipt, reopen, protected spending, public batch commit and a second reopen in
both default automatic and explicit legacy modes.

The frozen tracked-source manifest is
`ea53abbd1893932500b4b7d1f971719c3fedda13148baed40a954252b4a5db47`;
the independently checked built-runtime manifest is
`5a55a4c27ffb88068cd77860767ce88fc9f3dabf5dfeccbbbacc4bdbb0212076`.
Both were rechecked before and after execution. Every capture passed bounded
fault-marker triage without a supervisor timeout. The owned container and volume
were physically removed and independent successful inventories proved their
absence; the coordination resource calendar was removed and read back. The
later documentation updates are outside this frozen source snapshot and require
separate committed-head root checks.

These are functional component results. The recipient example proves ownership
and wallet lifecycle using disclosed synthetic child outputs; it does not prove
every native covenant route or the complete buyer, seller, admission and HTTP
composition. The previous failed runs remain failed evidence. This run is not a
performance qualification, a mutation campaign or exact-head hosted approval.

The published `76c5853df` head still has unresolved application performance
checks. A CPU-only diagnostic on unchanged public purchase fixtures found repeated
construction of the same original transaction within a single recovery call.
A private call-local prototype preserves candidate bytes and independently parses
the returned funded transaction; it has not been adopted or qualified. Durable
multi-alias custody, full native route and activation preflight coverage, complete
HTTP demonstrations, final mutation reconciliation and terminal successful
exact-head hosted gates remain required for Checkpoint 2.
