/**
 * The record of what was said, and the order its writes happen in.
 *
 * Source to copy into your host and own. It is not part of the package's API
 * and carries no compatibility promise.
 *
 * The library hands each message to a subscriber exactly once and keeps no log.
 * That is deliberate — how long a transcript lives is the host's decision, not
 * a library's — but it means every host writes the same table, and the first
 * one to do it wrote two bugs into it.
 *
 * **The read beat the write.** The host subscribed to `message` and did
 * `void transcript.append(...)`, while a screen subscribed to the same event
 * and did `void reload()`, which SELECTs. Two un-awaited promises on one event:
 * the SELECT could run before the INSERT, so an arriving message did not appear
 * until something else forced a refresh. It read as "stale UI" and cost a day.
 * {@link Transcript.follow} exists so no host writes that again: it appends,
 * and only then tells anyone, so a listener that re-reads cannot miss the row.
 *
 * **Your own messages are not echoed.** MLS does not deliver a sender its own
 * message, so unless the host records what it sends, a sent message vanishes on
 * the next read. {@link Transcript.record} is that call, and the 677-line screen
 * that got it wrong had no test covering it.
 *
 * ## Message ids come from the library
 *
 * Every send returns a `messageId` and every `message` event carries the same
 * one, derived from the ciphertext rather than chosen by the sender, so both
 * ends agree without the two clients having to agree on anything first. Pass
 * what the send returned to {@link Transcript.record}; {@link Transcript.follow}
 * takes the one on the event. That is what `replyTo` and a reaction's
 * `reference` name.
 *
 * An earlier version of this file minted its own ids into `extra.messageId`,
 * which worked only for hosts that had copied this same file.
 *
 * ## What it still leaves to you
 *
 * - **Retention.** Nothing here deletes. A transcript grows until you prune it.
 * - **Scoping.** One table serves one identity. Give each its own `tableName`,
 *   or add an identity column.
 * - **Paging.** {@link Transcript.list} returns a whole chat. A long one wants
 *   a cursor and a virtualised list; reading 10,000 rows to draw 20 is the
 *   other thing that integration did.
 * - **Attachments.** Only the envelope is stored. Bytes behind a
 *   `RemoteAttachment` URL are yours to fetch, verify and cache.
 */
import type {
  GroupMessagingClient,
  IdentityKey,
  MessageContent,
  SqlDriver,
  Unsubscribe
} from '@bsv/group-messaging'

const DEFAULT_TABLE = 'group_messaging_transcript'

export interface StoredMessage {
  chatId: string
  /** The library's id for the message; what a reply or a reaction references. */
  id: string
  sender: IdentityKey
  /** Milliseconds since the epoch, as this device saw it. */
  at: number
  content: MessageContent
}

export interface TranscriptOptions {
  tableName?: string
  now?: () => number
  /**
   * Where a failed write surfaces.
   *
   * `follow` cannot throw at a caller — nobody awaits an inbound message — and
   * the library's emitter only catches synchronous throws, so without this a
   * rejected INSERT becomes an unhandled rejection and the message is simply
   * gone. It is gone either way: the library hands each message over exactly
   * once and has already committed the new group state by the time the
   * subscriber runs. The choice is between losing it loudly and losing it
   * silently, and the default is loud: a host that has not thought about this
   * yet gets a log line rather than a message that was never there.
   *
   * Replace it with whatever reporting you already have. The library's own
   * emitter rethrows on a fresh task instead, which reaches the platform's
   * unhandled-error handling; a template is host code, so it logs where a host
   * looks rather than inflicting a redbox from a file somebody copied.
   */
  onError?: (error: Error, message: StoredMessage) => void
}

/** The default `onError`: lose the message, but never lose the fact of it. */
const reportLostMessage = (error: Error, message: StoredMessage): void => {
  console.error(`Transcript: dropped message ${message.id} in chat ${message.chatId}`, error)
}

