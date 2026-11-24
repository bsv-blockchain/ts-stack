---
release:
  "@bsv/wallet-toolbox": patch
  "@bsv/wallet-toolbox-client": patch
  "@bsv/wallet-toolbox-mobile": patch
---
The ARC broadcaster treats HTTP 401 and 403 as service errors, as Arcade does
since 2.15.1. An API-key protected ARC answers 401 before it reads the
transaction; arc.taal.com and arc-test.taal.com, the default arcUrl on main and
test, answer every keyless request that way, so a transaction was recorded as
rejected and its inputs released when no other provider accepted it in the same
attempt. A failed status read for an extra txid in ARC.postBeef becomes a
service error for that txid instead of an exception. WhatsOnChain post answers
for 401, 403, 408, an exhausted 429 retry or 5xx, including node-side service
failures it relays, are service errors; a relayed node refusal of the
transaction keeps its classification. A per-transaction ECONNRESET in a Bitails
answer is a service error.

## Migration

No consumer migration is required.
