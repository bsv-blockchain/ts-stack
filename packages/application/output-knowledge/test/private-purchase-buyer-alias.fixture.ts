import {
  outputAssert,
  OutputProtocolError,
  type OutputPurchaseEnvelope,
  type OutputPurchaseTransport
} from '@bsv/sdk'
import { PrivatePurchaseBuyerAliasCurrentness } from '../src/private/PrivatePurchaseBuyerAliasCurrentness.js'
import { purchaseBuyerFixture } from './private-purchase-buyer.fixture.js'

/** Independent native buyer/server custody and controlled domain/chain premises.
 * The deliberately synthetic alias representation is not Bitcoin/SPV proof;
 * the genuine SDK ancestry corpus is tested separately. */
export function purchaseBuyerAliasFixture() {
  const f = purchaseBuyerFixture('full-purchase-commitment-v1'),
    send = f.wire.getMockImplementation()!,
    verify = f.partial.validation.candidateBinding!,
    aliasTxid = 'cd'.repeat(32)
  let reports = true,
    chainCurrent = true,
    commitmentValid = true,
    available = true
  const counts = { domainAliases: 0, chains: 0 }
  f.partial.validation.candidateBinding = async (...args) => {
    const result = await verify(...args)
    if (args[2].txid !== aliasTxid) return result
    counts.domainAliases++
    return {
      ...result,
      purchaseCommitment: commitmentValid ? result.purchaseCommitment : 'ef'.repeat(32)
    }
  }
  f.wire.mockImplementation(async function (this: OutputPurchaseTransport<'prepare'>, ...args) {
    const result = await send.apply(this, args)
    const packet = result as unknown as OutputPurchaseEnvelope
    const operation = (this as unknown as { operation: string }).operation
    if (
      reports &&
      operation === 'recover' &&
      'result' in packet &&
      packet.result.status === 'delivered'
    )
      packet.currentAlias = { txid: aliasTxid, beef: f.server.f.candidate.beef }
    return result
  })
  const make = () =>
    new PrivatePurchaseBuyerAliasCurrentness({
      seller: f.server.f.f.f.installation.seller,
      domainProfile: f.server.f.custody.original.terms.body.domainProfile,
      validation: f.partial.validation,
      currentness: {
        async assess(subject, candidate) {
          counts.chains++
          outputAssert(
            subject.acquisitionId === candidate.acquisitionId,
            'Controlled alias subject mismatch'
          )
          if (!available) return undefined
          if (!chainCurrent)
            throw new OutputProtocolError(
              'context-changed',
              'Controlled buyer selected chain changed'
            )
          await Promise.resolve()
          return {
            currentAlias: { txid: candidate.txid, beef: candidate.beef },
            contextId: 'controlled-buyer-currentness',
            chainPolicyDigest: 'c0'.repeat(32),
            blockHash: 'c1'.repeat(32),
            height: '1',
            tipHash: 'c1'.repeat(32),
            tipHeight: '1',
            placement: {
              checkCurrent() {
                outputAssert(
                  chainCurrent,
                  'Controlled buyer selected chain changed',
                  'context-changed'
                )
              }
            }
          }
        }
      }
    })
  return {
    f,
    counts,
    aliasTxid,
    make,
    report(value: boolean) {
      reports = value
    },
    current(value: boolean) {
      chainCurrent = value
    },
    validCommitment(value: boolean) {
      commitmentValid = value
    },
    available(value: boolean) {
      available = value
    }
  }
}
