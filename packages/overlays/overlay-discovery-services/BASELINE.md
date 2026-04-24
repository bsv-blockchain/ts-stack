# BASELINE — @bsv/overlay-discovery-services

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/overlay-discovery-services` |
| Path | `packages/overlays/overlay-discovery-services` |
| npm | [@bsv/overlay-discovery-services](https://www.npmjs.com/package/@bsv/overlay-discovery-services) |
| Version | 2.0.2 |
| Criticality | **Tier 3** — overlay discovery; failure isolated to overlay lookup domain |
| Reliability Level | **RL1** — 4 test files, coverage tooling present |
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
| Test files | 4 |
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
| Production | 4 | @bsv/overlay, @bsv/sdk, @bsv/wallet-toolbox-client, mongodb |

## Known Issues & Incidents
None recorded at migration time.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
