---
id: wallet-backup-recovery
title: 'Wallet Backup and Recovery'
kind: guide
version: '1.0.0'
last_updated: '2026-09-24'
last_verified: '2026-09-24'
review_cadence_days: 30
status: stable
tags: [wallet, backup, recovery, brc100, brc38, brc39]
---

# Wallet backup and recovery

**A BRC-100 wallet recovery plan needs both recoverable root key material and
the wallet's records, including derivation metadata.** A seed or private key
alone is not a complete Wallet Toolbox backup. A database or BRC-39 export alone
does not restore the user's signing authority. Build and test both recovery
paths before asking users to depend on the wallet.

This guide is for wallet builders and storage operators. An application using
`WalletClient` should direct users to their wallet's recovery controls; it
should not request their private keys or implement a wallet backup by listing
only the application's visible transactions.

## Follow the complete recovery path

| Task                                                  | Resource                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Decide what must survive a lost device or provider    | This guide's recovery inventory and responsibility table                                                   |
| Implement encrypted file export and import            | [BRC-38/39 wallet data portability](wallet-data-portability.md)                                            |
| Prove recovery and handle failures                    | [Recovery drill and acceptance checklist](wallet-recovery-drill.md)                                        |
| Give an AI coding agent a bounded implementation task | [Wallet recovery agent brief](wallet-recovery-agent-brief.md)                                              |
| Understand storage and wallet boundaries              | [Wallet Toolbox](../packages/wallet/wallet-toolbox.md), [BRC-100 architecture](../architecture/brc-100.md) |

## What must survive

BSV wallet outputs can depend on protocol identifiers, counterparties, derivation
prefixes/suffixes and custom spending instructions. Wallet-local records also
associate transactions with baskets, labels, certificates and pending work.
These are not all recoverable by scanning the chain with a root key. On-chain
transaction availability is not a substitute for retaining the metadata needed
to identify and spend the user's outputs.

Keep an inventory for **each profile and network**, with these separate parts:

| Recovery component             | Examples                                                                                                                                                    | What it does not replace                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Key recovery                   | Root key, or sufficient independently recoverable shares/factors for the product's actual key manager; any required privileged keys                         | Wallet transaction and derivation records                   |
| Wallet data                    | Transactions, outputs and scripts, derivation metadata, baskets, tags, labels, certificates, proof/broadcast state and sync relationships                   | Root key, application login or key-manager recovery factors |
| Product data and configuration | Profile mapping, contacts/trust decisions, application settings, external content, supported spending modules and independently verified service identities | Neither key nor wallet-data recovery                        |
| Backup access                  | BRC-39 passphrase, backup encryption keys, vault access, provider-independent instructions                                                                  | The protected data itself                                   |

Inventory external signing devices and custom scripts separately: preserving a
`customInstructions` field does not install the implementation or recover an
external co-signer. A wallet-manager `saveSnapshot()` is another distinct
artifact. Some manager snapshots contain root/privileged key material; treat
them as wallet-equivalent secrets, but do not assume they include the storage
database. Read the chosen manager's contract.

Avoid circular recovery dependencies. A backup that requires a password
manager, mailbox or cloud account accessible only from the lost wallet/device
does not provide an independent recovery path. A device-bound keystore protects
secrets at rest; verify how those secrets can be recovered after that device
is gone.

## Choose complementary protections

| Mechanism                                             | Useful for                                             | Required qualification                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Key vault or threshold recovery                       | Recovering signing authority                           | Prove recovery without the lost device and with the stated provider/factor unavailable                                    |
| Storage-provider replication                          | Availability and maintaining another data copy         | Monitor lag and failures; replication can propagate mistakes and deletion                                                 |
| Versioned database backups and point-in-time recovery | Operator disaster recovery and rollback                | Use a database-supported consistent backup, preserve schema/migrations and required external stores, and test restoration |
| Per-user BRC-39 file                                  | User-controlled data recovery and vendor/provider exit | Pair with separate key recovery; verify freshness, completeness, passphrase access and target compatibility               |

