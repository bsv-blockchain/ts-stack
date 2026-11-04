/**
 * One owner for the client's lifetime.
 *
 * Source to copy into your host and own. It is not part of the package's API
 * and carries no compatibility promise.
 *
 * Reviewing the first real integration turned up three defects that look
 * unrelated — a cache key without the identity in it, an open with no cleanup
 * on failure, and two screens that each decided when to open and close — and
 * are one thing: nobody owned the client's lifetime. It lived in a pair of
 * module-scoped `let`s that any component could reach.
 *
 * None of the three needed anything the library does not already offer.
 * `client.identityKey` says whose a cached client is, `close()` tears one down,
 * and the invariants name the rule (one client per identity per process). They
 * happened because the rule had no owner. This is that owner.
 *
 * What it guarantees:
 *
 * - **You cannot ask for a client without saying whose it is.** {@link ClientKey}
 *   makes `identityKey` structurally mandatory, so the original defect is a
 *   compile error rather than a silent wrong answer.
 * - **A failed open releases what it acquired.** `acquire` and `create` are
 *   separate so the owner can run the `try`/`catch` the host kept forgetting;
 *   a database handle opened before a throwing `create` is closed, not leaked.
 * - **A key change closes the old client before opening the new one**, awaited.
 *   Fire-and-forget teardown runs the old `close()` concurrently with the new
 *   `create()` on the same identity and storage, which invariant 8 forbids.
 * - **Concurrent callers share one open.** Two screens asking at once get one
 *   client, not two racing on `putGroup`.
 *
 * ## What it still leaves to you
 *
 * - **Calling it from one place.** This owns the client; something still has to
 *   own this. A module-level instance is fine; one per component is the bug
 *   again with extra steps.
 * - **Noticing the identity changed.** It answers what you ask. If your UI
 *   never re-asks after a profile switch, it never learns.
 * - **What `acquire` means.** It is whatever must be released if the open
 *   fails — usually a database handle. Return `undefined` if there is nothing.
 * - **Resubscribing.** Handlers registered on a closed client are dead. Take a
 *   fresh client from `get` and re-register after any key change.
 */
import type { GroupMessagingClient, IdentityKey } from '@bsv/group-messaging'

/**
 * Everything that decides *which* client this is.
 *
 * `identityKey` is mandatory because leaving it out is the defect this exists
 * for. Add whatever else you vary — the chain, the relay host — as further
 * properties; they all take part in the key.
 */
export interface ClientKey {
  identityKey: IdentityKey
  [dimension: string]: string | undefined
}

/**
 * How to build one client, split so a failure between the two can be cleaned up.
 *
 * `R` is whatever `acquire` hands back and `release` takes: a database handle,
 * a socket, `undefined`.
 */
export interface ClientRecipe<R> {
  /** Acquire what the client needs. Runs first; released if anything after it throws. */
  acquire: () => Promise<R>
  /** Build the client. If this throws, `release` runs and the error is rethrown. */
  create: (resource: R) => Promise<GroupMessagingClient>
  /** Release what `acquire` returned. Runs after `client.close()`, and on a failed open. */
  release: (resource: R) => Promise<void>
}

interface Held<R> {
  key: string
  client: GroupMessagingClient
  resource: R
  /** Kept from the recipe that acquired it; re-deriving could release the wrong thing. */
  release: (resource: R) => Promise<void>
}

/**
 * Stable regardless of property order, so two spellings of one key agree.
 *
 * Structural rather than joined: a relay URL containing `&zone=b` would make
 * `{relay: 'a', zone: 'b'}` and `{relay: 'a&zone=b'}` the same string under a
 * separator join, which is the cache-key collision this file exists to prevent,
 * one dimension over from the identity it guards. `JSON.stringify` also keeps
 * an absent dimension distinct from an empty one, so a host that conditionally
 * spreads a property does not tear the client down on a render that changed
 * nothing.
 */
const keyOf = (key: ClientKey): string =>
  JSON.stringify(
    Object.keys(key)
      // Code-unit order, not `localeCompare`: this string is a cache key, so it
      // has to come out identical on every device. A locale-aware collation is
      // the one comparison that could order the same two names differently
      // under a different ICU build and quietly reopen a client that was held.
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map(name => [name, key[name] ?? null])
  )

export class ClientOwner<R> {
  readonly #recipeFor: (key: ClientKey) => ClientRecipe<R>
  #held: Held<R> | undefined
  /** Serialises opens and closes, so two callers cannot interleave them. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(recipeFor: (key: ClientKey) => ClientRecipe<R>) {
    this.#recipeFor = recipeFor
  }

  /**
   * The client for this key, opening it if necessary and closing any other.
   *
   * Safe to call on every render: the same key returns the same client.
   */
  async get(key: ClientKey): Promise<GroupMessagingClient> {
    return this.#serialise(async () => {
      const wanted = keyOf(key)
      const held = this.#held
      if (held?.key === wanted) {
        // Belt and braces. If this ever fires, something reached past the owner
        // and the quiet wrong answer is the one that cost three bugs.
        if (held.client.identityKey !== key.identityKey) {
          throw new Error(
            `Held client belongs to ${held.client.identityKey}, not ${key.identityKey}`
          )
        }
        return held.client
      }

      await this.#closeHeld()

      const recipe = this.#recipeFor(key)
      const resource = await recipe.acquire()
      let client: GroupMessagingClient
      try {
        client = await recipe.create(resource)
      } catch (cause) {
        // The leak the host kept writing: only the success path built a close.
        await recipe.release(resource).catch(() => undefined)
        throw cause
      }

      this.#held = { key: wanted, client, resource, release: recipe.release }
      return client
    })
  }

  /** Close and release whatever is held. Idempotent; safe to call on teardown. */
  async close(): Promise<void> {
    await this.#serialise(() => this.#closeHeld())
  }

  /** Whose client is held, if any. For a host that wants to render it. */
  get identityKey(): IdentityKey | undefined {
    return this.#held?.client.identityKey
  }

  async #closeHeld(): Promise<void> {
    const held = this.#held
    if (held === undefined) return
    // Cleared first: a throwing close must not leave a client nobody can
    // replace, which would wedge the host until restart.
    this.#held = undefined
    try {
      await held.client.close()
    } finally {
      await held.release(held.resource)
    }
  }

  async #serialise<T>(work: () => Promise<T>): Promise<T> {
    // `then(work, work)` runs the next piece of work whether or not this one
    // failed, so a rejection cannot stall the chain. Every caller awaits the
    // promise returned here, so the rejection is always observed.
    const next = this.#queue.then(work, work)
    this.#queue = next
    return next
  }
}
