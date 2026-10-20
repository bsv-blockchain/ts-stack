import { type ValidListOutputsArgs } from '@bsv/sdk/wallet/validationHelpers'
import { Beef, ListOutputsResult, WalletOutput } from '@bsv/sdk'
import { StorageProvider } from '../StorageProvider'
import { AuthId } from '../../sdk/WalletStorage.interfaces'
import { TableOutput } from '../schema/tables/TableOutput'
import {
  specOpBasketPrefixOutputs,
  specOpInvalidChange,
  specOpSetWalletChangeParams,
  specOpWalletBalance,
  specOpWalletManagedUtxos,
  TransactionStatus
} from '../../sdk/types'
import { verifyId, verifyInteger, verifyOne } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { MAX_UTXO_REVIEW_CANDIDATES, reviewUtxoOutputs } from './reviewUtxoOutputs'

/** Statuses of a signed transaction whose outputs the basket-prefix operation lists. */
const LISTED_OUTPUT_TX_STATUSES: TransactionStatus[] = ['completed', 'unproven', 'nosend', 'sending', 'unprocessed']

/** Statuses of a spending action under which its inputs are reserved rather than spent. */
const RESERVING_TX_STATUSES: TransactionStatus[] = ['unsigned', 'unprocessed', 'nosend', 'sending']

function byOutpoint(a: TableOutput, b: TableOutput): number {
  if (a.txid === b.txid) return a.vout - b.vout
  return (a.txid ?? '') < (b.txid ?? '') ? -1 : 1
}

async function hydrateBasketPrefixOutput(
  s: StorageProvider,
  output: TableOutput,
  vargs: ValidListOutputsArgs,
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
  if (vargs.includeLabels) {
    walletOutput.labels = (await s.getLabelsForTransactionId(output.transactionId)).map(label => label.label)
  }
  if (vargs.includeTags) {
    walletOutput.tags = (await s.getTagsForOutputId(output.outputId)).map(tag => tag.tag)
  }
  if (vargs.includeLockingScripts) {
    await s.validateOutputScript(output)
    if (output.lockingScript != null) walletOutput.lockingScript = asString(output.lockingScript)
  }
  if (vargs.includeTransactions && output.txid != null && beef.findTxid(output.txid) == null) {
    await s.getValidBeefForKnownTxid(output.txid, beef, undefined, vargs.knownTxids)
  }
  return walletOutput
}

async function listBasketPrefixOutputs(
  s: StorageProvider,
  auth: AuthId,
  vargs: ValidListOutputsArgs,
  specOpTags: string[]
): Promise<ListOutputsResult> {
  const namespace = specOpTags[0]
  if (!namespace) throw new WERR_INVALID_PARAMETER('tags', 'a basket namespace as the first tag')
  const userId = verifyId(auth.userId)
  const basketIds = new Set(
    (await s.findOutputBaskets({ partial: { userId, isDeleted: false } }))
      .filter(basket => basket.name.startsWith(`${namespace} `))
      .map(basket => basket.basketId)
  )
  const noScript = !vargs.includeLockingScripts
  const unspent = await Promise.all(
    [...basketIds].map(
      async basketId =>
        await s.findOutputs({
          partial: { userId, basketId, spendable: true },
          txStatus: LISTED_OUTPUT_TX_STATUSES,
          noScript
        })
    )
  )
  const spenders = await s.findTransactions({
    partial: { userId },
    status: RESERVING_TX_STATUSES,
    noRawTx: true
  })
  const reserved = await Promise.all(
    spenders.map(
      async spender =>
        await s.findOutputs({
          partial: { userId, spentBy: spender.transactionId },
          txStatus: LISTED_OUTPUT_TX_STATUSES,
          noScript
        })
    )
  )
  const outputs: TableOutput[] = [
    ...unspent.flat(),
    ...reserved.flat().filter(output => output.basketId != null && basketIds.has(output.basketId))
  ]
  if (outputs.length > MAX_UTXO_REVIEW_CANDIDATES) {
    throw new WERR_INVALID_OPERATION(`basketPrefixOutputs is limited to ${MAX_UTXO_REVIEW_CANDIDATES} outputs.`)
  }
  outputs.sort(byOutpoint)
  const beef = new Beef()
  const result: ListOutputsResult = { totalOutputs: outputs.length, outputs: [] }
  // Outputs hydrate one at a time because they share the BEEF they add transactions to.
  await outputs.reduce<Promise<void>>(async (previous, output) => {
    await previous
    result.outputs.push(await hydrateBasketPrefixOutput(s, output, vargs, beef))
  }, Promise.resolve())
  if (vargs.includeTransactions) result.BEEF = beef.toBinary()
  return result
}

