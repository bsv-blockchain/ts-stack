# BASELINE — @bsv/wallet-toolbox

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity

| Field | Value |
|-------|-------|
| Package | `@bsv/wallet-toolbox` |
| Path | `packages/wallet/wallet-toolbox` |
| npm | [@bsv/wallet-toolbox](https://www.npmjs.com/package/@bsv/wallet-toolbox) |
| Version | 2.1.22 |
| Criticality | **Tier 1** — critical service, failure breaks multiple consumers |
| Reliability Level | **RL2** — tests pass, coverage tooling present, no executable contracts yet |
| Owner | @sirdeggen |
| Backup owner | — |

## Build

| Field | Value |
|-------|-------|
| Build command | `tsc --build` |
| Build status | ✅ Passing |
| Outputs | Multiple tsconfig targets (all, client, mobile) |

## Tests

| Field | Value |
|-------|-------|
| Test command | `npm run build && jest --testPathIgnorePatterns=man.test.ts` |
| Test files | 77 |
| Coverage command | `npm run test:coverage` |
| Coverage | Not yet captured as baseline |
| Known flaky | `man.test.ts` excluded (manual integration tests requiring live services) |
| Known skips | `man.test.ts` pattern ignored in default test run |

## Lint

| Field | Value |
|-------|-------|
| Linter | prettier (source repo) — **target: migrate to ts-standard** |
| Lint command | `prettier --write 'src/**/*.ts'` |
| Status | Uses prettier, not ts-standard — tracked debt |

## Dependencies

| Type | Count | Packages |
|------|-------|---------|
| Production | 10 | @bsv/auth-express-middleware, @bsv/payment-express-middleware, @bsv/sdk, better-sqlite3, express, hash-wasm, idb, knex, mysql2, ws |
| Dev | — | typescript, jest, prettier, ts2md, … |

## Known Issues & Incidents

- Lint uses prettier rather than ts-standard (org standard). Migration tracked.
- `man.test.ts` tests require external services — not run in CI.

## Conformance Vectors

No vectors exist yet. Phase 2 target: wallet interface (BRC-100) contract tests.

## Migration Gate Checklist (MBGA §13.3)

- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo (bsv-blockchain/wallet-toolbox)
