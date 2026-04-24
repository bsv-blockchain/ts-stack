# BASELINE — @bsv/project (uhrp-services)

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/project` |
| Path | `packages/overlays/uhrp-services` |
| npm | private — not published |
| Version | 1.0.0 |
| Criticality | **Tier 3** — non-critical private UHRP overlay service |
| Reliability Level | **RL0** — no tests, no lint, CARS deployment |
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
| Test command | — |
| Test files | 0 |
| Coverage command | — |
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
- CARS deployment model; no conventional source in root.
- No tests or lint configured.
- Package name `@bsv/project` is a placeholder — does not reflect actual service name.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
