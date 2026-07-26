---
id: licensing-policy
title: "Licensing Policy"
kind: reference
version: "1.0.0"
last_updated: "2026-07-26"
last_verified: "2026-07-26"
review_cadence_days: 90
status: stable
tags: [reference, licensing, packages, releases]
---

# Licensing Policy

The entire TypeScript stack uses the Open BSV License Version 6. This applies
uniformly to all npm package projects in the monorepo: public packages, private
applications, infrastructure services, examples, conformance runners,
documentation tooling, and code generators.

The repository-root
[`LICENSE.txt`](https://github.com/bsv-blockchain/ts-stack/blob/main/LICENSE.txt)
is the canonical text. It is an exact copy of the current
[BSV Association license published by Teranode](https://github.com/bsv-blockchain/teranode/blob/main/LICENSE),
with SHA-256
`bac995a0c84dd533f7d5335b6d870aae9fee7d28d189b8aa78b103e0c9932bc0`.

## Package convention

Every directory containing a `package.json` must:

- declare `"license": "SEE LICENSE IN LICENSE.txt"`;
- contain `LICENSE.txt` with bytes identical to the canonical root file;
- include `LICENSE.txt` exactly once when the package uses a `files` allowlist;
- avoid alternate package-level names such as `LICENSE`, `LICENSE.md`, or
  `license.md`; and
- repeat the same declaration in the root package entry of a colocated
  `package-lock.json`.

Open BSV License is not an SPDX-listed identifier, so npm manifests point to
the bundled license text instead of inventing an SPDX expression. Container
metadata uses the uniform identifier `LicenseRef-Open-BSV-License-6`.

These rules cover first-party project licensing. They do not change the
licenses of third-party dependencies or incorporated third-party material;
their required notices and attribution must remain intact.

## Enforcement

Run:

```sh
pnpm license:check
```

The command discovers every npm manifest in the repository, verifies the
canonical license hash, compares each package-local copy byte-for-byte, checks
manifest and lockfile declarations, and rejects legacy filenames. It is part of
`pnpm health:check`, so CI prevents a new package or later edit from drifting.

Maintainers can repair mechanical drift with:

```sh
pnpm license:sync
```

Review the resulting diff before commit. A change to the canonical license
version or text is a legal-policy change: it requires explicit maintainer
authorization, an updated authoritative source and hash, regenerated package
copies, updated container metadata, and full package-tarball verification.

## Release verification

Before publishing:

1. run `pnpm license:check`;
2. dry-pack every public package with lifecycle scripts disabled;
3. confirm each tarball contains the exact `LICENSE.txt`;
4. run repository health, build, test, audit, and version checks; and
5. publish only through the reviewed OIDC release workflow.

This keeps registry packages, source projects, lockfiles, and deployable image
metadata on the same license version.
