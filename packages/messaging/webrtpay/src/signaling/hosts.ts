/**
 * Which MessageBox host a recipient uses, remembered for a while. Internal: not exported from
 * the package.
 */

/** Recipients whose host is remembered, at most. */
export const MAX_REMEMBERED_HOSTS = 256
/** How long a resolved host is trusted, in milliseconds. */
export const HOST_TTL_MS = 5 * 60 * 1000

interface Entry {
  host: Promise<string>
  at: number
}

/**
 * A bounded cache of `resolve(identityKey)`: one lookup per recipient per {@link HOST_TTL_MS},
 * at most {@link MAX_REMEMBERED_HOSTS} remembered (oldest dropped first). A lookup that fails
 * is forgotten, so the next asks again.
 */
export class RecipientHosts {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly resolve: (identityKey: string) => Promise<string>,
    private readonly now: () => number = Date.now
  ) {}

  /** The recipient's host. */
  of(identityKey: string): Promise<string> {
    const now = this.now()
    const known = this.entries.get(identityKey)
    if (known !== undefined && now - known.at < HOST_TTL_MS) return known.host
    this.entries.delete(identityKey)
    const host = Promise.resolve().then(() => this.resolve(identityKey))
    const entry: Entry = { host, at: now }
    this.entries.set(identityKey, entry)
    host.catch(() => {
      if (this.entries.get(identityKey) === entry) this.entries.delete(identityKey)
    })
    while (this.entries.size > MAX_REMEMBERED_HOSTS) {
      this.entries.delete(this.entries.keys().next().value as string)
    }
    return host
  }
}

/** True when `a` and `b` are URLs with the same origin; false for anything unparsable. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}
