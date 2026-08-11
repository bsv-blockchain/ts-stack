import { ListOutputsResult, Validation } from '@bsv/sdk'
import { StorageProvider } from '../StorageProvider'
import { AuthId } from '../../sdk/WalletStorage.interfaces'
import { TableOutput } from '../schema/tables/TableOutput'
import {
  specOpInvalidChange,
  specOpSetWalletChangeParams,
  specOpWalletBalance,
  specOpWalletManagedUtxos
} from '../../sdk/types'
import { verifyId, verifyInteger, verifyOne } from '../../utility/utilityHelpers'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import {
  classifyOutputUtxo,
  mapWithConcurrency,
  type OutputUtxoClassification,
  UTXO_PROVIDER_MAX_CONCURRENCY
} from '../../services/classifyOutputUtxo'

export interface ListOutputsSpecOp {
  name: string
  useBasket?: string
  ignoreLimit?: boolean
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
    vargs: Validation.ValidListOutputsArgs,
    specOpTags: string[]
  ) => Promise<ListOutputsResult>
  resultFromOutputs?: (
    s: StorageProvider,
    auth: AuthId,
    vargs: Validation.ValidListOutputsArgs,
    specOpTags: string[],
    outputs: TableOutput[]
  ) => Promise<ListOutputsResult>
  filterOutputs?: (
    s: StorageProvider,
    auth: AuthId,
    vargs: Validation.ValidListOutputsArgs,
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

const INVALID_CHANGE_MAX_AUDIT_PROVIDERS = 8
const INVALID_CHANGE_MAX_PROVIDER_NAME_LENGTH = 128

interface InvalidChangeClassification {
  output: TableOutput
  status: OutputUtxoClassification
}

function invalidChangeAuditDetails(
  classifications: InvalidChangeClassification[],
  released: number,
  userId: number | undefined,
  reason: 'inconclusive-provider-result' | 'provider-confirmed-spent'
): string {
  const allProviders = [
    ...new Set(
      classifications.map(result =>
        result.status.provider.slice(0, INVALID_CHANGE_MAX_PROVIDER_NAME_LENGTH)
      )
    )
  ]
  const providers = allProviders.slice(0, INVALID_CHANGE_MAX_AUDIT_PROVIDERS)
  const confirmedSpent = classifications.filter(result => result.status.verdict === 'spent')
  return JSON.stringify({
    operation: 'specOpInvalidChange',
    reason,
    userId,
    checked: classifications.length,
    confirmedUnspent: classifications.filter(result => result.status.verdict === 'unspent').length,
    confirmedSpent: confirmedSpent.length,
    unknown: classifications.filter(result => result.status.verdict === 'unknown').length,
    confirmedSpentSatoshis: confirmedSpent.reduce((sum, result) => sum + result.output.satoshis, 0),
    released,
    providers,
    providerCount: allProviders.length,
    providersTruncated: allProviders.length > providers.length
  })
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
        vargs: Validation.ValidListOutputsArgs,
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
      includeOutputScripts: true,
      includeSpent: false,
      tagsToIntercept: ['release', 'all'],
      filterOutputs: async (
        s: StorageProvider,
        auth: AuthId,
        vargs: Validation.ValidListOutputsArgs,
        specOpTags: string[],
        outputs: TableOutput[]
      ): Promise<TableOutput[]> => {
        const services = s.getServices()
        const candidates = outputs.filter(output => output.basketId != null)
        const classifications = await mapWithConcurrency(candidates, UTXO_PROVIDER_MAX_CONCURRENCY, async output => {
          try {
            await s.validateOutputScript(output)
          } catch (error: unknown) {
            return {
              output,
              status: {
                verdict: 'unknown' as const,
                provider: '<script-validation-error>',
                error
              }
            }
          }
          return {
            output,
            status: await classifyOutputUtxo(services, output)
          }
        })
        const unknown = classifications.filter(result => result.status.verdict === 'unknown')
        const release = specOpTags.includes('release')
        if (unknown.length > 0) {
          if (release) {
            const now = new Date()
            await s.insertMonitorEvent({
              created_at: now,
              updated_at: now,
              id: 0,
              event: 'InvalidChangeReleaseBlocked',
              details: invalidChangeAuditDetails(
                classifications,
                0,
                auth.userId,
                'inconclusive-provider-result'
              )
            })
          }
          throw new WERR_INVALID_OPERATION(
            `UTXO review was inconclusive for ${unknown.length} of ${classifications.length} candidates; no outputs were changed.`
          )
        }

        const filteredOutputs = classifications
          .filter(result => result.status.verdict === 'spent')
          .map(result => result.output)
        if (release) {
          const releasedOutputIds = new Set<number>()
          await s.transaction(async trx => {
            for (const output of filteredOutputs) {
              const current = await s.findOutputById(output.outputId, trx, true)
              if (current == null || current.userId !== auth.userId) {
                throw new WERR_INVALID_PARAMETER('outputId', `owned by user ${auth.userId}`)
              }
              if (current.spendable !== true || current.spentBy != null) {
                throw new WERR_INVALID_OPERATION(
                  `Output ${output.outputId} changed state during UTXO review; no outputs were changed.`
                )
              }
              const updated = await s.updateOutput(output.outputId, { spendable: false }, trx)
              if (updated !== 1) {
                throw new WERR_INVALID_PARAMETER('outputId', `updated exactly once: ${output.outputId}`)
              }
              releasedOutputIds.add(output.outputId)
            }
            const now = new Date()
            await s.insertMonitorEvent(
              {
                created_at: now,
                updated_at: now,
                id: 0,
                event: 'InvalidChangeRelease',
                details: invalidChangeAuditDetails(
                  classifications,
                  releasedOutputIds.size,
                  auth.userId,
                  'provider-confirmed-spent'
                )
              },
              trx
            )
          })
          for (const output of filteredOutputs) {
            if (releasedOutputIds.has(output.outputId)) output.spendable = false
          }
        }
        return filteredOutputs
      }
    },
    [specOpSetWalletChangeParams]: {
      name: 'setWalletChangeParams',
      tagsParamsCount: 2,
      resultFromTags: async (
        s: StorageProvider,
        auth: AuthId,
        vargs: Validation.ValidListOutputsArgs,
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
        vargs: Validation.ValidListOutputsArgs,
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
