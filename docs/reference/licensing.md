---
id: licensing-policy
title: 'Licensing Policy'
kind: reference
version: '2.2.0'
last_updated: '2026-08-27'
last_verified: '2026-08-27'
review_cadence_days: 90
status: stable
tags: [reference, licensing, packages, releases]
---

# Licensing Policy

Current TS Stack first-party contributions use the Open BSV License Version 6.
Historical first-party code remains subject to every prior grant that applied
when it was published; those grants are preserved and scoped through
`governance/license-continuity.json`. This rule applies to public packages,
private applications, infrastructure services, examples, conformance runners,
documentation tooling, and code generators. It does not relicense incorporated
third-party material or extinguish a prior grant.

The repository-root
[`LICENSE.txt`](https://github.com/bsv-blockchain/ts-stack/blob/main/LICENSE.txt)
is the canonical first-party text. It is an exact copy of the current
[BSV Association license published by Teranode](https://github.com/bsv-blockchain/teranode/blob/main/LICENSE),
with SHA-256
`bac995a0c84dd533f7d5335b6d870aae9fee7d28d189b8aa78b103e0c9932bc0`.

## Package convention

Every directory containing a `package.json` must:

- declare `"author": "BSV Association"`, the Association's current public
  identity;
- declare `"license": "SEE LICENSE IN LICENSE.txt"`;
- contain `LICENSE.txt` with bytes identical to the canonical root file;
- include `LICENSE.txt` exactly once when the package uses a `files` allowlist;
- avoid alternate first-party names such as `LICENSE`, `LICENSE.md`, or
  `license.md`; and
- repeat the same declaration in the root package entry of a colocated
  `package-lock.json`.

Open BSV License is not an SPDX-listed identifier, so npm manifests point to
the bundled first-party license text instead of inventing an SPDX expression.
Container metadata uses the scoped identifier
`LicenseRef-Open-BSV-License-6` and points to its full notice archive.
Older Association names remain only where they form part of an exact historical
copyright or license record. They must not be rewritten in those records or
used as current package authorship.

Separately or historically licensed portions are listed in
`governance/third-party-materials.json`, with immutable provenance records in
`governance/license-evidence/provenance.json` and the pre-uniformization
snapshot in `governance/license-continuity.json`. Runtime packages compiled
into the deployed documentation site are separately pinned in
`governance/docs-site-bundled-materials.json`. Generated
`THIRD_PARTY_NOTICES.md` and `LICENSES/` payloads accompany every affected npm
package, UMD bundle, WASM package, container, and static-site deployment. The
Open BSV terms apply only to TS Stack's protectable first-party contributions
to those mixed works.

## Incorporated material

There are three distinct compliance categories:

1. **Ordinary dependencies** stay separate in `node_modules`. Their package
   licenses are preserved by the package manager and inventoried in release
   SBOMs.
2. **Incorporated source** was copied, translated, adapted, or inlined into TS
   Stack source. Its copyright notices, license terms, source provenance, and
   affected paths must be registered and shipped with every containing
   distribution.
3. **Compiled or bundled material** includes browser bundles, static-site
   client code, generated search runtimes, and VeriFast's WASM/toolchain output.
   The containing distribution must ship its scoped notices and exact license
   texts, and generated JavaScript must retain a notice banner even when copied
   separately.

The documentation build creates temporary client source maps solely to derive
the exact set of packages entering the Vite bundle. It rejects any component
not present in the hash-pinned registry, adds Pagefind and its embedded mark.js
runtime, writes the complete deployment notice archive, and then removes the
temporary source maps. Development-only packages that do not enter the browser
bundle are excluded.

Adding MIT, ISC, BSD, Apache, Boost, or other permissively licensed portions
does not require changing all of TS Stack to MIT. Those licenses continue to
govern the identified portions; Open BSV Version 6 continues to govern the
separable first-party portions. A blanket repository relicense must never be
used as a substitute for preserving third-party notices or proving the right to
relicense a contribution.

The registry is authoritative for incorporated and historically scoped
material. Every entry records:

- upstream identity and version or commit;
- license expression and retained license-text hash;
- copyright/attribution notice;
- incorporation form and exact source paths;
- distribution targets; and
- any unresolved rights-clearance item.

Manifest declarations are evaluated with the publishing party's identity,
repository history, immutable package artifacts, and contribution record. A
label without sufficient corroboration remains a recorded gap; a reconstructed
notice alone is never treated as proof of permission.

## Enforcement

Run:

```sh
pnpm license:check
```

The command verifies every layer of the policy. It discovers every npm
manifest, checks the canonical first-party license hash and package copies,
validates the incorporated-material registry and source paths, verifies every
license-text hash, hash-validates the provenance and continuity records,
confirms that each historical scope has a retained grant, rejects restoration
of known unlicensed distribution artifacts, validates every docs-bundle package
and license hash, and byte-compares all generated notice payloads. The docs
build additionally compares its actual source-map module set with the governed
inventory before it can produce a deployment artifact. These checks are part
of `pnpm health:check`, so CI prevents a new package or later edit from drifting.

Maintainers can repair mechanical drift with:

```sh
pnpm license:sync
```

Review the resulting diff before commit. A change to the canonical license
version or text is a legal-policy change: it requires explicit maintainer
authorization, an updated authoritative source and hash, regenerated package
copies, updated container metadata, and full package-tarball verification.

Before changing or importing code, search its provenance, inspect the exact
upstream revision, and update the registry in the same change. Do not rely only
on dependency scanners: copied and translated code often has no package
metadata. Run both structural/source-history review and similarity scanning for
cryptography, protocol fixtures, generated code, and binaries.

## Release verification

Before publishing:

1. run `pnpm license:check`;
2. run `pnpm license:release-check` and resolve every recorded clearance;
3. dry-pack every public package with lifecycle scripts disabled;
4. confirm each tarball contains exact `LICENSE.txt`,
   `THIRD_PARTY_NOTICES.md`, and scoped `LICENSES/` payloads;
5. verify browser bundle banners, VeriFast WASM companions, container notice
   paths, CycloneDX components, and `licenses.json`;
6. run repository health, build, test, audit, and version checks; and
7. publish only through the reviewed OIDC release workflow.

`pnpm license:release-check` intentionally fails while any registry clearance
is `required`. Change a clearance to `cleared` only when the accepted immutable
public evidence, written permission, assignment, counsel-approved ownership
chain, or independently reauthored replacement is retained and identified by
the registry. Notice generation must never auto-clear a rights gap.
