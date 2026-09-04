import Transaction from '../transaction/Transaction.js'
import type ChainTracker from '../transaction/ChainTracker.js'
import { PushDrop } from '../script/index.js'
import { ProtoWallet } from '../wallet/ProtoWallet.js'
import { Beef } from '../transaction/Beef.js'
import * as Utils from '../primitives/utils.js'
import {
  LookupValidationError,
  LookupValidationUnavailableError,
  withinDeadline
} from '../overlay-tools/ReliableLookup.js'
import type { ReliableLookupResult } from '../overlay-tools/ReliableLookup.js'
import type { LookupAnswer } from '../overlay-tools/LookupResolver.js'
import type { KVStoreEntry, KVStoreQuery } from './types.js'

export interface KVStoreReliabilityConfig {
  /** Trusted, network-correct header validation. Never use a permissive tracker in production. */
  chainTracker: ChainTracker
  /** Explicit trust policy for completeness. Discovery is not an authority election. */
  authoritativeHosts?: string[]
  deadlineMs?: number
  hostTimeoutMs?: number
}
export interface ValidatedKVOutput {
  entry: KVStoreEntry
  transaction: Transaction
  outpoint: string
}
export interface KVStoreReadEvidence {
  completedHosts: number
  failedHosts: number
  discoveryComplete: boolean
  durationMs: number
}
export type KVStoreReadResult =
  | {
      kind: 'data'
      entries: KVStoreEntry[]
      completeness: 'complete' | 'partial'
      freshness: 'observed'
      evidence: KVStoreReadEvidence
    }
  | { kind: 'absent'; authority: 'configured-hosts'; evidence: KVStoreReadEvidence }
  | {
      kind: 'unavailable' | 'incomplete' | 'malformed' | 'rejected'
      retryable: true
      evidence: KVStoreReadEvidence
    }
  | { kind: 'conflict'; retryable: true; evidence: KVStoreReadEvidence }
  | { kind: 'stale'; entries: KVStoreEntry[]; retryable: true; evidence: KVStoreReadEvidence }

export class KVStoreUnavailableError extends Error {
  readonly retryable = true
  constructor(readonly outcome: KVStoreReadResult['kind']) {
    super('Data is temporarily unavailable. Please retry.')
    this.name = 'KVStoreUnavailableError'
  }
}
export class KVStoreWriteError extends Error {
  readonly retryable = true
  constructor(
    readonly outcome: 'rejected' | 'unconfirmed',
    readonly txid: string
  ) {
    super(
      outcome === 'rejected'
        ? 'The write was not accepted.'
        : 'Write confirmation is pending. Reconcile before creating another transaction.'
    )
    this.name = 'KVStoreWriteError'
  }
}

function matches(entry: KVStoreEntry, query: KVStoreQuery): boolean {
  if (query.key !== undefined && query.key !== entry.key) return false
  if (query.controller !== undefined && query.controller !== entry.controller) return false
  if (
    query.protocolID !== undefined &&
    JSON.stringify(query.protocolID) !== JSON.stringify(entry.protocolID)
  )
    return false
  if (query.tags !== undefined) {
    const test = (tag: string): boolean => entry.tags?.includes(tag) === true
    if (!(query.tagQueryMode === 'any' ? query.tags.some(test) : query.tags.every(test)))
      return false
  }
  return true
}

