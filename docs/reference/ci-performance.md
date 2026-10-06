---
id: ci-performance
title: 'CI Performance Governance'
kind: reference
version: '1.8.2'
last_updated: '2026-10-06'
last_verified: '2026-10-06'
review_cadence_days: 30
status: stable
tags: [reference, ci, performance, github-actions]
---

# CI Performance Governance

The existing `CI` manual dispatch has an optional
`application-performance-diagnostics` input, disabled by default. It measures the
unchanged native alias-disclosure property on an isolated hosted Linux runner
in the existing package-artifact job, before complete artifact verification.
Its additional work does not consume either ordinary application coverage
job's original time budget. A maintainer can also
select it on an ordinary PR run with the explicit
`ci:application-performance-diagnostics` label before the next source push. The
label alone does not trigger the workflow. Remove it after the bounded
measurement. This preserves the ordinary PR mutation policy; complete manual
mutation qualification is still required once the functional baseline passes. Use
`gh workflow run ci.yml --ref <branch> -f application-performance-diagnostics=true`
for an explicitly requested measurement. Ordinary unlabelled pull-request runs, complete
test discovery, both coverage shards, merge gates and mutation qualification
remain unchanged.

The repository-only diagnostic retains the original minimum 300 runs, seed
3242026, replay-free profile, 150-second interruption-as-failure budget and
180-second case deadline. It first checks the built-in SQLite driver, binds the
complete tracked source, built SDK/wallet/application bytes and Node binary, and
runs one serial property with coverage and CPU profiling. The diagnostic uses a
fixed 10,000-microsecond sampling interval, recorded in its identity, to reduce
profile size within the unchanged 64 MiB file bound. Oversized profiles are
refused before their contents are read. This is a sampling choice for diagnosis;
it changes no application property or qualification control. Every child has a
finite deadline within an immutable 900-second calendar and Boolean fault, case-timeout and output triage. Cancellation
and every exit drain the complete process group through bounded TERM/KILL.
Timing extraction requires unchanged inputs, all guards clear and an absent
group; otherwise only Boolean metadata is retained. A timing-file or summary
refusal records its bounded phase and reason. Only a safe, fully drained
measurement with unchanged source may continue into complete artifact validation
when timing is unavailable; ordinary coverage remains independently required. A fault, case/output bound, child/calendar deadline,
cancellation or source guard failure stops that diagnostic job. Raw logs, CPU profiles and
application values never enter the uploaded report. Each file is opened once; its
descriptor supplies both the size check and bounded read, without following
symlinks.

The uploaded `application-performance-diagnostic-<run>-<attempt>` artifact
contains checked-out source and PR-head/runtime identity, exit and drain evidence, and bounded self and
inclusive function timing. Per-call-stack timings are retained alongside complete
function aggregates keyed by name, source URL and measured line. Recursive
occurrences receive each inclusive sample only once. Measured positions can refer
to instrumented/transformed code rather than original source lines. Profiling
overhead is included. A valid measurement
can describe a property-budget interruption; it never qualifies the property,
coverage, mutation campaign or checkpoint. The complete ordinary coverage run
must still pass independently. No performance improvement is claimed
until comparable measurements and full unchanged qualification support it.

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
A lockfile-only change selects the importers whose lock snapshots actually
changed instead of treating the root lockfile as a global invalidation. Root
compiler, workspace and shared CI execution controls select the complete graph deliberately.

Mutation selection follows each target's exact implementation, property,
regression, configuration, and policy inputs. Package-wide mutation suites
expand only where their configuration really covers the whole package. Image
jobs follow changed build contexts. Changes to the shared CI workflow validate
all infrastructure build lanes; unrelated documentation workflow changes do not.
Shared image/runtime contract inputs fan out to the registered consumers.

Recovery-plan mutation execution retains its complete module and seven original
construction ranges in three parts, separated at the existing failure-handler
function boundary. Every part keeps the original complete test selection and
qualification controls. The pinned engine independently proves that all 131
canonical mutants occur exactly once across the parts; even the call-only range
without an executable mutant remains in the source union. Complete qualification
requires their combined original global gate. Neither smaller scheduling parts
nor a successful initial test run substitute for the finished campaign.

Revenue-purchase verification separates history extension from transaction binding
at complete private-method boundaries. Original evidence association, validation
order, mandatory outputs, full Script/history verification and all tests remain
required. The new complete source inventory is independently replayed; preceding
source scores cannot qualify the refactor. Original execution deadlines and global
score requirements remain unchanged.

