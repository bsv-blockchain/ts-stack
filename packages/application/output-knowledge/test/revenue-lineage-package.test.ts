import { afterEach, expect, it, jest } from '@jest/globals'
import {
  Beef,
  canonicalOutputJSON,
  OutputProtocolError,
  PrivateKey,
  signOutputPacket,
  Utils
} from '@bsv/sdk'
import { ATOMIC_BEEF, BEEF_V2 } from '@bsv/sdk/transaction/Beef'
import {
  assembleLineage,
  lineageLimits,
  parseRevenueListingLineagePackage,
  REVENUE_LISTING_LINEAGE_LIMITS
} from '../src/revenue-listing/LineagePackage.js'
import { completeGenesis, lineage, plainProvedEvidence } from './revenue-lineage-fixture.js'

afterEach(() => {
  jest.restoreAllMocks()
})

function genesisPackage() {
  const packet = structuredClone(lineage)
  packet.target = structuredClone(packet.genesis.body.genesis)
  packet.transactions = packet.transactions.filter(entry => entry.txid === packet.target.txid)
  return packet
}

it('owns object, UTF-8 and string envelopes and enforces the exact package byte limit', () => {
  const packet = genesisPackage()
  const json = canonicalOutputJSON(packet)
  const bytes = new TextEncoder().encode(json)
  for (const input of [packet, json, bytes]) {
    const parsed = parseRevenueListingLineagePackage(input, { bytes: bytes.length })
    expect(parsed).toEqual(packet)
    expect(parsed).not.toBe(packet)
    expect(parsed.descriptor).not.toBe(packet.descriptor)
    parsed.descriptor.initialRevenue.recipients[0].weight = 999
    expect(packet.descriptor.initialRevenue.recipients[0].weight).toBe(7)
    expect(() => parseRevenueListingLineagePackage(input, { bytes: bytes.length - 1 })).toThrow(
      'byte limit'
    )
  }
})

it('accepts every exact local maximum and refuses reductions outside positive integers', () => {
  expect(lineageLimits({})).toEqual({
    bytes: 2097152,
    listingTransactions: 256,
    transactions: 4096,
    inputs: 16384,
    scriptMemoryBytes: 134217728,
    timeoutMs: 60000,
    concurrentRequests: 4
  })
  expect(Object.isFrozen(lineageLimits({}))).toBe(true)
  for (const [key, maximum] of Object.entries(REVENUE_LISTING_LINEAGE_LIMITS)) {
    expect(lineageLimits({ [key]: 1 })[key as keyof typeof REVENUE_LISTING_LINEAGE_LIMITS]).toBe(1)
    for (const value of [0, -1, 1.5, maximum + 1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => lineageLimits({ [key]: value })).toThrow('Invalid lineage limit')
  }
})

it('rejects malformed authorization, outpoints, transaction entries and noncanonical BEEF bytes', () => {
  const packet = genesisPackage()
  const invalid: unknown[] = [
    { ...packet, genesis: { ...packet.genesis, signature: 1 } },
    { ...packet, genesis: { ...packet.genesis, body: { ...packet.genesis.body, version: 2 } } },
    {
      ...packet,
      genesis: { ...packet.genesis, body: { ...packet.genesis.body, listingId: '00'.repeat(32) } }
    },
    { ...packet, target: { ...packet.target, outputIndex: -1 } },
    { ...packet, transactions: null },
    { ...packet, transactions: [...packet.transactions, ...packet.transactions] },
    { ...packet, transactions: [{ ...packet.transactions[0], extra: true }] },
    { ...packet, transactions: [{ ...packet.transactions[0], txid: 'AB'.repeat(32) }] },
    { ...packet, transactions: [{ ...packet.transactions[0], beef: 'AA' }] }
  ]
  for (const input of invalid)
    expect(() => parseRevenueListingLineagePackage(input)).toThrow(OutputProtocolError)
  expect(() => parseRevenueListingLineagePackage(lineage, { listingTransactions: 7 })).toThrow(
    'Lineage transaction limit'
  )
  expect(parseRevenueListingLineagePackage(lineage, { listingTransactions: 8 })).toEqual(lineage)
})

it('counts the owned BEEF union once and applies exact transaction and input bounds', () => {
  const packet = parseRevenueListingLineagePackage(genesisPackage())
  const assembly = assembleLineage(packet, lineageLimits({}))
  const transactions = assembly.beef.txs.length
  const inputs = [...assembly.transactions.values()].reduce(
    (count, tx) => count + tx.inputs.length,
    0
  )
  expect(transactions).toBeGreaterThan(1)
  expect(inputs).toBeGreaterThan(1)
  expect(assembleLineage(packet, lineageLimits({ transactions, inputs })).entries.size).toBe(1)
  expect(() => assembleLineage(packet, lineageLimits({ transactions: transactions - 1 }))).toThrow(
    'Lineage dependency limit'
  )
  expect(() => assembleLineage(packet, lineageLimits({ inputs: inputs - 1 }))).toThrow(
    'Lineage dependency limit'
  )
})

it('requires each declared BEEF target raw transaction and its exact atomic identity', () => {
  const packet = genesisPackage()
  const part = Beef.fromBinaryStrict(Utils.toArray(packet.transactions[0].beef, 'base64'))
  const other = part.txs.find(item => item.txid !== packet.target.txid)!
  packet.transactions[0].beef = Utils.toBase64(part.toBinaryAtomic(other.txid))
  expect(() =>
    assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({}))
  ).toThrow('BEEF target mismatch')
  const only = new Beef()
  only.mergeTxidOnly(packet.target.txid)
  packet.transactions[0].beef = Utils.toBase64(only.toBinaryAtomic(packet.target.txid))
  expect(() =>
    assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({}))
  ).toThrow('BEEF target raw bytes required')
})

