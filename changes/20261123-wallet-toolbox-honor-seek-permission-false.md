---
release:
  "@bsv/wallet-toolbox": patch
  "@bsv/wallet-toolbox-client": patch
  "@bsv/wallet-toolbox-mobile": patch
---
Wallet Toolbox makes WalletPermissionsManager honor the caller's BRC-100
seekPermission: false on listActions, internalizeAction, listOutputs, encrypt,
decrypt, createHmac, verifyHmac, createSignature, verifySignature,
discoverByIdentityKey and discoverByAttributes, and on the built-in BRC-177
module's label check for listActions, as getPublicKey already did. A call that
passes false and would otherwise prompt now fails with the existing
seekPermission=false errors instead of prompting. Calls that need no prompt (an
admin originator, an existing grant, an exempt protocol), and calls that omit
the flag or pass true, are unaffected.

## Migration

No consumer migration is required. Exports, types, storage and wire formats are
unchanged. An application that passed seekPermission: false and relied on the
prompt appearing anyway now receives the existing seekPermission=false error and
should omit the flag or pass true to allow the prompt.
