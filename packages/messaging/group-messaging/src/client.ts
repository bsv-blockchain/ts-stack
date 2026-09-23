import { decodeEnvelope, encodeEnvelope, type Envelope } from './bootstrap/index.js'
import { bytesEqual, fromHex, randomId } from './bytes.js'
import { decodeContent, type MessageContent } from './content/index.js'
import { GroupMessagingError, PermanentProcessingError } from './errors.js'
import { Emitter } from './events.js'
import { Group } from './group.js'
import { IdentityService, type IdentityInput } from './identity/index.js'
import { InviteService } from './invites/index.js'
import { MlsEngine, type MlsProcessResult } from './mls/index.js'
import { StorageProvider, type StorageInput } from './storage/index.js'
import { TransportService, type TransportInput } from './transport/index.js'
import {
  DEFAULT_CIPHERSUITE,
  type ChatId,
  type CiphersuiteChoice,
  type IdentityKey,
  type InviteId,
  type KeyPackageBytes,
  type KeyPackageOptions,
  type KeyPackageRef,
  type MintedKeyPackage,
  type MlsCiphersuiteName,
  type MlsGroupId,
  type PrivateKeyPackageBytes,
  type Unsubscribe
} from './types.js'

export interface GroupMessagingClientOptions {
  /** A BRC-100 `WalletClient`, a `KeyDeriver`, or a bare root `PrivateKey`. */
  wallet: IdentityInput
  /** A `SqlDriver`, an `IDBDatabase`, a `Map`, a `StorageProvider`, or `"memory"`. */
  storage: StorageInput
  /** A `MessageBoxClient`, a `TransportBackend`, or a `TransportService`. */
  transport: TransportInput
  ciphersuite?: CiphersuiteChoice
}

/**
 * How far behind the group a queued message may be and still decrypt.
 *
 * `ts-mls`'s `retainKeysForEpochs` defaults to 4, so a message held while more
 * than four Commits go by can never be opened: `processMessage` throws before
 * the engine reaches it. Such a message is dropped and reported rather than
 * retried forever.
 */
const RETAINED_EPOCHS = 4n

/** What the drain decided about one queued payload. */
type Consumed =
  | { verdict: 'keep' }
  | { verdict: 'skip' }
  | { verdict: 'applied'; state: Uint8Array; announce: () => void }

/**
 * How many payloads may be held for a group this device has not joined yet.
 *
 * A Welcome does not name its group — the id sits in `encrypted_group_info`,
 * behind the init private key this library never holds — so what is held
 * cannot be checked against the invitation justifying it until the join. The
 * cap is what keeps that gap from being a write amplifier.
 */
const MAX_HELD_BEFORE_JOIN = 64

/**
 * How many groups this device has not joined may hold payloads at once.
 *
 * {@link MAX_HELD_BEFORE_JOIN} bounds one queue, but `mlsGroupId` is cleartext
 * framing the sender chooses, so a per-group bound alone multiplies: one peer
 * can mint ids without limit and pay that cost once per id. A window this wide
 * still covers the real case, which is a handful of invitations outstanding at
 * the same time.
 */
export const MAX_GROUPS_HELD_BEFORE_JOIN = 8

/**
 * How far ahead of the group an epoch may be and still be worth holding.
 *
 * `groupId` and `epoch` are cleartext framing on a `PrivateMessage`, so both
 * are attacker-chosen until the message is actually opened. A payload claiming
 * an epoch this far ahead is not a reordered message, it is a claim no
 * sequence of Commits will reach in the life of the queue.
 */
export const MAX_EPOCH_LOOKAHEAD = 64n

/** How many payloads may wait for one group's next Commit. */
export const MAX_PENDING_PER_GROUP = 256

/** How many bytes of payload may wait for one group's next Commit. */
export const MAX_PENDING_BYTES_PER_GROUP = 1_048_576

