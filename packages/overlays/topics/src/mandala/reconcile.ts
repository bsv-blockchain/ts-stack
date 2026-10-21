// The owner-index reconciler (spec §4.2a rule 5). At boot and on an interval
// the overlay runs it over every unspent output the engine has admitted on a
// topic. An output whose index row is missing, or disagrees with its script, is
// repaired from the owner journal exactly as an inline repair would be (rule
// 3); one the journal cannot repair is reported, for the readiness check.
//
// The engine can spend an output while the reconciler visits it: it marks the
// output spent, then tells the lookup, which takes the row. A row the
// reconciler inserts after that would be permanent (the coin is never listed
// again and no further spend notification comes), so every inserted row is
// checked against the engine once more and taken back if the coin is gone.
import { LockingScript } from '@bsv/sdk'
import { Bsv21Binary, tokenIdToString } from '@bsv/templates'
import type { Bsv21Role } from '@bsv/templates'
import type { MandalaStorageManager } from './MandalaStorageManager.js'
import { eachInOrder } from './inOrder.js'
import { takeBackRepair } from './ownership.js'
import type { EngineOutputReader, MandalaOwnerRecord } from './types.js'

export interface ReconcileResult {
  /** Admitted outputs the engine listed. */
  scanned: number
  /**
   * Rows inserted or corrected from the journal. An insert taken back because the engine spent the
   * coin meanwhile is not counted.
   */
  repaired: number
  /** `<txid>.<vout>` of every output whose row is wrong and that the journal cannot repair. */
  unrepairable: string[]
}

/** The reads, the repair and its undo that the reconciler needs from the lookup's store. */
export type ReconcileStore = Pick<
  MandalaStorageManager,
  | 'getTokenRow'
  | 'getAuthorityRow'
  | 'getOwnerJournal'
  | 'repairOwnerRow'
  | 'takeToken'
  | 'takeAuthority'
  | 'adjustBalance'
>

export interface ReconcileDeps {
  storage: ReconcileStore
  engine: EngineOutputReader
  topic: string
  /** Outputs per engine page; 200 by default. */
  batchSize?: number
  /**
   * The §4.2a rule 3 repair log, told the outpoint of every repair (`inserted` false: an existing
   * row was corrected). Defaults to `console.warn`.
   */
  onRepair?: (outpoint: string, inserted: boolean) => void
}

interface Outpoint {
  txid: string
  outputIndex: number
}

/** What the engine's own copy of the output says. */
interface ScriptToken {
  tokenId: string
  role: Bsv21Role
  amount: bigint
}

const DEFAULT_BATCH = 200
const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/

const labelOf = ({ txid, outputIndex }: Outpoint): string => `${txid}.${outputIndex}`

const sameAmount = (stored: number, amount: bigint): boolean =>
  Number.isSafeInteger(stored) && BigInt(stored) === amount

const logRepair = (outpoint: string, inserted: boolean): void => {
  const what = inserted ? 'row inserted' : 'row corrected'
  console.warn(
    `[reconcileOwnerIndex] owner index repaired for ${outpoint} from the owner journal (${what})`
  )
}

// undefined: not a token output, or a deploy anywhere but vout 0 (no token id).
function scriptToken(script: number[], { txid, outputIndex }: Outpoint): ScriptToken | undefined {
  try {
    const { role, tokenId, amount } = Bsv21Binary.decode(LockingScript.fromBinary(script))
    if (tokenId !== undefined) return { tokenId: tokenIdToString(tokenId), role, amount }
    return outputIndex === 0 ? { tokenId: `${txid}_0`, role, amount } : undefined
  } catch {
    return undefined
  }
}

async function rowAgrees(
  storage: ReconcileStore,
  op: Outpoint,
  token: ScriptToken
): Promise<boolean> {
  if (token.role !== 'value') {
    const row = await storage.getAuthorityRow(op.txid, op.outputIndex)
    return row !== null && row.tokenId === token.tokenId && COMPRESSED_KEY.test(row.identityKey)
  }
  const row = await storage.getTokenRow(op.txid, op.outputIndex)
  return (
    row !== null &&
    row.tokenId === token.tokenId &&
    sameAmount(row.amount, token.amount) &&
    COMPRESSED_KEY.test(row.identityKey)
  )
}

