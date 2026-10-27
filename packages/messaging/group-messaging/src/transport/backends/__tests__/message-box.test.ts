import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeEnvelope } from '../../../bootstrap/index.js'
import type { StorageTable } from '../../../storage/index.js'
import { DEFAULT_CIPHERSUITE } from '../../../types.js'
import { GroupMessagingClient } from '../../../client.js'
import { PermanentProcessingError } from '../../../errors.js'
import { TransportService } from '../../transport-service.js'
import { encodeBody } from '../message-box-body.js'
import {
  DEFAULT_MESSAGE_BOX,
  LIVE_BACKSTOP_INTERVAL_MS,
  MAX_REMEMBERED_MESSAGES,
  MessageBoxTransport,
  type ClientLiveState,
  type ClientLiveStatus,
  type LiveStatus
} from '../message-box.js'

/**
 * The real client's `tryParse`: every inbound body is `JSON.parse`d before the
 * caller sees it, falling back to the raw string only when that fails.
 */
const tryParse = (raw: string): string | Record<string, unknown> => {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return raw
  }
}

/** Arrival times, one second apart, in the order the test pushed them. */
const ARRIVED_AT = Date.UTC(2026, 7, 20, 12, 0, 0)
const arrivalOf = (index: number): string => new Date(ARRIVED_AT + index * 1000).toISOString()

/**
 * A MessageBox the test drives: put messages in, watch what is acknowledged.
 *
 * Two things it copies from the real client on purpose. `listMessages` mirrors
 * `tryParse`, because every body this backend sends is valid JSON and so always
 * comes back pre-parsed into an object in production — a fake that returned the
 * string verbatim would never catch a `decodeBody` that only handled one of the
 * two forms. And it hands the batch back reversed, because the real client
 * merges hosts into a Map and sorts on a field its own types do not declare:
 * `inbox` order is the truth, `created_at` carries it, and the order on the
 * wire is deliberately not it.
 *
 * `acknowledgeMessage` rejects an empty list, as the real one does, so a call
 * that should never have been made cannot pass unnoticed.
 */
