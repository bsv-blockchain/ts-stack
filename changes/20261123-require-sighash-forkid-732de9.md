---
release:
  "@bsv/sdk": patch
---
Transaction.verify() and the default Spend interpreter reject a signature whose sighash omits SIGHASH_FORKID, the same requirement the node enforces. Callers that pass verifyFlags keep the previous rule: the bit is required only when that set includes it. Signatures produced by the SDK, public types and wallet wire formats are unchanged.

## Migration

A caller that verifies a pre-fork signature through Transaction.verify() or Spend without verifyFlags must pass an explicit verifyFlags set that omits SIGHASH_FORKID. No other migration is required.
