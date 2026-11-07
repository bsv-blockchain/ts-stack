import { expect, it, jest } from '@jest/globals'
import type { RequestHandler } from 'express'
import { PrivateKey } from '@bsv/sdk'
import type {
  PrivateAcquisitionHostOptions,
  PrivatePublicationHostOptions
} from '../PrivateOverlayHost.js'
import type { PrivateAcquisitionRouteOptions } from '../PrivateAcquisitionHTTPPorts.js'
import type { PrivatePublicationRouteOptions } from '../PrivatePublicationHTTPPorts.js'
import type { PrivatePurchaseRouteOptions } from '../PrivatePurchaseHTTPPorts.js'

const acquisition = jest
  .fn<(input: PrivateAcquisitionRouteOptions) => RequestHandler>()
  .mockImplementation(() => (_req, _res, next) => {
    next()
  })
const publication = jest
  .fn<(input: PrivatePublicationRouteOptions) => RequestHandler>()
  .mockImplementation(() => (_req, _res, next) => {
    next()
  })
const purchase = jest
  .fn<(input: PrivatePurchaseRouteOptions) => RequestHandler>()
  .mockImplementation(() => (_req, _res, next) => {
    next()
  })
jest.unstable_mockModule('../PrivateAcquisitionRoutes.js', () => ({
  createPrivateAcquisitionRouter: acquisition
}))
jest.unstable_mockModule('../PrivatePublicationRoutes.js', () => ({
  createPrivatePublicationRouter: publication
}))
jest.unstable_mockModule('../PrivatePurchaseRoutes.js', () => ({
  createPrivatePurchaseRouter: purchase
}))
const { PrivateOverlayHost } = await import('../PrivateOverlayHost.js')
const identity = new PrivateKey(104).toPublicKey().toString()
function options() {
  const acquire: PrivateAcquisitionHostOptions = {
    identity,
    baseURL: 'https://private.example/api',
    service: { acquire: async () => '', recover: async () => '' },
    disclosure: {
      prepare: () => {
        throw new Error('Unused')
      },
      enqueueControl: (_input, _caller, send) => {
        send()
      }
    }
  }
  const publish: PrivatePublicationHostOptions = {
    identity,
    baseURL: acquire.baseURL,
    service: { publish: async () => ({}), status: async () => ({}) },
    disclosure: {
      prepare: () => {
        throw new Error('Unused')
      },
      enqueueControl: (_input, _caller, send) => {
        send()
      }
    }
  }
  const auth: RequestHandler = (_req, _res, next) => {
    next()
  }
  acquisition.mockClear()
  publication.mockClear()
  purchase.mockClear()
  return { acquire, publish, auth }
}
it.each(['none', 'acquisition', 'publication', 'both'] as const)(
  'selects only explicitly installed %s routes in acquisition-first order',
  mode => {
    const f = options(),
      hasA = mode === 'both' || mode === 'acquisition',
      hasP = mode === 'both' || mode === 'publication'
    const host = new PrivateOverlayHost({
      ...(hasA ? { acquisition: f.acquire } : {}),
      ...(hasP ? { publication: f.publish } : {})
    })
    host.requireIdentity(identity)
    const routes = host.routes(f.auth, true, { request: 1024, response: 2048 })
    expect(host.maximumHeaderBytes).toBe(hasA ? 131072 : undefined)
    expect(acquisition).toHaveBeenCalledTimes(hasA ? 1 : 0)
    expect(publication).toHaveBeenCalledTimes(hasP ? 1 : 0)
    expect(routes).toEqual([
      ...(hasA ? [acquisition.mock.results[0].value] : []),
      ...(hasP ? [publication.mock.results[0].value] : [])
    ])
    if (hasA)
      expect(acquisition).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticate: f.auth,
          handleHandshake: true,
          maximumRequestBytes: 1024,
          maximumResponseBytes: 2048
        })
      )
    if (hasP)
      expect(publication).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticate: f.auth,
          handleHandshake: !hasA,
          maximumRequestBytes: 1024,
          maximumResponseBytes: 2048
        })
      )
  }
)
it('leaves handshake ownership to existing companions and bounds explicitly selected capacities', () => {
  const f = options(),
    host = new PrivateOverlayHost({
      acquisition: { ...f.acquire, maximumRequestBytes: 512, maximumResponseBytes: 8192 },
      publication: { ...f.publish, maximumRequestBytes: 8192, maximumResponseBytes: 512 }
    })
  host.routes(f.auth, false, { request: 1024, response: 2048 })
  expect(acquisition).toHaveBeenCalledWith(
    expect.objectContaining({
      handleHandshake: false,
      maximumRequestBytes: 512,
      maximumResponseBytes: 2048
    })
  )
  expect(publication).toHaveBeenCalledWith(
    expect.objectContaining({
      handleHandshake: false,
      maximumRequestBytes: 1024,
      maximumResponseBytes: 512
    })
  )
})
it.each([undefined, '*', [], ['https://host.example']] as const)(
  'preserves host browser policy %s',
  origins => {
    const f = options(),
      host = new PrivateOverlayHost({ acquisition: f.acquire, publication: f.publish })
    host.routes(f.auth, true, { request: 1024, response: 2048, origins })
    for (const factory of [acquisition, publication])
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({ allowedOrigins: origins === '*' ? undefined : origins })
      )
  }
)
it('owns explicit origins and profile selection before later caller mutation', () => {
  const f = options(),
    origins = ['https://selected.example'],
    selected = { ...f.acquire, allowedOrigins: origins },
    profiles = { acquisition: selected, publication: f.publish }
  const host = new PrivateOverlayHost(profiles)
  origins.push('https://later.example')
  Object.assign(profiles, { acquisition: f.acquire })
  selected.identity = new PrivateKey(105).toPublicKey().toString()
  host.requireIdentity(identity)
  host.routes(f.auth, true, { request: 1024, response: 2048, origins: ['https://host.example'] })
  expect(acquisition).toHaveBeenCalledWith(
    expect.objectContaining({ identity, allowedOrigins: ['https://selected.example'] })
  )
})
it('refuses invalid profile identities, origins and mismatched server wallets', () => {
  const f = options(),
    other = new PrivateKey(106).toPublicKey().toString()
  for (const key of ['acquisition', 'publication'] as const) {
    const selected = key === 'acquisition' ? { acquisition: f.acquire } : { publication: f.publish }
    expect(() => new PrivateOverlayHost(selected).requireIdentity(other)).toThrow('must match')
  }
  expect(
    () => new PrivateOverlayHost({ acquisition: { ...f.acquire, identity: 'invalid' } })
  ).toThrow()
  expect(
    () => new PrivateOverlayHost({ publication: { ...f.publish, allowedOrigins: '*' as never } })
  ).toThrow('array')
  expect(() => new PrivateOverlayHost({}).requireIdentity('invalid')).toThrow()
})

