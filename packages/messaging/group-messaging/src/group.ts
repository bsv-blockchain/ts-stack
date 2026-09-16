import { encodeEnvelope } from './bootstrap/index.js'
import type { GroupMessagingClient } from './client.js'
import {
  encodeContent,
  markdown as markdownContent,
  text as textContent,
  type MessageContent,
  type Reaction,
  type RemoteAttachment
} from './content/index.js'
import { GroupMessagingError, UnknownGroupError } from './errors.js'
import type { ChatId, ChatInfo, IdentityKey, KeyPackageBytes, MlsGroupId } from './types.js'

/**
 * One MLS group, as a chat.
 *
 * Commit, Proposal and Welcome mechanics stay inside; callers deal in members
 * and messages. Every method reads the group's current state from storage and
 * writes the advanced state back, so two `Group` handles to the same group
 * never hold diverging copies.
 *
 * Every operation persists before it sends. The group has advanced locally
 * whether or not delivery succeeded, which is the only safe order: an MLS
 * ratchet that moved for the recipients but not for us cannot be recovered,
 * while a Commit nobody received can be resent.
 */
export class Group {
  constructor(
    /** The application's local name for this chat. Never leaves the device. */
    readonly chatId: ChatId,
    /** The MLS group identifier. The only cross-party name for this group. */
    readonly mlsGroupId: MlsGroupId,
    private readonly client: GroupMessagingClient
  ) {}

  /**
   * The chat's name and identifier, over the MLS group's epoch and roster.
   *
   * The first pair comes from the stored chat record — the engine has no way to
   * know them — and the second from the group state.
   */
  async info(): Promise<ChatInfo> {
    const chat = await this.client.storage.getChat(this.chatId)
    if (chat === undefined) throw new GroupMessagingError(`No chat ${this.chatId}`)
    const summary = await this.client.engine.info(await this.state())
    return {
      chatId: chat.chatId,
      mlsGroupId: summary.mlsGroupId,
      name: chat.name,
      epoch: summary.epoch,
      members: summary.members
    }
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /** Send plain text. */
  async sendText(body: string): Promise<void> {
    return this.sendContent(textContent(body))
  }

  /** Send Markdown, with an optional distinct plain-text fallback. */
  async sendMarkdown(source: string, body?: string): Promise<void> {
    return this.sendContent(markdownContent(source, body))
  }

  async sendRemoteAttachment(attachment: RemoteAttachment, body?: string): Promise<void> {
    return this.sendContent({
      v: 1,
      type: 'remoteAttachment',
      body: body ?? attachment.filename ?? 'Attachment',
      attachments: [attachment]
    })
  }

  async sendReaction(input: {
    reference: string
    content: string
    action?: Reaction['action']
    schema?: Reaction['schema']
  }): Promise<void> {
    return this.sendContent({
      v: 1,
      type: 'reaction',
      body: input.content,
      reaction: {
        reference: input.reference,
        action: input.action ?? 'added',
        content: input.content,
        schema: input.schema ?? 'unicode'
      }
    })
  }

  async sendReply(input: { reference: string; body: string; markdown?: string }): Promise<void> {
    return this.sendContent({
      v: 1,
      type: 'reply',
      body: input.body,
      ...(input.markdown === undefined ? {} : { markdown: input.markdown }),
      replyTo: input.reference
    })
  }

  /** Send an already-constructed content envelope. */
  async sendContent(content: MessageContent): Promise<void> {
    return this.send(encodeContent(content))
  }

  /** Encrypt arbitrary bytes to the current epoch and deliver them. */
  async send(plaintext: Uint8Array): Promise<void> {
    const { state, message } = await this.#advance(async current =>
      this.client.engine.encrypt({ state: current, plaintext })
    )
    await this.#broadcast(state, message)
  }

  // ── Membership ───────────────────────────────────────────────────────────

