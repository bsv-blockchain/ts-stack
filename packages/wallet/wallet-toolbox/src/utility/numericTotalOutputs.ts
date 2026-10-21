import type { ListOutputsResult } from '@bsv/sdk'
import { WERR_INTERNAL } from '../sdk/WERR_errors'

/**
 * A `listOutputs` `totalOutputs` as a number: an output count, or a special operation's
 * satoshi sum. Only a BRC-112 module balance query returns decimal text there.
 */
export function numericTotalOutputs(result: Pick<ListOutputsResult, 'totalOutputs'>): number {
  if (typeof result.totalOutputs !== 'number') {
    throw new WERR_INTERNAL('listOutputs returned BRC-112 decimal text where a number was expected')
  }
  return result.totalOutputs
}
