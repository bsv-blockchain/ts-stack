import { runInSeries } from '../../utility/runInSeries'
import { Transaction } from '@bsv/sdk'
import type { StorageKnex } from '../StorageKnex'
import type { StorageWriterAdmission } from '../StorageActiveWrite'
import type { TableProvenTx } from '../schema/tables/TableProvenTx'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { sameSyncProof, validateSyncProof } from './validateSyncProof'
import { classifyOutputUtxo } from '../../services/classifyOutputUtxo'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'

const confirmedSourceStatuses = ['completed', 'unproven', 'sending', 'nosend']
const pageSize = 32
const workMsecs = 1500
const matchLimit = 24
// The proof review has a rolling window for shallow reorgs. Require the same
// 100-block separation as the historical proof audit before changing a durable flag.
const minimumDepth = 100

export interface ConfirmedSpendTarget {
  outputId: number
  userId: number
  txid: string
  vout: number
}

function inputOutpoints(proof: TableProvenTx): Map<string, number> {
  const inputs = new Map<string, number>()
  for (const [vin, input] of Transaction.fromBinary(proof.rawTx).inputs.entries()) {
    if (input.sourceTXID != null && input.sourceOutputIndex !== 0xffffffff)
      inputs.set(`${input.sourceTXID}.${input.sourceOutputIndex}`, vin)
  }
  return inputs
}

/** Applies only positive evidence from a stable canonical proof. No explorer
 * absence, stale output flag, or foreign wallet transaction ID is authority. */
export async function reconcileConfirmedSpender(
  storage: StorageKnex,
  proof: TableProvenTx,
  targets: ConfirmedSpendTarget[],
  tipHeight: number,
  admission?: StorageWriterAdmission
): Promise<number> {
  if (targets.length === 0 || proof.height + minimumDepth > tipHeight) return 0
  if (targets.length > matchLimit) throw new RangeError('Too many confirmed spend targets')
  const inputs = inputOutpoints(proof)
  for (const target of targets) {
    if (!inputs.has(`${target.txid}.${target.vout}`)) throw new Error('Proven spender does not consume the target')
  }
  await validateSyncProof(storage, proof)

  const apply = async (trx: TrxToken): Promise<number> => {
    const db = storage.toDb(trx)
    const currentProof = await db('proven_txs')
      .select('provenTxId')
      .where('provenTxId', proof.provenTxId)
      .forUpdate()
      .first()
    const observed = currentProof == null ? undefined : await storage.findProvenTxById(proof.provenTxId, trx)
    if (observed == null || !sameSyncProof(observed, proof)) return 0
    let changed = 0
    await runInSeries(
      targets.slice().sort((a, b) => a.outputId - b.outputId),
      async target => {
        const output = await db('outputs')
          .where({ outputId: target.outputId, userId: target.userId })
          .select('outputId', 'txid', 'vout', 'basketId', 'spendable', 'spentBy', 'updated_at', 'transactionId')
          .forUpdate()
          .first()
        if (!output?.spendable || output.basketId == null || output.txid !== target.txid || output.vout !== target.vout)
          return
        const source = await db('transactions')
          .where({ transactionId: output.transactionId, userId: target.userId })
          .select('status')
          .first()
        if (source == null || !confirmedSourceStatuses.includes(source.status)) return
        // This is a chain observation shared by all copies of the same outpoint.
        // Keep ownership, existing local reservations and the wallet's history intact.
        const now = new Date(Math.max(Date.now(), new Date(output.updated_at).getTime() + 1))
        if ((await storage.updateOutput(target.outputId, { spendable: false, updated_at: now }, trx)) !== 1)
          throw new Error('Confirmed spend lost its locked output')
        await storage.insertMonitorEvent(
          {
            id: 0,
            created_at: now,
            updated_at: now,
            event: 'ConfirmedOutputSpend',
            details: JSON.stringify({
              outputId: target.outputId,
              userId: target.userId,
              txid: target.txid,
              vout: target.vout,
              previousUpdatedAt: output.updated_at,
              observedUpdatedAt: now,
              provenTxId: proof.provenTxId,
              spendingTxid: proof.txid,
              height: proof.height,
              blockHash: proof.blockHash,
              vin: inputs.get(`${target.txid}.${target.vout}`)
            })
          },
          trx
        )
        changed++
      }
    )
    return changed
  }
  return admission == null
    ? await storage.transaction(apply)
    : await admission(async () => await storage.transaction(apply))
}

