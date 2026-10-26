import { afterAll, beforeAll, expect, it } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { privatePublicationEngineFixture } from './PrivatePublicationEngine.fixture.js'
import { privatePublicationHTTPFixture } from './PrivatePublicationRoutes.fixture.js'
import { PrivatePublicationCoordinator } from '../../../../application/output-knowledge/src/private/PrivatePublicationCoordinator.js'
let replica: Awaited<ReturnType<typeof privatePublicationEngineFixture>>
beforeAll(async () => {
  replica = await privatePublicationEngineFixture()
}, 120000)
afterAll(async () => {
  await replica?.close()
}, 60000)
async function httpFixture(name: string) {
  let actual: Awaited<ReturnType<typeof replica.install>> | undefined
  let coordinator: PrivatePublicationCoordinator | undefined
  const f = await privatePublicationHTTPFixture(async owner => {
    actual = await replica.install(owner, name, true)
    coordinator = new PrivatePublicationCoordinator({ ...owner.options, admission: actual.bridge })
    return { service: coordinator }
  })
  if (!actual || !coordinator) throw new Error('Missing native installation')
  const service = coordinator
  return {
    ...f,
    actual,
    request: (operation: 'publish' | 'status', body: unknown) =>
      f.fetch(operation, JSON.stringify(body)),
    clientFor: (key: PrivateKey) => (operation: 'publish' | 'status', body: unknown) =>
      f.clientFor(key).fetch(f.origin + '/api/overlay/v1/private/' + operation, {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify(body)
      }),
    onSign: f.onHTTPSign,
    async close() {
      try {
        await service.stop()
      } finally {
        await f.close()
      }
    }
  }
}
it('serves actual mutually authenticated publication/status and rejects revocation after BRC-104 signing', async () => {
  const f = await httpFixture('authenticated-private-service')
  try {
    const response = await f.request('publish', f.contract.request)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ready',
      publicationId: f.status.publicationId
    })
    expect(f.wireHeaders.at(-1)!.get('cache-control')).toBe('private, no-store')
    expect(f.wireHeaders.at(-1)!.get('access-control-allow-origin')).toBe('*')
    expect(f.actual.submissions).toBe(1)
    f.onSign(() => f.revokeAccess())
    const changed = await f.request('status', f.status)
    expect(changed.status).toBe(404)
    expect(await changed.json()).toEqual({
      version: 1,
      error: {
        code: 'not-found',
        message: 'Private publication request not-found',
        retryable: false
      }
    })
  } finally {
    await f.close()
  }
}, 30000)
it('authenticates the original publisher and sends only fixed public domain errors', async () => {
  const f = await httpFixture('authenticated-private-errors')
  try {
    expect((await f.request('publish', f.contract.request)).status).toBe(200)
    const wrong = await f.clientFor(new PrivateKey(64))('status', f.status)
    expect(wrong.status).toBe(404)
    expect(await wrong.json()).toMatchObject({
      error: { code: 'not-found', message: 'Private publication request not-found' }
    })
    f.validate.mockRejectedValue(
      new Error('Synthetic private key and custody path must not leave service')
    )
    const invalid = await f.request('publish', {
      ...f.contract.request,
      requestId: 'another-private-publication'
    })
    expect(invalid.status).toBe(503)
    expect(await invalid.text()).not.toMatch(/Synthetic|custody path|private key/)
    expect(f.actual.submissions).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)
it('preserves existing public lookup and credential-free preflight while rejecting unselected private requests', async () => {
  const f = await httpFixture('private-legacy-compatibility')
  try {
    const legacy = await fetch(f.origin + '/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(await legacy.json()).toEqual({ type: 'output-list', outputs: [] })
    const cors = await fetch(f.origin + '/api/overlay/v1/private/publish', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://unknown-app.example',
        'access-control-request-headers': 'content-type, x-bsv-overlay-profile'
      }
    })
    expect(cors.status).toBe(204)
    expect(cors.headers.get('access-control-allow-origin')).toBe('*')
    expect(cors.headers.has('access-control-allow-credentials')).toBe(false)
    const unsigned = await fetch(f.origin + '/api/overlay/v1/private/publish', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(f.contract.request)
    })
    expect(unsigned.status).toBe(401)
    expect(f.native.rows()).toHaveLength(0)
  } finally {
    await f.close()
  }
}, 30000)
