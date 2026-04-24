# BASELINE — @bsv/messagebox-services

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/messagebox-services` |
| Path | `packages/messaging/messagebox-services` |
| npm | private — not published |
| Version | 1.0.0 |
| Criticality | **Tier 2** — private CARS-deployed messaging service; failure isolates to message delivery domain |
| Reliability Level | **RL0** — no test files found at root; delegated to backend sub-project |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `cars build 1` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | CARS deployment artifact |

## Tests
| Field | Value |
|-------|-------|
| Test command | `npm --prefix backend run test` |
| Test files | 0 (root); backend tests delegated to `backend/` sub-project |
| Coverage command | `npm --prefix backend run test:coverage` |
| Coverage | Not yet captured as baseline |
| Known flaky | None identified |

## Lint
| Field | Value |
|-------|-------|
| Linter | — |
| Lint command | — |

## Dependencies
| Type | Count | Packages |
|------|-------|---------|
| Production | 0 | none (backend manages its own dependencies) |

## Known Issues & Incidents
- Private package — not published to npm.
- CARS deployment model; not a conventional npm package.
- No lint configured at root level.
- Tests delegated to `backend/` sub-project via `--prefix` flag.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