const fakeClient = (host?: string) => ({
  sent: [] as Array<{ recipient: string; messageBox: string; body: string }>,
  inbox: [] as Array<{ messageId: string; sender: string; body: string; created_at?: string }>,
  acked: [] as string[],
  listed: [] as Array<{ messageBox: string; acceptPayments?: boolean; host?: string }>,
  ...(host !== undefined && { host }),
  async sendMessage(args: { recipient: string; messageBox: string; body: string }) {
    this.sent.push(args)
    return {}
  },
  async listMessages(args: { messageBox: string; acceptPayments?: boolean; host?: string }) {
    this.listed.push(args)
    return this.inbox
      .map((message, index) => ({
        ...message,
        created_at: message.created_at ?? arrivalOf(index),
        body: tryParse(message.body)
      }))
      .reverse()
  },
  async acknowledgeMessage(args: { messageIds: string[]; host?: string }) {
    if (args.messageIds.length === 0) throw new Error('Message IDs array cannot be empty')
    this.acked.push(...args.messageIds)
    this.inbox = this.inbox.filter(message => !args.messageIds.includes(message.messageId))
    return {}
  }
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('MessageBoxTransport', () => {
  it('sends a payload as a versioned body to the default box', async () => {
    const client = fakeClient()
    const transport = new MessageBoxTransport(client)

    await transport.send('02bb', Uint8Array.from([7, 8]))

    expect(client.sent).toHaveLength(1)
    expect(client.sent[0]!.recipient).toBe('02bb')
    expect(client.sent[0]!.messageBox).toBe(DEFAULT_MESSAGE_BOX)
    expect(JSON.parse(client.sent[0]!.body)).toMatchObject({ v: 1 })
  })

  it('delivers what it polls, and acknowledges it once the handler succeeds', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client)

    const seen: Array<{ from: string; payload: Uint8Array }> = []
    transport.onMessage(async (from, payload) => {
      seen.push({ from, payload })
    })
    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(seen).toEqual([{ from: '02aa', payload: Uint8Array.from([1]) }])
    expect(client.acked).toEqual(['m1'])
  })

  it('leaves a message in the box when the handler throws, without calling acknowledge at all', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client)
    const acknowledgeMessage = vi.spyOn(client, 'acknowledgeMessage')
    const errors: Error[] = []
    transport.onError(error => errors.push(error))

    transport.onMessage(async () => {
      throw new Error('storage is down')
    })
    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(client.acked).toEqual([])
    expect(client.inbox).toHaveLength(1)
    // An empty batch is not an acknowledgement of nothing: the real
    // acknowledgeMessage rejects an empty id list, so the call must not happen.
    expect(acknowledgeMessage).not.toHaveBeenCalled()
    expect(errors.map(error => error.message)).toEqual(['storage is down'])
  })

  it('delivers every message in a batch and acknowledges the survivors in one call, even when one handler throws', async () => {
    const client = fakeClient()
    client.inbox.push(
      { messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) },
      { messageId: 'm2', sender: '02bb', body: encodeBody(Uint8Array.from([2])) },
      { messageId: 'm3', sender: '02cc', body: encodeBody(Uint8Array.from([3])) }
    )
    const transport = new MessageBoxTransport(client)
    const acknowledgeMessage = vi.spyOn(client, 'acknowledgeMessage')

    const seen: string[] = []
    transport.onMessage(async from => {
      seen.push(from)
      if (from === '02bb') throw new Error('handler blew up on m2')
    })
    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(seen).toEqual(['02aa', '02bb', '02cc'])
    expect(client.acked).toEqual(['m1', 'm3'])
    expect(acknowledgeMessage).toHaveBeenCalledTimes(1)
  })

  it('acknowledges a malformed body immediately and still delivers the rest of the batch', async () => {
    const client = fakeClient()
    client.inbox.push(
      { messageId: 'm1', sender: '02aa', body: JSON.stringify({ hello: 'world' }) },
      { messageId: 'm2', sender: '02bb', body: encodeBody(Uint8Array.from([9])) }
    )
    const transport = new MessageBoxTransport(client)
    const errors: Error[] = []
    transport.onError(error => errors.push(error))

    const seen: Array<{ from: string; payload: Uint8Array }> = []
    transport.onMessage(async (from, payload) => {
      seen.push({ from, payload })
    })
    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(client.acked).toEqual(['m1', 'm2'])
    expect(seen).toEqual([{ from: '02bb', payload: Uint8Array.from([9]) }])
    expect(errors).toHaveLength(1)
    expect(errors[0]!.name).toBe('MalformedBodyError')
  })

  it('skips a poll tick that overlaps a still in-flight delivery', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client)
    const listMessages = vi.spyOn(client, 'listMessages')

    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const seen: Array<{ from: string; payload: Uint8Array }> = []
    transport.onMessage(async (from, payload) => {
      await gate
      seen.push({ from, payload })
    })

    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)
    const callsWhileInFlight = listMessages.mock.calls.length
    expect(callsWhileInFlight).toBe(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(listMessages.mock.calls).toHaveLength(callsWhileInFlight)

    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(seen).toEqual([{ from: '02aa', payload: Uint8Array.from([1]) }])
    expect(client.acked).toEqual(['m1'])
  })

  it('delivers a batch oldest first, whatever order the box returned it in', async () => {
    // MLS needs the Commit before the messages in its epoch, and the real
    // client's own sort keys off a field its types do not declare.
    const client = fakeClient()
    client.inbox.push(
      { messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) },
      { messageId: 'm2', sender: '02bb', body: encodeBody(Uint8Array.from([2])) },
      { messageId: 'm3', sender: '02cc', body: encodeBody(Uint8Array.from([3])) }
    )
    const transport = new MessageBoxTransport(client)

    const seen: number[] = []
    transport.onMessage((_from, payload) => {
      seen.push(payload[0]!)
    })
    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(seen).toEqual([1, 2, 3])
    expect(client.acked).toEqual(['m1', 'm2', 'm3'])
  })

  it('never asks the box to accept payments', async () => {
    // listMessages defaults acceptPayments to true, which internalizes any
    // payment an unauthenticated sender dropped in the box. This transport
    // moves ciphertext, never money.
    const client = fakeClient()
    const transport = new MessageBoxTransport(client)
    transport.onMessage(() => undefined)

    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(client.listed).not.toHaveLength(0)
    for (const call of client.listed) expect(call.acceptPayments).toBe(false)
  })

  it("passes the client's own host on listMessages and acknowledgeMessage, to skip the overlay lookup", async () => {
    const client = fakeClient('https://gmb.bsvblockchain.tech')
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client)
    const acknowledgeMessage = vi.spyOn(client, 'acknowledgeMessage')
    transport.onMessage(() => undefined)

    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(client.listed[0]?.host).toBe('https://gmb.bsvblockchain.tech')
    expect(acknowledgeMessage).toHaveBeenCalledWith({
      messageIds: ['m1'],
      host: 'https://gmb.bsvblockchain.tech'
    })
  })

  it('calls listMessages and acknowledgeMessage with no host argument at all when the client has none', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client)
    const acknowledgeMessage = vi.spyOn(client, 'acknowledgeMessage')
    transport.onMessage(() => undefined)

    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    // Not just "host is undefined": exactOptionalPropertyTypes distinguishes
    // an absent key from one present with an undefined value, and a stray
    // `host: undefined` on the wire is exactly what an unconditional pass-
    // through would produce.
    expect(Object.hasOwn(client.listed[0]!, 'host')).toBe(false)
    expect(Object.hasOwn(acknowledgeMessage.mock.calls[0]![0], 'host')).toBe(false)
  })

  it('leaves a batch in the box while nothing is subscribed', async () => {
    // start() runs before the client subscribes, and close() drops handlers
    // while a tick may still be running. Delivering to an empty handler set
    // completes without throwing, so acknowledging it would destroy the batch.
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client)
    const acknowledgeMessage = vi.spyOn(client, 'acknowledgeMessage')

    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(client.acked).toEqual([])
    expect(client.inbox).toHaveLength(1)
    expect(acknowledgeMessage).not.toHaveBeenCalled()

    const seen: string[] = []
    transport.onMessage(from => {
      seen.push(from)
    })
    await vi.advanceTimersByTimeAsync(5000)

    expect(seen).toEqual(['02aa'])
    expect(client.acked).toEqual(['m1'])
  })

  it('waits for a delivery already in flight before it reports itself closed', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client)

    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let finished = false
    transport.onMessage(async () => {
      await gate
      finished = true
    })
    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    let closed = false
    const closing = transport.close().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toBe(false)

    release()
    await closing

    expect(finished).toBe(true)
    expect(client.acked).toEqual(['m1'])
  })

  it('stops polling when closed', async () => {
    const client = fakeClient()
    const transport = new MessageBoxTransport(client)
    const listed = vi.spyOn(client, 'listMessages')

    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)
    const afterFirst = listed.mock.calls.length
    await transport.close()
    await vi.advanceTimersByTimeAsync(20000)

    expect(listed.mock.calls).toHaveLength(afterFirst)
  })

  it('does not start a tick while the previous one is still running', async () => {
    const client = fakeClient()
    let release = (): void => undefined
    const slow = new Promise<void>(resolve => {
      release = () => resolve()
    })
    const original = client.listMessages.bind(client)
    let calls = 0
    client.listMessages = async args => {
      calls += 1
      if (calls === 1) await slow
      return original(args)
    }

    const transport = new MessageBoxTransport(client, { pollIntervalMs: 1000 })
    transport.onMessage(async () => {})
    await transport.start()

    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)
    // Four windows pass while the first call is still in flight.
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls).toBe(1)

    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(2)

    await transport.close()
  })

  it('polls again when started after a close', async () => {
    const client = fakeClient()
    const transport = new MessageBoxTransport(client, { pollIntervalMs: 1000 })
    transport.onMessage(async () => {})
    await transport.start()
    await vi.advanceTimersByTimeAsync(1000)
    await transport.close()
    const listedAtClose = client.listed.length

    await transport.start()
    await vi.advanceTimersByTimeAsync(1000)

    expect(client.listed).toHaveLength(listedAtClose + 1)
    await transport.close()
  })

  it('runs no further poll once closed, even if a tick was in flight', async () => {
    // The only path that reaches `#arm()` after close: a tick already running
    // whose `finally` re-arms once it settles. Closing with nothing in flight
    // proves nothing — the cleared timer covers that on its own.
    const client = fakeClient()
    let release = (): void => undefined
    const slow = new Promise<void>(resolve => {
      release = () => resolve()
    })
    const original = client.listMessages.bind(client)
    let calls = 0
    client.listMessages = async args => {
      calls += 1
      if (calls === 1) await slow
      return original(args)
    }

    const transport = new MessageBoxTransport(client, { pollIntervalMs: 1000 })
    transport.onMessage(async () => {})
    await transport.start()

    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)

    // `close()` waits for the in-flight tick, so do not await it yet.
    const closing = transport.close()
    release()
    await closing

    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(1)
    // The guard's real job. `#arm()` runs from the in-flight tick's `finally`,
    // which is after `close()` has set `#stopped` — without the guard it arms a
    // timer whose tick returns early and arms another, forever. No poll is
    // visible because `#deliver` is cleared, so a poll count cannot see it; a
    // pending timer can.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a failed poll without stopping the timer', async () => {
    const client = fakeClient()
    const transport = new MessageBoxTransport(client)
    const errors: Error[] = []
    transport.onError(error => errors.push(error))
    transport.onMessage(() => undefined)
    vi.spyOn(client, 'listMessages').mockRejectedValueOnce(new Error('401'))

    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(errors.map(error => error.message)).toEqual(['401'])

    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    // The failed tick doubled the wait to 10000; the timer keeps running, just slower.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.acked).toEqual(['m1'])
  })

  it('surfaces a poll failure to a client as processingFailed with no sender', async () => {
    const client = fakeClient()
    vi.spyOn(client, 'listMessages').mockRejectedValue(new Error('token expired'))
    const transport = new MessageBoxTransport(client)
    const wallet = new KeyDeriver(PrivateKey.fromRandom())

    const groupMessagingClient = await GroupMessagingClient.create({
      wallet,
      storage: new Map(),
      transport
    })

    const failures: Array<{ from?: string; error: Error }> = []
    groupMessagingClient.on('processingFailed', failure => failures.push(failure))

    await vi.advanceTimersByTimeAsync(5000)

    expect(failures).toHaveLength(1)
    expect(failures[0]!.from).toBeUndefined()
    expect(failures[0]!.error.message).toBe('token expired')

    await groupMessagingClient.close()
  })
})

