import { afterEach, expect, it, jest } from '@jest/globals'
import { request } from 'node:http'
import express, { type Request, type RequestHandler } from 'express'
import { canonicalOutputJSON, PrivateKey } from '@bsv/sdk'
import { createPrivatePublicationRouter } from '../PrivatePublicationRoutes.js'
import { privatePublicationHTTPFixture } from './PrivatePublicationRoutes.fixture.js'

const fixtures: Awaited<ReturnType<typeof privatePublicationHTTPFixture>>[] = []
async function fixture(...args: Parameters<typeof privatePublicationHTTPFixture>) {
  const f = await privatePublicationHTTPFixture(...args)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})

it.each([
  ['content-type', 'text/plain', 400],
  ['content-encoding', 'gzip', 422],
  ['x-extra', 'x'.repeat(16385), 413]
])(
  'rejects bounded pre-authentication header %s without public effects',
  async (name, value, status) => {
    const f = await fixture()
    const response = await fetch(f.origin + '/api/overlay/v1/private/publish', {
      method: 'POST',
      headers: { ...f.headers, [name]: value },
      body: JSON.stringify(f.contract.request)
    })
    expect(response.status).toBe(status)
    expect((await response.json()).error).toBeDefined()
    expect(f.native.rows()).toEqual([])
    expect(f.calls).toEqual([])
  }
)
it('bounds raw bytes, rejects malformed UTF-8, and enforces mount ordering', async () => {
  const f = await fixture({ maximumRequestBytes: 1024 })
  for (const [body, status] of [
    ['x'.repeat(1025), 413],
    ['', 400],
    [Buffer.from([0xff]), 400]
  ] as const) {
    const response = await fetch(f.origin + '/api/overlay/v1/private/status', {
      method: 'POST',
      headers: f.headers,
      body
    })
    expect(response.status).toBe(status)
  }
  const parsed = await fixture({}, true)
  const response = await fetch(parsed.origin + '/api/overlay/v1/private/publish', {
    method: 'POST',
    headers: parsed.headers,
    body: '{}'
  })
  expect(response.status).toBe(422)
  expect(f.calls).toEqual([])
  expect(parsed.calls).toEqual([])
})
it('enforces exact selected profile and no-store on authenticated requests', async () => {
  const f = await fixture()
  for (const [name, value, code, status] of [
    ['x-bsv-overlay-profile', 'urn:unknown', 'unsupported', 422],
    ['cache-control', 'public', 'invalid', 400],
    ['x-bsv-overlay-capability', 'invalid', 'invalid', 400]
  ] as const) {
    const response = await f.client.fetch(f.origin + '/api/overlay/v1/private/publish', {
      method: 'POST',
      headers: { ...f.headers, [name]: value },
      body: JSON.stringify(f.contract.request)
    })
    expect(response.status).toBe(status)
    expect((await response.json()).error.code).toBe(code)
  }
  expect(f.calls).toEqual([])
})
it('keeps disconnected work counted until physical settlement', async () => {
  const f = await fixture({ maximumWork: 1 })
  expect((await f.fetch()).status).toBe(200)
  const result = await f.coordinator.status(f.status, f.caller)
  let release!: (value: typeof result) => void, began!: () => void
  const started = new Promise<void>(resolve => {
    began = resolve
  })
  const pending = new Promise<typeof result>(resolve => {
    release = resolve
  })
  const original = f.coordinator.status.bind(f.coordinator)
  jest
    .spyOn(f.coordinator, 'status')
    .mockImplementationOnce(async () => {
      began()
      return await pending
    })
    .mockImplementation(original)
  const controller = new AbortController(),
    abortable = f.clientFor(new PrivateKey(63), controller.signal)
  const first = Promise.allSettled([
    abortable.fetch(f.origin + '/api/overlay/v1/private/status', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(f.status)
    })
  ])
  try {
    await started
    controller.abort()
    expect((await first)[0].status).toBe('rejected')
    const blocked = await f.fetch('status')
    expect(blocked.status).toBe(413)
    expect((await blocked.json()).error.code).toBe('limited')
  } finally {
    release(result)
    await first
  }
  await new Promise<void>(resolve => setImmediate(resolve))
  expect((await f.fetch('status')).status).toBe(200)
})
it('bounds prepared responses and controls signed diagnostics under current native policy', async () => {
  const f = await fixture({ maximumResponseBytes: 1 })
  const response = await f.fetch()
  expect(response.status).toBe(413)
  expect((await response.json()).error.code).toBe('limited')
  f.httpState.control = false
  await expect(f.fetch('status')).rejects.toThrow()
})
it('preserves credential-free default CORS and enforces only explicitly installed origins', async () => {
  const f = await fixture(),
    restricted = await fixture({ allowedOrigins: ['https://allowed.example'] })
  for (const [owner, origin, status] of [
    [f, 'https://unknown.example', 204],
    [restricted, 'https://allowed.example', 204],
    [restricted, 'https://denied.example', 403]
  ] as const) {
    const response = await fetch(owner.origin + '/api/overlay/v1/private/status', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-headers': 'content-type, x-bsv-overlay-profile' }
    })
    expect(response.status).toBe(status)
    expect(response.headers.has('access-control-allow-credentials')).toBe(false)
    if (status === 204)
      expect(response.headers.get('access-control-allow-origin')).toBe(owner === f ? '*' : origin)
  }
  const publicResult = await fetch(f.origin + '/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  expect(await publicResult.json()).toEqual({ type: 'output-list', outputs: [] })
})
it('accepts the profile ceiling and rejects invalid transport configurations', async () => {
  const f = await fixture()
  expect(() =>
    createPrivatePublicationRouter({ ...f.options, maximumRequestBytes: 4194304 })
  ).not.toThrow()
  for (const options of [
    { maximumRequestBytes: 4194305 },
    { maximumRequestBytes: 0 },
    { maximumResponseBytes: 4194305 },
    { maximumWork: 0 },
    { maximumWork: 1, maximumWorkPerPrincipal: 2 },
    { requestTimeoutMs: 30001 },
    { allowedOrigins: ['*'] }
  ])
    expect(() => createPrivatePublicationRouter({ ...f.options, ...options })).toThrow()
})
it.each([
  '/api/overlay/v1/private/status?x=1',
  '/api/overlay/v1/private/STATUS',
  '/api/overlay/v1/private/status/'
])('rejects ambiguous selected endpoint %s', async path => {
  const f = await fixture()
  const response = await fetch(f.origin + path, { method: 'POST', headers: f.headers, body: '{}' })
  expect([400, 404]).toContain(response.status)
  expect(await response.json()).toEqual({
    version: 1,
    error: {
      code: path.includes('?') ? 'invalid' : 'not-found',
      message: 'Private publication request ' + (path.includes('?') ? 'invalid' : 'not-found'),
      retryable: false
    }
  })
  expect(f.native.rows()).toEqual([])
})

