import Transaction from '../../../transaction/Transaction.js'
import BigNumber from '../../../primitives/BigNumber.js'
import LockingScript from '../../LockingScript.js'
import PrivateKey from '../../../primitives/PrivateKey.js'
import PublicKey from '../../../primitives/PublicKey.js'
import TransactionSignature from '../../../primitives/TransactionSignature.js'
import ProtoWallet from '../../../wallet/ProtoWallet.js'
import UnlockingScript from '../../UnlockingScript.js'
import { toArray, toHex } from '../../../primitives/utils.js'
import { hash160, hash256, sha256 } from '../../../primitives/Hash.js'
import { RevenueListingProfileSpend } from '../RevenueListingProfileSpend.js'
import type { RevenueListingProfileDescriptor } from '../RevenueListingProfile.js'
import type { RevenueListingProfileAction } from '../RevenueListingProfilePlan.js'
import {
  fixture,
  genesis,
  activation,
  purchase,
  profile,
  purchaseAction,
  executeAll,
  construct
} from './RevenueListingProfile.fixture.js'

test.each([
  [
    'activation',
    activation,
    genesis,
    { operation: 'activate' } as RevenueListingProfileAction,
    114
  ],
  ['purchase', purchase, activation, purchaseAction, 15]
] as const)(
  'reproduces the unchanged %s witness and executes every complete input',
  (_name, original, previous, action, depth) => {
    const builder = new RevenueListingProfileSpend(
      profile,
      fixture.descriptor,
      [{ rawTransaction: previous.toHex(), outputIndex: 0 }],
      action
    )
    const prepared = builder.prepare(original)
    expect(prepared.signingRequests()).toEqual([])
    if (action.operation === 'purchase')
      expect(prepared.purchaseCommitment).toBe(fixture.expectedPurchaseCommitment)
    expect(prepared.purchaseCommitment).toBe(
      action.operation === 'purchase'
        ? toHex(hash256(original.inputs[0].unlockingScript!.chunks[0].data!))
        : undefined
    )
    const completed = prepared.complete({})
    expect(completed.inputs[0].unlockingScript!.chunks).toHaveLength(depth)
    expect(completed.inputs[0].unlockingScript!.toHex()).toBe(
      original.inputs[0].unlockingScript!.toHex()
    )
    expect(completed.toHex()).toBe(original.toHex())
    expect(completed.inputs[0].unlockingScript!.toBinary().length).toBeLessThanOrEqual(
      builder.estimateUnlockingLength()
    )
    expect(() => prepared.assertFinalLayout(completed)).not.toThrow()
    executeAll(completed)
  },
  30000
)

test('retains its own plan and source bytes rather than a caller-owned mutable record', () => {
  const descriptor = JSON.parse(JSON.stringify(fixture.descriptor))
  const previous = [{ rawTransaction: activation.toHex(), outputIndex: 0 }]
  const builder = new RevenueListingProfileSpend(profile, descriptor, previous, purchaseAction)
  descriptor.purchasePrice = '1'
  previous[0].rawTransaction = ''
  const first = builder.plan()
  first.outputs[0].satoshis = '1'
  first.schedule.recipients[0].weight = 1
  expect(builder.plan().outputs[0].satoshis).toBe('1002')
  expect(builder.plan().schedule.recipients[0].weight).toBe(7)
  expect(() => builder.prepare(purchase).complete({})).not.toThrow()
  expect(() => builder.estimateUnlockingLength(1)).toThrow('input zero')
})

test.each([
  { lockTime: 1, listingSequence: 0xffffffff, fundingSequence: 0xffffffff },
  { lockTime: 0, listingSequence: 0xfffffffe, fundingSequence: 0xffffffff },
  { lockTime: 0, listingSequence: 0xffffffff, fundingSequence: 0xfffffffe },
  { lockTime: 900000000, listingSequence: 0xfffffffe, fundingSequence: 0xfffffffd }
])(
  'preserves an explicitly selected Bitcoin header without changing recommended defaults: %j',
  async header => {
    const result = await construct(
      purchase,
      { operation: 'payout', units: '100' },
      fixture.descriptor,
      10,
      true,
      header
    )
    expect(result.completed.lockTime).toBe(header.lockTime)
    expect(result.completed.inputs.map(input => input.sequence)).toEqual([
      header.listingSequence,
      header.fundingSequence
    ])
    const recommended = new RevenueListingProfileSpend(
      profile,
      fixture.descriptor,
      [{ rawTransaction: purchase.toHex(), outputIndex: 0 }],
      { operation: 'payout', units: '100' }
    )
    expect(recommended.plan().lockTime).toBe(0)
    expect(recommended.plan().requireAllFinalInputs).toBe(true)
    expect(() => recommended.prepare(result.completed)).toThrow()
    const changed = Transaction.fromHex(result.completed.toHex())
    changed.inputs.forEach((input, index) => {
      input.sourceTransaction = result.completed.inputs[index].sourceTransaction
    })
    changed.lockTime++
    expect(() => result.prepared.assertFinalLayout(changed)).toThrow()
  },
  30000
)

