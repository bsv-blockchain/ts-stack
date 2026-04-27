<!-- Centralized reliability record. Source repo: bsv-blockchain/ts-sdk -->
<!-- When ts-sdk is consolidated into ts-stack (Phase 5), this file moves with it. -->

# Reliability Status

## Component
- Name: @bsv/sdk
- Domain: SDK
- Criticality tier: 0
- Reliability Level (current → target): RL2 → RL5
- Owner / Backup owner: BSV Blockchain SDK team / BSV Blockchain Association

## Build and Test
- Build command: `npm run build` (tsc -b + rspack UMD bundle)
- Test command: `npm test` (build + jest)
- Lint command: `npm run lint:ci` (ts-standard)
- Coverage command: `npm run test:coverage`
- Benchmark command: None defined (benchmarks/ directory exists but no npm script)
- Last baseline date: 2026-04-24
- Known flaky tests: None known

## Supported Versions
- Runtime versions: Node.js 20, 22, 24 (tested in CI matrix)
- Package versions: @bsv/sdk v2.0.14
- Protocol/spec versions: BRC-2, BRC-3, BRC-10, BRC-31, BRC-42, BRC-56, BRC-69, BRC-77, BRC-78, BRC-100 (per README/docs)

## Contracts
- Public APIs: TypeScript exports via dist/types/mod.d.ts; ESM (dist/esm/) and CJS (dist/cjs/) dual-package
- Specs: BRC specifications at https://brc.dev
- Schemas: None (type declarations serve as schema)
- Contract tests: None separate from unit tests
- Conformance vectors: None formally maintained
- Codegen source: None

## Operations
- Health endpoint: N/A (library, not a service)
- Readiness endpoint: N/A
- Metrics: N/A
- Logs: N/A
- Tracing: N/A
- Runbook: None
- Dashboard: None
- Alerts: None
- SLOs: None defined
- Rollback procedure: Revert npm publish via `npm unpublish @bsv/sdk@<version>` (within 72h) or pin consumers to prior version

## Security
- Threat model: None formally documented
- High-risk paths: Key generation/derivation (primitives/PrivateKey), ECDSA/Schnorr signing, HMAC/ECIES encryption, transaction construction (BEEF/BUMP/Merkle), script evaluation (script/Interpreter), auth/session (auth/)
- Signing key source: npm OIDC provenance (GitHub Actions publish job uses id-token: write)
- SBOM location: None generated
- Last security review: Unknown

## Risks
- Known risks: No fuzz or property-based tests; no formal threat model; no coverage threshold enforced in CI
- Recent incidents: None known
- Unsupported behavior: Browser environments (UMD bundle provided but not tested in CI)
- Technical debt: No coverage threshold gate; benchmark suite not integrated into CI

## Release Requirements
- Required checks: Build & Test CI (Node 20/22/24), lint:ci
- Required reviewers: Unknown (not documented in repo)
- Artifact signing: npm OIDC provenance (id-token write via GitHub Actions)
- SBOM: Not generated
- Migration notes: See CHANGELOG.md

---

# Baseline Snapshot
Date: 2026-04-24

## Build
- Build command: `npm run build`
- Build result: pass
- Build time: Unknown (not measured locally; CI runs on ubuntu-latest)

## Tests
- Test command: `npm test` (runs build then jest)
- Test count: 237
- Test result: pass
- Coverage: Available via `npm run test:coverage` (lcov output to coverage/); no enforced threshold

## Lint
- Lint command: `npm run lint:ci` (ts-standard src/**/*.ts)
- Result: pass (run in CI on every push/PR)

## Dependencies
- Dependency audit command: `npm audit`
- Known HIGH/CRITICAL CVEs: Unknown — audit not run at baseline date; no automated audit step in CI

## Known Issues
- Known flaky tests: None known
- Known failing tests: None known
- Technical debt notes: Benchmark suite in benchmarks/ directory exists but is not wired into CI. No coverage threshold enforced. No fuzz/property tests.

## Reliability Level
- Current RL: 2
- Target RL: 5
- Gaps to next level:
  - RL3: No executable conformance vectors for BRC specs; no formal breaking-change policy documented; release notes exist (CHANGELOG.md) but conformance test suite absent
  - RL4: No health/readiness endpoints (library); no structured observability (n/a for library, but interop test matrix not green/tracked)
  - RL5: No fuzz or property-based tests; no load/soak tests; no formal threat model; no tracked security findings; no interop matrix

---

# Benchmark Baseline

Captured: 2026-04-24
Machine: arm64 (Apple M3 Pro, Darwin 25.4.0)
Runtime: Node.js v22.20.0

## Hot Path Baselines

| Operation | ns/op | Notes |
|-----------|------:|-------|
| ECDSA Sign | 967,819 | secp256k1 via ECDSA.sign (BigNumber-based impl) |
| ECDSA Verify | 1,831,090 | secp256k1 via ECDSA.verify |
| SHA-256 (32 B input) | 1,982 | Pure-JS SHA256, 32-byte input |
| SHA-256 (1 KB input) | 17,215 | Pure-JS SHA256, 1024-byte input |
| BEEF_V1 parse (minimal) | 161,431 | BRC-62 minimal 2-tx chain |
| Transaction serialize (toBinary) | 7,137 | 3-input 2-output P2PKH tx |
| Script eval (P2PKH) | 1,271,585 | Full Spend.validate() with OP_CHECKSIG |

> Note: TS SDK ECDSA is pure-JavaScript (BigNumber-based); Go uses stdlib
> `crypto/ecdsa` over the native secp256k1 curve. The ~20× difference in ECDSA
> is expected and reflects the two different cryptographic backends.
> SHA-256 is also pure-JS vs Go's stdlib (~50× difference), consistent with
> known JavaScript overhead.

## Methodology

- **TS**: `node scripts/benchmark.mjs` — `performance.now()` wall-clock,
  per-operation iteration counts chosen to give ≥250 ms total per run,
  2 warm-up rounds, median of 3 independent runs, reported as ns/op.
- Benchmark source: `scripts/benchmark.mjs`

## Raw output (node scripts/benchmark.mjs)

```
MBGA Phase 0 — Tier 0 Hot-Path Baselines (TS SDK)
========================================================================
Operation                                     ns/op
------------------------------------------------------------------------
ECDSA sign                                  967,819 ns/op   (1000 iters, median of 3 runs)
ECDSA verify                              1,831,090 ns/op   (500 iters, median of 3 runs)
SHA-256 (32 B input)                          1,982 ns/op   (50000 iters, median of 3 runs)
SHA-256 (1 KB input)                         17,215 ns/op   (50000 iters, median of 3 runs)
BEEF_V1 parse (minimal)                     161,431 ns/op   (5000 iters, median of 3 runs)
Transaction serialize (toBinary)              7,137 ns/op   (50000 iters, median of 3 runs)
Script eval (P2PKH)                       1,271,585 ns/op   (500 iters, median of 3 runs)
========================================================================
```

## Regression gate

A >5% regression on any Tier 0 row (ECDSA Sign, ECDSA Verify, SHA-256, BEEF
parse, Transaction serialize, Script eval P2PKH) blocks a Tier 0 release
(MBGA §16 Appendix B).
