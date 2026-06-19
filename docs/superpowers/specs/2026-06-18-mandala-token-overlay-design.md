# Mandala Token Regulated-Transfer Overlay — Design

**Date:** 2026-06-18
**Branch:** `feature/mandala-token-overlay`
**Status:** Approved for implementation planning

## 1. Summary

A regulated fungible-token system built on the BRC-92 Mandala Token Protocol, spanning two
packages:

- **`@bsv/templates`** (`packages/helpers/ts-templates`) — two new script templates:
  `MandalaToken` (FT transfer) and `MandalaAdmin` (authorization-outpoint chain for
  administrative actions).
- **`@bsv/overlay-topics`** (`packages/overlays/topics`) — a `tm_mandala` topic manager and
  `ls_mandala` lookup service that enforce token conservation, verify off-chain
  `revealSpecificKeyLinkage` data, screen both transfer sides against a sanctions list, and
  retain linkage data for the regulatory minimum.

The overlay is treated as highly sensitive infrastructure. Identity-linked balances are an
internal side-effect and are **never** exposed via a public query.

## 2. Background & Key Decisions

- **Token framework:** BRC-92 Mandala Token Protocol (https://bsv.brc.dev/tokens/0092).
  FT-only in this cut — no NFT variant, no arbitrary PushDrop data fields.
- **Linkage method:** `revealSpecificKeyLinkage` — ties the controlling identity key to the
  **specific** `protocolID` + `keyID` used to derive each output's key (connecting receiving
  counterparties to specific keys), not the root-key counterparty version. The SDK defines
  `RevealSpecificKeyLinkageArgs` / `RevealSpecificKeyLinkageResult` in
  `packages/sdk/src/wallet/Wallet.interfaces.ts`. The overlay is the `verifier`; the wallet
  encrypts the linkage to the overlay's public key.
- **Off-chain transport:** linkage data reaches the overlay via the `offChainValues?: number[]`
  parameter already present on `TopicManager.identifyAdmissibleOutputs` and propagated to the
  lookup service through `OutputAdmittedByTopic` / `OutputSpent`.
- **Change outputs:** treated identically to any output — the sender is their own counterparty.
  No special-case branch.
- **Storage:** MongoDB, matching every existing topic in the package (UHRP, Identity, etc.).
- **Sanctions screening:** an injected `ScreeningProvider` interface with an in-memory
  implementation for tests; a real provider (e.g. OFAC feed) injected in production.
- **Naming:** module dir `src/mandala/`, classes `MandalaTopicManager` + `MandalaLookupService`,
  topic `tm_mandala`, service `ls_mandala`.

### 2.1 Linkage Encryption — Store Encrypted-At-Source

The `revealSpecificKeyLinkage` response is **already end-to-end encrypted by the wallet to the
overlay's public key** (`encryptedLinkage` + `encryptedLinkageProof`). The overlay therefore
stores those ciphertext blobs verbatim — no separate encryption layer or `LinkageEncryptor` seam
is needed; data is encrypted at rest by construction.

Decryption happens **per-output, only at the moment of verification**, using the overlay's own
private key (it is the `verifier`):

