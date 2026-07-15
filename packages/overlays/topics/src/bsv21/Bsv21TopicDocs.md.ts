export default `# BSV-21 Token Topic Manager (tm_bsv21)

Admits BSV-21 (1Sat ordinals-style) fungible-token outputs by structural
validation: each output is decoded against the ord-inscription envelope
(\`OP_FALSE OP_IF "ord" OP_1 "application/bsv-20" OP_0 <json> OP_ENDIF\` +
P2PKH owner) and the transaction is admitted when per-tokenId value
conservation holds on the divisible bigint amounts.

A \`deploy+mint\` output (whose tokenId is its own outpoint, with no prior
input of that tokenId) is treated as issuance and admitted. A transaction that
would inflate a token (outputs exceed inputs for a tokenId that has inputs) is
rejected in full. Ownership is plain P2PKH — there is no key-linkage or
sanctions layer.
`
