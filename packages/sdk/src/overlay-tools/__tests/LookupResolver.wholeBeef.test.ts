import LookupResolver, {
  HTTPSOverlayLookupFacilitator,
  LookupHTTPError,
  type LookupFacilitatorAnswer,
  type LookupRequestOptions
} from '../LookupResolver'
import { getOverlayHostReputationTracker } from '../HostReputationTracker'
import OverlayAdminTokenTemplate from '../OverlayAdminTokenTemplate'
import { CompletedProtoWallet } from '../../auth/certificates/__tests/CompletedProtoWallet'
import PrivateKey from '../../primitives/PrivateKey'
import { Beef } from '../../transaction/Beef'
import MerklePath from '../../transaction/MerklePath'
import Transaction from '../../transaction/Transaction'
import Script from '../../script/Script'

const service = 'ls_history'
const question = { service, query: { findAll: true } }
const host = 'https://history.example'

interface History {
  /** BEEF as an overlay Engine `history` selector returns it: every hop, subject last. */
  beef: number[]
  subject: string
  proven: string
  ancestor: string
}

/**
 * ancestor (unproven) <- proven (has a merkle path) <- subject (unproven).
 * Ordinary SPV serialization of `subject` stops at `proven`; a lookup service
 * that selects topical history keeps `ancestor` as well.
 */
