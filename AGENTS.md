# ts-stack agent instructions

These instructions apply to every file in this repository. They are the only
repository contribution instructions for AI agents. A package-level
`AGENTS.md` is a pointer to this file, not a place to define different rules.

## Read before changing anything

1. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md), the relevant package or service
   README, and any applicable material under `docs/`, `specs/`, and
   `governance/`.
2. Read [`.github/SECURITY.md`](./.github/SECURITY.md) before touching a trust
   boundary, dependency, workflow, release, credential, public service, or
   persistence behavior.
3. Establish the current `main` state, inspect existing changes, and identify
   the governed project profile and criticality in
   `governance/repository-health/projects.json`. Infrastructure service
   contracts live in `governance/service-operations.json`.
4. Keep work narrowly scoped. Do not overwrite unrelated changes or
   regenerate unrelated artifacts.

Do not create package-local contribution rules, agent instructions, pull
request templates, issue templates, Dependabot files, or workflows. Propose
shared policy at the repository root. Package-specific technical information
belongs in its README, `docs/`, `specs/`, or an operator guide.

## Preserve contracts first

- Specifications, conformance vectors, public declarations, documented
  behavior, and established cross-implementation behavior are contracts.
- Prefer additive and backward-compatible changes. Do not rename or remove
  exports, narrow accepted input, change defaults, alter wire encodings,
  serialization, persisted schemas, error identities, runtime targets, or
  browser/mobile behavior without an explicitly approved migration.
- A generic cleanup, analyzer suggestion, dependency upgrade, or refactor is
  never sufficient reason for a breaking change.
- When behavior is portable across BSV implementations, update or add shared
  conformance evidence and consider compatibility with implementations outside
  this repository.
- Tier 0 projects (`@bsv/sdk`, `@bsv/verifast`, and
  `@bsv/wallet-toolbox`) require the highest review bar. Treat cryptography,
  Script/consensus logic, transaction encoding, WASM/worker boundaries, wallet
  storage, signing, and remotely exposed trust boundaries as security- and
  compatibility-critical.

For public services, preserve credential-free public cross-domain access by
default where it is already part of the service contract. Overlay, Wallet
Storage, WAB, Message Box, relay, browser, mobile, and unknown-domain clients
must not be silently blocked by CORS, CSP, hosting URLs, or origin checks.
Allowlist modes are opt-in deployment policy; authentication, authorization,
signatures, validation, rate limits, and request bounds provide security.

## Implementation discipline

- Understand the root cause and deployed impact before editing.
- Prefer the smallest clear solution that removes the cause without hiding a
  finding or weakening a check.
- Keep authored code warning-free, strictly typed, formatted, and
  understandable. Do not use generated output, suppression, exclusions,
  accepted findings, false-positive status, skipped tests, or baselines to
  conceal new debt.
- Add tests that fail on the old behavior when practical. Cover negative,
  boundary, interoperability, and compatibility cases appropriate to the
  change.
- Review the complete diff as a maintainer would: correctness, security,
  compatibility, public API, package artifacts, performance, documentation,
  migration, release, and operational impact.
- Update documentation in the same change. Documentation, examples, manifests,
  generated facts, release notes, and code must never intentionally drift.

## Dependencies and generated files

- Treat Dependabot and other automation as proposals, not approvals. Review
  upstream release notes, necessity, runtime and peer compatibility,
  transitive changes, lockfile deduplication, advisories, CodeQL impact,
  package consumers, and bundle/performance effects.
- First-party `@bsv/*` versions are coordinated by the repository release
  process, not generic dependency automation.
- Never hand-edit owned generated files. Change their source or generator and
  run the documented deterministic generation check.
- Do not add an override, quality exception, advisory dismissal, or dependency
  hold unless no safe remediation exists and the governed registry records an
  owner, evidence, review date, removal condition, and compatibility rationale.

## Validation

Use Node and pnpm versions from the root `package.json`. Run the strictest
relevant local checks before spending hosted CI resources. At minimum, every
change must pass:

```sh
pnpm health:check
pnpm lint
pnpm format:check
pnpm typecheck
```

Run build and tests for every affected package and dependent behavior. Add the
applicable conformance, coverage, packed-consumer, browser, mobile, property,
mutation, documentation, security-audit, infrastructure, container, or
performance checks described in [`CONTRIBUTING.md`](./CONTRIBUTING.md). A local
shortcut may speed iteration but cannot replace the remote merge gate.

## Pull requests and completion

- Fill in the root pull request template with commands and concrete evidence;
  do not check a box that has not been proved.
- Open unfinished work as a draft. After each push, monitor the exact head
  until every applicable check reaches a terminal successful state. An
  expected scope-based skip is acceptable only when the repository merge gate
  validates it; a missing, cancelled, stale, or unexpectedly skipped check is
  not success.
- A PR is not ready for handoff, review, merge, or a claim of completion while
  CI is pending or failing, review threads are open, or Sonar/CodeQL has a new
  finding. Continue working through failures; do not leave them for another
  contributor without an explicit handoff request.
- “Quality gate passed” means the complete repository gate passed for the
  exact head. SonarCloud’s aggregate badge alone is not evidence. New Sonar
  issues—including accepted or false-positive classifications—new unreviewed
  hotspots, and new CodeQL alerts must be resolved before review.
- One qualified maintainer approval is sufficient. Maintainers and
  administrators may facilitate a merge after required checks and review
  threads are complete; no independent last-pusher rule is assumed.
- Re-read the final diff and verify the head SHA before review or merge. After
  merge, verify `main` when the change affects shared controls, releases, or
  deployed behavior.

## Versions, notes, and releases

Follow `docs/about/versioning.md` and the protected release workflows.
Published-byte or manifest changes require the correct affected-package SemVer
decision, an updated `governance/package-release-notes.json` entry, current
package documentation, and migration guidance—even when the migration is
“none.” Update a package-local changelog when that package already maintains
one.

Never publish npm packages or container images, create release tags, or deploy
from a workstation unless an operator explicitly authorizes that separate
action. Merging source is not publication, and publication is not deployment.
