---
id: dependency-release-policy
title: "Dependency and Release Policy"
kind: reference
version: "1.0.0"
last_updated: "2026-07-24"
last_verified: "2026-07-24"
review_cadence_days: 30
status: stable
tags: [reference, dependencies, security, releases]
---

# Dependency and Release Policy

This workspace keeps application code, published npm packages, and infrastructure
images on one reviewed dependency baseline.

## Supported toolchain

- Node.js 24.11 or newer
- pnpm 10
- TypeScript 6
- Oxlint for TypeScript linting

CI, conformance, documentation, and release workflows run on Node.js 24. Package
lint errors fail the build. Existing warnings remain visible and are reduced
progressively; a package may opt into stricter warning enforcement once its
warning baseline reaches zero.

## Supply-chain controls

`pnpm-workspace.yaml` is the source of truth for installation controls:

- dependency build scripts are denied unless explicitly listed in `allowBuilds`;
- ordinary releases must age for 24 hours before installation;
- first-party `@bsv/*` packages are exempt so coordinated releases can complete;
- registry provenance downgrades are rejected for recent packages; and
- `pnpm audit --audit-level=high` blocks high and critical advisories in CI and
  release jobs.

Parallel test lanes install with lifecycle scripts disabled. The wallet lanes
then rebuild only the explicitly allowlisted `better-sqlite3` binding they need;
the full build lane remains the single place that runs the workspace's approved
installation scripts.

The version-consistency gate also rejects public package manifests that place
type declarations, test runners, test clients, linters, documentation
generators, or TypeScript build tools in `dependencies`. This prevents
development-only advisory trees from leaking into clean consumer installs.

The workspace carries one audited dependency override. Jest 30 still reaches
unpatched `brace-expansion` 1.x/2.x releases through its current `glob` and
`test-exclude` graph, so those versions are raised to 5.0.8. This final
substitution is verified by every Jest suite and is removed when Jest accepts
the patched major. Any future temporary override must likewise name its upstream
removal condition in `pnpm-workspace.yaml` and verify the affected path.

The former AsyncAPI generator override was eliminated by replacing that
dependency with a deterministic
renderer built on the maintained `yaml` parser. This removes the legacy parser,
`brace-expansion`, and `jsonpath-plus` chains instead of masking them with
transitive substitutions.

## Known upstream advisory holds

The verified 2026-07-24 audit contains no high or critical findings. The
remaining findings are not runtime paths in published BSV libraries:

| Scope | Severity | Reason for hold |
| --- | --- | --- |
| Jest notifier: `uuid` 8 | Moderate | Test notification path only; no caller supplies a UUID output buffer. |
| Docs site: React Router 6 | Moderate | Static, repository-authored site. Router 7 is incompatible with the current SSG adapter and currently introduces a high-severity React Server Components advisory into the audit. |
| `ts-jest` build helper: `esbuild` | Low | Development dependency; the advisory requires a Windows development server, which this workflow does not run. |
| Express: `body-parser` 2.2 | Low | The paymail service does not configure an invalid body-size limit. |

Do not hide these with broad overrides. Re-evaluate them when Jest, `ts-jest`,
Express, or the docs SSG adapter publishes a compatible fix.

## Update and release flow

1. Refresh direct dependencies within their declared semver ranges.
2. Remove obsolete or unused packages before considering overrides.
3. Run the frozen install, version checks, audit, lint, build, tests,
   conformance, and documentation build.
4. Review Dependabot changes as grouped maintenance work. Do not merge a bot PR
   merely because its diff is generated: check runtime relevance, changelogs,
   peer compatibility, audit impact, and full CI.
5. Patch-bump every publishable workspace package whose source or published
   manifest changed.
6. Publish through the OIDC release workflow. Never publish from a workstation.
7. Merge the generated version-sync PR, then release any infra images whose
   first-party dependency ranges changed.

Breaking major upgrades are handled as focused migrations with an explicit
compatibility and rollback plan. They are not forced into the workspace through
transitive overrides.