test.each([
  { operation: 'split', firstAmount: '301' },
  { operation: 'payout', units: '100' },
  { operation: 'retire', authority: 'seller' },
  { operation: 'retire', authority: 'expiry', lockHeight: fixture.descriptor.expiryHeight }
] as const)(
  'constructs fully funded $operation/$authority with protected authority only when required',
  async action => {
    const { plan, prepared } = await construct(purchase, action)
    expect(prepared.signingRequests()).toHaveLength(plan.sellerAuthorization === undefined ? 0 : 1)
    expect(plan.retirementTopUp).toBe(action.operation === 'retire' ? '8' : '0')
  },
  30000
)

test('activates eight recipients, purchases and pays all eight with exactly one final funding change', async () => {
  const descriptor: RevenueListingProfileDescriptor = {
    ...fixture.descriptor,
    initialRevenue: {
      recipients: Array.from({ length: 8 }, (_, index) => ({
        identity: new PrivateKey(index + 21).toPublicKey().toString(),
        weight: index + 1
      })).sort((left, right) => (left.identity < right.identity ? -1 : 1))
    }
  }
  const stage = Transaction.fromHex(genesis.toHex())
  stage.outputs[0].lockingScript = profile.lock('activation', descriptor)
  const activated = await construct(stage, { operation: 'activate' }, descriptor)
  expect(activated.completed.inputs[0].unlockingScript!.chunks).toHaveLength(114)
  expect(activated.plan.receiptIndex).toBeNull()
  const bought = await construct(activated.completed, purchaseAction, descriptor)
  const paid = await construct(bought.completed, { operation: 'payout', units: '27' }, descriptor)
  expect(paid.plan.outputs).toHaveLength(10)
  expect(paid.completed.outputs).toHaveLength(11)
  expect(paid.completed.outputs[0].satoshis).toBe(30)
  for (const [index, recipient] of descriptor.initialRevenue.recipients.entries()) {
    expect(paid.completed.outputs[index + 2].satoshis).toBe(recipient.weight * 27)
    const root = Array.from({ length: 8 }, (_, i) => new PrivateKey(i + 21)).find(
      key => key.toPublicKey().toString() === recipient.identity
    )!
    const wallet = new ProtoWallet(root)
    const key = await wallet.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: 'brc197 authority',
      counterparty: 'anyone',
      forSelf: true
    })
    const source = paid.completed.outputs[index + 2]
    // Verify the fixed-child remittance destination before requesting its spend.
    expect(source.lockingScript.toHex()).toBe(
      '76a914' + toHex(hash160(toArray(key.publicKey, 'hex'))) + '88ac'
    )
    const spend = new Transaction(
      1,
      [
        {
          sourceTXID: paid.completed.id('hex'),
          sourceTransaction: paid.completed,
          sourceOutputIndex: index + 2,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript()
        }
      ],
      [{ satoshis: source.satoshis! - 1, lockingScript: source.lockingScript }],
      0
    )
    const preimage = TransactionSignature.format({
      sourceTXID: paid.completed.id('hex'),
      sourceOutputIndex: index + 2,
      sourceSatoshis: source.satoshis!,
      transactionVersion: 1,
      otherInputs: [],
      outputs: spend.outputs,
      inputIndex: 0,
      subscript: source.lockingScript,
      inputSequence: 0xffffffff,
      lockTime: 0,
      scope: 0x41
    })
    const signed = await wallet.createSignature({
      protocolID: [2, '3241645161d8'],
      keyID: 'brc197 authority',
      counterparty: 'anyone',
      data: sha256(preimage)
    })
    spend.inputs[0].unlockingScript = new UnlockingScript()
      .writeBin([...signed.signature, 0x41])
      .writeBin(toArray(key.publicKey, 'hex'))
    executeAll(spend)
  }
}, 30000)

