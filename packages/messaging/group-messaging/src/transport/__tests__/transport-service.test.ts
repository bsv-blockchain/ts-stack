import { describe, expect, it, vi } from 'vitest'
import type { IdentityKey, WirePayload } from '../../types.js'
import type { TransportBackend } from '../backend.js'
import { InProcessTransportHub } from '../backends/in-process.js'
import { BroadcastError, DeliveryFailed, TransportService } from '../transport-service.js'

const ALICE = `02${'aa'.repeat(32)}`
const BOB = `02${'bb'.repeat(32)}`
const CAROL = `02${'cc'.repeat(32)}`

/** A backend whose inbound side the test drives directly. */
const fakeBackend = () => {
  let onMessage: ((from: IdentityKey, payload: Uint8Array) => Promise<void>) | undefined
  let onError: ((error: Error) => void) | undefined
  return {
    sent: [] as Array<{ recipient: IdentityKey; payload: Uint8Array }>,
    async send(recipient: IdentityKey, payload: WirePayload) {
      this.sent.push({ recipient, payload })
    },
    onMessage(handler: (from: IdentityKey, payload: Uint8Array) => Promise<void>) {
      onMessage = handler
      return () => {
        onMessage = undefined
      }
    },
    onError(handler: (error: Error) => void) {
      onError = handler
      return () => {
        onError = undefined
      }
    },
    async deliver(from: IdentityKey, payload: Uint8Array) {
      await onMessage?.(from, payload)
    },
    fail(error: Error) {
      onError?.(error)
    }
  }
}

describe('InProcessTransportHub', () => {
  it('delivers to a listening endpoint', async () => {
    const hub = new InProcessTransportHub()
    const received: Array<{ from: string; payload: Uint8Array }> = []
    hub.endpoint(BOB).onMessage((from, payload) => {
      received.push({ from, payload })
    })

    await hub.endpoint(ALICE).send(BOB, new Uint8Array([9]))

    expect(received).toEqual([{ from: ALICE, payload: new Uint8Array([9]) }])
  })

  it("queues into the caller's map while an endpoint is offline", async () => {
    const queues = new Map<string, Uint8Array>()
    const hub = new InProcessTransportHub(queues)
    const received: number[] = []
    hub.endpoint(BOB).onMessage((_from, payload) => {
      received.push(payload[0]!)
    })

    hub.goOffline(BOB)
    await hub.endpoint(ALICE).send(BOB, new Uint8Array([1]))
    await hub.endpoint(ALICE).send(BOB, new Uint8Array([2]))

    expect(received).toEqual([])
    expect(hub.pendingCount(BOB)).toBe(2)
    expect(queues.has(BOB)).toBe(true)

    await hub.goOnline(BOB)

    expect(received).toEqual([1, 2])
    expect(hub.pendingCount(BOB)).toBe(0)
  })

  it('preserves the sender across a queued round trip', async () => {
    const hub = new InProcessTransportHub()
    hub.goOffline(BOB)
    await hub.endpoint(ALICE).send(BOB, new Uint8Array([5]))

    const received: string[] = []
    hub.endpoint(BOB).onMessage(from => {
      received.push(from)
    })
    await hub.goOnline(BOB)

    expect(received).toEqual([ALICE])
  })

  it('keeps a message sent mid-drain behind the ones already queued', async () => {
    // The property #flushing buys: a flush already running owns the queue, so
    // a send that lands while it is parked on a handler cannot overtake the
    // messages ahead of it. Commit-before-message ordering depends on it.
    const hub = new InProcessTransportHub()
    hub.goOffline(BOB)
    await hub.endpoint(ALICE).send(BOB, new Uint8Array([1]))
    await hub.endpoint(ALICE).send(BOB, new Uint8Array([2]))

    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const received: number[] = []
    hub.endpoint(BOB).onMessage(async (_from, payload) => {
      if (payload[0] === 1) await gate
      received.push(payload[0]!)
    })

    const draining = hub.goOnline(BOB)
    const late = hub.endpoint(ALICE).send(BOB, new Uint8Array([3]))
    release()
    await Promise.all([draining, late])

    expect(received).toEqual([1, 2, 3])
  })
})

