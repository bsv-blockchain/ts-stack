import { Beef, ListOutputsResult, OriginatorDomainNameStringUnder250Bytes, WalletOutput, Validation } from '@bsv/sdk'
import { getListOutputsSpecOp, type ListOutputsSpecOp } from './ListOutputsSpecOp'
import { StorageIdb } from '../StorageIdb'
import { AuthId, FindOutputsArgs } from '../../sdk/WalletStorage.interfaces'
import { verifyId } from '../../utility/utilityHelpers'
import { TableOutput } from '../schema/tables/TableOutput'
import { TransactionStatus } from '../../sdk/types'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { isManagedChangeOutput, managedChangeOutputFields } from './managedChange'

interface ResolvedListTags {
  tags: string[]
  specOpTags: string[]
  basketId?: number
}

function normalizeListOffset(offset: number): {
  offset: number
  orderDescending: boolean
} {
  return offset < 0
    ? { offset: -offset - 1, orderDescending: true }
    : { offset, orderDescending: false }
}

async function resolveIdbBasketId(
  storage: StorageIdb,
  userId: number,
  basket: string | undefined
): Promise<number | null | undefined> {
  if (basket == null || basket === '') return undefined
  const baskets = await storage.findOutputBaskets({
    partial: { userId, name: basket }
  })
  return baskets.length === 1 ? baskets[0].basketId : null
}

function resolveListTags(
  specOp: ListOutputsSpecOp | undefined,
  sourceTags: string[],
  initialBasketId: number | undefined
): ResolvedListTags {
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

async function findIdbTagIds(
  storage: StorageIdb,
  userId: number,
  tags: string[]
): Promise<number[]> {
  const tagIds: number[] = []
  if (tags.length === 0) return tagIds
  await storage.filterOutputTags(
    { partial: { userId, isDeleted: false } },
    outputTag => {
      if (tags.includes(outputTag.tag)) tagIds.push(outputTag.outputTagId)
    }
  )
  return tagIds
}

function tagQueryCannotMatch(
  tags: string[],
  tagIds: number[],
  queryModeAll: boolean
): boolean {
  return queryModeAll
    ? tagIds.length < tags.length
    : tags.length > 0 && tagIds.length === 0
}

async function loadIdbOutputs(
  storage: StorageIdb,
  userId: number,
  basketId: number | undefined,
  tagIds: number[],
  queryModeAll: boolean,
  specOp: ListOutputsSpecOp | undefined,
  limit: number,
  offset: number,
  orderDescending: boolean
): Promise<{ outputs: TableOutput[]; totalOutputs: number }> {
  const args: FindOutputsArgs = {
    partial: {
      userId,
      basketId,
      spendable: true,
      ...(specOp?.managedChangeOnly ? managedChangeOutputFields : {})
    },
    txStatus: ['completed', 'unproven', 'nosend', 'sending'] as TransactionStatus[],
    noScript: true,
    orderDescending
  }
  const pageManagedChange =
    specOp?.managedChangeOnly === true && specOp.ignoreLimit !== true
  if (!specOp?.ignoreLimit && !pageManagedChange) {
    args.paged = { limit, offset }
  }
  let outputs = await storage.findOutputs(args, tagIds, queryModeAll)
  if (specOp?.managedChangeOnly) {
    outputs = outputs.filter(
      output => isManagedChangeOutput(output) && output.spentBy == null
    )
  }
  if (pageManagedChange) {
    const totalManagedOutputs = outputs.length
    outputs = outputs.slice(offset, offset + limit)
    return {
      outputs,
      totalOutputs:
        outputs.length === limit ? totalManagedOutputs : outputs.length
    }
  }
  if (outputs.length !== limit) {
    return { outputs, totalOutputs: outputs.length }
  }
  args.paged = undefined
  return {
    outputs,
    totalOutputs: await storage.countOutputs(args, tagIds, queryModeAll)
  }
}

async function hydrateIdbWalletOutput(
  storage: StorageIdb,
  output: TableOutput,
  vargs: Validation.ValidListOutputsArgs,
  labelsByTxid: Record<string, string[]>,
  beef: Beef
): Promise<WalletOutput> {
  const walletOutput: WalletOutput = {
    satoshis: Number(output.satoshis),
    spendable: !!output.spendable,
    outpoint: `${output.txid}.${output.vout}`
  }
  if (vargs.includeCustomInstructions && output.customInstructions) {
    walletOutput.customInstructions = output.customInstructions
  }
  if (vargs.includeLabels && output.txid) {
    labelsByTxid[output.txid] ??= (
      await storage.getLabelsForTransactionId(output.transactionId)
    ).map(label => label.label)
    walletOutput.labels = labelsByTxid[output.txid]
  }
  if (vargs.includeTags) {
    walletOutput.tags = (
      await storage.getTagsForOutputId(output.outputId)
    ).map(tag => tag.tag)
  }
  if (vargs.includeLockingScripts) {
    await storage.validateOutputScript(output)
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
      vargs.knownTxids
    )
  }
  return walletOutput
}

async function hydrateIdbOutputResult(
  storage: StorageIdb,
  outputs: TableOutput[],
  vargs: Validation.ValidListOutputsArgs,
  result: ListOutputsResult
): Promise<void> {
  const labelsByTxid: Record<string, string[]> = {}
  const beef = new Beef()
  for (const output of outputs) {
    result.outputs.push(
      await hydrateIdbWalletOutput(storage, output, vargs, labelsByTxid, beef)
    )
  }
  if (vargs.includeTransactions) result.BEEF = beef.toBinary()
}

export async function listOutputsIdb(
  storage: StorageIdb,
  auth: AuthId,
  vargs: Validation.ValidListOutputsArgs,
  _originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<ListOutputsResult> {
  const userId = verifyId(auth.userId)
  const limit = vargs.limit
  const { offset, orderDescending } = normalizeListOffset(vargs.offset)
  const result: ListOutputsResult = { totalOutputs: 0, outputs: [] }
  const { specOp, basket, tags: sourceTags } = getListOutputsSpecOp(
    vargs.basket,
    vargs.tags
  )
  const resolvedBasketId = await resolveIdbBasketId(storage, userId, basket)
  if (resolvedBasketId === null) return result
  const { tags, specOpTags, basketId } = resolveListTags(
    specOp,
    sourceTags,
    resolvedBasketId
  )
  if (specOp?.resultFromTags != null) {
    return specOp.resultFromTags(storage, auth, vargs, specOpTags)
  }
  const tagIds = await findIdbTagIds(storage, userId, tags)
  const isQueryModeAll = vargs.tagQueryMode === 'all'
  if (tagQueryCannotMatch(tags, tagIds, isQueryModeAll)) return result
  let { outputs, totalOutputs } = await loadIdbOutputs(
    storage,
    userId,
    basketId,
    tagIds,
    isQueryModeAll,
    specOp,
    limit,
    offset,
    orderDescending
  )
  result.totalOutputs = totalOutputs
  if (specOp != null) {
    if (specOp.filterOutputs != null) {
      outputs = await specOp.filterOutputs(
        storage,
        auth,
        vargs,
        specOpTags,
        outputs
      )
    }
    if (specOp.resultFromOutputs != null) {
      return specOp.resultFromOutputs(storage, auth, vargs, specOpTags, outputs)
    }
  }
  await hydrateIdbOutputResult(storage, outputs, vargs, result)
  return result
}
