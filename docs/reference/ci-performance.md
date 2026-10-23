---
id: ci-performance
title: 'CI Performance Governance'
kind: reference
version: '1.5.0'
last_updated: '2026-10-21'
last_verified: '2026-10-21'
review_cadence_days: 30
status: stable
tags: [reference, ci, performance, github-actions]
---

# CI Performance Governance

The weekly `CI performance trend` workflow classifies successful pull-request
CI runs as full-scope (at least 50 executed, non-skipped jobs) or targeted,
retains the latest 20 of each class, and compares median and p95 end-to-end duration with
`governance/ci-performance-baseline.json`. A material regression fails the
workflow and requires timing evidence before its budget or baseline changes.

The uploaded JSON report retains run, job, and step duration; queue time;
prepare-job duration; artifact upload/download duration; and variance. This
separates targeted feedback from the complete merge gate so a changing PR mix
cannot make the trend appear faster or slower by accident.

The zero-install scope job resolves three distinct package sets from the
workspace dependency graph. Directly changed package importers own coverage
suites; their reverse-dependency closure owns non-instrumented regression,
compatibility, and browser checks; and the forward closure supplies every build
prerequisite. This preserves behavioral coverage of possible consumers without
paying to regenerate unchanged packages' coverage reports.
A lockfile change selects every package importer whose installed graph reaches
a changed or republished package, directly or not, in either lockfile, instead
of treating the root lockfile as a global invalidation. An indirect upgrade
therefore tests the packages that install it even when no importer entry
changed. Changes to the root importer's own dependencies or to lockfile settings
select the complete graph; root tools reached only indirectly run in the lint,
build and artifact jobs on every pull request. A `pnpm-workspace.yaml` change
confined to resolution settings (overrides, patches, package extensions,
catalogs, release age) defers to that lockfile analysis, and a project registry
change confined to project entries selects only the changed or added projects.
Root compiler, other workspace settings and shared CI execution controls select
the complete graph deliberately.

Mutation selection follows each target's exact implementation, property,
regression, configuration, and policy inputs. Package-wide mutation suites
expand only where their configuration really covers the whole package. Image
jobs follow changed build contexts. Changes to the shared CI workflow validate
all infrastructure build lanes; unrelated documentation workflow changes do not.
Shared image/runtime contract inputs fan out to the registered consumers.

The main CI workflow builds the selected graph once and shares immutable
outputs with isolated test lanes, skips empty lanes, installs through the
setup-node pnpm cache, caches the immutable MongoDB test binary, and rebuilds
native/build tools only in jobs that execute them. Browser lanes retain exact
package-composition reports without rebuilding the workspace. The shared
build starts immediately, beside the scope job and the repository-health
contract, and builds every workspace package (unchanged ones restore from the
package build cache); test lanes, lint and policy start only after the repository-health,
scope and dependency-review gates pass. Lint and policy run beside the test
lanes and gate `build-and-test` and the merge gate. The scope job also plans the
test-lane matrices, since that needs only Node and jq. Exact-head Sonar analysis runs concurrently with the
shared build and remains mandatory in the final merge gate. Expensive PR mutation waits for both a
successful shared build and successful exact-head Sonar analysis. Main and
manual full campaigns allow only the intentional skip of the PR-only analyzer
gate. A failed, cancelled, missing or unexpectedly skipped analyzer stops the
normal mutation launch; suppressed selected mutation is not qualified evidence.
Package artifact checks and documentation consumers run beside the tests after the shared build, with their own required
result. They are sharded by measured per-package check time (the
`package-artifacts` lane), pack the restored shared build instead of rebuilding each package,
resolve all of a package's public entrypoints in one process per module system
(the SDK has 459), and reuse an npm download cache that npm verifies against
each tarball's integrity hash. Matrix siblings finish after a failure so acceptance
evidence includes every selected shard. Within a regression or coverage shard,
packages execute serially because individual test runners already use worker
pools; this prevents nested pools starving real-cryptography integration tests.
These controls reduce repeated CPU, network, and setup work without weakening
the tests selected by the dependency or registered trust-boundary graph.

