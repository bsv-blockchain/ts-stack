import { Transaction } from '@bsv/sdk'
import { ProvenTxReqStatus, TrxToken } from '../../sdk'
import { WERR_INTERNAL, WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { StatusForTxidResult } from '../../sdk/WalletServices.interfaces'
import { parseTxScriptOffsets } from '../../utility/parseTxScriptOffsets'
import { randomBytesBase64, verifyId, verifyOne, verifyOneOrNone } from '../../utility/utilityHelpers'
import { asArray } from '../../utility/utilityHelpers.noBuffer'
import type { Brc177NoSendExpiryState } from '../../utility/brc177NoSendExpiry'
import type { StorageProvider } from '../StorageProvider'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { TableOutput } from '../schema/tables/TableOutput'
import { TableTransaction } from '../schema/tables/TableTransaction'

// Descending lifecycle order ensures a row advanced by this pass moves only
// into a state whose page has already run, so it is never counted or acted on
// twice without retaining an unbounded set of transaction IDs.
const ACTIVE_STATES: Brc177NoSendExpiryState[] = [
  'reclaiming',
  'broadcast',
  'conflicted',
  'revocation-requested',
  'signed',
  'unsigned',
  'preparing'
]
const QUERY_PAGE_SIZE = 100
const STATUS_BATCH_SIZE = 100

export interface NoSendExpiryLifecycleResult {
  inspected: number
  cancelled: number
  observed: number
  reclaimActivated: number
  reclaimed: number
  targetWon: number
  deferred: number
  errors: number
}

function emptyResult(): NoSendExpiryLifecycleResult {
  return {
    inspected: 0,
    cancelled: 0,
    observed: 0,
    reclaimActivated: 0,
    reclaimed: 0,
    targetWon: 0,
    deferred: 0,
    errors: 0
  }
}

async function activeTransactionsOnPage(
  storage: StorageProvider,
  page: TableTransaction[]
): Promise<TableTransaction[]> {
  // A remote database may be retained as a synchronized backup while another
  // provider is authoritative for a user. Check only the bounded set of users
  // represented by this page rather than materializing every active user or
  // expiry in a multi-user service.
  const activeStorage = storage.getSettings().storageIdentityKey
  const activeUsers = new Set<number>()
  for (const userId of new Set(page.map(transaction => transaction.userId))) {
    const user = verifyOneOrNone(
      await storage.findUsers({
        partial: { userId, activeStorage },
        paged: { limit: 1 }
      })
    )
    if (user != null) activeUsers.add(userId)
  }
  return page.filter(transaction => activeUsers.has(transaction.userId))
}

function isDue(transaction: TableTransaction, nowSeconds: number, height: number | undefined): boolean {
  if (transaction.noSendExpiryState === 'revocation-requested') return true
  if (transaction.noSendExpiryDeadline == null) return false
  return transaction.noSendExpiryMode === 'blockheight'
    ? height != null && height >= transaction.noSendExpiryDeadline
    : nowSeconds >= transaction.noSendExpiryDeadline
}

async function getStatuses(
  storage: StorageProvider,
  transactions: TableTransaction[]
): Promise<Map<string, StatusForTxidResult['status']>> {
  const txids = [
    ...new Set(
      transactions.flatMap(transaction => {
        const txids: string[] = []
        if (transaction.txid) txids.push(transaction.txid)
        if (transaction.noSendExpiryState === 'reclaiming' && transaction.noSendExpiryReclaimTxid) {
          txids.push(transaction.noSendExpiryReclaimTxid)
        }
        return txids
      })
    )
  ]
  if (txids.length === 0) return new Map()
  const statuses = new Map<string, StatusForTxidResult['status']>()
  for (let offset = 0; offset < txids.length; offset += STATUS_BATCH_SIZE) {
    try {
      const result = await storage.getServices().getStatusForTxids(txids.slice(offset, offset + STATUS_BATCH_SIZE))
      if (result.status !== 'success') continue
      for (const item of result.results) statuses.set(item.txid, item.status)
    } catch {}
  }
  return statuses
}

async function updateReqStatus(
  storage: StorageProvider,
  txid: string | undefined,
  status: ProvenTxReqStatus,
  note: string,
  trx: TrxToken
): Promise<void> {
  if (!txid) return
  const req = await EntityProvenTxReq.fromStorageTxid(storage, txid, trx)
  if (req == null || req.status === 'completed') return
  req.status = status
  req.addHistoryNote({ what: note })
  await req.updateStorageDynamicProperties(storage, trx)
}

async function quarantineTransactionOutputs(
  storage: StorageProvider,
  transactionId: number,
  trx: TrxToken
): Promise<void> {
  const outputs = await storage.findOutputs({ partial: { transactionId }, trx })
  for (const output of outputs) {
    if (output.spendable) await storage.updateOutput(output.outputId, { spendable: false }, trx)
  }
}

async function markObservedTarget(
  storage: StorageProvider,
  transaction: TableTransaction,
  final: boolean
): Promise<boolean> {
  return await storage.transaction(async trx => {
    const current = verifyOne(
      await storage.findTransactions({
        partial: { transactionId: verifyId(transaction.transactionId) },
        trx
      })
    )
    if (current.noSendExpiryState === 'reclaimed' || current.noSendExpiryState === 'cancelled') return false

    if (final) {
      return await finishTargetWinner(storage, current, trx)
    }
    if (
      current.noSendExpiryState !== 'signed' &&
      current.noSendExpiryState !== 'revocation-requested' &&
      current.noSendExpiryState !== 'broadcast' &&
      current.noSendExpiryState !== 'conflicted'
    ) {
      return false
    }
    // Claim even an existing broadcast state. Besides making conflicted ->
    // broadcast monotonic, the conditional write holds this row for the rest
    // of the transaction so a concurrent reclaim/proof winner cannot be
    // overwritten by the observation metadata update below.
    if (
      !(await storage.compareAndSetNoSendExpiryState(
        current.transactionId,
        current.noSendExpiryState,
        'broadcast',
        trx
      ))
    ) {
      return false
    }
    await storage.updateTransaction(
      current.transactionId,
      {
        noSendExpiryObservedAt: Date.now(),
        ...(current.status === 'nosend' ? { status: 'unproven' as const } : {})
      },
      trx
    )
    await updateReqStatus(storage, current.txid, 'unmined', 'brc177-target-observed', trx)
    return true
  })
}

async function noteTargetObservedDuringRace(storage: StorageProvider, transaction: TableTransaction): Promise<boolean> {
  return await storage.transaction(async trx => {
    const current = verifyOne(
      await storage.findTransactions({
        partial: { transactionId: verifyId(transaction.transactionId) },
        trx
      })
    )
    if (current.noSendExpiryState !== 'reclaiming') return false
    // Lock the lifecycle row before changing transaction/request metadata. If
    // a proof winner committed after our read, this self-transition fails and
    // prevents stale observation data from reviving the losing transaction.
    if (!(await storage.compareAndSetNoSendExpiryState(current.transactionId, 'reclaiming', 'reclaiming', trx))) {
      return false
    }
    let changed = false
    if (current.status === 'nosend') {
      await storage.updateTransaction(
        current.transactionId,
        {
          status: 'unproven',
          noSendExpiryObservedAt: current.noSendExpiryObservedAt ?? Date.now()
        },
        trx
      )
      changed = true
    }
    if (current.txid != null) {
      const req = await EntityProvenTxReq.fromStorageTxid(storage, current.txid, trx)
      if (req != null && req.status === 'nosend') {
        req.status = 'unmined'
        req.addHistoryNote({ what: 'brc177-target-observed-during-reclaim-race' })
        await req.updateStorageDynamicProperties(storage, trx)
        changed = true
      }
    }
    if (current.noSendExpiryReclaimTxid != null) {
      const reclaim = verifyOneOrNone(
        await storage.findTransactions({
          partial: { userId: current.userId, txid: current.noSendExpiryReclaimTxid },
          trx
        })
      )
      const reclaimReq = await EntityProvenTxReq.fromStorageTxid(storage, current.noSendExpiryReclaimTxid, trx)
      // Once the target is positively observed, BRC-177 stops future reclaim
      // submissions. Keep the request in proof tracking because a prior send
      // may still have reached a processor and either side can win the race.
      if (reclaimReq != null && (reclaimReq.status === 'unsent' || reclaimReq.status === 'sending')) {
        reclaimReq.status = 'unmined'
        reclaimReq.addHistoryNote({ what: 'brc177-reclaim-retry-suppressed-target-observed' })
        await reclaimReq.updateStorageDynamicProperties(storage, trx)
        if (reclaim != null && (reclaim.status === 'unprocessed' || reclaim.status === 'sending')) {
          await storage.updateTransaction(reclaim.transactionId, { status: 'unproven' }, trx)
        }
        changed = true
      }
    }
    return changed
  })
}

async function cancelUnsigned(storage: StorageProvider, transaction: TableTransaction): Promise<boolean> {
  return await storage.transaction(async trx => {
    const expected = transaction.noSendExpiryState
    if (expected !== 'preparing' && expected !== 'unsigned') return false
    if (!(await storage.compareAndSetNoSendExpiryState(transaction.transactionId, expected, 'cancelled', trx))) {
      return false
    }
    await storage.updateTransactionStatus('failed', transaction.transactionId, undefined, undefined, trx)
    return true
  })
}

function validateReclaim(transaction: TableTransaction): Transaction {
  if (
    transaction.noSendExpiryReclaimRawTx == null ||
    !transaction.noSendExpiryReclaimTxid ||
    !transaction.noSendExpiryReclaimDerivationPrefix ||
    !transaction.noSendExpiryReclaimDerivationSuffix ||
    transaction.noSendExpiryReclaimSatoshis == null ||
    !transaction.noSendExpiryAnchorTxid ||
    transaction.noSendExpiryAnchorVout == null
  ) {
    throw new WERR_INVALID_OPERATION('BRC-177 reclaim metadata is incomplete')
  }
  const reclaim = Transaction.fromBinary(asArray(transaction.noSendExpiryReclaimRawTx))
  if (
    reclaim.id('hex') !== transaction.noSendExpiryReclaimTxid ||
    reclaim.inputs.length !== 1 ||
    reclaim.outputs.length !== 1 ||
    reclaim.inputs[0].sourceTXID !== transaction.noSendExpiryAnchorTxid ||
    reclaim.inputs[0].sourceOutputIndex !== transaction.noSendExpiryAnchorVout ||
    reclaim.outputs[0].satoshis !== transaction.noSendExpiryReclaimSatoshis
  ) {
    throw new WERR_INVALID_OPERATION('BRC-177 reclaim metadata does not describe the signed reclaim transaction')
  }
  return reclaim
}

async function insertReclaim(
  storage: StorageProvider,
  target: TableTransaction,
  anchor: TableOutput,
  trx: TrxToken
): Promise<EntityProvenTxReq> {
  const reclaim = validateReclaim(target)
  const rawTx = asArray(target.noSendExpiryReclaimRawTx!)
  const reclaimTxid = target.noSendExpiryReclaimTxid!
  const existingTransaction = verifyOneOrNone(
    await storage.findTransactions({
      partial: { userId: target.userId, txid: reclaimTxid },
      trx
    })
  )
  let reclaimTransaction = existingTransaction
  if (reclaimTransaction == null) {
    const now = new Date()
    reclaimTransaction = {
      created_at: now,
      updated_at: now,
      transactionId: 0,
      userId: target.userId,
      status: 'unprocessed',
      reference: randomBytesBase64(12),
      isOutgoing: true,
      satoshis: target.noSendExpiryReclaimSatoshis! - anchor.satoshis,
      description: 'BRC-177 expiry reclaim',
      version: reclaim.version,
      lockTime: reclaim.lockTime,
      txid: reclaimTxid
    }
    reclaimTransaction.transactionId = await storage.insertTransaction(reclaimTransaction, trx)

    const basket = verifyOne(
      await storage.findOutputBaskets({
        partial: { userId: target.userId, name: 'default' },
        trx
      })
    )
    const offsets = parseTxScriptOffsets(rawTx)
    const scriptOffset = offsets.outputs[0]
    const lockingScript = rawTx.slice(scriptOffset.offset, scriptOffset.offset + scriptOffset.length)
    await storage.insertOutput(
      {
        created_at: now,
        updated_at: now,
        outputId: 0,
        userId: target.userId,
        transactionId: reclaimTransaction.transactionId,
        basketId: basket.basketId,
        // The reclaim is deliberately racing the released target. Do not expose
        // its output as wallet liquidity until a locally validated proof wins.
        spendable: false,
        change: true,
        outputDescription: '',
        vout: 0,
        satoshis: target.noSendExpiryReclaimSatoshis!,
        providedBy: 'storage',
        purpose: 'change',
        type: 'P2PKH',
        txid: reclaimTxid,
        derivationPrefix: target.noSendExpiryReclaimDerivationPrefix,
        derivationSuffix: target.noSendExpiryReclaimDerivationSuffix,
        scriptLength: scriptOffset.length,
        scriptOffset: scriptOffset.offset,
        lockingScript: scriptOffset.length > storage.getSettings().maxOutputScript ? undefined : lockingScript
      },
      trx
    )
  }

  await storage.updateOutput(
    anchor.outputId,
    {
      spendable: false,
      spentBy: reclaimTransaction.transactionId
    },
    trx
  )

  const targetReq = target.txid == null ? undefined : await EntityProvenTxReq.fromStorageTxid(storage, target.txid, trx)
  if (targetReq == null) throw new WERR_INTERNAL('BRC-177 protected transaction request is missing')
  const req = EntityProvenTxReq.fromTxid(reclaimTxid, rawTx, targetReq.api.inputBEEF)
  req.status = 'unsent'
  req.addNotifyTransactionId(reclaimTransaction.transactionId)
  req.addHistoryNote({ what: 'brc177-reclaim-activated', targetTxid: target.txid })
  return await req.insertOrMerge(storage, trx)
}

async function activateReclaim(
  storage: StorageProvider,
  transaction: TableTransaction,
  anchor: TableOutput,
  expected: 'signed' | 'revocation-requested' | 'conflicted'
): Promise<EntityProvenTxReq | undefined> {
  return await storage.transaction(async trx => {
    if (!(await storage.compareAndSetNoSendExpiryState(transaction.transactionId, expected, 'reclaiming', trx)))
      return undefined
    return await insertReclaim(storage, transaction, anchor, trx)
  })
}

async function finishReclaimWinner(
  storage: StorageProvider,
  target: TableTransaction,
  reclaimTransaction: TableTransaction,
  trx: TrxToken
): Promise<boolean> {
  const currentTarget = verifyOne(
    await storage.findTransactions({
      partial: { transactionId: target.transactionId, userId: target.userId },
      trx
    })
  )
  const currentReclaim = verifyOne(
    await storage.findTransactions({
      partial: { transactionId: reclaimTransaction.transactionId, userId: target.userId },
      trx
    })
  )
  if (
    currentTarget.noSendExpiryState !== 'reclaiming' ||
    currentTarget.status === 'completed' ||
    currentTarget.provenTxId != null ||
    currentReclaim.provenTxId == null
  ) {
    return false
  }
  if (!(await storage.compareAndSetNoSendExpiryState(currentTarget.transactionId, 'reclaiming', 'reclaimed', trx))) {
    return false
  }
  if (currentTarget.status !== 'failed') {
    await storage.updateTransactionStatus('failed', currentTarget.transactionId, undefined, undefined, trx)
  }
  await updateReqStatus(storage, currentTarget.txid, 'invalid', 'brc177-reclaim-won', trx)
  const anchor = verifyOne(
    await storage.findOutputs({
      partial: {
        userId: currentTarget.userId,
        txid: currentTarget.noSendExpiryAnchorTxid,
        vout: currentTarget.noSendExpiryAnchorVout
      },
      trx
    })
  )
  await storage.updateOutput(
    anchor.outputId,
    {
      spendable: false,
      spentBy: currentReclaim.transactionId
    },
    trx
  )
  const reclaimOutput = verifyOne(
    await storage.findOutputs({
      partial: { transactionId: currentReclaim.transactionId, vout: 0 },
      trx
    })
  )
  await storage.updateOutput(reclaimOutput.outputId, { spendable: true }, trx)
  return true
}

async function finishTargetWinner(storage: StorageProvider, target: TableTransaction, trx: TrxToken): Promise<boolean> {
  const current = verifyOne(
    await storage.findTransactions({
      partial: { transactionId: target.transactionId, userId: target.userId },
      trx
    })
  )
  if (
    current.noSendExpiryState == null ||
    current.noSendExpiryState === 'reclaimed' ||
    current.noSendExpiryState === 'cancelled' ||
    current.noSendExpiryState === 'target-won'
  ) {
    return false
  }
  const reclaimTxid = current.noSendExpiryReclaimTxid
  const reclaimTransaction =
    reclaimTxid == null
      ? undefined
      : verifyOneOrNone(
          await storage.findTransactions({
            partial: { userId: current.userId, txid: reclaimTxid },
            trx
          })
        )
  // Contradictory completion/proof signals for competing spends cannot both
  // describe the same best chain. Keep every output quarantined until the
  // ordinary proof reconciliation machinery resolves that inconsistency.
  if (reclaimTransaction?.status === 'completed' || reclaimTransaction?.provenTxId != null) {
    await quarantineTransactionOutputs(storage, current.transactionId, trx)
    await quarantineTransactionOutputs(storage, reclaimTransaction.transactionId, trx)
    return false
  }
  // A status flag alone suppresses reclaim but never releases value or
  // finalizes a winner; only the linked, locally validated proof may do that.
  if (current.provenTxId == null) return false
  if (
    !(await storage.compareAndSetNoSendExpiryState(current.transactionId, current.noSendExpiryState, 'target-won', trx))
  ) {
    return false
  }
  if (reclaimTransaction != null && reclaimTransaction.status !== 'failed') {
    await storage.updateTransactionStatus('failed', reclaimTransaction.transactionId, undefined, undefined, trx)
    await updateReqStatus(storage, reclaimTxid, 'doubleSpend', 'brc177-target-won', trx)
  }
  const anchor = verifyOne(
    await storage.findOutputs({
      partial: {
        userId: current.userId,
        txid: current.noSendExpiryAnchorTxid,
        vout: current.noSendExpiryAnchorVout
      },
      trx
    })
  )
  await storage.updateOutput(
    anchor.outputId,
    {
      spendable: false,
      spentBy: current.transactionId
    },
    trx
  )
  await storage.updateTransaction(
    current.transactionId,
    {
      noSendExpiryObservedAt: current.noSendExpiryObservedAt ?? Date.now(),
      ...(current.status === 'nosend' ? { status: 'unproven' as const } : {})
    },
    trx
  )
  return true
}

async function reconcileRace(
  storage: StorageProvider,
  target: TableTransaction
): Promise<'reclaimed' | 'target' | 'deferred'> {
  const reclaim =
    target.noSendExpiryReclaimTxid == null
      ? undefined
      : verifyOneOrNone(
          await storage.findTransactions({
            partial: { userId: target.userId, txid: target.noSendExpiryReclaimTxid }
          })
        )
  if (target.status === 'completed' || target.provenTxId != null) {
    const won = await storage.transaction(async trx => await finishTargetWinner(storage, target, trx))
    return won ? 'target' : 'deferred'
  }
  if (reclaim?.status === 'completed' || reclaim?.provenTxId != null) {
    const won = await storage.transaction(async trx => await finishReclaimWinner(storage, target, reclaim, trx))
    return won ? 'reclaimed' : 'deferred'
  }
  return 'deferred'
}

function isKnownOrMined(status: StatusForTxidResult['status'] | undefined): boolean {
  return status === 'known' || status === 'mined'
}

async function processObservationOrRace(
  storage: StorageProvider,
  transaction: TableTransaction,
  targetStatus: StatusForTxidResult['status'] | undefined,
  result: NoSendExpiryLifecycleResult
): Promise<boolean> {
  // A service's `mined` verdict is useful evidence that reclaim must stop,
  // but it is not a locally verified Merkle proof. Only storage's proven
  // state may finalize the target as the winner.
  if (transaction.status === 'completed' || transaction.provenTxId != null) {
    if (await markObservedTarget(storage, transaction, true)) result.targetWon++
    return true
  }
  if (transaction.noSendExpiryState === 'reclaiming') {
    if (isKnownOrMined(targetStatus)) {
      if (await noteTargetObservedDuringRace(storage, transaction)) result.observed++
    }
    const race = await reconcileRace(storage, transaction)
    if (race === 'reclaimed') result.reclaimed++
    else if (race === 'target') result.targetWon++
    else result.deferred++
    return true
  }
  const stateCanObserve =
    transaction.noSendExpiryState === 'signed' ||
    transaction.noSendExpiryState === 'revocation-requested' ||
    transaction.noSendExpiryState === 'broadcast' ||
    transaction.noSendExpiryState === 'conflicted'
  if (stateCanObserve && isKnownOrMined(targetStatus)) {
    if (await markObservedTarget(storage, transaction, false)) result.observed++
    return true
  }
  return false
}

async function requestRevocation(
  storage: StorageProvider,
  transaction: TableTransaction
): Promise<'revocation-requested' | undefined> {
  if (transaction.noSendExpiryState === 'revocation-requested') return 'revocation-requested'
  if (transaction.noSendExpiryState !== 'signed') return undefined
  // Persist that the deadline has triggered before consulting fallible
  // services. A clock correction or block-height reorganization must not
  // reactivate a transaction after its expiry was already observed.
  const changed = await storage.compareAndSetNoSendExpiryState(
    transaction.transactionId,
    'signed',
    'revocation-requested'
  )
  return changed ? 'revocation-requested' : undefined
}

async function attemptReclaim(
  storage: StorageProvider,
  transaction: TableTransaction,
  result: NoSendExpiryLifecycleResult,
  expected: 'revocation-requested' | 'conflicted' = 'revocation-requested'
): Promise<void> {
  const anchor = verifyOne(
    await storage.findOutputs({
      partial: {
        userId: transaction.userId,
        txid: transaction.noSendExpiryAnchorTxid,
        vout: transaction.noSendExpiryAnchorVout
      }
    })
  )
  let anchorIsUtxo: boolean
  try {
    anchorIsUtxo = await storage.getServices().isUtxo(anchor)
  } catch {
    result.deferred++
    return
  }
  if (!anchorIsUtxo) {
    if (expected === 'revocation-requested') {
      await storage.compareAndSetNoSendExpiryState(transaction.transactionId, expected, 'conflicted')
    }
    result.deferred++
    return
  }

  const reclaim = await activateReclaim(storage, transaction, anchor, expected)
  if (reclaim == null) return
  result.reclaimActivated++
  await storage.attemptToPostReqsToNetwork([reclaim]).catch(() => undefined)
}

async function processTransaction(
  storage: StorageProvider,
  transaction: TableTransaction,
  targetStatus: StatusForTxidResult['status'] | undefined,
  nowSeconds: number,
  height: number | undefined,
  result: NoSendExpiryLifecycleResult
): Promise<void> {
  if (await processObservationOrRace(storage, transaction, targetStatus, result)) return
  if (!isDue(transaction, nowSeconds, height)) return
  if (transaction.noSendExpiryState === 'preparing' || transaction.noSendExpiryState === 'unsigned') {
    if (await cancelUnsigned(storage, transaction)) result.cancelled++
    return
  }
  if (transaction.noSendExpiryState === 'conflicted') {
    // A competing mempool spend can disappear. Resume only after the target
    // is still explicitly unknown and the anchor service again gives a
    // conclusive unspent verdict; `attemptReclaim` advances directly to the
    // higher-ranked reclaiming state without reviving the released target.
    if (targetStatus !== 'unknown') {
      result.deferred++
      return
    }
    await attemptReclaim(storage, transaction, result, 'conflicted')
    return
  }
  if ((await requestRevocation(storage, transaction)) == null) return
  // Absence of a successful, explicit "unknown" verdict is not evidence
  // that the protected transaction is absent. A service outage must never
  // turn into authorization to double spend the anchor.
  if (targetStatus !== 'unknown') {
    result.deferred++
    return
  }
  await attemptReclaim(storage, transaction, result)
}

interface LifecycleContext {
  nowSeconds: number
  height?: number
  heightAttempted: boolean
}

async function processPage(
  storage: StorageProvider,
  page: TableTransaction[],
  context: LifecycleContext,
  result: NoSendExpiryLifecycleResult
): Promise<void> {
  const transactions = await activeTransactionsOnPage(storage, page)
  result.inspected += transactions.length

  const needsHeight = transactions.some(transaction => transaction.noSendExpiryMode === 'blockheight')
  if (!context.heightAttempted && needsHeight) {
    context.heightAttempted = true
    try {
      context.height = await storage.getServices().getHeight()
    } catch {}
  }
  const statuses = await getStatuses(storage, transactions)
  for (const transaction of transactions) {
    try {
      const targetStatus = transaction.txid ? statuses.get(transaction.txid) : undefined
      await processTransaction(storage, transaction, targetStatus, context.nowSeconds, context.height, result)
    } catch {
      // A damaged row needs operator repair, but it must not block unrelated
      // users or later deadlines in this multi-user monitor pass.
      result.deferred++
      result.errors++
    }
  }
}

async function processState(
  storage: StorageProvider,
  state: Brc177NoSendExpiryState,
  context: LifecycleContext,
  result: NoSendExpiryLifecycleResult
): Promise<void> {
  for (let offset = 0; ; offset += QUERY_PAGE_SIZE) {
    const page = await storage.findTransactions({
      partial: { noSendExpiryState: state },
      paged: { limit: QUERY_PAGE_SIZE, offset }
    })
    await processPage(storage, page, context, result)
    // State transitions can shift later offsets and defer some rows until
    // the next five-second pass, but each pass remains strictly bounded in
    // memory and every pass restarts from the beginning.
    if (page.length < QUERY_PAGE_SIZE) return
  }
}

export async function processNoSendExpiryLifecycle(storage: StorageProvider): Promise<NoSendExpiryLifecycleResult> {
  const result = emptyResult()
  const context: LifecycleContext = {
    nowSeconds: Math.floor(Date.now() / 1000),
    heightAttempted: false
  }

  for (const state of ACTIVE_STATES) {
    await processState(storage, state, context, result)
  }
  return result
}
