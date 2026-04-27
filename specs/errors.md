# Error Taxonomy

This document defines the canonical error taxonomy for the BSV Distributed Applications Stack.
All error codes used across TypeScript, Go, Python, and Rust implementations should map to
one of the categories and codes below.

- Every stable error code is **append-only** — codes are never re-numbered or repurposed.
- Implementations must throw/return an object with at minimum `{ code, message }`.
- The `isError: true` property marks an object as a wallet error in the BRC-100 wire format.
- See `specs/sdk/brc-100-wallet.json#/$defs/WalletErrorObject` for the JSON Schema.

---

## Standard Error Shape

```json
{
  "isError": true,
  "code": "ERR_SERIALIZATION_INVALID_BEEF",
  "message": "BEEF bytes do not start with the expected magic bytes",
  "details": {
    "expected": "0100beef",
    "got": "deadbeef"
  }
}
```

| Field     | Type    | Required | Description                                                     |
|-----------|---------|----------|-----------------------------------------------------------------|
| `isError` | boolean | Yes      | Always `true`. Allows serialization layers to identify errors.  |
| `code`    | string  | Yes      | Stable machine-readable code. 10–40 chars. `ERR_<CATEGORY>_<DETAIL>`. |
| `message` | string  | Yes      | Human-readable English description. 20–200 chars.              |
| `details` | object  | No       | Optional extra context (not for display to end users).         |
| `stack`   | string  | No       | Stack trace (development mode only; strip from production logs).|

---

## Error Code Numbering Convention

Codes follow the pattern:

```
ERR_<CATEGORY>_<DETAIL>
```

- `<CATEGORY>` is one of the 15 taxonomy categories below (uppercased).
- `<DETAIL>` is a short descriptor unique within the category (uppercased, underscores).
- No numeric ranges are used — codes are named, not numbered.

Examples:
- `ERR_SERIALIZATION_INVALID_BEEF`
- `ERR_CRYPTO_INVALID_PRIVATE_KEY`
- `ERR_TX_CONSTRUCTION_INSUFFICIENT_FUNDS`
- `ERR_BROADCAST_ARC_DOUBLE_SPEND`

---

## Category 1: serialization

Failures to parse or encode structured binary or text formats.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_SERIALIZATION_INVALID_BEEF` | BEEF bytes fail validation (bad magic, truncated, wrong version). | overlay /submit, wallet internalizeAction |
| `ERR_SERIALIZATION_INVALID_ATOMIC_BEEF` | AtomicBEEF (BRC-95) bytes fail validation. | createAction, signAction |
| `ERR_SERIALIZATION_INVALID_BUMP` | BUMP/Merkle path bytes fail validation. | broadcast callback, chain tracker |
| `ERR_SERIALIZATION_INVALID_TX` | Raw transaction bytes cannot be deserialized. | broadcast, overlay |
| `ERR_SERIALIZATION_INVALID_SCRIPT` | Script bytes cannot be parsed. | createAction output, template |
| `ERR_SERIALIZATION_INVALID_OUTPOINT` | Outpoint string does not match `<64hex>.<uint>` format. | listOutputs, relinquishOutput |
| `ERR_SERIALIZATION_INVALID_HEX` | String contains non-hexadecimal characters. | getPublicKey, signatures |
| `ERR_SERIALIZATION_VECTOR_FORMAT` | Test vector or conformance record violates the schema. | conformance runners |

---

## Category 2: crypto/key-handling

Failures in key generation, derivation, encoding, or usage.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_CRYPTO_INVALID_PRIVATE_KEY` | Private key is zero, out of range, or otherwise invalid. | createSignature, createHmac |
| `ERR_CRYPTO_INVALID_PUBLIC_KEY` | Public key is not a valid compressed secp256k1 point. | getPublicKey, revealCounterpartyKeyLinkage |
| `ERR_CRYPTO_INVALID_SIGNATURE` | DER-encoded ECDSA signature cannot be parsed or is mathematically invalid. | verifySignature |
| `ERR_CRYPTO_SIGNATURE_VERIFICATION_FAILED` | Signature is well-formed but does not verify against the given data and key. | verifySignature |
| `ERR_CRYPTO_HMAC_VERIFICATION_FAILED` | HMAC value does not match the expected value. | verifyHmac |
| `ERR_CRYPTO_KEY_DERIVATION_FAILED` | BRC-42/BRC-43 key derivation produced an invalid key (e.g. point at infinity). | getPublicKey, encrypt, createSignature |
| `ERR_CRYPTO_DECRYPTION_FAILED` | Ciphertext cannot be decrypted (bad key, tampered data, wrong IV). | decrypt |
| `ERR_CRYPTO_ENCRYPTION_FAILED` | Plaintext cannot be encrypted. | encrypt |
| `ERR_CRYPTO_INVALID_CERTIFICATE_SIGNATURE` | Certificate signature does not verify against the certifier key. | acquireCertificate, proveCertificate |