## Planned coverage shards

The `coverage-other` lane runs each shard's packages serially, so a shard lasts
as long as the sum of its packages and the lane lasts as long as its slowest
shard. It previously used one shard for one package and two otherwise,
assigning packages round-robin by name. On one long-running branch the first
shard ran 855–1,503 seconds while the second finished in 117–211.

`scripts/ci-shard-plan.mjs` now plans the matrix from
`governance/ci-lane-durations.json`. The shard count is the larger of the
estimated total divided by the per-shard target and the package count divided
by six, capped at six shards. Packages are assigned longest first to the
least-loaded shard that has not reached its even share of packages, so one
package that becomes slow in a pull request shares its shard with only a few
others. Planning decides only which shard runs a package; every selected
package still runs exactly once and serially.

Each shard prints `coverage-other-duration <package> <seconds>s` and a summary
table. Refresh the lane durations from those hosted values; the initial
values come from a hosted full-scope run on 2026-10-21. Against round-robin on
the same runners, the slowest shard fell from 410 to 161 seconds while total
shard time rose from 608 to 774 seconds.

## Duration-balanced test-file shards

The wallet-toolbox and SDK coverage lanes shard by test file with
`scripts/jest-duration-sequencer.cjs` instead of Jest's path-hash sharding. The
sequencer assigns files longest first to the least-loaded shard from the
governed per-file seconds in `governance/ci-lane-durations.json`; every file
still runs in exactly one shard. The SDK shards disable Jest's per-run threshold
check because each sees part of the coverage; `Coverage / SDK thresholds` merges
their Istanbul maps with the library Jest uses and enforces the SDK's configured
global thresholds, so the result matches one unsharded run. The packed SDK
browser and UMD contract checks run beside the coverage shards.

The shared build restores each package's outputs from a cache keyed on the git
blob ids of the package's own files, of every workspace package it depends on,
and of the root toolchain inputs (`scripts/build-output-cache.mjs`); only
packages whose inputs changed are built. Typecheck runs in the lint and policy
job after the build, beside the test lanes.

The affected-dependents lane plans its shards the same way from measured
per-package test seconds (the `dependent-tests` lane). The wallet-toolbox
storage shards start their pinned Postgres container in the background after
checkout and wait for it to report healthy before Jest starts.

The wallet-toolbox synced-header test restores a cached mainnet header store,
keyed on the chaintracks storage code that writes it, instead of downloading
about 75 MB from the header CDN into a fresh store on every run.

## Execution ledger across outcomes and attempts

The weekly trend also writes `ci-execution-ledger.json`. This separate ledger
includes the latest 20 PR CI runs of every outcome and every attempt, including
failed, cancelled and unfinished work and multiple runs of the same head. It
does not replace the successful-run latency ratchet or reset its baseline.

Attempt-specific API pages retain run, attempt, head and job identities. Complete
job durations, including setup and teardown, are summed as runner execution
seconds; unfinished or missing durations remain unknown, so that total is a
lower bound. Duplicate delivery is counted once; conflicting duplicates,
inconsistent attempt metadata, incomplete pagination or exceeded bounds fail
collection rather than silently omit work. Bounds are 20 recent runs, 10
attempts per run and 1000 jobs per attempt. This is a recent window, not lifetime
usage. The ledger is retained even if the subsequent successful-run budget fails.

Declared/skipped mutation jobs do not prove selected source scope or passing
qualification. A cancellation does not identify timeout versus supersession.
Runner billing, actual scheduler queue, dependency-ready timing and selected
target union remain unavailable; do not invent them from this API. Initial
admission is reported only for the first attempt. Execution span uses observed
job timestamps rather than a potentially stale workflow `updated_at`, and is
unknown while the attempt is unfinished. The workflow retains its existing
read-only permissions and 90-day artifact retention.

Local read-only collection with an authenticated token:

