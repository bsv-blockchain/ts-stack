import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import Transaction from '../../../transaction/Transaction.js'
import { hash160, sha256 } from '../../../primitives/Hash.js'
import { toArray, toHex, Writer } from '../../../primitives/utils.js'
import {
  RevenueListingProfile,
  type RevenueListingProfileDescriptor
} from '../RevenueListingProfile.js'
import { revenueListingChildPublicKey } from '../RevenueListingKeys.js'
import {
  planRevenueListingProfileSpend,
  parseRevenueListingProfileAction
} from '../RevenueListingProfilePlan.js'

const fixture: {
  descriptor: RevenueListingProfileDescriptor
  genesis: string
  activation: string
  purchase: string
  purchaseAction: {
    operation: 'purchase'
    acquisitionId: string
    requestDigest: string
    recipient: string
  }
} = JSON.parse(
  gunzipSync(
    readFileSync(resolve(__dirname, 'fixtures/revenue-listing-profile-plan.json.gz'))
  ).toString('utf8')
)
const genesis = Transaction.fromHex(fixture.genesis)
const activation = Transaction.fromHex(fixture.activation)
const purchase = Transaction.fromHex(fixture.purchase)
const profile = new RevenueListingProfile(
  genesis.outputs[0].lockingScript.toBinary().slice(721),
  activation.outputs[0].lockingScript.toBinary().slice(721)
)
const previous = (rawTransaction: string) => [{ rawTransaction, outputIndex: 0 }]
const plan = (rawTransaction: string, action: unknown) =>
  planRevenueListingProfileSpend(profile, fixture.descriptor, previous(rawTransaction), action)

test('activation recreates only the reserve with the active program and no administrative receipt', () => {
  const planned = plan(fixture.genesis, { operation: 'activate' })
  expect(planned.operationCode).toBe(0)
  expect(planned.outputs).toEqual([
    { satoshis: '1', lockingScript: activation.outputs[0].lockingScript.toHex() }
  ])
  expect(planned.input.txid).toBe(genesis.id('hex'))
  expect(planned.receiptIndex).toBeNull()
  expect(planned.minimumExternalFunding).toBe('0')
  expect(planned.sellerAuthorization).toBeUndefined()
  expect(planned.lockTime).toBe(0)
  expect(planned.listingSequence).toBe(0xffffffff)
  expect(planned.requireAllFinalInputs).toBe(true)
})

test('purchase reproduces both unchanged corpus mandatory outputs and preserves the full listing value', () => {
  const planned = plan(fixture.activation, fixture.purchaseAction)
  expect(planned.outputs).toEqual(
    purchase.outputs
      .slice(0, 2)
      .map(output => ({
        satoshis: output.satoshis!.toString(),
        lockingScript: output.lockingScript.toHex()
      }))
  )
  expect(planned.receiptIndex).toBe(1)
  expect(planned.operationCode).toBe(1)
  expect(planned.minimumExternalFunding).toBe('1002')
  expect(planned.sellerAuthorization).toBeUndefined()
})

test('split preserves the complete immutable lock and total value and requests only the protected seller child', () => {
  const planned = plan(fixture.purchase, { operation: 'split', firstAmount: '301' })
  expect(planned.outputs.slice(0, 2)).toEqual([
    { satoshis: '301', lockingScript: purchase.outputs[0].lockingScript.toHex() },
    { satoshis: '701', lockingScript: purchase.outputs[0].lockingScript.toHex() }
  ])
  expect(planned.outputs).toHaveLength(3)
  expect(planned.outputs[2].satoshis).toBe('1')
  expect(planned.outputs[2].lockingScript).toHaveLength(180)
  expect(planned.sellerAuthorization).toEqual({
    identity: fixture.descriptor.seller,
    publicKey: revenueListingChildPublicKey(fixture.descriptor.seller),
    protocolID: [2, '3241645161d8'],
    keyID: 'brc197 authority',
    counterparty: 'anyone'
  })
  expect(planned.sellerAuthorization!.publicKey).not.toBe(planned.sellerAuthorization!.identity)
  expect(planned.minimumExternalFunding).toBe('1')
})

