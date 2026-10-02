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
`