```bash
node scripts/ci-performance.mjs --collect \
  --baseline governance/ci-performance-baseline.json \
  --output ci-performance-report.json \
  --execution-ledger-output ci-execution-ledger.json
```

## Explicit mutation diagnostics

For a PR, apply the `ci:mutation-diagnostics` label before the next ordinary CI
trigger (opening, reopening or pushing the PR). Adding or removing the label
alone does not start a campaign; normal qualification resumes on the next run
without the label. This opt-in permits collecting mutation results after a
failed or unavailable analyzer prerequisite. It does not waive required Sonar,
CodeQL, coverage, audit or merge gates, and it does not qualify a failed PR.

For a manual full-tree campaign, select the boolean `mutation-diagnostics`
workflow input explicitly (default `false`). The normal manual run already
permits the intentional PR-only Sonar skip; the diagnostic input is only an
eligibility override if that analyzer prerequisite has another result. A manual
campaign is not a replacement for the exact-head PR analyzer and merge gate.

Both diagnostic routes still require the successful audited shared build, a
nonempty selected target set and an uncancelled workflow. They preserve every
selected source, test, threshold, worker and timeout. Mutation reports remain
retained on failure. A successful diagnostic mutation result never turns a
failed prerequisite into successful qualification. Existing mutation siblings
finish to collect evidence after a mutation failure; this opt-in changes the
preliminary analyzer eligibility, not matrix failure handling.

To refresh the evidence without changing the baseline:

```bash
GITHUB_TOKEN=... node scripts/ci-performance.mjs \
  --collect \
  --baseline governance/ci-performance-baseline.json \
  --output ci-performance-report.json
```

Changing the committed baseline requires a reviewed PR:

```bash
GITHUB_TOKEN=... node scripts/ci-performance.mjs \
  --collect \
  --write-baseline governance/ci-performance-baseline.json
```

Review the 40 exact run links, classification threshold, sample summaries,
workflow or runner changes, and the stated median/p95 budget. Never loosen a
budget solely to make a red trend green.

## Sampling and investigation

The collector searches up to ten pages of successful PR runs, deduplicates source
heads, and paginates each run's complete job list. It retains 20 full-scope and
20 targeted runs, including job and step timings. When history cannot supply the
required sample, it writes the partial report before failing; incomplete samples
cannot establish a new baseline. API requests and pagination are bounded.

The September review found that the July baseline predates the optical-codec
mutation target and later QA additions. In the recovered 40-run sample, full-scope
median/p95 was 2,007/2,254 seconds and targeted median/p95 was 566/833 seconds.
The optical-codec mutation job dominated full runs (median 1,378 seconds), while
wallet coverage dominated the longer targeted runs. Those observations do not by
themselves justify raising the budget. Keep the historical baseline until a
reviewed workload comparison and measurements justify a replacement.

The duplicate-tracking codec regression now bounds its fixture's search and
avoids constructing a successful Jest matcher for every redundant frame. It
still sends more than the actual tracking limit, checks every acceptance result,
repeats the final frame and verifies exact recovered bytes. Mutation and property
coverage, payload sizes, test counts and timeout budgets remain governed.

## Complete release acceptance

Dispatch `CI` manually on the reviewed main commit to select the entire governed
workspace, all infrastructure build lanes and mutation targets. This deliberately
uses the workflow's all-scope path instead of comparing only the latest commit.
Source merges still validate their affected scope automatically.

Every execution lane uses an explicit successful-preparation condition that
survives intentionally skipped PR-only gates on a main push and honors explicit
workflow cancellation so obsolete runs cannot hold the concurrency slot. The final result
gate independently checks scope outputs against each job result: selected jobs
must succeed; missing, cancelled or skipped selected jobs fail the merge gate.
Only genuinely unselected lanes and main's PR-only checks may be skipped.
Do not infer full release acceptance from a green documentation-only push.

## Contributor-fork coverage