it('rejects duplicate wire header names before authentication or publication effects', async () => {
  const f = await fixture(),
    response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        f.origin + '/api/overlay/v1/private/publish',
        {
          method: 'POST',
          headers: [
            'Host',
            new URL(f.origin).host,
            'Content-Length',
            '2',
            ...Object.entries(f.headers).flat(),
            'CONTENT-TYPE',
            'application/json'
          ]
        },
        res => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.once('error', reject)
          res.once('end', () =>
            resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') })
          )
        }
      )
      req.once('error', reject)
      req.end('{}')
    })
  expect(response.status).toBe(400)
  expect(JSON.parse(response.body).error.code).toBe('invalid')
  expect(f.native.rows()).toEqual([])
  expect(f.calls).toEqual([])
})

it('requires authentication and both native disclosure operations when constructing a route', async () => {
  const f = await fixture(),
    disclosure = {
      prepare: f.disclosure.prepare.bind(f.disclosure),
      enqueueControl: f.disclosure.enqueueControl.bind(f.disclosure)
    }
  for (const changed of [
    { authenticate: undefined },
    { disclosure: { ...disclosure, prepare: undefined } },
    { disclosure: { ...disclosure, enqueueControl: undefined } }
  ]) {
    expect(() =>
      createPrivatePublicationRouter({
        ...f.options,
        ...changed
      } as unknown as Parameters<typeof createPrivatePublicationRouter>[0])
    ).toThrow('Private publication routes require authentication and a native disclosure owner')
  }
  expect(f.native.rows()).toEqual([])
})

it('retains the request slot until a genuine authenticated status operation physically settles', async () => {
  const f = await fixture({ maximumRequests: 1 })
  expect((await f.fetch()).status).toBe(200)
  let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => {
      entered = resolve
    }),
    blocked = new Promise<void>(resolve => {
      finish = resolve
    }),
    original = f.coordinator.status.bind(f.coordinator),
    changed = jest.spyOn(f.coordinator, 'status').mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      entered()
      await blocked
      return result
    }),
    first = f.fetch('status')
  try {
    await started
    const response = await fetch(f.origin + '/api/overlay/v1/private/status', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(f.status)
    })
    expect(response.status).toBe(413)
    expect((await response.json()).error).toEqual({
      code: 'limited',
      message: 'Private publication request limited',
      retryable: true
    })
  } finally {
    finish()
    await first
    changed.mockRestore()
  }
  expect((await f.fetch('status')).status).toBe(200)
})

