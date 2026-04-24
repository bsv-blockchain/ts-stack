# BASELINE — @bsv/chaintracks-server

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/chaintracks-server` |
| Path | `packages/network/chaintracks-server` |
| npm | private — not published |
| Version | 1.0.2 |
| Criticality | **Tier 2** — private chain tracking service; failure isolates to network/headers domain |
| Reliability Level | **RL0** — no tests, no lint configured |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsc` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | Compiled JS from tsc |

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
| Production | 4 | @bsv/wallet-toolbox, body-parser, dotenv, express |

## Known Issues & Incidents
- Private package — not published to npm.
- Service, not a library; no tests configured.
- No lint configured.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
