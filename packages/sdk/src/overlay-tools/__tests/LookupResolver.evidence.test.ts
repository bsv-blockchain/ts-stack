import LookupResolver, { type LookupFacilitatorAnswer } from '../LookupResolver'
import MerklePath from '../../transaction/MerklePath'
import Transaction from '../../transaction/Transaction'
import P2PKH from '../../script/templates/P2PKH'
import PrivateKey from '../../primitives/PrivateKey'
import Script from '../../script/Script'

const service = 'ls_identity'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function sameTransactionReceipts(): Promise<{ bad: number[]; valid: number[] }> {
  const key = new PrivateKey(42)
  const p2pkh = new P2PKH()
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 10, lockingScript: p2pkh.lock(key.toAddress()) })
  source.merklePath = new MerklePath(700_000, [
    [
      { offset: 0, hash: source.id('hex'), txid: true },
      { offset: 1, duplicate: true }
    ]
  ])

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: p2pkh.unlock(key)
  })
  tx.addOutput({ satoshis: 4, lockingScript: p2pkh.lock(key.toAddress()) })
  await tx.sign()
  const bad = tx.toBEEF()

  const alternate = Transaction.fromBEEF(bad)
  const alternateSource = alternate.inputs[0].sourceTransaction
  if (alternateSource === undefined) throw new Error('fixture source is missing')
  alternateSource.merklePath = new MerklePath(700_000, [
    [
      { offset: 0, hash: alternateSource.id('hex'), txid: true },
      { offset: 1, hash: '42'.repeat(32) }
    ]
  ])
  const valid = alternate.toBEEF()
  expect(Transaction.fromBEEF(bad).id('hex')).toBe(Transaction.fromBEEF(valid).id('hex'))
  return { bad, valid }
}

function resolverFor(
  hosts: string[],
  lookup: (host: string) => Promise<LookupFacilitatorAnswer>
): LookupResolver {
  return new LookupResolver({
    hostOverrides: { [service]: hosts },
    facilitator: { lookup: async host => await lookup(host) }
  })
}

