---
id: sonar-pr569-budget
title: 'Approved PR569 Sonar budget'
kind: meta
version: '1.0.0'
last_updated: '2026-10-18'
last_verified: '2026-10-18'
status: stable
tags: [governance, sonar, review]
---

# Approved PR569 Sonar budget

Owner: ty-everett. Approved by the maintainer on 2026-10-18 in the private
operator task. Approval applies to the concrete scoped proposal prepared for
PR569; it does not authorize merge, publication or deployment. PR569 remains
open/draft under its existing merge hold. Implementation and full qualification
of #544 remain required.

## Scope and limits

The machine-readable registry is
[`governance/sonar-pr569-budget.json`](https://github.com/bsv-blockchain/ts-stack/blob/23667a791204c96c9d0447ac8bd674da20f7ec9c/governance/sonar-pr569-budget.json),
also recorded in the repository-health exceptions registry. The only eligible
context is repository `bsv-blockchain/ts-stack`, Sonar project
`bsv-blockchain_ts-stack`, PR569, same-repository head branch
`codex/wallet-sync-interop-reliability`, base `main`, before
`2026-10-24T23:59:59Z`. At expiry the original strict policy applies; a new
explicit maintainer approval and reviewed implementation are needed to extend
it. This is an authorization window, separate from advisory review reminders.

The scoped gate requires maintainability A, reliability A, security A,
duplication ≤6%, zero unresolved bugs/vulnerabilities, zero unresolved
reliability/security impacts, and 100% reviewed security hotspots. Only
CODE_SMELL issues whose complete MQR impacts are maintainability-only may
remain. Unknown/missing classifications, mixed impacts, accepted bugs,
false-positive security findings and unknown conditions fail closed. Fixed
records remain in the inventory. No suppression, exclusion, baseline, profile,
threshold at SonarCloud, or finding-state change accompanies this policy.

An absolute smell count can reward risky rewrites of required ordered async
operations and explicit implementations across supported runtimes. A measured
maintainability/duplication budget retains the visibility and review of that
debt while preserving correctness and security. It does not justify deferring
required features, platform/mutation validation or production-readiness proof.

## Enforcement and evidence

The existing `sonar-zero-findings` job identity and all merge/mutation
dependencies remain. Its CLI calls `scripts/sonar-policy-gate.mjs`, which selects
the original strict implementation except in the exact unexpired Actions
context. There is no budget-enabling CLI argument or caller-snapshot input.

For an eligible Actions run, the controller checks the Actions event plus a
fresh response from the fixed GitHub PR API. Both head and base repositories,
PR number, branch names, state and exact head SHA must agree. It then waits for
the exact Sonar head, collects every issue state and every hotspot through
complete pagination, and rechecks the analysis identity/date and live GitHub
head/base. Missing, duplicated, truncated, changing or malformed inventories
fail. Missing required conditions, ignored conditions and unknown failed
conditions fail. The analysis must describe the same PR/head branch/base and
revision throughout collection. A moving head/base or an API failure cannot
produce a scoped pass. The authorization is checked again after collection.

Raw GitHub/analysis responses, every issue/hotspot page, the full snapshot,
both policy verdicts and collection failures are retained under `.sonar-policy/`
and uploaded by an always-run artifact step. Evidence filenames come only from
controller labels, never remote keys or messages. JSON files use exclusive
creation with private file/directory permissions so an earlier collection or a
preexisting file symlink cannot be overwritten. Raw records remain untrusted
data; no artifact is imported or executed as source. The Actions summary reports both
verdicts and counts; a scoped pass is never labeled a zero-findings pass. Tokens
and request authorization headers are not written. The only additional token
permission is read access to pull requests for this job. The workflow uses the
existing pinned artifact action and retains all other gates and dependencies.

`node --test scripts/sonar-pr-gate.test.mjs scripts/sonar-policy-gate.test.mjs`
checks original strict behavior plus scope, expiry, live-context disagreement,
analysis drift, complete pagination and inventory, all correctness/security
finding states, mixed impacts, hotspot reviews, condition integrity and
boundary values. The original strict tests remain unchanged.

The collector uses SonarCloud's published [Web API](https://sonarcloud.io/web_api)
issue states (`OPEN,CONFIRMED,ACCEPTED,FALSE_POSITIVE,FIXED`) and MQR impacts.
No offline review command can grant a CI pass.

## Existing measurement and remaining review

The proposal's 2026-10-17 published-head snapshot at
`39413caca8083ba3ad10c7e8f2da9b55fd94b3a8` contained 3 bugs,
2 vulnerabilities and 3,118 code smells. Among those smells, 268 carried
reliability impacts. Maintainability was A, duplication 5.3%, and
reliability/security C. Both the original and scoped policies fail that
historical sample. It does not analyze or qualify unpublished implementation.

After all features are implemented and integrated, run complete exact-head
qualification, resolve all blocking findings, inspect the full retained debt
inventory and revisit the budget with the maintainer. No historical result or
unit test here establishes feature completion, green hosted CI or production
readiness. Remove the policy after qualification; no automatic renewal exists.

The separately reviewed PR569 analysis operations in
[`governance/pr569-reviewed-analysis-exceptions.json`](https://github.com/bsv-blockchain/ts-stack/blob/5c2baf3a8d9676beb1a41b818c296c048dc6f42e/governance/pr569-reviewed-analysis-exceptions.json)
are the sole additional exception: CodeQL353 intentional private JSON evidence
storage and two exact Sonar S2612 required public artifact permissions. Owner
BraydenLangley reviewed the operator-delegated decision on October 19. Exact
alert identities and SHA-256 source checks apply only to PR569 before October 24
at 23:59:59 UTC. The Sonar inventory and original failed verdict remain visible;
reviewed permission keys are reported separately. Their original security C
metric is covered only when both exact findings are present; all other
security ratings and findings retain strict enforcement. Every other finding, metric,
platform and merge gate remains required. Changed source requires fresh review.
