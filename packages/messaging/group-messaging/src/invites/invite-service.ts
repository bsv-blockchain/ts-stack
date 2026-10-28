import { encodeEnvelope, type BootstrapMessage } from '../bootstrap/index.js'
import { randomId, toHex } from '../bytes.js'
import { GroupMessagingError, PermanentProcessingError } from '../errors.js'
import type { StorageProvider } from '../storage/index.js'
import type { TransportService } from '../transport/index.js'
import type {
  IdentityKey,
  KeyPackageBytes,
  KeyPackageRef,
  MlsCiphersuiteName,
  PendingInvite
} from '../types.js'

/** Everything {@link InviteService} needs, injected so it owns none of it. */
export interface InviteServiceDeps {
  identityKey: IdentityKey
  storage: StorageProvider
  transport: TransportService
  ciphersuite: MlsCiphersuiteName
  /**
   * Loosely typed on purpose: the service must not depend on the client.
   * Awaited, so a consumer that has to enrich a payload before publishing it
   * — the client decoding a Welcome to name the KeyPackage it needs — is
   * finished before `handle` returns.
   */
  emit: (event: string, payload: unknown) => void | Promise<void>
  /**
   * The ref of the stored KeyPackage a Welcome was encrypted to, `undefined`
   * when this device holds none, throwing when the bytes are not a Welcome.
   *
   * Injected like {@link InviteServiceDeps.emit} and for the same reason:
   * decoding a Welcome needs the MLS engine, which this service must not
   * import. It runs before anything is stored, so a Welcome this device could
   * never join does not become a row a stranger caused to exist.
   */
  resolveWelcome: (welcome: Uint8Array) => Promise<KeyPackageRef | undefined>
}

/**
 * How many inbound `keyPackageRequest` invites may be pending at once.
 *
 * A stranger can send a request, so without a ceiling any sender can write
 * rows into the host's database until it fills. The cap is deliberately global
 * rather than per-peer: identities are free, so a per-peer count bounds
 * nothing. It is sized to stay a humanly reviewable list — the list is what a
 * user is expected to work through — and the cost of being full is that
 * genuine invitations are refused until some are accepted or declined.
 */
export const MAX_PENDING_INBOUND_REQUESTS = 64

/**
 * The invitation exchange, and the reason no KeyPackage is ever minted
 * automatically: an inbound request is stored and surfaced, and only an
 * explicit `accept` — carrying a KeyPackage the caller minted — answers it.
 *
 * That makes an unwanted invite a full invite list, not a key an attacker
 * caused to exist. `inviteId` is this device's handle and never leaves it;
 * `requestId` is the only value that correlates the two sides.
 */
export class InviteService {
  constructor(private readonly deps: InviteServiceDeps) {}