describe('LookupResolver additive evidence intake', () => {
  it('delivers both owned receipts before legacy first-wins aggregation and isolates callback mutations', async () => {
    const { bad, valid } = await sameTransactionReceipts()
    const firstHost = 'https://first.invalid-proof.example'
    const secondHost = 'https://second.valid-proof.example'
    const callbackEvents: Array<{ host: string; beef: number[] }> = []
    const responses: Record<string, LookupFacilitatorAnswer> = {
      [firstHost]: { type: 'output-list', outputs: [{ beef: bad, outputIndex: 0, context: [1] }] },
      [secondHost]: {
        type: 'output-list',
        outputs: [{ beef: valid, outputIndex: 0, context: [2] }]
      }
    }
    const resolver = resolverFor([firstHost, secondHost], async host => responses[host])

    const answer = await resolver.query({ service, query: {} }, undefined, {
      onEvidence: event => {
        if (event.type !== 'output') return
        callbackEvents.push({ host: event.host, beef: event.output.beef.slice() })
        event.output.beef.fill(0)
        event.output.context?.fill(0)
      }
    })

    expect(callbackEvents).toEqual([
      { host: firstHost, beef: bad },
      { host: secondHost, beef: valid }
    ])
    expect(answer.outputs).toEqual([{ beef: bad, outputIndex: 0, context: [1] }])
    expect(responses[firstHost]).toEqual({
      type: 'output-list',
      outputs: [{ beef: bad, outputIndex: 0, context: [1] }]
    })
    expect(responses[secondHost]).toEqual({
      type: 'output-list',
      outputs: [{ beef: valid, outputIndex: 0, context: [2] }]
    })
  })

  it('does not emit untrusted receipts for malformed, empty, or freeform answers', async () => {
    const malformedHost = 'https://malformed.example'
    const emptyHost = 'https://empty.example'
    const freeformHost = 'https://freeform.example'
    const resolver = resolverFor([malformedHost, emptyHost, freeformHost], async host => {
      if (host === malformedHost)
        return { type: 'output-list', outputs: [{ beef: [], outputIndex: 0 }] } as never
      if (host === emptyHost) return { type: 'output-list', outputs: [] }
      return { type: 'freeform', result: { untrusted: true } }
    })
    const received: unknown[] = []

    await expect(
      resolver.query({ service, query: {} }, undefined, {
        onEvidence: event => received.push(event)
      })
    ).resolves.toEqual({
      type: 'output-list',
      outputs: []
    })
    expect(received).toEqual([])
  })

  it('isolates a synchronous callback failure from the legacy answer', async () => {
    const { bad } = await sameTransactionReceipts()
    const resolver = resolverFor(['https://callback-throws.example'], async () => ({
      type: 'output-list',
      outputs: [{ beef: bad, outputIndex: 0 }]
    }))

    await expect(
      resolver.query({ service, query: {} }, undefined, {
        onEvidence: () => {
          throw new Error('consumer failure')
        }
      })
    ).resolves.toEqual({ type: 'output-list', outputs: [{ beef: bad, outputIndex: 0 }] })
  })

  it('closes evidence delivery when a progressive iterator is closed before a late host responds', async () => {
    const { bad, valid } = await sameTransactionReceipts()
    const firstHost = 'https://fast.example'
    const lateHost = 'https://late.example'
    const late = deferred<LookupFacilitatorAnswer>()
    const events: string[] = []
    const resolver = resolverFor([firstHost, lateHost], async host =>
      host === firstHost
        ? { type: 'output-list', outputs: [{ beef: bad, outputIndex: 0 }] }
        : await late.promise
    )
    const iterator = resolver
      .query$({ service, query: {} }, undefined, {
        graceMs: 0,
        onEvidence: event => {
          if (event.type === 'output') events.push(event.host)
        }
      })
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await iterator.return?.()
    late.resolve({ type: 'output-list', outputs: [{ beef: valid, outputIndex: 0 }] })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(events).toEqual([firstHost])
  })

  it('reports each bounded intake limit once while preserving the legacy aggregation', async () => {
    const { bad } = await sameTransactionReceipts()
    const manyOutputs = Array.from({ length: 513 }, () => ({ beef: bad.slice(), outputIndex: 0 }))
    const countEvents: Array<'output' | 'limit'> = []
    const countResolver = resolverFor(['https://count-limit.example'], async () => ({
      type: 'output-list',
      outputs: manyOutputs
    }))

    const counted = await countResolver.query({ service, query: {} }, undefined, {
      onEvidence: event => countEvents.push(event.type)
    })
    expect(countEvents.filter(type => type === 'output')).toHaveLength(512)
    expect(countEvents.filter(type => type === 'limit')).toHaveLength(1)
    expect(counted.outputs).toEqual([{ beef: bad, outputIndex: 0 }])

    const bytesEvents: Array<'output' | 'limit'> = []
    const tooLarge = Array.from({ length: 16 * 1024 * 1024 + 1 }, () => 0)
    const bytesResolver = resolverFor(['https://bytes-limit.example'], async () => ({
      type: 'output-list',
      outputs: [{ beef: tooLarge, outputIndex: 0 }]
    }))
    await bytesResolver.query({ service, query: {} }, undefined, {
      onEvidence: event => bytesEvents.push(event.type)
    })
    expect(bytesEvents).toEqual(['limit'])
  })

  it('applies caller-configured evidence limits without changing legacy aggregation', async () => {
    const { bad, valid } = await sameTransactionReceipts()
    const outputs = [
      { beef: bad, outputIndex: 0 },
      { beef: valid, outputIndex: 0 }
    ]
    const resolver = resolverFor(['https://configured-limits.example'], async () => ({
      type: 'output-list',
      outputs
    }))
    const limited: Array<'output' | 'limit'> = []
    const answer = await resolver.query({ service, query: {} }, undefined, {
      evidenceLimits: { maxOutputs: 1, maxBytes: bad.length * 2 },
      onEvidence: event => limited.push(event.type)
    })
    expect(limited).toEqual(['output', 'limit'])
    expect(answer.outputs).toEqual([{ beef: bad, outputIndex: 0 }])

    const admitted: Array<'output' | 'limit'> = []
    await resolver.query({ service, query: {} }, undefined, {
      evidenceLimits: { maxOutputs: 2, maxBytes: bad.length + valid.length },
      onEvidence: event => admitted.push(event.type)
    })
    expect(admitted).toEqual(['output', 'output'])
  })
})