Public fork PRs upload the merged LCOV evidence through the pinned Codecov action's
[tokenless fork mode](https://github.com/codecov/codecov-action#v4-release).
GitHub withholds repository secrets from these ordinary `pull_request` jobs;
no privileged trigger or additional write/OIDC permission is granted. The uploader,
processing check and final notifications run for every nonempty report, so the
advisory `codecov/patch` report is available for contributors as well as maintainers.
The repository-owned 90% patch-coverage check is mandatory on the exact diff.
The repository ruleset must require `merge-gate` and must not require the duplicate
external `codecov/patch` status. Uploading, processing and notification run in a
separate reporting job after the local gate, so an external service outage cannot
block a tested change. Sonar, CodeQL, Socket, dependency review, conformance,
review resolution and branch protections remain required.

## September 25 critical-path correction

PR #617 run [36094137059](https://github.com/bsv-blockchain/ts-stack/actions/runs/36094137059)
took 1,018 seconds to reach merge-gate. Wallet shard 4 took 612 seconds, including
524 seconds for two sequential real-HTTP sync scenarios; the other wallet shards
took 85–124 seconds. Main run 36095294323 confirmed the same long tail. These are
observations, not a replacement performance baseline.

The 0 ms and 1,000 ms HTTP scenarios now execute independently in two additional
required wallet coverage matrix entries. The four ordinary shards exclude only
that file, and each added entry selects one exact latency scenario from it. Their
LCOV reports participate in the same mandatory aggregate check. Payload sizes,
real authentication, retry/restart/integrity assertions, artificial latency and
production deadlines are unchanged. Separate Jest processes preserve the suite's
global transport spies; running the two cases concurrently inside one process
would be unsafe. No scenario is moved to a schedule or omitted from a wallet change.

Sonar waiting (79 seconds), package checks (71 seconds), and Codecov processing
(29 seconds) were also on that PR's serial path. Required Sonar analysis and
package checks now overlap execution; the duplicate external reporting wait is
outside the merge gate. Verify the new run timings before claiming a measured
speedup. Shared CI changes still select the complete governed execution graph.

## Mutation runs as a full campaign, not a PR gate

Mutation testing no longer executes on ordinary pull requests or pushes.
`scripts/ci-mutation-scope.mjs` selects no targets for a compared range and
reports the complete registry as deferred (`high`) or outside (`critical`);
both mean **not executed, not passed**. The merge gate still verifies that this
is a complete disjoint canonical partition and that the executed matrix equals
the `required` list, so an unexpectedly selected or missing job fails closed.
The scope job needs no workspace install for this: it only reads the registry
and policy with the pinned Node.js runtime.

The complete governed registry runs in three places: a manual `CI`
`workflow_dispatch` on the reviewed commit (the all-scope path), the weekly
scheduled or manually dispatched `Mutation quality` workflow (full campaign or
one exact diagnostic target on any ref), and the release final qualification
below. Run one of these before publication or when a change to a governed
boundary needs assertion-strength evidence; `pnpm test:mutation --target <id>`
remains available locally. The `ci:mutation-diagnostics` label and the
`mutation-diagnostics` dispatch input keep their analyzer-eligibility meaning
for those full campaigns.

This is a deliberate trade: before this change the compared-range selector
required the whole registry on 49 of the previous 60 merged pull requests
(release-notes and health-baseline metadata alone triggered 27 of them), so a
documentation-only or single-package fix waited 25–40 minutes behind 33–37
mutation jobs on six runners while every other lane finished in under five.
Mutation results describe each target's own assertions against its own source;
a dependency change is covered by the dependents' regular and compatibility
test lanes, which still run on the affected graph. Record the measured
`CI performance trend` after adoption before claiming an exact speedup.

Complete final qualification runs every canonical target at the exact source
candidate before npm, general OCI or Marketplace publication. Per-target raw
reports and receipts bind source SHA, run, attempt, pinned runtime, configuration,
lock and target union. The final verifier repeats static instrumentation with the
pinned Stryker engine and checks complete mutant tuple multisets, source bytes,
execution configuration and every existing score/no-coverage/invalid gate.
Zero-mutant files may omit report entries; missing mutant-bearing files cannot.
Static replay checks inventory, not assertion quality or runtime freshness. Fresh
report-directory removal, successful matrix jobs and same-attempt receipts supply
execution provenance. `Ignored` is accepted only when the same source directive
produces the same reason during replay. Timeout remains part of the existing
detected score; it is not an assertion-killed result.

A manual single-target campaign is explicitly diagnostic and issues no full
qualification SHA. Partial, stale, cancelled, failed or missing-target campaigns
cannot authorize publication. Full reruns must rerun every job: receipts from an
older attempt do not fill gaps. Weekly qualification remains useful trend evidence
and cannot qualify a different release source. Qualification is exhaustive over
the **governed registry**, not every production line in the repository.

### What the current scores measure

Changing a minimum score does not make Stryker execute fewer mutants: this
repository evaluates the governed score after the report completes. Mutation
checks whether assertions detect injected faults; ordinary line/branch coverage
only establishes execution. The two are related but do not supply the same
oracle. Patch coverage combines executable line and branch points and can be
misclassified by fixture paths; lowering its percentage does not correct a
missing-file classification error.

Review actual source ranges before relying on a target's broad name. For
example, current `amount-format` includes currency-converter lines 208–260 but
omits the later satoshi safety and conversion arithmetic; `overlay-integrity`
includes BASM 154–190 but omits later Merkle-pair and TAC hash computations.
These are inventory limitations, not permission to silently omit existing
checks or claim the full registry proves all funds and hashing behavior.
Air-gap's frame-loss property has an explicit 120-case override, so a scheduled
5,000-case input does not make every property run 5,000 cases. Performance and
assurance reports should distinguish configured inputs from effective cases,
assertion-killed mutants from timeouts, and measured exact-source evidence from
historical target names. None of these metrics establishes historical escaped-
defect yield or an optimal percentage threshold by itself.

### SDKAuth execution partitions

The existing `sdk-auth-http` target remains one canonical policy/property
registration. Its source specifications are grouped by file into Peer, AuthFetch
client and SimplifiedFetchTransport parts, and AuthMessageValidation is cut at
line markers into core, snapshot and policy parts. A new canonical helper
defaults to core, and unsupported wildcard/unknown partition inputs fail. Each part retains the complete original
Jest test selection, four workers and governed property inputs. The current pinned
inventory replays to 37 + 16 + 20 + 22 + 137 + 91 = 323 mutants, exactly matching the
unpartitioned canonical inventory.

A part's score is diagnostic. It still requires complete actual source/config/
mutant evidence and zero uncovered/invalid outcomes. Only the combined original
canonical denominator and score can pass the target's required gate. Missing,
duplicate, overlapping, changed, stale or differently seeded parts fail. Completion
ordering and part-local mutant IDs cannot change the canonical result. The full
qualification workflow retains raw reports and independently reconstructs the
aggregate before it can issue the publication SHA.

PR matrix execution still waits for the prerequisite/analysis policy from #705;
diagnostics cannot bypass failed final gates. Six matrix jobs remain the global
parallelism limit, with four Stryker workers in each part. The required PR
aggregate receives only contents-read permission to check out its verifier; no
write permission, security setting or branch-protection change is introduced.

Archived SDKAuth jobs have a 19–37 minute tail. Three smaller parallel jobs can
reduce that tail, but they repeat the complete dry run three times and add
aggregate installation/replay setup. Queue contention may shift other targets.
The static 323-mutant equivalence proof is not a measured hosted speedup or a
billing estimate. Record comparable exact-source elapsed time, total execution,
dry-run and aggregate overhead before claiming a reduction. Wallet retained
snapshot partition adoption is independently owned and is not implemented by
this SDKAuth change.

### Retained snapshot partition adoption

The same required canonical aggregation supports an actually registered
`wallet-retained-snapshot`: whole retained lifecycle, whole Knex reader, and
all original StorageKnex/StorageProvider ranges. Future canonical sources join
lifecycle; every part keeps the complete original tests and property/config
settings. Selection creates no target absent from the current registry. PR and
full qualification require every selected partitioned target's original global
gate and full publication independently reconstructs its raw evidence.

Historical source `7539b7109de2c2cffa220b7a9df622ab807ab269` has exactly
110 lifecycle + 455 reader + 39 storage = 604 distinct canonical mutants. Its
hosted job ran 89m53s before a 90-minute timeout without a final report. The
reader contains 75% of these sites, so file splitting can leave a substantial
tail. Counts do not predict runtime; repeated complete dry runs, verifier setup
and six-slot contention add compute. No measured improvement is established.
This source proof cannot qualify a newer wallet head: its owner must compare
the full pinned inventory/configuration on the final source before adoption.
Registry, runtime, assertions, workers, deadlines and thresholds remain owned
and unchanged by the partition facility.

### Line-split execution partitions

Full qualification wall time is bounded by its slowest target. Before line
splitting, `brc52-envelope` took 22–32 minutes in every release campaign: all 358
mutants of one file share almost the complete 291-test selection, so a file
partition cannot divide it. A line plan in `scripts/mutation-partitions.mjs`
cuts a file at explicit declaration markers instead. Each marker must start
exactly one source line, in order, so an edit that moves, removes or duplicates
one fails closed. The segments are contiguous from line 1 to the last line, and
every original specification is intersected with each segment, so overlapping
canonical ranges keep their original union.

The canonical registry, inventory, tests, workers, property inputs and score
gate are unchanged. The combined report merges a split file's mutants only when
every part carries the identical source, orders them by partition, and must
then equal the canonical whole-target inventory exactly; a dropped or
double-tested mutant fails. `scripts/ci-integration/sdk-auth-partitions.test.mjs`
replays every partitioned target against the pinned instrumenter on each PR.

Current pinned inventories:

| Target             | Parts                                                  | Mutants |
| ------------------ | ------------------------------------------------------ | ------- |
| `brc52-envelope`   | 64 + 64 + 64 + 50 + 70 + 46 (lines)                    | 358     |
| `brc52-status`     | 201 + 164 (lines)                                      | 365     |
| `brc52-disclosure` | 192 + 134 (lines)                                      | 326     |
| `air-gap-codec`    | decoder 94 + 105 (lines), encoder 75, coding/base64 80 | 354     |
| `webrtpay-frames`  | 110 + 119 (lines)                                      | 229     |
| `mandala-encoding` | mandala 93, strict CBOR 352, BSV-21 336                | 781     |
| `webrtpay-codes`   | codes 273, SDP 532                                     | 805     |

Each extra part repeats the target's dry run and job setup, so total compute
rises while the campaign tail falls. The matrix grows from 41 to 56 jobs under
the unchanged 20-job limit.

### Automatic file partitions

Hand-written plans cannot keep up with new targets: `color-permission`, added
with 1,072 mutants on 2026-10-20, ran alone for more than 25 minutes in the next
full campaign while every planned part had finished within 6m15s.

A target without an explicit plan now splits automatically when it is slow.
Mutant count does not predict time, because tests dominate (676 `auth`
mutants take under two minutes; 358 `brc52-envelope` mutants took fifteen), so
the estimate is the target's measured seconds in
`governance/mutation-testing/durations.json`. A target never measured uses a
deliberately pessimistic one second per code line. A file whose share of the
estimate exceeds one 180-second part is cut inside at top-level declaration
lines (`function`, `class`, `const`, `export …` at column zero), or at member
declarations of a top-level class (methods, constructor and accessors at the
two-space Prettier indent), that are unique line prefixes, balanced by code
lines; a mutant cannot span two top-level statements or two class members, and
a two-space line inside a function, method, string, template, or comment is
never a cut. Whole files and file segments are then grouped heaviest first into
the estimate over 180 seconds parts. Explicit plans, including hand-placed line
cuts, keep priority. Today `color-permission` splits automatically into twelve
parts and `reorg-stream` into two; the exhaustiveness replay covers every target
that executes in parts, so an automatic cut that dropped or duplicated a mutant
fails CI.

In release run
[39845676503](https://github.com/bsv-blockchain/ts-stack/actions/runs/39845676503)
the slowest `color-permission` part held the whole `strictJson.ts` `Parser`
class and ran 7m37s. With class member cuts and a 240-second part the slowest
part was the head of `identifiers.ts` at 6m48s
([39917134050](https://github.com/bsv-blockchain/ts-stack/actions/runs/39917134050)).
The part target is now 180 seconds: estimated from that run's per-part times,
the slowest of twelve parts takes about 4m40s, below the hand-planned
`webrtpay-codes/sdp` (5m17s). An extra part costs only its own setup now that
every part starts at once.

### Stop-on-kill Jest environment

StrykerJS treats a mutant as killed by its first failing test and bails for its
other runners; the Vitest runner sets `bail: 1`. The Jest runner instead forces
`bail: false`, because Jest's own bail exits the process, so every later test
covering an already-killed mutant still ran. In the 2026-10-19 `brc52-envelope`
release report, 330 of 358 mutants were killed, yet each mutant ran 139.6 tests
on average.

`governance/mutation-testing/stop-on-kill-environment.cjs` extends the package's
Node environment. While Stryker has an active mutant and one of its tests has
failed, it marks each remaining test as skipped at `test_start`, which
jest-circus dispatches before reading the skip mode. It does nothing without an
active mutant, so the initial coverage run and plain `jest` runs execute every
test, and a surviving mutant still runs every covering test. Every governed Jest
target uses it.

Verdicts cannot change: a mutant with a failing test is Killed regardless of
later tests. A local same-machine run of `brc52-envelope/envelope-2` produced
identical verdicts for all 64 mutants (61 Killed, 3 Survived) while tests run
per mutant fell from 138.8 to 19.2 and wall time from 117 to 50 seconds.

### Longest-first campaign scheduling

GitHub starts matrix jobs in listed order up to the concurrency limit. With the
registry order, long parts could start last and run alone at the end. The
`matrix` command now lists parts longest first from
`governance/mutation-testing/durations.json` (measured hosted job seconds), the
longest-processing-time-first heuristic for parallel machine scheduling. Order
changes only when a part starts, never which parts run; an unmeasured part sorts
first. Refresh the durations after a campaign whose part timings changed.

Fork benchmark, same runners, about six concurrent jobs, every gate passing:

| Campaign                  | Wall   | Longest part                | Total part time |
| ------------------------- | ------ | --------------------------- | --------------- |
| Unchanged main            | 26m36s | 23m44s `brc52-envelope`     | 167m39s         |
| Partitions only           | 35m17s | 14m51s `sdk-auth-http/core` | 164m49s         |
| Partitions + stop-on-kill | 17m01s | 6m10s `sdk-auth-http/core`  | 105m48s         |

Partitions alone were slower there because long parts queued behind short ones,
which longest-first ordering addresses.

The full campaign has since grown to about 70 parts. `mutation-tests.yml` now
allows 100 parallel parts, so the whole campaign starts at once and its longest
part bounds wall time; total runner time is unchanged. The canonical global
gates that merge each partitioned target's parts ran two at a time and added
about three minutes after the last part; they now all start together. The PR
diagnostic campaign in `ci.yml` keeps its 6-part limit.

| Campaign (org runners)                              | Parts | Global gates | Full campaign |
| --------------------------------------------------- | ----- | ------------ | ------------- |
| Release run 39845676503 (20 parts, 2 gates at once) | 7m42s | 3m30s        | 13m24s        |
| Dispatch 39917134050 (all parts at once, 2 gates)   | 6m48s | 2m54s        | 11m48s        |
