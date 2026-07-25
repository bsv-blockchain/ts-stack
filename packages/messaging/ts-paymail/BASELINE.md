# BASELINE — @bsv/paymail

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/paymail` |
| Path | `packages/helpers/ts-paymail` |
| npm | [@bsv/paymail](https://www.npmjs.com/package/@bsv/paymail) |
| Version | 2.3.0 |
| Criticality | **Tier 2** — Paymail protocol implementation; failure isolates to paymail resolution domain |
| Reliability Level | **RL2** — 15 test files, coverage tooling present |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsc -b && tsconfig-to-dual-package tsconfig.cjs.json` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | Dual ESM + CJS via tsconfig-to-dual-package |

## Tests
| Field | Value |
|-------|-------|
| Test command | `npm run build && jest --testTimeout=15000` |
| Test files | 15 |
| Coverage command | `npm run build && jest --coverage` |
| Coverage | Not yet captured as baseline |
| Known flaky | None identified (extended timeout suggests some network-dependent tests) |

## Lint
| Field | Value |
|-------|-------|
| Linter | Oxlint |
| Lint command | `oxlint src` |

## Dependencies
| Type | Count | Packages |
|------|-------|---------|
| Production | 12 | @bsv/sdk, @types/jest, cross-fetch, express, jest, joi, node-fetch, supertest, ts-jest, ts2md, tsconfig-to-dual-package, typescript |

## Known Issues & Incidents
- Some production dependencies (@types/jest, jest, ts-jest, etc.) appear to be dev-only dependencies listed in `dependencies` rather than `devDependencies` — tracked debt.
- Extended test timeout (15s) may indicate network-dependent tests.

Resolution (2026-07-25): version 2.4.2 moved all test, type, build, lint, and
documentation tools to `devDependencies`, removed unused `node-fetch`, added
the declared license to the tarball, and excluded tests and locally generated
example/build artifacts from the published package.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
