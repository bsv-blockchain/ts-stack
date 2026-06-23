export default `# Classic STAS Token Topic Manager (tm_stas)

Admits classic STAS (legacy P2STAS) token transfer outputs by structural
validation only: an output is decoded against the STAS locking-script shape
(\`76a914 <owner> 88ac69 <engine> OP_RETURN <flags> <symbol> …\`) and the
transaction is admitted when per-asset value conservation holds — classic STAS
is satoshi-denominated, so the token amount IS the output's satoshi value.

Unlike \`tm_mandala\`, there is no key-linkage verification and no sanctions
screening: classic STAS carries no identity linkage on-chain. A transaction
with no STAS inputs for an asset is treated as issuance and admitted; mint
authority is not verified on-chain in this version. A transaction that would
inflate a token (STAS outputs exceed STAS inputs for an asset that has inputs)
is rejected in full.
`