const validName = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unusable table name: ${name}`)
  return name
}

interface Row {
  id: number
  chatId: string
  messageId: string
  sender: string
  at: number
  content: string
  body: string
}

export class Transcript {
  readonly #driver: SqlDriver
  readonly #table: string
  readonly #now: () => number
  readonly #listeners = new Set<(message: StoredMessage) => void>()
  readonly #onError: (error: Error, message: StoredMessage) => void
  /**
   * Serialises writes so two appends cannot land out of order.
   *
   * This was removed once, on the evidence that deleting it broke no test, and
   * put back when that turned out to be a property of the test driver rather
   * than of the code: `node:sqlite` runs synchronously behind an async facade,
   * so concurrent appends there are never concurrent. The driver this seam
   * actually targets says the opposite in writing — concurrent
   * non-transactional statements carry no ordering guarantee — and `follow`
   * issues exactly those, un-awaited, one per inbound message. Without this,
   * the `at`/`id` ordering below is a hope rather than a guarantee, because
   * `id` is the rowid assigned at INSERT *execution*.
   */
  #writes: Promise<unknown> = Promise.resolve()

  private constructor(
    driver: SqlDriver,
    table: string,
    now: () => number,
    onError: (error: Error, message: StoredMessage) => void
  ) {
    this.#driver = driver
    this.#table = table
    this.#now = now
    this.#onError = onError
  }

  static async open(driver: SqlDriver, options: TranscriptOptions = {}): Promise<Transcript> {
    const table = validName(options.tableName ?? DEFAULT_TABLE)
    // Every column the current version uses. A fresh install must not run a
    // migration to reach the shape it was just created in — the integration
    // this came from declared a stale schema and then ALTERed it on every
    // first open, which turned a legacy path into the normal one and made two
    // concurrent opens collide on `duplicate column name`.
    await driver.execAsync(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        sender TEXT NOT NULL,
        at INTEGER NOT NULL,
        content TEXT NOT NULL,
        body TEXT NOT NULL
      )`
    )
    await driver.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_${table}_chat ON ${table}(chatId, at, id)`
    )
    return new Transcript(
      driver,
      table,
      options.now ?? Date.now,
      options.onError ?? reportLostMessage
    )
  }

  async append(message: StoredMessage): Promise<void> {
    await this.#serialise(async () => {
      await this.#driver.runAsync(
        `INSERT INTO ${this.#table} (chatId, messageId, sender, at, content, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          message.chatId,
          message.id,
          message.sender,
          message.at,
          JSON.stringify(message.content),
          // Kept alongside the envelope so a row stays readable to anything
          // that only knows `body`, which is the library's own degradation rule
          // for an unknown `type`.
          message.content.body ?? ''
        ]
      )
    })
    for (const listener of this.#listeners) {
      try {
        listener(message)
      } catch {
        // One screen throwing must not stop another being told.
      }
    }
  }

  /**
   * Record a message this device sent. MLS does not echo it back, so without
   * this it is gone on the next read.
   *
   * `id` is what the send returned. It is required because the sender always
   * has it — including on a `BroadcastError`, where it is on the
   * `deliveryFailed` event — and a locally invented substitute would be an id
   * no other member could resolve.
   */
  async record(input: {
    chatId: string
    sender: IdentityKey
    content: MessageContent
    id: string
  }): Promise<StoredMessage> {
    const message: StoredMessage = {
      chatId: input.chatId,
      id: input.id,
      sender: input.sender,
      at: this.#now(),
      content: input.content
    }
    await this.append(message)
    return message
  }

  /**
   * Append every inbound message, then tell listeners.
   *
   * The ordering is the point. A listener that re-reads the chat sees the row
   * that triggered it, so a host has no reason to write the un-awaited
   * append-and-reload pair that loses messages.
   */
  follow(client: GroupMessagingClient): Unsubscribe {
    return client.on('message', event => {
      const message: StoredMessage = {
        chatId: event.chatId,
        id: event.messageId,
        sender: event.sender,
        at: this.#now(),
        content: event.content
      }
      this.append(message).catch((cause: unknown) => {
        this.#onError(cause instanceof Error ? cause : new Error(String(cause)), message)
      })
    })
  }

  /** Called after a message has been written, never before. */
  onAppended(listener: (message: StoredMessage) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async list(chatId: string): Promise<StoredMessage[]> {
    // `at` then `id`: two messages can share a millisecond, and arrival order
    // is the only tiebreak this device can honestly claim. `id` is the rowid,
    // assigned when the INSERT executes — which is arrival order only because
    // `append` serialises its writes.
    const rows = await this.#driver.getAllAsync<Row>(
      `SELECT id, chatId, messageId, sender, at, content, body FROM ${this.#table}
       WHERE chatId = ? ORDER BY at ASC, id ASC`,
      [chatId]
    )
    return rows.map(row => ({
      chatId: row.chatId,
      id: row.messageId,
      sender: row.sender as IdentityKey,
      at: row.at,
      content: parse(row.content, row.body)
    }))
  }

  async #serialise<T>(work: () => Promise<T>): Promise<T> {
    // `then(work, work)` runs the next write whether or not this one failed,
    // so a rejection cannot stall the chain. Every caller awaits the promise
    // returned here, so the rejection is always observed.
    const next = this.#writes.then(work, work)
    this.#writes = next
    return next
  }
}

const parse = (stored: string, body: string): MessageContent => {
  try {
    const value: unknown = JSON.parse(stored)
    // A scalar parses fine and is not an envelope; without this the `catch`
    // never fires and a caller gets a number where it expects `content.type`.
    if (typeof value !== 'object' || value === null) return { v: 1, type: 'text', body }
    return value as MessageContent
  } catch {
    return { v: 1, type: 'text', body }
  }
}
