# BASELINE — @bsv/messagebox-server

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/messagebox-server` |
| Path | `packages/messaging/message-box-server` |
| npm | private — not published |
| Version | 1.1.5 |
| Criticality | **Tier 2** — private messaging service; failure isolates to message delivery domain |
| Reliability Level | **RL1** — builds, 3 test files, coverage tooling present but coverage unknown |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsc` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | Compiled JS (ESM via tsc) |

## Tests
| Field | Value |
|-------|-------|
| Test command | `node --experimental-vm-modules node_modules/jest/bin/jest.js --config=jest.config.mjs` |
| Test files | 3 |
| Coverage command | `node --experimental-vm-modules node_modules/jest/bin/jest.js --config=jest.config.mjs --coverage --coverageReporters=text --coverageReporters=html` |
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
| Production | 16 | @bsv/auth-express-middleware, @bsv/authsocket, @bsv/payment-express-middleware, @bsv/sdk, @bsv/wallet-toolbox, body-parser, dotenv, express, firebase-admin, knex, mongodb, mysql2, prettyjson, swagger-jsdoc, swagger-ui-express, web-push |

## Known Issues & Incidents
- Private package — not published to npm.
- Service, not a library; requires database and external dependencies at runtime.
- Uses `--experimental-vm-modules` flag for Jest ESM support.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
