# CHANGELOG for `@bsv/overlay-topics`

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [1.4.0 - 2026-06-30](#140---2026-06-30)

## [Unreleased]

### Removed (2.0.0 candidate)

- Remove `tm_did` / `ls_did`, `DIDTopicManager`, `createDIDLookupService`,
  `DIDRecord` and `DIDQuery`. Public certificate discovery uses the existing
  identity overlay; deterministic identity-key DID resolution uses `@bsv/did`.
  Hosts are discovery providers, not issuer trust anchors. Operators must
  explicitly select hosted services and reconcile stale advertisements; no
  replacement service is installed and no database or on-chain data is deleted.
  See [migration guidance](../../../docs/guides/identity-did-vc-migration.md).

- Replace the `tm_mandala` / `ls_mandala` admission, lookup and storage API
  with Mandala on BRC-162 (BSV-21 binary, authority supply). The old
  `MandalaToken` / `MandalaAdmin` templates are gone from `@bsv/templates`
  2.0.0, so the old wire format is no longer admitted. Migration:
  - `MandalaTopicManager` no longer takes `adminWallet` or `adminProtocolID`
    (admin outputs lock to the issuer, not to a derived admin key) and no longer
    needs `stateStore.isAdminOutpoint`: admin continuity is an admitted
    authority input. It now requires `trustedIssuers` (a non-empty list of
    compressed lowercase public keys; construction throws otherwise) and
    `engineOutputs` (the owner-index repair reads), and accepts an optional
    `membership` provider, `membershipExempt` keys and an `onOwnerRepair`
    log. `stateStore` is a `MandalaStateStore`; pass the same
    `MandalaStorageManager` to admission and lookup.
  - Refusals are a typed `MandalaReject { code, reason }` with one of the
    `ERR_*` codes, not a free-text `Error`. Registry membership is an explicit
    `MembershipProvider` dependency, answered as `ERR_MEMBERSHIP`. The reason
    strings change with the catalog (`Reasons`): the no-linkage refusal
    `output N: MandalaToken-decodable output with no verified linkage` is now
    `output N: token output with no verified linkage`, so do not match on the
    old text.
  - The v2 linkage payload is replaced by the v3 envelope
    `{ inputs, outputs, admin, deploySig }`. The `MandalaLinkagePayload` type is
    removed; use `MandalaEnvelope`, `encodeEnvelope` and `decodeEnvelope`.
    Admin details are strict DAG-CBOR (lowercase hex), committed by the
    authority output, and the `register` action is replaced by a deploy at
    output 0 with a `deploySig`.
  - `foldAction`, `defaultAssetState`, `AssetAdminState` and `FoldContext`
    change with the schema: `assetId` is now `tokenId` (`<txid>_0`),
    `issuerIdentityKey` and `FoldContext.issuer` are removed (the trusted set is
    configuration), `feeRatePerKb` is added, `defaultAssetState` takes
    `(tokenId, feeRatePerKb?)` and `foldAction` folds an `AdminDetails`.
    `MandalaTokenRecord.assetId` is now `tokenId`.
  - Every Mandala output is read by the layer-A BRC-162 ledger
    (`classifyOutputs`, `buildLedger`), which refuses a token-shaped output whose
    encoding is not canonical.

- Persisted-schema change (spec section 6.6), a clean break with no data
  migration. New collections: `mandalaOwners` (the append-only owner journal)
  and `mandalaAuthorities` (unspent authority outputs). Changed shapes:
  `mandalaTokens`, `mandalaMetadata`, `mandalaAssetStates` and
  `mandalaAdminHistory` are keyed by `tokenId` (`<txid>_0`) instead of
  `assetId`, metadata holds the decoded deploy payload (`sym`, `dec`, `label`,
  `feeRatePerKb`), the asset state drops `issuerIdentityKey` and gains
  `feeRatePerKb`, and an admin history row stores `kind`, `detailsHex`,
  `commitment` and `delta` instead of `actionDetails`. `mandalaLinkageRecords`, `mandalaBalances` and
  `mandalaCounters` keep their shapes. Rows written by 1.x are not valid 2.0.0
  rows and are not read or converted: start Mandala on a new database with new
  deploys. Existing on-chain outputs are not spent or deleted.

- Accept SDK-compatible 200-row UHRP lookup pages with deterministic outpoint ordering and unchanged selector/signature validation.

- Updates the packed workspace dependency candidate for the additive overlay persistence contract. Runtime behavior and defaults are unchanged; no consumer migration is required.
- Advances the packed overlay dependency candidate for BASM validation hardening.
  Package runtime behavior is unchanged; no consumer migration is required.

### Added

- `tm_mandala_registry` / `ls_mandala_registry`: the Mandala identity registry
  as its own authority-only BRC-162 token (`RegistryTopicManager`,
  `RegistryLookupService`, `createRegistryLookupService`, `RegistryStorage`,
  `registryMembership`).
- Mandala on BRC-162 adds to the package entry point `classifyOutputs`,
  `classifyAdmittedInputs`, `buildLedger` and `specVerdicts` (layer A),
  `MandalaReject`, `isMandalaReject` and `Reasons`, `reconcileOwnerIndex`,
  `encodeEnvelope` and `decodeEnvelope`, `encodeAdminDetails`,
  `decodeAdminDetails`, `deployMetadata` and `commitmentOf`, `deployDigest` and
  `verifyDeploySig`, `MANDALA_TOPIC`, and their types. The manager journals every
  admitted owner before admittance, repairs a missing owner-index row inline,
  and the lookup service carries the eviction API (`outputEvicted`,
  `purgeAndRefold`, `restoreInputRow`).
- Mandala on BRC-162 hardening (2.0.0 candidate):
  - Every authority coin a transaction spends must be owned by a trusted
    issuer, or it is refused as `ERR_UNTRUSTED` with the reason
    `input N: authority owner K is not a trusted issuer`. Removing a key from
    `trustedIssuers` therefore takes away the authority it holds; rotate a key
    by moving its authority coins first.
  - An inline owner-row repair that raced a spend of the same coin (another
    engine process) is taken back and answered `ERR_UNAVAILABLE`, instead of
    leaving a phantom row and balance credit. `MandalaStateStore` gains
    `takeToken`, `takeAuthority` and `adjustBalance` for that undo.
  - A failed store write is `... could not be written; retry`
    (`Reasons.storeWriteUnavailable`), not `... could not be read; retry`, and
    every infra reject keeps the store's or provider's error as its `cause`.
  - `membershipExempt` keys are validated at construction like
    `trustedIssuers`.
  - The lookup writes the records nothing can rebuild (the committed action,
    the deploy metadata and first state, the linkage record) before the owner
    index, and attempts every write even when one fails, rethrowing the first
    fault. A freeze's history row records the frozen coin's `frozenAmount` and
    `frozenOwner` (additive optional fields), and refolds use them; a freeze of
    another token's coin freezes at 0. `tokenIdsWithHistory()` (lookup and
    storage) lists the tokens the overlay must refold at boot; the README lists
    the overlay's boot-refold and eviction duties.
