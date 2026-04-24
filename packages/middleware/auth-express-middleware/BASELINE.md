# BASELINE — @bsv/auth-express-middleware

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity

| Field | Value |
|-------|-------|
| Package | `@bsv/auth-express-middleware` |
| Path | `packages/middleware/auth-express-middleware` |
| npm | [@bsv/auth-express-middleware](https://www.npmjs.com/package/@bsv/auth-express-middleware) |
| Version | 2.0.5 |
| Criticality | **Tier 1** — critical service, used by message-box-server, wallet-toolbox, wab |
| Reliability Level | **RL1** — builds, 2 test files (low coverage), no contracts |
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
| Test files | 2 |
| Coverage command | `npm run test:coverage` |
| Coverage | **Low** — 2 test files for 4 source files. |
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
| Production | 2 | @bsv/sdk, express |
| Dev | — | typescript, jest, ts-standard, ts2md, … |

## Known Issues & Incidents

- **Test coverage low** — 2 test files for 4 source files. Auth middleware is security-critical; coverage gap is a risk.
- Phase 1 priority: expand test coverage and add property/fuzz tests on token parsing paths.

## Security Notes

Auth middleware handles request authentication across multiple services. Per MBGA §7, this is a candidate for threat model review in Phase 2.

## Conformance Vectors

No vectors exist yet. Phase 2 target: BRC-31 (auth) request/response contract vectors.

## Migration Gate Checklist (MBGA §13.3)

- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo (bsv-blockchain/auth-express-middleware)