export interface ClientEvents {
  /** An application message, decrypted. */
  message: {
    chatId: ChatId
    mlsGroupId: MlsGroupId
    sender: IdentityKey
    /** The epoch the message was sent in, which may predate the current one. */
    epoch: bigint
    content: MessageContent
  }
  membership: {
    chatId: ChatId
    mlsGroupId: MlsGroupId
    added: IdentityKey[]
    removed: IdentityKey[]
  }
  /**
   * A group could not advance. `queued` means the Commit that opens the
   * message's epoch has not arrived and the payload is being held; `dropped`
   * means it fell more than {@link RETAINED_EPOCHS} epochs behind and its keys
   * are gone, so it is unrecoverable and has been discarded.
   */
  epochMismatch: {
    chatId: ChatId
    mlsGroupId: MlsGroupId
    expected: bigint
    received: bigint
    disposition: 'queued' | 'dropped' | 'refused'
  }
  /**
   * A stored KeyPackage has been spent and retired.
   *
   * The library keeps only the public half, so retiring it stops the ref
   * matching a later Welcome. Forward secrecy needs the other half gone too,
   * and only the host has it — this event names which one.
   */
  keyPackageConsumed: { ref: KeyPackageRef }
  /** Delivery failed for some members. The group has still advanced locally. */
  deliveryFailed: {
    chatId: ChatId
    mlsGroupId: MlsGroupId
    recipients: IdentityKey[]
    error: Error
  }
  /**
   * An inbound payload could not be processed. Delivery continues regardless.
   * `from` is absent when the payload came off the pending queue, which does
   * not record who sent it.
   */
  processingFailed: { from?: IdentityKey; error: Error }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  /** A peer asked for a KeyPackage. Nothing is minted until `invites.accept`. */
  inviteReceived: {
    inviteId: InviteId
    peer: IdentityKey
    ciphersuites: MlsCiphersuiteName[]
    chatName?: string
  }
  /**
   * A peer answered our request, with a KeyPackage whose credential names that
   * same peer. Emitted only when the two agree — see
   * {@link ClientEvents.keyPackageRejected} for when they do not — so a
   * consumer following this path cannot label a member with the wrong identity.
   */
  keyPackageReceived: {
    inviteId: InviteId
    peer: IdentityKey
    /** The identity the KeyPackage's own credential claims. Equals `peer`. */
    keyPackageIdentity: IdentityKey
    keyPackage: KeyPackageBytes
  }
  /**
   * A peer answered our request with a KeyPackage that is not theirs, or that
   * could not be read at all.
   *
   * A separate event rather than a field on {@link ClientEvents.keyPackageReceived},
   * because a field can be ignored: Bob answering Alice's invitation with
   * Carol's KeyPackage would otherwise build a group Alice's UI labels "Bob"
   * and Carol is actually in. The KeyPackage is deliberately not carried here —
   * there is no safe use for it — and the invitation has been consumed either
   * way, so the exchange must be restarted.
   */
  keyPackageRejected: {
    inviteId: InviteId
    /** Who the transport says answered. */
    peer: IdentityKey
    /** Who the credential claims, when the KeyPackage could be read at all. */
    claimed?: IdentityKey
    error: Error
  }
  inviteDeclined: { inviteId: InviteId; peer: IdentityKey }
  /**
   * A peer sent an answer to an invitation this client never issued them.
   *
   * The library refused it — this is the check that stops a stranger inserting
   * their own KeyPackage into somebody else's exchange — and this event is the
   * only record that it happened. Not `processingFailed`: nothing went wrong.
   * Not `keyPackageRejected`: that names the invitation an answer belonged to,
   * and this answer belonged to none.
   */
  bootstrapRefused: {
    peer: IdentityKey
    kind: 'keyPackageRequest' | 'keyPackageResponse' | 'keyPackageDecline' | 'welcome'
    requestId: string
    reason: string
  }
  /**
   * A peer added us to a group. Nothing is joined until `joinFromWelcome`.
   * `ref` names the KeyPackage the Welcome was encrypted to, so the caller
   * knows which private half to hand back; it is absent when none of this
   * device's stored KeyPackages match.
   */
  welcomeReceived: {
    inviteId: InviteId
    peer: IdentityKey
    ref?: KeyPackageRef
    /** The inviter's name for the chat, if they sent one. */
    chatName?: string
    welcome: Uint8Array
  }
}

/**
 * End-to-end encrypted group messaging for BRC-100 wallets.
 *
 * The one class most callers need. Hand it a wallet, a database and a
 * transport, and it wires up identity, MLS and delivery behind a chat-shaped
 * API:
 *
 * ```ts
 * const client = await GroupMessagingClient.create({
 *   wallet: new WalletClient(),
 *   storage: sqlDriver,           // whatever database the host already has
 *   transport: messageBoxClient,
 * })
 *
 * const minted = await client.keyPackages.create()   // keep the private half
 * const group = await client.createGroup({
 *   chatId: "project-alpha",
 *   members: [bobKeyPackage],
 *   privateKeyPackage: minted.privateKeyPackage,
 * })
 * await group.sendText("hello")
 *
 * client.on("message", ({ chatId, sender, content }) => { ... })
 * ```
 *
 * Private key material is never persisted by this library: `keyPackages.create`
 * hands the private half back once and keeps only the public one. The caller's
 * wallet stores it and passes it in where a group operation needs it.
 *
 * Bootstrap envelopes carry no signature of their own, so `peer` on an invite
 * is exactly as trustworthy as the transport's sender authentication and no
 * more (spec §5.3). Over MessageBox that is a BRC-31 authenticated identity;
 * over a transport that does not authenticate senders, treat it as a hint.
 *
 * Each layer is also exported on its own — {@link IdentityService},
 * {@link StorageProvider}, {@link TransportService}, {@link MlsEngine} — for
 * callers who want to compose them differently or swap one out.
 */
