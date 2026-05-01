---
id: spec-brc-100-wallet
title: BRC-100 Wallet Interface
kind: spec
version: "1.0.0"
last_updated: "2026-05-01"
last_verified: "2026-05-01"
status: stable
tags: ["spec", "wallet", "brc-100"]
---

# BRC-100 Wallet Interface

BRC-100 is the standard application-to-wallet interface used by BSV Desktop, BSV Browser, `@bsv/wallet-toolbox`, and any compatible wallet implementation.

The authoritative sources for this page are:

- `packages/sdk/src/wallet/Wallet.interfaces.ts` (TypeScript definitions)
- `specs/sdk/brc-100-wallet.json` (wire-format schema)
- [BRC-100 in the BRC repository](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md)

This MD is a human-readable summary. Implement against the TS interfaces and JSON schema. The TypeScript interface passes `originator?: OriginatorDomainNameStringUnder250Bytes` as an optional second method parameter (wire formats carry it in the request envelope). See `ReviewActionResult` for delayed-broadcast responses.

## Data Conventions

| Type | Shape |
|------|-------|
| `Byte[]` | Array of integers from `0` to `255`. Conformance vectors may encode byte arrays as hex strings for readability. |
| `BEEF` | BRC-62 transaction envelope bytes. |
| `AtomicBEEF` | BRC-95 bytes used for action transactions. |
| `OutpointString` | `<64 hex txid>.<output index>`. |
| `PubKeyHex` | Compressed secp256k1 public key, 66 hex chars. |
| `WalletProtocol` | Tuple `[securityLevel, protocolString]`, where security level is `0`, `1`, or `2`. |
| `WalletCounterparty` | A `PubKeyHex`, `'self'`, or `'anyone'`. |

Every method returns `Promise<object>`. Errors are thrown as wallet error objects with `isError: true`.

## Method Index

