import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import Transaction from '../../../transaction/Transaction.js'
import Spend from '../../Spend.js'
import LockingScript from '../../LockingScript.js'
import UnlockingScript from '../../UnlockingScript.js'
import PrivateKey from '../../../primitives/PrivateKey.js'
import ProtoWallet from '../../../wallet/ProtoWallet.js'
import P2PKH from '../P2PKH.js'
import { toArray, toHex } from '../../../primitives/utils.js'
import {
  RevenueListingProfile,
  type RevenueListingProfileDescriptor
} from '../RevenueListingProfile.js'
import { RevenueListingProfileSpend } from '../RevenueListingProfileSpend.js'
import type { RevenueListingProfileAction } from '../RevenueListingProfilePlan.js'

export const fixture: {
  descriptor: RevenueListingProfileDescriptor
  genesis: string
  activation: string
  purchase: string
  expectedPurchaseCommitment: string
  testActors: {
    seller: { scalar: number; identity: string }
    funding: { scalar: number; identity: string }
  }
} = JSON.parse(
  gunzipSync(
    readFileSync(resolve(__dirname, 'fixtures/revenue-listing-profile-spend.json.gz'))
  ).toString('utf8')
)
export const genesis = Transaction.fromHex(fixture.genesis)
export const activation = Transaction.fromAtomicBEEF(toArray(fixture.activation, 'base64'))
export const purchase = Transaction.fromAtomicBEEF(toArray(fixture.purchase, 'base64'))
export const profile = new RevenueListingProfile(
  genesis.outputs[0].lockingScript.toBinary().slice(721),
  activation.outputs[0].lockingScript.toBinary().slice(721)
)
const receipt = purchase.outputs[1].lockingScript.toBinary()
export const purchaseAction: RevenueListingProfileAction = {
  operation: 'purchase',
  acquisitionId: toHex(receipt.slice(42, 74)),
  requestDigest: toHex(receipt.slice(74, 106)),
  recipient: toHex(receipt.slice(106, 139))
}

export function executeAll(tx: Transaction): void {
  tx.inputs.forEach((input, index) => {
    const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
    const spend = new Spend({
      sourceTXID: input.sourceTXID!,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis!,
      lockingScript: LockingScript.fromHex(source.lockingScript.toHex()),
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, other) => other !== index),
      outputs: tx.outputs,
      inputIndex: index,
      unlockingScript: UnlockingScript.fromHex(input.unlockingScript!.toHex()),
      inputSequence: input.sequence!,
      lockTime: tx.lockTime,
      memoryLimit: 128 * 1024 * 1024
    })
    expect(spend.validate()).toBe(true)
  })
}

/** Offline, disclosed toy identities; the builder receives no private scalar. */
export async function construct(
  previous: Transaction,
  action: RevenueListingProfileAction,
  descriptor = fixture.descriptor,
  fee = 10,
  includeChange = true
) {
  const builder = new RevenueListingProfileSpend(
    profile,
    descriptor,
    [{ rawTransaction: previous.toHex(), outputIndex: 0 }],
    action
  )
  const plan = builder.plan()
  const funding = purchase.inputs[1].sourceTransaction!
  const tx = new Transaction(
    1,
    [
      {
        sourceTXID: previous.id('hex'),
        sourceTransaction: previous,
        sourceOutputIndex: 0,
        sequence: plan.listingSequence,
        unlockingScript: new UnlockingScript()
      },
      {
        sourceTXID: funding.id('hex'),
        sourceTransaction: funding,
        sourceOutputIndex: purchase.inputs[1].sourceOutputIndex,
        sequence: 0xffffffff,
        unlockingScript: new UnlockingScript()
      }
    ],
    plan.outputs.map(output => ({
      satoshis: Number(output.satoshis),
      lockingScript: LockingScript.fromHex(output.lockingScript)
    })),
    plan.lockTime
  )
  const sourceFunding = funding.outputs[purchase.inputs[1].sourceOutputIndex]
  const change =
    previous.outputs[0].satoshis! +
    sourceFunding.satoshis! -
    tx.outputs.reduce((total, output) => total + output.satoshis!, 0) -
    fee
  expect(change).toBeGreaterThan(0)
  if (includeChange)
    tx.addOutput({
      satoshis: change,
      lockingScript: LockingScript.fromHex(sourceFunding.lockingScript.toHex())
    })
  const prepared = builder.prepare(tx)
  const wallet = new ProtoWallet(new PrivateKey(fixture.testActors.seller.scalar))
  const signatures: { seller?: string } = {}
  const requests = prepared.signingRequests()
  expect(requests.length).toBeLessThanOrEqual(1)
  const request = requests[0]
  if (request !== undefined) {
    expect(request.identity).toBe(fixture.testActors.seller.identity)
    const publicKey = await wallet.getPublicKey({
      protocolID: [...request.protocolID],
      keyID: request.keyID,
      counterparty: request.counterparty,
      forSelf: true
    })
    expect(publicKey.publicKey).toBe(request.publicKey)
    expect(request.publicKey).not.toBe(request.identity)
    const signed = await wallet.createSignature({
      protocolID: [...request.protocolID],
      keyID: request.keyID,
      counterparty: request.counterparty,
      data: request.data
    })
    signatures.seller = toHex([...signed.signature, request.scope])
  }
  const completed = prepared.complete(signatures)
  completed.inputs[1].unlockingScript = await new P2PKH()
    .unlock(new PrivateKey(fixture.testActors.funding.scalar))
    .sign(completed, 1)
  prepared.assertFinalLayout(completed)
  expect(completed.inputs[0].unlockingScript!.toBinary().length).toBeLessThanOrEqual(
    builder.estimateUnlockingLength()
  )
  executeAll(completed)
  return { completed, plan, prepared }
}
