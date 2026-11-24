import {
  planRevenueListingSpend,
  parseRevenueListingAction,
  parseRevenueListingPrevious,
  readRevenueListingPrevious
} from '../RevenueListingPlan.js'
import { RevenueListing } from '../RevenueListing.js'
import {
  accepted,
  corpus,
  transaction,
  previous,
  action,
  makeFamily
} from './RevenueListing.fixture.js'
import PrivateKey from '../../../primitives/PrivateKey.js'

let family: RevenueListing
beforeAll(() => {
  family = makeFamily()
})

test.each(accepted)('mandatory outputs match frozen $name', trace => {
  const plan = planRevenueListingSpend(
    family,
    corpus.descriptor,
    previous(trace),
    action(trace, family)
  )
  const tx = transaction(trace.txid)
  expect(plan.operationCode).toBe(trace.operation)
  expect(plan.outputs).toEqual(
    tx.outputs.slice(0, -1).map(item => ({
      satoshis: item.satoshis!.toString(),
      lockingScript: item.lockingScript.toHex()
    }))
  )
  expect(plan.inputs).toEqual(
    previous(trace).map(item => {
      const source = readRevenueListingPrevious(item.rawTransaction)
      return {
        txid: source.id('hex'),
        outputIndex: item.outputIndex,
        satoshis: source.outputs[item.outputIndex].satoshis!.toString(),
        lockingScript: source.outputs[item.outputIndex].lockingScript.toHex()
      }
    })
  )
  expect(plan.minimumExternalFunding).toBe(
    trace.operation === 1 ? '1002' : trace.name === 'retire-topup-six-satoshis' ? '7' : '1'
  )
  expect(plan.signers).toEqual({
    ...(trace.operation === 1 ? {} : { seller: corpus.descriptor.seller }),
    recipients: trace.operation === 6 ? plan.currentState.recipients.map(item => item.identity) : []
  })
  expect(plan.retirementTopUp).toBe(trace.name === 'retire-topup-six-satoshis' ? '6' : '0')
  expect(plan.receiptIndex).toBe(trace.operation === 2 ? 2 : trace.operation === 5 ? 0 : 1)
  if (trace.operation === 5) expect(plan.successorState).toBeUndefined()
  else
    expect(family.decode(tx.outputs[0].lockingScript.toBinary(), corpus.descriptor)).toEqual(
      plan.successorState
    )
})

function prepare(name: string) {
  const trace = accepted.find(item => item.name === name)!
  return { trace, sources: previous(trace), route: action(trace, family) }
}

test('payout retains remainder and amendment requires every old recipient including removed ones', () => {
  const payout = prepare('payout')
  const paid = planRevenueListingSpend(family, corpus.descriptor, payout.sources, payout.route)
  expect(paid.outputs.map(item => item.satoshis)).toEqual(['2004', '1', '700', '300'])
  expect(paid.payout).toBe('1000')
  const amendment = prepare('amend-all-consent')
  const amended = planRevenueListingSpend(
    family,
    corpus.descriptor,
    amendment.sources,
    amendment.route
  )
  expect(amended.signers.recipients).toEqual(
    corpus.descriptor.initialRevenue.recipients.map(item => item.identity)
  )
  expect(amended.outputs[0].satoshis).toBe('2004')
  expect(
    amended.successorState!.recipients.every(
      item => !amended.signers.recipients.includes(item.identity)
    )
  ).toBe(true)
})

test('returned plans own source, output and schedule data', () => {
  const { sources, route } = prepare('split')
  const planned = planRevenueListingSpend(family, corpus.descriptor, sources, route)
  planned.currentState.recipients[0].weight = 10
  planned.successorState!.recipients[0].weight = 9
  planned.outputs[0].satoshis = '999'
  sources[0].outputIndex = 1
  const fresh = prepare('split')
  expect(
    planRevenueListingSpend(family, corpus.descriptor, fresh.sources, fresh.route).outputs[0]
      .satoshis
  ).toBe('500')
  expect(planned.currentState.recipients[0].weight).toBe(10)
})

test.each([
  { operation: 'payout', units: '0' },
  { operation: 'payout', units: '301' },
  { operation: 'payout', units: '18446744073709551615' },
  { operation: 'split', firstAmount: '0' },
  { operation: 'split', firstAmount: '3004' },
  { operation: 'split', firstAmount: '3005' }
])('rejects economically invalid plan %j', route => {
  const { sources } = prepare('payout')
  expect(() => planRevenueListingSpend(family, corpus.descriptor, sources, route)).toThrow()
})

test.each(['0', '2', '18446744073709551615'])(
  'rejects skipped or unchanged amendment revision %s',
  revision => {
    const { sources, route } = prepare('amend-all-consent')
    if (route.operation !== 'amend') throw new Error('fixture route')
    route.state.revision = revision
    expect(() => planRevenueListingSpend(family, corpus.descriptor, sources, route)).toThrow(
      'revision'
    )
  }
)