test('funded boundary requires complete source evidence and retains exact independently planned outputs', () => {
  const builder = new RevenueListingProfileSpend(
    profile,
    fixture.descriptor,
    [{ rawTransaction: activation.toHex(), outputIndex: 0 }],
    purchaseAction
  )
  const withoutSources = Transaction.fromHex(purchase.toHex())
  expect(() => builder.prepare(withoutSources)).toThrow('predecessor evidence')
  const incomplete = Transaction.fromAtomicBEEF(toArray(fixture.purchase, 'base64'))
  incomplete.inputs.pop()
  expect(() => builder.prepare(incomplete)).toThrow('layout')
  const prepared = builder.prepare(purchase)
  expect(() => prepared.complete({ seller: '300602010102010141' })).toThrow('presence')
  const changed = Transaction.fromAtomicBEEF(toArray(fixture.purchase, 'base64'))
  changed.outputs[0].satoshis = 1
  expect(() => prepared.assertFinalLayout(changed)).toThrow('output changed')
})

test('a complete no-change payout has canonical zero change fields and still executes every input', async () => {
  const { completed, plan } = await construct(
    purchase,
    { operation: 'payout', units: '100' },
    fixture.descriptor,
    10,
    false
  )
  // This offline case deliberately assigns the remaining external contribution to fees.
  expect(completed.outputs).toHaveLength(plan.outputs.length)
  expect(completed.inputs[0].unlockingScript!.chunks[9].data).toEqual(Array<number>(20).fill(0))
  expect(completed.inputs[0].unlockingScript!.chunks[10].op).toBe(0)
})

test.each(['activation', 'active'] as const)(
  'refuses a second %s-stage listing used as a funding source',
  stage => {
    const builder = new RevenueListingProfileSpend(
      profile,
      fixture.descriptor,
      [{ rawTransaction: activation.toHex(), outputIndex: 0 }],
      purchaseAction
    )
    const funded = Transaction.fromAtomicBEEF(toArray(fixture.purchase, 'base64'))
    const additional = stage === 'activation' ? genesis : purchase
    funded.inputs[1].sourceTransaction = additional
    funded.inputs[1].sourceTXID = additional.id('hex')
    funded.inputs[1].sourceOutputIndex = 0
    expect(() => builder.prepare(funded)).toThrow('Additional family listing')
  }
)

function fundedProfilePurchase() {
  return Transaction.fromAtomicBEEF(toArray(fixture.purchase, 'base64'))
}
function purchaseProfileBuilder() {
  return new RevenueListingProfileSpend(
    profile,
    fixture.descriptor,
    [{ rawTransaction: activation.toHex(), outputIndex: 0 }],
    purchaseAction
  )
}

test.each([
  ['activation', genesis, { operation: 'activate' } as const, 39110],
  ['active', activation, purchaseAction, 6542]
] as const)(
  'preserves the exact conservative %s witness bound',
  (_stage, previous, action, bytes) => {
    const builder = new RevenueListingProfileSpend(
      profile,
      fixture.descriptor,
      [{ rawTransaction: previous.toHex(), outputIndex: 0 }],
      action
    )
    expect(builder.estimateUnlockingLength()).toBe(bytes)
  }
)

test.each(
  (['version', 'lockTime', 'listing-sequence', 'funding-sequence'] as const).flatMap(field =>
    [-1, 1.5, 0x100000000, Number.NaN, Number.POSITIVE_INFINITY].map(value => ({ field, value }))
  )
)('refuses invalid preserved $field=$value before encoding the transaction', ({ field, value }) => {
  const transaction = fundedProfilePurchase()
  if (field === 'version' || field === 'lockTime') transaction[field] = value
  else transaction.inputs[field === 'listing-sequence' ? 0 : 1].sequence = value
  expect(() => purchaseProfileBuilder().preparePreservingHeader(transaction)).toThrow(
    'Invalid preserved transaction header'
  )
})

