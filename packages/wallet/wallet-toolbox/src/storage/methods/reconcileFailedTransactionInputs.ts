import { StorageReqWrite } from '../StorageReqWrite'
import { Transaction, WalletLoggerInterface } from '@bsv/sdk'
import type * as sdk from '../../sdk'
import { StorageProvider } from '../StorageProvider'
import { EntityProvenTxReq } from '../schema/entities'
import { ProvenTxReqNonTerminalStatus } from '../../sdk/types'
import { TableOutput, TableProvenTxReq } from '../schema/tables'
import { verifyId } from '../../utility/utilityHelpers'
import {
  classifyOutputUtxo,
  mapWithConcurrency,
  UTXO_PROVIDER_MAX_CONCURRENCY
} from '../../services/classifyOutputUtxo'

export interface FailedInputReconciliationResult {
  checked: number
  staleConfirmed: number
  staleOutpoints: string[]
}

interface LocalInput {
  output: TableOutput
  outpoint: { txid: string; vout: number }
}

async function quarantineLocalInputs(
  localInputs: LocalInput[],
  storage: StorageProvider,
  trx?: sdk.TrxToken,
  skipUnchanged = false
): Promise<FailedInputReconciliationResult> {
  const staleOutpoints = new Set<string>()
  for (const { output, outpoint } of localInputs) {
    if (!skipUnchanged || output.spendable)
      await storage.updateOutput(verifyId(output.outputId), { spendable: false }, trx)
    staleOutpoints.add(`${outpoint.txid}.${outpoint.vout}`)
  }
  return {
    checked: localInputs.length,
    staleConfirmed: localInputs.length,
    staleOutpoints: [...staleOutpoints]
  }
}

async function findLocalInputs(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  trx?: sdk.TrxToken,
  onlyUserId?: number
): Promise<LocalInput[]> {
  const tx = Transaction.fromBinary(req.rawTx)
  const outpoints = tx.inputs
    .map(input => ({ txid: input.sourceTXID ?? '', vout: input.sourceOutputIndex ?? 0 }))
    .filter(outpoint => outpoint.txid !== '')
  if (outpoints.length === 0) return []

  // A transaction can be internalized by multiple users while the request's
  // notification list is racing. Resolve every local copy by txid so no user's
  // basket retains the same confirmed-stale outpoint.
  const transactions = await storage.findTransactions({
    partial: { txid: req.txid, ...(onlyUserId == null ? {} : { userId: onlyUserId }) },
    noRawTx: true,
    trx
  })
  const userIds = [...new Set(transactions.map(transaction => transaction.userId))]
  const localInputs: LocalInput[] = []
  const localKeys = new Set<string>()
  for (const userId of userIds) {
    const byOutpoint = await storage.findOutputsByOutpoints(userId, outpoints, trx)
    for (const outpoint of outpoints) {
      const output = byOutpoint[`${outpoint.txid}.${outpoint.vout}`]
      const localKey = `${userId}:${outpoint.txid}.${outpoint.vout}`
      if (output != null && !localKeys.has(localKey)) {
        localKeys.add(localKey)
        localInputs.push({ output, outpoint })
      }
    }
  }
  return localInputs
}

/**
 * The outpoints a rejection names as spent, as `txid.vout`. Arcade relays the
 * validator's text, e.g. "UTXO_SPENT (70): [ProcessTransaction][<txid>]
 * <txid>:<vout> utxo already spent by tx <spender>[0]".
 */
function namedOutpoints(extraInfo: string | undefined): Set<string> {
  const named = new Set<string>()
  for (const match of (extraInfo ?? '').matchAll(/\b([0-9a-fA-F]{64})[:.](\d+)\b/g)) {
    named.add(`${match[1].toLowerCase()}.${Number(match[2])}`)
  }
  return named
}

/**
 * Quarantine the locally-owned inputs of a transaction after Arcade supplies
 * explicit missing-input/conflict evidence. This path is deliberately
 * independent of explorer or UTXO providers: a positive broadcaster verdict
 * is enough to stop the failed transaction from feeding the same inputs into
 * another action. When the rejection names which of the transaction's inputs
 * were spent, only those are quarantined: the others were released when the
 * transaction failed and are still the wallet's on chain (a retry's change
 * input must not leave the balance because the retry lost its race for a
 * different input). When it names none, every local input is quarantined. A
 * later validated mined proof remains able to repair the transaction through
 * the ordinary proof recovery path.
 */