async function findTargets(storage: StorageKnex, inputs: Map<string, number>): Promise<ConfirmedSpendTarget[]> {
  const keys = [...inputs.keys()]
  const targets: ConfirmedSpendTarget[] = []
  function* unmatchedBatches() {
    for (let start = 0; start < keys.length && targets.length < matchLimit; start += 128) {
      yield keys.slice(start, start + 128).map(key => [key.slice(0, 64), Number(key.slice(65))])
    }
  }
  await runInSeries(unmatchedBatches(), async batch => {
    const txids = [...new Set(batch.map(([txid]) => String(txid)))]
    const rows = await storage
      .knex('transactions as t')
      .join('outputs as o', 'o.transactionId', 't.transactionId')
      .whereIn('t.txid', txids)
      .whereIn(['t.txid', 'o.vout'], batch)
      .whereRaw('?? = ?? AND ?? = ??', ['o.txid', 't.txid', 'o.userId', 't.userId'])
      .whereIn('t.status', confirmedSourceStatuses)
      .where('o.spendable', true)
      .whereNotNull('o.basketId')
      .select<ConfirmedSpendTarget[]>('o.outputId', 'o.txid', 'o.vout', 'o.userId')
      .orderBy('o.outputId')
      .limit(matchLimit - targets.length)
    targets.push(...rows)
  })
  return targets
}

/** Sweep proof inputs, including proofs learned as BEEF ancestors or by
 * synchronization. A periodic wrap revisits flags imported or restored late. */
export async function reviewConfirmedSpendPage(
  storage: StorageKnex,
  after: number,
  tipHeight: number,
  admission?: StorageWriterAdmission
): Promise<{ after: number; examined: number; repaired: number; unavailable: number }> {
  const start = performance.now()
  const rows = await storage
    .knex('proven_txs')
    .select<{ provenTxId: number }[]>('provenTxId')
    .where('provenTxId', '>', after)
    .orderBy('provenTxId')
    .limit(pageSize)
  let examined = 0
  let repaired = 0
  let unavailable = 0
  for (const { provenTxId } of rows) {
    if (examined > 0 && performance.now() - start >= workMsecs) break
    const proof = await storage.findProvenTxById(provenTxId)
    let repeat = false
    if (proof != null && proof.height + minimumDepth <= tipHeight) {
      try {
        const targets = await findTargets(storage, inputOutpoints(proof))
        const changed = await reconcileConfirmedSpender(storage, proof, targets, tipHeight, admission)
        repaired += changed
        repeat = changed > 0 && targets.length === matchLimit
      } catch {
        // One orphan, corrupt proof or transient lookup must not block future
        // proofs. The next pass reconsiders this row with fresh evidence.
        unavailable++
      }
    }
    examined++
    if (repeat) return { after, examined, repaired, unavailable }
    after = provenTxId
  }
  return { after: examined === rows.length && rows.length < pageSize ? 0 : after, examined, repaired, unavailable }
}

interface ConfirmedSpendReceipt extends ConfirmedSpendTarget {
  height: number
  blockHash: string
  observedUpdatedAt: string
}

function readReceipt(details: string | undefined): ConfirmedSpendReceipt | undefined {
  try {
    const value = JSON.parse(details ?? 'null') as ConfirmedSpendReceipt | null
    if (
      value != null &&
      [value.outputId, value.userId, value.vout, value.height].every(id => Number.isSafeInteger(id) && id >= 0) &&
      /^[a-f0-9]{64}$/.test(value.txid) &&
      /^[a-f0-9]{64}$/.test(value.blockHash) &&
      typeof value.observedUpdatedAt === 'string' &&
      Number.isFinite(Date.parse(value.observedUpdatedAt))
    )
      return value
  } catch {
    // A damaged receipt cannot authorize making an output spendable.
  }
  return undefined
}

function stillQuarantined(
  row: { userId: number; txid?: string; vout: number; spendable: boolean; spentBy?: number | null; updated_at: Date },
  receipt: ConfirmedSpendReceipt
): boolean {
  return (
    row.userId === receipt.userId &&
    row.txid === receipt.txid &&
    row.vout === receipt.vout &&
    !row.spendable &&
    row.spentBy == null &&
    new Date(row.updated_at).getTime() === Date.parse(receipt.observedUpdatedAt)
  )
}

/** Recover an observation invalidated by a deep reorg. Only reverse our exact
 * untouched flag, with a canonical funding proof and a positive exact-outpoint
 * unspent result. A competing spend, transport error or later wallet edit wins. */