test('administration none does not expose an administrative exit', () => {
  const { sources } = prepare('split')
  const descriptor = { ...corpus.descriptor, administration: 'none' }
  const tx = readRevenueListingPrevious(sources[0].rawTransaction)
  tx.outputs[sources[0].outputIndex].lockingScript = family.lock(descriptor)
  sources[0].rawTransaction = tx.toHex()
  expect(() =>
    planRevenueListingSpend(family, descriptor, sources, { operation: 'split', firstAmount: '500' })
  ).toThrow('disabled')
  const buyer = new PrivateKey(44).toPublicKey().toString()
  expect(
    planRevenueListingSpend(family, descriptor, sources, {
      operation: 'purchase',
      acquisitionId: '55'.repeat(32),
      requestDigest: '66'.repeat(32),
      recipient: buyer
    }).signers
  ).toEqual({ recipients: [] })
})

test('requires exact independent listing inputs for merge', () => {
  const { sources, route } = prepare('merge')
  expect(() =>
    planRevenueListingSpend(family, corpus.descriptor, [sources[0], sources[0]], route)
  ).toThrow('Duplicate')
  expect(() => planRevenueListingSpend(family, corpus.descriptor, [sources[0]], route)).toThrow(
    'count'
  )
  const tx = readRevenueListingPrevious(sources[1].rawTransaction)
  const state = { ...corpus.descriptor.initialRevenue, revision: '1' }
  tx.outputs[0].lockingScript = family.lock(corpus.descriptor, state)
  sources[1].rawTransaction = tx.toHex()
  expect(() => planRevenueListingSpend(family, corpus.descriptor, sources, route)).toThrow('differ')
})

test.each(
  [
    [],
    [{ rawTransaction: '', outputIndex: 0 }],
    [{ rawTransaction: 'AB', outputIndex: 0 }],
    [{ rawTransaction: 'a', outputIndex: 0 }],
    [{ rawTransaction: '00', outputIndex: -1 }],
    [{ rawTransaction: '00'.repeat(1048577), outputIndex: 0 }]
  ].map(input => [input])
)('rejects malformed predecessor framing %#', input => {
  expect(() => parseRevenueListingPrevious(input)).toThrow()
})

test.each([
  { operation: 'retire', extra: true },
  { operation: 'unknown' },
  { operation: 'payout', units: 1 },
  { operation: 'split', firstAmount: '01' }
])('rejects unknown or noncanonical action %j', input => {
  expect(() => parseRevenueListingAction(input)).toThrow()
})

test.each([
  'version',
  'locktime',
  'sequence',
  'missing-output',
  'zero-value',
  'below-reserve',
  'wrong-family'
])('rejects invalid source %s', kind => {
  const { sources, route } = prepare('purchase')
  const tx = readRevenueListingPrevious(sources[0].rawTransaction)
  let descriptor = corpus.descriptor
  if (kind === 'version') tx.version = 3
  if (kind === 'locktime') tx.lockTime = 1
  if (kind === 'sequence') tx.inputs[0].sequence = 0
  if (kind === 'missing-output') sources[0].outputIndex = 11
  if (kind === 'zero-value') tx.outputs[0].satoshis = 0
  if (kind === 'below-reserve') {
    descriptor = { ...descriptor, reserve: '2' }
    tx.outputs[0].lockingScript = family.lock(descriptor)
  }
  if (kind === 'wrong-family') tx.outputs[0].lockingScript = tx.outputs[1].lockingScript
  sources[0].rawTransaction = tx.toHex()
  expect(() => planRevenueListingSpend(family, descriptor, sources, route)).toThrow()
})

test('predecessor envelope accepts exact byte capacity and rejects typed, empty and nonhex values precisely', () => {
  const rawTransaction = '00'.repeat(1048576)
  expect(
    parseRevenueListingPrevious([{ rawTransaction, outputIndex: 0 }])[0].rawTransaction
  ).toHaveLength(2097152)
  for (const value of ['', 1234, null, [], '00'.repeat(1048577)]) {
    expect(() => parseRevenueListingPrevious([{ rawTransaction: value, outputIndex: 0 }])).toThrow(
      'transaction length'
    )
  }
  for (const value of ['z0', '0z', 'AB', ' 00 ']) {
    expect(() => parseRevenueListingPrevious([{ rawTransaction: value, outputIndex: 0 }])).toThrow(
      'canonical transaction hex'
    )
  }
})

test('bounded predecessor reader accepts both versions and exact maximum dimensions', () => {
  const { sources } = prepare('purchase')
  const tx = readRevenueListingPrevious(sources[0].rawTransaction)
  tx.version = 2
  tx.inputs = Array.from({ length: 8 }, () => ({ ...tx.inputs[0] }))
  tx.outputs = Array.from({ length: 11 }, (_, index) => ({
    ...tx.outputs[1],
    satoshis: index === 0 ? 2100000000000000 : 0
  }))
  const read = readRevenueListingPrevious(tx.toHex())
  expect(read.version).toBe(2)
  expect(read.inputs).toHaveLength(8)
  expect(read.outputs).toHaveLength(11)
  expect(read.outputs[0].satoshis).toBe(2100000000000000)
  expect(read.outputs[1].satoshis).toBe(0)
  tx.outputs = tx.outputs.slice(0, 1)
  expect(readRevenueListingPrevious(tx.toHex()).outputs).toHaveLength(1)
})