it.each([false, true])(
  'fails closed when installed authentication returns without handling the handshake (error=%p)',
  async fail => {
    const f = await fixture({
      authenticate: (_req, _res, next) => next(fail ? new Error('private auth detail') : undefined)
    })
    const response = await fetch(f.origin + '/.well-known/auth', {
      method: 'POST',
      headers: f.headers,
      body: '{}'
    })
    expect(response.status).toBe(fail ? 503 : 422)
    expect((await response.json()).error).toEqual({
      code: fail ? 'unavailable' : 'unsupported',
      message: 'Private publication request ' + (fail ? 'unavailable' : 'unsupported'),
      retryable: fail
    })
    expect(f.native.rows()).toEqual([])
    expect(f.calls).toEqual([])
  }
)

it('destroys the response when its HTTP adapter fails after native response guarding is installed', async () => {
  let authenticate!: RequestHandler,
    failed = false
  const f = await fixture(
    {
      authenticate: (req, res, next) =>
        authenticate(req, res, error => {
          if (!error && req.path.endsWith('/publish')) {
            jest.spyOn(res, 'status').mockImplementation(() => {
              failed = true
              throw new Error('private HTTP adapter detail')
            })
          }
          next(error)
        })
    },
    false,
    (_app, installed) => {
      authenticate = installed
    }
  )
  await expect(f.fetch()).rejects.toThrow()
  expect(failed).toBe(true)
  expect(f.calls).toHaveLength(1)
  await expect(f.coordinator.status(f.status, f.caller)).resolves.toMatchObject({
    publicationId: f.status.publicationId,
    status: 'ready'
  })
})

