# BASELINE — @bsv/btms-backend

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/btms-backend` |
| Path | `packages/overlays/btms-backend` |
| npm | private — not published |
| Version | 0.1.0 |
| Criticality | **Tier 3** — non-critical private BTMS overlay backend |
| Reliability Level | **RL1** — 2 test files, coverage command present |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsc -b` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | Compiled JS from tsc |

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
| Production | 3 | @bsv/overlay, @bsv/sdk, mongodb |

## Known Issues & Incidents
- Private package — not published to npm.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