test.each(['no-inputs', 'nine-inputs', 'no-outputs', 'twelve-outputs', 'large-amount'])(
  'bounded predecessor reader rejects %s before planning',
  kind => {
    const { sources } = prepare('purchase')
    const tx = readRevenueListingPrevious(sources[0].rawTransaction)
    if (kind === 'no-inputs') tx.inputs = []
    if (kind === 'nine-inputs') tx.inputs = Array.from({ length: 9 }, () => ({ ...tx.inputs[0] }))
    if (kind === 'no-outputs') tx.outputs = []
    if (kind === 'twelve-outputs')
      tx.outputs = Array.from({ length: 12 }, () => ({ ...tx.outputs[0] }))
    if (kind === 'large-amount') tx.outputs[1].satoshis = 2100000000000001
    expect(() => readRevenueListingPrevious(tx.toHex())).toThrow(
      kind === 'large-amount' ? 'previous output amount' : 'layout exceeds profile'
    )
  }
)

test('merges two distinct outputs of one split predecessor', () => {
  const split = accepted.find(item => item.name === 'split')!
  const rawTransaction = transaction(split.txid).toHex()
  const plan = planRevenueListingSpend(
    family,
    corpus.descriptor,
    [
      { rawTransaction, outputIndex: 0 },
      { rawTransaction, outputIndex: 1 }
    ],
    { operation: 'merge' }
  )
  expect(plan.outputs[0].satoshis).toBe('1002')
  expect(plan.inputs[0].txid).toBe(plan.inputs[1].txid)
  expect(plan.inputs.map(item => item.outputIndex)).toEqual([0, 1])
})

function customSource(value: number, reserve: string, purchasePrice = '1') {
  const descriptor = { ...corpus.descriptor, reserve, purchasePrice }
  const { sources } = prepare('purchase')
  const tx = readRevenueListingPrevious(sources[0].rawTransaction)
  tx.outputs[0].satoshis = value
  tx.outputs[0].lockingScript = family.lock(descriptor)
  return { descriptor, sources: [{ rawTransaction: tx.toHex(), outputIndex: 0 }] }
}

test('preserves an arbitrary reserve on both split branches, including exact boundaries', () => {
  const { descriptor, sources } = customSource(100, '3')
  for (const firstAmount of ['2', '98'])
    expect(() =>
      planRevenueListingSpend(family, descriptor, sources, { operation: 'split', firstAmount })
    ).toThrow('Split would violate reserve')
  for (const firstAmount of ['3', '97'])
    expect(
      planRevenueListingSpend(family, descriptor, sources, { operation: 'split', firstAmount })
        .outputs.slice(0, 2)
        .map(item => item.satoshis)
    ).toEqual([firstAmount, String(100 - Number(firstAmount))])
})

test('payout cannot consume reserve even if the continuing amount is positive', () => {
  const invalid = customSource(25, '11')
  expect(() =>
    planRevenueListingSpend(family, invalid.descriptor, invalid.sources, {
      operation: 'payout',
      units: '2'
    })
  ).toThrow('Payout would violate reserve')
  const valid = customSource(31, '11')
  expect(
    planRevenueListingSpend(family, valid.descriptor, valid.sources, {
      operation: 'payout',
      units: '2'
    }).outputs[0].satoshis
  ).toBe('11')
  expect(() =>
    planRevenueListingSpend(family, valid.descriptor, valid.sources, {
      operation: 'payout',
      units: '0'
    })
  ).toThrow('Payout units must be positive')
})

test('purchase reaches SatoshiValue exactly but cannot exceed it', () => {
  const purchase = action(accepted[0], family)
  const valid = customSource(2099999999999999, '1')
  expect(
    planRevenueListingSpend(family, valid.descriptor, valid.sources, purchase).outputs[0].satoshis
  ).toBe('2100000000000000')
  const invalid = customSource(2100000000000000, '1')
  expect(() =>
    planRevenueListingSpend(family, invalid.descriptor, invalid.sources, purchase)
  ).toThrow('Listing output amount outside SatoshiValue')
})

test('distinguishes absent, zero and below-reserve listing outputs', () => {
  const missing = customSource(1, '1')
  missing.sources[0].outputIndex = 11
  expect(() =>
    planRevenueListingSpend(family, missing.descriptor, missing.sources, { operation: 'retire' })
  ).toThrow('Missing previous listing output')
  const zero = customSource(0, '1')
  expect(() =>
    planRevenueListingSpend(family, zero.descriptor, zero.sources, { operation: 'retire' })
  ).toThrow('Listing output amount outside SatoshiValue')
  const under = customSource(1, '2')
  expect(() =>
    planRevenueListingSpend(family, under.descriptor, under.sources, { operation: 'retire' })
  ).toThrow('Listing below reserve')
  const retired = customSource(20, '1')
  expect(
    planRevenueListingSpend(family, retired.descriptor, retired.sources, { operation: 'retire' })
  ).not.toHaveProperty('successorState')
})
