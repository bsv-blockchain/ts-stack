# BASELINE — @bsv/wab-server

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/wab-server` |
| Path | `packages/wallet/wab` |
| npm | private — not published |
| Version | 1.4.1 |
| Criticality | **Tier 3** — non-critical private WAB (Wallet Access Bridge) server |
| Reliability Level | **RL1** — 5 test files, coverage command present, no coverage baseline captured |
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
| Test command | `jest` |
| Test files | 5 |
| Coverage command | `jest --coverage` |
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
| Production | 10 | @bsv/sdk, @bsv/wallet-toolbox, dotenv, express, express-rate-limit, json-stable-stringify, knex, mysql2, sqlite3, twilio |

## Known Issues & Incidents
- Private package — not published to npm.
- Service, not a library.
- No lint configured.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