/** Validation happens before health credit, aggregation or deduplication. */
export async function validateKVAnswer(
  answer: LookupAnswer,
  query: KVStoreQuery,
  tracker: ChainTracker,
  signal: AbortSignal
): Promise<ValidatedKVOutput[]> {
  if (answer.outputs.length > 256) throw new LookupValidationError('malformed')
  const checkedTracker: ChainTracker = {
    currentHeight: async () => {
      try {
        return await tracker.currentHeight()
      } catch {
        throw new LookupValidationUnavailableError()
      }
    },
    isValidRootForHeight: async (root, height) => {
      try {
        return await tracker.isValidRootForHeight(root, height)
      } catch {
        throw new LookupValidationUnavailableError()
      }
    }
  }
  const values: ValidatedKVOutput[] = []
  let totalBytes = 0
  for (const result of answer.outputs) {
    if (signal.aborted) throw new Error('Lookup aborted')
    if (
      !Array.isArray(result.beef) ||
      result.beef.length === 0 ||
      !result.beef.every(x => Number.isInteger(x) && x >= 0 && x <= 255)
    )
      throw new LookupValidationError('malformed')
    totalBytes += result.beef.length
    if (
      totalBytes > 4 * 1024 * 1024 ||
      !Number.isInteger(result.outputIndex) ||
      result.outputIndex < 0
    )
      throw new LookupValidationError('malformed')
    try {
      const tx = Transaction.fromBEEF(result.beef)
      const txid = tx.id('hex')
      if (result.txid !== undefined && result.txid.toLowerCase() !== txid)
        throw new Error('Mismatched transaction')
      const output = tx.outputs[result.outputIndex]
      if (output === undefined) throw new Error('Missing output')
      const decoded = PushDrop.decode(output.lockingScript)
      if (decoded.fields.length !== 5 && decoded.fields.length !== 6)
        throw new Error('Invalid fields')
      const signature = decoded.fields.pop() as number[]
      const entry: KVStoreEntry = {
        protocolID: JSON.parse(Utils.toUTF8(decoded.fields[0])),
        key: Utils.toUTF8(decoded.fields[1]),
        value: Utils.toUTF8(decoded.fields[2]),
        controller: Utils.toHex(decoded.fields[3])
      }
      if (
        !Array.isArray(entry.protocolID) ||
        entry.protocolID.length !== 2 ||
        ![0, 1, 2].includes(entry.protocolID[0]) ||
        typeof entry.protocolID[1] !== 'string' ||
        entry.key.length === 0
      )
        throw new Error('Invalid identity')
      if (decoded.fields.length === 5) {
        const tags: unknown = JSON.parse(Utils.toUTF8(decoded.fields[4]))
        if (!Array.isArray(tags) || !tags.every(x => typeof x === 'string'))
          throw new Error('Invalid tags')
        entry.tags = tags
      }
      if (!matches(entry, query)) throw new Error('Off-query output')
      const anyone = new ProtoWallet('anyone')
      const args = {
        protocolID: entry.protocolID,
        keyID: entry.key,
        counterparty: entry.controller
      }
      const { valid } = await anyone.verifySignature({
        ...args,
        data: decoded.fields.flat(),
        signature
      })
      if (!valid) throw new Error('Invalid signature')
      const { publicKey } = await anyone.getPublicKey(args)
      if (decoded.lockingPublicKey.toString() !== publicKey)
        throw new Error('Invalid controller lock')
      if (!(await tx.verify(checkedTracker))) throw new Error('Invalid transaction proof')
      entry.token = {
        txid,
        outputIndex: result.outputIndex,
        beef: Beef.fromBinary(result.beef),
        satoshis: output.satoshis ?? 0
      }
      values.push({ entry, transaction: tx, outpoint: `${txid}.${result.outputIndex}` })
    } catch (error) {
      if (error instanceof LookupValidationUnavailableError) throw error
      throw new LookupValidationError('invalid')
    }
  }
  return values
}

function spends(transaction: Transaction, outpoint: string): boolean {
  const pending = [transaction]
  const seen = new Set<string>()
  for (let i = 0; i < pending.length && i < 4096; i++) {
    const tx = pending[i]
    const id = tx.id('hex')
    if (seen.has(id)) continue
    seen.add(id)
    for (const input of tx.inputs) {
      const source = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      if (`${source}.${input.sourceOutputIndex}` === outpoint) return true
      if (input.sourceTransaction !== undefined && input.sourceTransaction.id('hex') === source)
        pending.push(input.sourceTransaction)
    }
  }
  return false
}

/** Select only maximal states whose relationship is proven by transaction inputs. */
export function reconcileKVResults(
  result: ReliableLookupResult<ValidatedKVOutput>,
  authorities: string[] = []
): KVStoreReadResult {
  const answers = result.hosts.filter(h => h.kind === 'answer')
  const evidence: KVStoreReadEvidence = {
    completedHosts: result.hosts.length,
    failedHosts: result.hosts.length - answers.length,
    discoveryComplete: result.discoveryComplete,
    durationMs: result.durationMs
  }
  const unique = new Map<string, ValidatedKVOutput>()
  for (const host of answers) for (const value of host.values) unique.set(value.outpoint, value)
  const groups = new Map<string, ValidatedKVOutput[]>()
  for (const value of unique.values()) {
    const identity = JSON.stringify([
      value.entry.protocolID,
      value.entry.controller,
      value.entry.key
    ])
    const group = groups.get(identity) ?? []
    group.push(value)
    groups.set(identity, group)
  }
  const current: ValidatedKVOutput[] = []
  for (const group of groups.values()) {
    const tips = group.filter(
      value => !group.some(other => other !== value && spends(other.transaction, value.outpoint))
    )
    if (tips.length !== 1) return { kind: 'conflict', retryable: true, evidence }
    current.push(tips[0])
  }
  const normalize = (host: string): string => host.replace(/\/$/, '')
  const authoritative =
    authorities.length > 0 &&
    authorities.every(host => answers.some(answer => normalize(answer.host) === normalize(host)))
  // Completeness requires a configured trust set, successful discovery/settlement,
  // and identical reconciled membership. Counts or latency never elect authority.
  const complete =
    authoritative &&
    result.discoveryComplete &&
    evidence.failedHosts === 0 &&
    answers.every(host => {
      const represented = new Set(host.values.map(value => value.outpoint))
      return (
        current.every(value => represented.has(value.outpoint)) &&
        host.values.every(value => unique.has(value.outpoint))
      )
    })
  if (current.length > 0)
    return {
      kind: 'data',
      entries: current.map(v => v.entry),
      completeness: complete ? 'complete' : 'partial',
      freshness: 'observed',
      evidence
    }
  if (complete && answers.every(host => host.values.length === 0))
    return { kind: 'absent', authority: 'configured-hosts', evidence }
  const kind =
    answers.length > 0
      ? 'incomplete'
      : result.hosts.some(h => h.kind === 'invalid' || h.kind === 'malformed')
        ? 'malformed'
        : result.hosts.some(h => h.kind === 'rejected')
          ? 'rejected'
          : 'unavailable'
  return { kind, retryable: true, evidence }
}

