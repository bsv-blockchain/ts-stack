# BASELINE — @bsv/gasp

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/gasp` |
| Path | `packages/overlays/gasp-core` |
| npm | [@bsv/gasp](https://www.npmjs.com/package/@bsv/gasp) |
| Version | 1.2.2 |
| Criticality | **Tier 3** — GASP (Graph Aware Sync Protocol) core; failure isolated to overlay sync |
| Reliability Level | **RL1** — 1 test file, coverage tooling present |
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
| Test command | `npm run build && jest` |
| Test files | 1 |
| Coverage command | `npm run build && jest --coverage` |
| Coverage | Not yet captured as baseline |
| Known flaky | None identified |

## Lint
| Field | Value |
|-------|-------|
| Linter | ts-standard |
| Lint command | `ts-standard --fix src/**/*.ts` |

## Dependencies
| Type | Count | Packages |
|------|-------|---------|
| Production | 1 | @bsv/sdk |

## Known Issues & Incidents
None recorded at migration time.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
