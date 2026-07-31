---
id: container-supply-chain
title: 'Container Supply Chain'
kind: reference
version: '1.1.1'
last_updated: '2026-07-30'
last_verified: '2026-07-30'
review_cadence_days: 30
status: stable
tags: [reference, infrastructure, containers, security, releases]
---

# Container Supply Chain

The infrastructure images are deployable artifacts, so their build inputs,
review gates, provenance, and rollback identity are part of the public release
contract. The controls here do not create another service. They make the
existing seven images auditable and ensure the artifact reviewed by CI is the
artifact that reaches a registry.

## Sources of truth

`governance/container-images.json` is the complete release inventory. It owns:

- the seven Docker build contexts and their `linux/amd64` platform;
- the exact digest-pinned Node base and its human-readable expected version;
- OCI title, description, uniform `LicenseRef-Open-BSV-License-6`, and
  documentation metadata; and
- the GHCR or GHCR-plus-Marketplace release route for each component.

`scripts/container-supply-chain.test.mjs`, run by `pnpm health:check`, rejects
unregistered Dockerfiles, mutable bases, `apk upgrade`, uncommitted lockfile
resolution, incomplete OCI metadata, unpinned deployment examples, and loss of
the scan, attestation, signature, Docker Dependabot, or Scorecard controls.

`governance/Dockerfile.container-bases` is dependency-discovery metadata, not a
build context. Its canonical Docker Hub tag lets Dependabot discover Node
releases while its digest lets Scorecard verify pinning. The inventory's
`discoveryReference` records that single automation source; equivalent runtime
registry mirrors remain in `references` and must be resolved and compared
during review. This avoids making routine dependency discovery depend on public
ECR's unauthenticated rate limits without weakening multi-registry verification.
Repository health requires the discovery tag and digest, the registry's
expected version and digest, and every digest-only release `FROM` instruction
to reconcile in one change. Runtime Dockerfiles deliberately omit the tag
because Docker uses the digest as the actual identity. They are excluded from
the deployment-image Dependabot scan so its Docker updater cannot reinterpret
bare digest-only Node references as `latest`; the versioned governance manifest
is the single Node discovery source, while deployment images and database
versions remain monitored.
Automatic Sonar analysis excludes only the non-build metadata file because its
rule rejects tag-and-digest syntax; the executable zero-install repository check
remains authoritative for it.

Package locks under `infra/**/package-lock.json` are committed release inputs.
Release workflows never rewrite them. A stale or inconsistent lock therefore
fails `npm ci` before publication instead of silently producing a different
dependency graph.

## Pull request gates

The infrastructure CI matrix builds and scans only images whose build contexts
changed. Shared image-governance or runtime-contract changes expand to every
registered consumer, while application packages and CI orchestration alone do
not build unrelated images. GitHub's Linux/amd64 runners scan every selected
image with Trivy. Any high or critical OS or library vulnerability, including
one without an upstream fix, blocks the merge. A finding must be fixed or
entered in the repository's time-bounded exception registry with an owner,
evidence, review date, and objective removal condition.

All base-image and deployment references use a readable version tag plus a
content digest. Dependabot proposes reviewed Docker refreshes alongside the
monthly stack-maintenance change. OpenSSF Scorecard runs on `main`, weekly, and
when repository rules change; its SARIF is retained for 90 days and uploaded to
GitHub code scanning.

## GHCR release

`.github/workflows/infra-release.yaml` accepts an `infra/v*` tag reachable from
`main`, or a manual dispatch from `main`. For every version not already present
in GHCR it:

1. resolves the component from the checked-in registry;
2. builds the image once with commit-derived metadata;
3. rejects high and critical vulnerabilities;
4. creates and retains an SPDX JSON SBOM;
5. pushes that exact reviewed image under both version and source-commit tags;
6. publishes GitHub-signed SLSA provenance and SBOM attestations to GitHub and
   GHCR;
7. keylessly signs the digest and attaches the reviewed SPDX SBOM with Cosign;
8. verifies the digest, signature, provenance, and both SBOM attestations before
   declaring the release successful.

Concurrent releases are serialized and never cancelled midway. Existing
version tags are treated as immutable and skipped rather than overwritten.

For a released digest, verify the evidence from an authenticated environment:

```sh
image_ref='ghcr.io/bsv-blockchain/overlay-server@sha256:<digest>'

docker buildx imagetools inspect "$image_ref"
cosign verify \
  --certificate-identity-regexp \
  '^https://github\.com/bsv-blockchain/ts-stack/\.github/workflows/infra-release\.yaml@refs/(tags/infra/v.+|heads/main)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  "$image_ref"
gh attestation verify "oci://$image_ref" \
  --repo bsv-blockchain/ts-stack \
  --signer-workflow bsv-blockchain/ts-stack/.github/workflows/infra-release.yaml
gh attestation verify "oci://$image_ref" \
  --repo bsv-blockchain/ts-stack \
  --signer-workflow bsv-blockchain/ts-stack/.github/workflows/infra-release.yaml \
  --predicate-type 'https://spdx.dev/Document/v2.3'
```

## AWS Marketplace

WAB's Marketplace workflow applies the same trusted-source, single-build,
Trivy, SPDX, digest, and attestation gates before registering a new immutable
Marketplace version. GitHub stores keyless SLSA and SPDX attestations against
the exact Marketplace ECR digest. It does not assume that the
Marketplace-controlled repository permits auxiliary Cosign OCI manifests.
The workflow verifies both attestations while still authenticated to ECR, then
submits the catalog change and waits for a terminal success state.

## Refresh and rollback

For a base-image refresh:

1. start from the Dependabot change in
   `governance/Dockerfile.container-bases`;
2. verify that version's multi-platform digest directly against every entry in
   `governance/container-images.json#baseImages[].references`;
3. update `governance/container-images.json` and every matching digest-only
   `FROM` line in one PR;
4. let the complete image matrix build and scan;
5. merge only when repository health and security analysis pass.

Roll back a deployment by selecting a previously verified image digest, not by
moving or reusing a release tag. Retain the failing digest and workflow URL in
the incident or tracking issue so the transition remains auditable. Never
delete or overwrite a published version merely to make a rollback appear
current.

The normal path is GitHub CI on Linux/amd64. Maintainers on macOS should not
build or publish cluster images locally. An emergency manual image requires a
traceable tag, source commit, immediate upstream reconciliation, and recorded
operational evidence.
