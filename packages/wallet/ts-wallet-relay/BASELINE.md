# BASELINE — @bsv/wallet-relay

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/wallet-relay` |
| Path | `packages/wallet/ts-wallet-relay` |
| npm | [@bsv/wallet-relay](https://www.npmjs.com/package/@bsv/wallet-relay) |
| Version | 0.1.0 |
| Criticality | **Tier 3** — non-critical wallet relay; failure isolated |
| Reliability Level | **RL0** — no test files found |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsup` |
| Build status | ✅ Passing (assumed — not yet verified in ts-stack CI) |
| Outputs | tsup bundled output |

## Tests
| Field | Value |
|-------|-------|
| Test command | `jest --config jest.config.cjs` |
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
| Production | 0 | none |

## Known Issues & Incidents
- No test files found despite test command configured.
- No lint configured.
- No production dependencies — may be incomplete or a scaffolding package.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
