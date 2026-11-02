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
- `messageIdOf` and `MessageId`. `replyTo` and a reaction's `reference` always
  named an id the library did not define, so each host invented one and two
  hosts inventing differently did not interoperate. The id is derived from the
  MLS application message rather than chosen by the sender, so both ends reach
  it independently: every send returns it, every `message` event carries it,
  and `deliveryFailed` carries it for a send that did not get through. The send
  helpers return the id rather than nothing.
- `TransportService.onLiveStatus`, forwarding what the backend's live connection
  is doing. A host previously had to build the backend itself and keep a
  reference past the service to learn any of it. `LiveStatus` moves to the
  backend contract, so a backend other than MessageBox can report it too, and
  the current status is replayed to a handler that subscribes late — a screen
  mounted after the socket settled saw nothing until a transition that, on a
  healthy connection, never comes.
- A KeyPackage's `notBefore` reaches five minutes further back than the moment
  it was minted. An admitter validates the lifetime against its own clock and
  `ts-mls` runs that check unconditionally for a commit the caller is sending,
  so a peer whose clock read even a second later rejected the add outright with
  "Current time not within Lifetime" and the join could not be retried into
  working. `lifetimeSeconds` still means how far forward the package is good
  for. Verified on two devices with a 162-second skew between them.
- Four templates under `templates/`, alongside the managed invitation exchange:
  `client-lifecycle` (opening and closing a client without leaking a database a
  failed open had already acquired), `sql-shelf` (the private half of a
  KeyPackage, claimed exactly once), `transcript` (the message log, and the
  write ordering a host's driver does not promise) and
  `web-crypto-conformance` (which primitives a runtime actually has, answered
  before the first `keyPackages.create()` rather than after it). Each is
  machinery the first real host integration wrote from scratch and got wrong.
  They ship as source to copy and carry no compatibility promise.

Migrated from a standalone repository; the demo application that exercises this
package end to end, including a live MessageBox harness and an adversary suite,
stays there rather than moving with it.
