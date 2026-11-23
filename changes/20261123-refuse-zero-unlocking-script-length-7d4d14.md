---
release:
  "@bsv/sdk": patch
---
createAction refuses an input that omits unlockingScript and sets unlockingScriptLength to 0. The field is a BRC-100 PositiveInteger (minimum 1); lengths of 1 and above remain accepted. An empty unlockingScript is still refused as a hexadecimal string, before the length check.

## Migration

No wire, storage or schema migration is required. A caller that sent unlockingScriptLength 0 must send a length of at least 1 or supply the script.
