/**
 * Copy this into your host and own it.
 *
 * The library deliberately does not run the invitation exchange: its state
 * lives in four places that cannot be written atomically through the storage
 * seam, and your database can write them in one transaction. This file is the
 * bookkeeping that belongs on your side of that line, in the smallest form
 * that works. It is source, not API — there is no compatibility promise.
 *
 * Where to put each piece with a real database, in one transaction per step:
 *   - the shelf below becomes a row keyed by `ref`, with a unique index on
 *     `inviteId`, holding the private half in whatever your secure store is.
 *     It must survive a restart, and the row is the host's proof of whom it
 *     answered: a Welcome joins only from that peer.
 *   - `ChatIds` becomes the mapping you already keep between a chat's local
 *     id and the name that crosses the wire.
 *   - the retry in `#admit` belongs with your outbox.
 */
import { WelcomeDeliveryError } from '@bsv/group-messaging'
import type {
  GroupMessagingClient,
  KeyPackageBytes,
  KeyPackageRef,
  PrivateKeyPackageBytes
} from '@bsv/group-messaging'

/**
 * What `accept` shelves, and what a Welcome is checked against. The `peer` is
 * the only thing that ties a `ref` to the party this host answered: the ref is
 * cleartext in the Welcome and anyone holding the public KeyPackage can name it.
 */
export interface ShelvedInvitation {
  ref: KeyPackageRef
  inviteId: string
  /** The peer the answer went to, and the only sender whose Welcome may join. */
  peer: string
  /**
   * Chosen by this host at accept; nothing the Welcome carries can change it.
   * It is also fixed: a join that fails because the chat already exists is not
   * retried under another id, so choose one that cannot collide.
   */
  chatId: string
  half: PrivateKeyPackageBytes
  /** What was sent, so a retry resends the same bytes. */
  keyPackage: KeyPackageBytes
}

/**
 * Where a minted KeyPackage's private half waits for its Welcome. It also keeps
 * the public bytes sent, so a retry of `accept` can resend them: a send that
 * failed may still have arrived.
 */
export interface PrivateHalfShelf {
  hold(record: ShelvedInvitation): Promise<void>
  /** Reads without removing, so a refused Welcome leaves the half for the genuine one. */
  peek(ref: string): Promise<ShelvedInvitation | undefined>
  forInvite(inviteId: string): Promise<ShelvedInvitation | undefined>
  /** Removes as it returns: a KeyPackage is single-use. */
  take(ref: string): Promise<ShelvedInvitation | undefined>
}

/** Lasts as long as the process. Replace it with your secure store. */
export class MemoryShelf implements PrivateHalfShelf {
  readonly #held = new Map<string, ShelvedInvitation>()
  async hold(record: ShelvedInvitation): Promise<void> {
    this.#held.set(record.ref, record)
  }
  async peek(ref: string): Promise<ShelvedInvitation | undefined> {
    return this.#held.get(ref)
  }
  async forInvite(inviteId: string): Promise<ShelvedInvitation | undefined> {
    for (const record of this.#held.values()) if (record.inviteId === inviteId) return record
    return undefined
  }
  async take(ref: string): Promise<ShelvedInvitation | undefined> {
    const record = this.#held.get(ref)
    this.#held.delete(ref)
    return record
  }
}

/**
 * The two sides of the exchange see different ids, so they get different
 * callbacks. The inviter knows the id its own `invites.send` returned; the
 * invitee's Welcome row carries a fresh id that matches nothing the invitee
 * passed to `accept`. The invitee therefore decides the chat at `accept`, from
 * the name the request carried, and shelves it beside the peer: a Welcome is
 * matched by `ref` and sender, never by the name it carries.
 */
export interface ChatIds {
  /** Inviter side: `inviteId` is what `invites.send` returned. */
  forAnswer(inviteId: string): string
  /**
   * Inviter side: the name the request and Welcome carry. Without it
   * `forWelcome` receives `undefined`.
   */
  nameFor?(inviteId: string): string | undefined
  /** Invitee side, called at `accept`: the inviter's name for the chat, if it sent one. */
  forWelcome(chatName: string | undefined): string
}

export interface Failure {
  stage: 'admit' | 'join'
  chatId: string
  peer?: string
  reason: string
  /**
   * Set when the Add succeeded and only the Welcome's send failed. Its bytes
   * are the only thing that can finish the join and cannot be regenerated:
   * queue the error and pass it to `client.retryDelivery` later.
   */
  undelivered?: WelcomeDeliveryError
  /**
   * Set when a Welcome named a KeyPackage whose shelved record is missing. The
   * Welcome's own invitation id matches nothing the host passed to `accept`, so
   * this is the key a host can use to find the chat it was waiting on: note
   * `shelf.forInvite(inviteId).ref` after `accept`.
   */
  ref?: string
}

export class ManagedInvitations {
  readonly #answered = new Set<string>()
  /** Refs whose join is running, so a redelivered Welcome is not mistaken for a lost record. */
  readonly #joining = new Set<string>()
  /** The tail of the admissions queued per chat. */
  readonly #admitting = new Map<string, Promise<void>>()

