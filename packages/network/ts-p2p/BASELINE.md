# BASELINE — @bsv/teranode-listener

> Captured: 2026-04-24. Reflects state at time of ts-stack migration.

## Identity
| Field | Value |
|-------|-------|
| Package | `@bsv/teranode-listener` |
| Path | `packages/network/ts-p2p` |
| npm | [@bsv/teranode-listener](https://www.npmjs.com/package/@bsv/teranode-listener) |
| Version | 1.0.3 |
| Criticality | **Tier 2** — P2P network listener; failure isolates to peer-to-peer/Teranode connectivity |
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
| Production | 14 | libp2p, @libp2p/bootstrap, @libp2p/kad-dht, @libp2p/pnet, @libp2p/tcp, @libp2p/crypto, @chainsafe/libp2p-noise, @chainsafe/libp2p-yamux, @chainsafe/libp2p-gossipsub, @libp2p/pubsub-peer-discovery, @libp2p/identify, @libp2p/ping, @multiformats/multiaddr, @libp2p/peer-id |

## Known Issues & Incidents
- No tests configured.
- No lint configured.
- Heavy libp2p dependency tree — supply chain review recommended.

## Migration Gate Checklist (MBGA §13.3)
- [x] BASELINE.md captured
- [ ] Conformance runner vectors passing
- [ ] Contract tests green
- [ ] Publishing rehearsed (npm dry-run)
- [ ] Rollback documented
- [ ] 60-day deprecation notice in source repo
