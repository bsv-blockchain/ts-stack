import type { ListOutputsResult } from '@bsv/sdk'
import { WERR_INTERNAL } from '../sdk/WERR_errors'

/**
 * The `totalOutputs` of an ordinary `listOutputs` result. Only a BRC-112 module
 * balance query returns decimal text there, and that is a balance, not a count.
 */
export function listOutputsCount(result: Pick<ListOutputsResult, 'totalOutputs'>): number {
  if (typeof result.totalOutputs !== 'number') {
    throw new WERR_INTERNAL('listOutputs returned a module balance where an output count was expected')
  }
  return result.totalOutputs
}
