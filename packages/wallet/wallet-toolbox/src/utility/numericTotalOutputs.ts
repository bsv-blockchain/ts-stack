import type { ListOutputsResult } from '@bsv/sdk'
import { WERR_INTERNAL } from '../sdk/WERR_errors'

/**
 * A numeric `listOutputs` `totalOutputs`: an output count or a BRC-112/special-operation
 * balance summary. Ordinary counts and supported balance queries retain numeric results.
 */
export function numericTotalOutputs(result: Pick<ListOutputsResult, 'totalOutputs'>): number {
  if (typeof result.totalOutputs !== 'number') {
    throw new WERR_INTERNAL('listOutputs returned BRC-112 decimal text where a number was expected')
  }
  return result.totalOutputs
}
