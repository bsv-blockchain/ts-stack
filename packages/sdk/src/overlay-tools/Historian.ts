import Transaction from '../transaction/Transaction.js'
import { utf8ByteLength } from '../primitives/UTF8.js'

const TXID = /^[0-9a-f]{64}$/i
const DEFAULT_MAX_HISTORY_TRANSACTIONS = 10_000
const DEFAULT_MAX_INTERPRETED_OUTPUTS = 100_000
const MAX_CONTEXT_DEPTH = 64
const MAX_CONTEXT_ITEMS = 100_000
const MAX_CONTEXT_KEY_BYTES = 64 * 1024
const MAX_INTERPRETER_VERSION_BYTES = 256

/**
 * Interpreter function signature used by Historian.
 *
 * Returning `undefined` means that an output does not contribute to the
 * requested history. Interpreters used for authorization-sensitive histories
 * must authenticate every returned value and bind every namespace component
 * (for example, key, protocol, and controller) through `context`.
 */
export type InterpreterFunction<T, C = unknown> = (
  tx: Transaction,
  outputIndex: number,
  ctx?: C
) => Promise<T | undefined> | T | undefined

interface TraversalBudget {
  transactions: number
  outputs: number
}

interface FullFrame {
  transaction: Transaction
  phase: 'enter' | 'exit'
}

interface LineageFrame<T> {
  transaction: Transaction
  outputIndex: number
  key: string
  entered: boolean
  nextInput: number
  value?: T
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor == null || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new TypeError('Historian cache context must contain only plain data properties.')
  }
  return descriptor.value
}

/** UTF-16 code-unit order, the same order as a comparator-less `Array#sort`. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Produces a deterministic, type-preserving key for JSON-like context. Unlike
 * JSON.stringify, this does not collapse missing/undefined values or silently
 * reuse one cache entry after a circular/unsupported context fails to encode.
 */
function stableContextKey(value: unknown): string {
  let items = 0
  const ancestors = new Set<object>()

  const encode = (current: unknown, depth: number): string => {
    if (++items > MAX_CONTEXT_ITEMS || depth > MAX_CONTEXT_DEPTH) {
      throw new RangeError('Historian cache context exceeds the permitted complexity.')
    }
    if (current === undefined) return 'u'
    if (current === null) return 'n'
    if (typeof current === 'boolean') return current ? 'b1' : 'b0'
    if (typeof current === 'string') return `s${current.length}:${current}`
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new TypeError('Historian cache context numbers must be finite.')
      }
      return Object.is(current, -0) ? 'd-0' : `d${String(current)}`
    }
    if (typeof current !== 'object') {
      throw new TypeError('Historian cache context must be JSON-like plain data.')
    }
    if (ancestors.has(current)) {
      throw new TypeError('Historian cache context must not contain cycles.')
    }
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const values: string[] = []
        for (let index = 0; index < current.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            throw new TypeError('Historian cache context arrays must be dense.')
          }
          values.push(
            encode(
              ownDataValue(current as unknown as Record<string, unknown>, String(index)),
              depth + 1
            )
          )
        }
        const extraKeys = Reflect.ownKeys(current).filter(key => {
          if (key === 'length') return false
          if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return true
          const index = Number(key)
          return !Number.isSafeInteger(index) || index < 0 || index >= current.length
        })
        if (extraKeys.length !== 0) {
          throw new TypeError('Historian cache context arrays must not have extra properties.')
        }
        return `a${current.length}[${values.join(',')}]`
      }

      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Historian cache context must contain only plain objects.')
      }
      const keys = Reflect.ownKeys(current)
      if (keys.some(key => typeof key !== 'string')) {
        throw new TypeError('Historian cache context must not contain symbol properties.')
      }
      const stringKeys = (keys as string[]).sort(compareCodeUnits)
      const fields = stringKeys.map(key => {
        const encodedKey = `s${key.length}:${key}`
        return `${encodedKey}=${encode(
          ownDataValue(current as Record<string, unknown>, key),
          depth + 1
        )}`
      })
      return `o${fields.length}{${fields.join(',')}}`
    } finally {
      ancestors.delete(current)
    }
  }

  const encoded = encode(value, 0)
  if (utf8ByteLength(encoded) > MAX_CONTEXT_KEY_BYTES) {
    throw new RangeError('Historian cache context key exceeds the permitted size.')
  }
  return encoded
}

