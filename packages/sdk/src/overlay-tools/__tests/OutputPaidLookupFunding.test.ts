import {
  Beef,
  LockingScript,
  PrivateKey,
  Transaction,
  Utils,
  outputPacketDigest
} from '../../../mod.js'
import {
  inspectOutputPaidLookupFunding,
  parseOutputPaidLookupPayment
} from '../OutputPaidLookupFunding.js'
import { fundingFixture } from './OutputPaidLookupFunding.fixture.js'
import { BEEF_V1 } from '../../transaction/Beef.js'

test('identifies the exact BRC-29 output using both actual wallet derivations and retains its original bytes', async () => {
  const fixture = await fundingFixture(),
    payment = fixture.payment()
  const inspected = inspectOutputPaidLookupFunding(
    JSON.stringify(payment),
    fixture.challenge,
    fixture.selected
  )
  const funding = {
    chain: fixture.selected.chain,
    txid: fixture.transaction.id('hex'),
    outputIndex: 1
  }
  expect(inspected).toEqual({
    operation: {
      id: outputPacketDigest('wallet-funding', {
        seller: fixture.challenge.seller,
        acquisitionId: fixture.challenge.acquisitionId,
        funding
      }),
      acquisitionId: fixture.challenge.acquisitionId,
      funding,
      buyer: fixture.challenge.buyer,
      seller: fixture.challenge.seller,
      satoshis: '100',
      derivationPrefix: payment.derivationPrefix,
      derivationSuffix: payment.derivationSuffix,
      beef: payment.transaction
    },
    rawTransaction: Utils.toBase64(fixture.transaction.toBinary())
  })
  const expected = structuredClone(inspected)
  fixture.selected.chain.network = 'changed'
  fixture.challenge.satoshis = '1'
  payment.transaction = 'AA=='
  expect(inspected).toEqual(expected)
})

test('bounds the entire header and decoded BEEF independently with owned, closed fields', () => {
  const transaction = Utils.toBase64(new Uint8Array(65536))
  const payment = {
    derivationPrefix: 'x'.repeat(128),
    derivationSuffix: String.fromCharCode(0, 127),
    transaction
  }
  const json = JSON.stringify(payment)
  const exact = json + ' '.repeat(98304 - json.length)
  expect(parseOutputPaidLookupPayment(exact)).toEqual(payment)
  expect(parseOutputPaidLookupPayment(new TextEncoder().encode(exact))).toEqual(payment)
  expect(() => parseOutputPaidLookupPayment(exact + ' ')).toThrow('byte limit')
  expect(() =>
    parseOutputPaidLookupPayment({ ...payment, transaction: Utils.toBase64(new Uint8Array(65537)) })
  ).toThrow()
  expect(() => parseOutputPaidLookupPayment({ ...payment, paid: true })).toThrow('Unknown')
  expect(() =>
    parseOutputPaidLookupPayment(
      json.replace('"derivationPrefix":', '"derivationPrefix":"duplicate","derivationPrefix":')
    )
  ).toThrow('Duplicate')
  for (const field of ['derivationPrefix', 'derivationSuffix']) {
    for (const value of [undefined, null, '', 1, 'é', 'x'.repeat(129), String.fromCharCode(128)])
      expect(() => parseOutputPaidLookupPayment({ ...payment, [field]: value })).toThrow()
    for (const value of [null, ['a'], 'aé', String.fromCharCode(0, 128), ''])
      expect(() => parseOutputPaidLookupPayment({ ...payment, [field]: value })).toThrow(
        'Expected bounded ASCII payment derivation'
      )
  }
  expect(() => parseOutputPaidLookupPayment({ ...payment, transaction: 'AB==' })).toThrow()
})