test.each([0, 0xffffffff])(
  'preserves every explicitly selected uint32 header endpoint %i',
  value => {
    const transaction = fundedProfilePurchase()
    transaction.version = value
    transaction.lockTime = value
    transaction.inputs.forEach(input => {
      input.sequence = value
    })
    const completed = purchaseProfileBuilder().preparePreservingHeader(transaction).complete({})
    expect(completed.version).toBe(value)
    expect(completed.lockTime).toBe(value)
    expect(completed.inputs.map(input => input.sequence)).toEqual([value, value])
  }
)

test.each([0, 1, 9])('bounds %i funded inputs before predecessor work', count => {
  const transaction = fundedProfilePurchase(),
    inputs = transaction.inputs
  transaction.inputs = Array.from({ length: count }, (_, index) => ({
    ...inputs[index % inputs.length]
  }))
  expect(() => purchaseProfileBuilder().prepare(transaction)).toThrow(
    'Funded transaction layout exceeds profile'
  )
})
test.each([0, 12])('bounds %i funded outputs before predecessor work', count => {
  const transaction = fundedProfilePurchase(),
    output = transaction.outputs[0]
  transaction.outputs = Array.from({ length: count }, () => ({ ...output }))
  expect(() => purchaseProfileBuilder().prepare(transaction)).toThrow(
    'Funded transaction layout exceeds profile'
  )
})
test('accepts layout ceilings before separately refusing duplicate inputs and excess route outputs', () => {
  const inputs = fundedProfilePurchase()
  inputs.inputs = [inputs.inputs[0], ...Array.from({ length: 7 }, () => ({ ...inputs.inputs[1] }))]
  expect(() => purchaseProfileBuilder().prepare(inputs)).toThrow('Duplicate funded input')
  const outputs = fundedProfilePurchase()
  while (outputs.outputs.length < 11) outputs.outputs.push({ ...outputs.outputs.at(-1)! })
  expect(() => purchaseProfileBuilder().prepare(outputs)).toThrow('Funded output count changed')
})

test.each([
  'identity',
  'missing-output',
  'required-amount',
  'required-script',
  'change-script',
  'value'
] as const)('keeps the funded %s boundary independently bound', field => {
  const transaction = fundedProfilePurchase()
  if (field === 'identity') transaction.inputs[1].sourceTXID = 'ef'.repeat(32)
  if (field === 'missing-output') transaction.inputs[1].sourceOutputIndex = 0xffffffff
  if (field === 'required-amount') transaction.outputs[0].satoshis!++
  if (field === 'required-script')
    transaction.outputs[0].lockingScript = LockingScript.fromHex('51')
  if (field === 'change-script')
    transaction.outputs.at(-1)!.lockingScript = LockingScript.fromHex('51')
  if (field === 'value') {
    const inputTotal = transaction.inputs.reduce(
        (total, input) =>
          total + input.sourceTransaction!.outputs[input.sourceOutputIndex].satoshis!,
        0
      ),
      required = transaction.outputs
        .slice(0, -1)
        .reduce((total, output) => total + output.satoshis!, 0)
    transaction.outputs.at(-1)!.satoshis = inputTotal - required + 1
  }
  const errors = {
    identity: 'Funding predecessor identity mismatch',
    'missing-output': 'Funding predecessor output missing',
    'required-amount': 'Required listing output changed',
    'required-script': 'Required listing output changed',
    'change-script': 'Only one final P2PKH change output is allowed',
    value: 'Funded transaction does not conserve value'
  }
  expect(() => purchaseProfileBuilder().prepare(transaction)).toThrow(errors[field])
})

test.each(['activation', 'active'] as const)(
  'keeps a foreign program with the exact %s script length distinct from the pinned family',
  stage => {
    const transaction = fundedProfilePurchase(),
      funding = Transaction.fromHex(transaction.inputs[1].sourceTransaction!.toHex()),
      output = funding.outputs[transaction.inputs[1].sourceOutputIndex],
      size = (stage === 'activation' ? genesis : activation).outputs[0].lockingScript.toBinary()
        .length
    output.lockingScript = LockingScript.fromHex('61'.repeat(size))
    transaction.inputs[1].sourceTransaction = funding
    transaction.inputs[1].sourceTXID = funding.id('hex')
    expect(purchaseProfileBuilder().prepare(transaction).signingRequests()).toEqual([])
  }
)

