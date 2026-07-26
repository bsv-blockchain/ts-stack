# BASELINE — @bsv/payment-express-middleware

> Verified: 2026-07-26. This is the source baseline; npm remains at the version
> shown until an explicit release is approved.

## Identity

| Field          | Value                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| Package        | `@bsv/payment-express-middleware`                                                    |
| Path           | `packages/middleware/payment-express-middleware`                                     |
| Source version | `2.1.1`                                                                              |
| Criticality    | Tier 1 — payment authorization boundary                                              |
| Runtime        | Node.js 22+                                                                          |
| Formats        | Native ESM + CommonJS + declarations                                                 |
| Protocol       | Legacy authenticated `x-bsv-payment` JSON flow; distinct from BRC-121 `@bsv/402-pay` |

## Verified gates

| Gate                | Result                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| Strict typecheck    | Passing                                                                              |
| Oxlint              | Passing with zero warnings                                                           |
| Prettier check      | Passing                                                                              |
| Deterministic tests | 37 passing in 1 suite; no public-network calls                                       |
| Production coverage | 98.50% lines, 98.13% branches, 100% functions, 97.90% statements                     |
| Coverage floor      | 85% lines/statements/functions; 80% branches                                         |
| Build               | `tsdown` passing                                                                     |
| Artifact            | Exact tarball validated for ESM, CommonJS, declarations, exports, and file allowlist |

## Reliability and security controls

- Authenticated compressed payer identity required
- Strict safe-integer pricing and fail-closed pricing errors
- Bounded, canonical JSON/base64 header parsing
- Atomic BEEF parsing and explicit output-zero value verification
- Atomic transaction-ID replay claims before wallet internalization
- Claims retained after ambiguous wallet errors
- Wallet authorization requires explicit new acceptance
- Stable public errors without internal wallet/store/pricing messages
- Process-local replay default fails closed at fixed capacity
- Shared durable atomic replay storage documented for scaled services
- No hard-coded CORS/CSP restriction

## Remaining program work

- Production deployments must supply and operationally monitor an appropriate
  durable replay store when multiple processes, replicas, or restarts matter.
- Publication, release notes, and rollback evidence are deferred until explicit
  release approval. No npm publication is part of this baseline.
