# CHANGELOG for `@bsv/templates`

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [1.8.0 - 2026-06-30](#180---2026-06-30)
- [1.0.0 - YYYY-MM-DD](#100---yyyy-mm-dd)

## [Unreleased]

### 2.0.0 candidate — BRC-162 (breaking)

### Removed

- `MandalaToken`, `MandalaAdmin` and `ADMIN_PROTOCOL`, with their types
  (`MandalaTokenDecoded`, `MandalaAdminDecoded`, `MandalaActionDetails`,
  `MandalaActionKind`, `MandalaAdminLockParams`, `MandalaAdminUnlockParams` and
  `AssetMetadata`). Mandala tokens now use the BRC-162 binary layout, which is
  not wire-compatible with the removed BRC-92 scripts.
- The `mandala-signing.ts` subpath.
- `encodeScriptNum`, `encodeAssetId` and `decodeAssetId` from the
  `mandala-encoding.ts` subpath, which keeps `createMinimallyEncodedScriptChunk`,
  `decodeScriptNum` and `decodeScriptNumChunk`.

### Added

- `Bsv21Binary`, a [BRC-162](https://brc.dev/162) (BSV-21 binary) token-output
  template with canonical pushes: `lock`, `lockBRC29`, `unlock` and `decode`.
  Amounts are `bigint` (0 to 2^64 - 1) and every value has exactly one accepted
  encoding; a token-shaped script that is not canonical throws
  `Bsv21BinaryError`. Companion exports: `Bsv21BinaryDecoded`, `Bsv21Role`,
  `BSV21_MAX_AMOUNT`, `encodeAmountChunk`, `decodeAmountChunk`,
  `tokenIdToString`, `tokenIdFromString` and `isTokenShaped`.
- A strict, dependency-free DAG-CBOR subset for token payloads:
  `encodeStrictCbor`, `decodeStrictCbor`, `tryDecodeStrictCbor`,
  `StrictCborError`, `StrictCborValue`, `StrictCborMap`,
  `STRICT_CBOR_MAX_BYTES` and `STRICT_CBOR_MAX_DEPTH`. Floats, tags, negative
  integers, arrays, unsorted keys, non-minimal headers, trailing bytes and
  nesting deeper than 4 are refused, and so is a `number[]` input with an entry
  outside 0..255 (never wrapped to a byte). Each refusal throws a fixed
  message; the package-local `test/vectors/brc162.json` pins every message and
  the order the checks run in, for ports such as the Go overlay.

### Changed

- Accept `@bsv/sdk` `^3.0.0` as well as `^2.1.6`. The source already declares
  this range, but published 1.10.3 only accepts `^2.1.6`, so a release that
  stages SDK 3 cannot install `@bsv/overlay-topics`, which depends on
  templates. 2.0.0 is the first release to publish the wider range; the other
  script templates are unchanged.

### 1.10.3 candidate — CommonJS SDK interop

### Fixed

- The CommonJS build no longer wraps `@bsv/sdk` default imports as whole
  modules, so `require('@bsv/templates')` consumers can construct scripts again
  instead of failing with `LockingScript.default is not a constructor`
  ([#571](https://github.com/bsv-blockchain/ts-stack/issues/571)). SDK classes
  are now imported by name from the SDK barrels; the ESM build and browser
  bundle size are unchanged.

### 1.10.2 candidate — signing-context and template hardening

### Added

- `R1K1Wallet`, a static Runar contract template with a salted P-256 hardware
  signing path and an independent secp256k1 recovery path.

### Changed

- Point contributors and AI agents to the canonical stack-level contribution
  and quality policy without changing template behavior.
- Consolidate MultiPushDrop script-chunk assembly without changing the
  generated locking script.
- Replace externally generated DSTAS test scripts with first-party synthetic
  structural fixtures; production decoding behavior is unchanged.

### Deprecated

- (List features that are in the process of being phased out or replaced.)

### Removed

- (Indicate features or capabilities that were taken out of the project.)

### Fixed

- (Document bugs that were fixed since the last release.)

### Security

- Validate and snapshot the complete signing context before requesting a
  wallet signature, including source outpoint, satoshis, locking script,
  sequence, scope, and any supplied source transaction.
- Require `MultiPushDrop` to match its complete canonical script and cap it at
  120 distinct compressed locking keys; bind `P2MSKH` signatures to the exact
  ordered key commitment and threshold.
- Reject non-positive or non-safe-integer Mandala amounts and harden Mandala,
  R1K1Wallet, OpReturn, DSTAS, STAS, and BSV-21 script and signature inputs
  against malformed, ambiguous, or mutation-backed values.

---

## [1.8.0] - 2026-06-30

### Added

- **Stablecoin admin action kinds in `MandalaActionKind`:** new values `pause`, `unpause`, `blockIdentity`, `unblockIdentity`, `allowIdentity`, `unallowIdentity`, `setAccessMode`, `freezeOutput`, `unfreezeOutput`, `reissue` for full stablecoin lifecycle control.
- **Extended `MandalaActionDetails`:** new optional fields `identityKey` (hex string), `outpoint` (string, `"<txid>.<vout>"`), `recipient` (hex string), `mode` (`'denylist' | 'allowlist'`), and `bankRef` (string) to carry per-action parameters without altering existing canonicalize/commitment logic.
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
