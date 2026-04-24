# BASELINE — @bsv/authsocket

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/authsocket` |
| Path | `packages/messaging/authsocket` |
| npm | [@bsv/authsocket](https://www.npmjs.com/package/@bsv/authsocket) |
| Version | 2.0.1 |
| Criticality | **Tier 2** — authenticated WebSocket server library; failure isolates to real-time messaging domain |
| Reliability Level | **RL1** — builds, only 1 test file, coverage tooling present |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `npm run build:ts` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | Compiled TypeScript output |

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
| Production | 2 | @bsv/sdk, socket.io |

## Known Issues & Incidents
None recorded at migration time.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