export async function quarantineReqInputs(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface,
  onlyUserOrEvidence?: number | { extraInfo?: string },
  onlyOutpoints?: ReadonlySet<string>,
  skipUnchanged = false,
  capturedEvidence?: { extraInfo?: string }
): Promise<FailedInputReconciliationResult> {
  const onlyUserId = typeof onlyUserOrEvidence === 'number' ? onlyUserOrEvidence : undefined
  const evidence = typeof onlyUserOrEvidence === 'object' ? onlyUserOrEvidence : capturedEvidence
  const inputOutpoints = new Set(
    Transaction.fromBinary(req.rawTx).inputs.map(input => `${input.sourceTXID ?? ''}.${input.sourceOutputIndex}`)
  )
  const named = [...namedOutpoints(evidence?.extraInfo)].filter(outpoint => inputOutpoints.has(outpoint))
  const localInputs = (await findLocalInputs(req, storage, trx, onlyUserId)).filter(
    ({ outpoint }) =>
      (onlyOutpoints == null || onlyOutpoints.has(`${outpoint.txid}.${outpoint.vout}`)) &&
      (named.length === 0 || named.includes(`${outpoint.txid}.${outpoint.vout}`))
  )
  const result = await quarantineLocalInputs(localInputs, storage, trx, skipUnchanged)
  if (result.staleConfirmed > 0) {
    logger?.log(
      `quarantineReqInputs: ${result.staleConfirmed} local input copy/copies quarantined for txid=${req.txid}`
    )
  }
  return result
}

/**
 * Keep only inputs created by a locally terminal parent unavailable after the
 * failed-child transition releases its allocations. Other inputs may still be
 * valid UTXOs and must remain reusable.
 */
export async function quarantineReqInputsFromFailedParents(
  req: EntityProvenTxReq,
  failedParentTxids: string[],
  storage: StorageProvider,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface,
  onlyUserId?: number,
  skipUnchanged = false
): Promise<FailedInputReconciliationResult> {
  const failedParents = new Set(failedParentTxids)
  const localInputs = (await findLocalInputs(req, storage, trx, onlyUserId)).filter(({ outpoint }) =>
    failedParents.has(outpoint.txid)
  )
  const result = await quarantineLocalInputs(localInputs, storage, trx, skipUnchanged)
  if (result.staleConfirmed > 0) {
    logger?.log(
      `quarantineReqInputsFromFailedParents: ${result.staleConfirmed} local parent output copy/copies quarantined for txid=${req.txid}`
    )
  }
  return result
}

/**
 * Fail every pending local action that spends an output of a terminal
 * transaction, and every pending action that spends theirs, in turn. Such an
 * action can never be mined; left pending it holds its other inputs as spent
 * and offers its own outputs as funding, so the wallet keeps building on a
 * dead chain until an aged-request poll catches up. Each descendant request
 * becomes `invalid`, its transaction `failed` (which releases its inputs),
 * and only the inputs it took from a failed parent stay quarantined.
 *
 * @returns the txids of the descendants failed here, in the order failed.
 */
export async function failPendingDescendants(
  terminalTxids: string[],
  storage: StorageProvider,
  trx?: sdk.TrxToken
): Promise<string[]> {
  const pending = await storage.findProvenTxReqs({ partial: {}, status: ProvenTxReqNonTerminalStatus, trx })
  const descendants = findPendingDescendants(terminalTxids, pending)
  // Descendants fail one at a time, in order, inside the caller's storage transaction.
  await descendants.reduce<Promise<void>>(async (previous, descendant) => {
    await previous
    await failDescendant(descendant, storage, trx)
  }, Promise.resolve())
  return descendants.map(({ reqApi }) => reqApi.txid)
}

/** Discover the complete currently pending graph before asynchronous observation. */
export async function pendingDescendantTxids(terminalTxids: string[], storage: StorageProvider): Promise<string[]> {
  const pending = await storage.findProvenTxReqs({ partial: {}, status: ProvenTxReqNonTerminalStatus })
  return findPendingDescendants(terminalTxids, pending).map(({ reqApi }) => reqApi.txid)
}

/** Reconcile only originally captured descendants, under each profile's original epoch. */
export async function failCapturedPendingDescendants(
  terminalTxids: string[],
  storage: StorageProvider,
  writes: StorageReqWrite
): Promise<string[]> {
  writes.assertProvider(storage)
  const pending = await storage.findProvenTxReqs({ partial: {}, status: ProvenTxReqNonTerminalStatus })
  const failed: string[] = []
  for (const { reqApi, parentTxids } of findPendingDescendants(terminalTxids, pending)) {
    if (!writes.hasRequest(reqApi.txid)) continue
    const req = new EntityProvenTxReq(reqApi)
    let applied = false
    const recorded = await writes.request(req, current => {
      if (!ProvenTxReqNonTerminalStatus.includes(current.status)) return Promise.resolve(false)
      current.status = 'invalid'
      current.addHistoryNote({
        when: new Date().toISOString(),
        what: 'failedParentCascade',
        parentTxids: parentTxids.join(',')
      })
      applied = true
      return Promise.resolve()
    })
    if (!recorded || !applied) continue
    await applyCapturedTerminalFailure(req, storage, writes, false, parentTxids)
    failed.push(req.txid)
  }
  return failed
}