export interface ListOutputsSpecOp {
  name: string
  useBasket?: string
  ignoreLimit?: boolean
  /** Hard ceiling applied even when this operation intentionally ignores caller paging. */
  maximumCandidateCount?: number
  includeOutputScripts?: boolean
  includeSpent?: boolean
  /**
   * If true, and supported by storage, maximum performance optimization, computing balance done in the query itself.
   */
  totalOutputsIsSumOfSatoshis?: boolean
  /** Restrict the operation to wallet-managed, BRC-29-signable change. */
  managedChangeOnly?: boolean
  resultFromTags?: (
    s: StorageProvider,
    auth: AuthId,
    vargs: ValidListOutputsArgs,
    specOpTags: string[]
  ) => Promise<ListOutputsResult>
  resultFromOutputs?: (
    s: StorageProvider,
    auth: AuthId,
    vargs: ValidListOutputsArgs,
    specOpTags: string[],
    outputs: TableOutput[]
  ) => Promise<ListOutputsResult>
  filterOutputs?: (
    s: StorageProvider,
    auth: AuthId,
    vargs: ValidListOutputsArgs,
    specOpTags: string[],
    outputs: TableOutput[]
  ) => Promise<TableOutput[]>
  /**
   * undefined to intercept no tags from vargs,
   * empty array to intercept all tags,
   * or an explicit array of tags to intercept.
   */
  tagsToIntercept?: string[]
  /**
   * How many positional tags to intercept.
   */
  tagsParamsCount?: number
}

const getBasketToSpecOp: () => Record<string, ListOutputsSpecOp> = () => {
  return {
    [specOpWalletBalance]: {
      name: 'totalOutputsIsWalletBalance',
      useBasket: 'default',
      ignoreLimit: true,
      totalOutputsIsSumOfSatoshis: true,
      managedChangeOnly: true,
      resultFromOutputs: async (
        s: StorageProvider,
        auth: AuthId,
        vargs: ValidListOutputsArgs,
        specOpTags: string[],
        outputs: TableOutput[]
      ): Promise<ListOutputsResult> => {
        let totalOutputs = 0
        for (const o of outputs) totalOutputs += o.satoshis
        return { totalOutputs, outputs: [] }
      }
    },
    [specOpWalletManagedUtxos]: {
      name: 'walletManagedUtxos',
      useBasket: 'default',
      managedChangeOnly: true
    },
    [specOpInvalidChange]: {
      name: 'invalidChangeOutputs',
      useBasket: 'default',
      ignoreLimit: true,
      maximumCandidateCount: MAX_UTXO_REVIEW_CANDIDATES,
      includeOutputScripts: true,
      includeSpent: false,
      tagsToIntercept: ['release', 'all'],
      filterOutputs: async (
        s: StorageProvider,
        auth: AuthId,
        vargs: ValidListOutputsArgs,
        specOpTags: string[],
        outputs: TableOutput[]
      ): Promise<TableOutput[]> => {
        const release = specOpTags.includes('release')
        const review = await reviewUtxoOutputs(s, auth, outputs, release ? 'atomic' : 'none')
        return review.confirmedSpentOutputs
      }
    },
    [specOpSetWalletChangeParams]: {
      name: 'setWalletChangeParams',
      tagsParamsCount: 2,
      resultFromTags: async (
        s: StorageProvider,
        auth: AuthId,
        vargs: ValidListOutputsArgs,
        specOpTags: string[]
      ): Promise<ListOutputsResult> => {
        if (specOpTags.length !== 2) {
          throw new WERR_INVALID_PARAMETER('numberOfDesiredUTXOs and minimumDesiredUTXOValue', 'valid')
        }
        const numberOfDesiredUTXOs: number = verifyInteger(Number(specOpTags[0]))
        const minimumDesiredUTXOValue: number = verifyInteger(Number(specOpTags[1]))
        const basket = verifyOne(
          await s.findOutputBaskets({
            partial: { userId: verifyId(auth.userId), name: 'default' }
          })
        )
        await s.updateOutputBasket(basket.basketId, {
          numberOfDesiredUTXOs,
          minimumDesiredUTXOValue
        })
        return { totalOutputs: 0, outputs: [] }
      }
    },
    [specOpBasketPrefixOutputs]: {
      name: 'basketPrefixOutputs',
      tagsParamsCount: 1,
      resultFromTags: listBasketPrefixOutputs
    }
  }
}

