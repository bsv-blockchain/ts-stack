# CHANGELOG for `@bsv/templates`

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [1.8.0 - 2026-06-30](#180---2026-06-30)
- [1.0.0 - YYYY-MM-DD](#100---yyyy-mm-dd)

## [Unreleased]

### Added
- (Include new features or significant user-visible enhancements here.)

### Changed
- (Include changes here.)

### Deprecated
- (List features that are in the process of being phased out or replaced.)

### Removed
- (Indicate features or capabilities that were taken out of the project.)

### Fixed
- (Document bugs that were fixed since the last release.)

### Security
- (Notify of any improvements related to security vulnerabilities or potential risks.)

---

## [1.8.0] - 2026-06-30

### Added
- **Stablecoin admin action kinds in `MandalaActionKind`:** new values `pause`, `unpause`, `blockIdentity`, `unblockIdentity`, `allowIdentity`, `unallowIdentity`, `setAccessMode`, `freeze`, `unfreeze`, `reissue` for full stablecoin lifecycle control.
- **Extended `MandalaActionDetails`:** new optional fields `identityKey` (hex string), `outpoint` (string, `"<txid>.<vout>"`), `recipient` (hex string), `mode` (`'open' | 'allowlist' | 'blocklist'`), and `bankRef` (string) to carry per-action parameters without altering existing canonicalize/commitment logic.
- **`MandalaAdmin` script template:** locking/unlocking script template for admin control outputs; signs over `MandalaActionDetails` payload using BRC-42 key derivation.

### Changed
- **MandalaToken assetId on-chain encoding (breaking on-chain format):** `encodeAssetId`
  now writes the txid in outpoint (internal/reversed, `tx.hash()`) byte order followed
  by the 4-byte little-endian vout, matching how an outpoint appears in a transaction.
  `decodeAssetId` reverses it back, so the `"<txid>.<vout>"` display string is
  unchanged. This lets smart contracts compare a token's embedded assetId directly
  against the genesis transaction's outpoint. Tokens minted under the previous
  (non-reversed) encoding will not decode to the same assetId.

---

## [1.0.0] - YYYY-MM-DD

### Added
- Initial release of the BSV Script Templates Repository.

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