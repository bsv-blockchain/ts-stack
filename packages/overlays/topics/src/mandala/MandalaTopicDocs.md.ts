export default `# Mandala Token Topic Manager (tm_mandala)

Admits BRC-92 Mandala fungible-token transfer outputs after verifying off-chain
\`revealSpecificKeyLinkage\` data, enforcing token conservation and the admin
authorization chain, and screening both transfer parties against a sanctions list.
Every token output and every admin-auth output must carry exactly 1 satoshi
(token value is payload-denominated); violating transactions are rejected.
Linkage data travels off-chain via \`offChainValues\` and is retained (encrypted).

### Mandala admission and the 1.8.0 upgrade

Use the same \`MandalaStorageManager\` for Mandala admission and lookup. The
reference store now implements \`isAdminOutpoint(assetId, txid, outputIndex)\`
against admitted admin history. Custom adapters must implement that predicate;
a missing verifier rejects non-genesis admin actions. Its optional TypeScript
member preserves source compatibility, not permission to bypass verification.
Never implement it as a constant \`true\`.

Registration must omit \`assetId\` or use an empty string: the registration's own
outpoint defines its asset. Subsequent admin actions must spend a previously
admitted admin output for that same asset. Token spends require a stored owner
row matching the source outpoint, asset and amount. Optional input linkage
corroborates that owner and the source locking key; it cannot replace missing
state. Sender blinding and transfers without input linkage remain supported
when authoritative owner state is present. Linkage arrays require unique,
non-negative integer indices.

Before upgrading an existing Mandala deployment, back up and audit its admin
history and token-owner records. Restore missing rows from verified admission
evidence before historical replay; do not infer authority from a submitted
payload. The engine identifies admissible outputs before sending spend
notifications, so normal admission can read the owner before lookup removes
the spent row. Custom replay adapters must preserve that ordering. These checks
do not retroactively validate old records.

Coordinate the admission and lookup upgrade. Existing valid wire fields and
encodings are unchanged, and no database collection migration is required.
Keep the new admission checks enabled while repairing historical data.

`
