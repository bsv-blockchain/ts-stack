---
id: test-quality-governance
title: 'Test Quality and Skip Governance'
kind: reference
version: '1.2.1'
last_updated: '2026-10-05'
last_verified: '2026-10-05'
review_cadence_days: 30
status: stable
tags: [reference, governance, quality, security, testing]
---

# Test Quality and Skip Governance

The required pull-request suite must be deterministic, assertion-bearing, and
honest about what ran. CI rejects:

- a new `test.skip`, `it.skip`, `describe.skip`, `test.todo`, or legacy `xit`
  declaration that is not registered;
- a stale registration after its skip is removed;
- an empty required test body;
- an unclassified `*.man.test.ts` or `*.live.test.ts` file;
- a conformance skip without a reason, owner, review date, exact file count, and
  removal condition; and
- a conformance dispatcher that reaches `not implemented` after the test has
  started. Gaps must be declared in vector metadata instead of passing
  vacuously.

Elapsed `reviewBy` dates are maintenance reminders, never PR failures. This
applies to manual inventories and policies, property suites and exclusions,
mutation policy, required skips, and conformance skip groups across every
package. The CLI prints `MAINTENANCE` warnings and exits successfully when only
dates have elapsed. Unknown owners, malformed dates, missing inventory, and
other structural findings still fail; runtime expiration checks are unchanged.

Run the contract locally:

```sh
pnpm test:governance
```

The machine-readable policy is
`governance/test-quality/policy.json`. It classifies the current suites as:

- **required** — deterministic PR and coverage tests;
- **manual/operator** (`*.man.test.ts`) — one explicitly selected suite that
  may require credentials, a funded identity, a database, cleanup, or human
  inspection;
- **scheduled live** (`*.live.test.ts`) — public-network checks that require no
  private credential but can fail because an external service is unavailable;
- **resource intensive** — deterministic checks that exceed the normal PR
  memory or time budget; and
- **conformance intended gaps** — stable vector IDs with per-file ownership and
  an explicit path to required or permanently unsupported status.

Never batch-run the Wallet Toolbox operator suites. Inspect and execute one
exact path:

```sh
pnpm --filter @bsv/wallet-toolbox test:manual -- \
  src/services/__tests/ARC.man.test.ts
```

Public live examples:

```sh
pnpm --filter @bsv/overlay-express test:live
pnpm --filter @bsv/wallet-toolbox test:live -- \
  src/services/chaintracker/chaintracks/__tests/GoChaintracksServiceClient.live.test.ts
```

The SDK resource boundary is similarly explicit:

```sh
pnpm --filter @bsv/sdk test:resource
```

## Property-based security tests

Required CI uses `fast-check` to generate and shrink unexpected inputs at the
registered packages' highest-risk trust boundaries:

- binary and text codecs: SDK Base58Check, DID base64url/multibase/SD-JWT,
  Bitcoin script numbers, asset outpoints, wallet action packs, and native BDK
  batches, plus wallet script classification and arbitrary OP_RETURN fields;
- public protocol parsers: Paymail addresses, Teranode message envelopes,
  reorg SSE frames, GASP requests/responses and UTXO reconciliation, overlay
  advertisements, Message Box hosts, and wallet pairing URIs;
- authorization and integrity: signed authentication bodies, exact issuer
  allowlists, BASM/TAC hashes, valid relay keys, expiry/freshness windows, and
  reserved-network rejection, plus per-origin BTMS authorization isolation and
  unsigned Bitcoin varint handling;
- HTTP and operator inputs: BRC-121 challenges, authenticated Express byte
  framing, payment replay admission, fund-wallet CLI keys/endpoints/amounts,
  currency conversion/formatting, and project-scaffolder path/configuration
  validation; and
- untrusted application data: Mandala BRC-162 envelope and issuer
  authorization, BTMS metadata and derivation instructions, canonical token
  amounts and asset IDs, and forge-resistant overlay log fields.

These are not round-trip-only tests. Depending on the boundary, the registered
invariants also require an independently encoded oracle, canonicalization,
length and numeric bounds, malformed-input totality, tamper rejection,
authority preservation, exact membership, or deterministic hashing. Generated
collections and byte strings are bounded so every pull request gets useful
coverage without turning CI duration into an unbounded input.

Every property suite and package declaration is registered under
`propertyTesting` in the policy. The governance check rejects a removed suite,
an unregistered `*.property.test.ts`, a missing package command, an undeclared
library/version, a missing trust-boundary/invariant description, or a run budget
below 300 generated cases. It also inventories all package manifests discovered
under `packages/`: each must either own a registered property suite or have a dated, owned exclusion
that explains why the package is only an adapter, composition layer, example,
or platform harness. This prevents both silent coverage gaps and low-value
properties added solely to increase a package count.