Keep a retained backup outside the failure domain of the live store. For
example, an operator may combine a managed key vault with an independent
offline recovery copy, and database backups with versioned retention. That is
a design pattern, not a guarantee: test the vault permissions, decryption keys,
database restore and provider-loss scenario together. A daily backup can leave
up to a day of new wallet records unprotected; choose and disclose a recovery
point objective (maximum acceptable data loss) and recovery time objective
(time to usable recovery) appropriate to the product.

`WalletStorageManager.addWalletStorageProvider(...)` and `updateBackups()`
provide storage replication building blocks. They do not create an off-site
retention policy, recover keys, or certify a recovery point. The
[SQLite backup example](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox-examples/src/backup.ts)
creates a sensitive data copy; see its
[safety instructions](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox-examples/README.md#security-and-operational-safety).
Do not copy a running SQLite database as an ordinary file and assume its WAL or
journal was captured consistently. Use the database's supported backup process
or a verified closed-database copy.

## Assign responsibilities explicitly

| Owner                            | Must provide and verify                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet product                   | Key recovery, profile/network selection, encrypted data export/import, backup reminders/status, product-data coverage, independent recovery instructions and a tested restore flow |
| Storage operator                 | Consistent retained data backups, encryption and access control, retention and restore objectives, monitoring, schema compatibility and a rehearsed provider recovery plan         |
| User or organizational custodian | Custody of the chosen recovery material and export passphrase, accessible copies, and periodic checks using the product's instructions                                             |
| Application developer            | Durable application-specific data where applicable; clear links to the wallet's recovery controls without collecting wallet secrets                                                |

For hosted storage, document whether the user can recover data when the provider
is permanently unavailable. A provider's successful backup job is not proof
that the user can access or restore that backup. For browser/mobile wallets,
test browser storage eviction, app removal and device replacement; local
IndexedDB or app storage can disappear with the device or profile.

The [WAB Shamir guide](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/docs/wab-shamir.md)
describes **key** recovery. Its share threshold, server independence and
authentication requirements must be tested separately from data restoration.
An OTP, phone-number change or recovered share does not retrieve lost wallet
records. Storage operators should also use the
[Wallet Infra operations guide](../infrastructure/wallet-infra.md).

## Make recovery understandable in the product

Present separate statuses for key recovery and wallet-data backup. Show the
selected profile/network, last completed export or backup time, last successful
restore test, and any records created since the recovery point. Do not mark a
wallet “fully backed up” merely because a seed was displayed, a download was
started, or a remote replica is reachable.

Suggested wording to adapt to the product's verified behavior:

> **Keep both parts.** Your recovery key restores control of this wallet. Your
> wallet-data backup restores the records needed to use it. Keep an accessible
> copy of each, protected separately.

> **Export wallet data.** This password-protected file contains the selected
> wallet's transaction history and metadata. It does not contain your root key
> or replace your key-recovery instructions. Keep its passphrase recoverable.

> **Recovery still needs verification.** Import has completed. Before using this
> wallet, we need to check its identity, network, records and current spend state.

Explain what is excluded, how often to export, where recovery instructions
remain available during an outage, and how to get help without sending private
keys, snapshots, passphrases or exports to support. Make error messages usable
with keyboard navigation and assistive technology; expose stage/progress and
retry instructions without placing secrets or wallet records in telemetry.

## Treat recovery as an ongoing capability

Run the [recovery drill](wallet-recovery-drill.md) before release and after
changes to key management, schema, storage backend, archive implementation or
supported device runtime. Test against the exact packages being distributed;
source `main`, an open PR and a published package are different states. Consult
the [package migration ledger](../reference/package-api-migrations.md),
[support policy](../about/versioning.md#support-policy) and
[published security advisories](https://github.com/bsv-blockchain/ts-stack/security/advisories).
Historical security minimums are not recommendations to pin an older version.

Keep this recovery set aligned with implementation and test evidence. Use
synthetic fixtures for public bug reports and compatibility demos. A short
cross-wallet import/export demonstration is useful interoperability evidence;
it does not establish recovery after total device/provider loss or preservation
of every product's custom state.
