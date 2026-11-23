---
release:
  "@bsv/sigma-permission-module": minor
---
Applications obtain a wallet-held statement point and deterministic Schnorr, DLEQ and OR zero-knowledge proofs through BRC-100 encrypt, with no new method or wire message; the proof scalar is derived from the BRC-42 child key and is never the child key itself. The module accepts only encrypt; it refuses every other method the wallet host routes to it, and every basket or label beginning p sigma that reaches it, and authorization precedes derivation. Exports the module, createSigmaModule, the pure verifiers and the point codecs. Requires the repaired SDK4.0.1 hotfix for the SDK4 peer alternative while retaining the SDK2/3 alternatives and lower bound.

## Migration

The module is inert until a wallet host registers it under permissionModules: { sigma }; removing that registration rolls it back.
