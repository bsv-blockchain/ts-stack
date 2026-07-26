# BASELINE — @bsv/auth-express-middleware

> Verified: 2026-07-26. This is the source baseline; npm remains at the version
> shown until an explicit release is approved.

## Identity

| Field          | Value                                         |
| -------------- | --------------------------------------------- |
| Package        | `@bsv/auth-express-middleware`                |
| Path           | `packages/middleware/auth-express-middleware` |
| Source version | `2.1.2`                                       |
| Criticality    | Tier 1 — service authentication boundary      |
| Runtime        | Node.js 22+                                   |
| Formats        | Native ESM + CommonJS + declarations          |

## Verified gates

| Gate                | Result                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| Strict typecheck    | Passing                                                                              |
| Oxlint              | Passing with zero warnings                                                           |
| Prettier check      | Passing                                                                              |
| Deterministic tests | 96 passing across 5 suites                                                           |
| Production coverage | 93.07% lines, 87.64% branches, 88.88% functions, 92.29% statements                   |
| Coverage floor      | 85% lines/statements/functions; 80% branches                                         |
| Build               | `tsdown` passing                                                                     |
| Artifact            | Exact tarball validated for ESM, CommonJS, declarations, exports, and file allowlist |

## Reliability and security controls

- Strict attacker-controlled handshake/header validation before state allocation
- Bounded request, certificate, verification, and response-signing state
- Configurable pending-request capacity and timeout
- Stable public errors without internal wallet/signing/storage messages
- Metadata-only optional logging; no raw auth headers, signatures,
  certificates, bodies, wallet objects, or peer objects
- Shared `AsyncSessionManager` supported and documented for scaled services
- Deterministic local AuthFetch and certificate integration coverage
- Public handshake path exact-matched; no hard-coded CORS/CSP restriction

## Remaining program work

- Repository-wide conformance/vector work remains tracked in the main stack
  health program.
- Publication, release notes, and rollback evidence are deferred until explicit
  release approval. No npm publication is part of this baseline.
