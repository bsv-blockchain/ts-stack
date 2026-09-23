# CHANGELOG

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [1.0.1](#101---2024-08-05)
- [1.0.0](#030---2024-07-22)
- [0.3.0](#020)

## [Unreleased]

### Added
- (Include new features or significant user-visible enhancements here.)

### Changed
- Fix the CommonJS build's `@bsv/sdk` default-import interop so P2P
  signature helpers construct SDK keys and signatures instead of failing with
  `.default is not a constructor`.
- Ship the Express declaration dependency needed by strict TypeScript
  consumers of the Paymail router API.

### Deprecated
- (List features that are in the process of being phased out or replaced.)

### Removed
- (Indicate features or capabilities that were taken out of the project.)

### Fixed
- (Document bugs that were fixed since the last release.)

### Security
- Harden Paymail discovery and capability requests against private-network
  pivots, DNS rebinding, redirects, unbounded or slow response bodies, unsafe
  endpoints, unrelated DoH answer owners, malformed capability value graphs,
  and unbounded capability caches.
- Bind PKI, public-key ownership, payment destinations, and transaction
  acknowledgements to the exact request, while preserving raw, BRC-62 BEEF,
  and BRC-95 Atomic BEEF compatibility.
- Make inbound routing fail closed for malformed identities, sender-validation
  configuration drift, invalid financial outputs, malformed JSON,
  non-canonical signatures/keys, handler mutation, and unrelated handler txids.
- Snapshot mounted routes and discovery configuration at construction, reject
  duplicate capability codes, and copy capability metadata before deriving its
  identifier so later local mutation cannot rewrite advertised authority.
- Require exact ordinal destination counts and strict negotiation booleans,
  restrict public-profile URLs away from literal/local hosts, and harden the
  private server example's sender/reference/replay checks.
- Document that legacy P2P signatures cover only a transaction ID, that
  Transaction Negotiation v1 is unauthenticated input, and that the package's
  historical reuse of BRFC `6745385c3fc0` is not the timestamped Basic Address
  Resolution assurance defined by the upstream specification.

---

## [1.0.1] - 2024-08-05

### Fixed
- Allow 'note' parameter in paymail responses to be null as well as '' and undefined within Joi.

---

## [1.0.0] - 2024-07-22

### Added
- (Include new features or significant user-visible enhancements here.)

### Changed
- Paymail signatures in both Client and Server modules - such that it conforms to existing paymail implementations. They use BS< over the txid not just the txid itself as the msg.
ts-paymail previously used a compact signature over sha256(txid)
go-paymail implementation uses a compact signature over sha256d(Bitcoin Signed Message:\n${txid})
ts-paymail will now conform to go-paymail as this is in line with original documentation hosted by a third party at paymail's launch.
Few people enforce these signatures so no one has noticed until now.

---

## [0.3.0] - YYYY-MM-DD

### Added
- Initial release

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
