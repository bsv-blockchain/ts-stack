# Templates

Source to copy into your host and own. None of it is part of the package's API
and none of it carries a compatibility promise. Each file ships as `.ts`, so
import your copy, not the package path.

| file | what it owns | why it is not in the library |
| --- | --- | --- |
| `managed-invitations.ts` | the invitation exchange, from answer to join | its state spans a stored invitation, a private half, a chat row and an outbound Welcome; only your database can write those atomically |
| `client-lifecycle.ts` | which client exists, and when it is closed | the library cannot know when your identity changes or your screens unmount |
| `sql-shelf.ts` | where an answered invitation's private half waits | the library never stores private key material (invariant 1); a shelf that survives a restart must |
| `transcript.ts` | what was said, and the order its writes happen in | how long a transcript lives is the host's decision |
| `web-crypto-conformance.ts` | whether this runtime's WebCrypto can do the job | the library cannot probe a host's platform for it |

All four exist because of what the first real integration got wrong.
`__tests__/host-lifecycle.test.ts` reproduces the lifecycle defects against the
naive pattern; each template's own tests are the counterfactual.

Nothing here is required. A host that reads the invariants and writes its own
will be fine. The point is that a team which read them and was writing tests
still got three of these wrong, so copying a file that has been mutation-tested
is a better default than rediscovery.

## Managed invitations

Source to copy into your host and own. It is not part of the package's API and
carries no compatibility promise.

`@bsv/group-messaging` does not run the invitation exchange. Its state spans a
stored invitation, a KeyPackage's private half, the chat row and the outbound
Welcome, and the library cannot write those atomically through the storage seam.
Your database can. `managed-invitations.ts` is the smallest working version of
the bookkeeping that therefore belongs on your side.

### What each piece of state is for

- **The shelf** (`PrivateHalfShelf`) holds one `ShelvedInvitation` per answered
  invitation, keyed by `ref` and findable by `inviteId`: the private half, the
  public KeyPackage bytes that were sent, the peer that was answered, and the
  `chatId` the host chose. `peek` reads without removing; `take` removes as it
  returns, because a KeyPackage is single-use. The library never stores a
  private half, so if the shelf loses one, that join is gone.
- **`ChatIds`** maps the exchange to your local `chatId`, with one callback per
  side because the two sides see different ids. The inviter's `forAnswer` gets
  the id `invites.send` returned. The invitee's `forWelcome` is called at `accept`
  with the chat name the request carried, and its answer is shelved: the Welcome
  row carries a fresh library id that matches nothing passed to `accept`, so the
  shelved record, not the Welcome's own chat name, decides where a join files. The optional `nameFor(inviteId)` is a member of this
  host-supplied interface, not a library feature: it supplies the chat name the
  Welcome carries, and without it `forWelcome` receives `undefined`. A `chatId`
  is local and never goes on the wire.
- **`decline` and `abandon`** are the only things that retire a shelved record
  short of a join. A failed `accept` keeps it, and the retry resends the same
  KeyPackage: the send may have arrived with only its acknowledgement lost, and
  a fresh KeyPackage would leave the inviter admitting the first one. Both work
  after the answer went out, which is when they matter (the answer was sent and
  no Welcome came): they retire the record and the public ref, so the given-up
  KeyPackage resolves no later Welcome. The shelved `chatId` is fixed at
  `accept`; a join that fails because that chat already exists is not retried
  under another id, so choose ids that cannot collide.
- **`#answered`** stops one invitation being accepted twice by this host. Back it
  with a column on your invitation row.
- **`onFailure`** is where `admit` and `join` failures reach your UI. Nobody awaits
  a Welcome, so a failed join has no caller to throw to.

### Event-driven failures are reported, not thrown

`start()` subscribes to events nobody awaits, and `#detached` is what keeps those
subscriptions from producing an unhandled rejection. A Node host dies on the
first one, and the pending join dies with it without a trace. Anything that
throws inside the detached `admit` or `join` (`chatIds`, a shelf `take` or
`hold` hitting a dropped connection, `nameFor`) is caught and handed to
`onFailure` with the stage, the peer and a chat id. That chat id is the one
`chatIds` returned, or `unknown:<inviteId>` when `chatIds` is what threw. If
`onFailure` itself throws, that is swallowed, since there is nowhere left to
report to. A failed `join` is reported, not retried; the host decides whether to
try again.

This covers the event subscriptions only. `accept` is awaited by your code, so a
rejection from the shelf's `hold`, from `invites.accept` or from `keyPackages.create`
reaches the caller, who can and must handle it; the template does not route it to
`onFailure`. If you rewrite the template, keep both halves of that split.

### The shelf must survive a restart

`MemoryShelf` lasts as long as the process. A browser host wants an IndexedDB
shelf and a server host wants its database. A real host puts the record in
its secure store, in the same transaction that records the invitation as
answered, with a unique index on `inviteId` and the peer stored beside the half:
the peer is what a Welcome is checked against, so a store that drops it
re-opens the hijack below.
A half that is lost with the process makes every pending join unrecoverable, and
nothing on either side reports it. `sql-shelf.ts` below is that shelf for a host
with a `SqlDriver`; read its note on key material at rest before copying it.

