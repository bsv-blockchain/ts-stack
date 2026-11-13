import { LookupProviderService } from '../src/lookup/LookupProviderService.js'
import { providerFixture } from './lookup-provider-fixture.js'
import { expect, jest } from '@jest/globals'
import { LookupResponseDisclosure } from '../src/lookup/LookupResponseDisclosure.js'
import { LookupProviderWork } from '../src/lookup/LookupProviderWork.js'
import { afterEach, test } from '@jest/globals'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { canonicalOutputJSON } from '@bsv/sdk'
import { SQLiteLookupIndex } from '../src/lookup/SQLiteLookupIndex.js'
import { SQLiteLookupSessions } from '../src/lookup/SQLiteLookupSessions.js'
import { LookupSessionCodec } from '../src/lookup/LookupSessionCodec.js'
import { lookupSessionFixture } from './lookup-session-fixture.js'
import { liveFixture } from './live-lookup-fixture.js'
import { lookupSendServiceFixture } from './lookup-send-fixture.js'
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0)) await close()
})
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lookup-native-send-'))
  const path = join(directory, 'index.sqlite'),
    binding = { service: 'records', rules: 'test' }
  const index = SQLiteLookupIndex.create(path, 'records', binding)
  closes.push(async () => {
    await index.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const clock = { now: '1000' }
  const codec = new LookupSessionCodec(liveFixture({}, undefined, 'brc103').selection)
  const sessions = SQLiteLookupSessions.create(index, codec, () => clock.now)
  const epoch = await sessions.createEpoch()
  await sessions.initializeGuard('serving')
  await index.advanceTime('1000', 10)
  const { value } = lookupSessionFixture('brc103', epoch, '0')
  await sessions.commit(value)
  const authorization = { principal: value.principal, access: value.access, guards: value.guards }
  const body = await sessions.serialize(value.session, authorization, value.first)
  const candidate = {
    reference: { kind: 'session' as const, session: value.session, principal: value.principal },
    bytes: new TextEncoder().encode(body)
  }
  return { index, path, sessions, value, clock, body, candidate, authorization }
}
test('enqueues original bytes once under a lock shared with an independent writer', async () => {
  const f = await fixture(),
    sent: Uint8Array[] = []
  const lock = `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=1'); try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); process.stdout.write('acquired') } catch(e) { if(e.errcode !== 5) throw e; process.stdout.write('busy') } finally { db.close() }`
  await f.sessions.enqueueResponse(
    f.candidate,
    (header, bytes) => {
      assert.equal(header?.session, f.value.session)
      assert.equal(header?.principal, f.value.principal)
      assert.equal(new TextDecoder().decode(bytes), f.body)
      // Validator receives owned copies; it cannot alter the bytes entering the queue.
      header!.first.expiresAt = '0'
      bytes.fill(0)
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', lock, f.path], {
        encoding: 'utf8'
      })
      assert.equal(child.status, 0)
      assert.equal(child.stdout, 'busy')
      return true
    },
    bytes => {
      sent.push(bytes)
      return undefined
    }
  )
  assert.equal(sent.length, 1)
  assert.equal(new TextDecoder().decode(sent[0]), f.body)
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', lock, f.path], {
    encoding: 'utf8'
  })
  assert.equal(child.status, 0)
  assert.equal(child.stdout, 'acquired')
})
test('rechecks a durable guard changed after earlier serialization', async () => {
  const f = await fixture()
  let count = 0
  await f.sessions.blockGuard('serving', '0', 'aa'.repeat(32))
  await assert.rejects(
    f.sessions.enqueueResponse(
      f.candidate,
      () => true,
      () => {
        count++
        return undefined
      }
    ),
    { code: 'reset-required' }
  )
  assert.equal(count, 0)
})
test('rechecks expiry after the current validator and before native enqueue', async () => {
  const f = await fixture()
  let count = 0
  await assert.rejects(
    f.sessions.enqueueResponse(
      f.candidate,
      () => {
        f.clock.now = f.value.first.expiresAt
        return true
      },
      () => {
        count++
        return undefined
      }
    ),
    { code: 'reset-required', message: 'Lookup session expired before enqueue' }
  )
  assert.equal(count, 0)
})
test('a closed session cannot reuse previously serialized bytes', async () => {
  const f = await fixture()
  let count = 0
  await f.sessions.closeSession(f.value.session, f.authorization)
  await assert.rejects(
    f.sessions.enqueueResponse(
      f.candidate,
      () => true,
      () => {
        count++
        return undefined
      }
    ),
    { code: 'expired', message: 'Lookup session is closed' }
  )
  assert.equal(count, 0)
})
test('denied current access stops disclosure and leaves ordinary storage usable', async () => {
  const f = await fixture()
  let count = 0
  await assert.rejects(
    f.sessions.enqueueResponse(
      f.candidate,
      () => false,
      () => {
        count++
        return undefined
      }
    ),
    { code: 'unauthorized' }
  )
  assert.equal(count, 0)
  assert.equal(await f.sessions.guard('serving'), '0')
})
for (const field of ['session', 'scope', 'cursor', 'highWater'] as const)
  test(`rejects changed ${field} before enqueue`, async () => {
    const f = await fixture(),
      body = structuredClone(f.value.first)
    let count = 0
    if (field === 'session') body.session = '77'.repeat(32)
    if (field === 'scope') body.scope.access = 'different'
    if (field === 'cursor') body.cursor = 'invalid'
    if (field === 'highWater') body.highWater = '9'
    const bytes = new TextEncoder().encode(canonicalOutputJSON(body))
    await assert.rejects(
      f.sessions.enqueueResponse(
        { ...f.candidate, bytes },
        () => true,
        () => {
          count++
          return undefined
        }
      )
    )
    assert.equal(count, 0)
  })