describe('MessageBoxTransport failure policy', () => {
  it('gives up after maxAttempts, acknowledging and reporting rather than looping', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client, { maxAttempts: 3 })
    const errors: Error[] = []
    transport.onError(error => errors.push(error))
    transport.onMessage(async () => {
      throw new Error('always fails')
    })
    await transport.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(client.acked).toEqual([])
    await vi.advanceTimersByTimeAsync(5000)
    expect(client.acked).toEqual([])
    await vi.advanceTimersByTimeAsync(5000)

    expect(client.acked).toEqual(['m1'])
    expect(errors.at(-1)?.message).toContain('3 attempts')
    expect(client.inbox).toHaveLength(0)
  })

  it('acknowledges a permanent failure immediately instead of retrying it', async () => {
    const client = fakeClient()
    client.inbox.push({
      messageId: 'm1',
      sender: '02aa',
      created_at: '2026-01-01T00:00:00Z',
      body: encodeBody(Uint8Array.from([1]))
    })
    const transport = new MessageBoxTransport(client)
    const errors: Error[] = []
    transport.onError(error => errors.push(error))
    transport.onMessage(() => {
      throw new PermanentProcessingError('will never work')
    })
    await transport.start()

    await vi.advanceTimersByTimeAsync(5000)

    expect(client.acked).toEqual(['m1'])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('will never work')
  })

  it('delivers a message once even when the box returns it before the ack lands', async () => {
    const client = fakeClient()
    const message = { messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) }
    client.inbox.push(message)
    // The first acknowledgement fails, so the box still holds the message.
    vi.spyOn(client, 'acknowledgeMessage').mockRejectedValueOnce(new Error('ack failed'))

    const transport = new MessageBoxTransport(client)
    let delivered = 0
    transport.onMessage(() => {
      delivered += 1
    })
    await transport.start()

    await vi.advanceTimersByTimeAsync(5000)
    // The failed acknowledgement doubled the wait to 10000 before the retry.
    await vi.advanceTimersByTimeAsync(10_000)

    expect(delivered).toBe(1)
    expect(client.acked).toEqual(['m1'])
  })

  it('reports one handler failure once per attempt, not once per layer', async () => {
    // TransportService reports each handler failure and then throws
    // DeliveryFailed to say the message was not processed; its error channel
    // forwards whatever the backend reports back to the same subscribers.
    // Re-reporting the summary turned one fault into a stream of events.
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const service = new TransportService(new MessageBoxTransport(client, { maxAttempts: 2 }))
    const reported: string[] = []
    service.onError(error => reported.push(error.message))
    service.onMessage(() => {
      throw new Error('storage is down')
    })
    await service.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(reported).toEqual(['storage is down'])

    await vi.advanceTimersByTimeAsync(5000)
    expect(reported).toEqual([
      'storage is down',
      'storage is down',
      'Giving up on message m1 after 2 attempts'
    ])
  })

  it('forgets the oldest handled id rather than remembering every one forever', async () => {
    // The real acknowledgeMessage throws when no host accepts, and the set of
    // handled ids is otherwise pruned only on success. Evicting the oldest
    // costs one duplicate delivery, which MLS rejects as a replay; keeping
    // every id costs memory that only grows.
    const client = fakeClient()
    for (let index = 0; index <= MAX_REMEMBERED_MESSAGES; index++) {
      client.inbox.push({
        messageId: `m${index}`,
        sender: '02aa',
        body: encodeBody(Uint8Array.from([index & 0xff, index >> 8]))
      })
    }
    vi.spyOn(client, 'acknowledgeMessage').mockRejectedValue(new Error('no host accepted'))
    const transport = new MessageBoxTransport(client)
    transport.onError(() => undefined)

    const deliveries = new Map<number, number>()
    transport.onMessage((_from, payload) => {
      const index = payload[0]! + (payload[1]! << 8)
      deliveries.set(index, (deliveries.get(index) ?? 0) + 1)
    })
    await transport.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(deliveries.size).toBe(MAX_REMEMBERED_MESSAGES + 1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(deliveries.get(0)).toBe(2)
    expect(deliveries.get(1)).toBe(1)
    expect(deliveries.get(MAX_REMEMBERED_MESSAGES)).toBe(1)
  })

  it('forgets the oldest attempt count too, so a one-off failure leaks nothing', async () => {
    // #attempts is cleared when a message gets through or is given up on. A
    // message that fails once and never comes back reaches neither, so the map
    // is capped like the handled set. The oldest entry restarts its count,
    // which costs that message one extra try and nothing else.
    const client = fakeClient()
    for (let index = 0; index <= MAX_REMEMBERED_MESSAGES; index++) {
      client.inbox.push({
        messageId: `m${index}`,
        sender: '02aa',
        body: '[Error: Failed to decrypt or parse message]'
      })
    }
    const transport = new MessageBoxTransport(client, { maxAttempts: 2 })
    transport.onError(() => undefined)
    transport.onMessage(() => undefined)
    await transport.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(client.acked).toEqual([])

    await vi.advanceTimersByTimeAsync(5000)

    expect(client.acked).toHaveLength(MAX_REMEMBERED_MESSAGES)
    expect(client.acked).not.toContain('m0')
    expect(client.inbox.map(message => message.messageId)).toEqual(['m0'])
  })

  it('acknowledges a malformed body immediately, since no retry will fix it', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: JSON.stringify({ v: 99 }) })
    const transport = new MessageBoxTransport(client)
    const errors: Error[] = []
    transport.onError(error => errors.push(error))
    transport.onMessage(() => undefined)
    await transport.start()

    await vi.advanceTimersByTimeAsync(5000)

    expect(client.acked).toEqual(['m1'])
    expect(errors).toHaveLength(1)
    expect(errors[0]!.name).toBe('MalformedBodyError')
  })

  it('retries a body that never parsed, rather than destroying it on first sight', async () => {
    // The real client swallows every walletClient.decrypt failure and puts this
    // literal string in the body, so a locked wallet must not cost a message.
    const client = fakeClient()
    client.inbox.push({
      messageId: 'm1',
      sender: '02aa',
      body: '[Error: Failed to decrypt or parse message]'
    })
    const transport = new MessageBoxTransport(client, { maxAttempts: 3 })
    const errors: Error[] = []
    transport.onError(error => errors.push(error))
    transport.onMessage(() => undefined)
    await transport.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(client.acked).toEqual([])
    expect(client.inbox).toHaveLength(1)
    expect(errors.map(error => error.name)).toEqual(['UnparsableBodyError'])

    await vi.advanceTimersByTimeAsync(5000)
    expect(client.acked).toEqual([])

    await vi.advanceTimersByTimeAsync(5000)
    expect(client.acked).toEqual(['m1'])
    expect(errors.at(-1)?.message).toContain('3 attempts')
  })
})