const journalAgrees = (journal: MandalaOwnerRecord, token: ScriptToken): boolean =>
  journal.tokenId === token.tokenId &&
  journal.role === token.role &&
  sameAmount(journal.amount, token.amount) &&
  COMPRESSED_KEY.test(journal.identityKey)

/**
 * `ok`: the row agrees, or the engine no longer holds the output (also when it spent the output
 * after the repair inserted the row, which is then taken back).
 */
type Outcome = 'ok' | 'repaired' | 'unrepairable'

async function reconcileOne(op: Outpoint, deps: ReconcileDeps): Promise<Outcome> {
  const { storage, engine, topic } = deps
  const admitted = await engine.findAdmittedOutput(op.txid, op.outputIndex, topic)
  // spent or evicted since it was listed: no longer the index's concern
  if (admitted === null) return 'ok'
  const token = scriptToken(admitted.lockingScript, op)
  if (token === undefined) return 'unrepairable'
  if (await rowAgrees(storage, op, token)) return 'ok'
  const journal = await storage.getOwnerJournal(op.txid, op.outputIndex, topic)
  if (journal === null || !journalAgrees(journal, token)) return 'unrepairable'
  const { inserted } = await storage.repairOwnerRow(journal)
  // A spend the engine made after the first read may already have taken the row this insert put
  // back. A correction needs no check: the row it corrected is still there for that spend to take.
  if (inserted && (await engine.findAdmittedOutput(op.txid, op.outputIndex, topic)) === null) {
    await takeBackRepair(storage, op.txid, op.outputIndex, token.role)
    return 'ok'
  }
  const onRepair = deps.onRepair ?? logRepair
  onRepair(labelOf(op), inserted)
  return 'repaired'
}

function batchSizeOf(deps: ReconcileDeps): number {
  const size = deps.batchSize ?? DEFAULT_BATCH
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error('reconcileOwnerIndex: batchSize must be a positive integer')
  }
  return size
}

async function reconcilePage(
  page: readonly Outpoint[],
  deps: ReconcileDeps,
  result: ReconcileResult
): Promise<void> {
  await eachInOrder(page, async op => {
    result.scanned++
    const outcome = await reconcileOne(op, deps)
    if (outcome === 'repaired') result.repaired++
    else if (outcome === 'unrepairable') result.unrepairable.push(labelOf(op))
  })
}

// A page that ends where the last one did would be read forever.
function requireProgress(page: readonly Outpoint[], cursor: Outpoint | null): void {
  const last = page.at(-1)
  if (cursor !== null && last !== undefined && labelOf(last) === labelOf(cursor)) {
    throw new Error(`reconcileOwnerIndex: the engine listing did not advance past ${labelOf(last)}`)
  }
}

// Reads and reconciles the page after `cursor`, then the rest, until a page comes back short.
async function reconcileFrom(
  cursor: Outpoint | null,
  limit: number,
  deps: ReconcileDeps,
  result: ReconcileResult
): Promise<void> {
  const page = await deps.engine.listUnspentAdmittedOutputs(deps.topic, cursor, limit)
  requireProgress(page, cursor)
  await reconcilePage(page, deps, result)
  const next = page.at(-1) ?? null
  if (page.length >= limit) await reconcileFrom(next, limit, deps, result)
}

/**
 * Pages the engine's unspent admitted outputs of `topic` in keyset order and reconciles each one.
 * Every engine or store fault is rethrown, so the caller retries the whole run; repairs are
 * idempotent upserts, so a rerun is harmless.
 */
export async function reconcileOwnerIndex(deps: ReconcileDeps): Promise<ReconcileResult> {
  const limit = batchSizeOf(deps)
  const result: ReconcileResult = { scanned: 0, repaired: 0, unrepairable: [] }
  await reconcileFrom(null, limit, deps, result)
  return result
}
