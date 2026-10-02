import { fixturePromise } from './private-async.fixture.js'
import { jest } from '@jest/globals'
import {
  OutputPaidLookupTransport,
  type OutputPaidLookupAcquired,
  type OutputPaidLookupQuote
} from '@bsv/sdk'
import type { buyerFixture } from './private-lookup-buyer.fixture.js'
export function buyerRemote(f: Awaited<ReturnType<typeof buyerFixture>>): {
  calls: string[]
  send: { mockRestore(): void }
  delivered: OutputPaidLookupAcquired
  lose(value: 'quote' | 'pay'): void
} {
  const quote = f.f.quote.challenge,
    funding = { chain: f.f.f.chain, txid: f.f.f.transaction.id('hex'), outputIndex: 1 },
    quoted: OutputPaidLookupAcquired = {
      version: 1,
      acquisitionId: quote.acquisitionId,
      status: 'quoted',
      challenge: quote,
      recoveryUntil: quote.recoveryUntil
    },
    delivered: OutputPaidLookupAcquired = {
      ...quoted,
      status: 'delivered',
      funding,
      acceptance: {
        chain: funding.chain,
        txid: funding.txid,
        policy: quote.acceptancePolicy,
        acceptedAt: '21'
      },
      result: { evidence: f.f.evidence, context: 'AQID', schema: 'urn:test:buyer-material' }
    }
  let quotedRemotely = false,
    paidRemotely = false,
    lose: 'quote' | 'pay' | undefined
  const calls: string[] = []
  const send = jest.spyOn(OutputPaidLookupTransport.prototype, 'send').mockImplementation(function (
    this: OutputPaidLookupTransport<'quote'>
  ) {
    return fixturePromise(() => {
      const operation = (this as unknown as { operation: string }).operation
      calls.push(operation)
      if (operation === 'quote') {
        quotedRemotely = true
        if (lose === 'quote') {
          lose = undefined
          throw new Error('Lost original quote')
        }
        return { kind: 'challenge', challenge: quote } as OutputPaidLookupQuote
      }
      if (operation === 'pay') {
        paidRemotely = true
        if (lose === 'pay') {
          lose = undefined
          throw new Error('Lost original delivery')
        }
        return delivered as unknown as OutputPaidLookupQuote
      }
      if (!quotedRemotely) throw new Error('Unexpected recovery before any quote')
      return (paidRemotely ? delivered : quoted) as unknown as OutputPaidLookupQuote
    })
  })
  return {
    calls,
    send,
    delivered,
    lose: (value: 'quote' | 'pay') => {
      lose = value
    }
  }
}
