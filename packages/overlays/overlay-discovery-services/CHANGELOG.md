# CHANGELOG for `@bsv/overlay-discovery-services`

## 2.2.6 (unreleased)

- Refresh packed first-party dependency ranges for the next wallet interoperability release; no independent API migration.

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [1.6.1 - 2026-02-05](#161---2026-02-05)

## [Unreleased]

- Updates the packed workspace dependency candidate for the additive overlay persistence contract. Runtime behavior and defaults are unchanged; no consumer migration is required.
- Advances the packed overlay dependency candidate for BASM validation hardening.
  Package runtime behavior is unchanged; no consumer migration is required.

### Added

- Support `ttn` WalletAdvertiser instances with chain-isolated TerraTestNet
  lookup routing and TTN wallet services.

### Changed

- Preserve the historical plain `Error` contract for malformed lookup queries
  while validating every optional topics-array element.
- Share SHIP/SLAP admittance logging without changing emitted messages.
- Clarify that `WalletAdvertiser.findAllAdvertisements()` reconciles only the
  current wallet identity's authenticated advertisements, while SHIP/SLAP
  lookup services discover other identities.
- Mark the retained public `WalletAdvertiser.privateKey` property as a
  compatibility-only root secret that must never cross a trust boundary.

### Deprecated

- (List features that are in the process of being phased out or replaced.)

### Removed

- (Indicate features or capabilities that were taken out of the project.)

### Fixed

- Make a zero lookup limit return zero rows instead of MongoDB's special
  unbounded result, and document the 1,000-row result ceiling.

### Security

- Reject punycode host labels explicitly instead of relying on Node's evolving
  URL parser validation for advertisable transport endpoints.
- Authenticate lookup-returned and revoked advertisements against their exact
  canonical script, owner identity, metadata, one-satoshi output, transaction,
  and outpoint before wallet signing. Bind requested action inputs and outputs
  through the final wallet-signed transaction.
- Require canonical bounded PushDrop advertisements and revalidate lookup
  admission callbacks before indexing them.
- Require accessor-free allowlisted lookup queries, bounded strings and arrays,
  real compressed public keys, exact booleans and sort order, integer
  pagination, and a maximum of 1,000 returned records.
- Reject credentialed, fragmented, oversized, or ambiguous transport and JS8
  advertisement URIs.

---

## [1.6.1] - 2026-02-05

### Changed

- Updated dependencies

---