test('control responses require their own current authorization without a session', async () => {
  const f = await fixture(),
    bytes = new TextEncoder().encode('{}')
  let count = 0
  await f.sessions.enqueueResponse(
    { reference: { kind: 'control' }, bytes },
    header => {
      assert.equal(header, undefined)
      return true
    },
    owned => {
      assert.deepEqual(owned, bytes)
      count++
      return undefined
    }
  )
  await assert.rejects(
    f.sessions.enqueueResponse(
      { reference: { kind: 'control' }, bytes },
      () => false,
      () => {
        count++
        return undefined
      }
    ),
    { code: 'unauthorized' }
  )
  assert.equal(count, 1)
})
test('rejects async callbacks before invoking them', async () => {
  const f = await fixture()
  let count = 0
  await assert.rejects(
    f.sessions.enqueueResponse(
      f.candidate,
      (async () => {
        count++
        return true
      }) as never,
      () => undefined
    ),
    { code: 'invalid' }
  )
  await assert.rejects(
    f.sessions.enqueueResponse(f.candidate, () => true, (async () => {
      count++
    }) as never),
    { code: 'invalid' }
  )
  assert.equal(count, 0)
})
test('propagates failure after an enqueue attempt without invoking another enqueue', async () => {
  const f = await fixture(),
    failure = new Error('uncertain queue acknowledgement')
  let count = 0
  await assert.rejects(
    f.sessions.enqueueResponse(
      f.candidate,
      () => true,
      () => {
        count++
        throw failure
      }
    ),
    error => error === failure
  )
  assert.equal(count, 1)
  assert.equal(await f.sessions.guard('serving'), '0')
})
test('blocks reentrant session work while validating a response', async () => {
  const f = await fixture()
  let attempt: Promise<unknown> | undefined
  await f.sessions.enqueueResponse(
    f.candidate,
    () => {
      attempt = f.sessions.blockGuard('serving', '0', 'bb'.repeat(32))
      return true
    },
    () => undefined
  )
  await assert.rejects(attempt!, {
    code: 'unavailable',
    message: 'Lookup session gate is reentered'
  })
  assert.equal(await f.sessions.guard('serving'), '0')
})