it('binds a declared plain BEEF entry to its exact present raw target independently of proof order', () => {
  const packet = genesisPackage(),
    part = Beef.fromBinaryStrict(Utils.toArray(packet.transactions[0].beef, 'base64')),
    tx = part.findTransactionForSigning(packet.target.txid)!,
    raw = tx.toHex()
  packet.transactions[0].beef = Utils.toBase64(plainProvedEvidence(part, packet.target.txid))
  const parsed = Beef.fromBinaryStrict(Utils.toArray(packet.transactions[0].beef, 'base64'))
  expect(parsed.atomicTxid).toBeUndefined()
  expect(parsed.txs.at(-1)!.txid).not.toBe(packet.target.txid)
  const assembly = assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({}))
  expect(assembly.transactions.get(packet.target.txid)!.toHex()).toBe(raw)
  // Assembly is bounded byte collection, never independent proof or lineage trust.
  const only = new Beef()
  only.mergeTxidOnly(packet.target.txid)
  packet.transactions[0].beef = Utils.toBase64(only.toBinary())
  expect(() =>
    assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({}))
  ).toThrow('BEEF target raw bytes required')
})

it('counts txid-only BEEF records against dependency capacity even without raw bytes', () => {
  const packet = genesisPackage()
  const part = Beef.fromBinaryStrict(Utils.toArray(packet.transactions[0].beef, 'base64'))
  const existing = part.txs.length
  part.mergeTxidOnly('aa'.repeat(32))
  part.version = BEEF_V2
  // Keep the extra record: normal atomic serialization deliberately prunes it.
  packet.transactions[0].beef = Utils.toBase64(
    new Utils.Writer()
      .writeUInt32LE(ATOMIC_BEEF)
      .write(Utils.toArray(packet.target.txid, 'hex').reverse())
      .write(part.toBinary())
      .toArray()
  )
  expect(() =>
    assembleLineage(
      parseRevenueListingLineagePackage(packet),
      lineageLimits({ transactions: existing })
    )
  ).toThrow('Lineage dependency limit')
})

