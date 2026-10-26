# Changelog

## [Unreleased]

### Added

- Initial migration of `@bsv/group-messaging` into ts-stack. End-to-end
  encrypted group messaging for BRC-100 wallets, with MLS (RFC 9420) group state
  by way of `ts-mls` and identity bound to the wallet's own secp256k1 key.
- `GroupMessagingClient` as the entry point, with the layers beneath it exported
  for callers who compose them differently: `IdentityService`, `StorageProvider`,
  `TransportService`, `MlsEngine` and `InviteService`.
- Storage backends for `Map`, SQL and IndexedDB; transport backends for an
  in-process hub and `@bsv/message-box-client`, the latter with optional live
  socket delivery and a polling backstop.

Migrated from a standalone repository; the demo application that exercises this
package end to end, including a live MessageBox harness and an adversary suite,
stays there rather than moving with it.
