import { guardAuthenticatedResponse, type AuthenticatedResponseCandidate } from '../../mod.js'
import { queueFixture, deferred } from './authenticatedResponseQueue.fixture.js'

const fixtures: Awaited<ReturnType<typeof queueFixture>>[] = []
async function make(...args: Parameters<typeof queueFixture>) {
  const f = await queueFixture(...args)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})
const fetchSigned = (f: Awaited<ReturnType<typeof queueFixture>>, signal?: AbortSignal) =>
  f.client.fetch(f.url, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
    signal
  })
const replacement = () => ({
  statusCode: 409,
  headers: { 'content-type': 'application/json', 'x-bsv-result': 'reset-required' },
  body: Buffer.from(JSON.stringify({ error: 'reset-required' }))
})

it('authenticates and queues owned bytes exactly once after the complete response was signed', async () => {
  let observed: AuthenticatedResponseCandidate | undefined,
    doubleError = ''
  const f = await make((_req, res) => {
    guardAuthenticatedResponse(res, (candidate, enqueue) => {
      observed = candidate
      candidate.body.fill(0)
      candidate.headers['x-bsv-proof'] = 'changed'
      enqueue()
      try {
        enqueue()
      } catch (error) {
        doubleError = (error as Error).message
      }
    })
    res.status(201).set('x-bsv-proof', 'retained').json({ value: 'owned' })
  })
  const result = await fetchSigned(f)
  expect(result.status).toBe(201)
  expect(await result.json()).toEqual({ value: 'owned' })
  expect(result.headers.get('x-bsv-proof')).toBe('retained')
  expect(observed).toMatchObject({ identityKey: f.clientIdentity, attempt: 0, statusCode: 201 })
  expect(observed?.headers['x-bsv-auth-signature']).toMatch(/^[0-9a-f]+$/)
  expect(doubleError).toMatch(/no longer active/)
})
it('discards a candidate made stale during actual signing and signs a bounded replacement for the same request', async () => {
  let revision = 0
  const candidates: AuthenticatedResponseCandidate[] = []
  const f = await make((_req, res) => {
    const captured = revision
    guardAuthenticatedResponse(res, (candidate, enqueue) => {
      candidates.push(candidate)
      if (candidate.attempt === 0 && captured !== revision) return replacement()
      enqueue()
    })
    f.onSign(() => {
      revision++
    })
    res.set('x-bsv-private', 'must-not-leave').json({ advertisement: 'stale-row' })
  })
  const result = await fetchSigned(f)
  expect(result.status).toBe(409)
  expect(await result.json()).toEqual({ error: 'reset-required' })
  expect(result.headers.get('x-bsv-private')).toBeNull()
  expect(result.headers.get('x-bsv-result')).toBe('reset-required')
  expect(candidates.map(item => item.attempt)).toEqual([0, 1])
  expect(candidates[0].requestId).toBe(candidates[1].requestId)
  expect(candidates[0].headers['x-bsv-auth-signature']).not.toBe(
    candidates[1].headers['x-bsv-auth-signature']
  )
})
it('rejects guard registration on an unauthenticated request before route effects', async () => {
  let effects = 0
  const f = await make((_req, res) => {
    try {
      guardAuthenticatedResponse(res, () => undefined)
      effects++
    } catch (error) {
      res.status(400).json({ message: (error as Error).message })
    }
  })
  const result = await fetch(f.url, { method: 'POST' })
  expect(result.status).toBe(400)
  expect((await result.json()).message).toMatch(/authenticated request/)
  expect(effects).toBe(0)
})
it('rejects a buffering response wrapper before guarded route effects', async () => {
  let effects = 0
  const f = await make(
    (_req, res) => {
      try {
        guardAuthenticatedResponse(res, (_candidate, enqueue) => enqueue())
        effects++
      } catch (error) {
        res.status(400).json({ message: (error as Error).message })
      }
    },
    {
      before(req, res) {
        if (req.path === '/queue') {
          const original = res.end
          res.end = function (...args: Parameters<typeof res.end>) {
            return original.apply(this, args)
          }
        }
      }
    }
  )
  const result = await fetchSigned(f)
  expect(result.status).toBe(400)
  expect((await result.json()).message).toMatch(/buffering or replacement/)
  expect(effects).toBe(0)
})
it('rejects guard installation after an unguarded send has started', async () => {
  let late = ''
  const f = await make((_req, res) => {
    res.json({ ordinary: true })
    try {
      guardAuthenticatedResponse(res, (_candidate, enqueue) => enqueue())
    } catch (error) {
      late = (error as Error).message
    }
  })
  expect(await (await fetchSigned(f)).json()).toEqual({ ordinary: true })
  expect(late).toMatch(/before sending/)
})
it.each(['empty', 'second-replacement', 'throw', 'late-wrapper', 'oversized', 'bodyless'])(
  'closes a rejected guarded response without unsigned fallback or stale bytes (%s)',
  async mode => {
    let calls = 0
    const f = await make((_req, res) => {
      guardAuthenticatedResponse(res, () => {
        calls++
        if (mode === 'throw') throw new Error('private internal diagnostic')
        if (mode === 'second-replacement') return replacement()
        if (mode === 'oversized') return { ...replacement(), body: new Uint8Array(65537) }
      })
      if (mode === 'late-wrapper') {
        const writeHead = res.writeHead
        res.writeHead = function (...args: Parameters<typeof res.writeHead>) {
          return writeHead.apply(this, args)
        }
      }
      if (mode === 'bodyless') res.status(204)
      res.json({ secret: 'must-not-leave' })
    })
    await expect(fetchSigned(f, AbortSignal.timeout(5000))).rejects.toThrow()
    expect(calls).toBe(
      mode === 'second-replacement' ? 2 : mode === 'late-wrapper' || mode === 'bodyless' ? 0 : 1
    )
  }
)
it('cancels a timed-out guard and makes its retained enqueue callback unusable', async () => {
  const entered = deferred(),
    release = deferred()
  let enqueue: (() => void) | undefined, signal: AbortSignal | undefined
  const f = await make(
    (_req, res) => {
      guardAuthenticatedResponse(res, async (_candidate, commit, cancellation) => {
        enqueue = commit
        signal = cancellation
        entered.resolve()
        await release.promise
      })
      res.json({ secret: 'retained' })
    },
    { timeout: 250 }
  )
  const result = fetchSigned(f, AbortSignal.timeout(5000))
  await entered.promise
  await expect(result).rejects.toThrow()
  expect(signal?.aborted).toBe(true)
  expect(() => enqueue!()).toThrow(/no longer active/)
  release.resolve()
})
it('cancels pending guard work when the client disconnects', async () => {
  const entered = deferred(),
    cancelled = deferred(),
    release = deferred(),
    controller = new AbortController()
  let enqueue: (() => void) | undefined
  const f = await make((_req, res) => {
    guardAuthenticatedResponse(res, async (_candidate, commit, signal) => {
      enqueue = commit
      signal.addEventListener('abort', cancelled.resolve, { once: true })
      entered.resolve()
      await release.promise
    })
    res.json({ secret: 'retained' })
  })
  const result = fetchSigned(f, controller.signal)
  await entered.promise
  controller.abort()
  await expect(result).rejects.toThrow()
  await cancelled.promise
  expect(() => enqueue!()).toThrow(/no longer active/)
  release.resolve()
})

