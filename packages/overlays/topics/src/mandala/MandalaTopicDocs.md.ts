export default `# Mandala Token Topic Manager (tm_mandala)

Admits BRC-92 Mandala fungible-token transfer outputs after verifying off-chain
\`revealSpecificKeyLinkage\` data, enforcing token conservation and the admin
authorization chain, and screening both transfer parties against a sanctions list.
Every token output and every admin-auth output must carry exactly 1 satoshi
(token value is payload-denominated); violating transactions are rejected.
Linkage data travels off-chain via \`offChainValues\` and is retained (encrypted).
`