/** UI state contains only caller-owned memory; it must be discarded on account/query change. */
export class KVStoreReadState {
  private lastGood: KVStoreEntry[] | undefined
  apply(result: KVStoreReadResult): KVStoreReadResult {
    if (result.kind === 'data') {
      for (const next of result.entries) {
        const prior = this.lastGood?.find(
          entry =>
            entry.key === next.key &&
            entry.controller === next.controller &&
            JSON.stringify(entry.protocolID) === JSON.stringify(next.protocolID)
        )
        if (
          prior?.token === undefined ||
          next.token === undefined ||
          prior.token.txid === next.token.txid
        )
          continue
        try {
          const previousTx = Transaction.fromBEEF(prior.token.beef.toBinary(), prior.token.txid)
          const nextTx = Transaction.fromBEEF(next.token.beef.toBinary(), next.token.txid)
          if (spends(previousTx, `${next.token.txid}.${next.token.outputIndex}`)) {
            return {
              kind: 'stale',
              entries: this.lastGood as KVStoreEntry[],
              retryable: true,
              evidence: result.evidence
            }
          }
          if (!spends(nextTx, `${prior.token.txid}.${prior.token.outputIndex}`))
            return { kind: 'conflict', retryable: true, evidence: result.evidence }
        } catch {
          return { kind: 'conflict', retryable: true, evidence: result.evidence }
        }
      }
      if (result.completeness === 'partial' && this.lastGood !== undefined) {
        const identity = (entry: KVStoreEntry): string =>
          JSON.stringify([entry.protocolID, entry.controller, entry.key])
        const combined = new Map(this.lastGood.map(entry => [identity(entry), entry]))
        for (const entry of result.entries) combined.set(identity(entry), entry)
        this.lastGood = [...combined.values()]
        return { kind: 'stale', entries: this.lastGood, retryable: true, evidence: result.evidence }
      }
      this.lastGood = result.entries
    } else if (result.kind === 'absent') this.lastGood = undefined
    else if (result.kind !== 'conflict' && this.lastGood !== undefined)
      return { kind: 'stale', entries: this.lastGood, retryable: true, evidence: result.evidence }
    return result
  }
  clear(): void {
    this.lastGood = undefined
  }
}

/** Poll confirmation only; never construct another logical write on an ambiguous result. */
export async function confirmKVWrite(
  read: (signal: AbortSignal) => Promise<KVStoreReadResult>,
  outpoint: string | undefined,
  deadlineMs = 5000
): Promise<boolean> {
  try {
    return await withinDeadline(async signal => {
      while (!signal.aborted) {
        const result = await read(signal)
        if (signal.aborted) return false
        if (outpoint === undefined && result.kind === 'absent') return true
        if (
          result.kind === 'data' &&
          result.completeness === 'complete' &&
          result.entries.some(
            entry => `${entry.token?.txid}.${entry.token?.outputIndex}` === outpoint
          )
        )
          return true
        if (result.kind === 'conflict') return false
        await new Promise<void>(resolve => {
          const finish = (): void => {
            clearTimeout(timer)
            signal.removeEventListener('abort', finish)
            resolve()
          }
          const timer = setTimeout(finish, 200)
          signal.addEventListener('abort', finish, { once: true })
        })
      }
      return false
    }, deadlineMs)
  } catch {
    return false
  }
}
