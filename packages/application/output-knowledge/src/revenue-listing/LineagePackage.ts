import {
  Beef,
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputHex32,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputOutpoint,
  verifyOutputPacket,
  type OutputOutpoint,
  type Transaction
} from '@bsv/sdk'
import {
  parseRevenueListingDescriptor,
  revenueListingId,
  type RevenueListingDescriptor
} from '@bsv/sdk/script/templates/RevenueListing'

export interface RevenueListingLineagePackage {
  version: 1
  descriptor: RevenueListingDescriptor
  genesis: {
    body: { version: 1; listingId: string; genesis: OutputOutpoint }
    signature: string
  }
  target: OutputOutpoint
  transactions: { txid: string; beef: string }[]
}

export interface RevenueListingLineageLimits {
  bytes: number
  listingTransactions: number
  transactions: number
  inputs: number
  scriptMemoryBytes: number
  timeoutMs: number
  concurrentRequests: number
}

/** Local maxima; an installed caller may reduce them, never enlarge this profile. */
export const REVENUE_LISTING_LINEAGE_LIMITS: Readonly<RevenueListingLineageLimits> = Object.freeze({
  bytes: 2097152,
  listingTransactions: 256,
  transactions: 4096,
  inputs: 16384,
  scriptMemoryBytes: 134217728,
  timeoutMs: 60000,
  concurrentRequests: 4
})

export function requireLineage(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new OutputProtocolError('invalid', reason)
}

export function lineageLimits(
  overrides: Partial<RevenueListingLineageLimits>
): Readonly<RevenueListingLineageLimits> {
  const result = { ...REVENUE_LISTING_LINEAGE_LIMITS, ...overrides }
  for (const [key, value] of Object.entries(result)) {
    const maximum = Object.hasOwn(REVENUE_LISTING_LINEAGE_LIMITS, key)
      ? REVENUE_LISTING_LINEAGE_LIMITS[key as keyof RevenueListingLineageLimits]
      : 0
    requireLineage(
      Number.isSafeInteger(value) && value > 0 && value <= maximum,
      'Invalid lineage limit'
    )
  }
  return Object.freeze(result)
}

/** Bounded, owned schema and genesis authorization; no Bitcoin or ancestry verdict. */
export function parseRevenueListingLineagePackage(
  input: unknown,
  limits: Partial<RevenueListingLineageLimits> = {}
): RevenueListingLineagePackage {
  const policy = lineageLimits(limits)
  const value = parseOutputJSON(
    typeof input === 'string' || input instanceof Uint8Array
      ? input
      : canonicalOutputJSON(input, { bytes: policy.bytes }),
    { bytes: policy.bytes }
  )
  closedOutputObject(value, ['version', 'descriptor', 'genesis', 'target', 'transactions'])
  requireLineage(value.version === 1, 'Unknown lineage package version')
  const descriptor = parseRevenueListingDescriptor(value.descriptor)
  closedOutputObject(value.genesis, ['body', 'signature'])
  closedOutputObject(value.genesis.body, ['version', 'listingId', 'genesis'])
  const body = value.genesis.body
  requireLineage(body.version === 1, 'Unknown genesis version')
  const listingId = outputHex32(body.listingId)
  requireLineage(listingId === revenueListingId(descriptor), 'Genesis descriptor mismatch')
  const genesis = parseOutputOutpoint(body.genesis),
    target = parseOutputOutpoint(value.target)
  for (const point of [genesis, target])
    requireLineage(
      canonicalOutputJSON(point.chain) === canonicalOutputJSON(descriptor.chain),
      'Lineage chain mismatch'
    )
  requireLineage(genesis.outputIndex === 0, 'Genesis must be output zero')
  const signature = value.genesis.signature
  requireLineage(typeof signature === 'string', 'Invalid genesis signature')
  const packet = { body: { version: 1 as const, listingId, genesis }, signature }
  requireLineage(
    verifyOutputPacket('sale-genesis', packet, descriptor.seller),
    'Genesis authorization failed'
  )
  requireLineage(Array.isArray(value.transactions), 'Invalid lineage transactions')
  if (value.transactions.length > policy.listingTransactions)
    throw new OutputProtocolError('limited', 'Lineage transaction limit')
  requireLineage(value.transactions.length > 0, 'Empty lineage package')
  let previous = ''
  const transactions = value.transactions.map(entry => {
    closedOutputObject(entry, ['txid', 'beef'])
    const txid = outputHex32(entry.txid)
    requireLineage(txid > previous, 'Lineage transactions must be sorted and unique')
    previous = txid
    decodeOutputBytes(entry.beef, policy.bytes)
    return { txid, beef: entry.beef as string }
  })
  return {
    version: 1,
    descriptor,
    genesis: { body: packet.body, signature: packet.signature },
    target,
    transactions
  }
}

export interface LineageAssembly {
  package: RevenueListingLineagePackage
  beef: Beef
  transactions: Map<string, Transaction>
  entries: Set<string>
}

/** Collect every binding before resolving paths. Entry order is never dependency order. */
export function assembleLineage(
  input: RevenueListingLineagePackage,
  limits: Readonly<RevenueListingLineageLimits>
): LineageAssembly {
  const beef = new Beef(),
    transactions = new Map<string, Transaction>(),
    entries = new Set<string>()
  let inputs = 0
  for (const entry of input.transactions) {
    const part = Beef.fromBinaryStrict(decodeOutputBytes(entry.beef, limits.bytes))
    requireLineage(
      (part.atomicTxid ?? part.txs.at(-1)?.txid) === entry.txid,
      'BEEF target mismatch'
    )
    const seen = new Set<string>()
    for (const item of part.txs) {
      requireLineage(!seen.has(item.txid), 'Duplicate BEEF transaction')
      seen.add(item.txid)
      const tx = item.tx
      if (tx === undefined) continue
      requireLineage(tx.id('hex') === item.txid, 'BEEF raw transaction mismatch')
      if (!transactions.has(item.txid)) {
        inputs += tx.inputs.length
        transactions.set(item.txid, tx)
      }
      if (inputs > limits.inputs || transactions.size > limits.transactions)
        throw new OutputProtocolError('limited', 'Lineage dependency limit')
    }
    requireLineage(part.findTxid(entry.txid)?.tx !== undefined, 'BEEF target raw bytes required')
    beef.mergeBeef(part)
    if (beef.txs.length > limits.transactions)
      throw new OutputProtocolError('limited', 'Lineage dependency limit')
    entries.add(entry.txid)
  }
  // Parsing/merging carries no trust. Bitcoin verification uses this owned union.
  return { package: input, beef, transactions, entries }
}