describe('TransportService', () => {
  it('fans a broadcast out to every recipient', async () => {
    const hub = new InProcessTransportHub()
    const seen: Record<string, number[]> = { [BOB]: [], [CAROL]: [] }
    for (const identity of [BOB, CAROL]) {
      hub.endpoint(identity).onMessage((_from, payload) => {
        seen[identity]!.push(payload[0]!)
      })
    }

    const alice = await TransportService.open(hub.endpoint(ALICE))
    await alice.broadcast('g1', [BOB, CAROL], new Uint8Array([7]))

    expect(seen[BOB]).toEqual([7])
    expect(seen[CAROL]).toEqual([7])
  })

  it("uses the backend's own broadcast when it has one", async () => {
    const broadcast = vi.fn(async () => undefined)
    const backend: TransportBackend = {
      send: vi.fn(async () => undefined),
      broadcast,
      onMessage: () => () => undefined
    }
    const service = await TransportService.open(backend)

    await service.broadcast('g1', [BOB, CAROL], new Uint8Array([1]))

    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(backend.send).not.toHaveBeenCalled()
  })

  it('reports which recipients a broadcast failed to reach', async () => {
    const backend: TransportBackend = {
      send: async (recipient: IdentityKey) => {
        if (recipient === CAROL) throw new Error('unreachable')
      },
      onMessage: () => () => undefined
    }
    const service = await TransportService.open(backend)

    // A Commit that reached one of two members is a different situation from
    // one that reached none, so the error carries both halves.
    let error: unknown
    try {
      await service.broadcast('g1', [BOB, CAROL], new Uint8Array([1]))
    } catch (cause) {
      error = cause
    }

    expect(error).toBeInstanceOf(BroadcastError)
    const broadcastError = error as BroadcastError
    expect(broadcastError.failed).toEqual([CAROL])
    expect(broadcastError.delivered).toBe(1)
  })

  it('stops delivering once closed', async () => {
    const hub = new InProcessTransportHub()
    const bob = await TransportService.open(hub.endpoint(BOB))
    const received: number[] = []
    bob.onMessage((_from, payload) => {
      received.push(payload[0]!)
    })

    await hub.endpoint(ALICE).send(BOB, new Uint8Array([1]))
    await bob.close()
    await hub.endpoint(ALICE).send(BOB, new Uint8Array([2]))

    expect(received).toEqual([1])
  })

  it('closes the backend before it drops the handlers', async () => {
    // A backend with a delivery in flight must still find real subscribers, or
    // every handler "succeeds" vacuously and it acknowledges a batch nobody
    // received.
    const backend = fakeBackend()
    const received: number[] = []
    const service = new TransportService({
      ...backend,
      send: backend.send.bind(backend),
      close: async () => {
        await backend.deliver(ALICE, new Uint8Array([1]))
      }
    })
    service.onMessage((_from, payload) => {
      received.push(payload[0]!)
    })
    await service.start()

    await service.close()

    expect(received).toEqual([1])
  })

  it('rejects something it cannot recognize', async () => {
    await expect(TransportService.open({ nope: true } as never)).rejects.toThrow(
      /Unrecognized transport/
    )
  })
})

describe('handler isolation', () => {
  it('keeps delivering after one handler throws', async () => {
    const hub = new InProcessTransportHub()
    const service = await TransportService.open(hub.endpoint(BOB))
    const errors: string[] = []
    const delivered: number[] = []

    service.onError(error => {
      errors.push(error.message)
    })
    service.onMessage(() => {
      throw new Error('boom')
    })
    service.onMessage((_from, payload) => {
      delivered.push(payload[0]!)
    })

    await hub.endpoint(ALICE).send(BOB, new Uint8Array([1]))
    await hub.endpoint(ALICE).send(BOB, new Uint8Array([2]))

    expect(errors).toEqual(['boom', 'boom'])
    expect(delivered).toEqual([1, 2])
  })

  it('does not stall a queue drain when a handler throws', async () => {
    const hub = new InProcessTransportHub()
    hub.goOffline(BOB)
    await hub.endpoint(ALICE).send(BOB, new Uint8Array([1]))
    await hub.endpoint(ALICE).send(BOB, new Uint8Array([2]))

    const service = await TransportService.open(hub.endpoint(BOB))
    const delivered: number[] = []
    service.onError(() => undefined)
    service.onMessage(() => {
      throw new Error('boom')
    })
    service.onMessage((_from, payload) => {
      delivered.push(payload[0]!)
    })

    await hub.goOnline(BOB)

    expect(delivered).toEqual([1, 2])
    expect(hub.pendingCount(BOB)).toBe(0)
  })
})

describe('the delivery contract', () => {
  it('runs every handler even when an earlier one throws, then reports both', async () => {
    const backend = fakeBackend()
    const service = new TransportService(backend)
    const reported: Error[] = []
    service.onError(error => reported.push(error))

    const ran: string[] = []
    service.onMessage(() => {
      ran.push('first')
      throw new Error('first failed')
    })
    service.onMessage(() => {
      ran.push('second')
    })
    await service.start()

    await expect(backend.deliver('02aa', new Uint8Array([1]))).rejects.toThrow(DeliveryFailed)
    expect(ran).toEqual(['first', 'second'])
    expect(reported.map(error => error.message)).toEqual(['first failed'])
  })

  it('resolves when every handler succeeds, so a backend can acknowledge', async () => {
    const backend = fakeBackend()
    const service = new TransportService(backend)
    // Resolving is only half of it. The fake's deliver calls an optional
    // handler, so a service that subscribed to nothing also resolves — and a
    // backend would acknowledge a message no subscriber ever saw.
    const received: Array<{ from: string; payload: Uint8Array }> = []
    service.onMessage((from, payload) => {
      received.push({ from, payload })
    })
    await service.start()

    await expect(backend.deliver('02aa', new Uint8Array([1]))).resolves.toBeUndefined()
    expect(received).toEqual([{ from: '02aa', payload: new Uint8Array([1]) }])
  })

  it("forwards a backend's own error to the error handlers", async () => {
    const backend = fakeBackend()
    const service = new TransportService(backend)
    const reported: Error[] = []
    service.onError(error => reported.push(error))
    await service.start()

    backend.fail(new Error('poll returned 401'))

    expect(reported.map(error => error.message)).toEqual(['poll returned 401'])
  })
})

describe('errors raised while the backend starts', () => {
  it('forwards what the backend reports from inside its own start', async () => {
    const backend = fakeBackend()
    Object.assign(backend, {
      async start() {
        backend.fail(new Error('live delivery was refused'))
      }
    })
    const service = new TransportService(backend)
    const reported: Error[] = []
    service.onError(error => reported.push(error))

    await service.start()

    expect(reported.map(error => error.message)).toEqual(['live delivery was refused'])
  })
})
