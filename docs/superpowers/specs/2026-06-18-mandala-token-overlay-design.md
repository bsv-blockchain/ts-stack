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
  `revealCounterpartyKeyLinkage` data, screen both transfer sides against a sanctions list, and
  retain linkage data for the regulatory minimum.

The overlay is treated as highly sensitive infrastructure. Identity-linked balances are an
internal side-effect and are **never** exposed via a public query.

## 2. Background & Key Decisions

- **Token framework:** BRC-92 Mandala Token Protocol (https://bsv.brc.dev/tokens/0092).
  FT-only in this cut — no NFT variant, no arbitrary PushDrop data fields.
- **Linkage method:** `revealCounterpartyKeyLinkage` (the root-key counterparty version, not
  `revealSpecificKeyLinkage`). The SDK already defines `RevealCounterpartyKeyLinkageArgs/Result`
  in `packages/sdk/src/wallet/Wallet.interfaces.ts`.
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

### 2.1 Accepted Deviation — Linkage Encryption Deferred

The brief calls for core-banking-grade envelope encryption (KMS/HSM) of retained linkage data.
For this first cut the user has accepted storing linkage data **plaintext** behind a
`LinkageEncryptor` seam (passthrough implementation). This is a **hard follow-up obligation**, not
a permanent state — see §8. The seam exists specifically so a real KMS/HSM envelope-encryption
implementation can be dropped in without touching call sites.

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

- `boundKey = identityPublicKey.deriveChild(anyone, commitment)` where `anyone` is the
  private-key constant `1` and `commitment = hash(actionDetails)`.
- Each administrative transaction spends authorization outpoint *n* and creates outpoint *n+1*,
  forming an immutable linked hash chain in the transaction DAG since genesis.

Action kinds:
- `register` — genesis authorization outpoint; establishes the `assetId` basis.
- `issue` / mint — create new FT supply.
- `redeem` — destroy FT supply.
- `recover` — reissue burnt tokens.

Methods:
- `deriveBoundKey(identityPublicKey, actionDetails)` → boundKey + commitment.
- `lock(boundKey)`.
- genesis/registration builder.
- `unlock(wallet, ...)` → boundKey signature for `OP_CHECKSIG`.
- `decode(script)` → `{ boundKey }`; throws on non-admin scripts.

## 4. Component 2 — Overlay (`@bsv/overlay-topics`, `src/mandala/`)

File layout mirrors existing topics (UHRP / Identity):

| File | Responsibility |
|------|----------------|
| `types.ts` | `MandalaTokenRecord`, off-chain linkage payload types, `ScreeningProvider`, `LinkageEncryptor` interfaces |
| `verifyKeyLinkage.ts` | EC point-addition verification of `revealCounterpartyKeyLinkage` data → controlling identity pubkey per input/output |
| `MandalaTopicManager.ts` | `TopicManager` implementation (admittance + all enforcement) |
| `MandalaLookupService.ts` | `LookupService` implementation (persistence + queries) |
| `MandalaStorageManager.ts` | MongoDB persistence |
| `MandalaTopicDocs.md.ts` / `MandalaLookupDocs.md.ts` | Markdown docs (message-box pattern) |

All exported from `packages/overlays/topics/src/index.ts`.

### 4.1 `verifyKeyLinkage.ts`

Modeled on UHRP's `isTokenSignatureCorrectlyLinked.ts`. Given a `revealCounterpartyKeyLinkage`
payload, perform elliptic-curve point-addition to confirm which identity public key controls a
given input or output. Independently verifiable; relies on discrete-log hardness. Change outputs
use the same path with the sender as their own counterparty.

### 4.2 `MandalaTopicManager`

`identifyAdmissibleOutputs(beef, previousCoins, offChainValues, mode)`:

1. Parse transaction outputs; classify each as **FT transfer** (`MandalaToken.decode`), **admin**
   (`MandalaAdmin.decode`), or non-topical.
2. Parse `offChainValues` → linkage payload (per input and per output).
3. Verify linkage via `verifyKeyLinkage` → controlling identity public key for each relevant
   input/output.
4. **Admin outputs:** validate boundKey `OP_CHECKSIG`, that the tx spends the prior authorization
   outpoint, that the commitment matches the declared action details, and chain integrity.
   Issuance/recovery are the authorized supply-changing exceptions.
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
- **retained linkage records** (passed through `LinkageEncryptor`; plaintext for now),
- internal per-identity-key balances (maintained as outputs are admitted/spent).

`lookup(question)` answers **only** by `assetId` and by outpoint. There is deliberately **no**
balance-by-identity-key query exposed.

### 4.4 `MandalaStorageManager` (MongoDB)

Collections:
- `tokens` — current UTXO set for token outputs.
- `linkageRecords` — retained linkage, **no TTL expiry** (must persist ≥5 years; deletion is an
  out-of-band retention-policy action, not an automatic index).
- `balances` — internal per-identity-key running balances.

## 5. Injected Dependencies (testable seams)

```ts
interface ScreeningProvider {
  isSanctioned(identityKey: string): Promise<boolean>
}
// InMemoryScreeningProvider — list-backed, used in tests.

interface LinkageEncryptor {
  encrypt(plaintext: number[]): Promise<number[]>
  decrypt(ciphertext: number[]): Promise<number[]>
}
// PassthroughEncryptor — returns input unchanged. TODO: replace with KMS/HSM envelope encryption.
```

Both are constructor-injected into the topic manager / lookup service so production wiring swaps
implementations without code changes.

## 6. Compliance Model

- Screen both sides of every transfer; reject any transaction touching a sanctioned identity key.
- Retain linkage data and the derived identity public key for ≥5 years.
- Balances are queryable internally only — never via a public API.

## 7. Testing

- **ts-templates (jest):** `MandalaToken` lock/unlock/decode roundtrip; `MandalaAdmin`
  boundKey derivation + lock/unlock/decode; conservation arithmetic helpers.
- **topics (jest + `mongodb-memory-server`):** linkage verification with known EC test vectors;
  conservation rejection; admin-chain validation (valid issuance admitted, broken chain rejected);
  both-side sanctions rejection; lookup by assetId/outpoint; confirm no identity-balance query
  path exists.

## 8. Follow-up Obligations (out of scope for this spec)

1. **Linkage encryption (HARD):** replace `PassthroughEncryptor` with real envelope encryption
   (KMS/HSM, data-key wrapping, key rotation via Shamir's Secret Sharing, audit logging, key-
   compromise migration plan). Tracks the brief's core-banking sensitivity requirement.
2. Production `ScreeningProvider` backed by a real sanctioned-parties feed.
3. Operational hardening of the overlay host (physical/logical/operational controls).

## 9. Out of Scope

- NFT Mandala variant.
- Arbitrary PushDrop data fields on token outputs.
- Public balance/analytics APIs.
