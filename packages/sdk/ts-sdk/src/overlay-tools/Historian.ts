import Transaction from '../transaction/Transaction.js'

/**
 * Interpreter function signature used by Historian.
 *
 * Generics:
 * - T: The decoded/typed value produced for a matching output. Returning `undefined`
 *      means “this output does not contribute to history.”
 * - C: The per-call context passed through Historian to the interpreter. This carries
 *      any metadata needed to interpret outputs (e.g., `{ key: string }` for KVStore).
 *
 * Params:
 * - tx: The transaction containing the output to interpret.
 * - outputIndex: Index of the output within `tx.outputs`.
 * - ctx: Optional context object of type C, supplied at [Historian.buildHistory(startTx, context)]
 *
 * Returns:
 * - `T | undefined` (or a Promise thereof). `undefined` indicates a non-applicable or
 *   un-decodable output for the given context.
 */
export type InterpreterFunction<T, C = unknown> =
  (tx: Transaction, outputIndex: number, ctx?: C) => Promise<T | undefined> | T | undefined

/**
 * Historian builds a chronological history (oldest → newest) of typed values by traversing
 * a transaction's input ancestry and interpreting each output with a provided interpreter.
 *
 * Core ideas:
 * - You provide an interpreter `(tx, outputIndex) => T | undefined` that decodes one output
 *   into your domain value (e.g., kvstore entries). If it returns `undefined`, that output
 *   contributes nothing to history.
 * - Traversal follows `Transaction.inputs[].sourceTransaction` recursively, so callers must
 *   supply transactions whose inputs have `sourceTransaction` populated (e.g., via overlay
 *   history reconstruction).
 * - The traversal visits each transaction once (cycle-safe) and collects interpreted values
 *   in reverse-chronological order, then returns them as chronological (oldest-first).
 * - Optional caching support: provide a `historyCache` Map to cache complete history results
 *   and avoid re-traversing identical transaction chains with the same context.
 *
 * Usage:
 * - Construct with an interpreter (and optional cache)
 * - Call historian.buildHistory(tx, context) to get an array of values representing the history of a token over time.
 *
 * Example:
 *   const cache = new Map() // Optional: for caching repeated queries
 *   const historian = new Historian(interpreter, { historyCache: cache })
 *   const history = await historian.buildHistory(tipTransaction, context)
 *   // history: T[] (e.g., prior values for a protected kvstore key)
 *
 * Caching:
 * - Cache keys are generated from `interpreterVersion|txid|contextKey`
 * - Cached results are immutable snapshots to prevent external mutation
 * - Bump `interpreterVersion` when interpreter semantics change to invalidate old cache entries
 */
export class Historian<T, C = unknown> {
  private readonly interpreter: InterpreterFunction<T, C>
  private readonly debug: boolean

  // --- minimal cache support ---
  private readonly historyCache?: Map<string, readonly T[]>
  private readonly interpreterVersion: string
  private readonly ctxKeyFn: (ctx?: C) => string

  /**
   * Create a new Historian instance
   *
   * @param interpreter - Function to interpret transaction outputs into typed values
   * @param options - Configuration options
   * @param options.debug - Enable debug logging (default: false)
   * @param options.historyCache - Optional external cache for complete history results
   * @param options.interpreterVersion - Version identifier for cache invalidation (default: 'v1')
   * @param options.ctxKeyFn - Custom function to serialize context for cache keys (default: JSON.stringify)
   */
  constructor (
    interpreter: InterpreterFunction<T, C>,
    options?: {
      debug?: boolean
      /** Optional cache for entire history results keyed by (version|txid|ctxKey) */
      historyCache?: Map<string, readonly T[]>
      /** Bump this if interpreter semantics change to invalidate cache */
      interpreterVersion?: string
      /** Deterministic, non-secret key for context. Default is JSON.stringify(ctx) */
      ctxKeyFn?: (ctx?: C) => string
    }
  ) {
    this.interpreter = interpreter
    this.debug = options?.debug ?? false

    // Configure caching (all optional)
    this.historyCache = options?.historyCache
    this.interpreterVersion = options?.interpreterVersion ?? 'v1'
    this.ctxKeyFn = options?.ctxKeyFn ?? ((ctx?: C) => {
      try { return JSON.stringify(ctx ?? null) } catch { return '' }
    })
  }

  private historyKey (startTransaction: Transaction, context?: C): string {
    const txid = startTransaction.id('hex')
    const ctxKey = this.ctxKeyFn(context)
    return `${this.interpreterVersion}|${txid}|${ctxKey}`
  }

  /**
   * Build history by traversing input chain from a starting transaction
   * Returns values in chronological order (oldest first)
   *
   * If caching is enabled, will first check for cached results matching the
   * startTransaction and context. On cache miss, performs full traversal and
   * stores the result for future queries.
   *
   * @param startTransaction - The transaction to start traversal from
   * @param context - The context to pass to the interpreter
   * @returns Array of interpreted values in chronological order
   */
  async buildHistory (startTransaction: Transaction, context?: C): Promise<T[]> {
    // --- minimal cache fast path ---
    if (this.historyCache != null) {
      const cacheKey = this.historyKey(startTransaction, context)
      if (this.historyCache.has(cacheKey)) {
        const cached = this.historyCache.get(cacheKey)
        if (cached != null) {
          if (this.debug) console.log('[Historian] History cache hit:', cacheKey)
          // Return a shallow copy to avoid external mutation of the cached array
          return cached.slice()
        }
      }
    }

    const history: T[] = []
    const visited = new Set<string>()

    // Recursively traverse input transactions to build history
    const traverseHistory = async (transaction: Transaction): Promise<void> => {
      const txid = transaction.id('hex')

      // Prevent infinite loops
      if (visited.has(txid)) {
        if (this.debug) {
          console.log(`[Historian] Skipping already visited transaction: ${txid}`)
        }
        return
      }
      visited.add(txid)

      if (this.debug) {
        console.log(`[Historian] Processing transaction: ${txid}`)
      }

      // Check all outputs in this transaction for interpretable values
      for (let outputIndex = 0; outputIndex < transaction.outputs.length; outputIndex++) {
        try {
          // Try to interpret this output
          const interpretedValue = await Promise.resolve(this.interpreter(transaction, outputIndex, context))

          if (interpretedValue !== undefined) {
            history.push(interpretedValue)
            if (this.debug) {
              console.log('[Historian] Added value to history:', interpretedValue)
            }
          }
        } catch (error) {
          if (this.debug) {
            console.log(`[Historian] Failed to interpret output ${outputIndex}:`, error)
          }
          // Skip outputs that can't be interpreted
        }
      }

      // Recursively traverse input transactions
      for (const input of transaction.inputs) {
        if (input.sourceTransaction != null) {
          await traverseHistory(input.sourceTransaction)
        } else if (this.debug) {
          console.log('[Historian] Input missing sourceTransaction, skipping')
        }
      }
    }

    // Start traversal from the provided transaction
    await traverseHistory(startTransaction)

    // History is built in reverse chronological order during traversal,
    // so we reverse it to return oldest-first
    const chronological = history.reverse()

    if (this.historyCache != null) {
      const cacheKey = this.historyKey(startTransaction, context)
      // Store an immutable snapshot to avoid accidental external mutation
      this.historyCache.set(cacheKey, Object.freeze(chronological.slice()))
      if (this.debug) console.log('[Historian] History cached:', cacheKey)
    }

    return chronological
  }
}