### A redelivered Welcome is not a lost record

`#join` tracks the refs it is joining. A second Welcome for a ref whose join is
still running is a redelivery and is ignored: the record is absent because the
first join took it, not because it was lost. Only a record missing with no join
running is reported, as `unknown:<inviteId>` with `failure.ref` set. A host that
wants to stop waiting on the chat maps `ref` to `chatId` when it shelves, before
the answer is sent. With a real store that map is the shelved row itself, which
already carries `chatId`: look it up by `ref` instead of keeping a side map that
a restart would empty. The chat app keeps its map in memory, which is only
adequate because its shelf is also in memory.

### A Welcome joins only from the peer that was answered

The `ref` in a Welcome is cleartext. Anyone holding the public KeyPackage, the
inviter or any member who saw the Add, can name it and send a Welcome for their
own group. `#join` therefore looks the record up by `ref` and refuses a sender
that is not the recorded peer, reporting it through `onFailure`, before it takes
the half. The refused Welcome leaves the half shelved, so the genuine one still
joins. Keep that order if you rewrite it. The library enforces the same rule
first: `invites.accept` binds the KeyPackage to the peer it answered and refuses
any other sender's Welcome before a row is written, so a forger costs no storage
and `bootstrapRefused` is how you hear of it. This check is the backstop for a
ref the library never bound. A KeyPackage has one owner: `invites.accept` refuses
to answer a second peer with a KeyPackage already handed to the first, rather
than retarget the ref and turn the first peer's genuine Welcome away, so mint a
fresh one per invitation. A refusal is reported under `refused:<inviteId>`
rather than the chat it impersonated, so it cannot mark the genuine chat failed,
and a missing record is reported under `unknown:<inviteId>` with the Welcome's `ref` on the failure, which is how a host traces it to the chat it was waiting on: the Welcome's own
chat name is the sender's to choose and never names a chat.

### A lost Welcome must be kept and resent

If the Add succeeds and the Welcome's send fails, the library throws a
`WelcomeDeliveryError` carrying the Welcome bytes. A Welcome belongs to the
Commit that produced it and cannot be regenerated, so those bytes are the only
thing that can finish the join. The template resends them once with
`client.retryDelivery`; if that fails too it hands the error to `onFailure` as
`failure.undelivered`. A real host writes it to its outbox and retries on its
own schedule.

### Admitting someone already in the chat

MLS accepts a second leaf for an identity already in the tree, so a re-invite
would silently duplicate the member. The template refuses and reports it. That
is the template's policy, not an MLS constraint; change it if your product
re-adds members after they lose their state.

### What the host is still handed

1. A ref never answered through `invites.accept` (hand-minted or pooled) has no
   bound peer. There the library bounds forged Welcomes only per sender, one row
   per identity, and the template's sender check is the only protection.
2. The invitee is never told its answer was refused.
3. A `chatId` chosen twice concurrently can produce two groups.
4. A shelf that does not survive a restart loses every pending join.

## Client lifecycle

`client-lifecycle.ts`. One owner for the client's lifetime.

Three defects in the first real integration looked unrelated and were one
thing. A cache keyed `${chain}:${host}` with no identity in it, so switching
profile returned the previous profile's client and its chats. An open that
acquired a database handle and only built a `close` on the success path, so a
throwing `create` leaked it — and on that platform a leaked handle made
"delete the database" throw for the rest of the process. Two screens that each
decided when to open and close, so navigating between them closed the client
the other still held.

None of them needed anything the library does not offer. `client.identityKey`
says whose a cached client is, `close()` tears one down. They happened because
the rule had no owner.

`ClientOwner` is that owner:

```ts
const owner = new ClientOwner(key => ({
  acquire: () => openDatabase(`chats-${key.identityKey}.db`),
  create: database => GroupMessagingClient.create({ wallet, storage: database, transport }),
  release: database => database.closeAsync()
}))

const client = await owner.get({ identityKey, chain, host })
```

`ClientKey` makes `identityKey` mandatory, so the original defect is a compile
error. `acquire` and `create` are separate so the owner can run the
`try`/`catch`. A key change closes the old client before creating the new one,
awaited. Concurrent callers share one open.

### What the host is still handed

1. **Calling it from one place.** This owns the client; something still has to
   own this. One instance per component is the bug again with extra steps.
2. **Noticing the identity changed.** It answers what you ask. A UI that never
   re-asks after a profile switch never learns.
3. **Resubscribing.** Handlers on a closed client are dead. Re-register after
   any key change.

## SQL shelf

`sql-shelf.ts`. A `PrivateHalfShelf` that outlives the client.

The section above says the shelf must survive a restart, and lists losing it
as the fourth thing the host is handed. The first real integration read that
and used `MemoryShelf` anyway — rebuilding one per client open, so a relay
change or a navigation between `accept` and its Welcome dropped the half and
the join became unrecoverable, silently. The window is one relay round trip.
Shipping a working shelf is a better answer than warning harder.

