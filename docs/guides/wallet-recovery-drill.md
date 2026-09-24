---
id: wallet-recovery-drill
title: 'Wallet Recovery Drill and Acceptance Checklist'
kind: guide
version: '1.0.0'
last_updated: '2026-09-24'
last_verified: '2026-09-24'
review_cadence_days: 30
status: stable
tags: [wallet, recovery, backup, testing, interoperability]
---

# Wallet recovery drill and acceptance checklist

A successful download or matching balance is not sufficient recovery evidence.
Prove that an independently recovered key and retained data work together after
the original device or provider is unavailable. Start with the
[recovery inventory](wallet-backup-recovery.md#what-must-survive) and
[BRC-38/39 integration guide](wallet-data-portability.md).

This is a reusable acceptance plan, not a claim that TS Stack or any wallet has
passed every scenario. Use synthetic wallets and local/testnet fixtures. A
production restore, provider promotion or real-money spend needs a separate
operator-approved procedure; do not use this checklist to authorize one.

## Prepare a representative fixture

Record exact wallet/package versions, network, storage backend, device/runtime,
schema/migrations, selected profile and recovery point. Use at least two
distinct wallet identities so accidental cross-profile handling is detectable.
Include:

- incoming and outgoing transactions; spent and unspent outputs;
- derivation prefixes/suffixes, sender identities, scripts and any supported
  custom spending instructions;
- multiple baskets, tags, labels and map relationships, including tombstones;
- certificates/fields and their required keys;
- linked proof records, pending broadcast/proof state and sync state;
- product-owned contacts, trust settings or files that need a separate backup;
- enough records and large byte payloads to exercise the supported device's
  limits, rather than only an empty wallet.

Keep an independent expected inventory. The archive has 13 table arrays;
backend sync protocols may count their entity stores differently. Compare
relationships and values, not just a single total or balance. Make explicit
which product data is excluded and how it is restored separately.

## Rehearse the full sequence

1. **Protect the original.** Keep existing known-good recovery material and
   versioned data copies. Provision an isolated recovery target. Disable its
   automatic broadcasting, monitor side effects and writes to production
   providers through the host's tested controls.
2. **Establish a recovery point.** Quiesce a local source or use a consistent
   database backup. Export the selected profile, save the encrypted file and
   verify it can be reopened. Record the time and expected inventory without
   logging secrets or plaintext records.
3. **Remove the original dependency.** Use a clean installation/device/profile
   with no original browser storage, manager snapshot or cached credentials.
   Simulate provider unavailability. Do not actually erase the sole original.
4. **Recover signing authority independently.** Follow the product's key/share
   recovery instructions. Derive the identity and compare it with the expected
   profile. Test any required privileged keys or external signer separately.
5. **Preview and import data.** Confirm archive identity, network and mode.
   Restore into empty, migrated storage with exclusive access. Keep the
   recovered copy isolated while checking all expected records and product data.
6. **Reconcile current state.** Verify transaction bytes, relationships,
   tombstones, output ownership and derivation. Revalidate proofs and current
   spend state through supported services. Resolve pending transactions using
   existing transaction identities; do not create replacement payments merely
   because confirmation was lost.
7. **Exercise wallet behavior.** Read history and basketed outputs through
   normal APIs, prove key control with a harmless challenge, and spend a known
   synthetic/testnet fixture under controlled conditions. Include custom
   scripts and certificate/decryption behavior if the product supports them.
   Key possession alone does not prove those assets are usable.
8. **Restart and verify again.** Confirm state survives restart, repeated reads
   agree, and the tested merge/sync retry does not duplicate or lose semantic
   records. The `restore` mode intentionally rejects a now-nonempty target;
   repeat restoration uses another empty target.
9. **Approve cutover separately.** Resolve active-storage authority, endpoint
   trust and sync policy before reconnecting writers or promoting a provider.
   Keep the original protected until acceptance is complete; retain evidence
   and a rollback plan for the cutover.

## Minimum acceptance matrix

| Scenario                                                | Expected result                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Clean-device recovery                                   | Same independently derived wallet identity; expected records and tested wallet behavior restored without the original installation    |
| Seed/key only                                           | Product explains missing data and offers recovery from an available backup; does not report complete recovery                         |
| Archive only, missing root key                          | Data can be inspected by an authorized holder of its passphrase, but product does not claim signing authority                         |
| Lost provider                                           | Independent key and data copies remain accessible; document any dependency that still prevents recovery                               |
| Wrong password, truncated file or modified tag          | Clear failure; no activation or modification of the existing wallet                                                                   |
| Unsupported header, invalid fields or broken references | Rejected before import; original archive retained                                                                                     |
| Wrong profile or network                                | Host blocks before writes; profile switching during preview/commit cannot redirect the import                                         |
| Nonempty restore target                                 | Explicit rejection; no automatic deletion, overwrite or fallback to merge                                                             |
| Interrupted import or lost save acknowledgement         | Product identifies uncertain/incomplete state and offers a safe retry; no false “backed up” or “restored” status                      |
| Old backup after new receives/spends                    | Product shows the recovery point and unresolved gap; stale spendable flags do not authorize a spend                                   |
| Repeated merge/sync                                     | No duplicated semantic transactions/outputs or revived tombstones; compare data rather than demanding zero bookkeeping updates        |
| Concurrent source writes                                | Export uses the documented consistency procedure; no claim that sequential reads form a database snapshot                             |
| Low-memory device and large file                        | Enforced product limits, measured peak memory/time and usable failure/progress UI; no weakened cryptography                           |
| Browser eviction, app uninstall, device loss            | Recovery succeeds through independent copies, or the exact unsupported case is clearly disclosed                                      |
| Vendor A export → vendor B import                       | Same identity/network and compatible row semantics; unsupported product extensions disclosed; test the reverse direction when claimed |
| Key/share or passphrase dependency unavailable          | Document the supported combinations and actual failure behavior; no circular recovery assumption                                      |

For operator backups, additionally restore a retained database backup into a
separate environment, apply only reviewed schema migrations, restore required
external data and secret-store access, and measure actual recovery time/data
loss. Keep monitor/background jobs disabled until their side effects and
replay state have been reviewed. Replicas, backups and service health are
separate evidence.

## Diagnose failures without destroying evidence

| Symptom                                  | Safe next step                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| File cannot decrypt                      | Check original bytes and passphrase entry; do not modify KDF/header fields or promise a password reset                                     |
| Import rejects target                    | Inspect network, schema and emptiness; provision a new isolated store rather than clearing the existing one                                |
| Data imports but wallet identity differs | Stop before activation; recover the correct key/profile and repeat preview                                                                 |
| Balance/history differs                  | Compare full data inventory, backup time, relationships, pending state and product exclusions; do not rely on rescan as a universal repair |
| Proofs are stale or a spend fails        | Use supported canonical proof/status recovery; preserve transaction IDs and avoid duplicate payment attempts                               |
| Merge or sync was interrupted            | Preserve both sides; inspect committed state and use the tested retry path or restore the isolated target from its pre-import backup       |
| Schema migration fails                   | Preserve the database and migration journal; follow the version-specific recovery procedure, never delete journal rows blindly             |

## Copyable evidence record

Store real recovery evidence privately. Public records should use synthetic
fixtures and redact wallet identifiers, balances and storage topology when
they are sensitive. Never include keys, shares, passphrases, manager snapshots
or plaintext/export files.

```text
Recovery drill ID / date / owner:
Wallet version / source commit / exact package versions:
Runtime / device / network / backend / schema version:
Synthetic fixture ID / profile count / data classes covered:
Key recovery method / unavailable factors tested (no secret values):
Data recovery method / consistent recovery point / archive digest:
Product data included / excluded / separate restoration method:
Source device/provider dependencies removed for the drill:
Restore or merge target and authority decision:
Expected vs actual inventory / relationships / binary-data verification:
Identity / read / controlled spend / restart / retry outcomes:
Negative, resource-limit and cross-wallet scenarios with results:
Observed data-loss interval / restore duration vs declared objectives:
Unresolved gaps / user-visible limitations / remediation owner:
Cutover authorized separately? / rollback evidence:
Reviewer / next drill due / evidence location:
```

Use “passed” only for an executed scenario with retained evidence. Keep
unexecuted tests and unsupported recovery paths visible. Feed failures back
into the [product guidance](wallet-backup-recovery.md#make-recovery-understandable-in-the-product)
and [agent implementation brief](wallet-recovery-agent-brief.md).
