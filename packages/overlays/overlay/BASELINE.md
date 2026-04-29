# BASELINE — @bsv/overlay

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity

| Field | Value |
|-------|-------|
| Package | `@bsv/overlay` |
| Path | `packages/overlays/overlay-services` |
| npm | [@bsv/overlay](https://www.npmjs.com/package/@bsv/overlay) |
| Version | 2.0.2 |
| Criticality | **Tier 1** — critical service, failure breaks overlay domain |
| Reliability Level | **RL1** — builds, 3 test files (low coverage), no contracts |
| Owner | @sirdeggen |
| Backup owner | — |

## Build

| Field | Value |
|-------|-------|
| Build command | `tsc -b && tsconfig-to-dual-package tsconfig.cjs.json` |
| Build status | ✅ Passing |
| Outputs | ESM + CJS dual package |

## Tests

| Field | Value |
|-------|-------|
| Test command | `npm run build && jest` |
| Test files | 3 |
| Coverage command | `npm run test:coverage` |
| Coverage | **Low** — 3 test files for 21 source files. Significant gap. |
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
| Production | 3 | @bsv/gasp, @bsv/sdk, knex |
| Dev | — | typescript, jest, ts-standard, ts2md, … |

## Known Issues & Incidents

- **Test coverage is critically low** (3 test files / 21 source files). Phase 1 priority: expand before Phase 2 contract work.
- Core engine for all overlay services — regressions here cascade widely.

## Conformance Vectors

No vectors exist yet. Phase 2 target: overlay Topic Manager + Lookup Service contract interface vectors.

## Migration Gate Checklist (MBGA §13.3)

- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo (bsv-blockchain/overlay-services)
