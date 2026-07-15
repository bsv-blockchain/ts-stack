export default `# DSTAS Token Topic Manager (tm_dstas)

Admits DSTAS (Divisible STAS / STAS 3.0) token transfer outputs by structural
validation. Each output is decoded against the dxs-bsv-token-sdk DSTAS template
(\`<owner:20> <action data> [engine] OP_RETURN <redemption/tokenId:20> <flags> …\`)
and the transaction is admitted when per-tokenId value conservation holds —
DSTAS is satoshi-denominated, so the token amount IS the output's satoshi value.

DSTAS has no public third-party indexer (unlike classic STAS via Bitails or
BSV-21 via the 1Sat overlay), so this overlay is the discovery surface for
DSTAS holdings. A transaction with no DSTAS inputs for a tokenId is treated as
issuance and admitted; a transaction that would inflate a token is rejected in
full. Freeze/confiscation authority is not verified at admission in this
version (the frozen marker is surfaced for indexing only).
`
