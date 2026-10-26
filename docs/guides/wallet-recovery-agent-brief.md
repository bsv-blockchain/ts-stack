---
id: wallet-recovery-agent-brief
title: 'Wallet Recovery Implementation Brief for AI Agents'
kind: guide
version: '1.0.0'
last_updated: '2026-09-24'
last_verified: '2026-09-24'
review_cadence_days: 30
status: stable
tags: [wallet, recovery, backup, agents, implementation]
---

# Wallet recovery implementation brief for AI agents

Use this brief to prepare a concrete wallet implementation and its acceptance
evidence. It is technical task guidance; repository contribution instructions
remain in the root
[AGENTS.md](https://github.com/bsv-blockchain/ts-stack/blob/main/AGENTS.md)
and [CONTRIBUTING.md](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md).
It does not authorize production data access, a deployment or a real-money
transaction.

## Read and verify before editing

1. [Wallet backup and recovery](wallet-backup-recovery.md): the separate key,
   wallet-data, product-data and backup-access requirements.
2. [BRC-38/39 portability](wallet-data-portability.md): real API signatures,
   concrete-provider constraints, consistency limits and restore/merge semantics.
3. [Recovery drill](wallet-recovery-drill.md): fixture, negative tests and
   evidence requirements.
4. The wallet host's key manager, profile storage, file APIs, selected network,
   background writers and active-storage transition code.
5. The exact installed declarations and
   [portable implementation/tests](wallet-data-portability.md#standards-implementation-and-evidence).
   Record source commit and package versions; do not infer availability from
   an open PR, an old package README or a generated-looking API name.

## Copy and adapt this task

```text
Implement a reviewed wallet backup and recovery flow for this repository.

First report the current key manager, how keys can be recovered after device
loss, the selected profile/network model, storage provider, product data outside
Wallet Toolbox, and exact installed package versions. Identify gaps before
claiming complete recovery. Use synthetic fixtures; do not request or log real
keys, shares, passphrases, manager snapshots, exports or production records.

Use TS Stack's wallet-backup-recovery, wallet-data-portability and
wallet-recovery-drill guides. Verify every helper against current declarations.
Use the appropriate Node/browser/mobile package. Remote StorageClient or
StorageMobile is not a concrete StorageProvider: implement and verify the local
copy or trusted export path before wiring exportBRC39 into UI. Do not invent
wallet.exportBRC39(), archive streaming, cancellation or snapshot guarantees.

Provide encrypted export for the selected profile with a recoverable passphrase,
confirmed file-save completion, freshness information and clear exclusions.
Preserve library format/KDF defaults and enforce tested resource limits. Keep
key recovery and wallet-data backup as separate statuses and instructions.

For import, recover the expected identity independently, decrypt/validate for
preview, compare identity and network, then confirm target and explicit mode.
Reject profile changes between preview and write. Restore into an isolated,
migrated empty provider without creating a user first; never clear an existing
wallet to make restore pass. Offer merge only as a separate tested flow with a
pre-import backup. Keep imported endpoint/sync metadata from silently changing
storage authority. Leave monitor/broadcast/cutover disabled until acceptance.

Add meaningful host-level tests for saved-file reopen, wrong password/corrupt
file, wrong profile/network, nonempty target, interruption, stale backups,
resource limits and clean-device/provider-loss recovery. Verify transaction and
derivation records, relationships, tombstones and binary data; balance alone is
insufficient. Exercise restart and a controlled synthetic/testnet spend. Test
each claimed runtime and cross-wallet direction with exact versions.

Deliver implementation, user instructions, recovery inventory, acceptance
evidence and explicit unresolved limits. Distinguish implemented, locally
tested, device-tested and released behavior. Follow this repository's review
and CI requirements; production recovery/cutover requires separate authority.
```

## Review the result

- Can a new user find both recovery paths from onboarding, settings and an
  offline-accessible help page? Is “backup complete” tied to verified evidence?
- Does the implementation keep key material out of the archive and logs while
  acknowledging that wallet records themselves are highly sensitive?
- Is each selected profile/network bound throughout the operation, including
  asynchronous file selection, preview and commit?
- Does the provider actually implement the required methods without type casts
  that hide an unsupported remote-storage path?
- Does the consistency procedure stop every relevant writer to the export
  copy, with explicit limits for a continuously changing remote source?
- Are failure states visible and retries safe? Does cancellation avoid claiming
  rollback that the underlying API does not supply?
- Are expected records, key control and wallet behavior verified together on a
  clean device, including external/custom dependencies?
- Are release/version claims grounded in the
  [migration ledger](../reference/package-api-migrations.md) and the exact
  installed artifact, with future capabilities labelled as future work?

Record results using the [drill evidence template](wallet-recovery-drill.md#copyable-evidence-record).
For defects, supply the smallest synthetic reproduction through the root issue
templates. Suspected vulnerabilities belong in the
[private security process](https://github.com/bsv-blockchain/ts-stack/blob/main/.github/SECURITY.md),
not public recovery examples.
