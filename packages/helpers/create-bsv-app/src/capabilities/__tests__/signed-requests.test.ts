import { describe, expect, test } from '@jest/globals'
import { signedRequests } from '../signed-requests'
import { newBuilder } from '../../scaffold/base-app'

const ctx = { name: 'demo', network: 'test' as const, bsvDir: 'src/bsv', stack: {}, layout: 'monorepo' as const }

describe('signed-requests (variant)', () => {
  test('requires wallet-connect', () => {
    expect(signedRequests.requires).toEqual(['wallet-connect'])
    expect(signedRequests.roles).toEqual(['client', 'server'])
  })
  test('client helper binds proof to { action, body }', () => {
    const client = signedRequests.files(ctx).client ?? []
    expect(client.map(f => f.path).sort()).toEqual(['SignedRequestDemo.tsx', 'signedRequest.ts', 'useSignedRequest.ts'])
    const helper = client.find(f => f.path === 'signedRequest.ts')
    expect(helper?.content).toContain('createAuthProof')
    expect(helper?.content).toContain('body')
  })
  test('server verify is a framework-agnostic function (no express import)', () => {
    const server = signedRequests.files(ctx).server ?? []
    const verify = server.find(f => f.path === 'verifySignedRequest.ts')
    expect(verify?.content).toContain('verifyAuthProof')
    expect(verify?.content).not.toContain("from 'express'")
  })
  test('client files include SignedRequestDemo.tsx', () => {
    const client = signedRequests.files(ctx).client ?? []
    const paths = client.map(f => f.path)
    expect(paths).toContain('SignedRequestDemo.tsx')
  })
  test('counterparty auto-resolves: hook serverIdentityKey is optional, demo needs no key', () => {
    const client = signedRequests.files(ctx).client ?? []
    const hook = client.find(f => f.path === 'useSignedRequest.ts')
    const demo = client.find(f => f.path === 'SignedRequestDemo.tsx')
    expect(hook?.content).toContain('getServerIdentity')
    expect(hook?.content).toContain('serverIdentityKey?: string')
    expect(demo?.content).toContain('useSignedRequest()')
    expect(demo?.content).not.toContain("SERVER_IDENTITY_KEY = ''")
  })
  test('baseEdits adds route descriptor and server verify route', () => {
    const builder = newBuilder()
    signedRequests.baseEdits?.({ builder, ctx })
    expect(builder.app.routes).toContainEqual({ path: '/signed-demo', component: 'SignedRequestDemo', importPath: './bsv/SignedRequestDemo', label: 'Signed request demo' })
    expect(builder.server.routes.join()).toContain('verifySignedRequest')
  })
  test('demo page renders a removable step-by-step activity log', () => {
    const page = (signedRequests.files(ctx).client ?? []).find(f => f.path === 'SignedRequestDemo.tsx')
    expect(page?.content).toContain('demo activity log (safe to delete)')
    expect(page?.content).toContain('Signing a request proof')
  })
  test('agentsSection has the How it works / Future integrations structure', () => {
    const md = signedRequests.agentsSection(ctx)
    expect(md).toContain('### How it works')
    expect(md).toContain('### Future integrations')
  })
})