it.each(['other-error', 'non-error', 'inherited-type'] as const)(
  'normalizes a native raw-parser %s refusal before authentication',
  async fault => {
    const native = express.raw
    const parser = jest.spyOn(express, 'raw').mockImplementation(options => {
      const installed = native(options)
      return (req, res, next) =>
        installed(req, res, error => {
          if (!error) return next()
          if (fault === 'non-error') return next('Malformed parser error data')
          const refused = new Error('Controlled raw-parser refusal')
          if (fault === 'inherited-type')
            Object.setPrototypeOf(
              refused,
              Object.assign(Object.create(Error.prototype), { type: 'entity.too.large' })
            )
          next(refused)
        })
    })
    let f: Awaited<ReturnType<typeof fixture>>
    try {
      f = await fixture({ maximumRequestBytes: 1024 })
    } finally {
      parser.mockRestore()
    }
    const response = await fetch(f!.origin + '/api/overlay/v1/private/status', {
      method: 'POST',
      headers: f!.headers,
      body: 'x'.repeat(1025)
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatchObject({
      code: 'invalid',
      message: 'Private publication request invalid'
    })
    expect(f!.native.rows()).toEqual([])
    expect(f!.calls).toEqual([])
  }
)

it('accepts identity encoding and case-insensitive JSON media types while refusing missing media selection', async () => {
  const f = await fixture()
  const accepted = await f.client.fetch(f.origin + '/api/overlay/v1/private/publish', {
    method: 'POST',
    headers: {
      ...f.headers,
      'content-type': 'APPLICATION/JSON; charset=utf-8'
    },
    body: JSON.stringify(f.contract.request)
  })
  expect(accepted.status).toBe(200)
  const identity = await fetch(f.origin + '/api/overlay/v1/private/status', {
    method: 'POST',
    headers: { ...f.headers, 'content-encoding': 'identity' },
    body: '{}'
  })
  expect(identity.status).toBe(401)
  expect((await identity.json()).error.code).toBe('unauthorized')
  const absent = await fetch(f.origin + '/api/overlay/v1/private/status', {
    method: 'POST',
    headers: { 'cache-control': 'no-store' },
    body: Buffer.from('{}')
  })
  expect(absent.status).toBe(400)
  expect((await absent.json()).error.code).toBe('invalid')
})

it('keeps an explicitly disabled handshake outside the private route owner', async () => {
  const f = await fixture({ handleHandshake: false })
  const response = await fetch(f.origin + '/.well-known/auth', {
    method: 'POST',
    headers: f.headers,
    body: '{}'
  })
  expect(response.status).toBe(404)
  expect(response.headers.get('content-type')).toContain('text/html')
  expect(f.calls).toEqual([])
})

it.each(['principal', 'global'] as const)(
  'enforces the independent %s work ceiling and recovers capacity after physical settlement',
  async boundary => {
    const f = await fixture({
      maximumWork: boundary === 'global' ? 2 : 3,
      maximumWorkPerPrincipal: 2
    })
    expect((await f.fetch()).status).toBe(200)
    let finish!: () => void,
      began!: () => void,
      calls = 0
    const blocked = new Promise<void>(resolve => {
        finish = resolve
      }),
      started = new Promise<void>(resolve => {
        began = resolve
      }),
      original = f.coordinator.status.bind(f.coordinator),
      changed = jest.spyOn(f.coordinator, 'status').mockImplementation(async (...args) => {
        calls++
        if (calls === 2) began()
        await blocked
        return await original(...args)
      }),
      second = boundary === 'global' ? f.clientFor(new PrivateKey(64)) : f.client,
      active = Promise.allSettled([
        f.fetch('status'),
        second.fetch(f.origin + '/api/overlay/v1/private/status', {
          method: 'POST',
          headers: f.headers,
          body: JSON.stringify(f.status)
        })
      ])
    try {
      await started
      const response = await f.fetch('status')
      expect(response.status).toBe(413)
      expect((await response.json()).error).toEqual({
        code: 'limited',
        message: 'Private publication request limited',
        retryable: true
      })
      expect(calls).toBe(2)
    } finally {
      finish()
      await active
      changed.mockRestore()
    }
    expect((await f.fetch('status')).status).toBe(200)
  }
)

it('cancels a timed-out authenticated response while retaining its occupied work slot until settlement', async () => {
  const f = await fixture({ requestTimeoutMs: 500, maximumWork: 1 })
  expect((await f.fetch()).status).toBe(200)
  let finish!: () => void, began!: () => void, closed!: () => void
  const blocked = new Promise<void>(resolve => {
      finish = resolve
    }),
    started = new Promise<void>(resolve => {
      began = resolve
    }),
    cancelled = new Promise<void>(resolve => {
      closed = resolve
    }),
    original = f.coordinator.status.bind(f.coordinator),
    callers: Parameters<typeof original>[1][] = [],
    changed = jest.spyOn(f.coordinator, 'status').mockImplementationOnce(async (...args) => {
      callers.push(args[1])
      args[1].signal!.addEventListener('abort', closed, { once: true })
      began()
      await blocked
      return await original(...args)
    }),
    pending = Promise.allSettled([f.fetch('status')])
  try {
    await started
    const beganAt = performance.now()
    expect((await pending)[0].status).toBe('rejected')
    await cancelled
    expect(performance.now() - beganAt).toBeLessThan(2000)
    expect(callers[0].signal!.aborted).toBe(true)
    expect(callers[0].current()).toBe(false)
    const response = await f.fetch('status')
    expect(response.status).toBe(413)
    expect((await response.json()).error.code).toBe('limited')
  } finally {
    finish()
    await pending
    changed.mockRestore()
  }
  expect((await f.fetch('status')).status).toBe(200)
})

it.each(['absent', 'unknown'] as const)(
  'rejects %s identity from an unhandled authentication adapter',
  async mode => {
    const f = await fixture({
      authenticate: (req, _res, next) => {
        if (mode === 'unknown') Object.assign(req, { auth: { identityKey: 'unknown' } })
        next()
      }
    })
    const response = await fetch(f.origin + '/api/overlay/v1/private/status', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(f.status)
    })
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('unauthorized')
    expect(f.calls).toEqual([])
  }
)

it('keeps both the authenticated request owner and its identity live through native work', async () => {
  let authenticate!: RequestHandler, selected!: Request & { auth: { identityKey: string } }
  const f = await fixture(
    {
      authenticate: (req, res, next) =>
        authenticate(req, res, error => {
          selected = req as typeof selected
          next(error)
        })
    },
    false,
    (_app, installed) => {
      authenticate = installed
    }
  )
  expect((await f.fetch()).status).toBe(200)
  const original = f.coordinator.status.bind(f.coordinator),
    changed = jest.spyOn(f.coordinator, 'status').mockImplementationOnce(async (input, caller) => {
      const owner = selected.auth,
        identity = owner.identityKey
      expect(caller.current()).toBe(true)
      try {
        selected.auth = { ...owner }
        expect(caller.current()).toBe(false)
        selected.auth = owner
        owner.identityKey = new PrivateKey(64).toPublicKey().toString()
        expect(caller.current()).toBe(false)
      } finally {
        selected.auth = owner
        owner.identityKey = identity
      }
      expect(caller.current()).toBe(true)
      return await original(input, caller)
    })
  try {
    expect((await f.fetch('status')).status).toBe(200)
  } finally {
    changed.mockRestore()
  }
})

it('accepts an exactly full native response and a canonical base URL with a final slash', async () => {
  const f = await fixture(async owner => {
    await owner.coordinator.publish(owner.contract.request, owner.caller)
    const result = await owner.coordinator.status(owner.status, owner.caller)
    return {
      maximumResponseBytes: Buffer.byteLength(canonicalOutputJSON(result)),
      baseURL: owner.contract.installation.baseURL + '/'
    }
  })
  const response = await f.fetch('status')
  expect(response.status).toBe(200)
  expect((await response.json()).status).toBe('ready')
})
