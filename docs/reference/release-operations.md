---
id: release-operations
title: 'Release and Operations Guide'
kind: reference
version: '1.2.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
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
- Treat an unpublished source manifest as a visible release-held candidate,
  never as evidence that a package or image is available to consumers.

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

On pull requests, the repository-owned 90% patch-coverage gate is blocking and
uses the merged LCOV reports for changed production lines and branches.
External coverage reporting remains informational only when it cannot enforce
that contract. Exact package checks must prove all conditional/wildcard
exports, declarations, maps, side-effect metadata, peer/optional adapter
metadata, and clean ESM/CommonJS consumers. Browser candidates must also
produce the governed composition report without exceeding their committed
budgets.

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

The run has exactly one human gate, the `release-approval` environment on the
`approve` job. It starts at t=0 beside preparation and mutation
qualification. Approve it immediately after dispatch. The rest of the run then
proceeds unattended, and publication still happens only if every automated
gate passes. `npm-production` keeps its branch policy and npm trusted-publisher
binding but has no required reviewers, so there is no late approval prompt.

The workflow stages immutable tarballs in an uncredentialed job, emits package
and aggregate CycloneDX SBOMs, audits licenses and vulnerabilities, verifies
clean consumers, and then passes only those bytes into the protected
`npm-production` job. That job verifies GitHub attestations, publishes with npm
OIDC provenance and lifecycle scripts disabled, and reconciles registry
integrity.

Record the source SHA, workflow run, artifact manifest, package names/versions,
attestation results, and registry digests in the release evidence.

## 4. Post-publication reconciliation

A successful cascade waits until every published version resolves from the
registry, then creates one generated commit on
`automation/sync-published-versions` directly on top of the released
`github.sha`. That commit synchronizes workspace floors, updates every
just-published first-party package found anywhere in each infrastructure lock
(including transitive entries such as middleware reached through
`wallet-toolbox`), and patch-bumps every infrastructure component whose
manifest or lock changed. The same run then calls `infra-release.yaml` to build,
scan, attest, sign, and push the images from that exact commit (section 5). It
also opens the sync PR so `main` records the same bytes. Review that PR like
source code:

1. verify every first-party range corresponds to a published version;
2. inspect `pnpm-lock.yaml` and every changed infrastructure lock;
3. confirm lock refreshes name no ad hoc package and run with lifecycle scripts
   disabled;
4. rerun audits, build/typecheck, package consumers, infrastructure tests and
   images, and repository health; and
5. merge only after required checks and review threads are complete.

Do not merge an independent Dependabot PR that fights the release-sync graph.
Consolidate it into the reviewed baseline or close it as superseded.

The read-only dependency/release verification workflow runs after successful
release workflows and monthly. Confirm that its artifact records:

- every source version, npm `latest`, recorded published baseline, tarball
  integrity, and provenance result;
- every remaining source candidate that is still intentionally held from
  publication;
- a clean lifecycle-disabled install plus `npm audit signatures`;
- every deployment image pulled by immutable digest; and
- generated package/support/conformance/coverage-reporting facts with no drift.

Do not close a release wave by copying version numbers from source manifests.
Use this artifact and the release workflow evidence to distinguish what is
published from what remains held. If publication was explicitly not
authorized, close the implementation work with the held-candidate inventory
and leave publication as a separate operator action.

## 5. Infrastructure images and deployment

A cascade npm release publishes affected images automatically from its
infra-sync commit. A cascade with no npm candidates still releases infra
components already bumped on `main`. For infrastructure-only source changes, or
after a single-package npm release:

1. update and review its manifest and committed lock, bumping its version;
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

## 6. Independent assurance program

The release owner is also accountable for arranging an independent review of
the security-sensitive stack. The review must cover cryptography, consensus and
Script evaluation, wallet signing and storage, authentication and payment
replay boundaries, Overlay and other untrusted network parsers, and npm/image
supply-chain controls. It must inspect reviewed `main` source and the exact
released packages and images, not production secrets or customer data.