test('bounds complete transaction and predecessor bytes before reading their financial fields', () => {
  const transaction = fundedProfilePurchase()
  transaction.outputs[0].lockingScript = new LockingScript()
    .writeOpCode(0x6a)
    .writeBin(Array<number>(4194304).fill(0))
  expect(() => purchaseProfileBuilder().prepare(transaction)).toThrow(
    'Transaction exceeds local byte limit'
  )
  const funded = fundedProfilePurchase(),
    funding = Transaction.fromHex(funded.inputs[1].sourceTransaction!.toHex())
  funding.outputs[funded.inputs[1].sourceOutputIndex].lockingScript = new LockingScript()
    .writeOpCode(0x6a)
    .writeBin(Array<number>(1048576).fill(0))
  funded.inputs[1].sourceTransaction = funding
  funded.inputs[1].sourceTXID = funding.id('hex')
  expect(() => purchaseProfileBuilder().prepare(funded)).toThrow(
    'Transaction exceeds local byte limit'
  )
})

test('owns the complete funded transaction and source evidence before the caller changes either', () => {
  const transaction = fundedProfilePurchase(),
    original = transaction.toHex(),
    prepared = purchaseProfileBuilder().prepare(transaction)
  transaction.outputs[0].satoshis!++
  transaction.inputs[1].sequence!--
  transaction.inputs[1].sourceTransaction!.outputs[transaction.inputs[1].sourceOutputIndex]
    .satoshis!++
  const completed = prepared.complete({})
  expect(completed.toHex()).toBe(original)
  executeAll(completed)
})

test('owns protocol metadata across returned plans and protected signing requests', async () => {
  const action = { operation: 'split', firstAmount: '301' } as const,
    { completed } = await construct(purchase, action),
    builder = new RevenueListingProfileSpend(
      profile,
      fixture.descriptor,
      [{ rawTransaction: purchase.toHex(), outputIndex: 0 }],
      action
    ),
    prepared = builder.prepare(completed),
    plan = builder.plan()
  Reflect.set(plan.sellerAuthorization!.protocolID, 0, 3)
  expect(builder.plan().sellerAuthorization!.protocolID).toEqual([2, '3241645161d8'])
  const requests = prepared.signingRequests()
  Reflect.set(requests[0].protocolID, 1, 'foreign-child-domain')
  requests[0].data[0] ^= 1
  requests[0].preimage[0] ^= 1
  requests[0].publicKey = '00'
  const actual = prepared.signingRequests()[0],
    input = completed.inputs[0],
    source = input.sourceTransaction!.outputs[input.sourceOutputIndex],
    preimage = TransactionSignature.format({
      sourceTXID: input.sourceTXID!,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis!,
      transactionVersion: completed.version,
      otherInputs: completed.inputs.slice(1),
      outputs: completed.outputs,
      inputIndex: 0,
      subscript: source.lockingScript,
      inputSequence: input.sequence!,
      lockTime: completed.lockTime,
      scope: 0x41
    }),
    wallet = new ProtoWallet(new PrivateKey(fixture.testActors.seller.scalar)),
    child = await wallet.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: 'brc197 authority',
      counterparty: 'anyone',
      forSelf: true
    })
  expect(actual).toEqual({
    inputIndex: 0,
    identity: fixture.testActors.seller.identity,
    publicKey: child.publicKey,
    role: 'seller',
    protocolID: [2, '3241645161d8'],
    keyID: 'brc197 authority',
    counterparty: 'anyone',
    scope: 65,
    data: sha256(preimage),
    preimage
  })
})