function cloneHistory<T>(history: readonly T[]): T[] {
  try {
    return structuredClone(history) as T[]
  } catch {
    throw new TypeError('Historian cached values must be structured-cloneable.')
  }
}

/**
 * Builds authenticated, chronological values from transaction ancestry.
 *
 * `buildHistory(tx, context)` preserves the original broad behavior and visits
 * every output in the complete input ancestry. This is useful for descriptive
 * ancestry analysis, but it must not be used to assert that every value belongs
 * to one token lineage.
 *
 * `buildHistory(tx, context, outputIndex)` selects an exact tip output and then
 * follows only spent source outputs for which the interpreter returns a value.
 * Use this lineage mode for state/history assertions so unrelated funding inputs
 * and sibling outputs cannot contaminate the result.
 */
export class Historian<T, C = unknown> {
  readonly #interpreter: InterpreterFunction<T, C>
  readonly #debug: boolean
  readonly #historyCache?: Map<string, readonly T[]>
  readonly #interpreterVersion: string
  readonly #ctxKeyFn: (ctx?: C) => string
  readonly #maxTransactions: number
  readonly #maxInterpretedOutputs: number

  constructor(
    interpreter: InterpreterFunction<T, C>,
    options?: {
      debug?: boolean
      /** Optional cache for entire history results keyed by version, tip, mode, and context. */
      historyCache?: Map<string, readonly T[]>
      /** Bump this if interpreter semantics change to invalidate cached results. */
      interpreterVersion?: string
      /** Deterministic, non-secret context key. The default accepts JSON-like plain data. */
      ctxKeyFn?: (ctx?: C) => string
      /** Maximum distinct ancestry transactions visited by one call. */
      maxTransactions?: number
      /** Maximum output interpretations performed by one call. */
      maxInterpretedOutputs?: number
    }
  ) {
    if (typeof interpreter !== 'function') throw new TypeError('Historian interpreter is required.')
    this.#interpreter = interpreter
    this.#debug = options?.debug ?? false
    this.#historyCache = options?.historyCache
    this.#interpreterVersion = options?.interpreterVersion ?? 'v1'
    this.#ctxKeyFn = options?.ctxKeyFn ?? ((ctx?: C) => stableContextKey(ctx))
    this.#maxTransactions = this.#positiveLimit(
      options?.maxTransactions ?? DEFAULT_MAX_HISTORY_TRANSACTIONS,
      'maxTransactions'
    )
    this.#maxInterpretedOutputs = this.#positiveLimit(
      options?.maxInterpretedOutputs ?? DEFAULT_MAX_INTERPRETED_OUTPUTS,
      'maxInterpretedOutputs'
    )
    if (
      typeof this.#interpreterVersion !== 'string' ||
      utf8ByteLength(this.#interpreterVersion) > MAX_INTERPRETER_VERSION_BYTES
    ) {
      throw new TypeError('Historian interpreterVersion must be a bounded string.')
    }
  }

  #positiveLimit(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Historian ${label} must be a positive safe integer.`)
    }
    return value
  }

  #transactionID(transaction: Transaction): string {
    const txid = transaction.id('hex')
    if (typeof txid !== 'string' || !TXID.test(txid)) {
      throw new TypeError('Historian encountered an invalid transaction ID.')
    }
    return txid.toLowerCase()
  }

  #historyKey(
    startTransaction: Transaction,
    context: C | undefined,
    startOutputIndex: number | undefined
  ): string {
    const txid = this.#transactionID(startTransaction)
    const ctxKey = this.#ctxKeyFn(context)
    if (typeof ctxKey !== 'string' || utf8ByteLength(ctxKey) > MAX_CONTEXT_KEY_BYTES) {
      throw new TypeError('Historian ctxKeyFn must return a bounded string.')
    }
    const mode = startOutputIndex === undefined ? 'all' : `lineage:${startOutputIndex}`
    return `${this.#interpreterVersion.length}:${this.#interpreterVersion}${txid}${mode.length}:${mode}${ctxKey.length}:${ctxKey}`
  }

  #cachedHistory(
    startTransaction: Transaction,
    context: C | undefined,
    startOutputIndex: number | undefined
  ): T[] | undefined {
    if (this.#historyCache == null) return undefined
    const cacheKey = this.#historyKey(startTransaction, context, startOutputIndex)
    const cached = this.#historyCache.get(cacheKey)
    if (cached == null) return undefined
    if (this.#debug) console.log('[Historian] History cache hit:', cacheKey)
    return cloneHistory(cached)
  }

  async #interpretOutput(
    transaction: Transaction,
    outputIndex: number,
    context: C | undefined,
    budget: TraversalBudget
  ): Promise<T | undefined> {
    if (++budget.outputs > this.#maxInterpretedOutputs) {
      throw new RangeError('Historian output interpretation limit exceeded.')
    }
    try {
      const interpretedValue = await Promise.resolve(
        this.#interpreter(transaction, outputIndex, context)
      )
      if (interpretedValue !== undefined && this.#debug) {
        console.log('[Historian] Added value to history:', interpretedValue)
      }
      return interpretedValue
    } catch (error) {
      if (this.#debug) {
        console.log(`[Historian] Failed to interpret output ${outputIndex}:`, error)
      }
      return undefined
    }
  }

  #countTransaction(budget: TraversalBudget): void {
    if (++budget.transactions > this.#maxTransactions) {
      throw new RangeError('Historian transaction traversal limit exceeded.')
    }
  }

  #validSource(
    input: Transaction['inputs'][number]
  ): { transaction: Transaction; outputIndex: number } | undefined {
    if (input.sourceTransaction == null) {
      if (this.#debug) console.log('[Historian] Input missing sourceTransaction, skipping')
      return undefined
    }
    if (!Number.isSafeInteger(input.sourceOutputIndex) || input.sourceOutputIndex < 0) {
      if (this.#debug) console.log('[Historian] Input has invalid sourceOutputIndex, skipping')
      return undefined
    }
    const sourceTxid = this.#transactionID(input.sourceTransaction)
    if (
      input.sourceTXID !== undefined &&
      (typeof input.sourceTXID !== 'string' || input.sourceTXID.toLowerCase() !== sourceTxid)
    ) {
      if (this.#debug) console.log('[Historian] Input source transaction ID mismatch, skipping')
      return undefined
    }
    if (input.sourceOutputIndex >= input.sourceTransaction.outputs.length) {
      if (this.#debug) console.log('[Historian] Input source output is missing, skipping')
      return undefined
    }
    return { transaction: input.sourceTransaction, outputIndex: input.sourceOutputIndex }
  }

  async #buildFullAncestry(
    startTransaction: Transaction,
    context: C | undefined,
    budget: TraversalBudget
  ): Promise<T[]> {
    const history: T[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const stack: FullFrame[] = [{ transaction: startTransaction, phase: 'enter' }]

    while (stack.length > 0) {
      const frame = stack.pop() as FullFrame
      const txid = this.#transactionID(frame.transaction)
      if (frame.phase === 'enter') {
        if (visited.has(txid) || visiting.has(txid)) {
          if (this.#debug) console.log(`[Historian] Skipping already visited transaction: ${txid}`)
          continue
        }
        this.#countTransaction(budget)
        visiting.add(txid)
        if (this.#debug) console.log(`[Historian] Processing transaction: ${txid}`)
        stack.push({ transaction: frame.transaction, phase: 'exit' })
        for (let index = frame.transaction.inputs.length - 1; index >= 0; index--) {
          const source = this.#validSource(frame.transaction.inputs[index])
          if (source !== undefined) stack.push({ transaction: source.transaction, phase: 'enter' })
        }
        continue
      }

      visiting.delete(txid)
      if (visited.has(txid)) continue
      visited.add(txid)
      for (let outputIndex = 0; outputIndex < frame.transaction.outputs.length; outputIndex++) {
        const value = await this.#interpretOutput(frame.transaction, outputIndex, context, budget)
        if (value !== undefined) history.push(value)
      }
    }
    return history
  }

  async #buildOutputLineage(
    startTransaction: Transaction,
    startOutputIndex: number,
    context: C | undefined,
    budget: TraversalBudget
  ): Promise<T[]> {
    if (
      !Number.isSafeInteger(startOutputIndex) ||
      startOutputIndex < 0 ||
      startOutputIndex >= startTransaction.outputs.length
    ) {
      throw new RangeError('Historian startOutputIndex does not identify an existing output.')
    }

    const history: T[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const startTxid = this.#transactionID(startTransaction)
    const stack: Array<LineageFrame<T>> = [
      {
        transaction: startTransaction,
        outputIndex: startOutputIndex,
        key: `${startTxid}:${startOutputIndex}`,
        entered: false,
        nextInput: 0
      }
    ]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (!frame.entered) {
        if (visited.has(frame.key) || visiting.has(frame.key)) {
          if (this.#debug) console.log(`[Historian] Skipping already visited output: ${frame.key}`)
          stack.pop()
          continue
        }
        this.#countTransaction(budget)
        const value = await this.#interpretOutput(
          frame.transaction,
          frame.outputIndex,
          context,
          budget
        )
        if (value === undefined) {
          visited.add(frame.key)
          stack.pop()
          continue
        }
        frame.value = value
        frame.entered = true
        visiting.add(frame.key)
        if (this.#debug) console.log(`[Historian] Processing lineage output: ${frame.key}`)
      }

      let pushedParent = false
      while (frame.nextInput < frame.transaction.inputs.length) {
        const input = frame.transaction.inputs[frame.nextInput++]
        const source = this.#validSource(input)
        if (source === undefined) continue
        const sourceKey = `${this.#transactionID(source.transaction)}:${source.outputIndex}`
        if (visited.has(sourceKey) || visiting.has(sourceKey)) {
          if (this.#debug) console.log(`[Historian] Skipping already visited output: ${sourceKey}`)
          continue
        }
        stack.push({
          transaction: source.transaction,
          outputIndex: source.outputIndex,
          key: sourceKey,
          entered: false,
          nextInput: 0
        })
        pushedParent = true
        break
      }
      if (pushedParent) continue

      visiting.delete(frame.key)
      visited.add(frame.key)
      history.push(frame.value as T)
      stack.pop()
    }
    return history
  }

  /**
   * Returns values oldest-first. Supplying `startOutputIndex` activates exact
   * spent-output lineage mode; omitting it visits the complete input ancestry.
   */
  async buildHistory(
    startTransaction: Transaction,
    context?: C,
    startOutputIndex?: number
  ): Promise<T[]> {
    const cached = this.#cachedHistory(startTransaction, context, startOutputIndex)
    if (cached !== undefined) return cached

    const budget: TraversalBudget = { transactions: 0, outputs: 0 }
    const chronological =
      startOutputIndex === undefined
        ? await this.#buildFullAncestry(startTransaction, context, budget)
        : await this.#buildOutputLineage(startTransaction, startOutputIndex, context, budget)

    if (this.#historyCache != null) {
      const cacheKey = this.#historyKey(startTransaction, context, startOutputIndex)
      this.#historyCache.set(cacheKey, Object.freeze(cloneHistory(chronological)))
      if (this.#debug) console.log('[Historian] History cached:', cacheKey)
    }
    return chronological
  }
}
