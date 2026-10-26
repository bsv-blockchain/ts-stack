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

type DataProperties = Record<string, PropertyDescriptor>

function dataProperties(value: unknown): DataProperties | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).length > 64 || Object.values(descriptors).some(d => d.get != null || d.set != null)) {
      return undefined
    }
    return descriptors
  } catch {
    return undefined
  }
}

function valueOf(properties: DataProperties, name: string): unknown {
  const property = properties[name]
  return property != null && Object.prototype.hasOwnProperty.call(property, 'value') ? property.value : undefined
}

function isUint32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff
}

function isHeight(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0x7fffffff
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
}

function hasBaseHeaderShape(properties: DataProperties): boolean {
  return (
    isUint32(valueOf(properties, 'version')) &&
    isHash(valueOf(properties, 'previousHash')) &&
    isHash(valueOf(properties, 'merkleRoot')) &&
    isUint32(valueOf(properties, 'time')) &&
    isUint32(valueOf(properties, 'bits')) &&
    isUint32(valueOf(properties, 'nonce'))
  )
}

/**
 * Type guard function.
 * @publicbody
 */
export function isLive(header: BlockHeader | LiveBlockHeader): header is LiveBlockHeader {
  return isLiveBlockHeader(header)
}

/** Union of all block header variants */
export type AnyBlockHeader = BaseBlockHeader | BlockHeader | LiveBlockHeader

/**
 * Type guard function.
 * @publicbody
 */
export function isBaseBlockHeader(header: AnyBlockHeader): header is BaseBlockHeader {
  const properties = dataProperties(header)
  return properties != null && hasBaseHeaderShape(properties)
}

/**
 * Type guard function.
 * @publicbody
 */
export function isBlockHeader(header: AnyBlockHeader): header is BlockHeader {
  const properties = dataProperties(header)
  return (
    properties != null &&
    hasBaseHeaderShape(properties) &&
    isHeight(valueOf(properties, 'height')) &&
    isHash(valueOf(properties, 'hash'))
  )
}

/**
 * Type guard function.
 * @publicbody
 */
export function isLiveBlockHeader(header: AnyBlockHeader): header is LiveBlockHeader {
  const properties = dataProperties(header)
  const headerId = properties == null ? undefined : valueOf(properties, 'headerId')
  const previousHeaderId = properties == null ? undefined : valueOf(properties, 'previousHeaderId')
  return (
    properties != null &&
    hasBaseHeaderShape(properties) &&
    isHeight(valueOf(properties, 'height')) &&
    isHash(valueOf(properties, 'hash')) &&
    isHash(valueOf(properties, 'chainWork')) &&
    Number.isSafeInteger(headerId) &&
    (headerId as number) >= 1 &&
    (previousHeaderId === null || (Number.isSafeInteger(previousHeaderId) && (previousHeaderId as number) >= 1)) &&
    typeof valueOf(properties, 'isActive') === 'boolean' &&
    typeof valueOf(properties, 'isChainTip') === 'boolean'
  )
}