| Area | Methods |
|------|---------|
| Actions | [`createAction`](#createaction), [`signAction`](#signaction), [`abortAction`](#abortaction), [`listActions`](#listactions), [`internalizeAction`](#internalizeaction) |
| Outputs | [`listOutputs`](#listoutputs), [`relinquishOutput`](#relinquishoutput) |
| Keys and cryptography | [`getPublicKey`](#getpublickey), [`revealCounterpartyKeyLinkage`](#revealcounterpartykeylinkage), [`revealSpecificKeyLinkage`](#revealspecifickeylinkage), [`encrypt`](#encrypt), [`decrypt`](#decrypt), [`createHmac`](#createhmac), [`verifyHmac`](#verifyhmac), [`createSignature`](#createsignature), [`verifySignature`](#verifysignature) |
| Certificates and identity discovery | [`acquireCertificate`](#acquirecertificate), [`listCertificates`](#listcertificates), [`proveCertificate`](#provecertificate), [`relinquishCertificate`](#relinquishcertificate), [`discoverByIdentityKey`](#discoverbyidentitykey), [`discoverByAttributes`](#discoverbyattributes) |
| Wallet state | [`isAuthenticated`](#isauthenticated), [`waitForAuthentication`](#waitforauthentication), [`getHeight`](#getheight), [`getHeaderForHeight`](#getheaderforheight), [`getNetwork`](#getnetwork), [`getVersion`](#getversion) |

## Actions

### createAction

Creates a transaction action. The wallet may fund, sign, and process it immediately, or it may return a `signableTransaction` reference when inputs need external unlocking scripts.

```typescript
const result = await wallet.createAction(args)
```

Required args:

| Field | Type | Notes |
|-------|------|-------|
| `description` | `string` | Human-readable action description, 5-50 bytes. |

Optional args:

| Field | Type | Notes |
|-------|------|-------|
| `inputBEEF` | `BEEF` | Source transaction data for explicit inputs. |
| `inputs` | `CreateActionInput[]` | Explicit inputs to spend. Each needs `outpoint` and `inputDescription`; provide `unlockingScript` now or `unlockingScriptLength` for later signing. |
| `outputs` | `CreateActionOutput[]` | Outputs to create. Each needs `lockingScript`, `satoshis`, and `outputDescription`; may include `basket`, `customInstructions`, and `tags`. |
| `lockTime` | `number` | Transaction lock time. |
| `version` | `number` | Transaction version. |
| `labels` | `string[]` | Action-level labels for `listActions`. |
| `options` | `CreateActionOptions` | Processing options below. |

Options:

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `signAndProcess` | `boolean` | `true` | If true and all inputs can be signed, return `txid` and/or `tx`. If false or an input has only `unlockingScriptLength`, return `signableTransaction`. |
| `acceptDelayedBroadcast` | `boolean` | `true` | If true, wallet may queue broadcast in the background. If false, broadcast errors can be returned immediately. |
| `trustSelf` | `'known'` | - | Allows proof data for wallet-known transactions to be omitted. |
| `knownTxids` | `string[]` | - | TXIDs the wallet may treat as known for chained transactions. |
| `returnTXIDOnly` | `boolean` | `false` | Return only `txid` when possible. |
| `noSend` | `boolean` | `false` | Construct without sending; useful for chained batches. |
| `noSendChange` | `string[]` | - | Change outpoints from prior `noSend` actions in the same batch. |
| `sendWith` | `string[]` | - | TXIDs of prior `noSend` actions to send with this action. |
| `randomizeOutputs` | `boolean` | `true` | Set false when output order must remain deterministic. |

Returns:

| Field | Type | When present |
|-------|------|--------------|
| `txid` | `TXIDHexString` | When the action has a transaction ID to report. |
| `tx` | `AtomicBEEF` | When transaction bytes are returned. |
| `noSendChange` | `OutpointString[]` | When `noSend` produces change for later chained actions. |
| `sendWithResults` | `SendWithResult[]` | When sending a batch created with `sendWith`. |
| `signableTransaction` | `{ tx: AtomicBEEF, reference: Base64String }` | When the action needs a follow-up `signAction`. |
| (ReviewActionResult fields) | `object` | When `acceptDelayedBroadcast: false`; see `ReviewActionResult` (status, competingTxs, etc.) in `Wallet.interfaces.ts`. |

Minimal shape:

```typescript
const result = await wallet.createAction({
  description: 'Create payment',
  outputs: [{
    lockingScript,
    satoshis: 1000,
    outputDescription: 'Payment output'
  }],
  options: { acceptDelayedBroadcast: false }
})
```

### signAction

Completes an action that was created with `createAction` and returned a `signableTransaction`.

```typescript
const result = await wallet.signAction(args)
```

Required args:

| Field | Type | Notes |
|-------|------|-------|
| `reference` | `Base64String` | `signableTransaction.reference` from `createAction`. |
| `spends` | `Record<number, SignActionSpend>` | Map from input index to `{ unlockingScript, sequenceNumber? }`. |

Options:

| Option | Type | Default |
|--------|------|---------|
| `acceptDelayedBroadcast` | `boolean` | `true` |
| `returnTXIDOnly` | `boolean` | `false` |
| `noSend` | `boolean` | `false` |
| `sendWith` | `TXIDHexString[]` | - |

Returns:

| Field | Type |
|-------|------|
| `txid` | `TXIDHexString` |
| `tx` | `AtomicBEEF` |
| `sendWithResults` | `SendWithResult[]` |

Minimal shape:

```typescript
await wallet.signAction({
  reference: action.signableTransaction!.reference,
  spends: {
    0: { unlockingScript }
  },
  options: { acceptDelayedBroadcast: false }
})
```

### abortAction

Cancels an in-progress action before it is finalized.

| Args | Returns |
|------|---------|
| `{ reference: Base64String }` | `{ aborted: true }` |

### listActions

Lists wallet actions matching labels.

Required args:

| Field | Type |
|-------|------|
| `labels` | `LabelStringUnder300Bytes[]` |

Optional args:

| Field | Type | Default |
|-------|------|---------|
| `labelQueryMode` | `'any' | 'all'` | `'any'` |
| `includeLabels` | `boolean` | `false` |
| `includeInputs` | `boolean` | `false` |
| `includeInputSourceLockingScripts` | `boolean` | `false` |
| `includeInputUnlockingScripts` | `boolean` | `false` |
| `includeOutputs` | `boolean` | `false` |
| `includeOutputLockingScripts` | `boolean` | `false` |
| `limit` | `number` | `10`, max `10000` |
| `offset` | `number` | `0` |
| `seekPermission` | `boolean` | `true` |

Returns `{ totalActions, actions }`, where each action includes `txid`, `satoshis`, `status`, `isOutgoing`, `description`, `version`, `lockTime`, and optional labels/inputs/outputs depending on include flags.

### internalizeAction

Imports a transaction into the wallet so selected outputs become wallet payments or basket insertions.

Required args:

| Field | Type | Notes |
|-------|------|-------|
| `tx` | `AtomicBEEF` | Transaction bytes to internalize. |
| `outputs` | `InternalizeOutput[]` | Outputs to treat as wallet payments or basket insertions. |
| `description` | `string` | Human-readable description, 5-50 bytes. |

Optional args:

| Field | Type |
|-------|------|
| `labels` | `string[]` |
| `seekPermission` | `boolean` |

`InternalizeOutput` uses:

| Field | Type | Notes |
|-------|------|-------|
| `outputIndex` | `number` | Output index in the transaction. |
| `protocol` | `'wallet payment' | 'basket insertion'` | Determines the remittance shape. |
| `paymentRemittance` | `{ derivationPrefix, derivationSuffix, senderIdentityKey }` | Required for wallet payments. |
| `insertionRemittance` | `{ basket, customInstructions?, tags? }` | Required for basket insertions. |

Returns `{ accepted: true }`.

## Outputs

### listOutputs

Lists tracked outputs from a basket.

Required args:

| Field | Type |
|-------|------|
| `basket` | `BasketStringUnder300Bytes` |

Optional args:

| Field | Type | Default |
|-------|------|---------|
| `tags` | `OutputTagStringUnder300Bytes[]` | - |
| `tagQueryMode` | `'all' | 'any'` | `'any'` |
| `include` | `'locking scripts' | 'entire transactions'` | - | Legacy `includeEntireTransactions: boolean` also supported for compatibility; prefer `include` enum. |
| `includeCustomInstructions` | `boolean` | `false` |
| `includeTags` | `boolean` | `false` |
| `includeLabels` | `boolean` | `false` |
| `limit` | `number` | `10`, max `10000` |
| `offset` | `number` | `0`; negative offsets read newest first. |
| `seekPermission` | `boolean` | `true` |

Returns:

| Field | Type |
|-------|------|
| `totalOutputs` | `number` |
| `BEEF` | `BEEF`, when `include: 'entire transactions'` |
| `outputs` | `WalletOutput[]` |

`WalletOutput` includes `outpoint`, `satoshis`, `spendable`, optional `lockingScript`, optional `customInstructions`, optional `tags`, and optional action `labels`.

### relinquishOutput

Removes an output from a basket without spending it.

| Args | Returns |
|------|---------|
| `{ basket: string, output: OutpointString }` | `{ relinquished: true }` |

## Keys and Cryptography

Most key and crypto methods share `WalletEncryptionArgs`:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `protocolID` | `WalletProtocol` | yes except `getPublicKey({ identityKey: true })` | `[securityLevel, protocolString]`. |
| `keyID` | `string` | yes except `getPublicKey({ identityKey: true })` | Derivation key ID. |
| `counterparty` | `WalletCounterparty` | no | Public key, `'self'`, or `'anyone'`. |
| `privileged` | `boolean` | no | Requests privileged keyring. |
| `privilegedReason` | `string` | when privileged | Reason shown to the user. |
| `seekPermission` | `boolean` | no | Defaults to true. |

### getPublicKey

Retrieves the wallet identity key or a derived public key.

Args:

| Field | Type | Notes |
|-------|------|-------|
| `identityKey` | `true` | If true, returns the user's identity key and ignores protocol/key fields. |
| `protocolID` | `WalletProtocol` | Required when not requesting the identity key. |
| `keyID` | `string` | Required when not requesting the identity key. |
| `counterparty` | `WalletCounterparty` | Optional derivation counterparty. |
| `forSelf` | `boolean` | Return a key derived from this user's identity rather than the counterparty's identity. |
| `privileged`, `privilegedReason`, `seekPermission` | see shared args | Optional. |

Returns `{ publicKey: PubKeyHex }`.

### revealCounterpartyKeyLinkage

Reveals the linkage between this wallet and a counterparty across all interactions to a verifier.

| Args | Returns |
|------|---------|
| `{ counterparty: PubKeyHex, verifier: PubKeyHex, privileged?, privilegedReason? }` | `{ encryptedLinkage, encryptedLinkageProof, prover, verifier, counterparty, revelationTime }` |

### revealSpecificKeyLinkage

Reveals linkage for one protocol/key interaction.

| Args | Returns |
|------|---------|
| `{ counterparty, verifier, protocolID, keyID, privileged?, privilegedReason? }` | `{ encryptedLinkage, encryptedLinkageProof, prover, verifier, counterparty, protocolID, keyID, proofType }` |

### encrypt

Encrypts bytes with a derived key.

| Additional arg | Type |
|----------------|------|
| `plaintext` | `Byte[]` |

Returns `{ ciphertext: Byte[] }`.

### decrypt

Decrypts bytes with a derived key.

| Additional arg | Type |
|----------------|------|
| `ciphertext` | `Byte[]` |

Returns `{ plaintext: Byte[] }`.

### createHmac

Creates an HMAC over bytes with a derived key.

| Additional arg | Type |
|----------------|------|
| `data` | `Byte[]` |

Returns `{ hmac: Byte[] }`.

### verifyHmac

Verifies an HMAC over bytes with a derived key.

| Additional args | Type |
|-----------------|------|
| `data` | `Byte[]` |
| `hmac` | `Byte[]` |

Returns `{ valid: true }` on success and throws on failure.

### createSignature

Creates a DER-encoded ECDSA signature.

| Additional args | Type | Notes |
|-----------------|------|-------|
| `data` | `Byte[]` | Provide this or `hashToDirectlySign`. |
| `hashToDirectlySign` | `Byte[]` | For pre-hashed data. |

Returns `{ signature: Byte[] }`.

### verifySignature

Verifies a DER-encoded ECDSA signature.

| Additional args | Type | Notes |
|-----------------|------|-------|
| `signature` | `Byte[]` | Required. |
| `data` | `Byte[]` | Provide this or `hashToDirectlyVerify`. |
| `hashToDirectlyVerify` | `Byte[]` | For pre-hashed data. |
| `forSelf` | `boolean` | Verifies against this user's derived key rather than the counterparty's. |

Returns `{ valid: true }` on success and throws on failure.

## Certificates and Discovery

### acquireCertificate

Acquires a certificate by `direct` receipt or `issuance` from a certifier.

Required args:

| Field | Type |
|-------|------|
| `type` | `Base64String` |
| `certifier` | `PubKeyHex` |
| `acquisitionProtocol` | `'direct' | 'issuance'` |
| `fields` | `Record<string, string>` |

Optional args include `serialNumber`, `revocationOutpoint`, `signature`, `certifierUrl`, `keyringRevealer`, `keyringForSubject`, `privileged`, and `privilegedReason`.

Returns a `WalletCertificate` with `type`, `subject`, `serialNumber`, `certifier`, `revocationOutpoint`, `signature`, and `fields`.

### listCertificates

Lists certificates held by the wallet.

Required args:

| Field | Type |
|-------|------|
| `certifiers` | `PubKeyHex[]` |
| `types` | `Base64String[]` |

Optional args: `limit`, `offset`, `privileged`, `privilegedReason`.

Returns `{ totalCertificates, certificates }`. Each certificate may include `keyring` and `verifier`.

### proveCertificate

Builds a selective disclosure proof for specified fields.

Required args:

| Field | Type |
|-------|------|
| `certificate` | `Partial<WalletCertificate>` in TypeScript; schema artifact describes `WalletCertificate`. |
| `fieldsToReveal` | `string[]` |
| `verifier` | `PubKeyHex` |

Optional args: `privileged`, `privilegedReason`.

Returns `{ keyringForVerifier, certificate?, verifier? }`.

### relinquishCertificate

Removes a certificate from wallet storage.

| Args | Returns |
|------|---------|
| `{ type: Base64String, serialNumber: Base64String, certifier: PubKeyHex }` | `{ relinquished: true }` |

### discoverByIdentityKey

Discovers trusted identity certificates for an identity key.

| Required arg | Type |
|--------------|------|
| `identityKey` | `PubKeyHex` |

Optional args: `limit`, `offset`, `seekPermission`.

Returns `{ totalCertificates, certificates }`, where certificates are `IdentityCertificate[]`.

### discoverByAttributes

Discovers identity certificates matching public attributes.

| Required arg | Type |
|--------------|------|
| `attributes` | `Record<string, string>` |

Optional args: `limit`, `offset`, `seekPermission`.

Returns `{ totalCertificates, certificates }`, where certificates are `IdentityCertificate[]`.

## Wallet State

### isAuthenticated

Checks whether the user is authenticated.

| Args | Returns |
|------|---------|
| `{}` | `{ authenticated: true }` |

### waitForAuthentication

Waits until the user is authenticated.

| Args | Returns |
|------|---------|
| `{}` | `{ authenticated: true }` |

### getHeight

Gets the current chain height.

| Args | Returns |
|------|---------|
| `{}` | `{ height: PositiveInteger }` |

### getHeaderForHeight

Gets an 80-byte block header as hex.

| Args | Returns |
|------|---------|
| `{ height: PositiveInteger }` | `{ header: HexString }` |

### getNetwork

Gets the wallet network.

| Args | Returns |
|------|---------|
| `{}` | `{ network: 'mainnet' | 'testnet' }` |

### getVersion

Gets the wallet implementation version string.

| Args | Returns |
|------|---------|
| `{}` | `{ version: string }` |

## Conformance

Current BRC-100 conformance vectors cover `getPublicKey`, `createHmac`/`verifyHmac`, `createSignature`/`verifySignature`, and `encrypt`/`decrypt`.

See:

- [Vector Catalog](../conformance/vectors.md#wallet-brc-100)
- `conformance/vectors/wallet/brc100/`
- `conformance/META.json`

## Spec Artifact

- [`specs/sdk/brc-100-wallet.json`](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/sdk/brc-100-wallet.json)
