import { runInSeries } from '../../utility/runInSeries'
import { Transaction } from '@bsv/sdk'
import type { StorageKnex } from '../StorageKnex'
import type {
  ConfirmedSpendCursor,
  ConfirmedSpendPage,
  ConfirmedSpendRecoveryPage,
  StorageWriterAdmission
} from '../StorageActiveWrite'
import type { TableProvenTx } from '../schema/tables/TableProvenTx'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import { WalletError } from '../../sdk/WalletError'
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

/** Apply positive evidence only under the owning primary's captured epoch. */
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
  if (!(await storage.supportsPrimaryWriteFences()) || !(await storage.hasMonitorState())) return 0

  const byUser = new Map<number, ConfirmedSpendTarget[]>()
  for (const target of targets) {
    const group = byUser.get(target.userId) ?? []
    group.push(target)
    byUser.set(target.userId, group)
  }
  const users = await storage
    .knex('users')
    .select<{ userId: number; identityKey: string }[]>('userId', 'identityKey')
    .where({ activeStorage: storage.getSettings().storageIdentityKey })
    .whereIn('userId', [...byUser.keys()])
    .orderBy('userId')
  const captures: { userId: number; write: Awaited<ReturnType<StorageKnex['activeWriteTransaction']>> }[] = []
  await runInSeries(users, async user => {
    try {
      captures.push({ userId: user.userId, write: await storage.activeWriteTransaction(user) })
    } catch (error) {
      if (WalletError.fromUnknown(error).code !== 'WERR_NOT_ACTIVE') throw error
    }
  })
  if (captures.length === 0) return 0
  await validateSyncProof(storage, proof)

  let changed = 0
  await runInSeries(captures, async ({ userId, write }) => {
    const apply = () => write.transaction(trx => applyConfirmedSpend(storage, proof, inputs, byUser.get(userId)!, trx))
    try {
      changed += await (admission == null ? apply() : admission(apply))
    } catch (error) {
      if (WalletError.fromUnknown(error).code !== 'WERR_NOT_ACTIVE') throw error
    }
  })
  return changed
}

async function applyConfirmedSpend(
  storage: StorageKnex,
  proof: TableProvenTx,
  inputs: Map<string, number>,
  targets: ConfirmedSpendTarget[],
  trx: TrxToken
): Promise<number> {
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
      const now = new Date(Math.max(Date.now(), new Date(output.updated_at).getTime() + 1))
      if ((await storage.updateOutput(target.outputId, { spendable: false, updated_at: now }, trx)) !== 1)
        throw new Error('Confirmed spend lost its locked output')
      const details = JSON.stringify({
        ...target,
        previousUpdatedAt: output.updated_at,
        observedUpdatedAt: now,
        provenTxId: proof.provenTxId,
        spendingTxid: proof.txid,
        height: proof.height,
        blockHash: proof.blockHash,
        vin: inputs.get(`${target.txid}.${target.vout}`)
      })
      await db('monitor_confirmed_spends').insert({ outputId: target.outputId, details }).onConflict('outputId').merge()
      changed++
    }
  )
  return changed
}

async function findTargets(storage: StorageKnex, keys: string[], afterOutput: number): Promise<ConfirmedSpendTarget[]> {
  const batch = keys.map(key => [key.slice(0, 64), Number(key.slice(65))])
  const txids = [...new Set(batch.map(([txid]) => String(txid)))]
  return await storage
    .knex('transactions as t')
    .join('outputs as o', 'o.transactionId', 't.transactionId')
    .join('users as u', 'u.userId', 'o.userId')
    .where('u.activeStorage', storage.getSettings().storageIdentityKey)
    .whereIn('t.txid', txids)
    .whereIn(['t.txid', 'o.vout'], batch)
    .whereRaw('?? = ?? AND ?? = ??', ['o.txid', 't.txid', 'o.userId', 't.userId'])
    .whereIn('t.status', confirmedSourceStatuses)
    .where('o.spendable', true)
    .whereNotNull('o.basketId')
    .where('o.outputId', '>', afterOutput)
    .select<ConfirmedSpendTarget[]>('o.outputId', 'o.txid', 'o.vout', 'o.userId')
    .orderBy('o.outputId')
    .limit(matchLimit + 1)
}

