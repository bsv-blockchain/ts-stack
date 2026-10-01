# DID API

`DID` delegates to the proposed BRC-202 identity-key profile in `@bsv/did`.

| API                                | Result                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `DID.fromIdentityKey(key: string)` | Canonical identity-key `did:key` string; throws on invalid compressed point |
| `DID.resolve(did: string)`         | `DidResolutionResult` with a deterministic document or explicit error       |
| `wallet.getDID()`                  | `DidDocument` from the selected wallet identity key                         |
| `wallet.resolveDID(did: string)`   | `DidResolutionResult`, synchronously and offline                            |

`DidDocument` and `DidResolutionResult` are re-exported types from `@bsv/did`. Resolution supplies empty document metadata; it invents no creation time, chain history, key control, or status evidence. Other methods return `methodNotSupported`; malformed profile input returns `invalidDid`.

See the [identity-key guide](../guides/did.md) for an executable synthetic vector, relationship semantics, privacy limits, and migration.
