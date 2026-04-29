---
id: about-versioning
title: "Versioning Policy"
kind: meta
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 90
status: stable
tags: [about, versioning, semver, releases]
---

# Versioning Policy

ts-stack follows Semantic Versioning (MAJOR.MINOR.PATCH) for all packages.

## Version Format

```
MAJOR.MINOR.PATCH
  ↓     ↓     ↓
  1     2     3
```

- **MAJOR** — Breaking changes (incompatible API changes)
- **MINOR** — New features (backward compatible)
- **PATCH** — Bug fixes (backward compatible)

## Release Cadence

Different stability levels have different release schedules:

### Stable Packages (status: stable)
```
@bsv/sdk@1.2.3
@bsv/wallet-toolbox@1.0.0
@bsv/authsocket@2.1.6
```

- Monthly or as-needed for critical bugs
- Extensive testing before release
- OIDC npm provenance verification
- Breaking changes only in major versions

### Beta Packages (status: beta)
```
@bsv/wab-server@0.2.1
@bsv/uhrp-lite@0.1.0
```

- More frequent releases (weekly possible)
- May have breaking changes in minor versions
- Should not be used in production

### Experimental Packages (status: experimental)
- Expect significant changes
- Not ready for general use
- API may change without notice

## Support Windows

Only the latest major version receives bug fixes:

```
@bsv/sdk@1.x.x — Supported (bug fixes)
@bsv/sdk@2.x.x — Supported (full support)

Older versions — Unsupported
```

Critical security fixes (CVE/CWE) are backported to the previous major version for 6 months after new major release.

## Documentation Versioning

Doc pages track versions via frontmatter:

```yaml
---
version: "1.2.3"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
---
```

### Fields

- **version** — Latest tested version of package/spec
- **last_updated** — When documentation was last written
- **last_verified** — When documentation was last tested
- **review_cadence_days** — How often to re-verify

### Staleness

Docs are considered stale after `review_cadence_days` without verification:

```
last_verified: "2026-04-28"
review_cadence_days: 30

Stale after: 2026-05-28
```

Automated agents check stale docs and update them against current npm versions.

## Breaking Changes

When a breaking change occurs, all affected users are notified:

1. Major version bump (e.g., 1.x.x → 2.0.0)
2. Migration guide published
3. GitHub releases page annotated
4. NPM deprecation message on old version

### Deprecation Path

Features may be deprecated before removal:

1. **v1.x** — Feature works, deprecation warning logged
2. **v2.0** — Feature removed, migration guide updated

## Dependencies

ts-stack pins dependencies to minor versions:

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "postgres": "^14.0.0"
  }
}
```

This allows:
- Patch updates automatically (bug fixes)
- Requires manual update for minor/major (new features/breaking changes)

## Publishing

All packages are published via:

1. **NPM Registry** — npm.js.org
2. **OIDC Provenance** — Proves packages came from CI/CD
3. **Checksums** — Verify package integrity
4. **Tags** — `latest`, `beta`, `experimental`

Example:

```bash
npm install @bsv/sdk@latest     # Stable
npm install @bsv/wab-server@beta # Beta
```

## Changelog

See the [GitHub Releases](https://github.com/bsv-blockchain/ts-stack/releases) page for:
- Each package's release notes
- Breaking changes
- New features
- Bug fixes

Format per [Keep a Changelog](https://keepachangelog.com/):

```
## [1.2.0] - 2026-04-28

### Added
- New feature X

### Changed
- Breaking change Y

### Fixed
- Bug Z
```

## Next Steps

- [Contributing Guide](/docs/about/contributing/) — How to contribute
- [Doc Agent Guide](/docs/about/doc-agent/) — Maintaining docs
- [Package Updates](/docs/about/keeping-docs-fresh/) — Syncing with releases
