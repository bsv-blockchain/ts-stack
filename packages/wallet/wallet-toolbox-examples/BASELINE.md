# BASELINE — @bsv/wallet-toolbox-examples

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/wallet-toolbox-examples` |
| Path | `packages/wallet/wallet-toolbox-examples` |
| npm | [@bsv/wallet-toolbox-examples](https://www.npmjs.com/package/@bsv/wallet-toolbox-examples) |
| Version | 1.1.156 |
| Criticality | **Tier 3** — non-critical example code; no production consumers |
| Reliability Level | **RL1** — builds, coverage tooling present, 0 test files |
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
| Test command | `npm run build && jest` |
| Test files | 0 |
| Coverage command | `npm run build && jest --coverage` |
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
| Production | 2 | @bsv/sdk, @bsv/wallet-toolbox |

## Known Issues & Incidents
- Example code only — not intended for production use.
- No test files despite test/coverage commands being configured.
- Uses prettier rather than ts-standard (org standard).

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
