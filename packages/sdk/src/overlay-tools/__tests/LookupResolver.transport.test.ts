import {
  HTTPSOverlayLookupFacilitator,
  LookupResourceLimitError,
  type LookupAnswer,
  type LookupFacilitatorAnswer
} from '../LookupResolver'
import { Transaction } from '../../transaction/index'
import { LockingScript } from '../../script/index'

const question = { service: 'ls_transport', query: { id: 1 } }
const host = 'https://transport.example'

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const octetResponse = (payload: Uint8Array): Response =>
  new Response(payload, { headers: { 'content-type': 'application/octet-stream' } })

/**
 * Structurally parseable receipt. Parsing BEEF here makes no chain-validity
 * claim; these tests only exercise the transport's own byte and count bounds.
 */
function transaction(scriptBytes: number, satoshis = 1): Transaction {
  return new Transaction(
    1,
    [],
    [{ lockingScript: LockingScript.fromHex('00'.repeat(scriptBytes)), satoshis }],
    0
  )
}

/**
 * Aggregated octet-stream wire format: varint outpoint count, then per outpoint
 * a 32-byte txid, a varint output index and a varint-prefixed context, followed
 * by the shared BEEF. `repeats` outpoints all reference the same transaction.
 */
function octetPayload(tx: Transaction, repeats: number): Buffer {
  const txid = Buffer.from(tx.id('hex'), 'hex')
  const outpoints = Array.from({ length: repeats }, (_unused, index) =>
    Buffer.concat([txid, Buffer.from([index]), Buffer.from([0x00])])
  )
  return Buffer.concat([Buffer.from([repeats]), ...outpoints, Buffer.from(tx.toBEEF())])
}

function outputsOf(answer: LookupFacilitatorAnswer): LookupAnswer['outputs'] {
  if (answer.type !== 'output-list') throw new Error('expected an output-list answer')
  return answer.outputs
}

async function caught(work: Promise<unknown>): Promise<unknown> {
  return await work.then(
    () => {
      throw new Error('expected the lookup to reject')
    },
    (error: unknown) => error
  )
}