describe('GroupMessagingClient.close over MessageBox', () => {
  it('acknowledges nothing it stopped delivering', async () => {
    // The same hazard as the transport's own close, one layer up and on the
    // path a wallet actually takes: dropping the client's subscription first
    // leaves the in-flight poll delivering into an empty handler set, where
    // every remaining message "succeeds" and is acknowledged unseen.
    const client = fakeClient()
    // MLS-kind envelopes the engine cannot route (`epochOf` returns undefined
    // for arbitrary bytes) rather than raw garbage: routing failure stays
    // transient, where a non-envelope payload is now a permanent one and would
    // be given up on its own merits, muddying what this test is checking.
    const unroutable = (byte: number) =>
      encodeBody(encodeEnvelope({ kind: 'mls', payload: new Uint8Array([byte]) }))
    client.inbox.push(
      { messageId: 'm1', sender: '02aa', body: unroutable(1) },
      { messageId: 'm2', sender: '02bb', body: unroutable(2) }
    )
    const transport = new TransportService(new MessageBoxTransport(client))
    const wallet = new KeyDeriver(PrivateKey.fromRandom())
    const groupMessagingClient = await GroupMessagingClient.create({
      wallet,
      storage: new Map(),
      transport
    })

    // These payloads are unroutable, so the client's own handler fails on
    // both: nothing may be acknowledged. What must not happen is the second
    // message being acknowledged anyway because there was no handler left to
    // fail.
    groupMessagingClient.on('processingFailed', () => undefined)

    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const seen: string[] = []
    groupMessagingClient.transport.onMessage(async from => {
      seen.push(from)
      if (from === '02aa') await gate
    })

    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toEqual(['02aa'])

    const closing = groupMessagingClient.close()
    await vi.advanceTimersByTimeAsync(0)
    release()
    await closing

    expect(seen).toEqual(['02aa', '02bb'])
    expect(client.acked).toEqual([])
    expect(client.inbox).toHaveLength(2)
  })
})