interface PendingDescendant {
  reqApi: TableProvenTxReq
  parentTxids: string[]
}

/**
 * The pending requests that spend an output of a terminal transaction, or of
 * a request found here, in the order they fail, each with the failed parents
 * it spends. Passes over `pending` repeat until one finds nothing new.
 */
function findPendingDescendants(terminalTxids: string[], pending: TableProvenTxReq[]): PendingDescendant[] {
  const failed = new Set(terminalTxids)
  const candidates = pending.map(reqApi => ({ reqApi, sources: sourceTxids(reqApi.rawTx) }))
  const descendants: PendingDescendant[] = []
  let grew = true
  while (grew) {
    grew = false
    for (const { reqApi, sources } of candidates) {
      if (failed.has(reqApi.txid)) continue
      const parentTxids = [...new Set(sources.filter(txid => failed.has(txid)))]
      if (parentTxids.length === 0) continue
      failed.add(reqApi.txid)
      descendants.push({ reqApi, parentTxids })
      grew = true
    }
  }
  return descendants
}

/** The txids a raw transaction spends from; none when it does not parse. */
function sourceTxids(rawTx: number[]): string[] {
  try {
    return Transaction.fromBinary(rawTx)
      .inputs.map(input => input.sourceTXID)
      .filter((txid): txid is string => txid != null)
  } catch {
    return []
  }
}

async function failDescendant(
  { reqApi, parentTxids }: PendingDescendant,
  storage: StorageProvider,
  trx?: sdk.TrxToken
): Promise<void> {
  const req = new EntityProvenTxReq(reqApi)
  req.status = 'invalid'
  req.addHistoryNote({
    when: new Date().toISOString(),
    what: 'failedParentCascade',
    parentTxids: parentTxids.join(',')
  })
  await req.updateStorageDynamicProperties(storage, trx)
  let transactionIds = req.notify.transactionIds ?? []
  if (transactionIds.length === 0) {
    transactionIds = (await storage.findTransactions({ partial: { txid: req.txid }, noRawTx: true, trx })).map(
      tx => tx.transactionId
    )
  }
  await transactionIds.reduce<Promise<void>>(async (previous, transactionId) => {
    await previous
    const tx = (await storage.findTransactions({ partial: { transactionId }, noRawTx: true, trx }))[0]
    if (tx == null || tx.status === 'failed' || tx.status === 'completed' || tx.provenTxId != null) return
    await storage.updateTransactionStatus('failed', transactionId, undefined, undefined, trx)
  }, Promise.resolve())
  await quarantineReqInputsFromFailedParents(req, parentTxids, storage, trx)
}

/**
 * Ask the configured UTXO-provider collection to classify the request's local
 * inputs and mark only positively confirmed spent outputs unavailable.
 * Provider errors and a collection with no providers are inconclusive and
 * never count as spent.
 */
