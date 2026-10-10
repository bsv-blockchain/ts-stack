import Transaction from '../../../transaction/Transaction.js'
import PrivateKey from '../../../primitives/PrivateKey.js'
import TransactionSignature from '../../../primitives/TransactionSignature.js'
import ProtoWallet from '../../../wallet/ProtoWallet.js'
import UnlockingScript from '../../UnlockingScript.js'
import { toArray } from '../../../primitives/utils.js'
import { hash160, hash256, sha256 } from '../../../primitives/Hash.js'
import { toHex } from '../../../primitives/utils.js'
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
