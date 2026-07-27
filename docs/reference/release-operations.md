---
id: release-operations
title: 'Release and Operations Guide'
kind: reference
version: '1.0.0'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
status: stable
tags: [reference, releases, operations, rollback, npm, containers]
---

# Release and Operations Guide

This guide connects source versions, npm publication, post-release dependency
reconciliation, infrastructure images, deployments, and rollback. It does not
authorize a release: publication or deployment starts only when an operator
explicitly requests it.

## Release invariants

- Release only a reviewed commit reachable from `main`.
- Never build or publish npm packages from a workstation.
- Never build Linux/amd64 production images on an unverified local macOS
  toolchain; use the repository workflow.
- Treat package versions and image tags as immutable.
- Promote the exact packed tarball or image digest that passed its security and
  provenance gates.
- Do not bypass a failing audit, package consumer, dependency review, CodeQL,
  Sonar finding, image scan, attestation, or registry-integrity check.
- Keep public services reachable by default when that is their product
  contract. CORS and CSP are configurable deployment controls, not
  authentication or authorization.

## 1. Decide the release scope

Use the [Generated Stack Facts](./stack-facts.md) page for current source
versions and the package graph.

1. Classify each public change as patch, minor, or major.
2. Include every package whose packed bytes or manifest changed.
3. Inspect first-party dependents for declaration, bundle, range, wire, and
   runtime effects.
4. For infrastructure consumers, identify which image manifests and locks will
   need reconciliation after npm publication.
5. For breaking or persisted-data changes, write migration and rollback steps
   before changing versions.

A broad code change does not justify bumping all packages automatically, and a
small diff does not justify omitting an affected dependent.

## 2. Source preflight

Before creating a release tag, require green exact-main evidence for:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm rebuild esbuild
pnpm rebuild better-sqlite3
pnpm audit:security
pnpm check-versions
pnpm build
pnpm docs:examples
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm conformance --validate-only
pnpm health:check
pnpm docs:facts:check
```

Also require the affected package coverage, property, mutation, browser,
mobile, CLI, WASM, clean-consumer, and `pack:check` lanes selected by CI. The
full release workflow repeats artifact-critical checks; local success is not a
substitute.

Confirm before proceeding:

- the target versions are absent from npm;
- no draft or unrelated change was pulled into the release;
- package READMEs, examples, API docs, migration notes, and support statements
  match the candidate;
- Dependabot changes were reviewed for actual runtime and deployment effects;
- all temporary overrides still have valid evidence and removal dates; and
- open security findings are either fixed or explicitly governed with an
  owner, review deadline, and objective removal condition.

## 3. npm publication

Use one supported trigger:

- `packages/<path>/vX.Y.Z` for one package;
- `release/vYYYY-MM-DD` for a cascade;
- legacy `vX.Y.Z` for a cascade; or
- protected manual dispatch from `main`.

The workflow stages immutable tarballs in an uncredentialed job, emits package
and aggregate CycloneDX SBOMs, audits licenses and vulnerabilities, verifies
clean consumers, and then passes only those bytes into the protected
`npm-production` job. That job verifies GitHub attestations, publishes with npm
OIDC provenance and lifecycle scripts disabled, and reconciles registry
integrity.

Record the source SHA, workflow run, artifact manifest, package names/versions,
attestation results, and registry digests in the release evidence.

## 4. Post-publication reconciliation

A successful cascade may open `automation/sync-published-versions`. Review that
PR like source code:

1. verify every first-party range corresponds to a published version;
2. inspect `pnpm-lock.yaml` and every changed infrastructure lock;
3. confirm lock refreshes name no ad hoc package and run with lifecycle scripts
   disabled;
4. rerun audits, build/typecheck, package consumers, infrastructure tests and
   images, and repository health; and
5. merge only after required checks and review threads are complete.

Do not merge an independent Dependabot PR that fights the release-sync graph.
Consolidate it into the reviewed baseline or close it as superseded.

## 5. Infrastructure images and deployment

When published first-party versions affect a service:

1. update and review its manifest and committed lock;
2. let the Linux/amd64 CI matrix build and scan the image;
3. release with an `infra/v*` tag or the protected manual workflow;
4. verify the immutable digest, SPDX SBOM, SLSA provenance, and signature;
5. update deployment manifests to the exact verified digest;
6. deploy through the system's owned GitOps/CI path; and
7. validate health, readiness, authentication, storage/database connectivity,
   representative requests, logs, and rollback readiness in the real
   environment.

For Overlay, Wallet Storage, WAB, Message Box, Wallet Relay, and similar public
services, validate both:

- the public-by-default path from an origin not known at build time; and
- the opt-in allowlist path for operators that require a restricted
  deployment.

An allowlist must be explicit configuration. Setting a hosting URL, fallback QR
origin, or CSP document must not silently turn a public service into a
same-origin-only service. Authentication, authorization, signatures, topic
validation, rate limits, and request bounds remain enforced in both modes.

## Failure and rollback

### Before publication

Fix the source or workflow and rerun from a reviewed commit. Do not weaken a
gate or retag different bytes under the same version.

### Partial npm publication

Rerun within the retained candidate window so already-published versions are
accepted only when their registry digests exactly match the staged tarballs.
If the candidate expired or any digest differs, stop, inventory the published
subset, and plan a deliberate recovery release.

### Defective npm release

Deprecate the affected immutable version and publish a corrected patch or
explicit forward-fix. Advise consumers which version to pin during recovery.
Do not delete evidence or assume an npm unpublish is an operational rollback.

### Defective image or deployment

Roll back the deployment to a previously verified image digest. Preserve the
failing digest, source SHA, workflow URL, deployment transition, validation
results, and incident link. Reconcile any emergency live change back to
upstream source immediately.

### Security incident

Treat unexpected lifecycle execution, provenance/attestation failure, registry
digest mismatch, secret exposure, or active exploitation as a security
incident. Stop promotion, preserve evidence, rotate affected credentials, use a
private GitHub advisory, and coordinate disclosure under
[SECURITY.md](https://github.com/bsv-blockchain/ts-stack/security/policy).

## Completion record

A release is complete only when source, published artifacts, post-release
dependency state, deployed image digests where applicable, and documentation
agree. Update [tracker #324](https://github.com/bsv-blockchain/ts-stack/issues/324)
with the exact evidence; do not mark package availability or deployed behavior
complete from a local build alone.

See [npm Package Supply Chain](./npm-package-supply-chain.md),
[Container Supply Chain](./container-supply-chain.md), and
[Versioning Policy](../about/versioning.md) for the underlying contracts.