const outpointsPerBatch = 128

async function reviewSpendProof(
  storage: StorageKnex,
  proof: TableProvenTx,
  tipHeight: number,
  partial: ConfirmedSpendCursor | undefined,
  admission: StorageWriterAdmission | undefined
): Promise<{ repaired: number; unavailable: number; partial?: ConfirmedSpendCursor }> {
  const keys = [...inputOutpoints(proof).keys()]
  const cursor =
    partial?.proofId === proof.provenTxId ? partial : { proofId: proof.provenTxId, inputOffset: 0, outputId: 0 }
  const batch = keys.slice(cursor.inputOffset, cursor.inputOffset + outpointsPerBatch)
  if (!batch.length) return { repaired: 0, unavailable: 0 }
  const targets = await findTargets(storage, batch, cursor.outputId)
  const selected = targets.slice(0, matchLimit)
  let repaired = 0
  let unavailable = 0
  try {
    repaired = await reconcileConfirmedSpender(storage, proof, selected, tipHeight, admission)
  } catch {
    // Retain the target keyset even if this group could not commit.
    unavailable = 1
  }
  if (targets.length > matchLimit)
    return { repaired, unavailable, partial: { ...cursor, outputId: selected[matchLimit - 1].outputId } }
  const next = cursor.inputOffset + batch.length
  return {
    repaired,
    unavailable,
    partial: next < keys.length ? { ...cursor, inputOffset: next, outputId: 0 } : undefined
  }
}

/** Page the proof store and the physical target IDs independently. A stale
 * target can never hide later matches for the same proof. */
export async function reviewConfirmedSpendPage(
  storage: StorageKnex,
  after: number,
  tipHeight: number,
  admission?: StorageWriterAdmission,
  partial?: ConfirmedSpendCursor,
  limit = pageSize
): Promise<ConfirmedSpendPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    throw new RangeError('Invalid confirmed-spend proof page size')
  const started = performance.now()
  const rows = await storage
    .knex('proven_txs')
    .select<{ provenTxId: number }[]>('provenTxId')
    .where('provenTxId', '>', after)
    .orderBy('provenTxId')
    .limit(limit)
  let examined = 0
  let repaired = 0
  let unavailable = 0
  for (const { provenTxId } of rows) {
    if (examined > 0 && performance.now() - started >= workMsecs) break
    const proof = await storage.findProvenTxById(provenTxId)
    examined++
    if (proof != null && proof.height + minimumDepth <= tipHeight) {
      try {
        const page = await reviewSpendProof(storage, proof, tipHeight, partial, admission)
        repaired += page.repaired
        unavailable += page.unavailable
        if (page.partial != null) return { after, partial: page.partial, examined, repaired, unavailable }
      } catch {
        unavailable++
      }
    }
    after = provenTxId
  }
  return { after: examined === rows.length && rows.length < limit ? 0 : after, examined, repaired, unavailable }
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

/** Migrate only live rollback evidence. The original audit events stay intact
 * and this cursor is retired after the legacy range has been imported. */
async function importLegacyReceipts(storage: StorageKnex, after: number): Promise<number | null> {
  const ids = await storage
    .knex('monitor_events')
    .select<{ id: number }[]>('id')
    .where({ event: 'ConfirmedOutputSpend' })
    .where('id', '>', after)
    .orderBy('id')
    .limit(12)
  await runInSeries(ids, async ({ id }) => {
    const event = await storage.findMonitorEventById(id)
    const receipt = readReceipt(event?.details)
    if (receipt == null || event?.details == null) return
    const details = event.details
    await storage.transaction(async trx => {
      const db = storage.toDb(trx)
      const row = await db('outputs')
        .where({ outputId: receipt.outputId })
        .forUpdate()
        .first('userId', 'txid', 'vout', 'spendable', 'spentBy', 'updated_at')
      if (row != null && stillQuarantined(row, receipt)) {
        await db('monitor_confirmed_spends')
          .insert({ outputId: receipt.outputId, details })
          .onConflict('outputId')
          .ignore()
      }
    })
  })
  return ids.length < 12 ? null : ids.at(-1)!.id
}

