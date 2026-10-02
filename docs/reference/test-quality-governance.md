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
