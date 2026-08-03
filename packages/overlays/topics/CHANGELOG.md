# CHANGELOG for `@bsv/overlay-topics`

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [1.4.0 - 2026-06-30](#140---2026-06-30)

## [Unreleased]

### Added

- `tm_uora_dpp` / `ls_uora_dpp`: admission and lookup for UORA attestation
  anchors (`uora-anchor-v3`), keyed on the `did:key` of the party that made the
  claim. Anchors name their anchoring service in the output and lock to its
  BRC-42 child, so an instance attributes one with nothing configured. The
  anchor signature covers each field behind its own length, so it commits to
  where every field ends; `uora-anchor-v2`, which signed the fields run
  together and so left the subject/type boundary movable by any holder, is not
  admitted. Additive: no existing topic, export, schema or behaviour changes.

### Changed

- Make storage index initialization safely idempotent when concurrent startup
  paths call `ensureIndexes()`, without changing topic IDs, persisted schemas,
  or lookup behavior.

### Deprecated
- (List features that are in the process of being phased out or replaced.)

### Removed
- (Indicate features or capabilities that were taken out of the project.)

### Fixed
- (Document bugs that were fixed since the last release.)

### Security
- (Notify of any improvements related to security vulnerabilities or potential risks.)

---

## [1.6.0] - 2026-07-10

### Added
- **1-satoshi rule in `MandalaTopicManager`:** every Mandala token output and every verified admin-auth output must carry exactly 1 satoshi; `identifyAdmissibleOutputs` now rejects (throws) any transaction violating this. Token value is payload-denominated — satoshis carried by token outputs are dead weight and can be stranded. Ordinary wallet-change P2PKH outputs are unaffected (the admin check applies only after `verifyAdminOutput` admits, since a bare P2PKH also decodes as `MandalaAdmin`).

---

## [1.4.0] - 2026-06-30

### Added
- **`AssetAdminState` and `AdminHistoryEntry` types:** per-asset derived state (`isPaused`, `accessMode`, `blockedIdentities`, `allowedIdentities`, `frozenOutpoints`, `evictedOutpoints`, `lastProcessedHeight/Offset/AdmitSeq`) stored in MongoDB; `AdminHistoryEntry` records the ordered admin action log per asset.
- **`AssetStateReducer` (`foldAction`):** pure reducer folding a `MandalaActionDetails` event into `AssetAdminState`; handles all stablecoin admin kinds (pause/unpause, blockIdentity/unblockIdentity, allowIdentity/unallowIdentity, setAccessMode, freezeOutput/unfreezeOutput, reissue).
- **`rebuildState`:** ordered replay of admin history from MongoDB to reconstruct `AssetAdminState` from scratch; uses `txOrdering` + `admitSeq` for deterministic sort.
- **`MandalaStorageManager` extended:** new MongoDB collections `mandalaAssetStates`, `mandalaAdminHistory`, `mandalaCounters`; new methods `getAssetState`, `putAssetState`, `appendAdminHistory`, `findAdminHistoryByAssetId`, `findStateByAssetId`, `nextAdmitSeq`; `findByAssetId` now filters evicted outpoints.
- **New lookup queries in `ls_mandala`:** `assetStateAssetId` returns the current `AssetAdminState` for a given asset; `adminHistoryAssetId` returns the ordered admin action log.
- **`MandalaTopicManagerDeps.stateStore`:** required field (breaking for existing `MandalaTopicManager` instantiation); injects a `MandalaStorageManager` so the topic manager can enforce derived admin state.
- **Admin control gate in `MandalaTopicManager`:** on each admitted transaction, verifies admin outputs against `stateStore`; blocks token admission when the asset is paused, the sender/recipient is blocked (denylist mode) or not allowed (allowlist mode), or a referenced output is frozen; folds admitted admin actions into `AssetAdminState` via `foldAction`.

### Changed
- **`admissionMode` changed from `'locking-script'` to `'whole-tx'`:** `MandalaTopicManager.identifyAdmissibleOutputs` now receives the full transaction context needed for admin-output verification. **This is a behavioral change** — consumers relying on locking-script-only admission should review their upgrade path; see breaking-change note in the [1.4.0 release notes](#breaking-change-admissionmode).

### Note: breaking-change admissionMode
`admissionMode` switching from `'locking-script'` to `'whole-tx'` means the overlay engine will call `identifyAdmissibleOutputs` with the full transaction rather than individual output scripts. This enables admin-output verification but changes the call contract. Callers that constructed `MandalaTopicManager` against the previous signature or tested with locking-script stubs will need to update. The project maintainers have assessed this as a **minor** bump because `MandalaTopicManager` was not previously published as a stable API; however, if you shipped 1.3.x consumers, consider treating this as a **major** bump at your discretion.

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
