import { CompletedProtoWallet, PrivateKey, type LookupAnswer, type LookupQuestion } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { messageBoxTokenOutput, slapTokenOutput } from '../../test/support/transactions.js'
import { HostDiscovery, discoveryTarget, type LookupResolverLike } from './discovery.js'

const hostKey = PrivateKey.fromRandom()
const hostWallet = new CompletedProtoWallet(hostKey)
const hostIdentity = hostKey.toPublicKey().toString()

function resolverFor(outputs: LookupAnswer['outputs']): LookupResolverLike & {
  questions: LookupQuestion[]
} {
  const questions: LookupQuestion[] = []
  return {
    questions,
    async query(question) {
      questions.push(question)
      return { type: 'output-list', outputs }
    }
  }
}

describe('discoveryTarget', () => {
  const client = `02${'ab'.repeat(32)}`

  it('maps each query class to its discovery path', () => {
    expect(discoveryTarget('overlay-lookup', { service: 'ls_x' }, client)).toEqual({
      kind: 'overlay-lookup',
      service: 'ls_x'
    })
    expect(discoveryTarget('message-list', { messageBox: 'inbox' }, client)).toEqual({
      kind: 'message-list',
      recipient: client
    })
    expect(discoveryTarget('relay-lookup', {}, client)).toEqual({
      kind: 'static',
      key: 'relay-lookup'
    })
  })

  it('requires a service name for overlay lookups', () => {
    expect(() => discoveryTarget('overlay-lookup', {}, client)).toThrow(TypeError)
  })
})

describe('HostDiscovery', () => {
  it('asks ls_slap for the service and keeps each SLAP identity key', async () => {
    const resolver = resolverFor([
      await slapTokenOutput(hostWallet, 'https://a.example', 'ls_x'),
      await slapTokenOutput(hostWallet, 'https://other.example', 'ls_other'),
      await slapTokenOutput(hostWallet, 'https://ship.example', 'ls_x', 'SHIP'),
      { beef: [1, 2, 3], outputIndex: 0 }
    ])
    const discovery = new HostDiscovery({ resolver })
    expect(await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'https://a.example', identityKey: hostIdentity }
    ])
    expect(resolver.questions).toEqual([{ service: 'ls_slap', query: { service: 'ls_x' } }])
  })

  it('caches discovery for hostsTtlMs', async () => {
    let now = 0
    const resolver = resolverFor([await slapTokenOutput(hostWallet, 'https://a.example', 'ls_x')])
    const discovery = new HostDiscovery({ resolver, hostsTtlMs: 1000, now: () => now })
    await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })
    now = 999
    await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })
    expect(resolver.questions).toHaveLength(1)
    now = 1000
    await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })
    expect(resolver.questions).toHaveLength(2)
  })

  it('lets hostOverrides replace discovery and additionalHosts extend it', async () => {
    const resolver = resolverFor([await slapTokenOutput(hostWallet, 'https://a.example', 'ls_x')])
    const overridden = new HostDiscovery({
      resolver,
      hostOverrides: { ls_x: ['https://only.example/'] }
    })
    expect(await overridden.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'https://only.example' }
    ])
    expect(resolver.questions).toEqual([])

    const extended = new HostDiscovery({
      resolver,
      additionalHosts: { ls_x: ['https://extra.example', 'https://a.example'] }
    })
    expect(await extended.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'https://a.example', identityKey: hostIdentity },
      { url: 'https://extra.example' }
    ])
  })

  it('accepts plain http only under the local preset', async () => {
    const outputs = [
      await slapTokenOutput(hostWallet, 'http://127.0.0.1:4001', 'ls_x'),
      await slapTokenOutput(hostWallet, 'ftp://files.example', 'ls_x'),
      await slapTokenOutput(hostWallet, 'not a url', 'ls_x')
    ]
    const mainnet = new HostDiscovery({ resolver: resolverFor(outputs) })
    expect(await mainnet.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([])
    const local = new HostDiscovery({ resolver: resolverFor(outputs), networkPreset: 'local' })
    expect(await local.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'http://127.0.0.1:4001', identityKey: hostIdentity }
    ])
  })

  it('treats the SLAP trackers as the hosts of ls_slap itself', async () => {
    const resolver = resolverFor([])
    const discovery = new HostDiscovery({ resolver, slapTrackers: ['https://tracker.example'] })
    expect(await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_slap' })).toEqual([
      { url: 'https://tracker.example' }
    ])
    expect(resolver.questions).toEqual([])
  })

  it('resolves message box hosts through ls_messagebox', async () => {
    const recipient = `02${'ab'.repeat(32)}`
    const resolver = resolverFor([
      await messageBoxTokenOutput(hostWallet, recipient, 'https://box.example')
    ])
    const discovery = new HostDiscovery({ resolver })
    expect(await discovery.hostsFor({ kind: 'message-list', recipient })).toEqual([
      { url: 'https://box.example' }
    ])
    expect(resolver.questions).toEqual([
      { service: 'ls_messagebox', query: { identityKey: recipient } }
    ])
  })

  it('uses only configured hosts for classes without a discovery path', async () => {
    const discovery = new HostDiscovery({
      resolver: resolverFor([]),
      hostOverrides: { 'relay-lookup': ['https://relay.example'] }
    })
    expect(await discovery.hostsFor({ kind: 'static', key: 'relay-lookup' })).toEqual([
      { url: 'https://relay.example' }
    ])
    expect(await discovery.hostsFor({ kind: 'static', key: 'message-body' })).toEqual([])
  })

  it('survives a failing resolver', async () => {
    const discovery = new HostDiscovery({
      resolver: {
        async query() {
          throw new Error('trackers unreachable')
        }
      },
      additionalHosts: { ls_x: ['https://extra.example'] }
    })
    expect(await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'https://extra.example' }
    ])
  })
})
