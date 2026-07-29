import { Beef, ListOutputsResult, OriginatorDomainNameStringUnder250Bytes, WalletOutput, Validation } from '@bsv/sdk'
import type { StorageKnex } from '../StorageKnex'
import { Knex } from 'knex'
import { getListOutputsSpecOp, type ListOutputsSpecOp } from './ListOutputsSpecOp'
import { AuthId, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { verifyId, verifyOne } from '../../utility/utilityHelpers'
import { TableOutputTag } from '../schema/tables/TableOutputTag'
import { TableOutput } from '../schema/tables/TableOutput'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { managedChangeOutputFields } from './managedChange'

interface ResolvedKnexListTags {
  tags: string[]
  specOpTags: string[]
  basketId?: number
}

function normalizeKnexListOffset(offset: number): {
  offset: number
  orderBy: 'asc' | 'desc'
} {
  return offset < 0
    ? { offset: -offset - 1, orderBy: 'desc' }
    : { offset, orderBy: 'asc' }
}

async function resolveKnexBasketId(
  storage: StorageKnex,
  userId: number,
  basket: string | undefined,
  trx?: TrxToken
): Promise<number | null | undefined> {
  if (basket == null || basket === '') return undefined
  const baskets = await storage.findOutputBaskets({
    partial: { userId, name: basket },
    trx
  })
  return baskets.length === 1 ? baskets[0].basketId : null
}

function resolveKnexListTags(
  specOp: ListOutputsSpecOp | undefined,
  sourceTags: string[],
  initialBasketId: number | undefined
): ResolvedKnexListTags {
  const tags = sourceTags.slice()
  const specOpTags: string[] = []
  let basketId = initialBasketId
  if (specOp?.tagsParamsCount) {
    specOpTags.push(...tags.splice(0, Math.min(tags.length, specOp.tagsParamsCount)))
  }
  if (specOp?.tagsToIntercept == null) return { tags, specOpTags, basketId }
  const remaining: string[] = []
  for (const tag of tags) {
    if (
      specOp.tagsToIntercept.length === 0 ||
      specOp.tagsToIntercept.includes(tag)
    ) {
      specOpTags.push(tag)
      if (tag === 'all') basketId = undefined
    } else {
      remaining.push(tag)
    }
  }
  return { tags: remaining, specOpTags, basketId }
}

async function findKnexTagIds(
  k: Knex,
  userId: number,
  tags: string[]
): Promise<number[]> {
  if (tags.length === 0) return []
  const rows = await k<TableOutputTag>('output_tags')
    .where({ userId, isDeleted: false })
    .whereNotNull('outputTagId')
    .whereIn('tag', tags)
    .select('outputTagId')
  return rows.map(row => row.outputTagId)
}

function knexTagQueryCannotMatch(
  tags: string[],
  tagIds: number[],
  queryModeAll: boolean
): boolean {
  return queryModeAll
    ? tagIds.length < tags.length
    : tags.length > 0 && tagIds.length === 0
}

function applyKnexBaseFilters(
  query: Knex.QueryBuilder,
  userId: number,
  basketId: number | undefined,
  includeSpent: boolean,
  managedChangeOnly: boolean
): void {
  query.join('transactions as t', 't.transactionId', 'o.transactionId')
  query.where('o.userId', userId)
  query.whereIn('t.status', ['completed', 'unproven', 'nosend', 'sending'])
  if (basketId != null) query.where('o.basketId', basketId)
  if (!includeSpent) query.where('o.spendable', true)
  if (!managedChangeOnly) return
  query
    .where({
      'o.type': managedChangeOutputFields.type,
      'o.change': managedChangeOutputFields.change,
      'o.providedBy': managedChangeOutputFields.providedBy,
      'o.purpose': managedChangeOutputFields.purpose
    })
    .whereNotNull('o.derivationPrefix')
    .whereNot('o.derivationPrefix', '')
    .whereNotNull('o.derivationSuffix')
    .whereNot('o.derivationSuffix', '')
    .whereNull('o.spentBy')
}

function applyKnexTagFilters(
  query: Knex.QueryBuilder,
  k: Knex,
  tagIds: number[],
  queryModeAll: boolean
): void {
  if (queryModeAll) {
    for (const tagId of tagIds) {
      query.whereExists(function () {
        this.select(k.raw('1'))
          .from('output_tags_map as m')
          .whereRaw('m.outputId = o.outputId')
          .where('m.outputTagId', tagId)
          .whereNot('m.isDeleted', true)
      })
    }
    return
  }
  query.whereExists(function () {
    this.select(k.raw('1'))
      .from('output_tags_map as m')
      .whereRaw('m.outputId = o.outputId')
      .whereIn('m.outputTagId', tagIds)
      .whereNot('m.isDeleted', true)
  })
}

function createKnexOutputQuery(
  k: Knex,
  userId: number,
  basketId: number | undefined,
  includeSpent: boolean,
  managedChangeOnly: boolean,
  tagIds: number[],
  queryModeAll: boolean
): Knex.QueryBuilder {
  const query = k('outputs as o')
  applyKnexBaseFilters(
    query,
    userId,
    basketId,
    includeSpent,
    managedChangeOnly
  )
  if (tagIds.length > 0) {
    applyKnexTagFilters(query, k, tagIds, queryModeAll)
  }
  return query
}

async function loadKnexOutputAssociations(
  k: Knex,
  outputs: TableOutput[],
  includeLabels: boolean,
  includeTags: boolean
): Promise<{
  labelsByTransactionId: Record<number, string[]>
  tagsByOutputId: Record<number, string[]>
}> {
  const labelsByTransactionId: Record<number, string[]> = {}
  const tagsByOutputId: Record<number, string[]> = {}
  if (includeLabels) {
    const transactionIds = [
      ...new Set(
        outputs
          .map(output => output.transactionId)
          .filter((id): id is number => id !== undefined)
      )
    ]
    if (transactionIds.length > 0) {
      const rows = await k('tx_labels as l')
        .join('tx_labels_map as lm', 'lm.txLabelId', 'l.txLabelId')
        .whereIn('lm.transactionId', transactionIds)
        .whereNot('lm.isDeleted', true)
        .whereNot('l.isDeleted', true)
        .select('lm.transactionId', 'l.label')
      for (const row of rows) {
        const transactionId = Number(row.transactionId)
        labelsByTransactionId[transactionId] ??= []
        labelsByTransactionId[transactionId].push(String(row.label))
      }
    }
  }
  if (includeTags) {
    const outputIds = [
      ...new Set(
        outputs
          .map(output => output.outputId)
          .filter((id): id is number => id !== undefined)
      )
    ]
    if (outputIds.length > 0) {
      const rows = await k('output_tags as ot')
        .join('output_tags_map as om', 'om.outputTagId', 'ot.outputTagId')
        .whereIn('om.outputId', outputIds)
        .whereNot('om.isDeleted', true)
        .whereNot('ot.isDeleted', true)
        .select('om.outputId', 'ot.tag')
      for (const row of rows) {
        const outputId = Number(row.outputId)
        tagsByOutputId[outputId] ??= []
        tagsByOutputId[outputId].push(String(row.tag))
      }
    }
  }
  return { labelsByTransactionId, tagsByOutputId }
}

async function hydrateKnexWalletOutput(
  storage: StorageKnex,
  output: TableOutput,
  vargs: Validation.ValidListOutputsArgs,
  labelsByTransactionId: Record<number, string[]>,
  tagsByOutputId: Record<number, string[]>,
  beef: Beef,
  trx?: TrxToken
): Promise<WalletOutput> {
  const walletOutput: WalletOutput = {
    satoshis: Number(output.satoshis),
    spendable: !!output.spendable,
    outpoint: `${output.txid}.${output.vout}`
  }
  if (vargs.includeCustomInstructions && output.customInstructions) {
    walletOutput.customInstructions = output.customInstructions
  }
  if (vargs.includeLabels && output.transactionId !== undefined) {
    walletOutput.labels = labelsByTransactionId[output.transactionId] ?? []
  }
  if (vargs.includeTags && output.outputId !== undefined) {
    walletOutput.tags = tagsByOutputId[output.outputId] ?? []
  }
  if (vargs.includeLockingScripts) {
    await storage.validateOutputScript(output, trx)
    if (output.lockingScript != null) {
      walletOutput.lockingScript = asString(output.lockingScript)
    }
  }
  if (
    vargs.includeTransactions &&
    output.txid != null &&
    beef.findTxid(output.txid) == null
  ) {
    await storage.getValidBeefForKnownTxid(
      output.txid,
      beef,
      undefined,
      vargs.knownTxids,
      trx
    )
  }
  return walletOutput
}
export async function listOutputs(
  dsk: StorageKnex,
  auth: AuthId,
  vargs: Validation.ValidListOutputsArgs,
  _originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<ListOutputsResult> {
  const trx: TrxToken | undefined = undefined
  const userId = verifyId(auth.userId)
  const limit = vargs.limit
  const { offset, orderBy } = normalizeKnexListOffset(vargs.offset)
  const k = dsk.toDb(trx)
  const result: ListOutputsResult = { totalOutputs: 0, outputs: [] }
  const { specOp, basket, tags: sourceTags } = getListOutputsSpecOp(
    vargs.basket,
    vargs.tags
  )
  const resolvedBasketId = await resolveKnexBasketId(
    dsk,
    userId,
    basket,
    trx
  )
  if (resolvedBasketId === null) return result
  const { tags, specOpTags, basketId } = resolveKnexListTags(
    specOp,
    sourceTags,
    resolvedBasketId
  )
  if (specOp?.resultFromTags != null) {
    return specOp.resultFromTags(dsk, auth, vargs, specOpTags)
  }
  const tagIds = await findKnexTagIds(k, userId, tags)
  const isQueryModeAll = vargs.tagQueryMode === 'all'
  if (knexTagQueryCannotMatch(tags, tagIds, isQueryModeAll)) return result
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
  if (vargs.includeLockingScripts || specOp?.includeOutputScripts) {
    columns = [...columns, 'lockingScript', 'scriptLength', 'scriptOffset']
  }
  const includeSpent = specOp?.includeSpent ?? false
  const outputColumns = columns.map(c => `o.${c} as ${c}`)
  const baseQuery = createKnexOutputQuery(
    k,
    userId,
    basketId,
    includeSpent,
    specOp?.managedChangeOnly === true,
    tagIds,
    isQueryModeAll
  )
  if (specOp?.totalOutputsIsSumOfSatoshis) {
    baseQuery.sum('o.satoshis as totalSatoshis')
    const sum = await baseQuery.first()
    result.totalOutputs = Number(sum?.totalSatoshis ?? 0)
    return result
  }
  const qcount = baseQuery
    .clone()
    .clearSelect()
    .clearOrder()
    .count('o.outputId as total')
  baseQuery.select(outputColumns)
  if (!specOp?.ignoreLimit) baseQuery.limit(limit).offset(offset)
  baseQuery.orderBy('o.outputId', orderBy)
  let outputs: TableOutput[] = await baseQuery
  if (specOp != null) {
    if (specOp.filterOutputs != null) {
      outputs = await specOp.filterOutputs(
        dsk,
        auth,
        vargs,
        specOpTags,
        outputs
      )
    }
    if (specOp.resultFromOutputs != null) {
      return specOp.resultFromOutputs(dsk, auth, vargs, specOpTags, outputs)
    }
  }
  if (!limit || outputs.length < limit) {
    result.totalOutputs = outputs.length
  } else {
    const total = verifyOne(
      (await qcount) as Array<{ total: number | string }>
    ).total
    result.totalOutputs = Number(total)
  }
  const { labelsByTransactionId, tagsByOutputId } =
    await loadKnexOutputAssociations(
      k,
      outputs,
      vargs.includeLabels,
      vargs.includeTags
    )
  const beef = new Beef()
  for (const output of outputs) {
    result.outputs.push(
      await hydrateKnexWalletOutput(
        dsk,
        output,
        vargs,
        labelsByTransactionId,
        tagsByOutputId,
        beef,
        trx
      )
    )
  }
  if (vargs.includeTransactions) result.BEEF = beef.toBinary()
  return result
}
