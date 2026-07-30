---
id: about-contributing
title: 'Contributing'
kind: meta
version: '2.0.0'
last_updated: '2026-07-30'
last_verified: '2026-07-30'
review_cadence_days: 30
status: stable
tags: [about, contributing, development, community]
---

# Contributing to ts-stack

The canonical, repository-wide contribution policy is the root
[`CONTRIBUTING.md`](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md).
AI agents must also follow the root
[`AGENTS.md`](https://github.com/bsv-blockchain/ts-stack/blob/main/AGENTS.md).

Those files apply to every package, service, specification, conformance
project, documentation surface, and workflow. Package-level `AGENTS.md` files
are generated pointers to the root; packages do not define separate lint,
review, dependency, release, documentation, migration, or quality rules.

The canonical policy covers:

- safe workspace setup and the root Node/pnpm toolchain;
- specifications, cross-implementation compatibility, and Tier 0 review;
- strict TypeScript, zero-warning lint, formatting, testing, conformance,
  package consumers, browser/mobile/WASM, fuzz/property, mutation, security,
  infrastructure, and documentation validation;
- public-service CORS/CSP compatibility;
- dependency and Dependabot review;
- standardized SemVer, package release notes, changelogs, and migration notes;
- exact-head self-review, Sonar/CodeQL zero-finding requirements, and the rule
  that work is not handed off or called complete while CI is pending or
  failing; and
- protected publication, provenance, deployment, and rollback boundaries.

Use the root issue forms and pull request template. Security vulnerabilities
must be reported privately under the
[Security Policy](https://github.com/bsv-blockchain/ts-stack/security/policy).

Current focused follow-up programs are:

- [Deferred final QA: coverage, fuzzing, conformance, and runtime validation](https://github.com/bsv-blockchain/ts-stack/issues/400);
- [Authorized package/image release and external assurance](https://github.com/bsv-blockchain/ts-stack/issues/401); and
- [Sonar administration and CI efficiency review](https://github.com/bsv-blockchain/ts-stack/issues/402).

The completed modernization history remains in retired
[tracker #324](https://github.com/bsv-blockchain/ts-stack/issues/324); it is no
longer the source for contribution policy or active work.