it('reports exact envelope and authorization failures before BEEF assembly', () => {
  const p = completeGenesis()
  const outpoint = { ...p.genesis.body.genesis, outputIndex: 1 }
  const authorizedNonzero = signOutputPacket(
    'sale-genesis',
    { ...p.genesis.body, genesis: outpoint },
    new PrivateKey(41)
  )
  const cases: [unknown, string][] = [
    [{ ...p, version: 2 }, 'Unknown lineage package version'],
    [
      { ...p, genesis: { ...p.genesis, body: { ...p.genesis.body, version: 2 } } },
      'Unknown genesis version'
    ],
    [
      { ...p, genesis: { ...p.genesis, body: { ...p.genesis.body, listingId: '00'.repeat(32) } } },
      'Genesis descriptor mismatch'
    ],
    [
      { ...p, target: { ...p.target, chain: { ...p.target.chain, network: 'foreign' } } },
      'Lineage chain mismatch'
    ],
    [{ ...p, genesis: authorizedNonzero }, 'Genesis must be output zero'],
    [{ ...p, genesis: { ...p.genesis, signature: 1 } }, 'Invalid genesis signature'],
    [
      {
        ...p,
        genesis: {
          ...p.genesis,
          signature: signOutputPacket(
            'sale-genesis',
            { ...p.genesis.body, listingId: 'aa'.repeat(32) },
            new PrivateKey(41)
          ).signature
        }
      },
      'Genesis authorization failed'
    ],
    [{ ...p, transactions: null }, 'Invalid lineage transactions'],
    [{ ...p, transactions: [] }, 'Empty lineage package'],
    [
      { ...p, transactions: [...p.transactions, ...p.transactions] },
      'Lineage transactions must be sorted and unique'
    ]
  ]
  for (const [input, reason] of cases) {
    let failure: unknown
    try {
      parseRevenueListingLineagePackage(input)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(OutputProtocolError)
    expect((failure as OutputProtocolError).code).toBe('invalid')
    expect((failure as Error).message).toBe(reason)
  }
})

it('accepts a non-atomic BEEF with the declared subject last and rejects an empty one', () => {
  const p = completeGenesis()
  const atomic = Beef.fromBinaryStrict(Utils.toArray(p.transactions[0].beef, 'base64'))
  expect(atomic.txs.at(-1)?.txid).toBe(p.target.txid)
  p.transactions[0].beef = Utils.toBase64(atomic.toBinary())
  const assembly = assembleLineage(parseRevenueListingLineagePackage(p), lineageLimits({}))
  expect(assembly.transactions.get(p.target.txid)?.id('hex')).toBe(p.target.txid)
  p.transactions[0].beef = Utils.toBase64(new Beef().toBinary())
  expect(() => assembleLineage(parseRevenueListingLineagePackage(p), lineageLimits({}))).toThrow(
    'BEEF target mismatch'
  )
})

it('counts repeated raw funding ancestors once across entry boundaries', () => {
  const p = parseRevenueListingLineagePackage(lineage)
  const original = assembleLineage(p, lineageLimits({}))
  const transactions = original.beef.txs.length
  const inputs = [...original.transactions.values()].reduce((sum, tx) => sum + tx.inputs.length, 0)
  const exact = assembleLineage(p, lineageLimits({ transactions, inputs }))
  expect(exact.transactions.size).toBe(original.transactions.size)
  expect(exact.beef.toBinary()).toEqual(original.beef.toBinary())
})

it('refuses an over-budget raw union before merging a BEEF part', () => {
  const p = parseRevenueListingLineagePackage(completeGenesis())
  const merge = jest.spyOn(Beef.prototype, 'mergeBeef')
  let failure: unknown
  try {
    assembleLineage(p, lineageLimits({ transactions: 1 }))
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(OutputProtocolError)
  expect((failure as OutputProtocolError).code).toBe('limited')
  expect((failure as Error).message).toBe('Lineage dependency limit')
  expect(merge).not.toHaveBeenCalled()
})

it('checks the parser boundary raw binding and duplicate entries before trusting its union', () => {
  const p = parseRevenueListingLineagePackage(completeGenesis())
  const part = Beef.fromBinaryStrict(Utils.toArray(p.transactions[0].beef, 'base64'))
  const target = part.findTxid(p.target.txid)!
  const read = jest.spyOn(Beef, 'fromBinaryStrict').mockReturnValue(part)
  part.txs.push(target)
  expect(() => assembleLineage(p, lineageLimits({}))).toThrow('Duplicate BEEF transaction')
  part.txs.pop()
  const id = jest.spyOn(target.tx!, 'id').mockReturnValue('ff'.repeat(32))
  expect(() => assembleLineage(p, lineageLimits({}))).toThrow('BEEF raw transaction mismatch')
  id.mockRestore()
  read.mockRestore()
})