test('requires the retained prefix and exactly one matching script anywhere among all outputs', async () => {
  const fixture = await fundingFixture()
  expect(() =>
    inspectOutputPaidLookupFunding(
      { ...fixture.payment(), derivationPrefix: 'different' },
      fixture.challenge,
      fixture.selected
    )
  ).toThrow('frozen challenge')
  expect(() =>
    inspectOutputPaidLookupFunding(fixture.payment(), fixture.challenge, {
      ...fixture.selected,
      sellerPaymentKey: new PrivateKey(85).toPublicKey().toString()
    })
  ).toThrow('exactly one')
  for (const amount of [0, 1, 99, 101, 200]) {
    const copy = Transaction.fromHex(fixture.transaction.toHex())
    copy.inputs[0].sourceTransaction = fixture.source
    copy.outputs[1].satoshis = amount
    expect(() =>
      inspectOutputPaidLookupFunding(fixture.payment(copy), fixture.challenge, fixture.selected)
    ).toThrow('equal challenged')
  }
  for (const amount of [1, 99, 100, 101]) {
    const copy = Transaction.fromHex(fixture.transaction.toHex())
    copy.inputs[0].sourceTransaction = fixture.source
    copy.outputs.push({ satoshis: amount, lockingScript: fixture.script })
    expect(() =>
      inspectOutputPaidLookupFunding(fixture.payment(copy), fixture.challenge, fixture.selected)
    ).toThrow('exactly one')
  }
  fixture.transaction.outputs.reverse()
  expect(
    inspectOutputPaidLookupFunding(fixture.payment(), fixture.challenge, fixture.selected).operation
      .funding.outputIndex
  ).toBe(0)
})

test('requires a raw target and the exact atomic dependency graph with no trailing bytes', async () => {
  const fixture = await fundingFixture(),
    payment = fixture.payment()
  const bytes = Utils.toArray(payment.transaction, 'base64'),
    beef = Beef.fromBinaryStrict(bytes)
  const variants = [bytes.slice(36), [...bytes, 0], bytes.slice(0, -1), []]
  const wrongTarget = [...bytes]
  wrongTarget.fill(255, 4, 36)
  variants.push(wrongTarget)
  beef.makeTxidOnly(beef.atomicTxid!)
  variants.push([...bytes.slice(0, 36), ...beef.toBinary()])
  const unrelated = new Beef()
  unrelated.mergeBeef(bytes)
  unrelated.mergeTransaction(
    new Transaction(2, [], [{ satoshis: 1, lockingScript: LockingScript.fromHex('51') }], 0)
  )
  variants.push([...bytes.slice(0, 36), ...unrelated.toBinary()])
  expect(() =>
    inspectOutputPaidLookupFunding(
      { ...payment, transaction: Utils.toBase64(variants.at(-1)!) },
      fixture.challenge,
      fixture.selected
    )
  ).toThrow('Payment requires one Atomic BEEF dependency graph')
  const onlyTarget = new Beef()
  onlyTarget.mergeTxidOnly(fixture.transaction.id('hex'))
  expect(() =>
    inspectOutputPaidLookupFunding(
      {
        ...payment,
        transaction: Utils.toBase64([...bytes.slice(0, 36), ...onlyTarget.toBinary()])
      },
      fixture.challenge,
      fixture.selected
    )
  ).toThrow('Payment target raw transaction required')
  for (const variant of variants)
    expect(() =>
      inspectOutputPaidLookupFunding(
        { ...payment, transaction: Utils.toBase64(variant) },
        fixture.challenge,
        fixture.selected
      )
    ).toThrow()
})

test('funding identity ignores alternate valid BEEF representation and includes seller, acquisition and chain', async () => {
  const fixture = await fundingFixture(),
    original = fixture.payment()
  const expected = inspectOutputPaidLookupFunding(original, fixture.challenge, fixture.selected)
  const beef = Beef.fromBinaryStrict(Utils.toArray(original.transaction, 'base64'))
  beef.version = BEEF_V1 // Target transaction and outpoint are unchanged.
  const alternate = {
    ...original,
    transaction: Utils.toBase64(beef.toBinaryAtomic(beef.atomicTxid!))
  }
  expect(alternate.transaction).not.toBe(original.transaction)
  const recovered = inspectOutputPaidLookupFunding(alternate, fixture.challenge, fixture.selected)
  expect(recovered.operation.id).toBe(expected.operation.id)
  expect(recovered.operation.funding).toEqual(expected.operation.funding)
  expect(recovered.rawTransaction).toBe(expected.rawTransaction)
  expect(recovered.operation.beef).toBe(alternate.transaction)
  for (const challenge of [
    { ...fixture.challenge, acquisitionId: '99'.repeat(32) },
    { ...fixture.challenge, seller: new PrivateKey(85).toPublicKey().toString() }
  ])
    expect(
      inspectOutputPaidLookupFunding(original, challenge, fixture.selected).operation.id
    ).not.toBe(expected.operation.id)
  expect(
    inspectOutputPaidLookupFunding(original, fixture.challenge, {
      ...fixture.selected,
      chain: { ...fixture.selected.chain, network: 'different' }
    }).operation.id
  ).not.toBe(expected.operation.id)
})