async function serviceFixture() {
  const f = await lookupSendServiceFixture()
  closes.push(() => f.cleanup())
  return f
}
test('composes fresh authorization with original native session delivery across manifest rotation', async () => {
  const f = await serviceFixture()
  let count = 0
  const bound = f.disclosure.bind('open', f.response.body, f.caller)
  await f.rotate()
  await bound.enqueue(
    f.bytes,
    f.caller.principal!,
    bytes => {
      assert.deepEqual(bytes, f.bytes)
      count++
      return undefined
    },
    new AbortController().signal
  )
  assert.equal(count, 1)
})
test('never discloses when authorization changes after response preparation', async () => {
  const f = await serviceFixture()
  let count = 0
  const bound = f.disclosure.bind('open', f.response.body, f.caller)
  f.access.allowed = false
  await assert.rejects(
    bound.enqueue(
      f.bytes,
      f.caller.principal!,
      () => {
        count++
        return undefined
      },
      new AbortController().signal
    ),
    { code: 'unauthorized' }
  )
  assert.equal(count, 0)
})
test('does not let current authorization silently adopt a newer durable guard revision', async () => {
  const f = await serviceFixture()
  let count = 0
  const bound = f.disclosure.bind('open', f.response.body, f.caller)
  await f.sessions.advanceGuard('serving', '0')
  await assert.rejects(
    bound.enqueue(
      f.bytes,
      f.caller.principal!,
      () => {
        count++
        return undefined
      },
      new AbortController().signal
    ),
    { code: 'unauthorized' }
  )
  assert.equal(count, 0)
})
test('binds original response bytes, identity and cancellation independently of session validity', async () => {
  const f = await serviceFixture(),
    bound = f.disclosure.bind('open', f.response.body, f.caller)
  let count = 0
  const enqueue = () => {
      count++
      return undefined
    },
    signal = new AbortController().signal
  await assert.rejects(
    bound.enqueue(new TextEncoder().encode('{}'), f.caller.principal!, enqueue, signal),
    { code: 'invalid' }
  )
  await assert.rejects(bound.enqueue(f.bytes, 'different', enqueue, signal), {
    code: 'unauthorized'
  })
  await assert.rejects(bound.enqueue(f.bytes, f.caller.principal!, enqueue, AbortSignal.abort()), {
    code: 'cancelled'
  })
  assert.equal(count, 0)
})
test('control bindings reject data envelopes and apply current control authorization', async () => {
  const f = await serviceFixture()
  let count = 0
  assert.throws(() => f.disclosure.control(f.response.body, f.caller), { code: 'invalid' })
  const text = canonicalOutputJSON({ version: 1, closed: true }),
    bytes = new TextEncoder().encode(text)
  const bound = f.disclosure.control(text, f.caller)
  f.access.control = false
  await assert.rejects(
    bound.enqueue(
      bytes,
      f.caller.principal!,
      () => {
        count++
        return undefined
      },
      new AbortController().signal
    ),
    { code: 'unauthorized' }
  )
  assert.equal(count, 0)
  f.access.control = true
  await bound.enqueue(
    bytes,
    f.caller.principal!,
    () => {
      count++
      return undefined
    },
    new AbortController().signal
  )
  assert.equal(count, 1)
})

test('owns Buffer input bytes independently of both caller and validator mutation', async () => {
  const f = await fixture(),
    original = Buffer.from(f.body),
    expected = new TextEncoder().encode(f.body)
  let received: Uint8Array | undefined
  await f.sessions.enqueueResponse(
    { ...f.candidate, bytes: original },
    (_header, bytes) => {
      bytes.fill(0)
      original.fill(1)
      return true
    },
    bytes => {
      received = bytes
      return undefined
    }
  )
  assert.deepEqual(received, expected)
})

test('rejects malformed native selectors, byte capacities and callback results without a successful enqueue', async () => {
  const f = await fixture()
  let count = 0
  const enqueue = () => {
    count++
    return undefined
  }
  for (const candidate of [
    { ...f.candidate, extra: true },
    { ...f.candidate, bytes: [] },
    { ...f.candidate, bytes: new Uint8Array(4194305) },
    { ...f.candidate, reference: { kind: 'unknown' } },
    { ...f.candidate, reference: { kind: 'control', session: f.value.session } },
    { ...f.candidate, reference: { ...f.candidate.reference, session: 'bad' } },
    { ...f.candidate, reference: { ...f.candidate.reference, principal: 'bad' } }
  ])
    await assert.rejects(
      f.sessions.enqueueResponse(candidate as never, () => true, enqueue),
      { code: 'invalid' }
    )
  await assert.rejects(
    f.sessions.enqueueResponse(f.candidate, (() => Promise.resolve(true)) as never, enqueue),
    { code: 'unauthorized' }
  )
  assert.equal(count, 0)
  await assert.rejects(
    f.sessions.enqueueResponse(f.candidate, () => true, (() => {
      count++
      return 'not synchronous completion'
    }) as never),
    { code: 'invalid' }
  )
  assert.equal(count, 1)
})
test('rejects unbound principals, unknown operations and oversized or malformed control bodies', async () => {
  const f = await serviceFixture()
  assert.throws(() => f.disclosure.bind('close' as never, f.response.body, f.caller), {
    code: 'invalid'
  })
  assert.throws(
    () => f.disclosure.bind('open', f.response.body, { ...f.caller, principal: null }),
    { code: 'unsupported' }
  )
  assert.throws(
    () => f.disclosure.bind('open', f.response.body, { ...f.caller, capabilityDigest: 'bad' }),
    { code: 'invalid' }
  )
  for (const body of [undefined, ' '.repeat(4194305), 'é'.repeat(2100000)])
    assert.throws(() => f.disclosure.control(body as never, f.caller), { code: 'limited' })
  for (const body of [
    '{}',
    '{"version":2,"closed":true}',
    '{"version":1,"closed":false}',
    JSON.stringify({ version: 1, closed: true, extra: true })
  ])
    assert.throws(() => f.disclosure.control(body, f.caller), { code: 'invalid' })
  const packet = {
    version: 1,
    error: { code: 'not-found', message: 'Unavailable', retryable: false }
  }
  const body = canonicalOutputJSON(packet),
    bytes = new TextEncoder().encode(body)
  let sent = 0
  await f.disclosure.control(body, f.caller).enqueue(
    bytes,
    f.caller.principal!,
    () => {
      sent++
      return undefined
    },
    new AbortController().signal
  )
  assert.equal(sent, 1)
})