/** The identity the transports under test read for. */
const ME = `02${'ee'.repeat(32)}`

/** One message as the live socket hands it over. */
interface LivePush {
  messageId: string
  sender: string
  body: string | Record<string, unknown>
  created_at: string
}

/**
 * A client that can also do live delivery. `push` is the socket firing; `calls`
 * records the lifecycle so its ordering can be asserted — `leaveRoom` before
 * `disconnectWebSocket` is load-bearing, see the source.
 */
const fakeLiveClient = () => ({
  ...fakeClient(),
  calls: [] as string[],
  /**
   * What a self-addressed live send does. The relay stores it in the box and,
   * for a socket that works, pushes it too; the live probe kept with this
   * package's demo application saw both. `'box'` is a deaf socket: the
   * message is filed and nothing is pushed.
   */
  echo: 'box' as 'none' | 'box' | 'both',
  liveSent: [] as Array<{ recipient: string; messageBox: string; body: string }>,
  async sendLiveMessage(args: { recipient: string; messageBox: string; body: string }) {
    this.liveSent.push(args)
    if (this.echo === 'none' || args.recipient !== ME) return {}
    const messageId = `live-${this.liveSent.length}`
    this.inbox.push({ messageId, sender: ME, body: args.body })
    if (this.echo === 'both') {
      this.listener?.({
        messageId,
        sender: ME,
        body: tryParse(args.body),
        created_at: arrivalOf(0)
      })
    }
    return {}
  },
  listener: undefined as undefined | ((message: LivePush) => void),
  statusListeners: new Set<(status: ClientLiveStatus) => void>(),
  onLiveStatus(listener: (status: ClientLiveStatus) => void) {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  },
  /** Say what the socket is doing, the way the real client would. */
  reportLive(state: ClientLiveState, rooms: readonly string[] = []) {
    for (const listener of this.statusListeners) listener({ state, rooms })
  },
  async initializeConnection() {
    this.calls.push('initializeConnection')
  },
  async listenForLiveMessages(args: {
    messageBox: string
    onMessage: (message: LivePush) => void
  }) {
    this.calls.push('listenForLiveMessages')
    this.listener = args.onMessage
  },
  async leaveRoom(_messageBox: string) {
    this.calls.push('leaveRoom')
  },
  async disconnectWebSocket() {
    this.calls.push('disconnectWebSocket')
    this.listener = undefined
  },
  push(message: { messageId: string; sender: string; payload: Uint8Array }) {
    this.listener?.({
      messageId: message.messageId,
      sender: message.sender,
      body: tryParse(encodeBody(message.payload)),
      created_at: arrivalOf(0)
    })
  }
})

describe('MessageBoxTransport live delivery', () => {
  it('delivers a message the socket pushes', async () => {
    const client = fakeLiveClient()
    const transport = new MessageBoxTransport(client, { live: true })
    const seen: Array<{ from: string; payload: Uint8Array }> = []
    transport.onMessage(async (from, payload) => {
      seen.push({ from, payload })
    })
    await transport.start()

    client.push({ messageId: 'm1', sender: '02aa', payload: Uint8Array.from([1]) })
    await vi.advanceTimersByTimeAsync(1)

    expect(seen).toEqual([{ from: '02aa', payload: Uint8Array.from([1]) }])
    expect(client.acked).toEqual(['m1'])
  })

  it('slows the poll to the backstop cadence', async () => {
    const client = fakeLiveClient()
    const transport = new MessageBoxTransport(client, { live: true, pollIntervalMs: 5000 })
    await transport.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(client.listed).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(LIVE_BACKSTOP_INTERVAL_MS - 5000)
    expect(client.listed).toHaveLength(1)
  })

  it('goes back to the backstop cadence when a restart brings the socket up', async () => {
    const client = fakeLiveClient()
    const transport = new MessageBoxTransport(client, { live: true, pollIntervalMs: 5000 })
    transport.onError(() => undefined)
    transport.onMessage(async () => {})

    // Abandoning drops the poll to its configured rate, because the socket is
    // no longer carrying. That cadence must not outlive the socket's return.
    const initialize = client.initializeConnection.bind(client)
    client.initializeConnection = async () => {
      throw new Error('down')
    }
    await transport.start()
    await transport.close()

    client.initializeConnection = initialize.bind(client)
    await transport.start()

    client.listed.length = 0
    await vi.advanceTimersByTimeAsync(5000)
    expect(client.listed).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(LIVE_BACKSTOP_INTERVAL_MS - 5000)
    expect(client.listed).toHaveLength(1)

    await transport.close()
  })

  it('leaves the room before disconnecting, so the stale room bookkeeping clears', async () => {
    const client = fakeLiveClient()
    const transport = new MessageBoxTransport(client, { live: true })

    await transport.start()
    await transport.close()

    expect(client.calls).toEqual([
      'initializeConnection',
      'listenForLiveMessages',
      'leaveRoom',
      'disconnectWebSocket'
    ])
  })

  it('ignores a push that lands after close', async () => {
    const client = fakeLiveClient()
    const transport = new MessageBoxTransport(client, { live: true })
    const seen: string[] = []
    transport.onMessage(async from => {
      seen.push(from)
    })
    await transport.start()
    const listener = client.listener
    await transport.close()

    listener?.({
      messageId: 'm1',
      sender: '02aa',
      body: tryParse(encodeBody(Uint8Array.from([1]))),
      created_at: arrivalOf(0)
    })
    await vi.advanceTimersByTimeAsync(1)

    expect(seen).toEqual([])
  })

  it('reports and keeps polling when the client cannot do live delivery at all', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client, { live: true })
    const errors: Error[] = []
    transport.onError(error => errors.push(error))
    const seen: string[] = []
    transport.onMessage(async from => {
      seen.push(from)
    })

    await transport.start()
    await vi.advanceTimersByTimeAsync(LIVE_BACKSTOP_INTERVAL_MS)

    expect(errors).toHaveLength(1)
    expect(seen).toEqual(['02aa'])
  })
})

