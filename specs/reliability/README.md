# Reliability Registry

Centralized reliability records for all Tier 0/1 repos tracked by the MBGA plan.

> **Why here, not in the source repos?**  
> Phase 5 consolidates source repos into ts-stack. Keeping docs here avoids a double-touch (add now, move on consolidation). When a repo is consolidated, its reliability doc moves with it into `packages/<domain>/`.
>
> Source repos get a short redirect in their README pointing here — see Phase 0 end-of-day task.

## Registry

| Repo | Domain | Tier | Current RL | Target RL | File |
|------|--------|------|-----------|-----------|------|
| ts-sdk | SDK | 0 | RL2 | RL5 | [ts-sdk.md](./ts-sdk.md) |
| go-sdk | SDK | 0 | RL2 | RL5 | [go-sdk.md](./go-sdk.md) |
| wallet-toolbox | Wallet | 1 | RL2 | RL4 | [wallet-toolbox.md](./wallet-toolbox.md) |
| overlay-express | Overlay | 1 | RL2 | RL4 | [overlay-express.md](./overlay-express.md) |
| message-box-server | Messaging | 1 | RL1 | RL4 | [message-box-server.md](./message-box-server.md) |
| arc | Broadcast | 1 | RL3 | RL4 | [arc.md](./arc.md) |

## RL rubric (MBGA §4.1)

| Level | Gate |
|-------|------|
| RL0 | No baseline, no CI, may not build |
| RL1 | Clean build, CI unit tests, owner named, README |
| RL2 | Meaningful unit tests, coverage threshold, dep audit in CI |
| RL3 | Public APIs have executable specs, conformance vectors, breaking-change policy |
| RL4 | healthz/readyz, structured logs, metrics, traces, runbook, SLOs, alerts |
| RL5 | Fuzz/property tests, threat model, tracked security findings, green interop matrix |

## Notable gaps (2026-04-27)

- **message-box-server** is RL1: no CI test workflow on push/PR (only a manual Docker ECR publish). Most urgent gap.
- No repo has a formal threat model or SBOM generation.
- No repo has fuzz/property tests (RL5 requirement for Tier 0).
- arc is the most mature at RL3: OTel tracing, Prometheus metrics, E2E Docker suite, OpenAPI + protobuf contracts.
