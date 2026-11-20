const MAX_CACHED_GRANTS = 1024
const MAX_PENDING_GRANTS = 64

/**
 * Time-limited remembered approvals keyed by grant scope, plus at most one
 * pending decision per decision key so that concurrent equivalent requests
 * share one prompt. The decision key is the grant scope under 'grant' and the
 * whole authorization request under 'each'.
 */
export class GrantStore {
  readonly #lifetime: number
  readonly #expiryByScope = new Map<string, number>()
  readonly #decisionByScope = new Map<string, Promise<boolean>>()

  constructor(lifetime: number) {
    this.#lifetime = lifetime
  }

  /** True while an unexpired approval exists for `scope`; drops expired ones on the way. */
  covers(scope: string): boolean {
    const now = Date.now()
    for (const [oldScope, oldExpiry] of this.#expiryByScope) {
      if (oldExpiry > now) break
      this.#expiryByScope.delete(oldScope)
    }
    const expiry = this.#expiryByScope.get(scope)
    if (expiry !== undefined && expiry > now) return true
    this.#expiryByScope.delete(scope)
    return false
  }

  /**
   * Joins the pending decision for `scope`, or starts one with `ask`. `scope` is
   * the decision key: the grant scope under 'grant', the whole request under 'each'.
   */
  async decide(scope: string, ask: () => boolean | Promise<boolean>): Promise<boolean> {
    let decision = this.#decisionByScope.get(scope)
    if (decision === undefined) {
      if (this.#decisionByScope.size >= MAX_PENDING_GRANTS) {
        throw new Error('Sigma: authorization queue is full')
      }
      decision = Promise.resolve(ask())
      this.#decisionByScope.set(scope, decision)
    }
    try {
      return await decision
    } finally {
      if (this.#decisionByScope.get(scope) === decision) this.#decisionByScope.delete(scope)
    }
  }

  /** Remembers an approval for `scope`, evicting the oldest one when full. */
  remember(scope: string): void {
    this.#expiryByScope.delete(scope)
    if (this.#expiryByScope.size >= MAX_CACHED_GRANTS) {
      const oldest = this.#expiryByScope.keys().next()
      if (oldest.done !== true) this.#expiryByScope.delete(oldest.value)
    }
    this.#expiryByScope.set(scope, Date.now() + this.#lifetime)
  }

  /** Forgets every grant and pending decision. */
  clear(): void {
    this.#expiryByScope.clear()
    this.#decisionByScope.clear()
  }
}