describe('MessageBoxTransport live sending and status', () => {
  const liveSendingClient = fakeLiveClient

  it('sends over the socket while live delivery is carrying', async () => {
    const client = liveSendingClient()
    const transport = new MessageBoxTransport(client, { live: true })
    await transport.start()

    await transport.send('02bb', Uint8Array.from([7]))

    expect(client.liveSent).toHaveLength(1)
    expect(client.sent).toHaveLength(0)
  })

  it('sends over the socket again after a close taken while the socket was dormant', async () => {
    const client = liveSendingClient()
    const transport = new MessageBoxTransport(client, {
      pollIntervalMs: 1000,
      live: true
    })
    transport.onError(() => undefined)
    transport.onMessage(async () => {})

    const initialize = client.initializeConnection.bind(client)
    client.initializeConnection = async () => {
      throw new Error('down')
    }
    await transport.start()
    await transport.close()

    // The restart is carrying again, so sending must go back to the socket. An
    // HTTP `sendMessage` files the message without broadcasting it, so a stale
    // dormant flag leaves the recipient's own live subscriber pushed nothing.
    client.initializeConnection = initialize.bind(client)
    await transport.start()
    await transport.send('02bb', Uint8Array.from([7]))

    expect(client.liveSent).toHaveLength(1)
    expect(client.sent).toHaveLength(0)

    await transport.close()
  })

  it('stays on HTTP when live was never asked for', async () => {
    const client = liveSendingClient()
    const transport = new MessageBoxTransport(client)
    await transport.start()

    await transport.send('02bb', Uint8Array.from([7]))

    expect(client.liveSent).toHaveLength(0)
    expect(client.sent).toHaveLength(1)
  })

  it('reports what the socket is doing, and which producer carried a message', async () => {
    const client = liveSendingClient()
    const transport = new MessageBoxTransport(client, { live: true })
    const status: string[] = []
    transport.onLiveStatus(update =>
      status.push(update.source === undefined ? update.phase : `${update.phase}:${update.source}`)
    )
    transport.onMessage(async () => {})
    await transport.start()

    expect(status).toEqual(['connecting', 'subscribed'])

    client.push({ messageId: 'm1', sender: '02aa', payload: Uint8Array.from([1]) })
    await vi.advanceTimersByTimeAsync(1)
    expect(status).toContain('delivered:socket')

    client.inbox.push({
      messageId: 'm2',
      sender: '02aa',
      body: encodeBody(Uint8Array.from([2]))
    })
    await vi.advanceTimersByTimeAsync(LIVE_BACKSTOP_INTERVAL_MS)
    expect(status).toContain('delivered:poll')
  })
})

describe('MessageBoxTransport errors reach a service-level host', () => {
  it('reports a refused live socket through TransportService', async () => {
    const client = fakeClient()
    const service = new TransportService(new MessageBoxTransport(client, { live: true }))
    const errors: Error[] = []
    service.onError(error => errors.push(error))

    await service.start()

    expect(errors.map(error => error.name)).toEqual(['LiveDeliveryUnavailable'])
  })
})

describe('MessageBoxTransport keeps acknowledging a message the box will not drop', () => {
  it('re-acknowledges a returning message without delivering it twice', async () => {
    const client = fakeClient()
    // A box that keeps the message after acknowledging it: the id leaves
    // `#handled` on ack success but the message comes back on the next poll.
    client.acknowledgeMessage = async (args: { messageIds: string[]; host?: string }) => {
      if (args.messageIds.length === 0) throw new Error('Message IDs array cannot be empty')
      client.acked.push(...args.messageIds)
      return {}
    }
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client)
    const seen: Uint8Array[] = []
    transport.onMessage(async (_from, payload) => {
      seen.push(payload)
    })
    await transport.start()

    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)

    expect(seen).toHaveLength(1)
    expect(client.acked).toEqual(['m1', 'm1'])
  })
})

describe('MessageBoxTransport isolates its own subscribers', () => {
  /**
   * Invariant 5 holds in the normal wiring only because `TransportService` is
   * the sole subscriber and does the isolation itself. `MessageBoxTransport` is
   * a public export and `onMessage` accepts any number of handlers, so the
   * invariant should not depend on nobody using the surface as offered.
   */
  it('runs every handler even when an earlier one throws', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client)
    const errors: Error[] = []
    transport.onError(error => errors.push(error))

    const seen: string[] = []
    transport.onMessage(async () => {
      throw new Error('the first subscriber is broken')
    })
    transport.onMessage(async from => {
      seen.push(from)
    })

    await transport.start()
    await vi.advanceTimersByTimeAsync(5000)

    expect(seen).toEqual(['02aa'])
    expect(errors.map(error => error.message)).toContain('the first subscriber is broken')
  })
})

/**
 * The two halves of durability, composed.
 *
 * `IndexedDbStorageBackend` used to resolve a write on `IDBRequest.onsuccess`,
 * before its transaction committed, so an abort could roll the write back after
 * the client had already reported success — and the relay, seeing every handler
 * return, would acknowledge and discard the only copy. The backend now waits for
 * the commit; this is the other end of that, proving a rejected write really
 * does keep the message in the box rather than merely being reported somewhere.
 */
