---
id: about-doc-agent
title: 'Documentation Maintenance'
kind: meta
version: '2.1.0'
last_updated: '2026-07-30'
last_verified: '2026-07-30'
review_cadence_days: 30
status: stable
tags: [about, documentation, maintenance, automation]
---

# Documentation Maintenance

Documentation is part of the supported package and service contract. A page is
not current merely because it renders: its links, frontmatter, versions,
generated facts, examples, and operational claims must agree with source.

## Sources of truth

- Package name, version, engines, exports, and dependencies: the package's
  `package.json`.
- Governed projects, profiles, runtime targets, release routes, and ownership:
  `governance/repository-health/projects.json`.
- Public README requirements and support-language policy:
  `governance/documentation-policy.json`.
- Conformance totals: `conformance/META.json`; file-level parity:
  `conformance/PARITY_MATRIX.json`; runner behavior: current CI reports.
- Release behavior: `.github/workflows/release.yaml`,
  `.github/workflows/infra-release.yaml`, and the machine-readable supply-chain
  policies.
- Contribution policy: the root
  [`CONTRIBUTING.md`](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md).
- Deferred final QA:
  [issue #400](https://github.com/bsv-blockchain/ts-stack/issues/400);
  release/external assurance:
  [issue #401](https://github.com/bsv-blockchain/ts-stack/issues/401); and
  analysis/CI follow-up:
  [issue #402](https://github.com/bsv-blockchain/ts-stack/issues/402).

Do not copy source-manifest tables into prose. Run `pnpm docs:facts` and link to
[Generated Stack Facts](../reference/stack-facts.md).

## Required frontmatter

Every rendered page uses:

```yaml
---
id: unique-slug
title: 'Page title'
kind: spec
version: '1.0.0'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
status: stable
tags: [protocol, reference]
---
```

- `version` is the source package version verified by a package page, the
  protocol/doc version for a spec, or the page's own revision for meta content.
- `last_updated` changes when prose or structure changes.
- `last_verified` changes only after checking the page against its current
  source and applicable commands.
- `review_cadence_days` is enforced. Use 30 days for active package, protocol,
  operational, and security pages; use a longer cadence only for truly stable
  conceptual material.
- `status` describes the documented contract, not whether the page is finished.

## Blocking checks

```bash
# Generate after package, runtime, release-route, or conformance changes
pnpm docs:facts

# Verify generated facts, parity metadata, package README contracts,
# package-doc versions, and review cadence
pnpm docs:facts:check

# Validate frontmatter and source links
pnpm --filter docs-site validate

# Render the complete site and check built links
pnpm docs:build
```

The package README contract covers every public package and requires registry
consumers to be able to identify, install, exercise, and license it. Package
artifact checks separately prove that each README and `LICENSE.txt` ships in
the exact tarball. Every public package also has one current page under
`docs/packages`; the policy rejects missing or duplicate pages, stale versions,
retired source repositories, point-in-time source commits presented as current
authority, and npm links on private workspaces.

`pnpm check-versions` validates first-party package ranges; it does not publish,
query npm for documentation freshness, or replace `docs:facts:check`.
`pnpm sync-versions` is a release-reconciliation mutation and must not be run
as a casual documentation fix.

## Review procedure

When changing or re-verifying a page:

1. Identify every factual authority used by the page.
2. Compare package versions, exports, scripts, runtime requirements, service
   configuration, and release behavior with those sources.
3. Run or compile commands/examples that are meant to be executable. Label
   placeholders, pseudocode, destructive commands, live-service requirements,
   and platform assumptions honestly.
4. Remove obsolete promises, versions, counts, copied lists, unsafe defaults,
   and links to pre-consolidation repositories.
5. Preserve historical audits as clearly labeled point-in-time evidence; do not
   present them as the current backlog.
6. Update `last_updated` and, only after verification, `last_verified`.
7. Run all blocking checks above and review the rendered output.

For public services, document both the public-by-default cross-domain path and
the optional operator allowlist. CORS, CSP, or origin filtering must not be
described as authentication, and a hosting/fallback URL must not silently imply
same-origin-only access.

For releases, distinguish source, registry, and deployed state. Never say a
version or image is available until registry or deployment evidence proves it.
See [Release and Operations Guide](../reference/release-operations.md).

## Example quality

Prefer examples exercised by package tests, clean consumers, generated clients,
or an automated documentation-example check. A historical checklist that once
marked a code block correct is not a current test.

Examples must:

- import public entry points, not monorepo source paths;
- match current TypeScript declarations and runtime profiles;
- use synthetic keys, credentials, identities, and endpoints;
- avoid public database/firewall defaults and mutable production image tags;
- explain external services, wallets, databases, funded state, or live network
  requirements; and
- include error/security handling when omission would make the example unsafe.

## Historical and generated content

Generated output must declare its source and check command and must never be
hand-edited. Historical benchmark, audit, and migration records keep their
original measurements but carry a prominent archive banner and point to current
facts and tracker state.

## Pull request evidence

A documentation PR should state:

- pages and source authorities reviewed;
- commands/examples actually executed;
- generated files refreshed;
- runtime, deployment, security, or migration claims changed; and
- intentionally historical or deferred content left unchanged.

Update the applicable focused issue when work changes its remaining scope. Do
not reopen the retired modernization tracker or copy active policy into a
package-local document.