it('expires signing under the same deadline and never admits the late signed candidate', async () => {
  const entered = deferred(),
    release = deferred()
  let checked = 0
  const f = await make(
    (_req, res) => {
      guardAuthenticatedResponse(res, (_candidate, enqueue) => {
        checked++
        enqueue()
      })
      f.onSign(async () => {
        entered.resolve()
        await release.promise
      })
      res.json({ secret: 'retained-during-signing' })
    },
    { timeout: 250 }
  )
  const result = fetchSigned(f, AbortSignal.timeout(5000))
  await entered.promise
  await expect(result).rejects.toThrow()
  expect(checked).toBe(0)
  release.resolve()
})
it.each([204, 205])(
  'allows a signed bodyless %s response without unsigned metadata changes',
  async status => {
    const f = await make((_req, res) => {
      guardAuthenticatedResponse(res, (_candidate, enqueue) => enqueue())
      res.status(status).set('x-bsv-state', 'empty').end()
    })
    const response = await fetchSigned(f)
    expect(response.status).toBe(status)
    expect(await response.text()).toBe('')
    expect(response.headers.get('x-bsv-state')).toBe('empty')
  }
)
it('rejects duplicate registration and revokes the first candidate callback after a replacement', async () => {
  let earlier: (() => void) | undefined,
    duplicate = ''
  const f = await make((_req, res) => {
    guardAuthenticatedResponse(res, (candidate, enqueue) => {
      if (candidate.attempt === 0) {
        earlier = enqueue
        return replacement()
      }
      expect(() => earlier!()).toThrow(/no longer active/)
      enqueue()
    })
    try {
      guardAuthenticatedResponse(res, () => undefined)
    } catch (error) {
      duplicate = (error as Error).message
    }
    res.json({ old: true })
  })
  expect(await (await fetchSigned(f)).json()).toEqual({ error: 'reset-required' })
  expect(duplicate).toMatch(/exactly once/)
})

it.each([200, 204])(
  'presents the actual planned content length to the final guard (%i)',
  async status => {
    let length: string | undefined
    let wireLength: string | null | undefined
    const f = await make(
      (_req, res) => {
        guardAuthenticatedResponse(res, (candidate, enqueue) => {
          length = candidate.headers['content-length']
          enqueue()
        })
        res.status(status).set('content-length', '999999')
        if (status === 204) res.end()
        else res.send(Buffer.from([1, 2, 3]))
      },
      {
        received(response) {
          // AuthFetch exposes authenticated application headers separately;
          // framing must be checked on the actual HTTP response it receives.
          wireLength = response.headers.get('content-length')
        }
      }
    )
    const response = await fetchSigned(f)
    expect(length).toBe(status === 204 ? undefined : '3')
    expect(wireLength).toBe(status === 204 ? null : '3')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      status === 204 ? new Uint8Array() : Uint8Array.from([1, 2, 3])
    )
  }
)
