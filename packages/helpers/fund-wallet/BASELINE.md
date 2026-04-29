# BASELINE — @bsv/fund-wallet

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/fund-wallet` |
| Path | `packages/helpers/fund-wallet` |
| npm | *(private — CLI tool, not published as library)* |
| Version | 1.3.1 |
| Criticality | **Tier 3** — developer CLI utility; funds a Metanet wallet with BSV |
| Reliability Level | **RL0** — no tests configured, build not yet verified in ts-stack CI |
| Owner | @sirdeggen |
| Backup owner | — |

## Build
| Field | Value |
|-------|-------|
| Build command | `tsc` |
| Build status | Unknown (not yet verified in ts-stack CI) |
| Outputs | Compiled JS from tsc (`dist/`) |

## Tests
| Field | Value |
|-------|-------|
| Test command | `echo "Error: no test specified" && exit 1` |
| Test files | 0 |
| Coverage command | — |
| Coverage | None |
| Known flaky | None identified |

## Lint
| Field | Value |
|-------|-------|
| Linter | — |
| Lint command | — |

## Dependencies
| Type | Count | Packages |
|------|-------|---------|
| Production | 6 | @bsv/sdk, @bsv/wallet-toolbox, chalk, crypto, dotenv, readline |

## Known Issues & Incidents
- No tests configured.
- No lint tooling configured.
- Single source file (`index.ts`) at package root (no `src/` directory).

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
