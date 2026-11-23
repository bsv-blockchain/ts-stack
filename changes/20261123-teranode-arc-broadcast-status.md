---
release:
  "@bsv/sdk": minor
---
Add optional BroadcastResponse.txStatus and BroadcastResponse.arcStatus, set by Teranode and ARC when the service reports them and kept by validateBroadcastResult. Teranode.broadcast now reads ARC-style status bodies: a JSON body with a txStatus is read with ARC's rules and the result carries it as data. RECEIVED stays a success but means received, not yet validated, and may still be rejected. A well-formed competingTxs list is carried as ARC carries it, and ARC reads competingTxs: null, which ARC sends when nothing competes, as no competing transactions instead of ERR_INVALID_RESPONSE. A non-2xx keeps its HTTP code and description and adds the body's ARC status, txStatus and detail under more. A bare 2xx with no body, OK or any non-status body is unchanged, so plain Teranode nodes see the same result.

## Migration

Behaviour change: a 2xx body reporting a status in ARC's failure set (REJECTED, DOUBLE_SPEND_ATTEMPTED, INVALID, MALFORMED, MINED_IN_STALE_BLOCK), a txStatus naming an orphan, or another well-formed txid is now a failure, with code txStatus and more { txStatus, arcStatus, competingTxs } (or ERR_TXID_MISMATCH). Callers that treated every 2xx Teranode answer as success must handle that failure result. Callers that need certainty for RECEIVED check txStatus or poll the service (GET /tx/{txid}).
