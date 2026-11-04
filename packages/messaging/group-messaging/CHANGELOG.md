# Changelog

## [Unreleased]

## [0.2.0] - 2026-11-04

### Added

- `messageIdOf` and `MessageId`. `replyTo` and a reaction's `reference` always
  named an id the library did not define, so each host invented one and two
  hosts inventing differently did not interoperate. The id is derived from the
  MLS application message rather than chosen by the sender, so both ends reach
  it independently: every send returns it, every `message` event carries it,
  and a send that did not get through carries it both on the `deliveryFailed`
  event and on the `BroadcastError` it rejects with. The event is client-wide
  and names only the chat, so the rejection is the only place a host with two
  sends in flight can tell them apart, and a retry that fails again carries the
  same id. The send helpers return the id rather than nothing, and
  `Reaction.reference`, `MessageContent.replyTo` and the `reference` arguments
  to `sendReply` and `sendReaction` are typed `MessageId` rather than `string`
  — an alias, so nothing breaks; it just says which string is meant.
- `TransportService.onLiveStatus`, forwarding what the backend's live connection
  is doing. A host previously had to build the backend itself and keep a
  reference past the service to learn any of it. `LiveStatus` moves to the
  backend contract, so a backend other than MessageBox can report it too, and
  the connection phase is replayed to a handler that subscribes late — a screen
  mounted after the socket settled saw nothing until a transition that, on a
  healthy connection, never comes. A `delivered` report describes one batch
  rather than the connection, so it is not what gets replayed, and two
  identical ones in a row are both reported rather than deduped. `close()`
  releases the live-status handlers it was given, on the backend and through
  `TransportService` alike. `LiveStatus` is exported from the transport barrel
  where it is declared, as well as from the MessageBox backend.
- A KeyPackage's `notBefore` reaches five minutes further back than the moment
  it was minted. An admitter validates the lifetime against its own clock and
  `ts-mls` runs that check unconditionally for a commit the caller is sending,
  so a peer whose clock read even a second later rejected the add outright with
  "Current time not within Lifetime" and the join could not be retried into
  working. The window reaches that far past `lifetimeSeconds` at both ends, so
  an admitter whose clock runs either way is covered and a short
  `lifetimeSeconds` stays usable across devices. `lifetimeSeconds` still means
  how far forward the package is good for. Verified on two devices with a 162-second skew between them.
- Four templates under `templates/`, alongside the managed invitation exchange:
  `client-lifecycle` (opening and closing a client without leaking a database a
  failed open had already acquired), `sql-shelf` (the private half of a
  KeyPackage, claimed exactly once), `transcript` (the message log, the
  write ordering a host's driver does not promise, and recording the sender's
  own copy on both arms of a send, since the group advanced whether or not
  delivery did) and
  `web-crypto-conformance` (which primitives a runtime actually has, answered
  before the first `keyPackages.create()` rather than after it). Each is
  machinery the first real host integration wrote from scratch and got wrong.
  They ship as source to copy and carry no compatibility promise. A
  `./templates/*` export subpath makes them reachable from a consumer.

## [0.1.0] - 2026-10-28

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