export async function markConfirmedStaleReqInputs(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  services: sdk.WalletServices,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface,
  capturedWrites?: StorageReqWrite
): Promise<FailedInputReconciliationResult> {
  const writes =
    capturedWrites ??
    (trx == null && typeof storage.activeWriteTransaction === 'function'
      ? await StorageReqWrite.capture(storage, [req.txid])
      : undefined)
  const result = { checked: 0, staleConfirmed: 0, staleOutpoints: [] as string[] }
  const localInputs = await findLocalInputs(req, storage, trx)
  const verdicts = new Map<string, 'stale' | 'utxo' | 'inconclusive'>()
  const uniqueInputs = new Map<string, LocalInput>()
  for (const localInput of localInputs) {
    const key = `${localInput.outpoint.txid}.${localInput.outpoint.vout}`
    if (!uniqueInputs.has(key)) uniqueInputs.set(key, localInput)
  }

  await mapWithConcurrency([...uniqueInputs.values()], UTXO_PROVIDER_MAX_CONCURRENCY, async ({ output, outpoint }) => {
    const key = `${outpoint.txid}.${outpoint.vout}`
    if (output.lockingScript == null) {
      try {
        await storage.validateOutputScript(output, trx)
      } catch {
        verdicts.set(key, 'inconclusive')
        return
      }
    }
    if (output.lockingScript == null) {
      verdicts.set(key, 'inconclusive')
      return
    }
    const classification = await classifyOutputUtxo(services, output)
    let verdict: 'inconclusive' | 'stale' | 'utxo'
    if (classification.verdict === 'unknown') verdict = 'inconclusive'
    else if (classification.verdict === 'unspent') verdict = 'utxo'
    else verdict = 'stale'
    verdicts.set(key, verdict)
  })

  const staleOutpoints = new Set<string>()
  for (const { output, outpoint } of localInputs) {
    const key = `${outpoint.txid}.${outpoint.vout}`
    const verdict = verdicts.get(key)
    if (verdict == null || verdict === 'inconclusive') continue
    result.checked++
    if (verdict === 'stale') {
      let changed = false
      const apply = async (token?: sdk.TrxToken) => {
        const current = await storage.findOutputs({
          partial: {
            outputId: verifyId(output.outputId),
            userId: output.userId,
            txid: outpoint.txid,
            vout: outpoint.vout
          },
          trx: token
        })
        if (current.length !== 1) return
        await storage.updateOutput(verifyId(output.outputId), { spendable: false }, token)
        changed = true
      }
      const committed = writes != null ? await writes.forUser(output.userId, apply) : (await apply(trx), true)
      if (committed && changed) {
        result.staleConfirmed++
        staleOutpoints.add(key)
      }
    }
  }
  result.staleOutpoints = [...staleOutpoints]
  if (result.staleConfirmed > 0) {
    logger?.log(
      `markConfirmedStaleReqInputs: ${result.staleConfirmed} of ${result.checked} local input copy/copies confirmed spent for txid=${req.txid}`
    )
  }
  return result
}

/** Original captures restrict each real profile. Failure bookkeeping and input
 * quarantine commit atomically; counts include only actual committed scopes. */
export async function applyCapturedTerminalFailure(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  writes: StorageReqWrite,
  inputConflict: boolean,
  failedParentTxids: string[] = [],
  evidence?: { extraInfo?: string }
): Promise<FailedInputReconciliationResult> {
  writes.assertProvider(storage)
  const results = await writes.status(req, 'failed', async (userId, trx) => {
    if (inputConflict)
      return await quarantineReqInputs(req, storage, trx, undefined, userId, undefined, false, evidence)
    if (failedParentTxids.length)
      return await quarantineReqInputsFromFailedParents(req, failedParentTxids, storage, trx, undefined, userId)
    return { checked: 0, staleConfirmed: 0, staleOutpoints: [] }
  })
  return {
    checked: results.reduce((sum, result) => sum + result.checked, 0),
    staleConfirmed: results.reduce((sum, result) => sum + result.staleConfirmed, 0),
    staleOutpoints: [...new Set(results.flatMap(result => result.staleOutpoints))]
  }
}

/** Replay only recorded terminal evidence, under the caller's actual user
 * writer. History chooses comparison data, never a SQL actor or primary grant. */
export async function quarantineRecordedTerminalInputs(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  userId: number,
  trx: sdk.TrxToken
): Promise<void> {
  if (!['invalid', 'doubleSpend'].includes(req.status)) return
  const notes = req.history.notes ?? []
  if (
    notes.some(
      note =>
        ['arcSSETerminalRejection', 'proactiveTerminalReconciliation'].includes(note.what ?? '') &&
        note.inputConflict === true
    )
  ) {
    await quarantineReqInputs(req, storage, trx, undefined, userId, undefined, true)
    return
  }
  const spent = new Set<string>()
  const parents = new Set<string>()
  for (const note of notes) {
    if (note.what === 'markStaleInputsAsSpent' && typeof note.outpoints === 'string')
      for (const point of note.outpoints.split(',')) spent.add(point)
    if (note.what === 'proactiveFailedParentQuarantine' && typeof note.parentTxids === 'string')
      for (const txid of note.parentTxids.split(',')) if (/^[a-f0-9]{64}$/.test(txid)) parents.add(txid)
  }
  if (spent.size) await quarantineReqInputs(req, storage, trx, undefined, userId, spent, true)
  const failed: string[] = []
  for (const txid of parents) {
    const current = await storage.findProvenTxReqs({ partial: { txid }, trx })
    if (current.some(parent => ['invalid', 'doubleSpend'].includes(parent.status))) failed.push(txid)
  }
  if (failed.length) await quarantineReqInputsFromFailedParents(req, failed, storage, trx, undefined, userId, true)
}
