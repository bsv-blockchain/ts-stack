# BASELINE — wallet-infra

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `wallet-infra` |
| Path | `packages/wallet/wallet-infra` |
| npm | [wallet-infra](https://www.npmjs.com/package/wallet-infra) |
| Version | 2.0.4 |
| Criticality | **Tier 3** — non-critical infrastructure helpers; failure isolated |
| Reliability Level | **RL0** — no tests, no test command configured |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsc --build` |
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
| Linter | prettier |
| Lint command | `prettier --write 'src/**/*.ts' --log-level silent` |

## Dependencies
| Type | Count | Packages |
|------|-------|---------|
| Production | 8 | @bsv/payment-express-middleware, @bsv/sdk, @bsv/wallet-toolbox, body-parser, dotenv, express, knex, mysql2 |

## Known Issues & Incidents
- No tests configured.
- Uses prettier rather than ts-standard (org standard).
- Unprefixed package name (`wallet-infra`) — not in BSV org namespace.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
