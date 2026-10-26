# BSV WALLET TOOLBOX EXAMPLES

BSV BLOCKCHAIN | BRC100 Conforming Wallet Example Code

The BSV Wallet Toolbox builds on the [SDK](https://bsv-blockchain.github.io/ts-sdk) to add support for:

    - Persistent UTXO and transaction history management
    - Standardized key derivation protocols.

## Table of Contents

- [Objective](#objective)
- [Security and Operational Safety](#security-and-operational-safety)
- [Examples](#examples)
- [Documentation](#documentation)
- [Contribution Guidelines](#contribution-guidelines)
- [Support \& Contacts](#support--contacts)
- [License](#license)

## Objective

The BSV Wallet Toolbox Examples provides a collection of self-contained sample code to support learning and getting started with the @bsv/wallet-toolbox.

## Security and Operational Safety

This package is educational code, not a production wallet application. Importing
its modules is inert: examples run only when their source file is executed
directly or an exported function is explicitly called.

Treat the following boundaries as security decisions:

- Most transaction examples use testnet. `p2pkhToAddress`, `swapActive`, and the
  mainnet janitor functions intentionally affect mainnet state. `release` covers
  both chains. Verify the chain, identities, destination, amount, and active
  storage provider before invoking any of them.
- Generate `.env` inside `src` with `umask 077` and
  `npx tsx makeEnv > .env`. Never display, share, or commit it: `DEV_KEYS`
  contains root private keys. The committed `.env.template` contains placeholders
  only. Do not reuse credentials found in repository history; rotate any
  credential previously copied from an older template.
- Example logs can contain identity keys, balances, transaction IDs, BEEF,
  derivation data, and wallet/storage names. Treat logs as sensitive financial
  and operational data.
- Pass only a wallet and storage endpoints you independently trust. The selected
  wallet is the local authority for managed funding and change, while the custom
  signing examples additionally bind the requested outpoint, requested output,
  and final signed transaction and abort mismatched actions.
- SQLite backups contain sensitive wallet history. Put them in a trusted,
  owner-only directory; the example rejects linked targets and sets the
  database file to mode `0600`, but SQLite may create journal files beside it.
- `janitor release*` relinquishes outputs, and `swapActive*` changes the active
  storage authority. Inspect first, then invoke the narrowest function needed.

## Documentation

Use the maintained [Wallet Toolbox docs](https://bsv-blockchain.github.io/ts-stack/packages/wallet/wallet-toolbox/)
and [workspace examples](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox-examples).

The [SQLite backup example](src/backup.ts) copies wallet data through storage
replication; it does not export the root key or establish independent retention.
Follow [Wallet backup and recovery](https://bsv-blockchain.github.io/ts-stack/guides/wallet-backup-recovery/),
[BRC-38/39 integration](https://bsv-blockchain.github.io/ts-stack/guides/wallet-data-portability/) and the
[recovery drill](https://bsv-blockchain.github.io/ts-stack/guides/wallet-recovery-drill/) to build a complete flow.

The Toolbox is richly documented with code-level annotations. This should show up well within editors like VSCode.

## Examples

## Contribution Guidelines

We're always looking for contributors to help us improve the SDK. Whether it's bug reports, feature requests, or pull requests - all contributions are welcome.

1. **Fork & Clone**: Fork this repository and clone it to your local machine.
2. **Set Up**: Run `pnpm install` from the repository root.
3. **Make Changes**: Create a new branch and make your changes.
4. **Test**: Run `pnpm --filter @bsv/wallet-toolbox-examples test`.
5. **Commit**: Commit your changes and push to your fork.
6. **Pull Request**: Open a pull request from your fork to this repository.
   For more details, check the
   [repository contribution guidelines](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md).

## Support & Contacts

Project Owners: Thomas Giacomo and Darren Kellenschwiler

Development Team Lead: Ty Everett

For questions, bug reports, or feature requests, please open an issue on GitHub or contact us directly.

## License

The license for the code in this repository is the Open BSV License. Refer to [LICENSE.txt](./LICENSE.txt) for the license text.

Thank you for being a part of the BSV Blockchain Libraries Project. Let's build the future of BSV Blockchain together!