function historyBeef(): History {
  const ancestor = new Transaction()
  ancestor.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  ancestor.addOutput({ satoshis: 3, lockingScript: Script.fromASM('OP_TRUE') })
  const proven = new Transaction()
  proven.addInput({
    sourceTransaction: ancestor,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  proven.addOutput({ satoshis: 2, lockingScript: Script.fromASM('OP_TRUE') })
  proven.merklePath = new MerklePath(700_000, [
    [
      { offset: 0, hash: proven.id('hex'), txid: true },
      { offset: 1, duplicate: true }
    ]
  ])
  const subject = new Transaction()
  subject.addInput({
    sourceTransaction: proven,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  subject.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })

  const subjectId = subject.id('hex')
  const beef = Beef.fromBinary(subject.toBEEF())
  beef.mergeRawTx(ancestor.toBinary())
  beef.sortTxs()
  const last = beef.findTxid(subjectId)
  if (last === undefined) throw new Error('fixture subject is missing')
  beef.txs = [...beef.txs.filter(tx => tx.txid !== subjectId), last]
  return {
    beef: beef.toBinary(),
    subject: subjectId,
    proven: proven.id('hex'),
    ancestor: ancestor.id('hex')
  }
}

function txidsOf(beef: number[]): string[] {
  return Beef.fromBinary(beef).txs.map(tx => tx.txid)
}

/** The aggregated wire form: one outpoint (output 0, no context) and the shared BEEF. */
function aggregatedPayload(subject: string, beef: number[]): Uint8Array {
  return Uint8Array.from([1, ...Buffer.from(subject, 'hex'), 0, 0, ...beef])
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries())
}

describe('HTTPSOverlayLookupFacilitator wholeBeef', () => {
  const history = historyBeef()

  it('builds a fixture whose ordinary SPV form omits the ancestor behind the proof', () => {
    expect(txidsOf(history.beef).sort()).toEqual(
      [history.ancestor, history.proven, history.subject].sort()
    )
    expect(Transaction.fromBEEF(history.beef).id('hex')).toBe(history.subject)
    expect(txidsOf(Beef.fromBinary(history.beef).toBinaryAtomic(history.subject)).sort()).toEqual(
      [history.proven, history.subject].sort()
    )
  })

  it('by default asks for the aggregated answer and extracts each output up to its first proof', async () => {
    // Synthetic: overlay-express's own aggregation already omits the ancestor.
    // This pins that the resolver's extraction would drop it too.
    const fetchClient = jest.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(aggregatedPayload(history.subject, history.beef), {
          headers: { 'content-type': 'application/octet-stream' }
        })
    )
    const facilitator = new HTTPSOverlayLookupFacilitator(fetchClient as unknown as typeof fetch)

    const answer = await facilitator.lookup(host, question)

    expect(headersOf(fetchClient.mock.calls[0][1])['x-aggregation']).toBe('yes')
    if (answer.type !== 'output-list') throw new Error('expected an output list')
    expect(answer.outputs).toHaveLength(1)
    expect(answer.outputs[0].txid).toBe(history.subject)
    // Unchanged default: the ancestor the host sent is not in the extracted output.
    expect(txidsOf(answer.outputs[0].beef)).not.toContain(history.ancestor)
  })

  it('omits the aggregation header and returns each output BEEF as the host sent it', async () => {
    const fetchClient = jest.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            type: 'output-list',
            outputs: [{ beef: history.beef, outputIndex: 0, context: [7] }]
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    const facilitator = new HTTPSOverlayLookupFacilitator(fetchClient as unknown as typeof fetch)

    const answer = await facilitator.lookup(host, question, 2000, undefined, { wholeBeef: true })

    const headers = headersOf(fetchClient.mock.calls[0][1])
    expect(headers).not.toHaveProperty('x-aggregation')
    expect(headers['content-type']).toBe('application/json')
    expect(answer).toEqual({
      type: 'output-list',
      outputs: [{ beef: history.beef, outputIndex: 0, context: [7] }]
    })
    if (answer.type !== 'output-list') throw new Error('expected an output list')
    expect(txidsOf(answer.outputs[0].beef)).toContain(history.ancestor)
  })

  it('treats wholeBeef: false like the default', async () => {
    const fetchClient = jest.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ type: 'output-list', outputs: [] }), {
          headers: { 'content-type': 'application/json' }
        })
    )
    const facilitator = new HTTPSOverlayLookupFacilitator(fetchClient as unknown as typeof fetch)

    await facilitator.lookup(host, question, 2000, undefined, { wholeBeef: false })

    expect(headersOf(fetchClient.mock.calls[0][1])['x-aggregation']).toBe('yes')
  })

  it('refuses an aggregated binary answer to a wholeBeef request and releases its body', async () => {
    let issued: Response | undefined
    const fetchClient = jest.fn(async () => {
      issued = new Response(aggregatedPayload(history.subject, history.beef), {
        headers: { 'content-type': 'Application/Octet-Stream; charset=binary' }
      })
      return issued
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(fetchClient as unknown as typeof fetch)

    const error = await facilitator
      .lookup(host, question, 2000, undefined, { wholeBeef: true })
      .then(
        () => undefined,
        (reason: unknown) => reason
      )
    expect(error).toBeInstanceOf(LookupHTTPError)
    expect((error as LookupHTTPError).kind).toBe('semantic')
    expect((error as LookupHTTPError).status).toBe(200)
    expect((error as LookupHTTPError).message).toContain('whole-BEEF')
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(issued?.bodyUsed).toBe(true)
  })

  // Only an application/octet-stream answer is recognised as the aggregated
  // form. A binary body under any other content type is read as JSON, as it
  // is for a default lookup, and fails as an ordinary malformed answer.
  it.each([
    ['no content type', undefined],
    ['a JSON content type', 'application/json']
  ])(
    'reads a binary answer with %s as JSON and fails it as malformed',
    async (_label, contentType) => {
      const fetchClient = jest.fn(
        async () =>
          new Response(
            aggregatedPayload(history.subject, history.beef),
            contentType === undefined ? {} : { headers: { 'content-type': contentType } }
          )
      )
      const facilitator = new HTTPSOverlayLookupFacilitator(fetchClient as unknown as typeof fetch)

      const error = await facilitator
        .lookup(host, question, 2000, undefined, { wholeBeef: true })
        .then(
          () => undefined,
          (reason: unknown) => reason
        )
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(LookupHTTPError)
      expect((error as Error).message).toBe('Overlay response is not valid UTF-8.')
    }
  )
})