  constructor(
    private readonly client: GroupMessagingClient,
    private readonly shelf: PrivateHalfShelf,
    private readonly chatIds: ChatIds,
    /** Where failures surface: nobody awaits a Welcome, so there is no caller to throw to. */
    private readonly onFailure: (failure: Failure) => void = () => undefined
  ) {}

  /** Subscribe to the events the exchange turns on. Returns an unsubscribe. */
  start(): () => void {
    const stops = [
      this.client.on('keyPackageReceived', ({ inviteId, keyPackage, peer }) => {
        this.#detached(
          'admit',
          inviteId,
          peer,
          () => this.#admit(inviteId, keyPackage, peer),
          () => this.chatIds.forAnswer(inviteId)
        )
      }),
      this.client.on('keyPackageRejected', ({ inviteId, peer, error }) => {
        // The invitation stays pending until the host abandons it.
        this.onFailure({
          stage: 'admit',
          chatId: this.chatIds.forAnswer(inviteId),
          peer,
          reason: `answer refused: ${error.message}`
        })
      }),
      this.client.on('welcomeReceived', ({ inviteId, peer, ref }) => {
        this.#detached(
          'join',
          inviteId,
          peer,
          () => this.#join(inviteId, peer, ref),
          // The Welcome's own chat name is the sender's to choose, so it never
          // names a chat in a report; only the shelved record does.
          () => `unknown:${inviteId}`
        )
      })
    ]
    return () => stops.forEach(stop => stop())
  }

  /**
   * Nobody awaits an event handler, so a rejection here would be unhandled and
   * take down a Node host, silently losing the exchange with it. Everything the
   * host supplies (`chatIds`, the shelf, `onFailure`) runs inside `run`, so this
   * is the one place that turns any throw into an `onFailure` report. If
   * `onFailure` throws too there is nowhere left to report to.
   */
  #detached(
    stage: Failure['stage'],
    inviteId: string,
    peer: string,
    run: () => Promise<void>,
    chatIdOf: () => string
  ): void {
    run().catch((cause: unknown) => {
      try {
        let chatId: string
        try {
          chatId = chatIdOf()
        } catch {
          chatId = `unknown:${inviteId}`
        }
        this.onFailure({ stage, chatId, peer, reason: String(cause) })
      } catch {
        // The host's own reporter failed; the process must still survive.
      }
    })
  }

  /**
   * Answer an invitation. Mint, shelve the half, then send: a half that reaches
   * the peer without being shelved can never be joined, and nothing on either
   * side would report it.
   *
   * A failed send leaves the record shelved and a retry resends its bytes. The
   * send may have arrived with only the acknowledgement lost, and then the
   * inviter admits that KeyPackage: destroying its half would make the join
   * impossible, while a half nothing arrived for only costs storage until
   * `abandon` or `decline` retires it.
   */
  async accept(inviteId: string): Promise<void> {
    if (this.#answered.has(inviteId)) {
      throw new Error(`Invitation ${inviteId} was already answered by this host`)
    }
    this.#answered.add(inviteId)
    try {
      const record = (await this.shelf.forInvite(inviteId)) ?? (await this.#shelve(inviteId))
      await this.client.invites.accept(inviteId, record.keyPackage)
    } catch (cause) {
      this.#answered.delete(inviteId)
      throw cause
    }
  }

  /** Refuse an inbound request and retire what `accept` may have shelved for it. */
  async decline(inviteId: string): Promise<void> {
    await this.#giveUp(inviteId, () => this.client.invites.decline(inviteId))
  }

  /** Give up on an invitation and on the half and ref held for it. */
  async abandon(inviteId: string): Promise<void> {
    await this.#giveUp(inviteId, () => this.client.invites.abandon(inviteId))
  }

  /**
   * The library call throws once the answer went out, because `accept` deletes
   * the request row, and that is exactly the state where retiring matters: the
   * answer is sent and no Welcome came. So a failure with the request gone still
   * retires. A failure with the request still pending is transient: it is
   * rethrown with the record and ref intact, since they are what a retry needs.
   */
  async #giveUp(inviteId: string, call: () => Promise<void>): Promise<void> {
    try {
      await call()
    } catch (cause) {
      const pending = (await this.client.invites.list('inbound')).some(
        invite => invite.inviteId === inviteId
      )
      if (pending) throw cause
    }
    await this.#retire(inviteId)
  }

  /**
   * Drops the public ref, then the record. This order, so a throw between the
   * two leaves the record to retry with rather than a live ref nothing points at.
   */
  async #retire(inviteId: string): Promise<void> {
    const record = await this.shelf.forInvite(inviteId)
    if (record === undefined) return
    await this.client.keyPackages.retire(record.ref)
    await this.shelf.take(record.ref)
  }

  async #shelve(inviteId: string): Promise<ShelvedInvitation> {
    const request = (await this.client.invites.list('inbound')).find(
      invite => invite.inviteId === inviteId && invite.kind === 'keyPackageRequest'
    )
    if (request === undefined) throw new Error(`No pending request ${inviteId}`)
    const chatId = this.chatIds.forWelcome(request.chatName)
    const minted = await this.client.keyPackages.create()
    const record: ShelvedInvitation = {
      ref: minted.ref,
      inviteId,
      peer: request.peer,
      chatId,
      half: minted.privateKeyPackage,
      keyPackage: minted.keyPackage
    }
    await this.shelf.hold(record)
    return record
  }

  /**
   * The fork every host writes: create the chat if it does not exist, add to it
   * if it does. The KeyPackage arriving on `keyPackageReceived` has already had
   * its credential checked against the peer that sent it — an answer that fails
   * that check never reaches here, it is reported as `keyPackageRejected`.
   *
   * A Welcome that does not land arrives here on the error with its bytes. They
   * are the only thing that can still finish the join — a Welcome belongs to the
   * Commit that produced it and cannot be regenerated — so a real host queues
   * them for retry rather than logging and moving on.
   */
  async #admit(inviteId: string, keyPackage: KeyPackageBytes, peer: string): Promise<void> {
    // One writer per chat: the present-check and the Add below are a
    // read-then-write, and two answers for the same chat interleaving there
    // add the same identity twice.
    const chatId = this.chatIds.forAnswer(inviteId)
    const previous = this.#admitting.get(chatId) ?? Promise.resolve()
    const run = previous.then(async () => this.#admitNow(inviteId, chatId, keyPackage, peer))
    const tail = run.catch(() => undefined)
    this.#admitting.set(chatId, tail)
    try {
      await run
    } finally {
      if (this.#admitting.get(chatId) === tail) this.#admitting.delete(chatId)
    }
  }

  async #admitNow(
    inviteId: string,
    chatId: string,
    keyPackage: KeyPackageBytes,
    peer: string
  ): Promise<void> {
    const name = this.chatIds.nameFor?.(inviteId)
    try {
      const existing = await this.client.getGroup(chatId)
      if (existing !== undefined) {
        // MLS accepts a second leaf for an identity already in the tree, so a
        // re-invite would silently duplicate the member. Refusing is this
        // template's policy, not an MLS constraint.
        const present = (await existing.info()).members.some(m => m.identityKey === peer)
        if (present) {
          this.onFailure({
            stage: 'admit',
            chatId,
            peer,
            reason: `${peer} is already in ${chatId}`
          })
          return
        }
        await existing.addMembers([keyPackage])
      } else {
        const own = await this.client.keyPackages.create()
        await this.client.createGroup({
          chatId,
          members: [keyPackage],
          privateKeyPackage: own.privateKeyPackage,
          ...(name === undefined ? {} : { name })
        })
      }
    } catch (cause) {
      if (cause instanceof WelcomeDeliveryError) {
        await this.client.retryDelivery(cause).catch((again: unknown) => {
          // The error itself, not its message: it holds the Welcome bytes.
          this.onFailure({
            stage: 'admit',
            chatId,
            peer,
            reason: String(again),
            undelivered: again instanceof WelcomeDeliveryError ? again : cause
          })
        })
        return
      }
      this.onFailure({ stage: 'admit', chatId, peer, reason: String(cause) })
    }
  }

  /**
   * The join took only if the chat exists and the Welcome row is gone: the join
   * clears the row, so a chat that was already there under this id proves nothing.
   */
  async #joined(inviteId: string, chatId: string): Promise<boolean> {
    try {
      if ((await this.client.getGroup(chatId)) === undefined) return false
      return !(await this.client.invites.list()).some(invite => invite.inviteId === inviteId)
    } catch {
      return false
    }
  }

  /**
   * Match the Welcome to the half it was encrypted to, and join.
   *
   * The ref is cleartext, so anyone holding the public KeyPackage can name it
   * and send a Welcome for their own group. Only the peer this host answered
   * may join it, and the check runs before the half is taken: a refused Welcome
   * must leave the half for the genuine one.
   */
  async #join(inviteId: string, peer: string, ref: string): Promise<void> {
    // A Welcome for a ref already being joined is a redelivery. The record is
    // absent because this host is using it, not because it was lost, and
    // reporting that would be a false failure.
    if (this.#joining.has(ref)) return
    this.#joining.add(ref)
    try {
      await this.#joinNow(inviteId, peer, ref)
    } finally {
      this.#joining.delete(ref)
    }
  }

  async #joinNow(inviteId: string, peer: string, ref: string): Promise<void> {
    const held = await this.shelf.peek(ref)
    if (held === undefined) {
      this.#gone(inviteId, peer, ref)
      return
    }
    if (held.peer !== peer) {
      this.onFailure({
        stage: 'join',
        // Not the chat it impersonates: a refused forgery must not mark the
        // genuine one failed.
        chatId: `refused:${inviteId}`,
        peer,
        reason: `refused a Welcome from ${peer} for ${held.chatId}: the invitation was answered to ${held.peer}`
      })
      return
    }
    const record = await this.shelf.take(ref)
    if (record === undefined) {
      this.#gone(inviteId, peer, ref)
      return
    }
    const { chatId } = record
    try {
      await this.client.joinFromWelcome({ inviteId, chatId, privateKeyPackage: record.half })
    } catch (cause) {
      // A step after the join itself can throw. The chat existing means the
      // join took; re-shelving the half and reporting would leave a chat that
      // is never marked joined.
      if (await this.#joined(inviteId, chatId)) return
      // Back on the shelf: a failure the half is not to blame for must stay
      // retryable.
      await this.shelf.hold(record)
      this.onFailure({ stage: 'join', chatId, peer, reason: String(cause) })
    }
  }

  /** Shelved in another process, or lost with this one. Nothing retries it. */
  #gone(inviteId: string, peer: string, ref: string): void {
    this.onFailure({
      stage: 'join',
      chatId: `unknown:${inviteId}`,
      peer,
      ref,
      reason: 'the private half is gone'
    })
  }
}
