import { OutputProtocolError } from '@bsv/sdk'
import {
  apply,
  requester,
  selected
} from '../../../../application/output-knowledge/test/root-eviction-fixture.js'
import { rootResponseFixture } from './RootEvictionResponseGuard.fixture.js'

const fixtures: Awaited<ReturnType<typeof rootResponseFixture>>[] = []
async function make() {
  const fixture = await rootResponseFixture()
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

it('queues an authenticated eligible response through the actual SQLite gate', async () => {
  const f = await make(),
    response = await f.fetch()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ output: 'original' })
  expect(response.headers.get('x-bsv-private')).toBe('private-candidate-metadata')
  expect(f.signatures).toHaveLength(1)
  expect(f.checks).toEqual([{ identity: requester, kind: 'data' }])
})

it.each(['hydration', 'signing'])(
  'resets the complete response when suppression commits during %s',
  async boundary => {
    const f = await make(),
      writer = f.reopen()
    const suppress = async () => {
      if (boundary === 'signing' && f.signatures.length > 1) return
      await apply(writer)
    }
    if (boundary === 'hydration') f.beforeSend(suppress)
    else f.onSign(suppress)
    const response = await f.fetch()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      version: 1,
      error: { code: 'reset-required', message: 'Serving state changed', retryable: false }
    })
    expect(response.headers.get('x-bsv-private')).toBeNull()
    expect(response.headers.get('x-bsv-overlay-profile')).toBe('fixture-explicit-selection')
    expect(f.signatures).toHaveLength(2)
    expect(f.checks).toEqual([{ identity: requester, kind: 'control' }])
    const headers = f.wireHeaders.at(-1)!
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('cache-control')).toBe('private, no-store')
    expect(headers.get('access-control-allow-origin')).toBe('https://client.example.test')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect((await f.store.serving(selected())).state).toBe('suppressed')
  }
)

it('checks every retained target even when the captured revision is already current', async () => {
  const f = await make()
  await apply(f.store)
  const response = await f.fetch()
  expect(response.status).toBe(409)
  expect((await response.json()).error.code).toBe('reset-required')
  expect(response.headers.get('x-bsv-private')).toBeNull()
  expect(f.checks.map(check => check.kind)).toEqual(['data', 'control'])
})

it('rechecks data access and permits only a separately authorized sanitized denial', async () => {
  const f = await make()
  f.onSign(() => f.setAccess(false, true))
  const response = await f.fetch()
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    version: 1,
    error: { code: 'not-found', message: 'Response unavailable', retryable: false }
  })
  expect(f.checks).toEqual([
    { identity: requester, kind: 'data' },
    { identity: requester, kind: 'control' }
  ])
  expect(response.headers.get('x-bsv-private')).toBeNull()
})

it('closes without disclosing either response when current control access is denied', async () => {
  const f = await make()
  f.setAccess(false, false)
  await expect(f.fetch()).rejects.toThrow()
  expect(f.signatures).toHaveLength(2)
  expect(f.checks.map(check => check.kind)).toEqual(['data', 'control'])
})

it('does not retry indefinitely when the replacement becomes stale during signing', async () => {
  const f = await make()
  f.onSign(async () => {
    if (f.signatures.length === 1) await apply(f.store)
    else await f.store.changePolicy('33'.repeat(32))
  })
  await expect(f.fetch()).rejects.toThrow()
  expect(f.signatures).toHaveLength(2)
  expect(f.checks).toEqual([])
})

it('owns the complete target inventory captured before hydration', async () => {
  const f = await make(),
    target = selected()
  f.setTarget(target)
  f.afterInstall(() => {
    target.advertisementDigest = 'ff'.repeat(32)
    target.outpoint.txid = 'ee'.repeat(32)
    target.outpoint.chain.network = 'changed'
  })
  expect(await (await f.fetch()).json()).toEqual({ output: 'original' })
})

it('bounds a retryable storage failure to one sanitized signed control response', async () => {
  const f = await make()
  let attempts = 0
  f.setJournal({
    head: () => f.store.head(),
    enqueue: async (...args) => {
      if (++attempts === 1)
        throw new OutputProtocolError('unavailable', 'private database diagnostic', true)
      await f.store.enqueue(...args)
    }
  })
  const response = await f.fetch()
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    version: 1,
    error: { code: 'unavailable', message: 'Service unavailable', retryable: true }
  })
  expect(attempts).toBe(2)
})

it.each(['unexpected', 'invalid', 'missing-enqueue'])(
  'fails closed on an invalid journal boundary (%s)',
  async mode => {
    const f = await make()
    f.setJournal({
      head: () => f.store.head(),
      enqueue: async () => {
        if (mode === 'unexpected') throw new Error('private internal failure')
        if (mode === 'invalid') throw new OutputProtocolError('invalid', 'private selector')
      }
    })
    await expect(f.fetch()).rejects.toThrow()
    expect(f.signatures).toHaveLength(1)
  }
)

it('never appends a replacement after a journal reports failure following native enqueue', async () => {
  const f = await make()
  f.setJournal({
    head: () => f.store.head(),
    enqueue: async (...args) => {
      await f.store.enqueue(...args)
      throw new OutputProtocolError('unavailable', 'uncertain local acknowledgement', true)
    }
  })
  const response = await f.fetch()
  expect(await response.json()).toEqual({ output: 'original' })
  expect(f.signatures).toHaveLength(1)
})