it.each(['purchase', 'with-acquisition', 'with-publication', 'all'] as const)(
  'composes optional covenant %s with one shared handshake and preserved host ceilings',
  mode => {
    const f = options(),
      hasA = mode === 'with-acquisition' || mode === 'all',
      hasP = mode === 'with-publication' || mode === 'all',
      origins = ['https://selected.example'],
      selected = {
        ...f.acquire,
        allowedOrigins: origins,
        maximumRequestBytes: 512,
        maximumResponseBytes: 8192,
        service: { prepare: async () => '', submit: async () => '', recover: async () => '' },
        disclosure: {
          prepare: () => {
            throw new Error('Unused')
          },
          enqueueControl: (_input: unknown, _caller: unknown, send: () => void) => {
            send()
          }
        }
      }
    const host = new PrivateOverlayHost({
      purchase: selected,
      ...(hasA ? { acquisition: f.acquire } : {}),
      ...(hasP ? { publication: f.publish } : {})
    })
    origins.push('https://later.example')
    selected.identity = new PrivateKey(108).toPublicKey().toString()
    host.requireIdentity(identity)
    const routes = host.routes(f.auth, true, { request: 1024, response: 2048 })
    expect(routes).toEqual([
      ...(hasA ? [acquisition.mock.results[0].value] : []),
      purchase.mock.results[0].value,
      ...(hasP ? [publication.mock.results[0].value] : [])
    ])
    expect(purchase).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        authenticate: f.auth,
        handleHandshake: !hasA,
        maximumRequestBytes: 512,
        maximumResponseBytes: 2048,
        allowedOrigins: ['https://selected.example']
      })
    )
    expect(host.maximumHeaderBytes).toBe(hasA ? 131072 : undefined)
    if (hasP)
      expect(publication).toHaveBeenCalledWith(expect.objectContaining({ handleHandshake: false }))
    expect(() => host.requireIdentity(new PrivateKey(109).toPublicKey().toString())).toThrow(
      'must match'
    )
  }
)