test('keeps canonical signature shape, protected child, low S and exact sighash independent', async () => {
  const { completed, prepared } = await construct(purchase, {
      operation: 'split',
      firstAmount: '301'
    }),
    valid = toHex(completed.inputs[0].unlockingScript!.chunks[11].data!),
    failure = 'Seller signature must authorize this input with the protected child and ALL|FORKID'
  for (const seller of [
    null,
    1,
    [],
    {},
    '',
    '0'.repeat(16),
    '0'.repeat(17),
    '0'.repeat(145),
    '0'.repeat(146),
    '0'.repeat(19),
    'gg'.repeat(9),
    valid.toUpperCase(),
    'gg' + valid,
    valid + 'gg',
    valid + '\n\n'
  ]) {
    expect(() => prepared.complete({ seller })).toThrow('Expected canonical seller-child signature')
  }
  const minimum = '300602010102010141',
    maximum = toHex(
      new TransactionSignature(
        new BigNumber('80' + '00'.repeat(31), 16),
        new BigNumber('40' + '00'.repeat(31), 16),
        0x41
      ).toChecksigFormat()
    )
  expect(minimum).toHaveLength(18)
  expect(maximum).toHaveLength(144)
  for (const seller of [minimum, maximum])
    expect(() => prepared.complete({ seller })).toThrow(failure)
  const scope = TransactionSignature.fromChecksigFormat(toArray(valid, 'hex'))
  scope.scope = 0x42
  expect(() => prepared.complete({ seller: toHex(scope.toChecksigFormat()) })).toThrow(failure)
  const high = TransactionSignature.fromChecksigFormat(toArray(valid, 'hex')),
    order = new BigNumber('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 16)
  high.s = order.sub(high.s)
  expect(high.hasLowS()).toBe(false)
  expect(() => prepared.complete({ seller: toHex(high.toChecksigFormat()) })).toThrow(failure)
  expect(() => prepared.complete({})).toThrow('Exact seller-child signature presence required')
  expect(() => prepared.complete({ seller: valid, extra: true })).toThrow()
  expect(prepared.complete({ seller: valid }).inputs[0].unlockingScript!.toHex()).toBe(
    completed.inputs[0].unlockingScript!.toHex()
  )
})

test.each([0, 2100000000000001])(
  'refuses an encoded output amount outside the monetary range: %i',
  value => {
    const transaction = fundedProfilePurchase()
    transaction.outputs[0].satoshis = value
    expect(() => purchaseProfileBuilder().prepare(transaction)).toThrow('Invalid funded amount')
  }
)

test.each([0, 2100000000000000, 2100000000000001])(
  'keeps actual external funding amount %i separate from value conservation',
  value => {
    const transaction = fundedProfilePurchase(),
      source = Transaction.fromHex(transaction.inputs[1].sourceTransaction!.toHex())
    source.outputs[transaction.inputs[1].sourceOutputIndex].satoshis = value
    transaction.inputs[1].sourceTransaction = source
    transaction.inputs[1].sourceTXID = source.id('hex')
    expect(() => purchaseProfileBuilder().prepare(transaction)).toThrow(
      value > 2100000000000000
        ? 'Invalid external funding amount'
        : 'Funded transaction does not conserve value'
    )
  }
)

test('accepts the monetary ceiling before independently refusing a changed required output', () => {
  const transaction = fundedProfilePurchase()
  transaction.outputs[0].satoshis = 2100000000000000
  expect(() => purchaseProfileBuilder().prepare(transaction)).toThrow(
    'Required listing output changed'
  )
})

test.each(['version', 'change-value', 'change-destination'] as const)(
  'refuses a financially valid post-signing %s change at the authenticated layout boundary',
  field => {
    const transaction = fundedProfilePurchase(),
      prepared = purchaseProfileBuilder().prepare(transaction)
    if (field === 'version') transaction.version++
    if (field === 'change-value') transaction.outputs.at(-1)!.satoshis!--
    if (field === 'change-destination')
      transaction.outputs.at(-1)!.lockingScript = LockingScript.fromHex(
        '76a914' + '00'.repeat(20) + '88ac'
      )
    expect(() => prepared.assertFinalLayout(transaction)).toThrow(
      'Wallet changed the authenticated transaction layout'
    )
  }
)

test('bounds the completed witness independently of the already bounded funded transaction', () => {
  const transaction = fundedProfilePurchase()
  transaction.inputs.forEach(input => {
    input.unlockingScript = new UnlockingScript()
  })
  const empty = transaction.toBinary().length,
    payload = 4194304 - 1024 - empty - 9
  transaction.inputs[1].unlockingScript = new UnlockingScript().writeBin(
    Array<number>(payload).fill(0)
  )
  expect(transaction.toBinary()).toHaveLength(4194304 - 1024)
  const prepared = purchaseProfileBuilder().prepare(transaction)
  expect(() => prepared.complete({})).toThrow('Completed transaction exceeds local byte limit')
})

test.each(['locktime', 'listing-sequence', 'funding-sequence', 'missing-predecessor'] as const)(
  'retains the ordinary construction refusal for %s',
  field => {
    const transaction = fundedProfilePurchase()
    if (field === 'locktime') transaction.lockTime = 1
    if (field === 'listing-sequence') transaction.inputs[0].sequence = 0
    if (field === 'funding-sequence') transaction.inputs[1].sequence = 0
    if (field === 'missing-predecessor') transaction.inputs[1].sourceTransaction = undefined
    expect(() => purchaseProfileBuilder().prepare(transaction)).toThrow(
      field === 'locktime'
        ? 'Funded transaction locktime changed'
        : field === 'missing-predecessor'
          ? 'Funding predecessor evidence required'
          : 'Funded input finality differs from the route'
    )
  }
)

test('binds the selected listing output index even when another real output has identical bytes', () => {
  const previous = Transaction.fromHex(activation.toHex())
  previous.addOutput({ ...previous.outputs[0] })
  const transaction = fundedProfilePurchase(),
    builder = new RevenueListingProfileSpend(
      profile,
      fixture.descriptor,
      [{ rawTransaction: previous.toHex(), outputIndex: 0 }],
      purchaseAction
    )
  transaction.inputs[0].sourceTransaction = previous
  transaction.inputs[0].sourceTXID = previous.id('hex')
  transaction.inputs[0].sourceOutputIndex = previous.outputs.length - 1
  expect(previous.outputs.at(-1)!.lockingScript.toHex()).toBe(
    previous.outputs[0].lockingScript.toHex()
  )
  expect(previous.outputs.at(-1)!.satoshis).toBe(previous.outputs[0].satoshis)
  expect(() => builder.prepare(transaction)).toThrow('Listing input changed')
})

test('allows the one-output activation construction before independent funding Script verification', () => {
  const transaction = Transaction.fromAtomicBEEF(toArray(fixture.activation, 'base64')),
    builder = new RevenueListingProfileSpend(
      profile,
      fixture.descriptor,
      [{ rawTransaction: genesis.toHex(), outputIndex: 0 }],
      { operation: 'activate' }
    )
  transaction.outputs = transaction.outputs.slice(0, 1)
  expect(builder.prepare(transaction).signingRequests()).toEqual([])
  // The funding signature must be produced for this changed output set separately.
  expect(transaction.outputs).toHaveLength(1)
})

test('accepts exactly four MiB of funded encoding before constructing a witness', () => {
  const transaction = fundedProfilePurchase(),
    bound = 4194304
  transaction.inputs[1].unlockingScript = new UnlockingScript()
  const base = transaction.toBinary().length
  // The raw input gains four CompactSize bytes and a five-byte PUSHDATA4 prefix.
  transaction.inputs[1].unlockingScript = new UnlockingScript().writeBin(
    Array<number>(bound - base - 9).fill(0)
  )
  expect(transaction.toBinary()).toHaveLength(bound)
  expect(purchaseProfileBuilder().prepare(transaction).signingRequests()).toEqual([])
  // This is a construction byte-bound check, not funding Script validity.
})

test('rejects noncanonical signed DER even when its scalar signature verifies for the exact protected child', async () => {
  for (let index = 0; index < 8; index++) {
    const { completed, prepared } = await construct(purchase, {
        operation: 'split',
        firstAmount: String(301 + index)
      }),
      bytes = [...completed.inputs[0].unlockingScript!.chunks[11].data!]
    if (bytes[3] !== 33 || bytes[4] !== 0) continue
    // Removing the required positive R prefix preserves the mathematical scalar,
    // but the wire DER no longer has its unique positive-integer representation.
    bytes.splice(4, 1)
    bytes[1]--
    bytes[3]--
    const encoded = toHex(bytes),
      parsed = TransactionSignature.fromChecksigFormat(bytes),
      request = prepared.signingRequests()[0]
    expect(parsed.verify(sha256(request.preimage), PublicKey.fromString(request.publicKey))).toBe(
      true
    )
    expect(parsed.hasLowS()).toBe(true)
    expect(parsed.scope).toBe(0x41)
    expect(toHex(parsed.toChecksigFormat())).not.toBe(encoded)
    expect(() => prepared.complete({ seller: encoded })).toThrow(
      'Seller signature must authorize this input with the protected child and ALL|FORKID'
    )
    return
  }
  throw new Error('Expected the deterministic signed fixture to exercise a positive R prefix')
})
