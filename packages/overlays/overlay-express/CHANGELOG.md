# CHANGELOG for `@bsv/overlay-express`

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [2.4.1](#241-2026-06-27)
- [2.3.0](#230-2026-05-28)
- [0.7.11](#0711-2025-08-13)

## [Unreleased]

### Added
- Added `configureEdgePolicy` for public/allowlisted browser access, bounded
  JSON and binary bodies, concurrency, Node HTTP timeouts, and configurable
  CSP/browser response headers.

### Changed
- Public protocol endpoints now allow credential-free cross-origin browser
  calls by default. Operators can opt into exact origins or disable
  Origin-bearing calls.
- Verbose request logging records redacted headers and body size/type metadata
  instead of request bodies.
- Ship the Express declaration dependency required to typecheck the packed
  server API in a clean TypeScript consumer.

### Deprecated
- (List features that are in the process of being phased out or replaced.)

### Removed
- (Indicate features or capabilities that were taken out of the project.)

### Fixed
- Health and route failures no longer return internal exception messages.

### Security
- Added body, concurrency, connection-timeout, parser-error, and browser-header
  baselines to every route.
- Administrative Bearer tokens are compared in constant time.
- Janitor health probes now reject HTTP, redirects, credentials,
  query/fragment components, non-standard ports, and private or special IP
  literals unless the local-development override is explicitly enabled.

---

## [2.4.1] - 2026-06-27

### Added
- Added Arcade-first transaction propagation and proof lookup, with standard Arc
  broadcast as fallback when both providers are configured.
- Added go-chaintracks-compatible Chaintracks configuration for header lookup and
  BASM reorg SSE; Arcade-mounted Chaintracks defaults to `/chaintracks/v2`.
- Added active `OverlayMonitor` maintenance actions for BASM sync, unproven
  refresh-before-evict, and janitor runs.
- Added admin endpoints for proof refresh and unproven transaction maintenance.

### Changed
- Provider callbacks now classify terminal invalid and double-spend outcomes so
  rejected transactions can be evicted from admitted overlay state.
- Production overlay-server wiring now defaults to strict broadcast admission
  (`throwOnBroadcastFailure=true`) unless explicitly overridden.

---

## [2.3.0] - 2026-05-28

### Added
- Added `OverlayMonitor`, a reusable worker for probing Overlay Express `/lookup`
  responses and reporting BEEF proof-shape bloat.

### Fixed
- ARC broadcasts now include an explicit `/arc-ingest` callback URL, with optional
  callback-token validation for deployments that configure one.

---

## [0.7.11] - 2025-08-13

### Added
- Healthcheck endpoint

---

### Template for New Releases:

Replace `X.X.X` with the new version number and `YYYY-MM-DD` with the release date:

```
## [X.X.X] - YYYY-MM-DD

### Added
- 

### Changed
- 

### Deprecated
- 

### Removed
- 

### Fixed
- 

### Security
- 
```

Use this template as the starting point for each new version. Always update the "Unreleased" section with changes as they're implemented, and then move them under the new version header when that version is released.
