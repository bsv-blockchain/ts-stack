import { guardAuthenticatedResponse, type AuthenticatedResponseReplacement } from '../../mod.js'
import { authenticatedResponseQueue } from '../authenticatedResponseQueue.js'
import { queueFixture } from './authenticatedResponseQueue.fixture.js'

const fixtures: Awaited<ReturnType<typeof queueFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})

const invalid: [string, unknown, string][] = [
  ['null', null, 'status, headers and body'],
  ['primitive', 1, 'status, headers and body'],
  ['extra', { extra: 1 }, 'status, headers and body'],
  ['status-low', { statusCode: 199 }, 'status'],
  ['status-high', { statusCode: 600 }, 'status'],
  ['status-fraction', { statusCode: 200.5 }, 'status'],
  ['body-array', { body: [1] }, 'must be bytes'],
  ['headers-null', { headers: null }, 'headers'],
  ['headers-array', { headers: [] }, 'headers'],
  ['header-number', { headers: { 'x-value': 1 } }, 'must be strings'],
  ['header-duplicate', { headers: { 'X-Value': 'a', 'x-value': 'b' } }, 'Duplicate'],
  ['header-name', { headers: { 'bad name': 'a' } }, 'valid HTTP token'],
  ['header-value', { headers: { 'x-value': 'a\nb' } }, 'Invalid character'],
  ['auth-header', { headers: { 'x-bsv-auth-signature': 'abc' } }, 'belong to the transport'],
  ['transfer', { headers: { 'transfer-encoding': 'chunked' } }, 'framing'],
  ['encoding', { headers: { 'content-encoding': 'gzip' } }, 'framing'],
  ['replacement-bytes', { body: new Uint8Array(65537) }, '64 KiB'],
  ['replacement-headers', { headers: { 'x-extra': 'x'.repeat(65537) } }, '64 KiB'],
  ['bodyless', { statusCode: 304, body: new Uint8Array([1]) }, 'bodyless']
]
it.each(invalid)(
  'rejects invalid guarded candidate %s before signing or queue effects',
  async (_name, change, message) => {
    let failure: unknown
    const f = await queueFixture((_req, res) => {
      guardAuthenticatedResponse(res, (_candidate, enqueue) => enqueue())
      const queue = authenticatedResponseQueue(res)!
      const input =
        typeof change === 'object' && change !== null
          ? { statusCode: 200, headers: {}, body: new Uint8Array(), ...change }
          : change
      try {
        queue.prepare(input as AuthenticatedResponseReplacement, 1)
      } catch (error) {
        failure = error
      }
      res.end()
    })
    fixtures.push(f)
    const result = await f.client.fetch(f.url, { method: 'POST' })
    expect(result.status).toBe(200)
    expect(failure).toMatchObject({ message: expect.stringContaining(message) })
  }
)
it('enforces the configured body bound independently of the replacement limit', async () => {
  let failure: unknown
  const f = await queueFixture(
    (_req, res) => {
      guardAuthenticatedResponse(res, (_candidate, enqueue) => enqueue())
      try {
        authenticatedResponseQueue(res)!.prepare(
          { statusCode: 200, headers: {}, body: new Uint8Array(33) },
          0
        )
      } catch (error) {
        failure = error
      }
      res.end()
    },
    { maxBytes: 32 }
  )
  fixtures.push(f)
  expect((await f.client.fetch(f.url, { method: 'POST' })).status).toBe(200)
  expect((failure as Error).message).toMatch(/configured body limit/)
})
it('permits identity encoding and the inclusive replacement bound with an explicitly unbounded host body policy', async () => {
  const body = new Uint8Array(65536 - 'content-encoding'.length - 'identity'.length)
  const f = await queueFixture(
    (_req, res) => {
      guardAuthenticatedResponse(res, (candidate, enqueue) => {
        if (candidate.attempt === 0)
          return { statusCode: 200, headers: { 'content-encoding': 'identity' }, body }
        enqueue()
      })
      res.end()
    },
    { maxBytes: -1 }
  )
  fixtures.push(f)
  const response = await f.client.fetch(f.url, { method: 'POST' })
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
})
it('prioritizes cancellation that already occurred over an already fulfilled operation', async () => {
  let checked: Promise<void> | undefined
  const f = await queueFixture((_req, res) => {
    guardAuthenticatedResponse(res, () => undefined)
    const queue = authenticatedResponseQueue(res)!
    queue.close()
    checked = expect(queue.wait(Promise.resolve('too-late'))).rejects.toThrow(/cancelled/)
    res.end()
  })
  fixtures.push(f)
  await expect(f.client.fetch(f.url, { method: 'POST' })).rejects.toThrow()
  expect(checked).toBeDefined()
  await checked
})