test('requires durable native delivery and a synchronous control policy at installation', async () => {
  const f = await serviceFixture()
  const options = {
    sessions: f.sessions,
    contracts: f.contracts,
    authorize: async () => ({ access: 'public', guards: [] }),
    authorizeControl: () => true
  }
  for (const sessions of [
    { ...f.sessions, durability: 'volatile' },
    { ...f.sessions, responseEnqueue: 'other' }
  ])
    expect(() => new LookupResponseDisclosure({ ...options, sessions } as never)).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: 'Lookup disclosure requires a durable native-enqueue store'
      })
    )
  for (const authorizeControl of [undefined, async () => true])
    expect(() => new LookupResponseDisclosure({ ...options, authorizeControl } as never)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Lookup control authorization must be synchronous'
      })
    )
  const body = JSON.parse(f.response.body)
  body.scope.service = 'different'
  expect(() => f.disclosure.bind('open', canonicalOutputJSON(body), f.caller)).toThrow(
    expect.objectContaining({ code: 'context-changed', message: 'Lookup response service changed' })
  )
})

test('cancelled disclosure retains its physical authorization slot until the operation settles', async () => {
  const f = await serviceFixture(),
    work = new LookupProviderWork(1, 1, 30000)
  let release!: () => void, started!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  const entered = new Promise<void>(resolve => {
    started = resolve
  })
  let calls = 0,
    sent = 0
  const disclosure = new LookupResponseDisclosure({
    sessions: f.sessions,
    contracts: f.contracts,
    work,
    authorizeControl: () => true,
    authorize: async context => {
      calls++
      started()
      await pending
      return {
        access: context.principal!,
        guards: [{ id: 'serving', revision: '0', failure: 'unauthorized' }]
      }
    }
  })
  const bound = disclosure.bind('read', f.response.body, f.caller),
    abort = new AbortController()
  const result = bound.enqueue(
    f.bytes,
    f.caller.principal!,
    () => {
      sent++
      return undefined
    },
    abort.signal
  )
  const failed = expect(result).rejects.toMatchObject({ code: 'cancelled' })
  await entered
  abort.abort()
  await failed
  await expect(
    bound.enqueue(f.bytes, f.caller.principal!, () => undefined, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'limited' })
  expect(calls).toBe(1)
  expect(sent).toBe(0)
  release()
  await new Promise<void>(resolve => setImmediate(resolve))
  await bound.enqueue(
    f.bytes,
    f.caller.principal!,
    () => {
      sent++
      return undefined
    },
    new AbortController().signal
  )
  expect(calls).toBe(2)
  expect(sent).toBe(1)
})