---

## Category 3: tx-construction

Failures in building, composing, or computing properties of transactions.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_TX_CONSTRUCTION_INSUFFICIENT_FUNDS` | Wallet cannot fund the requested outputs (insufficient UTXO balance). | createAction |
| `ERR_TX_CONSTRUCTION_NO_INPUTS` | Transaction has zero inputs after selection. | createAction, signAction |
| `ERR_TX_CONSTRUCTION_NO_OUTPUTS` | Transaction has zero outputs. | createAction |
| `ERR_TX_CONSTRUCTION_LOCKTIME_CONFLICT` | Requested lockTime conflicts with input sequence numbers. | createAction |
| `ERR_TX_CONSTRUCTION_INVALID_VERSION` | Transaction version is not supported. | createAction |
| `ERR_TX_CONSTRUCTION_UNKNOWN_REFERENCE` | `reference` passed to signAction or abortAction does not match any in-progress transaction. | signAction, abortAction |
| `ERR_TX_CONSTRUCTION_SPEND_CONFLICT` | One or more inputs are already spent or being spent in another transaction. | createAction |
| `ERR_TX_CONSTRUCTION_NOSEND_CHANGE_INVALID` | `noSendChange` outpoints cannot be resolved. | createAction |

---

## Category 4: script/sighash

Failures in script evaluation, template execution, or sighash computation.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_SCRIPT_EVALUATION_FAILED` | Script evaluation returned false or threw. | overlay admission, broadcast |
| `ERR_SCRIPT_INVALID_OPCODE` | Script contains an unrecognized or disabled opcode. | template validation |
| `ERR_SCRIPT_INVALID_TEMPLATE` | Script template cannot produce a valid locking/unlocking script. | createAction output |
| `ERR_SIGHASH_INVALID_FLAGS` | Sighash flags combination is unsupported. | signAction |
| `ERR_SIGHASH_PREIMAGE_MISMATCH` | Computed sighash preimage does not match expected value. | signAction |

---

## Category 5: wallet-storage

Failures in reading from or writing to wallet persistent storage.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_WALLET_STORAGE_READ_FAILED` | Storage layer returned an error on read. | listActions, listOutputs, listCertificates |
| `ERR_WALLET_STORAGE_WRITE_FAILED` | Storage layer returned an error on write. | createAction, acquireCertificate, internalizeAction |
| `ERR_WALLET_STORAGE_MIGRATION_FAILED` | Database migration failed during startup. | wallet init |
| `ERR_WALLET_STORAGE_RECORD_NOT_FOUND` | Requested record does not exist. | relinquishOutput, relinquishCertificate |
| `ERR_WALLET_STORAGE_CONFLICT` | Write conflicts with an existing record. | createAction, acquireCertificate |
| `ERR_WALLET_STORAGE_CONSTRAINT_VIOLATION` | Storage constraint (e.g. unique key) violated. | write operations |

---

## Category 6: overlay-admission

Failures during topic manager evaluation of a submitted transaction.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_OVERLAY_ADMISSION_REJECTED` | Topic manager rejected the transaction; it does not satisfy the topic rules. | overlay /submit |
| `ERR_OVERLAY_ADMISSION_INVALID_TOPIC` | The `x-topics` header references a topic not hosted by this node. | overlay /submit |
| `ERR_OVERLAY_ADMISSION_MISSING_TOPICS_HEADER` | The `x-topics` header is absent. | overlay /submit |
| `ERR_OVERLAY_ADMISSION_INVALID_BEEF` | The BEEF payload is not valid for submission. | overlay /submit |
| `ERR_OVERLAY_ADMISSION_SCRIPT_INVALID` | Transaction output script fails topic manager evaluation. | overlay /submit |
| `ERR_OVERLAY_ADMISSION_ALREADY_ADMITTED` | Output is already tracked under this topic. | overlay /submit |

---

## Category 7: lookup-inconsistency

