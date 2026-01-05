import { ListOutputsResult, Validation } from '@bsv/sdk'
import { StorageProvider } from '../StorageProvider'
import { AuthId } from '../../sdk/WalletStorage.interfaces'
import { TableOutput } from '../schema/tables/TableOutput'
import { specOpInvalidChange, specOpSetWalletChangeParams, specOpWalletBalance } from '../../sdk/types'
import { verifyId, verifyInteger, verifyOne } from '../../utility/utilityHelpers'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

export interface ListOutputsSpecOp {
  name: string
  useBasket?: string
  ignoreLimit?: boolean
  includeOutputScripts?: boolean
  includeSpent?: boolean
  totalOutputsIsSumOfSatoshis?: boolean
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

const getBasketToSpecOp: () => Record<string, ListOutputsSpecOp> = () => {
  return {
    [specOpWalletBalance]: {
      name: 'totalOutputsIsWalletBalance',
      useBasket: 'default',
      ignoreLimit: true,
      /**
       * To support maximum performance optimization, computing balance is done in the query itself.
       */
      totalOutputsIsSumOfSatoshis: true,
      /* This alternative computes total from outputs returned by query.
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
      */
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
        const filteredOutputs: TableOutput[] = []
        const services = s.getServices()
        for (const o of outputs) {
          if (!o.basketId) continue // only care about outputs assigned to baskets.
          await s.validateOutputScript(o)
          let ok: boolean | undefined = false
          if (o.lockingScript && o.lockingScript.length > 0) {
            ok = await services.isUtxo(o)
          } else {
            ok = undefined
          }
          if (ok === false) {
            filteredOutputs.push(o)
          }
        }
        if (specOpTags.indexOf('release') >= 0) {
          for (const o of filteredOutputs) {
            await s.updateOutput(o.outputId, { spendable: false })
            o.spendable = false
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
        if (specOpTags.length !== 2)
          throw new WERR_INVALID_PARAMETER('numberOfDesiredUTXOs and minimumDesiredUTXOValue', 'valid')
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

let _basketSpecOps: Record<string, ListOutputsSpecOp> | undefined = undefined
let _tagSpecOps: Record<string, ListOutputsSpecOp> | undefined = undefined

/**
 * Check basket and tags arguments passed to listOutputs to determine if they trigger a special operation execution mode.
 * @param basket 
 * @param tags 
 * @returns 
 */
export function getListOutputsSpecOp(basket: string, tags: string[]): { specOp: ListOutputsSpecOp | undefined, basket?: string, tags: string[] } {
  let specOp: ListOutputsSpecOp | undefined
  if (basket) {
    if (_basketSpecOps === undefined) {
      _basketSpecOps = getBasketToSpecOp()
    }
    specOp = _basketSpecOps[basket]
    if (specOp) {
      return { specOp, basket: specOp.useBasket, tags: tags || []}
    }
  }
  if (tags) {
    if (_tagSpecOps === undefined) {
      _tagSpecOps = getTagToSpecOp()
    }
    for (const tag of tags) {
      specOp = _tagSpecOps[tag]
      if (specOp) {
        if (!basket && specOp.useBasket) basket = specOp.useBasket
        return { specOp, basket, tags: tags.filter(t => t !== tag) }
      }
    }
  }
  return { specOp: undefined, basket, tags }
}