describe('a storage write that fails', () => {
  /** Backed by a Map, except for one namespace that refuses to be written. */
  const backendRefusing = (refuse: StorageTable) => {
    const rows = new Map<string, Uint8Array>()
    return {
      get: (table: StorageTable, key: string) => rows.get(`${table}:${key}`),
      set: (table: StorageTable, key: string, value: Uint8Array) => {
        if (table === refuse) {
          throw new Error('IndexedDB transaction aborted before the write committed')
        }
        rows.set(`${table}:${key}`, value)
      },
      delete: (table: StorageTable, key: string) => {
        rows.delete(`${table}:${key}`)
      },
      keys: (table: StorageTable) =>
        [...rows.keys()]
          .filter(row => row.startsWith(`${table}:`))
          .map(row => row.slice(table.length + 1))
    }
  }

  it('leaves the message in the box instead of acknowledging it', async () => {
    const client = fakeClient()
    const transport = new MessageBoxTransport(client)
    const acknowledgeMessage = vi.spyOn(client, 'acknowledgeMessage')

    const groupMessagingClient = await GroupMessagingClient.create({
      wallet: new KeyDeriver(PrivateKey.fromRandom()),
      storage: backendRefusing('invites'),
      transport
    })
    const failures: Array<{ error: Error }> = []
    groupMessagingClient.on('processingFailed', failure => failures.push(failure))

    // A bootstrap request is the shortest path to a storage write: handling it
    // means putInvite, which is the namespace being refused.
    client.inbox.push({
      messageId: 'm1',
      sender: `02${'aa'.repeat(32)}`,
      body: encodeBody(
        encodeEnvelope({
          kind: 'bootstrap',
          message: {
            type: 'keyPackageRequest',
            requestId: 'r1',
            ciphersuites: [DEFAULT_CIPHERSUITE]
          }
        })
      )
    })
    await vi.advanceTimersByTimeAsync(5000)

    expect(client.acked).toEqual([])
    expect(client.inbox).toHaveLength(1)
    expect(acknowledgeMessage).not.toHaveBeenCalled()
    expect(failures.map(failure => failure.error.message)).toContain(
      'IndexedDB transaction aborted before the write committed'
    )

    await groupMessagingClient.close()
  })
})

describe('MessageBoxTransport backs off when the relay refuses it', () => {
  const inboxMessage = (id: string, byte: number) => ({
    messageId: id,
    sender: '02aa',
    body: encodeBody(Uint8Array.from([byte]))
  })

  it('backs the poll off when the relay refuses it, and stops at the ceiling', async () => {
    const client = fakeClient()
    client.listMessages = async () => {
      throw new Error('429 Too Many Requests')
    }
    const errors: Error[] = []
    const transport = new MessageBoxTransport(client, { pollIntervalMs: 1000 })
    transport.onError(error => errors.push(error))
    transport.onMessage(async () => {})
    await transport.start()

    // 1000 -> 2000 -> 4000 … each failure doubles the wait before the next try.
    const waits = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]
    let seen = 0
    for (const wait of waits) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(errors).toHaveLength(seen)
      await vi.advanceTimersByTimeAsync(1)
      seen += 1
      expect(errors).toHaveLength(seen)
    }

    await transport.close()
  })

  it('does not back off when the acknowledgement fails and reads keep succeeding', async () => {
    // A relay refusing an acknowledgement says nothing about whether it will
    // serve reads; treating it as a read failure walked the poll to the ceiling.
    const client = fakeClient()
    client.inbox.push(inboxMessage('m1', 1))
    client.acknowledgeMessage = async () => {
      throw new Error('Failed to acknowledge messages on all hosts')
    }
    const errors: Error[] = []
    const transport = new MessageBoxTransport(client, { pollIntervalMs: 1000 })
    transport.onError(error => errors.push(error))
    transport.onMessage(async () => {})
    await transport.start()

    for (let tick = 1; tick <= 6; tick++) {
      await vi.advanceTimersByTimeAsync(1000)
      expect(client.listed).toHaveLength(tick)
    }
    expect(errors.length).toBeGreaterThan(0)

    await transport.close()
  })

  it('never polls a slow host faster than it asked for', async () => {
    const client = fakeClient()
    // Records the call before throwing, since the assertions below count calls
    // through `client.listed` the way every other test in this file does.
    client.listMessages = async args => {
      client.listed.push(args)
      throw new Error('nope')
    }
    const transport = new MessageBoxTransport(client, { pollIntervalMs: 120_000 })
    transport.onError(() => undefined)
    transport.onMessage(async () => {})
    await transport.start()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(client.listed).toHaveLength(1)
    // The ceiling is 60s, well under this host's floor; the floor wins.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.listed).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.listed).toHaveLength(2)

    await transport.close()
  })

  it('returns to the configured cadence on the first poll that succeeds', async () => {
    const client = fakeClient()
    let fail = true
    const original = client.listMessages.bind(client)
    client.listMessages = async args => {
      if (fail) throw new Error('429')
      return original(args)
    }
    const transport = new MessageBoxTransport(client, { pollIntervalMs: 1000 })
    transport.onError(() => undefined)
    transport.onMessage(async () => {})
    await transport.start()

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    const backedOff = client.listed.length

    fail = false
    await vi.advanceTimersByTimeAsync(8000)
    expect(client.listed).toHaveLength(backedOff + 1)
    // Back at the floor: one call per 1000ms window.
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.listed).toHaveLength(backedOff + 2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.listed).toHaveLength(backedOff + 3)

    await transport.close()
  })
})

/**
 * The client reconnects and rejoins its own rooms from 2.7.0, so this backend
 * no longer probes the socket. What it still decides is how hard to poll, and
 * it decides that from what the client says about its socket.
 */
