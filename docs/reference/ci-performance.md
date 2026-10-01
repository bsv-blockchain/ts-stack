---
id: ci-performance
title: 'CI Performance Governance'
kind: reference
version: '1.3.5'
last_updated: '2026-10-01'
last_verified: '2026-10-01'
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
A lockfile-only change selects the importers whose lock snapshots actually
changed instead of treating the root lockfile as a global invalidation. Root
compiler, workspace and shared CI execution controls select the complete graph deliberately.

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

## Required PR scope and complete final qualification

`scripts/ci-mutation-scope.mjs` divides the canonical target registry into
required premerge targets, demonstrably unaffected noncritical targets deferred
to final qualification, and critical targets outside this PR's existing scope.
Deferred means **not passed**. The final merge gate verifies a complete disjoint
partition and permits only the existing `high` class to defer. Existing critical
selection remains required, together with affected dependency closure; ordinary
documentation changes do not create an all-critical campaign.

The selector uses both base and checked-out head package graphs, including
runtime, dev, optional and peer dependencies, cross-package static imports,
package helpers, fixtures and manifests. Removed dependency edges remain in the
union. Computed module inputs, unresolved aliases, unknown ownership, unproved
lock resolution and shared execution controls retain required qualification.
Results report newly deferred targets separately from targets the prior selector
already omitted. Canonical registry order remains stable to avoid moving long
jobs behind short work in the six-runner queue.

The reviewed air-gap loader is a specific bounded input exception, recorded in
the selector by the complete helper-file SHA-256 and the exact shared corpus
`conformance/vectors/transport/air-gap-optical.json`. The helper's parent walk
selects that fixed relative corpus in ordinary and Stryker sandbox locations.
Changed loader bytes, a missing corpus or another unknown runtime input remove
the proof and retain the target. Corpus changes remain required. This exception
is not permission to treat arbitrary filesystem reads as independent.

The standalone scheduler is not an execution input to PR mutation. A scheduler-
only change retains existing critical obligations while allowing a proved
unaffected high target to defer. Other shared controls remain conservative.
On current main's 33 targets, this demonstrates air-gap deferral for that narrow
case; it does not promise a reduction for arbitrary code, lock or runner edits.
Archived air-gap jobs consumed 16.4–18.17 runner-minutes at different heads.
These are potential avoided execution minutes, neither billed cost nor a
prediction of elapsed savings. Auth campaigns and other required jobs can still
dominate the tail.

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
Jest test selection, four workers and governed property inputs. The current pinned
inventory replays to 95 + 137 + 91 = 323 mutants, exactly matching the unpartitioned
canonical inventory.

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