```ts
const shelf = await SqlShelf.open(database)
await shelf.reap()                     // on open: a week-old half is waste
new ManagedInvitations(client, shelf, chatIds, onFailure).start()
```

**It writes key material to your database.** The half is an MLS private
KeyPackage. The library never stores it — invariant 1 holds — but a shelf that
survives a restart necessarily does, and that is a trade against losing joins,
not a free upgrade. Encrypt those columns if your database is not already
encrypted at rest, call `reap` so nothing accumulates, and keep it out of
unencrypted backups and crash reports. A host that cannot meet that should keep
`MemoryShelf` and tell the user to accept the invitation again — a defensible
choice, as long as it is a choice.

### What the host is still handed

1. **Scoping.** One table serves one identity. Several accounts sharing a
   database need a `tableName` each, or an identity column.
2. **Concurrency.** `take` is a read then a delete, not an atomic claim. One
   client per identity per process makes that safe; two do not.
3. **Encryption.** It stores what it is given.

## Transcript

`transcript.ts`. The record of what was said, and the order its writes happen in.

The library hands each message to a subscriber exactly once and keeps no log,
so every host writes the same table. The first one wrote two bugs into it.

**The read beat the write.** One subscription did `void transcript.append(...)`
and a screen's subscription on the same event did `void reload()`, which
SELECTs. Two un-awaited promises on one event: the SELECT could run before the
INSERT, so an arriving message did not appear until something else forced a
refresh. It read as "stale UI" and cost a day to diagnose. `Transcript.follow`
appends and only then tells anyone, so a listener that re-reads cannot miss the
row.

**Your own messages are not echoed.** MLS does not deliver a sender its own
message. Without `Transcript.record`, a sent message is gone on the next read —
and the 677-line screen that got this wrong had no test covering it.

```ts
const transcript = await Transcript.open(database)
transcript.follow(client)
transcript.onAppended(() => void redraw())

const content = textContent(draft)
const id = await group.sendContent(content)
await transcript.record({ chatId, sender: client.identityKey, content, id })
```

**The id comes from the library, not from here.** Every send returns the
`messageId` and every `message` event carries the same one, derived from the
ciphertext rather than chosen by the sender, so two clients agree without
having agreed on anything first. That is what `replyTo` and a reaction's
`reference` name. An earlier version of this template minted its own into
`extra.messageId`, which interoperated only with hosts that had copied the same
file.

### What the host is still handed

1. **Retention.** Nothing here deletes.
2. **Scoping.** One table per identity.
3. **Paging.** `list` returns a whole chat. Reading 10,000 rows to draw 20 is
   the other thing that integration did.
4. **Attachments.** Only the envelope is stored.

## WebCrypto conformance

`web-crypto-conformance.ts`. Can this runtime actually do what the MLS stack
needs? It imports nothing and probes whatever `SubtleCrypto` you hand it.

**This is the only safety net if you fill the gaps yourself, and you will have
to.** There is deliberately no shim here. We wrote one, reviewed it, and deleted
it: it passed this list twelve checks out of twelve and then could not mint a
KeyPackage, because `@hpke/core` reaches `exportKey('jwk')` with no fallback.
Crypto glue that stops getting fixes the moment it is copied is the wrong shape
for a template. `docs/2026-10-28-mls-crypto-on-react-native.md` has the worked
`@noble` approach and the eight traps we hit — the traps are the useful part.

`react-native-quick-crypto@0.7.17` has four holes — the `cfrg` family commented
out of `generateKey`, HMAC that imports but cannot sign, HKDF that cannot be
imported, EC `exportKey('jwk')` emitting malformed base64url — and none of them
is visible until the exact call is made. The integration found all four **one
failed exchange at a time**, over two days. One run of this shows all four, so
it never stops at the first failure.

```ts
const results = await checkWebCrypto(globalThis.crypto.subtle)
console.log(formatConformance(results))
```

**Self-consistency is not correctness, and neither is agreeing with a vector
you imported.** An earlier version of this list checked HMAC and HKDF against
RFC vectors and checked the two curves against themselves; a `subtle` whose
Ed25519 prefixed every message with `0x99` passed all twelve. Vectors fixed
that. Then a reviewer found four more adversaries that still scored full marks,
because every vector goes in through `importKey` and nothing exercised
`exportKey` — which is exactly where `react-native-quick-crypto`'s real defect
lives. The worst published the signing seed as the public key while the log
read "all checks passed".

So each curve now also does a round trip: generate, export both halves,
re-import, sign, verify. Four published vectors (RFC 8032, RFC 7748, RFC 4231,
RFC 5869) plus two export round trips plus a distinct-keys check that catches a
stuck generator — which a cross-derive check does not, since one constant pair
agrees with itself perfectly.

Run it in release builds too. Gating it on a dev flag means the one case it
never covers is a release build on an unfamiliar device.
