# CHANGELOG

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [1.0.0 - YYYY-MM-DD](#100---yyyy-mm-dd)

## [Unreleased]

### Added

- Optional typed decoder for the two-layer JSON wire format. New `decodeMessage()` / `tryDecodeMessage()` helpers and topic payload interfaces (`MessageEnvelope`, `BlockMessage`, `SubtreeMessage`, `RejectedTxMessage`, `NodeStatusMessage`, `FeePolicy`). Set `decodeMessages: true` on the listener to receive a typed `DecodedMessage` instead of raw `Uint8Array`. Backward compatible (defaults to off).

### Changed

- Refresh the compatible libp2p transport, discovery, identification, DHT,
  peer-ID, ping, and private-network maintenance releases.

### Deprecated

- (List features that are in the process of being phased out or replaced.)

### Removed

- (Indicate features or capabilities that were taken out of the project.)

### Fixed

- (Document bugs that were fixed since the last release.)

### Security

- Bound and structurally validate decoded GossipSub envelopes and payloads,
  reject prototype-sensitive/deep JSON and malformed PNET values, and clarify
  that the published mainnet PNET value and relayed topic data do not
  authenticate publishers or blockchain claims.
- Honor `usePrivateDHT: false` by omitting the DHT service instead of exposing
  it despite the caller's configuration.
- Snapshot and strictly validate listener callbacks, topics, addresses, and
  runtime controls; serialize concurrent lifecycle transitions and completely
  clean up failed starts before allowing a retry.
- Replace the placeholder subtree hash with the canonical Bitcoin Merkle root,
  preserve exact unsigned 64-bit values, and reject oversized, duplicate,
  truncated, trailing, aggregate-inconsistent, conflict-inconsistent, or
  root-forged subtree encodings before committing decoded state.

---

## [1.0.0] - YYYY-MM-DD

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
