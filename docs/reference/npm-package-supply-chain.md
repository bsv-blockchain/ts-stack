---
id: npm-package-supply-chain
title: 'npm Package Supply Chain'
kind: reference
version: '1.0.0'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
status: stable
tags: [reference, packages, npm, security, releases]
---

# npm Package Supply Chain

All 30 public packages are released from `.github/workflows/release.yaml`. The
workflow is the only supported publication path. It uses the protected
`npm-production` environment and npm trusted publishing (OIDC); release
automation must not use a long-lived npm write token.

## Release boundary

A release first builds and validates the workspace in an uncredentialed
`prepare` job. That job has read-only repository access, no `npm-production`
environment, no OIDC permission, and no persisted Git credentials. Package
build or lifecycle code therefore cannot mint an npm publisher token or push
repository changes.

The uncredentialed `prepare` job:

1. resolves the governed, public packages whose checked-in versions are not
   already present on npm;
2. packs each selected package once with lifecycle scripts disabled;
3. records SHA-256, SHA-512 integrity, size, source commit, package
   identity, and topological publication order in `manifest.json`;
4. generates a production-dependency CycloneDX 1.5 SBOM for every exact
   tarball and an aggregate release SBOM;
5. creates a complete production-license inventory and rejects missing or
   high/critical restricted license declarations.

The protected `publish` job downloads that immutable candidate, runs no package
build or lifecycle code, and:

6. scans the aggregate SBOM for high or critical vulnerability and license
   findings with Trivy;
7. creates GitHub SLSA build-provenance and CycloneDX SBOM attestations for the
   exact tarball bytes, then verifies both attestations against this repository,
   workflow, ref, and source commit;
8. retains the manifest, checksums, tarballs, SBOMs, and offline attestation
   bundles as a 90-day workflow artifact;
9. passes those same `.tgz` files to `npm publish --provenance` with lifecycle
   scripts disabled; and
10. verifies that npm exposes the same SHA-512 integrity value.

No build, pack, code-generation, or version-rewrite step may run between
attestation and publication. Published npm versions are immutable. A partial
retry skips an already-published version only when its registry digest exactly
matches the staged artifact.

The machine-readable contract is
`governance/npm-package-supply-chain.json`. Repository health tests ratchet the
workflow order, pinned actions, package count, scan gate, attestation
predicates, tokenless publication, and evidence policy.

## Release inputs

- `packages/<path>/vX.Y.Z` selects one governed package.
- `release/vYYYY-MM-DD` selects all governed packages.
- `vX.Y.Z` and a manual cascade release select all governed packages.
- A manual single release requires an explicit pnpm filter and must run from
  `main`.

Selection is not publication. A package is staged only when its exact
`name@version` is absent from npm. Package versions must therefore be updated
and reviewed on `main` before creating a release tag.

## Consumer verification

Download the registry tarball without installing it, then verify its GitHub
attestations:

```bash
SDK_VERSION="$(npm view @bsv/sdk version)"
npm pack "@bsv/sdk@$SDK_VERSION"

gh attestation verify "bsv-sdk-$SDK_VERSION.tgz" \
  --repo bsv-blockchain/ts-stack \
  --signer-workflow bsv-blockchain/ts-stack/.github/workflows/release.yaml \
  --predicate-type https://slsa.dev/provenance/v1

gh attestation verify "bsv-sdk-$SDK_VERSION.tgz" \
  --repo bsv-blockchain/ts-stack \
  --signer-workflow bsv-blockchain/ts-stack/.github/workflows/release.yaml \
  --predicate-type https://cyclonedx.org/bom
```

After installing dependencies with a lockfile, verify npm registry signatures
and npm provenance attestations:

```bash
npm audit signatures
```

For a particular release run, download the `npm-release-<run>-<attempt>`
workflow artifact to inspect the exact release manifest, per-package SBOMs,
aggregate SBOM, license inventory, checksums, and offline GitHub attestation
bundles.

## npm package settings

Each public package must configure the npm trusted publisher as:

- provider: GitHub Actions;
- organization: `bsv-blockchain`;
- repository: `ts-stack`;
- workflow filename: `release.yaml`;
- environment: `npm-production`; and
- allowed action: `npm publish`.

After trusted publishing has been confirmed for a package, its npm publishing
access should require 2FA and disallow traditional write tokens. Changing the
repository, workflow filename, environment, or package ownership requires a
coordinated update to all package settings before merging the source change.

## Failure and recovery

Do not replace an immutable version after a failed release.

- Before publication, fix the source or workflow and rerun from a reviewed
  commit.
- After partial publication, rerun the failed `publish` job within the
  candidate artifact's one-day retention window. It reuses the original
  candidate bytes; exact matching versions are verified and skipped, and
  remaining packages continue in dependency order. If the candidate has
  expired, review the published subset and prepare a deliberate recovery
  release rather than assuming newly packed bytes are identical.
- If published content is defective, deprecate the affected version and
  publish a new patch version through the normal workflow.
- Treat any registry digest mismatch, failed attestation, or unexpected
  lifecycle execution as a release-blocking security incident.
