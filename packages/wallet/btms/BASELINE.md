# BASELINE — @bsv/btms

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/btms` |
| Path | `packages/wallet/btms` |
| npm | [@bsv/btms](https://www.npmjs.com/package/@bsv/btms) |
| Version | 1.0.1 |
| Criticality | **Tier 3** — non-critical BTMS (BSV Token Management System) package |
| Reliability Level | **RL1** — builds, 2 test files, no coverage command configured |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsc -b` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | Compiled JS from tsc (in `btms-core-tmp/` sub-project) |

## Tests
| Field | Value |
|-------|-------|
| Test command | `jest` |
| Test files | 2 |
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
| Production | 0 | none |

## Known Issues & Incidents
- Non-standard directory structure: contains `btms-core-tmp/`, `backend/`, `frontend/`, `permission-module-ui/` sub-directories.
- Root-level `package.json` does not exist; package metadata from `btms-core-tmp/package.json`.
- CARS deployment model in `backend/`.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