describe('LookupResolver wholeBeef', () => {
  const history = historyBeef()
  const hostTracker = getOverlayHostReputationTracker()
  beforeEach(() => hostTracker.reset())

  function recordingFacilitator(answers: (url: string, q: { service: string }) => unknown): {
    calls: Array<{ url: string; service: string; options?: LookupRequestOptions }>
    facilitator: { lookup: jest.Mock }
  } {
    const calls: Array<{ url: string; service: string; options?: LookupRequestOptions }> = []
    const lookup = jest.fn(
      async (
        url: string,
        q: { service: string },
        _timeout?: number,
        _signal?: AbortSignal,
        options?: LookupRequestOptions
      ) => {
        calls.push({ url, service: q.service, options })
        return answers(url, q) as LookupFacilitatorAnswer
      }
    )
    return { calls, facilitator: { lookup } }
  }

  it('passes the flag to host lookups only when requested', async () => {
    const { calls, facilitator } = recordingFacilitator(() => ({
      type: 'output-list',
      outputs: [{ beef: history.beef, outputIndex: 0 }]
    }))
    const resolver = new LookupResolver({ facilitator, hostOverrides: { [service]: [host] } })

    await resolver.query(question)
    const whole = await resolver.query(question, undefined, { wholeBeef: true })

    expect(calls).toHaveLength(2)
    expect(calls[0].options).not.toHaveProperty('wholeBeef')
    expect(calls[1].options).toEqual(expect.objectContaining({ wholeBeef: true }))
    expect(whole.outputs).toEqual([{ beef: history.beef, outputIndex: 0 }])
  })

  it('keeps SLAP discovery aggregated while discovered hosts get the flag', async () => {
    const slapScript = await new OverlayAdminTokenTemplate(
      new CompletedProtoWallet(new PrivateKey(42))
    ).lock('SLAP', host, service)
    const slapTx = new Transaction(1, [], [{ lockingScript: slapScript, satoshis: 1 }], 0)
    const { calls, facilitator } = recordingFacilitator((_url, q) =>
      q.service === 'ls_slap'
        ? { type: 'output-list', outputs: [{ beef: slapTx.toBEEF(), outputIndex: 0 }] }
        : { type: 'output-list', outputs: [{ beef: history.beef, outputIndex: 0 }] }
    )
    const resolver = new LookupResolver({ facilitator, slapTrackers: ['https://tracker.example'] })

    const answer = await resolver.query(question, undefined, { wholeBeef: true })

    expect(calls.map(call => [call.url, call.service])).toEqual([
      ['https://tracker.example', 'ls_slap'],
      [host, service]
    ])
    expect(calls[0].options).not.toHaveProperty('wholeBeef')
    expect(calls[1].options).toEqual(expect.objectContaining({ wholeBeef: true }))
    expect(answer.outputs).toEqual([{ beef: history.beef, outputIndex: 0 }])
    expect(txidsOf(answer.outputs[0].beef)).toContain(history.ancestor)
  })

  it('carries the whole BEEF through the HTTPS facilitator', async () => {
    const seen: Array<Record<string, string>> = []
    const fetchClient = async (_url: string, init?: RequestInit): Promise<Response> => {
      seen.push(headersOf(init))
      return new Response(
        JSON.stringify({ type: 'output-list', outputs: [{ beef: history.beef, outputIndex: 0 }] }),
        { headers: { 'content-type': 'application/json' } }
      )
    }
    const resolver = new LookupResolver({
      facilitator: new HTTPSOverlayLookupFacilitator(fetchClient as unknown as typeof fetch),
      hostOverrides: { [service]: [host] }
    })

    const answer = await resolver.query(question, undefined, { wholeBeef: true })

    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toHaveProperty('x-aggregation')
    expect(answer.outputs).toEqual([{ beef: history.beef, outputIndex: 0 }])
  })

  /** A host that always answers in binary, as one ignoring the absent header would. */
  const binaryHost = 'https://binary.example'
  const jsonHost = 'https://json.example'
  function mixedFetch(seen: string[] = []): typeof fetch {
    return (async (url: string) => {
      seen.push(new URL(url).origin)
      if (new URL(url).origin === binaryHost) {
        return new Response(aggregatedPayload(history.subject, history.beef), {
          headers: { 'content-type': 'application/octet-stream' }
        })
      }
      return new Response(
        JSON.stringify({ type: 'output-list', outputs: [{ beef: history.beef, outputIndex: 0 }] }),
        { headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch
  }

  it('counts a host that answers a wholeBeef query in binary as a rejection, not a failure', async () => {
    const unreachable = jest.fn()
    const resolver = new LookupResolver({
      facilitator: new HTTPSOverlayLookupFacilitator(mixedFetch()),
      hostOverrides: { [service]: [binaryHost] }
    })

    const { answer, progress } = await resolver.queryDetailed(question, undefined, {
      wholeBeef: true,
      onUnreachableHost: unreachable
    })

    expect(answer.outputs).toEqual([])
    expect(progress.rejectedHosts).toBe(1)
    expect(progress.failedHosts).toBe(0)
    expect(progress.successfulHosts).toBe(0)
    expect(unreachable).not.toHaveBeenCalled()
  })

  it('keeps only the JSON host answer when another host answers in binary', async () => {
    const evidence: Array<{ host: string; beef: number[] }> = []
    const resolver = new LookupResolver({
      facilitator: new HTTPSOverlayLookupFacilitator(mixedFetch()),
      hostOverrides: { [service]: [binaryHost, jsonHost] }
    })

    const { answer, progress } = await resolver.queryDetailed(question, undefined, {
      wholeBeef: true,
      onEvidence: event => {
        if (event.type === 'output') evidence.push({ host: event.host, beef: event.output.beef })
      }
    })

    expect(answer.outputs).toEqual([{ beef: history.beef, outputIndex: 0 }])
    expect(progress.successfulHosts).toBe(1)
    expect(progress.rejectedHosts).toBe(1)
    expect(evidence).toEqual([{ host: jsonHost, beef: history.beef }])
  })

  it('takes the last transaction as the subject and drops an output whose txid names another', async () => {
    const answerWith = (txid: string): typeof fetch =>
      (async () =>
        new Response(
          JSON.stringify({
            type: 'output-list',
            outputs: [{ beef: history.beef, outputIndex: 0, txid }]
          }),
          { headers: { 'content-type': 'application/json' } }
        )) as unknown as typeof fetch
    const resolverFor = (txid: string): LookupResolver =>
      new LookupResolver({
        facilitator: new HTTPSOverlayLookupFacilitator(answerWith(txid)),
        hostOverrides: { [service]: [host] }
      })

    const matching = await resolverFor(history.subject).query(question, undefined, {
      wholeBeef: true
    })
    const other = await resolverFor(history.proven).query(question, undefined, { wholeBeef: true })

    expect(matching.outputs).toEqual([
      { beef: history.beef, outputIndex: 0, txid: history.subject }
    ])
    expect(other.outputs).toEqual([])
  })

  it('counts a binary answer without its content type as a failure, with the usual penalty', async () => {
    const untypedHost = 'https://untyped.example'
    const resolver = new LookupResolver({
      facilitator: new HTTPSOverlayLookupFacilitator(
        (async () =>
          new Response(aggregatedPayload(history.subject, history.beef))) as unknown as typeof fetch
      ),
      hostOverrides: { [service]: [untypedHost] }
    })

    const { answer, progress } = await resolver.queryDetailed(question, undefined, {
      wholeBeef: true
    })

    expect(answer.outputs).toEqual([])
    expect(progress.failedHosts).toBe(1)
    expect(progress.rejectedHosts).toBe(0)
    expect(hostTracker.snapshot(untypedHost)?.totalFailures).toBe(1)
    expect(hostTracker.snapshot(untypedHost)?.lastError).toBe(
      'Overlay response is not valid UTF-8.'
    )
  })

  it('does not back off a host for default lookups after it rejects wholeBeef lookups', async () => {
    const seen: string[] = []
    const resolver = new LookupResolver({
      facilitator: new HTTPSOverlayLookupFacilitator(mixedFetch(seen)),
      hostOverrides: { [service]: [binaryHost] }
    })

    for (let attempt = 0; attempt < 5; attempt++) {
      await resolver.queryDetailed(question, undefined, { wholeBeef: true })
    }
    const answer = await resolver.query(question)

    expect(seen).toEqual(Array(6).fill(binaryHost))
    expect(answer.outputs).toHaveLength(1)
    expect(answer.outputs[0].txid).toBe(history.subject)
  })
})