export class GroupMessagingClient {
  readonly #events = new Emitter<ClientEvents>((error, event) => {
    this.#onListenerError(error, event)
  })
  #unsubscribe: Unsubscribe | undefined

  /** One promise chain per group, tail-first. See {@link withGroupLock}. */
  readonly #groupLocks = new Map<MlsGroupId, Promise<unknown>>()

  /** The invitation exchange: request, accept, decline, list. */
  readonly invites: InviteService

  /**
   * Storage scoped to this client's identity.
   *
   * Not the provider that was passed in: the host's database is shared between
   * however many accounts the wallet manages, so every key is narrowed to this
   * identity before anything is read or written. See
   * {@link StorageProvider.scopeTo}.
   */
  readonly storage: StorageProvider

  /**
   * Direct construction, for a caller who has already built the pieces.
   * Most callers want {@link GroupMessagingClient.create}, which builds them.
   */
  constructor(
    readonly identity: IdentityService,
    storage: StorageProvider,
    readonly transport: TransportService,
    readonly engine: MlsEngine
  ) {
    this.storage = storage.scopeTo(identity.identityKey)
    this.invites = new InviteService({
      identityKey: identity.identityKey,
      storage: this.storage,
      transport,
      ciphersuite: engine.ciphersuite,
      emit: async (event, payload) => this.#onInviteEvent(event, payload),
      resolveWelcome: async welcome => this.keyPackages.refFor(welcome)
    })
  }

  /**
   * Resolve every input, open what needs opening, and start listening.
   *
   * Async because a wallet may prompt the user for the identity key and a
   * database may need its tables created.
   */
  static async create(options: GroupMessagingClientOptions): Promise<GroupMessagingClient> {
    const ciphersuite: MlsCiphersuiteName =
      options.ciphersuite === undefined || options.ciphersuite === 'default'
        ? DEFAULT_CIPHERSUITE
        : options.ciphersuite

    const [identity, storage, transport] = await Promise.all([
      IdentityService.open(options.wallet),
      StorageProvider.open(options.storage),
      TransportService.open(options.transport)
    ])

    const client = new GroupMessagingClient(
      identity,
      storage,
      transport,
      new MlsEngine({ identity, ciphersuite })
    )
    client.listen()
    return client
  }

  /** This client's long-term identity key, compressed secp256k1 hex. */
  get identityKey(): IdentityKey {
    return this.identity.identityKey
  }

  get ciphersuite(): MlsCiphersuiteName {
    return this.engine.ciphersuite
  }

  /** Begin consuming inbound transport traffic. `create` does this for you. */
  listen(): void {
    if (this.#unsubscribe !== undefined) return
    const stopErrors = this.transport.onError((error, from) => {
      if (from === undefined) this.#events.emit('processingFailed', { error })
      else this.#events.emit('processingFailed', { from, error })
    })
    const stopMessages = this.transport.onMessage(async (from, payload) => {
      await this.processIncoming(payload, from)
    })
    this.#unsubscribe = () => {
      stopMessages()
      stopErrors()
    }
  }

  /**
   * Stop listening and release the transport. Stored state is left intact.
   *
   * The transport closes before this client's own subscription is dropped, and
   * the order is load-bearing: a MessageBox poll already in flight would
   * otherwise deliver into a handler set this method had just emptied, see
   * every handler "succeed", and acknowledge — deleting from the box messages
   * nobody received. Closing first lets that delivery finish against a real
   * subscriber.
   *
   * That also means `close()` waits for an in-flight poll to finish, so a
   * handler that never settles will hang it. Deliberate — it is what stops the
   * acknowledgement above — but a host that cannot trust its own handlers
   * should put a timeout around shutdown.
   */
  async close(): Promise<void> {
    await this.transport.close()
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    await this.storage.close()
  }

  on<K extends keyof ClientEvents>(
    event: K,
    listener: (payload: ClientEvents[K]) => void
  ): Unsubscribe {
    return this.#events.on(event, listener)
  }

  // ── KeyPackages ──────────────────────────────────────────────────────────

  readonly keyPackages = {
    /**
     * Mint a KeyPackage.
     *
     * The private half is returned and forgotten — storing it is the caller's
     * job and this library's prohibition. The public half is kept, keyed by
     * ref, because {@link GroupMessagingClient.joinFromWelcome} needs it when
     * the Welcome lands and {@link GroupMessagingClient.createGroup} needs it
     * to pair with the private half handed back in.
     */
    create: async (options?: KeyPackageOptions): Promise<MintedKeyPackage> => {
      const minted = await this.engine.createKeyPackage(options)
      await this.storage.putKeyPackage(minted.ref, minted.keyPackage)
      return minted
    },

    /**
     * The ref of the stored KeyPackage a Welcome was encrypted to, if any.
     *
     * A Welcome covers every member one Commit added, so this picks out the
     * secret meant for this device.
     */
    refFor: async (welcome: Uint8Array): Promise<KeyPackageRef | undefined> => {
      const stored = new Set(await this.storage.listKeyPackageRefs())
      return this.engine.refsForWelcome(welcome).find(ref => stored.has(ref))
    },

    /** Refs of every public KeyPackage this device has kept. */
    list: async (): Promise<KeyPackageRef[]> => this.storage.listKeyPackageRefs(),

    /**
     * Forget a KeyPackage without spending it — an expired one, or a pool entry
     * being rotated. Spent ones retire themselves.
     */
    retire: async (ref: KeyPackageRef): Promise<void> => this.#retire(ref),

    /** The public bytes behind a ref, for republishing an unused KeyPackage. */
    get: async (ref: KeyPackageRef): Promise<KeyPackageBytes | undefined> =>
      this.storage.getKeyPackage(ref)
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  /**
   * Create a group, add every supplied member, and deliver their Welcomes.
   *
   * `privateKeyPackage` is the private half of a KeyPackage this client minted
   * through `keyPackages.create`; the matching public half is found in storage.
   * It is used and dropped — nothing about it is retained beyond the MLS group
   * state itself.
   *
   * State is persisted before any Welcome goes out, so a delivery failure can
   * never leave a member holding secrets for a group this device forgot. On
   * failure a `deliveryFailed` event is emitted and the error rethrown; the
   * group exists locally either way.
   */
  async createGroup(input: {
    chatId: ChatId
    members: KeyPackageBytes[]
    name?: string
    privateKeyPackage: PrivateKeyPackageBytes
  }): Promise<Group> {
    if ((await this.storage.getChat(input.chatId)) !== undefined) {
      throw new GroupMessagingError(`Chat ${input.chatId} already exists`)
    }
    const own = await this.#ownKeyPackageFor(input.privateKeyPackage)
    const created = await this.engine.createGroup({
      keyPackage: own.keyPackage,
      privateKeyPackage: input.privateKeyPackage
    })

    let state = created.state
    let welcome: Uint8Array | undefined
    if (input.members.length > 0) {
      const added = await this.engine.addMembers({ state, keyPackages: input.members })
      state = added.state
      welcome = added.welcome
    }

    // The chat row is what makes a group reachable, so it is written last.
    // Delivery stays outside the lock; see {@link withGroupLock}.
    await this.withGroupLock(created.mlsGroupId, async () => {
      await this.storage.putGroup(created.mlsGroupId, state)
      await this.storage.putChat({
        chatId: input.chatId,
        mlsGroupId: created.mlsGroupId,
        ...(input.name === undefined ? {} : { name: input.name }),
        createdAt: new Date().toISOString()
      })
      // Spent: its leaf node is in the tree now. Retired only once the group is
      // durable, so a failure earlier leaves the pair intact to try again.
      await this.#retire(own.ref)
    })

    const group = new Group(input.chatId, created.mlsGroupId, this)
    if (welcome !== undefined) {
      await this.deliverWelcome(group, input.members, welcome, input.name)
    }
    return group
  }

  /**
   * Join the group an inbound Welcome invites this client into.
   *
   * The Welcome and the ref it was encrypted to were recorded when it arrived,
   * so the caller supplies only the private half it kept and the local name it
   * wants the chat to have. The invite is consumed on success.
   */
  async joinFromWelcome(input: {
    inviteId: InviteId
    chatId: ChatId
    privateKeyPackage: PrivateKeyPackageBytes
    /** Overrides the name the inviter sent, if any. */
    name?: string
  }): Promise<Group> {
    const invite = await this.storage.getInvite(input.inviteId)
    if (invite === undefined) throw new GroupMessagingError(`No invite ${input.inviteId}`)
    if (invite.kind !== 'welcome' || invite.welcome === undefined) {
      throw new GroupMessagingError(`Invite ${input.inviteId} carries no Welcome`)
    }
    if (invite.ref === undefined) {
      throw new GroupMessagingError(
        `Invite ${input.inviteId} names no stored KeyPackage; this device cannot join it`
      )
    }
    // Held in a local because narrowing a property does not survive into the
    // closure below.
    const ref = invite.ref
    const keyPackage = await this.storage.getKeyPackage(ref)
    if (keyPackage === undefined) {
      throw new GroupMessagingError(`No stored KeyPackage ${invite.ref}`)
    }
    if ((await this.storage.getChat(input.chatId)) !== undefined) {
      throw new GroupMessagingError(`Chat ${input.chatId} already exists`)
    }

    const joined = await this.engine.joinFromWelcome({
      welcome: fromHex(invite.welcome),
      keyPackage,
      privateKeyPackage: input.privateKeyPackage
    })

    const name = input.name ?? invite.chatName
    await this.withGroupLock(joined.mlsGroupId, async () => {
      await this.storage.putGroup(joined.mlsGroupId, joined.state)
      await this.storage.putChat({
        chatId: input.chatId,
        mlsGroupId: joined.mlsGroupId,
        ...(name === undefined ? {} : { name }),
        createdAt: new Date().toISOString()
      })
      await this.storage.deleteInvite(input.inviteId)
      await this.#retire(ref)
      // The join is what names the group, so this is the first chance to read
      // anything held during it.
      await this.#drainPending(input.chatId, joined.mlsGroupId)
    })
    await this.#reclaimHeldBeforeJoin()

    return new Group(input.chatId, joined.mlsGroupId, this)
  }

  /** The chat with this local identifier, if this device has its state. */
  async getGroup(chatId: ChatId): Promise<Group | undefined> {
    const chat = await this.storage.getChat(chatId)
    if (chat === undefined) return undefined
    const state = await this.storage.getGroup(chat.mlsGroupId)
    return state === undefined ? undefined : new Group(chat.chatId, chat.mlsGroupId, this)
  }

  /** Every chat this device holds state for. */
  async listGroups(): Promise<Group[]> {
    const chats = await this.storage.listChats()
    const groups: Group[] = []
    for (const chat of chats) {
      if ((await this.storage.getGroup(chat.mlsGroupId)) !== undefined) {
        groups.push(new Group(chat.chatId, chat.mlsGroupId, this))
      }
    }
    return groups
  }

  // ── Inbound ──────────────────────────────────────────────────────────────

  /**
   * Route one inbound payload: a bootstrap envelope, or MLS group traffic.
   *
   * MLS traffic for an unknown group is ignored — this device was never in it,
   * or has left. Traffic for an epoch this device has not reached is queued
   * until the Commit that opens it arrives.
   */
  async processIncoming(payload: Uint8Array, from?: IdentityKey): Promise<void> {
    let envelope: Envelope
    try {
      envelope = decodeEnvelope(payload)
    } catch (cause) {
      // Not a library envelope, and no retry makes it one.
      throw new PermanentProcessingError('Payload is not a valid envelope', { cause })
    }
    if (envelope.kind === 'bootstrap') {
      if (from === undefined) {
        throw new GroupMessagingError('A bootstrap envelope needs a sender')
      }
      await this.invites.handle(from, envelope.message)
      return
    }

    const framing = this.engine.epochOf(envelope.payload)
    if (framing === undefined) throw new GroupMessagingError('Unroutable MLS payload')

    // Taken once, around the whole read-apply-drain: the drain re-enters
    // the drain after every Commit, and a lock per call would deadlock on it.
    await this.withGroupLock(framing.mlsGroupId, async () => {
      const chatId = await this.storage.chatIdForGroup(framing.mlsGroupId)
      if (chatId === undefined)
        return this.#holdForPendingJoin(framing.mlsGroupId, envelope.payload)

      const state = await this.storage.getGroup(framing.mlsGroupId)
      if (state === undefined) return this.#holdForPendingJoin(framing.mlsGroupId, envelope.payload)

      const local = await this.engine.info(state)
      if (framing.epoch > local.epoch) {
        // The Commit that opens this epoch has not arrived, if it ever will.
        const disposition = await this.#holdAhead(
          framing.mlsGroupId,
          envelope.payload,
          framing.epoch - local.epoch
        )
        this.#events.emit('epochMismatch', {
          chatId,
          mlsGroupId: framing.mlsGroupId,
          expected: local.epoch,
          received: framing.epoch,
          disposition
        })
        return
      }

      await this.#applyOne(
        chatId,
        framing.mlsGroupId,
        state,
        envelope.payload,
        framing.epoch,
        local.epoch
      )
      await this.#drainPending(chatId, framing.mlsGroupId)
    })
  }

  /**
   * @internal Run `operation` with nothing else touching this group's state.
   *
   * Every read-modify-write of one group goes through here. Without it a `send`
   * and an inbound message read the same stored state and one overwrites the
   * other: `createApplicationMessage` returns an advanced secret tree, and
   * dropping it re-consumes the generation just spent, so the same AEAD key
   * encrypts two different plaintexts separated only by the 32-bit reuse guard
   * — and the recipient, whose ratchet already spent that generation, silently
   * drops the second message.
   *
   * Chained per group rather than counted, the same shape as
   * `InProcessTransportHub`'s flush. Callers take it once at the outermost
   * boundary of a logical operation and never nest it, and delivery is done
   * outside so a transport that turns around and hands us an inbound message
   * cannot deadlock against the send waiting on it.
   */
  async withGroupLock<T>(mlsGroupId: MlsGroupId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#groupLocks.get(mlsGroupId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.#groupLocks.set(mlsGroupId, current)
    try {
      return await current
    } finally {
      if (this.#groupLocks.get(mlsGroupId) === current) this.#groupLocks.delete(mlsGroupId)
    }
  }

  /** @internal Used by {@link Group} to publish events. */
  emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    this.#events.emit(event, payload)
  }

  /** @internal Send one Welcome per newcomer. Used by {@link Group} too. */
  async deliverWelcome(
    group: Group,
    members: KeyPackageBytes[],
    welcome: Uint8Array,
    chatName?: string
  ): Promise<void> {
    const recipients = members.map(member => this.engine.identityForKeyPackage(member))
    const results = await Promise.allSettled(
      recipients.map(async recipient =>
        // A fresh correlator per recipient: one shared value would let two
        // newcomers recognize each other's invitation from the wire alone.
        this.transport.send(
          recipient,
          encodeEnvelope({
            kind: 'bootstrap',
            message: {
              type: 'welcome',
              requestId: randomId(),
              welcome,
              ...(chatName === undefined ? {} : { chatName })
            }
          })
        )
      )
    )
    const failed = recipients.filter((_, index) => results[index]?.status === 'rejected')
    if (failed.length === 0) return

    const error = new GroupMessagingError(
      `Could not deliver the Welcome for ${group.mlsGroupId} to ${failed.length} of ` +
        `${recipients.length} new members`
    )
    this.#events.emit('deliveryFailed', {
      chatId: group.chatId,
      mlsGroupId: group.mlsGroupId,
      recipients: failed,
      error
    })
    throw error
  }

  /**
   * A subscriber threw. Report it the way every other inbound failure is
   * reported, so it reaches a consumer rather than disappearing.
   *
   * A `processingFailed` listener that throws is the one case that cannot be
   * reported this way without looping, so it goes to the platform instead.
   */
  #onListenerError(error: Error, event: keyof ClientEvents): void {
    if (event === 'processingFailed') {
      queueMicrotask(() => {
        throw error
      })
      return
    }
    this.#events.emit('processingFailed', { error })
  }

  /**
   * Process one message and say what it changed, without storing anything.
   *
   * Returning the state rather than writing it lets the drain decide when to
   * store it. `announce` is deferred for the same reason: a host must not see a
   * message the storage has not yet accepted, so every caller writes first and
   * announces second.
   */
  async #processOne(
    chatId: ChatId,
    mlsGroupId: MlsGroupId,
    state: Uint8Array,
    message: Uint8Array,
    epoch: bigint,
    localEpoch: bigint
  ): Promise<{ state: Uint8Array; announce: () => void }> {
    let result: MlsProcessResult
    try {
      result = await this.engine.process({ state, message })
    } catch (cause) {
      throw new PermanentProcessingError(
        `Message for epoch ${epoch} cannot be processed at epoch ${localEpoch}`,
        { cause }
      )
    }

    if (result.kind === 'application') {
      // Decoded here but reported from `announce`, which every caller runs
      // after the write. The ratchet moved whether or not the plaintext turned
      // out to be content, so the advanced state has to be stored even as the
      // message is rejected: dropping it would leave the consumed key sitting
      // unconsumed, and a replay of these bytes would open again.
      let content: MessageContent | undefined
      let undecodable: unknown
      try {
        content = decodeContent(result.plaintext)
      } catch (cause) {
        undecodable = cause
      }
      return {
        state: result.state,
        announce: () => {
          if (content === undefined) {
            throw new PermanentProcessingError(
              `Message for epoch ${result.epoch} decrypted but its plaintext is not valid content`,
              { cause: undecodable }
            )
          }
          this.#events.emit('message', {
            chatId,
            mlsGroupId,
            sender: result.sender,
            epoch: result.epoch,
            content
          })
        }
      }
    }
    if (result.kind === 'commit') {
      return {
        state: result.state,
        announce: () => {
          this.#events.emit('membership', {
            chatId,
            mlsGroupId,
            added: result.added,
            removed: result.removed
          })
        }
      }
    }
    return { state: result.state, announce: () => undefined }
  }

  /** Process one message, store it, then announce it. */
  async #applyOne(
    chatId: ChatId,
    mlsGroupId: MlsGroupId,
    state: Uint8Array,
    message: Uint8Array,
    epoch: bigint,
    localEpoch: bigint
  ): Promise<void> {
    const { state: next, announce } = await this.#processOne(
      chatId,
      mlsGroupId,
      state,
      message,
      epoch,
      localEpoch
    )
    await this.storage.putGroup(mlsGroupId, next)
    announce()
  }

  /**
   * Apply whatever the group has caught up to, and keep the rest.
   *
   * One pass can open several epochs — a queued Commit lets the messages behind
   * it through — so this repeats until a pass applies nothing. Anything still
   * ahead goes back on the queue in order; anything now more than
   * {@link RETAINED_EPOCHS} behind is unrecoverable and is reported as dropped
   * rather than retried on every future Commit.
   */
  /**
   * One queued payload against the group as it stands now.
   *
   * `keep` is a payload from an epoch this client has not reached yet: it waits
   * for the Commit that gets there. `applied` hands back the new state rather
   * than storing it, so the caller can write it together with the shortened
   * queue.
   */
  async #consumeOne(
    chatId: ChatId,
    mlsGroupId: MlsGroupId,
    state: Uint8Array,
    payload: Uint8Array
  ): Promise<Consumed> {
    const local = await this.engine.info(state)
    const framing = this.engine.epochOf(payload)
    if (framing === undefined) {
      this.#events.emit('processingFailed', {
        error: new PermanentProcessingError(
          `A payload queued for ${mlsGroupId} is no longer routable MLS traffic`
        )
      })
      return { verdict: 'skip' }
    }
    if (framing.epoch > local.epoch) return { verdict: 'keep' }
    if (local.epoch - framing.epoch > RETAINED_EPOCHS) {
      this.#events.emit('epochMismatch', {
        chatId,
        mlsGroupId,
        expected: local.epoch,
        received: framing.epoch,
        disposition: 'dropped'
      })
      return { verdict: 'skip' }
    }
    try {
      const processed = await this.#processOne(
        chatId,
        mlsGroupId,
        state,
        payload,
        framing.epoch,
        local.epoch
      )
      return { verdict: 'applied', ...processed }
    } catch (cause) {
      // One unreadable payload must not strand the rest of the queue.
      this.#events.emit('processingFailed', { error: toError(cause) })
      return { verdict: 'skip' }
    }
  }

  /**
   * Store what one applied payload changed.
   *
   * Announcing sits after the write, and before the queue is shortened: the
   * only placement where "the state was stored" implies "the host was told".
   */
  async #storeApplied(
    mlsGroupId: MlsGroupId,
    consumed: Consumed & { verdict: 'applied' }
  ): Promise<void> {
    await this.storage.putGroup(mlsGroupId, consumed.state)
    try {
      consumed.announce()
    } catch (cause) {
      // The state moved and the payload is spent; only the report failed.
      this.#events.emit('processingFailed', { error: toError(cause) })
    }
  }

  /**
   * Apply what the queue is now ready for.
   *
   * Nothing leaves the queue until its state is stored, and the queue is
   * rewritten once per pass rather than once per payload — `replacePending`
   * writes the whole queue, so per-payload would make a full drain quadratic in
   * the bytes it moves, which is the cost that method's own docs exist to
   * avoid.
   *
   * A crash mid-pass therefore leaves the queue whole while some of its
   * payloads have already been applied. That is safe: the retry re-offers them
   * to a group that has consumed them, `ts-mls` refuses them as generations in
   * the past, and they are dropped as permanent. The cost is one spurious
   * `processingFailed` per already-applied payload, never a message.
   */
  async #drainPending(chatId: ChatId, mlsGroupId: MlsGroupId): Promise<void> {
    for (;;) {
      const queued = await this.storage.peekPending(mlsGroupId)
      if (queued.length === 0) return

      const kept: Uint8Array[] = []
      let applied = false
      for (const payload of queued) {
        const state = await this.storage.getGroup(mlsGroupId)
        // The group went away underneath the drain. Nothing has been taken off
        // the queue, so whatever is left stays for whoever holds it next.
        if (state === undefined) return
        const consumed = await this.#consumeOne(chatId, mlsGroupId, state, payload)
        if (consumed.verdict === 'keep') {
          kept.push(payload)
          continue
        }
        if (consumed.verdict !== 'applied') continue
        await this.#storeApplied(mlsGroupId, consumed)
        applied = true
      }
      if (kept.length !== queued.length) {
        await this.storage.replacePending(mlsGroupId, kept)
      }
      if (!applied) return
    }
  }

  /**
   * Hold a payload framed for an epoch this group has not reached.
   *
   * Both bounds exist because the epoch driving this decision is cleartext and
   * unauthenticated: a removed member can take one frame they captured while
   * they were still in the group, rewrite its epoch, and replay it. Nothing
   * here can tell that from a genuine reorder, so neither is allowed to cost
   * more than a fixed amount.
   */
  async #holdAhead(
    mlsGroupId: MlsGroupId,
    payload: Uint8Array,
    ahead: bigint
  ): Promise<'queued' | 'refused'> {
    if (ahead > MAX_EPOCH_LOOKAHEAD) return 'refused'
    const { count, bytes } = await this.storage.pendingStats(mlsGroupId)
    if (count >= MAX_PENDING_PER_GROUP) return 'refused'
    if (bytes + payload.length > MAX_PENDING_BYTES_PER_GROUP) return 'refused'
    await this.storage.queuePending(mlsGroupId, payload)
    return 'queued'
  }

  /**
   * Hold group traffic that arrived before this device could join it.
   *
   * Only while a Welcome is outstanding. With no pending invitation there is
   * nothing to join, so the payload is for a group this device left or was
   * never in — routine, and still dropped.
   */
  async #holdForPendingJoin(mlsGroupId: MlsGroupId, payload: Uint8Array): Promise<void> {
    const invites = await this.storage.listInvites()
    if (!invites.some(invite => invite.kind === 'welcome')) {
      await this.#reclaimHeldBeforeJoin()
      return
    }
    const { count, bytes } = await this.storage.pendingStats(mlsGroupId)
    if (count === 0 && (await this.#heldBeforeJoin()).length >= MAX_GROUPS_HELD_BEFORE_JOIN) return
    if (count >= MAX_HELD_BEFORE_JOIN) return
    if (bytes + payload.length > MAX_PENDING_BYTES_PER_GROUP) return
    await this.storage.queuePending(mlsGroupId, payload)
  }

  /** Groups with something queued that this device holds no state for. */
  async #heldBeforeJoin(): Promise<MlsGroupId[]> {
    const held: MlsGroupId[] = []
    for (const groupId of await this.storage.listPendingGroups()) {
      if ((await this.storage.chatIdForGroup(groupId)) === undefined) held.push(groupId)
    }
    return held
  }

  /**
   * Drop what was held for a join that can no longer happen.
   *
   * A Welcome does not name its group, so a queue held during the join window
   * is never matched to the invitation that justified it — only the join
   * itself can drain one. With no Welcome outstanding nothing will, and since
   * the sender chose the id there is no reason to believe the group exists.
   * Without this the window's writes stay in the host's database for good.
   */
  async #reclaimHeldBeforeJoin(): Promise<void> {
    const invites = await this.storage.listInvites()
    if (invites.some(invite => invite.kind === 'welcome')) return
    for (const groupId of await this.#heldBeforeJoin()) {
      await this.storage.replacePending(groupId, [])
    }
  }

  /**
   * The stored public KeyPackage that pairs with a private half.
   *
   * Matched cryptographically rather than by count: using "the only one stored"
   * would silently build a group around the wrong leaf key the moment a second
   * KeyPackage exists.
   */
  async #ownKeyPackageFor(
    privateKeyPackage: PrivateKeyPackageBytes
  ): Promise<{ ref: KeyPackageRef; keyPackage: KeyPackageBytes }> {
    const stored: Array<{ ref: KeyPackageRef; keyPackage: KeyPackageBytes }> = []
    for (const ref of await this.storage.listKeyPackageRefs()) {
      const keyPackage = await this.storage.getKeyPackage(ref)
      if (keyPackage !== undefined) stored.push({ ref, keyPackage })
    }
    const candidates = stored.map(entry => entry.keyPackage)
    const match = await this.engine.matchKeyPackage({ privateKeyPackage, candidates })
    if (match === undefined) {
      throw new GroupMessagingError(
        'No stored KeyPackage matches this private KeyPackage. Mint the pair with ' +
          'keyPackages.create() and keep the private half beside the ref it returned.'
      )
    }
    // Compared by bytes rather than identity: the engine picks a candidate, and
    // which object it hands back is its business, not a contract.
    const found = stored.find(entry => bytesEqual(entry.keyPackage, match))
    if (found === undefined) {
      throw new GroupMessagingError('A matched KeyPackage is not one of the stored ones')
    }
    return found
  }

  /**
   * Forget a spent KeyPackage, and say which one it was.
   *
   * Only the public half is here to forget. The private half is the host's and
   * is what forward secrecy actually turns on, so the event is the signal to
   * destroy it.
   */
  async #retire(ref: KeyPackageRef): Promise<void> {
    await this.storage.deleteKeyPackage(ref)
    this.#events.emit('keyPackageConsumed', { ref })
  }

  /**
   * Republish an {@link InviteService} event, filling in what only the MLS
   * engine can supply.
   *
   * The service is deliberately loosely coupled — it never imports the client
   * or the engine — so the payloads arrive untyped and are narrowed here. A
   * Welcome is the one that needs work: the ref it was encrypted to and the
   * bytes themselves are recorded on the invite so joining can happen later,
   * after a restart if the user takes their time.
   */
  async #onInviteEvent(event: string, payload: unknown): Promise<void> {
    switch (event) {
      case 'inviteReceived':
        this.#events.emit('inviteReceived', payload as ClientEvents['inviteReceived'])
        return
      case 'keyPackageReceived':
        await this.#onKeyPackageReceived(
          payload as { inviteId: InviteId; peer: IdentityKey; keyPackage: KeyPackageBytes }
        )
        return
      case 'inviteDeclined':
        this.#events.emit('inviteDeclined', payload as ClientEvents['inviteDeclined'])
        return
      case 'bootstrapRefused':
        this.#events.emit('bootstrapRefused', payload as ClientEvents['bootstrapRefused'])
        return
      case 'welcomeReceived': {
        const { inviteId, peer, ref, welcome, chatName } = payload as {
          inviteId: InviteId
          peer: IdentityKey
          ref?: KeyPackageRef
          welcome: Uint8Array
          chatName?: string
        }
        this.#events.emit('welcomeReceived', {
          inviteId,
          peer,
          ...(ref === undefined ? {} : { ref }),
          ...(chatName === undefined ? {} : { chatName }),
          welcome
        })
        return
      }
      default:
        throw new GroupMessagingError(`Unknown invite event ${event}`)
    }
  }

  /**
   * Publish a peer's answer only if the KeyPackage names that peer *and* the
   * peer's wallet actually attested to it.
   *
   * The transport says who sent the bytes; the credential says whose key they
   * are; the attestation is what makes the credential more than a claim.
   * Nothing forces the three to agree. A peer who substitutes somebody else's
   * KeyPackage gets that third party into a group the inviter believes they
   * built with the peer, and a credential whose signature does not verify is a
   * KeyPackage MLS will refuse at the moment of admission — after the inviter
   * has minted their own KeyPackage and asked the wallet to sign it, and
   * reported as an MLS failure rather than as a bad answer to an invitation.
   * Both are surfaced here, on the event a consumer already handles.
   */
  async #onKeyPackageReceived(payload: {
    inviteId: InviteId
    peer: IdentityKey
    keyPackage: KeyPackageBytes
  }): Promise<void> {
    const reject = (error: Error, claimed?: IdentityKey): void => {
      this.#events.emit('keyPackageRejected', {
        inviteId: payload.inviteId,
        peer: payload.peer,
        ...(claimed === undefined ? {} : { claimed }),
        error
      })
    }

    let claimed: IdentityKey
    try {
      claimed = this.engine.identityForKeyPackage(payload.keyPackage)
    } catch (cause) {
      reject(toError(cause))
      return
    }
    if (claimed !== payload.peer) {
      reject(
        new GroupMessagingError(
          `${payload.peer} answered with a KeyPackage whose credential names ${claimed}`
        ),
        claimed
      )
      return
    }

    const verified = await this.engine.verifyKeyPackage(payload.keyPackage)
    if (!verified.credentialBinding) {
      reject(
        new GroupMessagingError(
          `${payload.peer} answered with a KeyPackage whose credential does not attest to its MLS key` +
            (verified.error === undefined ? '' : `: ${verified.error}`)
        ),
        claimed
      )
      return
    }
    if (!verified.leafSignature || !verified.keyPackageSignature) {
      reject(
        new GroupMessagingError(
          `${payload.peer} answered with a KeyPackage whose own signature does not verify`
        ),
        claimed
      )
      return
    }

    this.#events.emit('keyPackageReceived', {
      inviteId: payload.inviteId,
      peer: payload.peer,
      keyPackageIdentity: claimed,
      keyPackage: payload.keyPackage
    })
  }
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))
