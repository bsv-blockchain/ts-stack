---
id: test-quality-governance
title: 'Test Quality and Skip Governance'
kind: reference
version: '1.1.0'
last_updated: '2026-07-26'
last_verified: '2026-08-26'
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

Required CI uses `fast-check` to generate and shrink unexpected inputs across
25 packages and the stack's highest-risk trust boundaries:

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
- untrusted application data: Mandala linkage payloads, BTMS metadata and
  derivation instructions, canonical token amounts and asset IDs, and
  forge-resistant overlay log fields.

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
below 300 generated cases. It also inventories all 33 package manifests: each
must either own a registered property suite or have a dated, owned exclusion
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
invariant. Every one of the 25 registered property suites therefore has a
matching Stryker mutation target. The target mutates the implementation owned
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
in parallel, reuse one workspace build, cancel unfinished siblings after a
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
affected workspace regression. Cheap repository, dependency, scope, and Sonar
checks gate installation and compilation, matrix lanes cancel siblings on a
failure, and every CI job has a reviewed timeout instead of GitHub's six-hour
default. The zero-install orchestration tests enforce these resource and
fail-fast controls.

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