Failures or inconsistent states encountered during lookup queries.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_LOOKUP_SERVICE_NOT_FOUND` | Requested lookup service name is not hosted by this node. | overlay /lookup |
| `ERR_LOOKUP_INVALID_QUERY` | Query object does not match the service's expected shape. | overlay /lookup |
| `ERR_LOOKUP_BACKEND_FAILURE` | The lookup service's storage backend returned an error. | overlay /lookup |
| `ERR_LOOKUP_OUTPUT_EVICTED` | Requested output has been evicted from the lookup service. | overlay /lookup |

---

## Category 8: messaging-failure

Failures in the message-box send, receive, or acknowledge flow.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_MESSAGING_SEND_FAILED` | Message could not be delivered to the message-box server. | message-box client |
| `ERR_MESSAGING_RECEIVE_FAILED` | Messages could not be retrieved from the message-box server. | message-box client |
| `ERR_MESSAGING_INVALID_PAYLOAD` | Message payload fails schema validation. | message-box server |
| `ERR_MESSAGING_RECIPIENT_NOT_FOUND` | No inbox exists for the specified recipient identity key. | message-box server |
| `ERR_MESSAGING_STORAGE_FAILED` | Message-box storage backend returned an error. | message-box server |
| `ERR_MESSAGING_DECRYPTION_FAILED` | Message body cannot be decrypted by the recipient. | message-box client |

---

## Category 9: auth-failure

Failures in the BRC-31 mutual authentication handshake or session management.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_AUTH_INVALID_NONCE` | Nonce in the auth challenge is invalid or expired. | BRC-31 handshake |
| `ERR_AUTH_INVALID_SIGNATURE` | Signature on the auth request or response is invalid. | BRC-31 handshake |
| `ERR_AUTH_IDENTITY_KEY_MISMATCH` | Presented identity key does not match the expected key. | BRC-31 handshake, admin routes |
| `ERR_AUTH_SESSION_EXPIRED` | Auth session token has expired. | auth-express-middleware |
| `ERR_AUTH_UNAUTHORIZED` | Request requires authentication but no credentials were provided. | all protected routes |
| `ERR_AUTH_FORBIDDEN` | Credentials are valid but insufficient for the requested operation. | admin routes |
| `ERR_AUTH_CERTIFICATE_REQUIRED` | Operation requires a verified identity certificate. | protected endpoints |

---

## Category 10: payment-failure

Failures in BRC-29 or BRC-121 (HTTP 402) payment flows.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_PAYMENT_INVALID_DERIVATION` | Payment derivation prefix or suffix is invalid. | BRC-29, internalizeAction |
| `ERR_PAYMENT_IDENTITY_KEY_MISMATCH` | Sender identity key does not match the expected key. | BRC-29, internalizeAction |
| `ERR_PAYMENT_INSUFFICIENT_AMOUNT` | Payment amount is below the required threshold. | BRC-121 middleware |
| `ERR_PAYMENT_TOKEN_INVALID` | Payment token (BRC-121) cannot be verified. | 402-pay middleware |
| `ERR_PAYMENT_TOKEN_EXPIRED` | Payment token has expired. | 402-pay middleware |
| `ERR_PAYMENT_DOUBLE_SPEND` | Payment transaction is a double spend. | payment verification |

---

## Category 11: broadcast-failure

Failures when submitting a transaction to the BSV network via ARC or other broadcasters.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_BROADCAST_ARC_DOUBLE_SPEND` | ARC reported `DOUBLE_SPEND_ATTEMPTED`. | ARC.broadcast() |
| `ERR_BROADCAST_ARC_REJECTED` | ARC reported `REJECTED`. | ARC.broadcast() |
| `ERR_BROADCAST_ARC_INVALID` | ARC reported `INVALID`. | ARC.broadcast() |
| `ERR_BROADCAST_ARC_MALFORMED` | ARC reported `MALFORMED`. | ARC.broadcast() |
| `ERR_BROADCAST_ARC_ORPHAN` | ARC reported an orphan status (extraInfo or txStatus contains "ORPHAN"). | ARC.broadcast() |
| `ERR_BROADCAST_ARC_STALE_BLOCK` | ARC reported `MINED_IN_STALE_BLOCK`. | ARC.broadcast() |
| `ERR_BROADCAST_NETWORK_UNREACHABLE` | HTTP request to the broadcaster failed due to a network error. | ARC.broadcast() |
| `ERR_BROADCAST_UNKNOWN` | Broadcaster returned an unrecognised error status. | ARC.broadcast() |

---

## Category 12: dependency-outage

Failures caused by unavailable or misbehaving external dependencies.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_DEPENDENCY_CHAIN_TRACKER_UNAVAILABLE` | Chain tracker (WhatsOnChain or custom) did not respond. | overlay, wallet |
| `ERR_DEPENDENCY_ARC_UNAVAILABLE` | ARC endpoint returned a non-retryable service error. | broadcast |
| `ERR_DEPENDENCY_STORAGE_UNAVAILABLE` | Database (Knex/MongoDB) is not reachable. | overlay, wallet, message-box |
| `ERR_DEPENDENCY_CERTIFIER_UNAVAILABLE` | Certificate issuer URL returned an error during issuance. | acquireCertificate |
| `ERR_DEPENDENCY_TIMEOUT` | A dependency call exceeded the configured timeout. | all services |

