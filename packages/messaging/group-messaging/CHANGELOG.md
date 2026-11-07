# Changelog

## [Unreleased]

- Prepare `0.1.0` with an SDK4 peer floor of `^4.0.1`; preserve all existing SDK2/3 alternatives and lower bounds. No wire or data migration.

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
- A complete invitation exchange: `invites.abandon` gives up an exchange and
  destroys the KeyPackage it minted, a KeyPackage minted by `invites.accept` is
  bound to the peer it was answered to and cannot be rebound, a Welcome naming a
  bound KeyPackage is joined only from the peer it was handed to, and
  `retryDelivery` resends a Welcome that never arrived without touching the
  group. A failed Welcome send surfaces as `WelcomeDeliveryError`. A KeyPackage
  minted by hand and published is bound to nobody, so a Welcome naming one is
  accepted from any sender and the host chooses between them.
- `MessageBoxTransport.onLiveStatus`, reporting what the live socket is doing.
  The socket's own recovery is left to `@bsv/message-box-client` 2.7.0, which
  reconnects and rejoins its rooms; this package follows that report and uses it
  for cadence, relaxing the poll to a backstop while the socket is live and
  returning it to the configured interval while it is not. Joining a room
  replays no backlog, so the poll remains the guarantee and the socket is a
  latency improvement over it.

Migrated from a standalone repository; the demo application that exercises this
package end to end, including a live MessageBox harness and an adversary suite,
stays there rather than moving with it.
