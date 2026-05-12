import { Beef, ListOutputsResult, OriginatorDomainNameStringUnder250Bytes, WalletOutput, Validation } from '@bsv/sdk'
import type { StorageKnex } from '../StorageKnex'
import { Knex } from 'knex'
import { getListOutputsSpecOp } from './ListOutputsSpecOp'
import { AuthId, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { verifyId, verifyOne } from '../../utility/utilityHelpers'
import { TableOutputBasket } from '../schema/tables/TableOutputBasket'
import { TableOutputTag } from '../schema/tables/TableOutputTag'
import { TableOutput } from '../schema/tables/TableOutput'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import type { ProcessingStatus } from '../../sdk'

/**
 * Maps the legacy per-user `TransactionStatus` values that `listOutputs` treated
 * as "eligible to appear" to their V7 `ProcessingStatus` equivalents.
 *
 * Legacy status → V7 ProcessingStatus[]
 *   completed  → ['proven']
 *   unproven   → ['sent', 'seen', 'seen_multi', 'unconfirmed']
 *   nosend     → ['nosend']
 *   sending    → ['sending']
 *
 * NOTE: V7 `queued` is intentionally excluded.  Legacy `sending` meant "is
 * actively being broadcast" which maps to V7 `sending`.  V7 `queued` is
 * broader ("just created, not yet dispatched") and its outputs have not been
 * broadcast; they therefore fall outside the default spendable set.
 *
 * The union is the full set of processing states whose outputs are eligible to
 * appear in a `listOutputs` response.
 */
const TX_PROCESSING_ALLOWED: ProcessingStatus[] = [
  'proven',          // was: completed
  'sent',            // was: unproven
  'seen',            // was: unproven
  'seen_multi',      // was: unproven
  'unconfirmed',     // was: unproven
  'nosend',          // was: nosend
  'sending'          // was: sending  (queued excluded — see note above)
]

export async function listOutputs (
  dsk: StorageKnex,
  auth: AuthId,
  vargs: Validation.ValidListOutputsArgs,
  originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<ListOutputsResult> {
  const trx: TrxToken | undefined = undefined
  const userId = verifyId(auth.userId)
  const limit = vargs.limit
  let offset = vargs.offset
  let orderBy: 'asc' | 'desc' = 'asc'
  if (offset < 0) {
    offset = -offset - 1
    orderBy = 'desc'
  }

  const k = dsk.toDb(trx)

  const r: ListOutputsResult = {
    totalOutputs: 0,
    outputs: []
  }

  /*
        ValidListOutputsArgs {
            basket: BasketStringUnder300Bytes

            tags: OutputTagStringUnder300Bytes[]
            tagQueryMode: 'all' | 'any' // default any

            limit: PositiveIntegerDefault10Max10000 // default 10
            offset: number // default 0
        }
    */

  let { specOp, basket, tags } = getListOutputsSpecOp(vargs.basket, vargs.tags)

  let basketId: number | undefined
  const basketsById: Record<number, TableOutputBasket> = {}
  if (basket) {
    const baskets = await dsk.findOutputBaskets({
      partial: { userId, name: basket },
      trx
    })
    if (baskets.length !== 1) {
      // If basket does not exist, result is no outputs.
      return r
    }
    basketId = baskets[0].basketId!
    basketsById[basketId] = baskets[0]
  }

  let tagIds: number[] = []
  const specOpTags: string[] = []
  if (specOp?.tagsParamsCount) {
    specOpTags.push(...tags.splice(0, Math.min(tags.length, specOp.tagsParamsCount)))
  }
  if (specOp?.tagsToIntercept != null) {
    // Pull out tags used by current specOp
    const ts = tags
    tags = []
    for (const t of ts) {
      if (specOp.tagsToIntercept.length === 0 || specOp.tagsToIntercept.includes(t)) {
        specOpTags.push(t)
        if (t === 'all') {
          basketId = undefined
        }
      } else {
        tags.push(t)
      }
    }
  }

  if (specOp?.resultFromTags != null) {
    const r = await specOp.resultFromTags(dsk, auth, vargs, specOpTags)
    return r
  }

  if (tags && tags.length > 0) {
    const q = k<TableOutputTag>('output_tags')
      .where({
        userId,
        isDeleted: false
      })
      .whereNotNull('outputTagId')
      .whereIn('tag', tags)
      .select('outputTagId')
    const r = await q
    tagIds = r.map(r => r.outputTagId)
  }

  const isQueryModeAll = vargs.tagQueryMode === 'all'
  if (isQueryModeAll && tagIds.length < tags.length)
  // all the required tags don't exist, impossible to satisfy.
  { return r }

  if (!isQueryModeAll && tagIds.length === 0 && tags.length > 0)
  // any and only non-existing tags, impossible to satisfy.
  { return r }

  let columns: string[] = [
    'outputId',
    'transactionId',
    'basketId',
    'spendable',
    'txid',
    'vout',
    'satoshis',
    'customInstructions',
    'outputDescription',
    'spendingDescription'
  ]
  if (vargs.includeLockingScripts || specOp?.includeOutputScripts) { columns = [...columns, 'lockingScript', 'scriptLength', 'scriptOffset'] }

  const noTags = tagIds.length === 0
  const includeSpent = specOp?.includeSpent ?? false

  const outputColumns = columns.map(c => `o.${c} as ${c}`)

  const applyBaseFilters = (q: Knex.QueryBuilder) => {
    q.join('transactions as t', 't.transactionId', 'o.transactionId')
    q.where('o.userId', userId)
    q.whereIn('t.processing', TX_PROCESSING_ALLOWED)
    if (basketId) q.where('o.basketId', basketId)
    if (!includeSpent) q.where('o.spendable', true)
  }

  const makeWithTagsQuery = () => {
    const q = k('outputs as o')
    applyBaseFilters(q)

    if (isQueryModeAll) {
      for (const tagId of tagIds) {
        q.whereExists(function () {
          this.select(k.raw('1'))
            .from('output_tags_map as m')
            .whereRaw('m.outputId = o.outputId')
            .where('m.outputTagId', tagId)
            .whereNot('m.isDeleted', true)
        })
      }
    } else {
      q.whereExists(function () {
        this.select(k.raw('1'))
          .from('output_tags_map as m')
          .whereRaw('m.outputId = o.outputId')
          .whereIn('m.outputTagId', tagIds)
          .whereNot('m.isDeleted', true)
      })
    }

    return q
  }
  const makeWithTagsQueries = () => {
    const q = makeWithTagsQuery()
    const qcount = q.clone()
    q.select(outputColumns)
    qcount.clearSelect().clearOrder().count('o.outputId as total')
    return { q, qcount }
  }

  const makeWithoutTagsQueries = () => {
    const q = k('outputs as o')
    applyBaseFilters(q)
    const qcount = q.clone().clearSelect().clearOrder().count('o.outputId as total')
    q.select(outputColumns)
    return { q, qcount }
  }

  if (specOp?.totalOutputsIsSumOfSatoshis) {
    if (noTags) {
      const q = k('outputs as o')
      applyBaseFilters(q)
      q.sum('o.satoshis as totalSatoshis')
      const rsum = await q.first()
      r.totalOutputs = Number(rsum ? rsum.totalSatoshis || 0 : 0)
      return r
    } else {
      const q = makeWithTagsQuery()
      q.sum('o.satoshis as totalSatoshis')
      const rsum = await q.first()
      r.totalOutputs = Number(rsum ? rsum.totalSatoshis || 0 : 0)
      return r
    }
  }

  const { q, qcount } = noTags ? makeWithoutTagsQueries() : makeWithTagsQueries()

  // Sort order when limit and offset are possible must be ascending for determinism.
  if (!specOp?.ignoreLimit) q.limit(limit).offset(offset)

  q.orderBy('o.outputId', orderBy)

  let outputs: TableOutput[] = await q

  if (specOp != null) {
    if (specOp?.filterOutputs != null) outputs = await specOp.filterOutputs(dsk, auth, vargs, specOpTags, outputs)
    if (specOp?.resultFromOutputs != null) {
      const r = await specOp.resultFromOutputs(dsk, auth, vargs, specOpTags, outputs)
      return r
    }
  }

  if (!limit || outputs.length < limit) r.totalOutputs = outputs.length
  else {
    const total = verifyOne(await qcount).total
    r.totalOutputs = Number(total)
  }

  /*
        ListOutputsArgs {
            include?: 'locking scripts' | 'entire transactions'
            includeCustomInstructions?: BooleanDefaultFalse
            includeTags?: BooleanDefaultFalse
            includeLabels?: BooleanDefaultFalse
        }

        ListOutputsResult {
            totalOutputs: PositiveIntegerOrZero
            BEEF?: BEEF
            outputs: Array<WalletOutput>
        }

        WalletOutput {
            satoshis: SatoshiValue
            spendable: boolean
            outpoint: OutpointString

            customInstructions?: string
            lockingScript?: HexString
            tags?: OutputTagStringUnder300Bytes[]
            labels?: LabelStringUnder300Bytes[]
        }
    */

  const labelsByTransactionId: Record<number, string[]> = {}
  const tagsByOutputId: Record<number, string[]> = {}

  if (vargs.includeLabels) {
    const txIds = [...new Set(outputs.map(o => o.transactionId).filter((id): id is number => id !== undefined))]
    if (txIds.length > 0) {
      /*
       * Post-V7-cutover the `tx_labels_map.transactionId` column is an FK to
       * `actions.actionId` — NOT to `transactions.transactionId`.  A direct
       * `WHERE lm.transactionId IN (output.transactionId)` is therefore wrong
       * because those two keyspaces no longer overlap.
       *
       * Correct hop:
       *   outputs.transactionId (= transactions.transactionId)
       *     → actions.transactionId  (same value, user-scoped)
       *     → actions.actionId
       *     → tx_labels_map.transactionId
       *
       * We join `actions a` on (a.userId, a.transactionId) to obtain
       * a.actionId, then join `tx_labels_map lm` on lm.transactionId = a.actionId.
       * The result is grouped back to outputs.transactionId so the caller's
       * existing `labelsByTransactionId` lookup key is unchanged.
       */
      const labels = await k('tx_labels as l')
        .join('tx_labels_map as lm', 'lm.txLabelId', 'l.txLabelId')
        .join('actions as a', function () {
          this.on('a.actionId', '=', 'lm.transactionId')
            .andOn(k.raw('a.userId = ?', [userId]))
        })
        .whereIn('a.transactionId', txIds)
        .whereNot('lm.isDeleted', true)
        .whereNot('l.isDeleted', true)
        .select('a.transactionId as transactionId', 'l.label')

      for (const row of labels) {
        const txid = Number(row.transactionId)
        if (!labelsByTransactionId[txid]) labelsByTransactionId[txid] = []
        labelsByTransactionId[txid].push(String(row.label))
      }
    }
  }

  if (vargs.includeTags) {
    const outputIds = [...new Set(outputs.map(o => o.outputId).filter((id): id is number => id !== undefined))]
    if (outputIds.length > 0) {
      const tags = await k('output_tags as ot')
        .join('output_tags_map as om', 'om.outputTagId', 'ot.outputTagId')
        .whereIn('om.outputId', outputIds)
        .whereNot('om.isDeleted', true)
        .whereNot('ot.isDeleted', true)
        .select('om.outputId', 'ot.tag')

      for (const row of tags) {
        const outputId = Number(row.outputId)
        if (!tagsByOutputId[outputId]) tagsByOutputId[outputId] = []
        tagsByOutputId[outputId].push(String(row.tag))
      }
    }
  }

  const beef = new Beef()

  for (const o of outputs) {
    const wo: WalletOutput = {
      satoshis: Number(o.satoshis),
      spendable: !!o.spendable,
      outpoint: `${o.txid}.${o.vout}`
    }
    r.outputs.push(wo)
    if (vargs.includeCustomInstructions && o.customInstructions) wo.customInstructions = o.customInstructions
    if (vargs.includeLabels && o.transactionId !== undefined) wo.labels = labelsByTransactionId[o.transactionId] || []
    if (vargs.includeTags && o.outputId !== undefined) wo.tags = tagsByOutputId[o.outputId] || []
    if (vargs.includeLockingScripts) {
      await dsk.validateOutputScript(o, trx)
      if (o.lockingScript != null) wo.lockingScript = asString(o.lockingScript)
    }
    if (vargs.includeTransactions && (beef.findTxid(o.txid!) == null)) {
      await dsk.getValidBeefForKnownTxid(o.txid!, beef, undefined, vargs.knownTxids, trx)
    }
  }

  if (vargs.includeTransactions) {
    r.BEEF = beef.toBinary()
  }

  return r
}