1. **At admission** — when the output is first created and admitted to the topic.
2. **At spend** — when a later transaction spends that output (re-verify the input's linkage).

Plaintext linkage is never persisted; it exists only transiently during these two verification
windows.

## 3. Component 1 — Script Templates (`@bsv/templates`)

Both classes implement `ScriptTemplate` from `@bsv/sdk`, follow the existing
`MultiPushDrop.ts` / `P2MSKH.ts` patterns (shared `createMinimallyEncodedScriptChunk`,
`verifyTruthy` helpers, `ScriptTemplateUnlock` for unlock), and are exported from `mod.ts`.

### 3.1 `MandalaToken` — FT transfer output

Locking script (FT only, no arbitrary data):

```
<0x21 marker> <assetId> <amount> OP_2DROP OP_DROP
OP_DUP OP_HASH160 <pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
```

- `0x21` is the UTF-8 `!` adoption marker (single-byte push).
- `assetId` = outpoint format (txid + output index) of the registration genesis.
- `amount` = Bitcoin number format.
- Stack cleanup: `OP_2DROP` removes `amount`+`assetId`, `OP_DROP` removes the marker, leaving a
  standard P2PKH lock.
- One satoshi per token output (BRC-92).

Methods:
- `lock(assetId, amount, pubKeyHash)` — raw form.
- `lock` BRC-29 helper — derive the locking public key / hash from a wallet
  (`protocolID`, `keyID`, `counterparty`), mirroring `P2MSKH.addressBRC29`.
- `unlock(wallet, ...)` → `ScriptTemplateUnlock` producing `<sig> <pubkey>` (P2PKH spend).
- `decode(script)` → `{ assetId, amount, pubKeyHash }`; throws on non-Mandala scripts.

### 3.2 `MandalaAdmin` — authorization-outpoint chain

Locking script:

```
<0x21 marker> OP_DROP <boundKey> OP_CHECKSIG
```

- `boundKey` is derived through the wallet, not by raw `deriveChild`:
  `wallet.getPublicKey({ protocolID, keyID, counterparty: 'anyone' })`, where
  `keyID = hash(canonicalize(actionDetails))`. `actionDetails` is an arbitrarily complex JSON
  object describing the admin action (kind, assetId, amount, prior outpoint, etc.).
- **Canonical form:** `actionDetails` is serialized to a deterministic canonical string before
  hashing so any party reproduces the identical `keyID`. Default: **RFC 8785 JSON Canonicalization
  Scheme (JCS)** — strict lexicographic key ordering + canonical scalar encoding. (JSON-LD /
  URDNA2015 is the alternative if a semantic RDF graph is ever needed; JCS is preferred here as it
  canonicalizes arbitrary JSON without requiring an `@context`.) The `keyID` is also the
  `commitment` that anchors the action into the chain.
- Each administrative transaction spends authorization outpoint *n* and creates outpoint *n+1*,
  forming an immutable linked hash chain in the transaction DAG since genesis.

Action kinds:
- `register` — genesis authorization outpoint; establishes the `assetId` basis.
- `issue` / mint — create new FT supply.
- `redeem` — destroy FT supply.
- `recover` — reissue burnt tokens.

Methods:
- `canonicalize(actionDetails)` → canonical string (RFC 8785 JCS).
- `deriveBoundKey(wallet, protocolID, actionDetails)` →
  `{ boundKey, keyID }` via `wallet.getPublicKey({ protocolID, keyID, counterparty: 'anyone' })`
  with `keyID = hash(canonicalize(actionDetails))`.
- `lock(boundKey)`.
- genesis/registration builder.
- `unlock(wallet, protocolID, actionDetails, ...)` → boundKey signature for `OP_CHECKSIG`
  (signs with the same `counterparty: 'anyone'` + derived `keyID`).
- `decode(script)` → `{ boundKey }`; throws on non-admin scripts.

The overlay re-derives `boundKey` from the claimed `actionDetails` (canonicalize → hash → keyID →
`getPublicKey` with `counterparty: 'anyone'`) and checks it matches the on-chain key, binding the
action's JSON to the authorization chain.

## 4. Component 2 — Overlay (`@bsv/overlay-topics`, `src/mandala/`)

File layout mirrors existing topics (UHRP / Identity):

| File | Responsibility |
|------|----------------|
| `types.ts` | `MandalaTokenRecord`, off-chain linkage payload types, `ScreeningProvider` interface |
| `verifyKeyLinkage.ts` | Decrypt (overlay as verifier) + EC point-addition verification of `revealSpecificKeyLinkage` data → controlling identity pubkey per input/output |
| `MandalaTopicManager.ts` | `TopicManager` implementation (admittance + all enforcement) |
| `MandalaLookupService.ts` | `LookupService` implementation (persistence + queries) |
| `MandalaStorageManager.ts` | MongoDB persistence |
| `MandalaTopicDocs.md.ts` / `MandalaLookupDocs.md.ts` | Markdown docs (message-box pattern) |

All exported from `packages/overlays/topics/src/index.ts`.

### 4.1 `verifyKeyLinkage.ts`

Modeled on UHRP's `isTokenSignatureCorrectlyLinked.ts`. Given a `revealSpecificKeyLinkage`
payload (`encryptedLinkage`, `encryptedLinkageProof`, `prover`, `counterparty`, `protocolID`,
`keyID`, `proofType`):

1. Decrypt `encryptedLinkage`/`encryptedLinkageProof` using the overlay's private key — the
   overlay is the `verifier` the wallet encrypted to.
2. Perform elliptic-curve point-addition to confirm which identity public key controls the given
   input or output for that specific `protocolID` + `keyID`.

Independently verifiable; relies on discrete-log hardness. Change outputs use the same path with
the sender as their own counterparty. Plaintext is held only transiently during this call.

### 4.2 `MandalaTopicManager`

`identifyAdmissibleOutputs(beef, previousCoins, offChainValues, mode)`:

1. Parse transaction outputs; classify each as **FT transfer** (`MandalaToken.decode`), **admin**
   (`MandalaAdmin.decode`), or non-topical.
2. Parse `offChainValues` → linkage payload (per input and per output).
3. Verify linkage via `verifyKeyLinkage` (decrypt-then-EC-verify) → controlling identity public
   key for each relevant input/output. This runs for newly-created outputs (admission) **and** for
   the previous coins being spent (re-verify the input linkage at spend time).
4. **Admin outputs:** validate boundKey `OP_CHECKSIG`, that the tx spends the prior authorization
   outpoint, and chain integrity. Re-derive `boundKey` from the declared `actionDetails`
   (`canonicalize` → hash → `keyID` → `getPublicKey({ counterparty: 'anyone' })`) and confirm it
   matches the on-chain key. Issuance/recovery are the authorized supply-changing exceptions.
5. **FT transfers:** enforce conservation — Σ input token amounts == Σ output token amounts per
   `assetId` (except under a valid admin issuance/recovery).
6. **Sanctions screen:** call `ScreeningProvider.isSanctioned` for every derived identity key on
   **both sides** (inputs and outputs). If any party is sanctioned, reject the entire
   transaction (admit nothing).
7. Return `AdmittanceInstructions` (outputs to admit + previous coins to retain).

Also implements `identifyNeededInputs` (anchor token history), `getDocumentation`, `getMetaData`.

### 4.3 `MandalaLookupService`

On `outputAdmittedByTopic` / `outputSpent`, persist via `MandalaStorageManager`:
- token UTXO records (assetId, amount, outpoint, controlling identity key),
- **retained linkage records** — the `encryptedLinkage`/`encryptedLinkageProof` ciphertext stored
  verbatim (encrypted at rest by construction), with `prover`/`protocolID`/`keyID` metadata,
- internal per-identity-key balances (maintained as outputs are admitted/spent).

`lookup(question)` answers **only** by `assetId` and by outpoint. There is deliberately **no**
balance-by-identity-key query exposed.

### 4.4 `MandalaStorageManager` (MongoDB)

Collections:
- `tokens` — current UTXO set for token outputs.
- `linkageRecords` — retained **encrypted** linkage ciphertext + metadata, **no TTL expiry**
  (must persist ≥5 years; deletion is an out-of-band retention-policy action, not an automatic
  index).
- `balances` — internal per-identity-key running balances.

## 5. Injected Dependencies (testable seams)

```ts
interface ScreeningProvider {
  isSanctioned(identityKey: string): Promise<boolean>
}
// InMemoryScreeningProvider — list-backed, used in tests.
```

`ScreeningProvider` is constructor-injected so production wiring swaps in a real sanctioned-parties
feed without code changes.

The topic manager also needs the **overlay's verifier key** (a `WalletInterface` / private key) to
decrypt `revealSpecificKeyLinkage` payloads during verification — injected the same way. In tests
this is a deterministic local wallet acting as the verifier.

## 6. Compliance Model

- Screen both sides of every transfer; reject any transaction touching a sanctioned identity key.
- Retain the (encrypted) linkage data and the derived identity public key for ≥5 years.
- Balances are queryable internally only — never via a public API.
- The overlay's verifier private key is the single key that can decrypt retained linkage — the
  acknowledged honeypot. Protecting it (HSM, access controls, audit logging, rotation, compromise
  migration plan) is operational hardening, tracked in §8.

## 7. Testing

- **ts-templates (jest):** `MandalaToken` lock/unlock/decode roundtrip; `MandalaAdmin`
  boundKey derivation + lock/unlock/decode; conservation arithmetic helpers.
- **topics (jest + `mongodb-memory-server`):** linkage verification with known EC test vectors;
  conservation rejection; admin-chain validation (valid issuance admitted, broken chain rejected);
  both-side sanctions rejection; lookup by assetId/outpoint; confirm no identity-balance query
  path exists.

## 8. Follow-up Obligations (out of scope for this spec)

1. **Verifier-key protection (HARD):** the overlay's decryption key is the honeypot. Harden with
   HSM/KMS custody, strict access controls, audit logging, key rotation via Shamir's Secret
   Sharing, and a key-compromise data-migration plan. (Linkage is already encrypted at rest by the
   wallet; this protects the one key that can decrypt it.)
2. Production `ScreeningProvider` backed by a real sanctioned-parties feed.
3. Operational hardening of the overlay host (physical/logical/operational controls).
4. **Issuer-side sanctions screening (I3, from whole-branch review):** admin issuance currently
   screens the FT output recipients but not the issuing identity itself (the admin output exposes a
   derived `boundKey`, not the issuer identity key). Add the issuer identity key to the admin
   off-chain payload and screen it, so an OFAC-listed issuer cannot mint. Design §4.2.6 intent.
5. **Canonical JSON → full RFC 8785 JCS (I1, from whole-branch review):** `MandalaAdmin.canonicalize`
   is a deterministic JSON subset (recursive key sorting + `JSON.stringify` scalars), not full JCS
   (no number/Unicode normalization). It is internally consistent (the overlay re-derives with the
   same function), so it is safe in-system, but a third party implementing literal JCS would compute
   a different `boundKey`. Either adopt a vetted JCS library or amend this spec to declare the
   implemented form normative before independent implementers build against it.
6. **Admin-chain depth:** the overlay verifies one hop (boundKey re-derivation + that the prior
   authorization outpoint is spent for non-`register` kinds); it does not walk the authorization
   chain back to genesis. A self-consistent forged `actionDetails` whose `priorOutpoint` points at
   any spent input the issuer controls passes the one-hop check. Add full chain-to-genesis walking.
7. **Redeem/burn output mechanics:** conservation currently requires `Σout === Σin + authorizedIssue`
   per assetId, which admits transfers and authorized issuance but does not model `redeem` (supply
   reduction) output rules. Define and enforce redeem semantics.

### Deferred minor items (from per-task reviews; triaged non-blocking)
- `MandalaToken.unlock` lacks an end-to-end `spendTx.verify()` test (signature correct by inspection
  vs SDK P2PKH); add full-interpreter verification.
- `MandalaLookupService.outputSpent` does a redundant `findByOutpoint` + `getTokenRow`; collapse to
  one query.
- `linkageControlsPubKeyHash` (in `verifyKeyLinkage.ts`) is currently unused by the topic manager
  (which inlines the byte comparison); either use it for DRY or remove.
- `MandalaToken.unlock`/`MandalaAdmin.unlock` duplicate ~30 lines of sighash-preimage construction;
  extract a shared helper.

## 9. Out of Scope

- NFT Mandala variant.
- Arbitrary PushDrop data fields on token outputs.
- Public balance/analytics APIs.
