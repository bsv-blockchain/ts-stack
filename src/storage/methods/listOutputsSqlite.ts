import { Beef, ListOutputsResult, OriginatorDomainNameStringUnder250Bytes, WalletOutput, Validation } from '@bsv/sdk'
import { StorageSqlite } from '../StorageSqlite'
import { getBasketToSpecOp, ListOutputsSpecOp } from './ListOutputsSpecOp'
import { AuthId, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { verifyId } from '../../utility/utilityHelpers'
import { TableOutput } from '../schema/tables/TableOutput'
import { asString } from '../../utility/utilityHelpers.noBuffer'

export async function listOutputsSqlite(
  storage: StorageSqlite,
  auth: AuthId,
  vargs: Validation.ValidListOutputsArgs,
  originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<ListOutputsResult> {
  const trx: TrxToken | undefined = undefined
  const userId = verifyId(auth.userId)
  const limit = vargs.limit
  let offset = vargs.offset
  let orderBy = 'ASC'
  if (offset < 0) {
    offset = -offset - 1
    orderBy = 'DESC'
  }

  const r: ListOutputsResult = {
    totalOutputs: 0,
    outputs: []
  }

  let specOp: ListOutputsSpecOp | undefined = undefined
  let basketId: number | undefined = undefined
  if (vargs.basket) {
    let b = vargs.basket
    specOp = getBasketToSpecOp()[b]
    b = specOp ? (specOp.useBasket ? specOp.useBasket : '') : b
    if (b) {
      const baskets = await storage.findOutputBaskets({ partial: { userId, name: b }, trx })
      if (baskets.length !== 1) return r
      basketId = baskets[0].basketId!
    }
  }

  let tagIds: number[] = []
  let tags = [...vargs.tags]
  const specOpTags: string[] = []
  if (specOp && specOp.tagsParamsCount) {
    specOpTags.push(...tags.splice(0, Math.min(tags.length, specOp.tagsParamsCount)))
  }
  if (specOp && specOp.tagsToIntercept) {
    const ts = tags
    tags = []
    for (const t of ts) {
      if (specOp.tagsToIntercept.length === 0 || specOp.tagsToIntercept.indexOf(t) >= 0) {
        specOpTags.push(t)
        if (t === 'all') basketId = undefined
      } else {
        tags.push(t)
      }
    }
  }

  if (specOp && specOp.resultFromTags) {
    return await specOp.resultFromTags(storage as any, auth, vargs, specOpTags)
  }

  if (tags.length > 0) {
    const placeholders = tags.map(() => '?').join(',')
    const rows = await storage.getAll<{ outputTagId: number }>(
      `SELECT outputTagId FROM output_tags WHERE userId = ? AND isDeleted = 0 AND outputTagId IS NOT NULL AND tag IN (${placeholders})`,
      [userId, ...tags]
    )
    tagIds = rows.map(r => r.outputTagId)
  }

  const isQueryModeAll = vargs.tagQueryMode === 'all'
  if (isQueryModeAll && tagIds.length < tags.length) return r
  if (!isQueryModeAll && tagIds.length === 0 && tags.length > 0) return r

  const columns = [
    'outputId', 'transactionId', 'basketId', 'spendable', 'txid', 'vout', 'satoshis',
    'lockingScript', 'customInstructions', 'outputDescription', 'spendingDescription',
    'scriptLength', 'scriptOffset'
  ]

  const noTags = tagIds.length === 0
  const includeSpent = specOp?.includeSpent || false
  const txStatusOk = `(SELECT status FROM transactions WHERE transactions.transactionId = outputs.transactionId) IN ('completed','unproven','nosend','sending')`

  let outputs: TableOutput[]
  let totalOutputs: number

  if (noTags) {
    const whereParts: string[] = [`userId = ?`]
    const whereParams: any[] = [userId]
    if (basketId) {
      whereParts.push(`basketId = ?`)
      whereParams.push(basketId)
    }
    if (!includeSpent) {
      whereParts.push(`spendable = 1`)
    }
    whereParts.push(txStatusOk)
    const whereClause = whereParts.join(' AND ')

    const baseSql = `FROM outputs WHERE ${whereClause}`

    if (!specOp || !specOp.ignoreLimit) {
      outputs = await storage.getAll<TableOutput>(
        `SELECT * ${baseSql} ORDER BY outputId ${orderBy} LIMIT ? OFFSET ?`,
        [...whereParams, limit, offset]
      )
    } else {
      outputs = await storage.getAll<TableOutput>(
        `SELECT * ${baseSql} ORDER BY outputId ${orderBy}`,
        whereParams
      )
    }

    if (!limit || outputs.length < limit) {
      totalOutputs = outputs.length
    } else {
      const countRow = await storage.getOne<{ total: number }>(
        `SELECT COUNT(outputId) as total ${baseSql}`,
        whereParams
      )
      totalOutputs = countRow?.total || 0
    }
  } else {
    const tagIdsList = tagIds.join(',')
    const tagCountCheck = isQueryModeAll ? `= ${tagIds.length}` : '> 0'

    let cteOptions = ''
    const cteParams: any[] = [userId]
    if (basketId) {
      cteOptions += ` AND o.basketId = ?`
      cteParams.push(basketId)
    }
    if (!includeSpent) cteOptions += ` AND o.spendable = 1`
    const txStatusOkCte = `(SELECT status FROM transactions WHERE transactions.transactionId = o.transactionId) IN ('completed','unproven','nosend','sending')`

    const cteSql = `
      SELECT ${columns.map(c => 'o.' + c).join(',')},
        (SELECT COUNT(*) FROM output_tags_map AS m WHERE m.outputId = o.outputId AND m.outputTagId IN (${tagIdsList})) AS tc
      FROM outputs AS o
      WHERE o.userId = ?${cteOptions} AND ${txStatusOkCte}`

    if (!specOp || !specOp.ignoreLimit) {
      outputs = await storage.getAll<TableOutput>(
        `WITH otc AS (${cteSql}) SELECT ${columns.join(',')} FROM otc WHERE tc ${tagCountCheck} ORDER BY outputId ${orderBy} LIMIT ? OFFSET ?`,
        [...cteParams, limit, offset]
      )
    } else {
      outputs = await storage.getAll<TableOutput>(
        `WITH otc AS (${cteSql}) SELECT ${columns.join(',')} FROM otc WHERE tc ${tagCountCheck} ORDER BY outputId ${orderBy}`,
        cteParams
      )
    }

    if (!limit || outputs.length < limit) {
      totalOutputs = outputs.length
    } else {
      const countRow = await storage.getOne<{ total: number }>(
        `WITH otc AS (${cteSql}) SELECT COUNT(outputId) as total FROM otc WHERE tc ${tagCountCheck}`,
        cteParams
      )
      totalOutputs = countRow?.total || 0
    }
  }

  if (specOp) {
    if (specOp.filterOutputs) outputs = await specOp.filterOutputs(storage as any, auth, vargs, specOpTags, outputs)
    if (specOp.resultFromOutputs) {
      return await specOp.resultFromOutputs(storage as any, auth, vargs, specOpTags, outputs)
    }
  }

  r.totalOutputs = totalOutputs

  const labelsByTxid: Record<string, string[]> = {}
  const beef = new Beef()

  for (const o of outputs) {
    const wo: WalletOutput = {
      satoshis: Number(o.satoshis),
      spendable: !!o.spendable,
      outpoint: `${o.txid}.${o.vout}`
    }
    r.outputs.push(wo)
    if (vargs.includeCustomInstructions && o.customInstructions) wo.customInstructions = o.customInstructions
    if (vargs.includeLabels && o.txid) {
      if (labelsByTxid[o.txid] === undefined) {
        labelsByTxid[o.txid] = (await storage.getLabelsForTransactionId(o.transactionId, trx)).map(l => l.label)
      }
      wo.labels = labelsByTxid[o.txid]
    }
    if (vargs.includeTags) {
      wo.tags = (await storage.getTagsForOutputId(o.outputId, trx)).map(t => t.tag)
    }
    if (vargs.includeLockingScripts) {
      await storage.validateOutputScript(o, trx)
      if (o.lockingScript) wo.lockingScript = asString(o.lockingScript)
    }
    if (vargs.includeTransactions && !beef.findTxid(o.txid!)) {
      await storage.getValidBeefForKnownTxid(o.txid!, beef, undefined, vargs.knownTxids, trx)
    }
  }

  if (vargs.includeTransactions) {
    r.BEEF = beef.toBinary()
  }

  return r
}