---

## Category 13: config-error

Failures caused by missing, invalid, or mutually exclusive configuration.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_CONFIG_MISSING_REQUIRED` | A required configuration value was not provided. | service startup |
| `ERR_CONFIG_INVALID_VALUE` | A configuration value is present but fails validation. | service startup |
| `ERR_CONFIG_CONFLICTING_OPTIONS` | Two configuration options are mutually exclusive. | service startup |
| `ERR_CONFIG_KNEX_NOT_CONFIGURED` | An operation requires Knex but it has not been configured. | overlay-express |
| `ERR_CONFIG_MONGO_NOT_CONFIGURED` | An operation requires MongoDB but it has not been configured. | overlay-express |
| `ERR_CONFIG_ENGINE_NOT_CONFIGURED` | An operation requires the overlay engine but it has not been configured. | overlay-express |

---

## Category 14: release-regression

Errors introduced by a specific release that did not exist in a prior version.
These codes are assigned per-bug when a regression is identified.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_REGRESSION_<ISSUE_NUMBER>` | Regression introduced in a specific release. The issue number identifies the tracking bug. | varies |

Example: `ERR_REGRESSION_1234` would correspond to GitHub issue #1234.

---

## Category 15: docs/example-mismatch

Failures detected when a documented example or code sample does not match the
actual behaviour of the implementation.

| Code | Description | Interfaces |
|------|-------------|------------|
| `ERR_DOCS_EXAMPLE_EXECUTION_FAILED` | A code example in the documentation fails when executed in CI. | docs CI |
| `ERR_DOCS_SCHEMA_MISMATCH` | A documented request/response shape does not match the JSON Schema. | contract tests |
| `ERR_DOCS_VERSION_DRIFT` | A documentation example references a package version that no longer exists. | docs CI |

---

## Error Codes by Interface

| Interface | Expected Error Categories |
|-----------|--------------------------|
| `createAction` | tx-construction, wallet-storage, broadcast-failure, crypto/key-handling |
| `signAction` | tx-construction, crypto/key-handling, serialization |
| `abortAction` | tx-construction |
| `listActions` | wallet-storage |
| `internalizeAction` | serialization, crypto/key-handling, payment-failure, wallet-storage |
| `listOutputs` | wallet-storage |
| `relinquishOutput` | wallet-storage |
| `acquireCertificate` | crypto/key-handling, dependency-outage, wallet-storage |
| `listCertificates` | wallet-storage |
| `proveCertificate` | crypto/key-handling, wallet-storage |
| `relinquishCertificate` | wallet-storage |
| `discoverByIdentityKey` | dependency-outage |
| `discoverByAttributes` | dependency-outage |
| `isAuthenticated` | auth-failure |
| `waitForAuthentication` | auth-failure |
| `getPublicKey` | crypto/key-handling, auth-failure |
| `revealCounterpartyKeyLinkage` | crypto/key-handling, auth-failure |
| `revealSpecificKeyLinkage` | crypto/key-handling, auth-failure |
| `encrypt` / `decrypt` | crypto/key-handling |
| `createHmac` / `verifyHmac` | crypto/key-handling |
| `createSignature` / `verifySignature` | crypto/key-handling |
| `getHeight` / `getHeaderForHeight` / `getNetwork` | dependency-outage |
| `overlay /submit` | serialization, overlay-admission, broadcast-failure, dependency-outage |
| `overlay /lookup` | lookup-inconsistency, dependency-outage |
| `ARC.broadcast()` | broadcast-failure, dependency-outage, serialization |
| `ARC.broadcastMany()` | broadcast-failure, dependency-outage, serialization |
| `message-box send/receive` | messaging-failure, auth-failure, dependency-outage |
| `BRC-31 auth handshake` | auth-failure, crypto/key-handling |
| `BRC-29/BRC-121 payment` | payment-failure, crypto/key-handling, broadcast-failure |
| `admin routes` | auth-failure, config-error, dependency-outage |