Each property is part of its package's ordinary required suite, so pull
requests execute at least 300 cases per property. The independent
`Property fuzzing` workflow runs the same complete registry every Saturday with
5,000 cases per property and a changing explicit seed. It can also be
dispatched manually with a case count, seed, and shrink path. A failing run
preserves its log for 30 days and writes an exact replay command to the workflow
summary.

Run the complete campaign locally (this builds the workspace once first):

```sh
pnpm test:property
```

Run one package while iterating:

```sh
pnpm --filter @bsv/teranode-listener test:property
```

Replay a reported counterexample exactly:

```sh
FAST_CHECK_NUM_RUNS=5000 \
FAST_CHECK_SEED=12345 \
FAST_CHECK_PATH='2:1:0' \
pnpm test:property
```

Fast-check prints the actual seed and shrink path on failure. Do not replace a
shrunk counterexample with a broad skip: first commit it as a deterministic
regression, then fix the implementation, and retain the general property.
Changes that introduce a new parser, codec, serializer, cryptographic framing
rule, network destination, or authorization decision must extend this registry
when an arbitrary-input invariant can be stated.

## Mutation-validated fuzzing

Property generation is only valuable when its assertions can detect a broken
invariant. Each registered property suite therefore has a matching Stryker mutation
target. The target mutates the implementation owned
by that property boundary and runs the smallest relevant combination of
property and deterministic regression tests. This catches weak round trips,
uncorrelated generators, assertions that only prove “did not throw,” and rare
boundaries that random generation is unlikely to reach.

The machine-readable ratchet is
`governance/mutation-testing/policy.json`. For each target it records the same
package, risk, trust boundary, and property suite as the property policy, plus
its measured minimum mutation score. All targets reject:

- any `NoCoverage` mutant in the selected implementation boundary;
- any compile-error or runtime-error mutant, which does not prove test
  detection; and
- a mutation-score regression below the target's reviewed baseline.

Surviving mutants are not automatically ignored. Review them to decide whether
they reveal a missing negative case, an insufficiently correlated generator,
an unasserted observable result, redundant implementation logic, or a genuinely
equivalent transformation. Prefer a deterministic regression plus the general
property when a survivor identifies a concrete boundary. Narrow a mutation
scope only to the implementation contract described by the registered
property; never exclude product code merely to raise the score.

Pull requests run targets whose registered implementation, property,
regression, configuration, or policy inputs changed. Lockfile changes select
only targets owned by importers whose dependency snapshots changed. Root
mutation engine, workspace toolchain, or scheduled full-matrix workflow changes
fan out to all targets; selector, scoring, unrelated SDK, CI, or governance
edits do not. Selector and score evaluation are covered by the zero-install
repository contract. The independent `Mutation quality` workflow runs the full
matrix every Sunday and can run one exact target manually. Targets execute
in parallel, reuse one workspace build, let selected siblings finish after a
failure, and preserve machine-readable reports for 30 days. Mutation runs use
the policy's fixed 300-case fast-check seed by default so the dry run and every
mutant see the same generated campaign. `FAST_CHECK_NUM_RUNS`,
`FAST_CHECK_SEED`, and `FAST_CHECK_PATH` remain available for an explicit replay
or deeper local investigation.

Application mutation targets may execute as complete-file parts while retaining
one canonical qualification gate. `output-knowledge-proposal-core` separates the
worker, Bitcoin state, knowledge store and proposal view/state; `proposal-journal-send`
separates the native journal, journal state and shared transaction domain. Each
part retains the entire original test/configuration input, property budget, seed,
worker settings and timeouts. Future files join the target's default part. The
aggregate verifies the exact canonical mutant union and original score,
no-coverage and invalid-mutant limits; a missing or timed-out part never passes.
PR CI downloads every selected part before that verification. A bounded local
campaign that times out is negative evidence, regardless of passing dry-run tests.

Pull-request CI applies the same dependency graph to package regressions,
browser/mobile consumers, infrastructure, and runtime images. Empty image and
infrastructure matrices do not allocate build runners. The standalone
TypeScript conformance workflow runs only when its vectors, specifications,
generator, or workflow change; SDK-dependent conformance behavior remains an
affected workspace regression. Cheap repository, dependency and scope checks gate installation and
compilation; Sonar remains required by the final merge gate. Selected matrix
lanes finish after a sibling failure, and every CI job has a reviewed timeout
instead of GitHub's six-hour default. The zero-install orchestration tests
enforce these resource and complete-campaign controls.

The retained-snapshot target recycles each Stryker test worker after eight mutant
executions to bound accumulated worker state. Every replacement worker runs the
same canonical test selection; the complete mutant union, four-worker concurrency,
property seeds and budgets, per-test limits and aggregate gates remain unchanged.
Worker exits and incomplete reports remain failed qualification evidence.

