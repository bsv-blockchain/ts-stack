# Wallet Toolbox examples

Examples in this directory are reusable source recipes, not Jest tests and not
published package entry points. Their deterministic logic is covered by normal
tests where possible; credentialed behavior is validated by one exact governed
manual integration suite.

## SQLite wallet backup

[`backup.ts`](./backup.ts) demonstrates attaching a local SQLite provider to an
authenticated wallet client and synchronizing the active store into it.
`backupWalletClient` and `backupToSQLite` retain their historical
`Promise<void>` signatures. The corresponding `WithEvidence` variants return
non-secret execution evidence for validation and operator records.

The default output contains wallet data and must be protected like the source
wallet. Choose an explicit path, verify filesystem permissions, and remove or
archive the database according to the operator's retention policy.

## Wallet sweep

[`sweep.ts`](./sweep.ts) preserves the useful cross-wallet sweep example that
used to be embedded in a legacy-fixture Jest file. It accepts two fully
configured wallet instances rather than loading hard-coded production
identities or endpoints. `sweepWalletWithEvidence` also records before/after
balances and rejects cross-chain or same-identity transfers.

## External P2PKH input

[`spendP2pkhOutpoint.ts`](./spendP2pkhOutpoint.ts) preserves the useful signing
recipe that was previously a skipped test with a hard-coded WIF and outpoint.
The maintained example requires the caller to provide an already validated
source BEEF, exact outpoint, amount, private key, and configured wallet; it
never loads or embeds credentials.

## BRC-29 wallet payment

[`walletPayment.ts`](./walletPayment.ts) contains the reusable output and action
recipes that were previously embedded in the live-wallet manual suite.
Recipients, amounts, keys, and wallet connections are caller-provided; the
example validates results and never logs credentials or embeds funded keys.
