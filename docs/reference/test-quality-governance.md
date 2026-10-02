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