- Version 1.9.0 (1.x history): `foldAction`, `defaultAssetState` and the
  `AssetAdminState` / `FoldContext` / `FrozenRef` types are exported from the
  package entry point, so consumers can replay Mandala admin history themselves
  (for example to rebuild an asset's state while excluding an evicted
  transaction) with the exact reducer the lookup service uses. The `exports`
  map was unchanged in 1.9.0. 2.0.0 keeps these exports but changes the
  signatures and keys of `foldAction`, `defaultAssetState` and
  `AssetAdminState` (see the Mandala entry under Removed (2.0.0 candidate)
  above).
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
- Replace externally generated DSTAS test scripts with first-party synthetic
  structural fixtures; topic admission behavior is unchanged.

### Deprecated

- (List features that are in the process of being phased out or replaced.)

### Removed

- (Indicate features or capabilities that were taken out of the project.)

### Fixed

- Version 1.7.3 (1.x history; 2.0.0 refuses with a different reason string,
  `output N: token output with no verified linkage`, see the Mandala entry
  under Removed (2.0.0 candidate) above): `tm_mandala`: a
  `MandalaToken`-shaped output with no linkage at its index, a linkage that
  verifies to a different key than the output is locked to, or a linkage the
  verifier cannot open now REJECTS the whole transaction with
  `output N: MandalaToken-decodable output with no verified linkage` (wire
  contract §6 as of 1.7.3, byte-identical to the Go engine then). Previously
  `verifyFtOutputs` skipped such an output and `conservationHolds` summed only
  the admitted subset, so a transaction could carry an extra token output of
  any value, still have its siblings admitted, receive the admission signature
  and be broadcast — a phantom coin mined inside an attested transaction that an
  offline verifier stopping at "this txid was admitted" would credit.

- Version 1.7.2 aligns `tm_uora_dpp` with the versioned UORA v3 format: compressed locking keys, exact drop tails, and printable UTF-8 fields. Valid anchors retain their bytes and admission result. The shared reference fixture covers key and tail validation. Coordinate reader upgrades and audit previously indexed nonconforming outputs before rebuilding the topic; this change does not claim a complete inventory of historical anchors.

### Security

- Reject non-canonical or unsafe BTMS amount fields in topic admission and
  lookup indexing, and fail closed if a per-asset aggregate leaves JavaScript's
  exact-integer range. Valid canonical amounts and topic identifiers are
  unchanged.

- Mandala hardening from 1.8.0 and 1.8.4, written for the 1.x admission design
  that 2.0.0 replaces (see the Mandala entries under Removed (2.0.0 candidate)
  above). These bullets are 1.x history, not 2.0.0 behavior or requirements: in
  particular the admin-history verifier that custom adapters had to implement
  no longer exists, because admin continuity is now an admitted authority
  input.
  - Version 1.8.0 requires admitted per-asset admin history for every
    non-genesis Mandala action. The reference storage manager provides the
    verifier; custom adapters must implement it. Registration uses its own
    genesis outpoint.
  - Version 1.8.0: token spends require authoritative stored ownership matching
    the source outpoint, asset and amount. Optional linkage corroborates the
    stored owner and source key. Sender blinding remains supported.
  - Version 1.8.0: reject duplicate or invalid linkage indices and normalize
    sanctions key casing. Valid wire fields and encodings are unchanged.
  - Version 1.8.4: canonicalize Mandala administrative identities and outpoints
    and compare historical policy state case-insensitively, preventing case
    variants from bypassing identity blocks, output freezes, or eviction
    records.
  - Version 1.8.4: make Mandala lookup balance accounting idempotent across
    repeated admission, spend, and eviction callbacks, and reject conflicting
    token metadata for an outpoint that is already indexed.
  - Version 1.8.0: back up and audit historical admin and ownership records
    before replay, and coordinate admission and lookup upgrades. 2.0.0 is a
    clean break with no data migration (see the persisted-schema entry under
    Removed (2.0.0 candidate) above).

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
