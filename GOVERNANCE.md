# Governance

## Mission

Make the BSV Distributed Applications Stack — across TypeScript, Go, Python, and Rust — easier to maintain, cleaner to read, measurably faster, demonstrably more secure, and boringly reliable. TypeScript is the canonical reference. Specs are the contract.

Full programme: [MBGA.md](./MBGA.md)

## Roles

| Role | Responsibility |
|------|----------------|
| **Stack Architect** | Spec ownership, cross-language consistency, final call on cross-domain boundaries |
| **Domain Leads** (SDK, Wallet, Overlay, Messaging, Broadcast, Middleware) | Parity and conformance across languages within domain; own CODEOWNERS entries |
| **Language Leads** (TS, Go, Py, Rs) | Idiomatic quality within a language |
| **Security Lead** | Supply chain, threat models, coordinated disclosure, signing infrastructure |
| **QA / Release Engineer** | CI, conformance dashboard, release process, interop matrix |

Named owners are recorded in `specs/reliability/` per package.

## Decision Making

- **Day-to-day changes** (bug fixes, tests, docs): single reviewer approval sufficient.
- **New packages or major refactors**: Domain Lead approval required.
- **Cross-domain changes** (touching ≥2 domains): Stack Architect approval required.
- **Breaking changes**: require `BREAKING.md` entry + 60-day deprecation window (security fixes exempt).
- **Spec amendments**: require a spec PR merged before implementation changes.

Disputes: Stack Architect holds final call on cross-domain design; Language Leads hold final call on idiomatic code within their language.

## Versioning and Releases

- **Semver** per package. Monorepo root has no version.
- **Changesets** for TS packages.
- **Release cadence**: SDKs on demand (reviewed weekly); services monthly; apps independent; security out of band.
- **Breaking changes**: `BREAKING.md` at repo root; minimum 60-day deprecation notice; cross-language parity issues auto-generated.

## Contribution

### Before You Start

- Check open issues and the [roadmap project](https://github.com/orgs/bsv-blockchain/projects) to avoid duplicate work.
- For large changes, open an issue first to discuss approach.
- Security vulnerabilities: see [SECURITY.md](./SECURITY.md).

### Pull Request Requirements

- [ ] CI green (build, lint, tests)
- [ ] Conformance vectors updated if behaviour changes
- [ ] Regression test added for bug fixes (shared vector if cross-language)
- [ ] Specs updated if a public API or protocol changes
- [ ] `BREAKING.md` updated if breaking (with migration notes)
- [ ] Docs updated if user-facing behaviour changes
- [ ] Benchmark re-run if hot path is touched

### Review SLA

Every PR receives a public review within **5 business days**. Misses are tracked on the conformance dashboard.

### Good First Issues

Look for `good-first-issue` labels. The easiest entry points:
- Port a single conformance vector to an under-represented language.
- Add a BASELINE.md to a package that is missing one.
- Fix a lint warning in a Tier 3 package.

## Parity Classes

| Class | Meaning | Release gate |
|-------|---------|--------------|
| **Required** | Production, cross-language public APIs | Must pass shared vectors; blocks release |
| **Intended** | Planned public support | Status visible; not blocking |
| **Best-effort** | Useful but not critical | Not blocking |
| **Unsupported** | Not implemented or not planned | Explicit in docs and dashboard |

Cross-language parity SLA: Go within 30 days of TS GA; Python/Rust within 90 days.

## Reliability Levels

Components are rated RL0–RL5. See [MBGA.md §4](./MBGA.md) for the full rubric. Current status per package: `specs/reliability/`.

## Code of Conduct

This project follows the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
