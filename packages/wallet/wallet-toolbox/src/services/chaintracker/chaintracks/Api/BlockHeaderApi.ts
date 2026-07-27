import type { BaseBlockHeader, BlockHeader } from '../../../../sdk/WalletServices.interfaces'

export type { BaseBlockHeader, BlockHeader } from '../../../../sdk/WalletServices.interfaces'

/**
 * The "live" portion of the block chain is recent history that can conceivably be subject to reorganizations.
 * The additional fields support tracking orphan blocks, chain forks, and chain reorgs.
 */
export interface LiveBlockHeader extends BlockHeader {
  /**
   * The cumulative chainwork achieved by the addition of this block to the chain.
   * Chainwork only matters in selecting the active chain.
   */
  chainWork: string
  /**
   * True only if this header is currently a chain tip. e.g. There is no header that follows it by previousHash or previousHeaderId.
   */
  isChainTip: boolean
  /**
   * True only if this header is currently on the active chain.
   */
  isActive: boolean
  /**
   * As there may be more than one header with identical height values due to orphan tracking,
   * headers are assigned a unique headerId while part of the "live" portion of the block chain.
   */
  headerId: number
  /**
   * Every header in the "live" portion of the block chain is linked to an ancestor header through
   * both its previousHash and previousHeaderId properties.
   *
   * Due to forks, there may be multiple headers with identical `previousHash` and `previousHeaderId` values.
   * Of these, only one (the header on the active chain) will have `isActive` === true.
   */
  previousHeaderId: number | null
}

//
// TYPE GUARDS
//

/**
 * Type guard function.
 * @publicbody
 */
function isHeaderLike(header: unknown): header is Record<string, unknown> {
  return header !== null && typeof header === 'object'
}

export function isLive(header: unknown): header is LiveBlockHeader {
  return isHeaderLike(header) && header.headerId !== undefined
}

/** Union of all block header variants */
export type AnyBlockHeader = BaseBlockHeader | BlockHeader | LiveBlockHeader

/**
 * Type guard function.
 * @publicbody
 */
export function isBaseBlockHeader(header: unknown): header is BaseBlockHeader {
  return isHeaderLike(header) && typeof header.previousHash === 'string'
}

/**
 * Type guard function.
 * @publicbody
 */
export function isBlockHeader(header: unknown): header is BlockHeader {
  return (
    isHeaderLike(header) && 'height' in header && typeof header.previousHash === 'string'
  )
}

/**
 * Type guard function.
 * @publicbody
 */
export function isLiveBlockHeader(header: unknown): header is LiveBlockHeader {
  return (
    isHeaderLike(header) && 'chainWork' in header && typeof header.previousHash === 'string'
  )
}
