---
release:
  "@bsv/wallet-toolbox": patch
  "@bsv/wallet-toolbox-client": patch
  "@bsv/wallet-toolbox-mobile": patch
---
A sendMax (maxPossibleSatoshis) createAction is funded from unproven change when
confirmed coins cannot pay the fee, instead of failing in the signer with an
invalid output amount.

## Migration

No API, wire or schema migration. The ordinary createAction path runs in
Storage, so upgrade a remote Storage server for it; the action batch path is
fixed by upgrading the wallet host.