const getTagToSpecOp: () => Record<string, ListOutputsSpecOp> = () => {
  return {
    [specOpWalletBalance]: {
      name: 'totalOutputsIsWalletBalance',
      useBasket: 'default',
      ignoreLimit: true,
      totalOutputsIsSumOfSatoshis: true,
      resultFromOutputs: async (
        s: StorageProvider,
        auth: AuthId,
        vargs: ValidListOutputsArgs,
        specOpTags: string[],
        outputs: TableOutput[]
      ): Promise<ListOutputsResult> => {
        let totalOutputs = 0
        for (const o of outputs) totalOutputs += o.satoshis
        return { totalOutputs, outputs: [] }
      }
    }
  }
}

let _basketSpecOps: Record<string, ListOutputsSpecOp> | undefined
let _tagSpecOps: Record<string, ListOutputsSpecOp> | undefined

function resolveBasketSpecOp(
  basket: string,
  tags: string[]
): { specOp: ListOutputsSpecOp; basket?: string; tags: string[] } | undefined {
  if (!basket) return undefined
  _basketSpecOps ??= getBasketToSpecOp()
  const specOp = _basketSpecOps[basket]
  return specOp === undefined ? undefined : { specOp, basket: specOp.useBasket, tags: tags || [] }
}

function resolveTagSpecOp(
  basket: string,
  tags: string[]
): { specOp: ListOutputsSpecOp; basket?: string; tags: string[] } | undefined {
  if (!tags) return undefined
  _tagSpecOps ??= getTagToSpecOp()
  for (const tag of tags) {
    const specOp = _tagSpecOps[tag]
    if (specOp === undefined) continue
    if (!basket && specOp.useBasket) basket = specOp.useBasket
    // The balance tag is also used to sum application baskets. Preserve
    // that behavior, while treating the default basket as wallet balance
    // and therefore restricting it to managed BRC-29 change.
    const resolvedSpecOp =
      specOp === _tagSpecOps[specOpWalletBalance] && basket === 'default'
        ? { ...specOp, managedChangeOnly: true }
        : specOp
    return { specOp: resolvedSpecOp, basket, tags: tags.filter(candidate => candidate !== tag) }
  }
  return undefined
}

/**
 * Check basket and tags arguments passed to listOutputs to determine if they trigger a special operation execution mode.
 * @param basket
 * @param tags
 * @returns
 */
export function getListOutputsSpecOp(
  basket: string,
  tags: string[]
): { specOp: ListOutputsSpecOp | undefined; basket?: string; tags: string[] } {
  return resolveBasketSpecOp(basket, tags) ?? resolveTagSpecOp(basket, tags) ?? { specOp: undefined, basket, tags }
}
