# BASELINE — @bsv/message-box-client

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/message-box-client` |
| Path | `packages/messaging/message-box-client` |
| npm | [@bsv/message-box-client](https://www.npmjs.com/package/@bsv/message-box-client) |
| Version | 2.1.1 |
| Criticality | **Tier 2** — client library for peer messaging; failure isolates to message delivery domain |
| Reliability Level | **RL2** — 8 test files, coverage tooling present |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `npm run build:ts && npm run build:umd` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | TypeScript compiled output + UMD bundle |

## Tests
| Field | Value |
|-------|-------|
| Test command | `jest --config=jest.config.ts` |
| Test files | 8 |
| Coverage command | `jest --coverage --coverageReporters=text --coverageReporters=html` |
| Coverage | Not yet captured as baseline |
| Known flaky | None identified |

## Lint
| Field | Value |
|-------|-------|
| Linter | ts-standard |
| Lint command | `ts-standard --fix .` |

## Dependencies
| Type | Count | Packages |
|------|-------|---------|
| Production | 2 | @bsv/authsocket-client, @bsv/sdk |

## Known Issues & Incidents
None recorded at migration time.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