test('a fresh access policy cannot substitute a different partition or guard set', async () => {
  const f = await serviceFixture()
  for (const granted of [
    { access: 'other', guards: [{ id: 'serving', revision: '0', failure: 'unauthorized' }] },
    {
      access: f.caller.principal!,
      guards: [
        { id: 'serving', revision: '0', failure: 'unauthorized' },
        { id: 'second', revision: '0', failure: 'unauthorized' }
      ]
    },
    {
      access: f.caller.principal!,
      guards: [{ id: 'other', revision: '0', failure: 'unauthorized' }]
    },
    {
      access: f.caller.principal!,
      guards: [{ id: 'serving', revision: '1', failure: 'unauthorized' }]
    },
    {
      access: f.caller.principal!,
      guards: [{ id: 'serving', revision: '0', failure: 'reset-required' }]
    }
  ]) {
    const disclosure = new LookupResponseDisclosure({
      sessions: f.sessions,
      contracts: f.contracts,
      authorize: async () => granted as never,
      authorizeControl: () => true
    })
    let sent = 0
    await expect(
      disclosure.bind('open', f.response.body, f.caller).enqueue(
        f.bytes,
        f.caller.principal!,
        () => {
          sent++
          return undefined
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'Lookup response authorization partition changed'
    })
    expect(sent).toBe(0)
  }
})

test('requires the restored contract to support authenticated delivery within its original bound', async () => {
  const f = await serviceFixture(),
    saved = await f.sessions.session(JSON.parse(f.response.body).session, f.caller.principal)
  const original = f.contracts.restore(saved.contract, f.caller.capabilityDigest)
  const restore = jest.spyOn(f.contracts, 'restore')
  try {
    for (const profile of [
      { ...original.profile, authentication: 'none' },
      { ...original.profile, maxResponseBytes: 1 }
    ]) {
      restore.mockReturnValue({ ...original, profile } as never)
      let sent = 0
      await expect(
        f.disclosure.bind('open', f.response.body, f.caller).enqueue(
          f.bytes,
          f.caller.principal!,
          () => {
            sent++
            return undefined
          },
          new AbortController().signal
        )
      ).rejects.toMatchObject({
        code: 'context-changed',
        message: 'Lookup native-send selection changed'
      })
      expect(sent).toBe(0)
    }
  } finally {
    restore.mockRestore()
  }
})

test('rejects extra received whitespace beyond the batch byte promise', async () => {
  const f = await fixture(),
    body = structuredClone(f.value.first)
  body.limits.maxBytes = 65536
  const bytes = new TextEncoder().encode(canonicalOutputJSON(body) + ' '.repeat(65536))
  let sent = 0
  await expect(
    f.sessions.enqueueResponse(
      { ...f.candidate, bytes },
      () => true,
      () => {
        sent++
        return undefined
      }
    )
  ).rejects.toMatchObject({
    code: 'limited',
    message: 'Lookup response exceeds its declared byte limit'
  })
  expect(sent).toBe(0)
})

test('passes the exact original request, selection and disclosure stage to installed authorization', async () => {
  const f = await serviceFixture(),
    contexts: unknown[] = []
  const disclosure = new LookupResponseDisclosure({
    sessions: f.sessions,
    contracts: f.contracts,
    authorizeControl: () => true,
    authorize: async context => {
      contexts.push(context)
      return {
        access: context.principal!,
        guards: [{ id: 'serving', revision: '0', failure: 'unauthorized' }]
      }
    }
  })
  for (const operation of ['open', 'read'] as const)
    await disclosure
      .bind(operation, f.response.body, f.caller)
      .enqueue(f.bytes, f.caller.principal!, () => undefined, new AbortController().signal)
  expect(contexts).toEqual(
    ['open', 'read'].map(operation =>
      expect.objectContaining({
        operation,
        stage: 'disclosure',
        principal: f.caller.principal,
        open: f.open,
        scope: JSON.parse(f.response.body).scope,
        selection: expect.objectContaining({
          profile: expect.objectContaining({ authentication: 'brc103' })
        })
      })
    )
  )
})

test('validates all guards independently, while permitting an equivalent reordered set', async () => {
  const f = await providerFixture('brc103')
  closes.push(() => f.cleanup())
  await f.sessions.initializeGuard('second')
  const guards = [
    { id: 'serving', revision: '0', failure: 'unauthorized' as const },
    { id: 'second', revision: '0', failure: 'unauthorized' as const }
  ]
  const provider = new LookupProviderService({
    index: f.index,
    sessions: f.sessions,
    contracts: f.contracts,
    now: () => f.clock.now,
    authorize: async context => ({ access: context.principal!, guards })
  })
  const response = await provider.open(f.open, f.caller),
    bytes = new TextEncoder().encode(response.body)
  let current = [...guards].reverse(),
    sent = 0
  const disclosure = new LookupResponseDisclosure({
    sessions: f.sessions,
    contracts: f.contracts,
    authorizeControl: () => true,
    authorize: async context => ({ access: context.principal!, guards: current })
  })
  const bound = disclosure.bind('open', response.body, f.caller)
  await bound.enqueue(
    bytes,
    f.caller.principal!,
    () => {
      sent++
      return undefined
    },
    new AbortController().signal
  )
  expect(sent).toBe(1)
  current = [{ ...guards[0], revision: '1' }, guards[1]]
  await expect(
    bound.enqueue(
      bytes,
      f.caller.principal!,
      () => {
        sent++
        return undefined
      },
      new AbortController().signal
    )
  ).rejects.toMatchObject({
    code: 'unauthorized',
    message: 'Lookup response authorization partition changed'
  })
  expect(sent).toBe(1)
})

test('rejects wrong byte types and same-length changes before invoking storage', async () => {
  const f = await serviceFixture(),
    bound = f.disclosure.bind('read', f.response.body, f.caller)
  const changed = f.bytes.slice()
  changed[0] ^= 1
  const store = jest.spyOn(f.sessions, 'enqueueResponse')
  try {
    for (const bytes of [Array.from(f.bytes), new Uint8Array(), changed]) {
      await expect(
        bound.enqueue(
          bytes as Uint8Array,
          f.caller.principal!,
          () => undefined,
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: 'invalid', message: 'Lookup response bytes changed' })
      expect(store).not.toHaveBeenCalled()
    }
    await expect(
      bound.enqueue(f.bytes, 'other', () => undefined, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'unauthorized', message: 'Lookup response principal changed' })
  } finally {
    store.mockRestore()
  }
})

test('rejects a malformed native session header even from an installed alternate store', async () => {
  const f = await serviceFixture(),
    original = f.sessions.enqueueResponse.bind(f.sessions)
  const gate = jest.spyOn(f.sessions, 'enqueueResponse')
  try {
    for (const changed of [undefined, { principal: 'other' }]) {
      gate.mockImplementation((candidate, validate, enqueue) =>
        original(
          candidate,
          (header, bytes) =>
            validate(changed === undefined ? undefined : { ...header!, ...changed }, bytes),
          enqueue
        )
      )
      let sent = 0
      await expect(
        f.disclosure.bind('open', f.response.body, f.caller).enqueue(
          f.bytes,
          f.caller.principal!,
          () => {
            sent++
            return undefined
          },
          new AbortController().signal
        )
      ).rejects.toMatchObject({
        code: 'unauthorized',
        message: 'Lookup response authorization partition changed'
      })
      expect(sent).toBe(0)
    }
  } finally {
    gate.mockRestore()
  }
})

test('retains closed control diagnostics for scalar JSON and inclusive response limits', async () => {
  const f = await serviceFixture()
  for (const body of ['null', 'true', '0', '"text"', '[]'])
    expect(() => f.disclosure.control(body, f.caller)).toThrow(
      expect.objectContaining({ code: 'invalid' })
    )
  const body = '{"version":1,"closed":true}'.padEnd(4194304, ' '),
    bytes = new TextEncoder().encode(body)
  let sent = 0
  await f.disclosure.control(body, f.caller).enqueue(
    bytes,
    f.caller.principal!,
    () => {
      sent++
      return undefined
    },
    new AbortController().signal
  )
  expect(sent).toBe(1)
  expect(() => f.disclosure.control(body + ' ', f.caller)).toThrow(
    expect.objectContaining({ code: 'limited', message: 'Lookup response byte limit' })
  )
})

test('accepts a response exactly at the restored selected byte bound', async () => {
  const f = await serviceFixture(),
    saved = await f.sessions.session(JSON.parse(f.response.body).session, f.caller.principal)
  const original = f.contracts.restore(saved.contract, f.caller.capabilityDigest),
    restore = jest.spyOn(f.contracts, 'restore')
  const body = f.response.body.padEnd(65536, ' '),
    bytes = new TextEncoder().encode(body)
  restore.mockReturnValue({
    ...original,
    profile: { ...original.profile, maxResponseBytes: 65536 }
  })
  try {
    let sent = 0
    await f.disclosure.bind('open', body, f.caller).enqueue(
      bytes,
      f.caller.principal!,
      () => {
        sent++
        return undefined
      },
      new AbortController().signal
    )
    expect(sent).toBe(1)
  } finally {
    restore.mockRestore()
  }
})
