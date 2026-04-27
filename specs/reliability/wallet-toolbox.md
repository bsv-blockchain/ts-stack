<!-- Centralized reliability record. Source repo: bsv-blockchain/wallet-toolbox -->
<!-- When wallet-toolbox is consolidated into ts-stack (Phase 5), this file moves with it. -->

# Reliability Status

## Component
- Name: @bsv/wallet-toolbox
- Domain: Wallet
- Criticality tier: 1
- Reliability Level (current → target): RL2 → RL4
- Owner / Backup owner: Tone Engel / BSV Blockchain Association

## Build and Test
- Build command: `npm run build` (tsc --build)
- Test command: `npm test` (build + jest, excludes man.test.ts)
- Lint command: `npm run lint` (prettier --write; no ts-standard lint:ci target)
- Coverage command: `npm run test:coverage`
- Benchmark command: None defined
- Last baseline date: 2026-04-24
- Known flaky tests: None known

## Supported Versions
- Runtime versions: Node.js 20, 22, 24 (tested in CI matrix)
- Package versions: @bsv/wallet-toolbox v2.1.22
- Protocol/spec versions: BRC-100 (wallet interface), depends on @bsv/sdk ^2.0.13

## Contracts
- Public APIs: out/src/index.js / out/src/index.d.ts; includes WalletStorage, WalletSigner, and BRC-100 wallet implementations
- Specs: BRC-100 wallet interface specification
- Schemas: None formally maintained
- Contract tests: None separate from unit tests
- Conformance vectors: None formally maintained
- Codegen source: None

## Operations
- Health endpoint: Express HTTP server included (express dependency); no dedicated /health route documented
- Readiness endpoint: None documented
- Metrics: None
- Logs: None structured
- Tracing: None
- Runbook: None
- Dashboard: None
- Alerts: None
- SLOs: None defined
- Rollback procedure: Pin consumers to prior npm version; npm deprecate if critical bug

## Security
- Threat model: None formally documented
- High-risk paths: Wallet key storage (better-sqlite3, knex/mysql2), signer operations, private key handling
- Signing key source: npm OIDC provenance (GitHub Actions publish job uses id-token: write)
- SBOM location: None generated
- Last security review: Unknown

## Risks
- Known risks: Depends on better-sqlite3 (native module, potential native CVEs); no coverage threshold enforced; prettier-only lint (no static analysis lint:ci)
- Recent incidents: None known
- Unsupported behavior: Mobile target (mobile/ directory) tested in CI but coverage unknown
- Technical debt: No lint:ci / static analysis gate; no coverage threshold; no runbook; no health endpoint

## Release Requirements
- Required checks: Test CI (Node 20/22/24), build
- Required reviewers: Unknown (not documented in repo)
- Artifact signing: npm OIDC provenance (id-token write via GitHub Actions)
- SBOM: Not generated
- Migration notes: See CHANGELOG.md; syncVersions.js keeps client/ and mobile/ packages in sync

---

# Baseline Snapshot
Date: 2026-04-24

## Build
- Build command: `npm run build` (tsc --build)
- Build result: pass
- Build time: Unknown (not measured locally)

## Tests
- Test command: `npm test` (build + jest --testPathIgnorePatterns=man.test.ts)
- Test count: 1038
- Test result: pass
- Coverage: Available via `npm run test:coverage`; no enforced threshold

## Lint
- Lint command: `npm run lint` (prettier --write)
- Result: pass (formatting only; no static analysis lint:ci step in CI)

## Dependencies
- Dependency audit command: `npm audit`
- Known HIGH/CRITICAL CVEs: Unknown — audit not run at baseline date; no automated audit step in CI

## Known Issues
- Known flaky tests: None known
- Known failing tests: man.test.ts excluded from default test run (manual/integration tests)
- Technical debt notes: No static analysis lint:ci gate. No coverage threshold enforced. No health/readiness endpoints. No runbook. Native dependency (better-sqlite3) requires native build toolchain.

## Reliability Level
- Current RL: 2
- Target RL: 4
- Gaps to next level:
  - RL3: No executable conformance vectors for BRC-100 spec; no formal breaking-change policy; release notes exist (CHANGELOG.md) but conformance test suite absent
  - RL4: No health/readiness endpoints; no structured logs; no metrics; no traces; no runbook; no SLOs; no alerts; no defined rollback procedure