export async function reviewConfirmedSpendRecoveries(
  storage: StorageKnex,
  after: number,
  admission?: StorageWriterAdmission
): Promise<{ after: number; restored: number; unavailable: number }> {
  const limit = 12
  const scope = storage.knex
  const ids = await scope('monitor_events')
    .select<{ id: number }[]>('id')
    .where({ event: 'ConfirmedOutputSpend' })
    .where('id', '>', after)
    .orderBy('id')
    .limit(limit)
  const started = performance.now()
  let restored = 0
  let unavailable = 0
  let processed = 0
  const services = storage.getServices()
  const headers = new Map<number, string>()
  function* budgetedReceipts() {
    for (const entry of ids) {
      if (processed > 0 && performance.now() - started >= workMsecs) return
      yield entry.id
    }
  }
  await runInSeries(budgetedReceipts(), async id => {
    after = id
    processed++
    try {
      restored += await reviewSpendReceipt(storage, id, services, headers, admission)
    } catch {
      unavailable++
    }
  })
  return { after: processed === ids.length && ids.length < limit ? 0 : after, restored, unavailable }
}

async function reviewSpendReceipt(
  storage: StorageKnex,
  id: number,
  services: WalletServices,
  headers: Map<number, string>,
  admission?: StorageWriterAdmission
): Promise<number> {
  const observation = await storage.findMonitorEventById(id)
  const receipt = readReceipt(observation?.details)
  if (receipt == null) return 0
  const row = await storage.findOutputById(receipt.outputId, undefined, true)
  if (row == null || !stillQuarantined(row, receipt)) return 0
  let activeHash = headers.get(receipt.height)
  if (activeHash == null) {
    const header = await services.getHeaderForHeight(receipt.height)
    if (header.length !== 80) throw new Error('Active header unavailable')
    activeHash = asString(doubleSha256BE(header))
    headers.set(receipt.height, activeHash)
  }
  if (activeHash === receipt.blockHash) return 0

  const funding = (await storage.findProvenTxs({ partial: { txid: receipt.txid } }))[0]
  if (funding == null) return 0
  await validateSyncProof(storage, funding)
  const scripted = await storage.findOutputById(receipt.outputId)
  if (scripted == null || !stillQuarantined(scripted, receipt)) return 0
  const verdict = await classifyOutputUtxo(services, scripted)
  if (verdict.verdict !== 'unspent') return 0
  const recheck = await services.getHeaderForHeight(receipt.height)
  if (recheck.length !== 80 || asString(doubleSha256BE(recheck)) !== activeHash) return 0

  const apply = async (trx: TrxToken): Promise<number> =>
    await restoreReceiptedOutput(storage, id, receipt, funding, activeHash, trx)
  return admission == null
    ? await storage.transaction(apply)
    : await admission(async () => await storage.transaction(apply))
}

async function restoreReceiptedOutput(
  storage: StorageKnex,
  id: number,
  receipt: ConfirmedSpendReceipt,
  funding: TableProvenTx,
  activeHash: string,
  trx: TrxToken
): Promise<number> {
  const sql = storage.toDb(trx)
  const fundingLock = await sql('proven_txs')
    .where('provenTxId', funding.provenTxId)
    .select('provenTxId')
    .forUpdate()
    .first()
  if (fundingLock == null) return 0
  const storedFunding = await storage.findProvenTxById(funding.provenTxId, trx)
  if (storedFunding == null || !sameSyncProof(storedFunding, funding)) return 0
  const locked = await sql('outputs')
    .where('outputId', receipt.outputId)
    .select('userId', 'txid', 'vout', 'transactionId', 'spendable', 'spentBy', 'updated_at')
    .forUpdate()
    .first()
  if (locked == null || !stillQuarantined(locked, receipt)) return 0
  const source = await sql('transactions')
    .where({ transactionId: locked.transactionId, userId: receipt.userId })
    .select('status', 'provenTxId')
    .first()
  if (source?.status !== 'completed' || source.provenTxId !== funding.provenTxId) return 0
  const now = new Date(Math.max(Date.now(), Date.parse(receipt.observedUpdatedAt) + 1))
  const changed = await storage.updateOutput(receipt.outputId, { spendable: true, updated_at: now }, trx)
  if (changed !== 1) throw new Error('Confirmed spend recovery lost its locked output')
  await storage.insertMonitorEvent(
    {
      id: 0,
      created_at: now,
      updated_at: now,
      event: 'ConfirmedOutputSpendRestored',
      details: JSON.stringify({ observationId: id, outputId: receipt.outputId, blockHash: activeHash })
    },
    trx
  )
  return changed
}
