import { Beef, ListOutputsResult, OriginatorDomainNameStringUnder250Bytes, WalletOutput, Validation } from '@bsv/sdk'
import { StorageKnex } from '../StorageKnex'
import { getListOutputsSpecOp } from './ListOutputsSpecOp'
import { AuthId, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { verifyId, verifyOne } from '../../utility/utilityHelpers'
import { TableOutputBasket } from '../schema/tables/TableOutputBasket'
import { TableOutputTag } from '../schema/tables/TableOutputTag'
import { TableOutput } from '../schema/tables/TableOutput'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { WERR_INTERNAL } from '../../sdk'

export async function listOutputs(
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

  let basketId: number | undefined = undefined
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
    basketsById[basketId!] = baskets[0]
  }

  let tagIds: number[] = []
  const specOpTags: string[] = []
  if (specOp && specOp.tagsParamsCount) {
    specOpTags.push(...tags.splice(0, Math.min(tags.length, specOp.tagsParamsCount)))
  }
  if (specOp && specOp.tagsToIntercept) {
    // Pull out tags used by current specOp
    const ts = tags
    tags = []
    for (const t of ts) {
      if (specOp.tagsToIntercept.length === 0 || specOp.tagsToIntercept.indexOf(t) >= 0) {
        specOpTags.push(t)
        if (t === 'all') {
          basketId = undefined
        }
      } else {
        tags.push(t)
      }
    }
  }

  if (specOp && specOp.resultFromTags) {
    const r = await specOp.resultFromTags(dsk, auth, vargs, specOpTags)
    return r
  }

  if (tags && tags.length > 0) {
    const q = k<TableOutputTag>('output_tags')
      .where({
        userId: userId,
        isDeleted: false
      })
      .whereNotNull('outputTagId')
      .whereIn('tag', tags)
      .select('outputTagId')
    const r = await q
    tagIds = r.map(r => r.outputTagId!)
  }

  const isQueryModeAll = vargs.tagQueryMode === 'all'
  if (isQueryModeAll && tagIds.length < tags.length)
    // all the required tags don't exist, impossible to satisfy.
    return r

  if (!isQueryModeAll && tagIds.length === 0 && tags.length > 0)
    // any and only non-existing tags, impossible to satisfy.
    return r

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
  if (vargs.includeLockingScripts || specOp?.includeOutputScripts)
    columns = [...columns, 'lockingScript', 'scriptLength', 'scriptOffset']

  const noTags = tagIds.length === 0
  const includeSpent = specOp && specOp.includeSpent ? specOp.includeSpent : false

  const txStatusOk = `(select status as tstatus from transactions where transactions.transactionId = outputs.transactionId) in ('completed', 'unproven', 'nosend', 'sending')`
  const txStatusOkCteq = `(select status as tstatus from transactions where transactions.transactionId = o.transactionId) in ('completed', 'unproven', 'nosend', 'sending')`

  const makeWithTagsQuery = () => {
    let cteqOptions = ''
    if (basketId) cteqOptions += ` AND o.basketId = ${basketId}`
    if (!includeSpent) cteqOptions += ` AND o.spendable`
    const cteq = k.raw(`
            SELECT ${columns.map(c => 'o.' + c).join(',')}, 
                    (SELECT COUNT(*) 
                    FROM output_tags_map AS m 
                    WHERE m.OutputId = o.OutputId 
                    AND m.outputTagId IN (${tagIds.join(',')}) 
                    ) AS tc
            FROM outputs AS o
            WHERE o.userId = ${userId} ${cteqOptions} AND ${txStatusOkCteq}
            `)

    const q = k.with('otc', cteq)
    q.from('otc')
    if (isQueryModeAll) q.where('tc', tagIds.length)
    else q.where('tc', '>', 0)
    return q
  }
  const makeWithTagsQueries = () => {
    const q = makeWithTagsQuery()
    const qcount = q.clone()
    q.select(columns)
    qcount.count('outputId as total')
    return { q, qcount }
  }

  const makeWhere = () => {
    const where: Partial<TableOutput> = { userId }
    if (basketId) where.basketId = basketId
    if (!includeSpent) where.spendable = true
    return where
  }
  const makeWithoutTagsQueries = () => {
    const where = makeWhere()
    const q = k('outputs').where(where).whereRaw(txStatusOk)
    const qcount = q.clone().count('outputId as total')
    q.columns(columns)
    return { q, qcount }
  }

  if (specOp?.totalOutputsIsSumOfSatoshis) {
    if (noTags) {
      const where = makeWhere()
      const q = k('outputs').sum('satoshis as totalSatoshis').where(where).whereRaw(txStatusOk)
      const rsum = await q.first()
      r.totalOutputs = Number(rsum ? rsum['totalSatoshis'] || 0 : 0)
      return r
    } else {
      columns = ['outputId', 'basketId', 'spendable', 'satoshis']
      const q = makeWithTagsQuery()
      q.sum('satoshis as totalSatoshis')
      const rsum = await q.first()
      r.totalOutputs = Number(rsum ? rsum['totalSatoshis'] || 0 : 0)
      return r
    }
  }

  const { q, qcount } = noTags ? makeWithoutTagsQueries() : makeWithTagsQueries()

  // Sort order when limit and offset are possible must be ascending for determinism.
  if (!specOp || !specOp.ignoreLimit) q.limit(limit).offset(offset)

  q.orderBy('outputId', orderBy)

  let outputs: TableOutput[] = await q

  if (specOp) {
    if (specOp.filterOutputs) outputs = await specOp.filterOutputs(dsk, auth, vargs, specOpTags, outputs)
    if (specOp.resultFromOutputs) {
      const r = await specOp.resultFromOutputs(dsk, auth, vargs, specOpTags, outputs)
      return r
    }
  }

  if (!limit || outputs.length < limit) r.totalOutputs = outputs.length
  else {
    const total = verifyOne(await qcount)['total']
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

  const labelsByTxid: Record<string, string[]> = {}

  const beef = new Beef()

  for (const o of outputs) {
    const wo: WalletOutput = {
      satoshis: Number(o.satoshis),
      spendable: !!o.spendable,
      outpoint: `${o.txid}.${o.vout}`
    }
    r.outputs.push(wo)
    //if (vargs.includeBasket && o.basketId) {
    //    if (!basketsById[o.basketId]) {
    //        basketsById[o.basketId] = verifyTruthy(await dsk.findOutputBasketId(o.basketId!, trx))
    //    }
    //    wo.basket = basketsById[o.basketId].name
    //}
    if (vargs.includeCustomInstructions && o.customInstructions) wo.customInstructions = o.customInstructions
    if (vargs.includeLabels && o.txid) {
      if (labelsByTxid[o.txid] === undefined) {
        labelsByTxid[o.txid] = (await dsk.getLabelsForTransactionId(o.transactionId, trx)).map(l => l.label)
      }
      wo.labels = labelsByTxid[o.txid]
    }
    if (vargs.includeTags) {
      wo.tags = (await dsk.getTagsForOutputId(o.outputId, trx)).map(t => t.tag)
    }
    if (vargs.includeLockingScripts) {
      await dsk.validateOutputScript(o, trx)
      if (o.lockingScript) wo.lockingScript = asString(o.lockingScript)
    }
    if (vargs.includeTransactions && !beef.findTxid(o.txid!)) {
      await dsk.getValidBeefForKnownTxid(o.txid!, beef, undefined, vargs.knownTxids, trx)
    }
  }

  if (vargs.includeTransactions) {
    r.BEEF = beef.toBinary()
  }

  return r
}