describe('MessageBoxTransport follows the client it was given', () => {
  const live = (client: ReturnType<typeof fakeLiveClient>) =>
    new MessageBoxTransport(client, { pollIntervalMs: 1000, live: true })

  it('polls at the backstop while the socket is live', async () => {
    const client = fakeLiveClient()
    const transport = live(client)
    transport.onError(() => undefined)
    transport.onMessage(async () => {})
    await transport.start()
    client.reportLive('live', [`${ME}-${DEFAULT_MESSAGE_BOX}`])
    const settled = client.listed.length

    // A configured interval's worth of silence buys nothing while live.
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.listed).toHaveLength(settled)
    await vi.advanceTimersByTimeAsync(LIVE_BACKSTOP_INTERVAL_MS)
    expect(client.listed).toHaveLength(settled + 1)

    await transport.close()
  })

  it('tightens to the configured interval the moment the socket is not live', async () => {
    const client = fakeLiveClient()
    const transport = live(client)
    transport.onError(() => undefined)
    transport.onMessage(async () => {})
    await transport.start()
    client.reportLive('live', [`${ME}-${DEFAULT_MESSAGE_BOX}`])
    await vi.advanceTimersByTimeAsync(LIVE_BACKSTOP_INTERVAL_MS)
    const settled = client.listed.length

    // Anything stored while the socket is away is never pushed once it is back,
    // so the poll is the only thing that will carry it.
    client.reportLive('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.listed).toHaveLength(settled + 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.listed).toHaveLength(settled + 2)

    await transport.close()
  })

  it("reports the client's states as its own phases", async () => {
    const client = fakeLiveClient()
    const transport = live(client)
    transport.onError(() => undefined)
    transport.onMessage(async () => {})
    const phases: Array<LiveStatus['phase']> = []
    transport.onLiveStatus(status => {
      phases.push(status.phase)
    })
    await transport.start()
    phases.length = 0

    client.reportLive('reconnecting')
    client.reportLive('connecting')
    client.reportLive('live', [`${ME}-${DEFAULT_MESSAGE_BOX}`])
    client.reportLive('closed')

    expect(phases).toEqual(['reconnecting', 'connecting', 'subscribed', 'closed'])

    await transport.close()
  })

  it('passes on the reason the client gave, when it gave one', async () => {
    const client = fakeLiveClient()
    const transport = live(client)
    transport.onError(() => undefined)
    transport.onMessage(async () => {})
    const details: Array<string | undefined> = []
    transport.onLiveStatus(status => {
      details.push(status.detail)
    })
    await transport.start()
    details.length = 0

    for (const listener of client.statusListeners) {
      listener({ state: 'reconnecting', rooms: [], reason: 'transport close' })
    }

    expect(details).toEqual(['transport close'])

    await transport.close()
  })

  it('stops listening on close, so a late status cannot retune a closed poll', async () => {
    const client = fakeLiveClient()
    const transport = live(client)
    transport.onError(() => undefined)
    transport.onMessage(async () => {})
    await transport.start()
    await transport.close()
    const settled = client.listed.length

    client.reportLive('reconnecting')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(client.statusListeners.size).toBe(0)
    expect(client.listed).toHaveLength(settled)
  })

  it('never relaxes the poll for a client too old to report anything', async () => {
    const client = fakeLiveClient()
    const bare: Record<string, unknown> = { ...client }
    delete bare['onLiveStatus']
    Object.setPrototypeOf(bare, Object.getPrototypeOf(client) as object)
    const transport = new MessageBoxTransport(
      bare as unknown as ReturnType<typeof fakeLiveClient>,
      { pollIntervalMs: 1000, live: true }
    )
    transport.onError(() => undefined)
    transport.onMessage(async () => {})
    await transport.start()
    const settled = (bare['listed'] as unknown[]).length

    // Nothing will say when the socket stops carrying, so the poll is never
    // relaxed: it runs at the interval the host asked for, exactly as it would
    // with no socket at all.
    await vi.advanceTimersByTimeAsync(1000)
    expect(bare['listed'] as unknown[]).toHaveLength(settled + 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(bare['listed'] as unknown[]).toHaveLength(settled + 2)

    await transport.close()
  })
})

/**
 * Edges the relay and the host can reach but the happy path never does. Each
 * one is a decision this backend already makes; none of them had a test.
 */
describe('MessageBoxTransport edges the relay can reach', () => {
  it('orders a batch the relay timestamped unparseably, without losing any of it', async () => {
    const client = fakeClient()
    client.inbox.push(
      {
        messageId: 'm1',
        sender: '02aa',
        body: encodeBody(Uint8Array.from([1])),
        created_at: 'not a date'
      },
      {
        messageId: 'm2',
        sender: '02aa',
        body: encodeBody(Uint8Array.from([2])),
        created_at: 'not a date'
      },
      {
        messageId: 'm3',
        sender: '02aa',
        body: encodeBody(Uint8Array.from([3])),
        created_at: '2026-01-01T00:00:00Z'
      }
    )
    const transport = new MessageBoxTransport(client, { pollIntervalMs: 1000 })
    transport.onError(() => undefined)
    const seen: string[] = []
    transport.onMessage((_from, payload) => {
      seen.push(String(payload[0]))
    })
    await transport.start()
    await vi.advanceTimersByTimeAsync(1000)

    expect(seen).toHaveLength(3)
    expect(new Set(seen)).toEqual(new Set(['1', '2', '3']))

    await transport.close()
  })

  it('reports a handler that threw something that is not an Error', async () => {
    const client = fakeClient()
    client.inbox.push({ messageId: 'm1', sender: '02aa', body: encodeBody(Uint8Array.from([1])) })
    const transport = new MessageBoxTransport(client, { pollIntervalMs: 1000, maxAttempts: 1 })
    const errors: Error[] = []
    transport.onError(error => errors.push(error))
    transport.onMessage(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'a string, as a careless handler might'
    })
    await transport.start()
    await vi.advanceTimersByTimeAsync(1000)

    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.every(error => error instanceof Error)).toBe(true)
    expect(errors.some(error => error.message.includes('careless handler'))).toBe(true)

    await transport.close()
  })

  it('ignores a second start, so the box is read on one cadence', async () => {
    const client = fakeClient()
    const transport = new MessageBoxTransport(client, { pollIntervalMs: 1000 })
    transport.onError(() => undefined)
    transport.onMessage(async () => {})
    await transport.start()
    await transport.start()
    await vi.advanceTimersByTimeAsync(1000)

    expect(client.listed).toHaveLength(1)

    await transport.close()
  })
})
