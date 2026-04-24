# BASELINE — @bsv/sdk

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity

| Field | Value |
|-------|-------|
| Package | `@bsv/sdk` |
| Path | `packages/sdk/ts-sdk` |
| npm | [@bsv/sdk](https://www.npmjs.com/package/@bsv/sdk) |
| Version | 2.0.14 |
| Criticality | **Tier 0** — core protocol, failure breaks entire stack |
| Reliability Level | **RL2** — tests pass in CI, coverage tooling present, no executable contracts yet |
| Owner | @sirdeggen |
| Backup owner | — |

## Build

| Field | Value |
|-------|-------|
| Build command | `npm run build` (tsc -b + tsconfig-to-dual-package + rspack UMD) |
| Build status | ✅ Passing |
| Outputs | `dist/esm/`, `dist/cjs/`, `dist/umd/` |
| Dual package | Yes (ESM + CJS via tsconfig-to-dual-package) |

## Tests

| Field | Value |
|-------|-------|
| Test command | `npm run build && jest` |
| Test files | 131 |
| Coverage command | `npm run build && jest --coverage` |
| Coverage | Not yet captured as baseline — run `npm run test:coverage` to establish |
| Known flaky | None identified |
| Known skips | None |

## Lint

| Field | Value |
|-------|-------|
| Linter | ts-standard |
| Lint command | `ts-standard src/**/*.ts` |
| Fix command | `ts-standard --fix src/**/*.ts` |
| Status | Not yet verified clean in ts-stack CI |

## Dependencies

| Type | Count | Packages |
|------|-------|---------|
| Production | 0 | *(zero — no runtime deps)* |
| Dev | — | typescript, jest, ts-standard, rspack, ts2md, … |

## Known Issues & Incidents

None recorded at migration time.

## Conformance Vectors

No vectors exist yet. Phase 1 target: populate `conformance/vectors/sdk/` with BRC-1 (transactions), BRC-2 (keys), BRC-3 (scripts) test cases.

## Migration Gate Checklist (MBGA §13.3)

- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo (bsv-blockchain/ts-sdk)