The main CI workflow builds the selected graph once and shares immutable
outputs with isolated test lanes, skips empty lanes, installs through the
setup-node pnpm cache, caches the immutable MongoDB test binary, and rebuilds
native/build tools only in jobs that execute them. Browser lanes retain exact
package-composition reports without rebuilding the workspace. The cheap
repository-health, scope, and dependency-review gates complete before
dependency installation. Exact-head Sonar analysis runs concurrently with the
shared build and remains mandatory in the final merge gate. Expensive PR mutation waits for both a
successful shared build and successful exact-head Sonar analysis. Main and
manual full campaigns allow only the intentional skip of the PR-only analyzer
gate. A failed, cancelled, missing or unexpectedly skipped analyzer stops the
normal mutation launch; suppressed selected mutation is not qualified evidence.
Package artifact checks and documentation consumers run beside the tests after the shared build, with their own required
result. Matrix siblings finish after a failure so acceptance
evidence includes every selected shard. Within a regression or coverage shard,
packages execute serially because individual test runners already use worker
pools; this prevents nested pools starving real-cryptography integration tests.
These controls reduce repeated CPU, network, and setup work without weakening
the tests selected by the dependency or registered trust-boundary graph.

The application output-knowledge coverage suite uses two isolated Jest shards
within the existing coverage matrix. Each retains the original complete discovery,
serial native worker, property cases and per-test deadlines. Its ordinary local
`test:coverage` command remains a single complete run with the original global
thresholds. CI requires both shards, then independently discovers the complete
suite again and checks a disjoint, exact execution union. Failed, missing, pending,
todo or skipped tests and mismatched source, run, attempt or configuration fail
qualification. The aggregate merges the complete Istanbul maps and applies all four
original global thresholds before contributing LCOV to the required patch gate.
Individual shard reports cannot qualify package coverage. The coverage jobs retain
their 35-minute deadlines; the aggregate and final merge gates remain required.
The three reporting libraries are direct, exact-version development dependencies
already present in the frozen graph; no runtime package dependency changes. Dependency-free inventory/result controls remain in the zero-install repository-health job. The actual reporting-library integration runs unconditionally after the frozen install and before build; its execution cannot be skipped to satisfy early health.

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
registration. Its source specifications are grouped by file into core validation
and Peer, AuthFetch client, and SimplifiedFetchTransport. Every range of a file
stays in one part; a new canonical helper defaults to core, and unsupported
wildcard/unknown partition inputs fail. Each part retains the complete original
Jest test selection, four workers and governed property inputs. The original
main-derived inventory replayed to 95 + 137 + 91 = 323 mutants. This branch's
expanded SDK sources replay to 416 + 250 + 91 = 757, including the complete finite
HTTP helper. Each union exactly matches its own unpartitioned canonical inventory;
the earlier count does not qualify the newer sources.

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

### Root-record execution partitions

`root-eviction-records` remains one canonical registration and one combined
90%/zero-uncovered/zero-invalid gate. Its complete source files are assigned to
request handling and serving records. Future canonical helpers join the request
part; no new source can disappear from the union. Both parts retain every original
root test, property input, fixture, runner setting and four-worker limit. The
pinned instrumenter reproduces exactly 218 request plus 257 serving mutants,
matching all 475 canonical tuples and their complete configuration. This is
static inventory evidence, not executed qualification or measured savings.

The previous unpartitioned run passed all 288 dry-run tests, then exceeded its
90-minute bound after six worker out-of-memory restarts. It was stopped without a
final report. That attempt remains incomplete, with no inferred passing score.
Fresh complete part reports must satisfy the canonical aggregate, including its
independent raw-part reconstruction. PR artifact downloads explicitly include
both parts; missing parts cannot pass the final gate. The existing 90-minute job
bound and every mutant/test deadline remain unchanged. Dry-run duplication,
worker memory and the slower part's wall time must be measured before claiming
an improvement.

The separate `root-eviction-codec` target receives the same bounded 90-minute job
allowance after its full 182-site run took 50m05s. That run achieved 97.80% with
zero uncovered/invalid outcomes and unchanged dependency bytes. This is an
execution allowance, not a reduced test set, score gate or worker constraint.
All earlier target allowances and the 45-minute default are retained.

### Recovery-store execution partitions

`wallet-recovery-store` remains one canonical target. Its original store-method
interval is scheduled at complete method and helper boundaries; installation
and operation-transition source intervals retain their separate original
registrations. All nine parts run the complete original tests and property
selection with unchanged inputs, operators, four workers and deadlines. Future
canonical companion sources remain in the fallback part. Ordinary CI downloads
every selected partitioned target's evidence before the mandatory canonical
aggregate, including recovery-plan, recovery-store, private-publication
admission and private-purchase HTTP parts. An installed
workflow control checks this wiring against the entire current target registry.

On source `9aff4d95b666103f2d3f1a209102b5f5b09fc02e`, full campaign
`37223480110`, attempt one, passed all 237 initial store tests in 123 seconds,
then reached the existing 90-minute job limit without a final report. That job
is unqualified. Independent pinned-engine replay observes all 229 original
mutants exactly once across nine nonempty parts, with inventories
44/9/14/16/20/10/93/13/10. The complete registry remains 141 targets, now
scheduled as 388 execution rows in batches of 256 and 132. Source and test
unions, global 90% score and zero-uncovered/invalid/unexecuted requirements
remain unchanged. This inventory proof establishes completeness; a fresh full
campaign on the published source must establish execution and final qualification.