describe('HTTPSOverlayLookupFacilitator bounded transport', () => {
  it('refuses to issue a request when the caller signal is already aborted', async () => {
    const fetchClient = jest.fn()
    const facilitator = new HTTPSOverlayLookupFacilitator(
      fetchClient as unknown as typeof fetch,
      true
    )
    const controller = new AbortController()
    controller.abort()

    const error = await caught(facilitator.lookup(host, question, 2000, controller.signal))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('AbortError')
    expect((error as Error).message).toBe('Lookup cancelled')
    expect(fetchClient).not.toHaveBeenCalled()
  })

  it('reports cancellation, not an HTTP failure, when the caller aborts as the response arrives', async () => {
    const controller = new AbortController()
    let issued: Response | undefined
    const fetchClient = jest.fn(async () => {
      controller.abort()
      issued = new Response('service unavailable', { status: 503, statusText: 'Unavailable' })
      return issued
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(
      fetchClient as unknown as typeof fetch,
      true
    )

    const error = await caught(facilitator.lookup(host, question, 2000, controller.signal))
    // Let the in-flight request settle so its body cleanup is observable.
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect((error as Error).name).toBe('AbortError')
    expect((error as Error).message).toBe('Lookup cancelled')
    // A cancelled request must not leave the response body undrained.
    expect(issued?.bodyUsed).toBe(true)
  })

  it('rejects a JSON output list longer than the requested output budget', async () => {
    const answer = {
      type: 'output-list',
      outputs: [
        { beef: transaction(1, 1).toBEEF(), outputIndex: 0 },
        { beef: transaction(1, 2).toBEEF(), outputIndex: 0 }
      ]
    }
    const facilitator = new HTTPSOverlayLookupFacilitator(
      jest.fn(async () => jsonResponse(answer)) as unknown as typeof fetch,
      true
    )

    const error = await caught(
      facilitator.lookup(host, question, 2000, undefined, { maxOutputs: 1 })
    )
    expect(error).toBeInstanceOf(LookupResourceLimitError)
    expect((error as LookupResourceLimitError).limit).toBe('maxOutputs')

    // The bound is inclusive: exactly maxOutputs is still accepted.
    const accepted = await facilitator.lookup(host, question, 2000, undefined, { maxOutputs: 2 })
    expect(outputsOf(accepted)).toHaveLength(2)
  })

  it('rejects an octet-stream outpoint count that is negative or over the output budget', async () => {
    const tx = transaction(4)
    const overBudget = new HTTPSOverlayLookupFacilitator(
      jest.fn(async () => octetResponse(octetPayload(tx, 3))) as unknown as typeof fetch,
      true
    )
    const tooMany = await caught(
      overBudget.lookup(host, question, 2000, undefined, { maxOutputs: 2 })
    )
    expect(tooMany).toBeInstanceOf(LookupResourceLimitError)
    expect((tooMany as LookupResourceLimitError).limit).toBe('maxOutputs')

    // 0xff + eight 0xff bytes decodes as -1: a count that must never be trusted.
    const negativeCount = Buffer.concat([
      Buffer.from([0xff]),
      Buffer.alloc(8, 0xff),
      Buffer.from(tx.toBEEF())
    ])
    const negative = new HTTPSOverlayLookupFacilitator(
      jest.fn(async () => octetResponse(negativeCount)) as unknown as typeof fetch,
      true
    )
    const malformed = await caught(
      negative.lookup(host, question, 2000, undefined, { maxOutputs: 64 })
    )
    expect(malformed).toBeInstanceOf(LookupResourceLimitError)
    expect((malformed as LookupResourceLimitError).limit).toBe('maxOutputs')
  })

  it('stops octet-stream extraction once the extracted bytes exceed the response budget', async () => {
    const tx = transaction(400)
    const payload = octetPayload(tx, 3)
    const beefBytes = tx.toBEEF().length
    // Three outpoints on one transaction extract three atomic BEEF copies, so
    // the retained total outruns the wire length the reader already accepted.
    expect(2 * beefBytes).toBeGreaterThan(payload.length + 1)
    const facilitator = new HTTPSOverlayLookupFacilitator(
      jest.fn(async () => octetResponse(payload)) as unknown as typeof fetch,
      true
    )

    const error = await caught(
      facilitator.lookup(host, question, 2000, undefined, {
        maxResponseBytes: payload.length + 1,
        maxOutputs: 8
      })
    )
    expect(error).toBeInstanceOf(LookupResourceLimitError)
    expect((error as LookupResourceLimitError).limit).toBe('maxResponseBytes')

    const accepted = await facilitator.lookup(host, question, 2000, undefined, {
      maxResponseBytes: 4 * beefBytes,
      maxOutputs: 8
    })
    const outputs = outputsOf(accepted)
    expect(outputs).toHaveLength(3)
    expect(outputs.map(output => output.txid)).toEqual([tx.id('hex'), tx.id('hex'), tx.id('hex')])
  })

  it('abandons octet-stream extraction when the caller cancels mid-decode', async () => {
    const controller = new AbortController()
    const tx = transaction(8)
    const payload = octetPayload(tx, 60)
    let scheduled = false
    const facilitator = new HTTPSOverlayLookupFacilitator(
      jest.fn(async () => octetResponse(payload)) as unknown as typeof fetch,
      true
    )

    const startedAt = Date.now()
    const error = await caught(
      facilitator.lookup(host, question, 5000, controller.signal, {
        maxResponseBytes: 1_000_000,
        maxOutputs: 128,
        // Cancel once the transport has begun reporting bytes: extraction
        // yields to the event loop between outputs and must observe the abort.
        consumeBytes: () => {
          if (scheduled) return
          scheduled = true
          setTimeout(() => controller.abort(), 0)
        }
      })
    )
    // The abandoned decode is detached from the caller-facing promise; give it
    // an event-loop turn so its own cancellation check runs before teardown.
    await new Promise<void>(resolve => setTimeout(resolve, 30))

    expect((error as Error).name).toBe('AbortError')
    expect((error as Error).message).toBe('Lookup cancelled')
    // Cancellation settles the request rather than waiting out the 5s deadline.
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })
})
