# BASELINE — @bsv/overlay-express

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/overlay-express` |
| Path | `packages/overlays/overlay-express` |
| npm | [@bsv/overlay-express](https://www.npmjs.com/package/@bsv/overlay-express) |
| Version | 2.2.0 |
| Criticality | **Tier 3** — overlay hosting framework; failure isolated to overlay deployment |
| Reliability Level | **RL2** — 6 test files, coverage command present |
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
| Test command | `jest` |
| Test files | 6 |
| Coverage command | `jest --coverage` |
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
| Production | 11 | @bsv/auth-express-middleware, @bsv/overlay, @bsv/overlay-discovery-services, @bsv/sdk, @bsv/wallet-toolbox-client, body-parser, chalk, express, knex, mongodb, uuid |

## Known Issues & Incidents
None recorded at migration time.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
