export default `# Mandala Token Lookup Service (ls_mandala)

Indexes the outputs \`tm_mandala\` admits (BRC-162 token outputs: deploy,
authority and value) by token id and outpoint. Each output's owner comes from
the owner journal the topic manager writes before admittance, so the index can
always be rebuilt from it. The service also keeps each deploy's metadata, each
token's admin state and its history of committed admin actions, the (encrypted)
key-linkage records, and internal per-identity balances.

A token id is \`<txid>_0\`: the deploy outpoint in display byte order, lowercase.

## Queries

The first key present, in this order, answers:

- \`{ metadataTokenId }\`: the deploy output of the token.
- \`{ assetStateTokenId }\`: the token's admin state.
- \`{ adminHistoryTokenId, limit?, skip? }\`: the committed admin actions in fold
  order \`(height, offset, admitSeq)\`, each with its kind, details, commitment
  and supply delta.
- \`{ authoritiesTokenId, limit?, skip? }\`: the token's unspent authority outputs.
- \`{ tokenId, limit?, skip? }\`: the token's unspent value outputs, in outpoint order.
- \`{ txid, outputIndex }\`: the value or authority output at that outpoint.

\`limit\` is 1 to 100 (default 100) and \`skip\` is 0 to 100000 (default 0).
Anything else is refused. Identity balances are not exposed through any query.

## Recovery duties of the overlay

The engine notifies each admitted output once and only logs what the lookup
throws. The records nothing can rebuild (the committed action, the deploy
metadata and first state, the linkage record) are written first, and every
write is attempted even when an earlier one fails; the owner rows are an index
the next spend or the reconciler repairs from the owner journal.

- At boot, before the engine accepts submissions, call \`rebuildState(tokenId)\`
  for every id in \`tokenIdsWithHistory()\`, and again on the reconciler interval
  with submissions quiesced: it restores an action whose fold was lost after its
  history row was written. It reads and then writes the state, so it must never
  run beside a live fold. A freeze's history row records the frozen coin's
  amount and owner (\`frozenAmount\`, \`frozenOwner\`), and a refold uses them.
- For every evicted transaction, call \`purgeAndRefold(txid)\` once, with
  submissions quiesced. Repeating an interrupted run is safe.
- Call \`restoreInputRow(journal)\` only after the engine confirms the input coin
  is unspent and admitted again: it does not check.
`
