# @bsv/group-messaging

End-to-end encrypted group messaging for BRC-100 wallets. Group state is MLS
(RFC 9420) by way of [`ts-mls`](https://www.npmjs.com/package/ts-mls); identity
is the wallet's own secp256k1 key, bound into each member's MLS credential so a
peer cannot join a group under a name that is not theirs.

The library opens no database and no network connection of its own. It uses the
storage and transport the host already has.

## ⚠️ Security status

Early release, `0.x`, and not yet something to put a user's safety on.

`ts-mls`, which is the entire cryptographic core here,
[states](https://www.npmjs.com/package/ts-mls#%EF%B8%8F-security-disclaimer) that
it has not undergone a formal security audit. That applies to this package by
inheritance. The layer added on top of it — the wallet attestation carried inside
each MLS credential — has had no external audit either; it has been reviewed by
reading, and the forgery paths it is meant to stop are covered by tests, which is
not the same thing as an audit having been done.

It has not been tested against any other MLS implementation. The content envelope
and the bootstrap wire format are versioned but not frozen, and `ts-mls` is
pinned exactly rather than by range because its releases have changed the key
schedule inside a minor bump — peers on different `ts-mls` versions may not
interoperate.

Provided as-is. Use at your own discretion.

## Install

```bash
npm install @bsv/group-messaging @bsv/sdk
```

`@bsv/sdk` is a required peer dependency. The package supports Node.js 22 and
newer, runs in the browser, and publishes ESM and CommonJS entry points.

## Quick start

```ts
import { GroupMessagingClient } from '@bsv/group-messaging'
import { WalletClient } from '@bsv/sdk'

const client = await GroupMessagingClient.create({
  wallet: new WalletClient(),
  storage: sqlDriver, // whatever database the host already has
  transport: messageBoxClient
})

const minted = await client.keyPackages.create() // keep the private half

const group = await client.createGroup({
  chatId: 'project-alpha',
  members: [bobKeyPackage],
  privateKeyPackage: minted.privateKeyPackage
})

await group.sendText('hello')

client.on('message', ({ chatId, sender, content }) => {
  console.log(chatId, sender, content)
})
```

`create()` is async because a wallet may prompt the user for their identity key
and a database may need its tables created. It also starts listening; call
`listen()` yourself only if you constructed the client directly.

## Inputs

Each of the three inputs accepts several shapes, so the client can sit on top of
whatever the host already runs.

| Input       | Accepts                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `wallet`    | a BRC-100 `WalletClient`, a `KeyDeriver`, or a bare root `PrivateKey`                       |
| `storage`   | a `SqlDriver`, an `IDBDatabase`, a `Map`, a `StorageProvider`, `"memory"`, or `"indexeddb"` |
| `transport` | a `MessageBoxClient`, a `TransportBackend`, or a `TransportService`                         |

`storage: "indexeddb"` is the one case where the library opens something itself,
for a browser caller with no database to hand. Every other backend is supplied.

Storage is scoped to the client's identity: one host database serves however
many accounts the wallet manages, because the client narrows the provider with
`StorageProvider.scopeTo(identityKey)` before using it.

## The invitation handshake

A group cannot be built until the inviter holds the invitee's KeyPackage, so
membership starts with a bootstrap exchange over the transport. Alice invites
Bob:

```ts
// Alice asks Bob for a KeyPackage.
const inviteId = await alice.invites.send(bobIdentityKey, { chatName: 'Project Alpha' })

// Bob is asked. Nothing is minted until he accepts.
bob.on('inviteReceived', async ({ inviteId }) => {
  const minted = await bob.keyPackages.create()
  await keepSomewhereSafe(minted.ref, minted.privateKeyPackage) // the host's job
  await bob.invites.accept(inviteId, minted.keyPackage)
})

// Alice gets an answer whose credential proves it is Bob's.
alice.on('keyPackageReceived', async ({ keyPackage }) => {
  const own = await alice.keyPackages.create()
  await alice.createGroup({
    chatId: 'project-alpha',
    members: [keyPackage],
    privateKeyPackage: own.privateKeyPackage
  })
})

// Bob is added. Nothing is joined until he says so.
bob.on('welcomeReceived', async ({ inviteId, ref }) => {
  if (ref === undefined) return // not encrypted to a KeyPackage we hold
  await bob.joinFromWelcome({
    inviteId,
    chatId: 'project-alpha',
    privateKeyPackage: privateHalfFor(ref)
  })
})
```

Two refusals are worth handling rather than ignoring:

- **`keyPackageRejected`** — a peer answered with a KeyPackage whose credential
  names somebody else, or one that could not be read. The KeyPackage is
  deliberately not carried on the event, because there is no safe use for it.
  The invitation is consumed either way, so the exchange must restart.
- **`bootstrapRefused`** — a peer answered an invitation this client never
  issued. The library refused it; the event is the only record. This is the
  check that stops a stranger inserting their KeyPackage into someone else's
  exchange.

Bootstrap envelopes carry no signature of their own, so `peer` on an invite is
exactly as trustworthy as the transport's sender authentication and no more.
Over MessageBox that is a BRC-31 authenticated identity. Over a transport that
does not authenticate senders, treat it as a hint.

## KeyPackage lifecycle

This is the part most easily got wrong, because a KeyPackage looks like a
long-lived key and is not one.

**A KeyPackage is an entry ticket, not a chat key.** It is consumed once, at the
moment its holder enters a group. Its init key exists to decrypt exactly one
Welcome; its leaf node becomes that member's leaf in the ratchet tree. After
that, the member's position in the group is maintained by the tree — and the
leaf key rotates on every Commit. Nothing about continued access depends on the
KeyPackage still existing. RFC 9420 §10 is explicit that KeyPackages "are
intended to be used only once and SHOULD NOT be reused."

**The library stores the public half only.** `keyPackages.create()` returns both
halves and keeps only the public one, keyed by its RFC 9420 ref. The private
half is handed back once and forgotten — storing it is the host's job and this
library's prohibition.

```ts
const minted = await client.keyPackages.create()
minted.ref // stored here, so a Welcome can be matched to it
minted.keyPackage // public: publish this, send it to an inviter
minted.privateKeyPackage // yours to keep, and yours alone to destroy
```

A ref is spent at two points:

| Point                      | What consumed it                        |
| -------------------------- | --------------------------------------- |
| `joinFromWelcome` succeeds | the init key decrypted the Welcome      |
| `createGroup` succeeds     | the leaf node became the founder's leaf |

After either, that ref should be retired and the matching private half
destroyed. Both halves matter, and only one of them is reachable from here:

- **Retiring the public ref** stops it matching future Welcomes.
  `keyPackages.refFor()` matches any Welcome ref still in storage, so a ref that
  is never retired stays eligible forever — and a second Welcome encrypted to
  the same init key is precisely the reuse RFC 9420 warns against.
- **Destroying the private half** is what preserves forward secrecy. An init
  private key kept after joining lets anyone who later compromises the device
  decrypt a captured Welcome and recover the group secrets of that epoch. The
  library cannot do this for you; it never had the bytes.

Retiring the public half is automatic: a successful `joinFromWelcome` or
`createGroup` forgets the ref it spent and emits `keyPackageConsumed` naming
it. That event is the signal to destroy the private half, which is the part the
library cannot reach.

```ts
client.on('keyPackageConsumed', ({ ref }) => {
  secureStore.delete(ref) // the half that forward secrecy turns on
})
```

Destroying it does not cost you the group. `PrivateKeyPackageBytes` carries
three keys, and entering a group consumes only one of them: the init key, which
decrypts a single Welcome and which a founder never uses at all. The other two —
the leaf encryption key and the signature key — are copied into the MLS group
state when you join or create, and that state is what `putGroup` persists. Your
standing in the tree, and your ability to commit, update and send afterwards,
lives there and not in the KeyPackage.

A ref that was never spent — expired, or a pool entry being rotated — is
retired on request:

```ts
await client.keyPackages.retire(ref)
```

Nothing is retired when the operation fails, so a join that threw can be
retried with the same pair.

**Publish a small pool, not one forever.** Retiring a ref means this device
cannot be invited anywhere until it mints and publishes another. That is why MLS
deployments keep a handful of unconsumed KeyPackages available, hand out one per
invitation, retire on consumption, and top the pool up. `keyPackages.list()` and
`keyPackages.get(ref)` exist for exactly that bookkeeping — `get` returns the
public bytes of an unconsumed KeyPackage so it can be republished.

Leaving a chat is unrelated. By then the ref was consumed at join, long before;
leaving is an MLS removal plus dropping local state, and touches no KeyPackage.

## Sending and receiving

`Group` carries the content helpers:

```ts
await group.sendText('hello')
await group.sendMarkdown('# heading')
await group.sendReaction({ messageId, emoji: '+1' })
await group.sendReply({ messageId, body: 'agreed' })
await group.sendRemoteAttachment(attachment, 'the spec')
await group.sendContent(content) // the v1 JSON envelope directly
await group.send(bytes) // opaque payload, no envelope
```

Membership and state:

```ts
await group.info()
await group.addMembers([keyPackage])
await group.removeMembers([identityKey])
await group.update() // rotate this member's leaf key
await group.delete() // drop local state for the chat
```

Inbound traffic is delivered through events. A subscriber that throws is
isolated: it cannot abort the delivery loop or stall a queue drain, and its
error surfaces as `processingFailed`.

| Event              | Meaning                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `message`          | an application message, decrypted, with the epoch it was sent in            |
| `membership`       | members added or removed                                                    |
| `epochMismatch`    | `queued` while awaiting the opening Commit, or `dropped` when unrecoverable |
| `deliveryFailed`   | delivery failed for some members; the group still advanced locally          |
| `processingFailed` | an inbound payload could not be processed; delivery continues               |

A message more than four epochs behind the group cannot be opened — `ts-mls`
retains keys for four epochs — so it is dropped and reported rather than retried
forever.

## Composing the layers

`GroupMessagingClient` is a facade. Every layer under it is exported for callers
who want to compose them differently or swap one out: `IdentityService`,
`StorageProvider`, `TransportService`, `MlsEngine`, `InviteService`, and the
storage and transport backends.

`MlsEngine` is the only module permitted to import `ts-mls`.

## Design notes for consumers

- **`chatId` is local and never goes on the wire.** `mlsGroupId` is the only
  cross-party identifier. Likewise `inviteId` is local; the wire carries
  `requestId`.
- **Branded types are a guard rail.** `KeyPackageBytes` and
  `PrivateKeyPackageBytes` are distinct types so the wrong one cannot be sent.
  Do not cast between them.
- **One client per identity per process.** Identity scoping lets several
  accounts share one database; it does not let two clients share one account.
  Group locks are per-instance, so two clients built for the same identity will
  race on group writes.
- **`close()` waits for an in-flight poll.** That is deliberate — it is what
  stops a poll acknowledging messages no subscriber received — but a host that
  cannot trust its own handlers should put a timeout around shutdown.

## API

See [API.md](./API.md), generated from `src/index.ts`:

```bash
npm run doc
```

## License

Licensed under the Open BSV License Version 6; see [LICENSE.txt](./LICENSE.txt).