  /**
   * Add members and tell the group.
   *
   * The existing members get the Commit; the newcomers get the Welcome, which
   * carries the ratchet tree they have no other source for.
   *
   * Both describe the same epoch transition, and the group has already advanced
   * past it locally, so a failed Commit must not cancel the Welcome. A Commit
   * can be resent from the stored state; a Welcome cannot — nothing keeps its
   * bytes, and the newcomers are in the roster either way, so a Welcome not
   * sent here is a member who can never join. The Commit still goes first, so
   * the group is at the new epoch before a newcomer can speak at it, and its
   * failure is rethrown once the Welcome has had its turn.
   */
  async addMembers(keyPackages: KeyPackageBytes[]): Promise<void> {
    const { commit, welcome, existing } = await this.#advance(async current => {
      const before = await this.#recipients(current)
      const result = await this.client.engine.addMembers({ state: current, keyPackages })
      return { ...result, existing: before }
    })

    let commitFailure: unknown
    try {
      await this.#deliver(existing, commit)
    } catch (error) {
      commitFailure = error
    }
    const chat = await this.client.storage.getChat(this.chatId)
    await this.client.deliverWelcome(this, keyPackages, welcome, chat?.name)
    if (commitFailure !== undefined) throw commitFailure
  }

  /**
   * Remove members and tell the group.
   *
   * The Commit goes to the members that remain. Those removed are not told:
   * they cannot process a Commit that blanks their own leaf, so sending it
   * would produce nothing but a processing failure on their side.
   */
  async removeMembers(identities: IdentityKey[]): Promise<void> {
    const result = await this.#advance(async current =>
      this.client.engine.removeMembers({ state: current, identityKeys: identities })
    )
    await this.#broadcast(result.state, result.commit)
  }

  /** Rotate this client's leaf key, for post-compromise security. */
  async update(): Promise<void> {
    const result = await this.#advance(async current =>
      this.client.engine.update({ state: current })
    )
    await this.#broadcast(result.state, result.commit)
  }

  /** Forget this chat, its MLS state, and everything queued for it. */
  async delete(): Promise<void> {
    await this.client.withGroupLock(this.mlsGroupId, async () => {
      await this.client.storage.deleteChat(this.chatId)
      await this.client.storage.deleteGroup(this.mlsGroupId)
    })
  }

  /**
   * Read the group's state, advance it, and persist the result with nothing
   * else touching the group in between.
   *
   * Delivery is deliberately left outside the lock. The invariant that must
   * hold is that no two operations derive from the same stored state; holding
   * the lock across a network round trip adds nothing to that and would let a
   * transport that delivers inbound traffic synchronously deadlock a send
   * against the message arriving mid-send.
   */
  async #advance<T extends { state: Uint8Array }>(
    operation: (state: Uint8Array) => Promise<T>
  ): Promise<T> {
    return this.client.withGroupLock(this.mlsGroupId, async () => {
      const result = await operation(await this.state())
      await this.client.storage.putGroup(this.mlsGroupId, result.state)
      return result
    })
  }

  /** @internal */
  async state(): Promise<Uint8Array> {
    const state = await this.client.storage.getGroup(this.mlsGroupId)
    if (state === undefined) throw new UnknownGroupError(this.mlsGroupId)
    return state
  }

  /** Every member of `state` except this client. */
  async #recipients(state: Uint8Array): Promise<IdentityKey[]> {
    const info = await this.client.engine.info(state)
    return info.members
      .map(member => member.identityKey)
      .filter(identityKey => identityKey !== this.client.identityKey)
  }

  async #broadcast(state: Uint8Array, message: Uint8Array): Promise<void> {
    await this.#deliver(await this.#recipients(state), message)
  }

  async #deliver(recipients: IdentityKey[], message: Uint8Array): Promise<void> {
    if (recipients.length === 0) return
    const payload = encodeEnvelope({ kind: 'mls', payload: message })
    try {
      await this.client.transport.broadcast(this.mlsGroupId, recipients, payload)
    } catch (error) {
      // The group has advanced locally regardless; the caller decides on retry.
      this.client.emit('deliveryFailed', {
        chatId: this.chatId,
        mlsGroupId: this.mlsGroupId,
        recipients,
        error: error as Error
      })
      throw error
    }
  }
}