  /** Ask `peer` for a KeyPackage. Returns the local handle for the exchange. */
  async send(peer: IdentityKey, options: { chatName?: string } = {}): Promise<string> {
    const inviteId = randomId()
    const requestId = randomId()

    await this.deps.storage.putInvite({
      inviteId,
      direction: 'outbound',
      kind: 'keyPackageRequest',
      peer,
      requestId,
      ...(options.chatName === undefined ? {} : { chatName: options.chatName }),
      receivedAt: new Date().toISOString()
    })

    await this.#send(peer, {
      type: 'keyPackageRequest',
      requestId,
      ciphersuites: [this.deps.ciphersuite],
      ...(options.chatName === undefined ? {} : { chatName: options.chatName })
    })
    return inviteId
  }

  /** Invitations still awaiting a decision, newest state as stored. */
  async list(direction?: 'inbound' | 'outbound'): Promise<PendingInvite[]> {
    return this.deps.storage.listInvites(direction)
  }

  /**
   * Answer an inbound request with a KeyPackage the caller minted and stored.
   * The invite is deleted only once the send resolves, so a transport failure
   * leaves it pending and retryable. **A retry MUST pass the same KeyPackage.**
   * Minting a fresh one orphans the first: its private half is already in the
   * caller's store with nothing that will ever reference it, and if the failed
   * send in fact reached the peer, they hold a KeyPackage this device will not
   * recognize when the Welcome arrives.
   *
   * The KeyPackage is also bound to the requesting peer, if this client stored
   * it, and only that peer's Welcome for it is accepted afterwards. It throws
   * before sending anything if the KeyPackage was already handed to a different
   * peer: mint one per invitation. Answering the same peer again is fine.
   */
  async accept(inviteId: string, keyPackage: KeyPackageBytes): Promise<void> {
    const invite = await this.#require(inviteId)
    this.#requireInboundRequest(invite)
    this.#requireSupportedCiphersuite(invite)
    await this.#bind(invite.peer, keyPackage)
    await this.#send(invite.peer, {
      type: 'keyPackageResponse',
      requestId: invite.requestId,
      keyPackage
    })
    await this.deps.storage.deleteInvite(inviteId)
  }

  /**
   * Record whom a stored KeyPackage is being handed to, before the send: the
   * binding must exist by the time the KeyPackage is on the wire, since a
   * Welcome can follow at once, and a send that arrived unacknowledged must
   * still be bound. The KeyPackage is found by its bytes among those
   * `keyPackages.create` stored; one never stored cannot resolve a Welcome
   * later, so there is nothing to bind.
   *
   * A KeyPackage already handed to a different peer is refused. Rebinding it
   * would silently retarget the ref and the first peer's genuine Welcome would
   * then be turned away; a KeyPackage is single-use, so it has one owner.
   */
  async #bind(peer: IdentityKey, keyPackage: KeyPackageBytes): Promise<void> {
    for (const ref of await this.deps.storage.listKeyPackageRefs()) {
      const stored = await this.deps.storage.getKeyPackage(ref)
      if (stored === undefined || toHex(stored) !== toHex(keyPackage)) continue
      const owner = await this.deps.storage.keyPackageOwner(ref)
      if (owner !== undefined && owner !== peer) {
        throw new GroupMessagingError(
          `KeyPackage ${ref} was already handed to ${owner}; answer ${peer} with a fresh one. ` +
            `Nothing was sent and the invitation is still pending.`
        )
      }
      await this.deps.storage.bindKeyPackage(ref, peer)
      return
    }
  }

  /**
   * The only invite an `accept` can answer is a request somebody sent us.
   *
   * Every other row would be answered with a `keyPackageResponse` nobody asked
   * for and then deleted — and for an inbound welcome the deleted row holds the
   * only copy of the Welcome bytes, so the group becomes unjoinable.
   */
  #requireInboundRequest(invite: PendingInvite): void {
    if (invite.direction === 'inbound' && invite.kind === 'keyPackageRequest') return
    throw new GroupMessagingError(
      `Invite ${invite.inviteId} is an ${invite.direction} ${invite.kind}; only an inbound ` +
        `keyPackageRequest can be accepted. Nothing was sent and nothing was deleted.`
    )
  }

  /**
   * Refuse an invitation for a ciphersuite this client cannot serve.
   *
   * The engine is bound to one suite and `joinFromWelcome` rejects a Welcome
   * for any other, so answering a cross-suite invitation would leave the caller
   * storing the private half of a KeyPackage for a group this device can never
   * enter. Refusing here is not the design decision about how a group's suite
   * should be negotiated; it is the honest failure until that is made.
   */
  #requireSupportedCiphersuite(invite: PendingInvite): void {
    const offered = invite.ciphersuites
    if (offered === undefined || offered.includes(this.deps.ciphersuite)) return
    throw new GroupMessagingError(
      `Invite ${invite.inviteId} asks for ciphersuite [${offered.join(', ')}]; this client ` +
        `uses ${this.deps.ciphersuite}. Nothing was minted: a KeyPackage for that suite ` +
        `could answer the invitation but never join the group.`
    )
  }

  /**
   * Give up on an invitation, and on the public ref it names in storage.
   *
   * The ref goes with the row because one left behind would still match a
   * Welcome that arrives later, which the host has decided never to join.
   * Retired quietly, without `keyPackageConsumed`: that event tells the host to
   * destroy a private half, and the host that abandons holds its own.
   *
   * The library does not expire invitations on a timer: how long to wait is the
   * host's to decide, and a wallet that forgets a pending join while its user
   * is still expecting it is worse than one that keeps a few bytes.
   * `invites.list()` is how a host finds candidates.
   */
  async abandon(inviteId: string): Promise<void> {
    const invite = await this.#require(inviteId)
    if (invite.ref !== undefined) await this.deps.storage.deleteKeyPackage(invite.ref)
    await this.deps.storage.deleteInvite(inviteId)
  }

  /** Refuse an inbound request, telling the peer so it stops waiting. */
  async decline(inviteId: string): Promise<void> {
    const invite = await this.#require(inviteId)
    await this.#send(invite.peer, { type: 'keyPackageDecline', requestId: invite.requestId })
    await this.deps.storage.deleteInvite(inviteId)
  }

  /**
   * Route one inbound bootstrap message: store it, emit, and stop.
   *
   * A response or decline that does not answer a request this device actually
   * sent to that peer touches no storage, but is reported via
   * `bootstrapRefused` rather than dropped silently — the check that stops a
   * stranger inserting their own KeyPackage into somebody else's exchange
   * should leave a record that it fired.
   */
  /** Every refusal path reports the same shape; only the reason differs. */
  async #refuse(
    peer: IdentityKey,
    kind: BootstrapMessage['type'],
    requestId: string,
    reason: string
  ): Promise<void> {
    await this.deps.emit('bootstrapRefused', { peer, kind, requestId, reason })
  }

  async handle(peer: IdentityKey, message: BootstrapMessage): Promise<void> {
    switch (message.type) {
      case 'keyPackageRequest':
        return this.#onKeyPackageRequest(peer, message)
      case 'keyPackageResponse':
        return this.#onKeyPackageResponse(peer, message)
      case 'keyPackageDecline':
        return this.#onKeyPackageDecline(peer, message)
      case 'welcome':
        return this.#onWelcome(peer, message)
    }
  }

  async #onKeyPackageRequest(
    peer: IdentityKey,
    message: Extract<BootstrapMessage, { type: 'keyPackageRequest' }>
  ): Promise<void> {
    // `decodeEnvelope` narrows the offer to suites this library has, so an
    // empty list is a peer asking for something we cannot answer. Storing it
    // would put a row in front of a user whose only move is to decline.
    if (message.ciphersuites.length === 0) {
      return this.#refuse(
        peer,
        'keyPackageRequest',
        message.requestId,
        'offers no ciphersuite this client supports'
      )
    }
    const pending = (await this.deps.storage.listInvites('inbound')).filter(
      invite => invite.kind === 'keyPackageRequest'
    )
    // A resend after a dropped ack is routine; it must reuse the row it already
    // made rather than add one the user has to decline twice.
    const duplicate = pending.some(
      invite => invite.peer === peer && invite.requestId === message.requestId
    )
    if (duplicate) {
      return this.#refuse(
        peer,
        'keyPackageRequest',
        message.requestId,
        'an invitation from this peer already holds this request id'
      )
    }
    if (pending.length >= MAX_PENDING_INBOUND_REQUESTS) {
      return this.#refuse(
        peer,
        'keyPackageRequest',
        message.requestId,
        `${MAX_PENDING_INBOUND_REQUESTS} invitations are already pending a decision`
      )
    }
    const inviteId = randomId()
    await this.deps.storage.putInvite({
      inviteId,
      direction: 'inbound',
      kind: 'keyPackageRequest',
      peer,
      requestId: message.requestId,
      ciphersuites: message.ciphersuites,
      ...(message.chatName === undefined ? {} : { chatName: message.chatName }),
      receivedAt: new Date().toISOString()
    })
    await this.deps.emit('inviteReceived', {
      inviteId,
      peer,
      ciphersuites: message.ciphersuites,
      ...(message.chatName === undefined ? {} : { chatName: message.chatName })
    })
  }

  async #onKeyPackageResponse(
    peer: IdentityKey,
    message: Extract<BootstrapMessage, { type: 'keyPackageResponse' }>
  ): Promise<void> {
    const invite = await this.#answered(message.requestId, peer)
    if (invite === undefined) {
      return this.#refuse(
        peer,
        'keyPackageResponse',
        message.requestId,
        'no outbound invitation matches this request id and sender'
      )
    }
    await this.deps.storage.deleteInvite(invite.inviteId)
    await this.deps.emit('keyPackageReceived', {
      inviteId: invite.inviteId,
      peer,
      keyPackage: message.keyPackage,
      // The row is already gone, so this is the host's only way to learn which
      // chat the invitation was sent for.
      ...(invite.chatName === undefined ? {} : { chatName: invite.chatName })
    })
  }

  async #onKeyPackageDecline(
    peer: IdentityKey,
    message: Extract<BootstrapMessage, { type: 'keyPackageDecline' }>
  ): Promise<void> {
    const invite = await this.#answered(message.requestId, peer)
    if (invite === undefined) {
      return this.#refuse(
        peer,
        'keyPackageDecline',
        message.requestId,
        'no outbound invitation matches this request id and sender'
      )
    }
    await this.deps.storage.deleteInvite(invite.inviteId)
    await this.deps.emit('inviteDeclined', { inviteId: invite.inviteId, peer })
  }

  async #onWelcome(
    peer: IdentityKey,
    message: Extract<BootstrapMessage, { type: 'welcome' }>
  ): Promise<void> {
    // A Welcome carries no checkable correlator — `deliverWelcome` mints a
    // fresh requestId per recipient — so a held KeyPackage is the only test.
    let ref: KeyPackageRef | undefined
    try {
      ref = await this.deps.resolveWelcome(message.welcome)
    } catch (cause) {
      throw new PermanentProcessingError(
        'Welcome bytes could not be read; no retry makes them readable',
        { cause }
      )
    }
    if (ref === undefined) {
      return this.#refuse(
        peer,
        'welcome',
        message.requestId,
        'no stored KeyPackage matches this Welcome'
      )
    }
    // The ref is cleartext, so naming one proves nothing. A KeyPackage this
    // device answered with is bound to the peer it was answered to, and any
    // other sender is refused before a row exists: a forger costs no storage
    // and cannot shadow the genuine Welcome. The ref-and-sender key below then
    // amounts to one row per bound ref. A ref never bound (a hand-minted or
    // pooled KeyPackage) has no known owner, so there the key is the only bound:
    // one row per identity a forger controls.
    const owner = await this.deps.storage.keyPackageOwner(ref)
    if (owner !== undefined && owner !== peer) {
      return this.#refuse(
        peer,
        'welcome',
        message.requestId,
        'this KeyPackage was handed to a different peer'
      )
    }
    const held = (await this.deps.storage.listInvites()).find(
      invite => invite.kind === 'welcome' && invite.ref === ref && invite.peer === peer
    )
    if (held !== undefined) {
      return this.#refuse(
        peer,
        'welcome',
        message.requestId,
        'this sender already has a pending Welcome for this KeyPackage'
      )
    }
    const inviteId = randomId()
    await this.deps.storage.putInvite({
      inviteId,
      direction: 'inbound',
      kind: 'welcome',
      peer,
      requestId: message.requestId,
      ref,
      welcome: toHex(message.welcome),
      ...(message.chatName === undefined ? {} : { chatName: message.chatName }),
      receivedAt: new Date().toISOString()
    })
    await this.deps.emit('welcomeReceived', {
      inviteId,
      peer,
      ref,
      welcome: message.welcome,
      ...(message.chatName === undefined ? {} : { chatName: message.chatName })
    })
  }

  /**
   * The outbound invite a response or decline legitimately answers, if any.
   *
   * `requestId` alone is not enough to identify one. The peer chooses the
   * `requestId` in the request it sends us, so matching on it alone lets that
   * peer send a response bearing the same value and have it resolve to our own
   * *inbound* invite — consuming the one awaiting our accept and surfacing
   * attacker-chosen bytes as if we had asked for them. Asking storage for the
   * `outbound` row closes that, and closes it whichever order the backend
   * happens to list a colliding pair in; requiring the peer to match closes the
   * parallel case where a third party learns a `requestId` we sent to somebody
   * else.
   */
  async #answered(requestId: string, peer: IdentityKey): Promise<PendingInvite | undefined> {
    const invite = await this.deps.storage.inviteForRequestId(requestId, 'outbound')
    if (invite === undefined) return undefined
    if (invite.peer !== peer) return undefined
    return invite
  }

  async #require(inviteId: string): Promise<PendingInvite> {
    const invite = await this.deps.storage.getInvite(inviteId)
    if (invite === undefined) throw new GroupMessagingError(`No invite ${inviteId}`)
    return invite
  }

  async #send(peer: IdentityKey, message: BootstrapMessage): Promise<void> {
    await this.deps.transport.send(peer, encodeEnvelope({ kind: 'bootstrap', message }))
  }
}