function checkPayments(outputs: { satoshis: string; lockingScript: string }[], units: bigint) {
  const writer = new Writer()
  fixture.descriptor.initialRevenue.recipients.forEach((recipient, index) => {
    const child = revenueListingChildPublicKey(recipient.identity)
    expect(outputs[index]).toEqual({
      satoshis: (units * BigInt(recipient.weight)).toString(),
      lockingScript: '76a914' + toHex(hash160(toArray(child, 'hex'))) + '88ac'
    })
    expect(outputs[index].lockingScript).not.toBe(
      '76a914' + toHex(hash160(toArray(recipient.identity, 'hex'))) + '88ac'
    )
    const script = toArray(outputs[index].lockingScript, 'hex')
    writer
      .writeUInt64LE(Number(outputs[index].satoshis))
      .writeVarIntNum(script.length)
      .write(script)
  })
  return toHex(sha256(writer.toArray()))
}

test('payout is permissionless, retains reserve and remainder, and commits every exact child payment', () => {
  const planned = plan(fixture.purchase, { operation: 'payout', units: '100' })
  expect(planned.payout).toBe('1000')
  expect(planned.outputs[0]).toEqual({
    satoshis: '2',
    lockingScript: purchase.outputs[0].lockingScript.toHex()
  })
  expect(planned.outputs).toHaveLength(4)
  expect(planned.sellerAuthorization).toBeUndefined()
  expect(planned.retirementTopUp).toBe('0')
  expect(planned.minimumExternalFunding).toBe('1')
  const commitment = checkPayments(planned.outputs.slice(2), 100n)
  expect(planned.outputs[1].lockingScript.slice(-64)).toBe(commitment)
})

test.each(['seller', 'expiry'] as const)(
  'retirement distributes reserve and remainder with an exact external top-up: %s',
  authority => {
    const action =
      authority === 'seller'
        ? { operation: 'retire', authority }
        : { operation: 'retire', authority, lockHeight: fixture.descriptor.expiryHeight }
    const planned = plan(fixture.purchase, action)
    expect(planned.operationCode).toBe(5)
    expect(planned.receiptIndex).toBe(0)
    expect(planned.payout).toBe('1010')
    expect(planned.retirementTopUp).toBe('8')
    expect(planned.minimumExternalFunding).toBe('9')
    expect(planned.outputs).toHaveLength(3)
    const commitment = checkPayments(planned.outputs.slice(1), 101n)
    expect(planned.outputs[0].lockingScript.slice(-64)).toBe(commitment)
    expect(planned.lockTime).toBe(authority === 'seller' ? 0 : fixture.descriptor.expiryHeight)
    expect(planned.listingSequence).toBe(authority === 'seller' ? 0xffffffff : 0xfffffffe)
    expect(planned.requireAllFinalInputs).toBe(authority === 'seller')
    expect(planned.sellerAuthorization === undefined).toBe(authority === 'expiry')
  }
)

test('rejects stage bypass, a second listing predecessor and incompatible operations before funding', () => {
  expect(() => plan(fixture.genesis, fixture.purchaseAction)).toThrow('stage')
  expect(() => plan(fixture.activation, { operation: 'activate' })).toThrow('stage')
  expect(() =>
    planRevenueListingProfileSpend(
      profile,
      fixture.descriptor,
      [...previous(fixture.activation), ...previous(fixture.activation)],
      fixture.purchaseAction
    )
  ).toThrow('bounds')
  for (const action of [
    { operation: 'merge' },
    { operation: 'amend', state: fixture.descriptor.initialRevenue },
    { operation: 'retire' },
    { operation: 'retire', authority: 'recipient' }
  ])
    expect(() => parseRevenueListingProfileAction(action)).toThrow()
})

test('refuses reserve violations, zero quanta and out-of-range expiry locks', () => {
  for (const firstAmount of ['0', '1002', '1003'])
    expect(() => plan(fixture.purchase, { operation: 'split', firstAmount })).toThrow('reserve')
  expect(() => plan(fixture.purchase, { operation: 'payout', units: '0' })).toThrow('positive')
  expect(() => plan(fixture.purchase, { operation: 'payout', units: '101' })).toThrow('reserve')
  for (const lockHeight of [fixture.descriptor.expiryHeight - 1, 500000000])
    expect(() =>
      plan(fixture.purchase, { operation: 'retire', authority: 'expiry', lockHeight })
    ).toThrow('height')
})
