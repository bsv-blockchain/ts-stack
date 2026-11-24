---
release:
  "@bsv/wallet-toolbox": patch
  "@bsv/wallet-toolbox-client": patch
  "@bsv/wallet-toolbox-mobile": patch
---
WhatsOnChain getUtxoStatus accepts /unspent/all entries whose status is
'unconfirmed' and that carry no height, as WhatsOnChain returns them for mempool
outputs; any answer containing one previously failed as a whole, so isUtxo could
report neither that output nor confirmed outputs of the same script until it was
mined. A present height is still validated and a confirmed entry still requires
one. Entries marked isSpentInMempoolTx: true are no longer reported as unspent,
and this applies to confirmed outputs too: a confirmed output already spent by a
mempool transaction, which getUtxoStatus previously reported as unspent, now
reads as spent, so reviewSpendableOutputs (and its release mode), proof recovery
and confirmed-spend recovery treat it as spent even if that mempool transaction
is later evicted or loses a race. A non-boolean value for that field, or an
outpoint listed twice, fails the answer.

## Migration

No consumer migration is required.