/** Recover an observation invalidated by a deep reorg. A competing spend,
 * transport error or later wallet edit wins. */
export async function reviewConfirmedSpendRecoveries(
  storage: StorageKnex,
  after: number,
  admission?: StorageWriterAdmission,
  legacyAfter: number | null = 0
): Promise<ConfirmedSpendRecoveryPage> {
  const limit = 12
  if (!(await storage.supportsPrimaryWriteFences()) || !(await storage.hasMonitorState()))
    return { after, legacyAfter, restored: 0, unavailable: 0 }
  const started = performance.now()
  if (legacyAfter != null) legacyAfter = await importLegacyReceipts(storage, legacyAfter)
  const rows = await storage
    .knex('monitor_confirmed_spends')
    .select<{ outputId: number; details: string }[]>('outputId', 'details')
    .where('outputId', '>', after)
    .orderBy('outputId')
    .limit(limit)
  let restored = 0
  let unavailable = 0
  let processed = 0
  const services = storage.getServices()
  const headers = new Map<number, string>()
  function* budgetedReceipts() {
    for (const row of rows) {
      if (processed > 0 && performance.now() - started >= workMsecs) return
      yield row
    }
  }
  await runInSeries(budgetedReceipts(), async ({ outputId, details }) => {
    after = outputId
    processed++
    try {
      restored += await reviewSpendReceipt(storage, outputId, details, services, headers, admission)
    } catch (error) {
      if (WalletError.fromUnknown(error).code !== 'WERR_NOT_ACTIVE') unavailable++
    }
  })
  return { after: processed === rows.length && rows.length < limit ? 0 : after, legacyAfter, restored, unavailable }
}

async function reviewSpendReceipt(
  storage: StorageKnex,
  outputId: number,
  details: string,
  services: WalletServices,
  headers: Map<number, string>,
  admission?: StorageWriterAdmission
): Promise<number> {
  const receipt = readReceipt(details)
  // Fail closed on damaged durable evidence so it can be inspected and repaired.
  if (receipt == null || receipt.outputId !== outputId) throw new Error('Invalid confirmed-spend receipt')
  const row = await storage.findOutputById(receipt.outputId, undefined, true)
  if (row == null || !stillQuarantined(row, receipt)) {
    await storage.knex('monitor_confirmed_spends').where({ outputId, details }).delete()
    return 0
  }
  const user = await storage
    .knex('users')
    .where({ userId: receipt.userId, activeStorage: storage.getSettings().storageIdentityKey })
    .first('identityKey', 'userId')
  if (user == null) return 0
  const write = await storage.activeWriteTransaction(user)
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

  const apply = () =>
    write.transaction(trx => restoreReceiptedOutput(storage, details, receipt, funding, activeHash, trx))
  return await (admission == null ? apply() : admission(apply))
}

async function restoreReceiptedOutput(
  storage: StorageKnex,
  details: string,
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
  const removed = await sql('monitor_confirmed_spends').where({ outputId: receipt.outputId, details }).delete()
  if (removed !== 1) return 0
  const now = new Date(Math.max(Date.now(), Date.parse(receipt.observedUpdatedAt) + 1))
  const changed = await storage.updateOutput(receipt.outputId, { spendable: true, updated_at: now }, trx)
  if (changed !== 1) throw new Error('Confirmed spend recovery lost its locked output')
  await storage.insertMonitorEvent(
    {
      id: 0,
      created_at: now,
      updated_at: now,
      event: 'ConfirmedOutputSpendRestored',
      details: JSON.stringify({ outputId: receipt.outputId, blockHash: activeHash })
    },
    trx
  )
  return changed
}