The retained-snapshot campaign and the three snapshot-sync groups have a
90-minute limit in PR CI and the standalone mutation workflow. The retained
campaign completed within that allowance, but the complete snapshot-sync campaign
still exceeded it ([hosted timeout](https://github.com/bsv-blockchain/ts-stack/actions/runs/36721037438/job/109907026722)).
Snapshot sync is therefore divided into orchestration (`wallet-snapshot-sync`),
destination (`wallet-snapshot-sync-destination`) and row mapping
(`wallet-snapshot-sync-rows`). Their disjoint ranges preserve the entire original
source scope, and every group runs the complete original selected test suite.
Each group independently requires at least 90% detection and zero uncovered or
invalid mutants; an aggregate score cannot hide a weak group.

The remote HTTP and service campaigns also exceeded their existing 90-minute
allowances on `6814ed282e617a7b572899915648fe03cf3d47f2`: the
[HTTP job](https://github.com/bsv-blockchain/ts-stack/actions/runs/36854954813/job/110346098383)
started 694 mutants after 550 passing dry-run tests, and the
[service job](https://github.com/bsv-blockchain/ts-stack/actions/runs/36854954813/job/110346098403)
started 1,357 mutants after 266 passing dry-run tests. Neither produced a complete
report. Their execution partitions keep every canonical specification exactly
once. HTTP places all server ranges together, all client ranges together, and
the whole protocol/RPC/transport sources in the protocol fallback. Service places
the whole controller in one part, guard/registry in another, the whole guard
backend separately, and all other sources in the persistence fallback.
Future canonical files join the
fallback automatically. Every execution part keeps the full original tests,
property suite, input dependencies and runner configuration. The existing
provenance and aggregate checks require all parts from the same source and
configuration, then evaluate the complete canonical mutant union; scores are
not averaged. These execution parts do not create new canonical targets.

The [next complete run](https://github.com/bsv-blockchain/ts-stack/actions/runs/36874901071)
also reached the 90-minute limit for retained reader/lifecycle, archive, remote
reader and service guard execution. Retained profile and relation migrations now
each execute as a whole-file part, alongside reader, storage and the lifecycle
fallback. The subsequent certificate-field migration is registered as another
complete source and whole-file part with the same full retained test selection;
its independently defined fixture is included in the input digest. Global
proof/request migration, model, MySQL metadata, SQLite metadata, bootstrap and
trigger sources are each registered in full, with the independent global fixture
included in the same retained input digest. The entry point and model share
`global-index`; the metadata backends, bootstrap and triggers each run in a
separate whole-file part. This follows a complete local monolithic run lasting
64 minutes that failed the zero-invalid gate; that failed evidence is retained.
The extraction preserves the original declaration bodies, and the separately
tested descriptor/SQL-binding corrections make broken variants fail within the
awaited migration. Every part retains the complete canonical test selection and
the existing 90-minute limit. These parts preserve the complete canonical
source and test union. Archive groups store/migration, source/closure and the capture fallback.
Remote reader groups lease, rows, page/open/cursor and the admission fallback.
These partitions retain every original source specification and full test
configuration. The single-file retained reader remains one complete part;
its traversal tests assert fixture bounds and cursor progress so broken paging
fails promptly. Partitioning and test changes require fresh complete evidence;
the cancelled run does not qualify these targets.

The eight SQLite conflict-repair helpers remain complete canonical retained
sources. Identity and membership each execute as a whole-file part; generation
shares its part with legacy ownership, bootstrap with state, and retirement with
the migration entry point. The identity/membership split follows a local
90-minute timeout on source `18748e2f4`, with 465 instrumented mutants and all 759
baseline tests passing but no complete mutation result. Preserve that failure
and its three worker crash warnings. All parts keep the full current canonical
tests and fixtures, four workers, reuse eight, the 90-minute limit, and their
independent critical score and zero-uncovered/invalid gates. Aggregation requires
the complete disjoint source union and fresh matching provenance; no target,
property budget, dependency-selection rule or acceptance threshold changes.

The journal target includes the complete receipt module in its own execution
part. All twelve journal parts retain the common complete tests/fixtures and
the existing governed property suite, including generated receipt histories.
The native receipt fixture is an explicit additional input and a 60-second group
alongside the unchanged owned MySQL generation/server-crash groups. Target and
property counts, 90% aggregate gate, zero invalid/uncovered requirement, 300-case
seeded property settings, worker/reuse limits and existing deadlines are preserved.

PR CI downloads each selected target's complete partition artifacts before
canonical verification. The orchestration regression derives the required
downloads from the canonical target registry and execution map, preventing a
new partitioned target from being omitted. Scheduled/manual qualification uses
its existing target matrix to download and independently verify the same union.

Both workflows use a 45-minute default and the same explicit 90-minute target
allowance list, including retained snapshots, snapshot sync, archive, remote
HTTP, remote reader and remote service. The execution split does not change
those limits, four mutation workers, six parallel jobs, individual mutant/test
deadlines, the 300-case fixed-seed property campaign or the 90% detection and
zero-uncovered/zero-invalid gates. A deadline cancellation is not a completed
report or a passing score.

The cancelled [PR569 campaign](https://github.com/bsv-blockchain/ts-stack/actions/runs/39466463041)
also exhausted the unchanged job limits in twenty execution units after successful
initial tests. A subsequent local identity-retirement run passed all 108 initial
tests, then exhausted its unchanged 45-minute envelope without a final report.
Its 797-mutant unit joins the same plan; this contended local failure is not a
hosted timing measurement. The source-bound execution plan is generated with
`node scripts/mutation-execution-partitions.mjs`; `--check` verifies deterministic
regeneration. The pinned installed engine derives disjoint line spans, keeping
mutants with overlapping parent spans together. The generated manifest binds
each original source hash and mutate specification. Changed sources require
regeneration; future canonical helpers remain fully owned by the first part.
The current plan retains all 99 canonical targets and 22,952 mutants in those
twenty-one units, with 246 execution rows below the existing 256-row ceiling.

Every range part retains its canonical mutation runner, complete selected unit
and property suites, and resource limits. Separately required functional files
retain their full CI invocation. The installed-engine integration check independently compares
the complete original and partitioned mutant tuples. Aggregation permits the
same source file in different parts only with identical complete source and
non-mutant report metadata, and rejects duplicate mutant ownership across parts.
It evaluates the original canonical target union and unchanged score and status
gates. Static inventory equality establishes coverage of the plan; actual
runtime fit and successful final-source qualification still require execution.

List and run targets locally:

```sh
pnpm test:mutation --list
pnpm test:mutation --target p2p-messages
pnpm test:mutation --all
```

The mutation score follows Stryker's valid-mutant definition: killed and timed
out mutants are detected; survived and uncovered mutants are undetected;
compile and runtime errors are excluded from the score but rejected separately
by this repository's policy. A score is a ratchet, not a substitute for
reviewing the surviving-mutant report and the semantic quality of each
generator.

Before running a governed non-PR suite, read its policy prerequisites. After the
run, perform its cleanup and attach evidence to the tracker or release record.
No private credential, production wallet data, or secret output belongs in CI
logs.

The complete ordinary `WalletStorageManager.journal.test.ts` file also runs
serially before the other tests in existing wallet shard 2. All ten original
cases, real two-store activation and 30-second hooks/cases remain unchanged.
Its exact file is removed only from the subsequent four ordinary invocations
and repeated mutation baselines. Coverage aggregation requires its clean exact
head/run/source identity, all ten passing original names, raw Jest report and
matching LCOV bytes through `scripts/wallet-journal-ci.mjs`. Missing, duplicate,
stale, failed or skipped evidence fails. Mutation metadata retains the full
functional file as an affected input; every other selected test/property and
all canonical mutants and acceptance gates remain required. The existing
67-row native matrix and 64-case browser inventory are unchanged.

## Required native functional lanes and mutation admission

Six full native workflow files execute in mandatory wallet CI lanes: composed
recovery (21 cases), independent-profile pairs (20), merge (6), authenticated
merge (6), retained reads (6), and user header dates (3). All 62 original cases
retain their producer plans inside the unchanged 67-row matrix. The required
aggregate gate checks actual Jest bytes, exact source identity and complete
cohort unions. Their complete workflows exceed the mutation initial-test limit
and already have separate bounded functional admission. Mutation targets
retain them as `requiredFunctionalTests` affected inputs alongside their genuine
component test selection. A functional test change still selects its owning
mutation targets. Routing checks final test globs as well as exact paths and
uses exact-file Jest ignore patterns, preserving the package's existing ignore
rules and every other selected test. A real Jest discovery regression verifies
that the retained-snapshot glob removes only its two already governed
functional files. Four of the six files were missing from the mutation metadata;
correcting that omission removes their duplicate execution from six reviewed
component selections while retaining every other test. All canonical implementation ranges, registered property
suites, minimum300 runs, seeds, global score ratchets and zero uncovered,
invalid or unexecuted mutant gates remain unchanged. No functional pass can
replace mutation evidence, and no mutation pass qualifies the full system.
Current routing is source implementation; full functional and mutation execution
must independently pass at the same head before a completion claim.

Schema-family component regressions use real private native writers and ordinary
SQLite to distinguish clustered metadata from prior-import physical rows and
refuse unowned or altered layouts. Integration modules load in awaited setup so
an initializer failure belongs to the registered test inventory. Production
schema definitions and all canonical mutants remain unchanged.

Stream failure-path regressions retain the real cipher objects while injecting
invalid output lengths or failures after actual destruction. They verify
original causes, concrete cleanup retry order, key erasure and refusal of
unvalidated output. Capability and missing-context fault tests are negative
component evidence; the original real native GCM and canonical Argon2id cases
remain mandatory and provide the positive backend evidence.

Current wallet mutation targets use reviewed explicit component selections in
`governance/mutation-testing/wallet-component-tests.json`. The original wider
component universe remains an affected input, every registered property is
mandatory, and the registry bytes and resulting configuration are bound to the
exact-head qualification identity. Related-test discovery was measured to keep
368 of371 suites for a broad target; shared imports do not provide a useful
resource boundary. Selection narrows repeated execution, never the canonical
mutant inventory or score/zero-uncovered/invalid/unexecuted gates. Every target
with browser-owned source includes a bridge to all60 original cases across19
native browser case files, and the KDF worker target retains its dedicated real
worker coverage bridge. These tests delegate to the existing native controller
and relay only actual per-test instrumentation counters. The full original
browser catalogue remains independently mandatory. Neither selected test
presence nor a scoped native pass establishes full coverage, process-tree
qualification or completion; holes require meaningful component tests.

Wallet component CI explicitly delivers the source-pinned official Chrome for
Testing155.0.8059.39 ARM64 archive. Its measured198202003-byte archive expands
to415397541 bytes across306 entries; the archive and289475976-byte executable
are checked against separate fixed SHA256 pins. Transport is bounded, extraction
stays inside an owned private directory, and changed bytes, lengths, paths or
symlink substitutes fail. The installer never disables the browser sandbox or
changes host security settings. It exposes `CHROME_BIN` for the enclosing job;
its receipt is delivery-only and grants no runtime or process-tree qualification.
Mutation setup follows the actual selected tests, avoiding the download for
node-only targets; ordinary wallet shards also receive the native browser.
Complete real browser/controller/Stryker coverage and cleanup qualification are
still required, with no skipped cases or substituted browser.

Wallet Jest compilation uses the source-owned `tsconfig.jest.json`. The canonical
mutation configuration captures its original checkout path before Stryker copies
Jest and its test root. It inherits the package's
strict compiler configuration and retains the existing CommonJS/bundler test
transform. A relocated-root integration regression copies and loads Jest before applying
the canonical runner configuration and exercising the real TypeScript transform; compiler configuration changes select every owning wallet Jest
mutation target. This fixes configuration discovery without suppressing diagnostics
or changing mutation scope, properties or score gates.

Native browser delivery follows the actual Jest glob selection, including ordered
negative exclusions, through the declared Node toolchain's standard glob matcher.
Whole-package and genuinely matched native tests receive the pinned browser;
node-only patterns do not. Exact canonical mutation and full functional scopes
remain unchanged, and routing controls grant no runtime qualification.

The unchanged native request-sync oracle measured47.3 seconds for its two
complete23.5-second preparations. Its selected case now receives90 seconds,
within the original function's120-second finite ceiling; the other59 cases
retain30 seconds. Shared test-only budgets align the catalogue, driver, CDP and
Jest timers with startup and the retained30-second cleanup allowance. The
original28/30-second failures remain evidence. All original data, assertions,
crypto parameters, production expiries and memory/PID bounds remain unchanged.
This is measured test admission; full browser, mutation and system qualification
are still required, and the measured latency remains a performance baseline.

The identity-retirement mutation target also selects the complete existing
`SnapshotSqliteSharedMembership.test.ts` and `SnapshotSqliteCompactMembership.test.ts`
files, whose ordinary SQLite source oracles directly execute its shared witness
SQL. Original component and property files remain selected, including all
300-run collation/conflict schedules. Their fixture and schema inputs participate
in affected-target selection and source binding. This adds semantic coverage;
the separately required owned-native and real MySQL qualification still apply.

The complete 39-case native integrity file runs in six mandatory cohorts with
a complete exact-head report/LCOV union. The original 67 matrix rows remain
unchanged; the six added rows retain the existing three-job concurrency,
40-minute job limit and 1,536-MiB heap. The ordinary shards and catalog mutation
baselines avoid repeating that complete file. All original data, case
names (including repeated names), 180-second owners, 210-second case guards and
4,096-operation limits remain. Actual Jest discovery verifies that this removes
only the duplicate full-file invocation and preserves every other selected
component and the registered property suite. The full file remains an affected
input; native lane dispatch/receipt controls also select owning mutation targets
and participate in final qualification identity. Every canonical mutant and
score/zero-uncovered/invalid/unexecuted gate remains required. This scheduling
repair does not resolve the separately observed retained-snapshot/sqlite-bootstrap
300-second startup failure or qualify the still-failing native integrity cases.

The retained-snapshot `sqlite-bootstrap` mutation partition uses the eight
existing direct schema component files and its unchanged registered property
suite. The selection is pinned to that partition's two complete source files
and their hashes; stale source, unknown tests/partitions and missing properties
refuse admission. Its original canonical target retains all 81 discovered
suites as affected inputs, and every other source partition keeps the original
runner configuration. Actual CI Bash and Jest discovery verifies that all 81
still execute exactly once in the four ordinary shards or the existing
receipt-gated browser lane. No original test, data, case, timeout or resource
limit changes. The 499-mutant canonical inventory, score and zero-uncovered,
invalid and unexecuted gates remain required. Targeted startup and coverage
measurements do not replace assertion-killed mutation quality or complete
exact-head functional and system qualification.

The retained snapshot `sqlite-bootstrap` execution unit uses six source-bound
canonical range packs with an explicit scheduling hint of 100 mutants. Its
complete 499-mutant inventory remains mandatory, with the same nine component
and property files in every child. The original 21 refinements are unchanged;
the complete execution matrix has 253 rows within its existing 256-row ceiling.
Packing changes scheduling only. Complete per-part receipts, the canonical
union, zero uncovered/invalid/unexecuted mutants and the original global score
and status gates remain required; an initial-run pass is not qualification.

The `proposal-channel-storage` target qualifies the complete atomic private
channel owner, writer, deadline inventory, privacy/representation contract and
session bootstrap. Its factory, writer, inventory, capacity, records, privacy and policy execution parts
split whole files only; new files fall back to factory. Every part retains the
canonical tests, 300-case native property budget, configuration and thresholds.
The final canonical aggregate remains mandatory. Passing an isolated draft or
one execution part is not a completed target qualification.

The wallet recovery encoder uses complete JSON and binary/bounds execution parts
within the existing `wallet-recovery-encoding` target. The extraction preserves
its public facade, accepted bytes and complete canonical regression/property
selection. Both reports are required for the canonical score, uncovered and
invalid gates; a completed part alone is not qualification. The prior hosted
45-minute timeout remains failed evidence until fresh exact-head CI succeeds.

The compound proposal-storage campaign recycles each test-runner process after
eight executions to bound accumulation in the long-running native Jest workers.
Its four-worker concurrency, all canonical sources/tests, generated-case budgets,
seeds, timeouts and final score/coverage/invalid gates are unchanged. This is an
execution-lifetime setting, not permission to omit a failing mutant or test.
Other targets retain their existing settings. Fresh complete qualification is
required; the preceding worker SIGABRT and missing-report timeout remain negative
evidence.

The protected-ledger target separates the complete SQLite owner from the complete
record/payload codecs. Both parts retain the same canonical custody, process-loss,
independent-process, authorization and 300-case restart tests, four workers,
deadlines and final critical gates. Workers recycle after eight executions; no
mutant or test is omitted. Both reports and the complete aggregate are required.

The former four-file compound contract execution is divided by complete file
into capacity, records, privacy and policy parts after the measured execution
approached its 45-minute bound. Factory, writer and inventory remain unchanged.
Every part retains the entire canonical test selection; no source, mutant,
property case or final gate is removed. Canonical aggregation remains required.

The application `revenue-lineage-graph` target also recycles a Jest worker after
eight mutant executions. A hosted 246-mutant run lost a worker to memory
exhaustion and reached its existing job bound without a report. Recycling does
not change the complete canonical source range, 99-test selection, property
budget, concurrency, deadlines or aggregate acceptance; fresh complete results
are required. Other lineage targets keep the previous default.

The private-publication-state target qualifies the entire native publication owner,
identity/domain pair, retained-record codec and ordered progress contract in four
disjoint whole-file execution parts. Every part retains all identity, restoration,
process-loss, deadline/authorization and 300-case native restart tests. Four workers,
the normal job deadlines, eight-execution worker recycling and the critical
90%/zero-uncovered/zero-invalid aggregate remain required. No pure transition
result or local part substitutes for actual admission/HTTP composition or final CI.

The overlay-private-publication-admission target retains both complete admission
and shared original-receipt validator modules, with private and existing proposal
unit/property tests. The proposal target also retains the extracted validator and
all its prior tests. Canonical property budgets, critical90%/zero-uncovered/
zero-invalid acceptance and existing deadlines remain unchanged; workers for the
new target recycle after eight executions. Native Engine/Mongo recovery tests run
separately from this generated unit campaign. Neither replaces full package and
exact-head hosted qualification.

The `root-eviction-coordination` target recycles each Jest worker after eight
executions. Its earlier hosted 97-mutant campaign passed all 296 canonical tests,
then lost a worker to memory exhaustion and reached the existing 45-minute job
bound without a complete report. The replacement preserves all three complete
source files, every canonical test/property case, four workers and all existing
score, uncovered, invalid and deadline gates. Other root targets keep their
previous runner settings. Fresh complete qualification is required; the cancelled
run remains failed evidence and is not accepted by this configuration change.

The bounded-worker lineage graph follow-up still reached its hosted 90-minute
limit without a report. The behavior-preserving private extraction separates the
complete layout/ABI and genesis/transition modules from the remaining graph
traversal module. Graph execution now has two whole-file parts, each retaining all
99 canonical tests and the original property budgets, workers, seeds and deadline;
the complete graph aggregate and independent traversal gate remain required.
Source-union and selected-artifact assertions prevent either helper from being
omitted. No public API or verification rule changes, and the cancelled hosted
attempt remains failed evidence.

The root journal, records, codec and storage targets also use the optional
eight-execution worker recycling setting. Their earlier hosted runs passed all296
baseline tests but reached the unchanged90-minute limit without complete reports;
those logs do not establish memory exhaustion as the cause. The setting is a
measured execution remedy, subject to complete qualification. Every complete
source, canonical test, seed, property budget, four-worker bound, existing records
partition and final critical gate remains unchanged. No cancelled report counts
as a passing result.

### Private publication composition

`private-publication-coordination` covers all seven complete authority, port,
coordinator, disclosure, work and reconciler modules. Its disjoint whole-file
parts each retain the full state/service/availability/authority/recovery/property
test union and actual Engine/HTTP integration cases. `private-publication-http`
covers all four transport modules and every native HTTP, response-driver, property
and cross-package integration test. Its routes, policy and guard parts preserve
the complete source union. The existing state and service targets add material-loss
availability cases without removing prior source or tests.

Both additions retain the critical 90% score, zero uncovered and zero invalid
gates, canonical property budgets and seeds, four workers and bounded runner reuse.
Selected complete artifacts are required by the final canonical aggregate gate.
Local report generation, a passing baseline or an incomplete/cancelled campaign
does not qualify any target.

### Paid acquisition foundations and execution follow-ups

`private-acquisition-foundation` qualifies five complete modules for original
paid lookup contracts, pinned-candidate lifecycle, exact BRC-29/Script/SPV funding,
native seller-wide funding uniqueness and recipient projection. Each whole-file
part retains all canonical tests, including protected-ledger compatibility,
300 generated lifecycle schedules and the separate-process SQLite claim race.
The critical aggregate score remains90%, with zero uncovered or invalid mutants,
four workers, bounded reuse8 and complete selected artifacts. These helpers do
not by themselves qualify the full paid acquisition service.

The proposal journal and HTTP targets now recycle each worker after eight
executions. Journal execution separates the complete facade and store files;
state/domain remain separate. HTTP separates complete routes, response guard and
policy/ports. Every part retains the original canonical test selection (209
journal and224 HTTP tests at the recorded hosted attempt), all sources, seeds,
budgets and45-minute bounds. Lookup sessions alone selects the same optional
reuse8 setting; every other lookup factory default stays unchanged. Its earlier
503-mutant/190-test attempt reached45minutes without a report. The204-mutant
proposal channel inventory cancellation already used reuse8 and is not resolved
by these changes. Every cancellation remains incomplete qualification until a
complete fresh run satisfies the unchanged gates.

`private-acquisition-state` qualifies all four complete payload, original-record,
state and native-owner modules in four disjoint whole-file execution parts.
Every part runs the complete canonical acquisition foundation and native-owner
suites, including the 300 generated native histories, process-loss boundaries,
private domain/identity and protected-ledger compatibility tests. The explicit
local batch tests also remain in the protected-ledger target. Execution uses
four workers, optional runner reuse of eight and the existing 45-minute part
bound. Complete aggregate score 90, zero uncovered and zero invalid remain
required; no individual part is substituted for the complete target.

`private-acquisition-coordination` retains nine complete modules across eight
whole-file parts. Each part includes all canonical acquisition state/foundation
and protected-ledger tests, the 300 service-interruption histories, worker tests,
release evidence and real Wallet Toolbox/SQLite receipt tests. The latter use the
public CJS development dependency, a same-head wallet build, fresh synthetic
storage and a trapped broadcast port. Wallet source, manifest, TypeScript build
configuration and fixtures are affected inputs. Existing four-worker/reuse-eight,
45-minute-part and complete aggregate 90/zero-uncovered/invalid requirements stay
unchanged. Cross-package HTTP qualification is a separate subsequent registration.

`private-acquisition-http` retains five complete modules across routes (including
ports), policy, guard and host parts. Every part keeps the full acquisition and
private-host suites, seeded 300-case authenticated signing/recovery schedules and
all private-publication HTTP/engine compatibility suites. Native wallet,
application, SDK, authentication and host inputs remain dependencies; the build
uses the same-head wallet and application packages. Existing four workers,
reuse eight, 45-minute parts and complete aggregate 90/zero-uncovered/invalid gates
remain unchanged. Independent legacy host and packed SDK-floor checks remain
required; this registration does not imply their success.

`sdk-paid-lookup-http` mutates the complete transport and shared finite HTTP owner
in disjoint whole-file parts, retaining all new transport/funding tests and all
existing proposal, root-eviction and lookup compatibility suites in every part.
The same new complete test union is added to `sdk-auth-http`,
`sdk-root-eviction-http` and `output-proposal-http`. `protected-operation-state`
mutates all three complete modules in wallet/interface and state parts, retaining
all protected/native/property/process and original operation-state tests. Both
new targets keep four workers, reuse eight, 300 cases/seed3242026/replay and
45-minute parts with aggregate90/zero uncovered/invalid. Explicit native-worker,
SDK and original store inputs select the same-head prerequisite builds.

The existing `wallet-recovery-controller` retains its complete controller plus
the complete managed signer, every original recovery test, added deadline
histories and shared signing/template compatibility tests. Its existing deadline
and target/property count remain unchanged. These inventories describe required
qualification, not an assertion that a particular head has passed it.

`protected-operation-objects` qualifies five complete native/browser operation
object modules in four disjoint whole-file parts. Every part retains all new
object/control/state tests and protected-ledger/payload compatibility suites,
both native child workers, backing storage/custody and SDK inputs, and the
same-head build. The protected-control target also retains the new dependencies
selected by its existing broad test union. Both generated backend histories run
at least 300 cases with the governed seed/replay. Four workers, the new target's
runner reuse of eight, 45-minute parts, complete aggregate 90% and zero uncovered
or invalid mutants remain mandatory. No prior source/test selection, threshold,
budget or deadline is narrowed.

`private-lookup-buyer` qualifies the complete buyer, payment adapter, interfaces
and entry in disjoint buyer/payment parts. Both retain the same complete buyer
and native payment test union, original encrypted custody fixtures, SDK transport
and actual wallet source inputs, with same-head wallet/application builds. Its
separate 300-case seeded property suite explores original-obligation interruption,
expiry, validation and reopen histories. Four workers, reuse eight, 45-minute
parts and complete aggregate 90%/zero uncovered/invalid remain required. Existing
targets and ordinary PR mutation deferral are preserved; deferred CI is not
complete-campaign evidence.

`lch-overlay-acquisition` qualifies every complete optional acquisition module
and the complete `overlay-acquisition*.test.ts` union, including actual signatures,
funding verification, native encrypted custody and licensed playback. Ordinary LCH
and SDK/application prerequisites remain registered inputs. Its separate 300-case
seeded codec/property entry covers both modes and original-byte evidence histories.
The new critical target retains a complete aggregate 90% minimum and zero uncovered
or invalid mutants. Existing wallet targets, source/test unions, thresholds,
deadlines and complete-campaign policy remain unchanged. Registration alone is not
passing campaign evidence.

`revenue-listing-purchase` qualifies the complete prepared-purchase verifier with
both full unit/property suites and the disclosed lineage/authority/funding fixture
closure. Its 300 seeded generated cases distinguish Script-valid receipts from
association with the original seller/request/recipient. The complete critical
source retains score90, zero uncovered/invalid/unexecuted, four workers and the
existing deadline/seed policy. It has no source partition; a named feedback run
is diagnostic, while the final complete campaign remains mandatory. Existing
wallet, application, LCH and administrative-route target unions remain intact.

`private-purchase-contract` qualifies the complete original-preparation contract
module with its full unit suite, disclosed fixture and separate 300-case seeded
property suite. `private-purchase-state` qualifies both complete progress and
SQLite custody modules with their full unit/fixture union and 300 actual native
interruption/reopen histories. Both critical targets require score90 and zero
uncovered, invalid or unexecuted mutants, preserving existing seeds, workers,
deadlines and complete-campaign-only qualification. Neither has a source partition
or an excluded source region. Their registrations are additional obligations;
passing component tests does not establish admission, release or full campaign
completion.

## Complete alias initial suites and qualification jobs

The approved private-purchase/alias composition keeps every original test and
mutation target. Its complete initial-suite allowance is 15 minutes for thirteen
profiles and 30 minutes for private-purchase-buyer; the registry regression tests
enumerate all fourteen, including five derived alias profiles. This is an outer
suite allowance, separate from each property's original 300-case minimum,
150-second interruption and 180-second case timeout.

Only the qualification profile grants 180-minute whole jobs to
wallet-funding-controller, revenue-listing-authority and revenue-listing-profile.
Ordinary diagnostic 45/90-minute limits and all other job limits are unchanged.
The complete 151-target/398-row campaign, unchanged source partitions, worker
limits and score gates still require successful final reports and independent
reconciliation on the exact published commit. A timeout or missing report remains
a failed run; prior failures cannot be reclassified by the larger allowance.