The BSV Association security owner will select an independent, conflict-free
provider with demonstrated cryptographic, application-security, and
supply-chain experience by **2026-08-31**. Selection evidence will record the
candidate comparison, scope, conflicts check, statement of work, and
confidential reporting channel. The review package will include the reviewed
source SHA, package and image digests, SBOMs and attestations, threat models,
conformance and coverage reports, fuzz/property evidence, and sanitized
deployment configuration.

Findings must use a private GitHub security advisory or
`security@bsvblockchain.org` and follow the acknowledgement, assessment,
remediation-update, severity, and coordinated-disclosure targets in
[SECURITY.md](https://github.com/bsv-blockchain/ts-stack/security/policy).
The ts-stack maintainers own triage and remediation; release owners own
affected-artifact inventory, mitigation, deprecation, forward fixes, and
deployment rollback. Public disclosure remains embargoed until coordinated
with the reporter and affected operators.

OpenSSF Best Practices badge registration is deferred while
[QA issue #400](https://github.com/bsv-blockchain/ts-stack/issues/400) remains
open, because its coverage, fuzzing, runtime, and manual-suite claims are not
yet complete enough for a truthful self-assessment. The BSV Association
security owner must register within five business days after issue #400 closes
and link the resulting project record from this guide. Existing Scorecard findings remain governed by
`governance/repository-health/exceptions.json`; badge deferral does not waive
or suppress them.

Independent review and badge participation improve evidence and accountability.
Neither is proof that defects cannot exist, and all findings enter the normal
private reporting, remediation, release, and incident processes.

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
agree. Record the exact evidence in the operator-authorized release tracker;
[completed release program #401](https://github.com/bsv-blockchain/ts-stack/issues/401)
is the retained reference closeout. Do not mark package availability or
deployed behavior complete from a local build alone.

See [npm Package Supply Chain](./npm-package-supply-chain.md),
[Container Supply Chain](./container-supply-chain.md), and
[Versioning Policy](../about/versioning.md) for the underlying contracts.

## Complete mutation qualification before publication

The publication candidate must complete the reusable `mutation-tests.yml`
campaign at its exact `github.sha`. In `release.yaml` the campaign starts at
t=0 in parallel with preparation and runs every target concurrently, so the
slowest single target bounds its wall time. The npm publisher waits for the
up-front approval, preparation, and full qualification. The OCI publisher
waits for discovery and full qualification, which a `release.yaml` call
satisfies with that same-run campaign;
the Marketplace publisher waits for credential-free source validation and full
qualification. Each guard requires both a successful campaign and its nonempty
`qualified-sha` equal to the candidate SHA before entering a job with publisher
credentials. All existing source, audit, environment, scanning, provenance,
artifact and publication checks remain in force.

Every canonical mutation target must have a successful fresh report and matching
source/run/attempt/configuration/lock-bound receipt. The verifier reconstructs
canonical source ranges and mutant inventory with pinned Stryker 9.6.1 and rechecks
all existing target gates. A partial manual target is diagnostic only. Earlier
weekly passes, previous attempts and reports from another source cannot satisfy
the gate; rerun the complete workflow when a full attempt needs replacement.

Preparation and execution verification use the same duration-scheduled complete
matrix. Every batch binds the digest of that full ordered matrix and its exact
ordered slice, alongside source, run, attempt and build archive identity. The
verifier reconstructs the scheduling order from the checked-out measurements;
it must not compare a scheduled digest with target-order rows or accept a
digest mismatch. Scheduling changes start order only, never the required union
of canonical targets, partitions, source ranges or mutation gates.

Declaration/import-only execution companions run with related nonempty parts.
Their complete original source ranges remain in the plan and the pinned-engine
inventory must match the original whole target exactly. A standalone empty
report remains invalid; neither a perfect percentage over zero sites nor a
passing initial test run can qualify a canonical target.

No mutation target is permanently removed by PR deferral. A failure at this final
gate blocks publication and requires a source fix and newly qualified candidate;
there is no label or manual input that converts failure into permission to publish.
For a standalone general OCI run, a discovered empty publication set avoids a
needless full campaign. `release.yaml` always runs its campaign because it also
qualifies the infrastructure images published by the same run. Marketplace
still verifies its existing-title condition within its credentialed
read/publish lane after qualification.

The npm and general OCI paths are consolidated for cascades: `release.yaml`
calls `infra-release.yaml` with its qualified `github.sha` and image source.
The called workflow accepts that call only from `release.yaml` and only for a
caller-qualified `github.sha`. The image source must be that SHA or its direct
infra-sync child limited to manifest, lock, and generated-facts paths. Product
source therefore cannot change between qualification and image publication.
Marketplace remains an independent `infra/v*` workflow with its own campaign.

The full mutation preparation first validates current inventory-review dates and
security advisories. An expired review or failed audit stops expensive campaign
execution. Renewed inventory dates record source/disposition review; they do not
qualify a runtime campaign. Target receipts also bind the fresh successful runner
record, report digest, property run count, deterministic seed and empty replay
path. An overridden partial replay cannot qualify publication.

## Retired one-time experimental #674 release waiver

The operator authorized one full release without successful #674 mutation
qualification: [release 40612905804](https://github.com/bsv-blockchain/ts-stack/actions/runs/40612905804),
SDK 4.0.1, Toolbox 2.15.1, 37 npm packages and 8 infrastructure images.
The npm source was f12e0dd669287b63964545035a39f0d339abc447, with package bytes
identical to the tested a6b6e352 candidates. GitHub skipped its image-sync
continuation through the intentionally skipped campaign. PR #1433 repaired only
release controls; [continuation 40617228519](https://github.com/bsv-blockchain/ts-stack/actions/runs/40617228519)
uses ada0681362455045ff3a0dd795fcf89e6f177d92 and the same immutable package
bytes, with no repeated npm publication. The image source is its generated
child 1aa0983115ba39579ac09885e1977c05b765e42e. Established compatibility and
normal approval,
artifact, advisory, SBOM, provenance and signature gates remained mandatory.

This was an operator waiver, not successful full mutation qualification. Failed
and canceled campaign evidence remains failed. The historical record is
`governance/release-exceptions/2026-10-27-674.json`. The temporary dispatch input
and admission implementation are removed. Every later release requires the
normal full mutation qualification; no future release can select this waiver.

The image inventory used two source children. Six new images came from
`1aa0983115ba39579ac09885e1977c05b765e42e` at caller `ada0681362455045ff3a0dd795fcf89e6f177d92`.
Message Box1.1.55 and WebRTpay Relay0.2.2 were already occupied by older images
containing SDK4.0.0, so the remaining recovery published Message Box1.1.56 and
Relay0.2.3 instead. [Image-only recovery 40623065656](https://github.com/bsv-blockchain/ts-stack/actions/runs/40623065656)
uses caller `d344bf07b8a9d25adc7203687b667a70e96955f5` and generated child
`f69c6f2b1f805e0d69962815515a641a35e230cb`. Relative to the original inputs, only
those two manifest/lock version fields changed; source and dependency bytes
remained identical. Normal approval, build, scan, signature, provenance and SBOM
gates remained required, with no additional npm build or publication. This
consumed the same one-time release waiver. The temporary image-only dispatch
adapter is removed together with the original admission.

## Reconcile verified published baselines

After a protected cascade publishes, independently verify every public version,
integrity, actual tarball digest and source-bound attestations. Reconcile the
generated sync PR against its original immutable image-source commit, then set
only the verified release entries in `governance/package-release-notes.json` to
the public `publishedVersion` with `releaseType: none`. Run `pnpm docs:packages`,
review the generated package facts and merge the validated reconciliation PR.
Do not advance a baseline for a held, failed or partially published candidate.
Later metadata commits do not change the pinned image source or its provenance.
