import { describe, expect, it, jest } from '@jest/globals'
import * as mod from '../../mod.js'
import OverlayExpress from '../OverlayExpress.js'
import {
  ArcadeProvider,
  BsvBroadcasterProvider,
  type ArcadeMerkleProof,
  type ArcadeProviderConfig,
  type BsvBroadcasterMerkleProof
} from '../ArcadeProvider.js'

/**
 * Arcade was renamed to BSV Broadcaster. ArcadeProvider, its types, the `ArcadeProvider.ts`
 * import path and `configureArcade` stay as deprecated aliases; these tests pin that existing
 * callers keep compiling and behave exactly as before.
 */
describe('deprecated Arcade aliases', () => {
  const txid = '11'.repeat(32)
  const tx = { id: () => txid, toHexEF: () => 'efhex', toHex: () => 'rawhex' } as any

  it('exports the same provider class under both names', () => {
    expect(ArcadeProvider).toBe(BsvBroadcasterProvider)
    expect(mod.ArcadeProvider).toBe(BsvBroadcasterProvider)
    expect(mod.BsvBroadcasterProvider).toBe(BsvBroadcasterProvider)
  })

  it('constructs through the alias and broadcasts with unchanged wire behavior', async () => {
    const fetcher = jest.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ txid, txStatus: 'RECEIVED' }), { status: 202 })
    )
    const config: ArcadeProviderConfig = {
      apiKey: 'secret',
      fetch: fetcher as unknown as typeof fetch
    }
    const provider: ArcadeProvider = new ArcadeProvider('https://arcade.example/', config)

    expect(provider).toBeInstanceOf(BsvBroadcasterProvider)
    expect(provider.name).toBe('Arcade')
    const response = await provider.broadcast(tx)
    expect(response).toEqual({
      status: 'success',
      txid,
      message: 'RECEIVED',
      competingTxs: undefined
    })
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://arcade.example/tx')
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret')

    const proof: ArcadeMerkleProof | undefined = undefined
    const sameShape: BsvBroadcasterMerkleProof | undefined = proof
    expect(sameShape).toBeUndefined()
  })

  it('configureArcade configures the same state as configureBsvBroadcaster', () => {
    const viaAlias = new OverlayExpress('Alias Test', 'private-key', 'overlay.example')
    const viaNew = new OverlayExpress('Alias Test', 'private-key', 'overlay.example')
    const config = { apiKey: 'api-key', deploymentId: 'deployment', chaintracksApiPrefix: '/ct/v2' }

    viaAlias.configureArcade('https://arcade.example', config)
    viaNew.configureBsvBroadcaster('https://arcade.example', config)

    const state = (o: OverlayExpress): Record<string, unknown> => ({
      arcadeUrl: o.arcadeUrl,
      arcadeApiKey: o.arcadeApiKey,
      arcadeDeploymentId: o.arcadeDeploymentId,
      arcadeChaintracksApiPrefix: o.arcadeChaintracksApiPrefix,
      arcadeAllowPrivateHosts: o.arcadeAllowPrivateHosts
    })
    expect(state(viaAlias)).toEqual(state(viaNew))
    expect(state(viaAlias)).toEqual({
      arcadeUrl: 'https://arcade.example',
      arcadeApiKey: 'api-key',
      arcadeDeploymentId: 'deployment',
      arcadeChaintracksApiPrefix: '/ct/v2',
      arcadeAllowPrivateHosts: false
    })
    expect(() => viaAlias.configureArcade('https://arcade.example', null as any)).toThrow(
      'Arcade configuration must be an object'
    )
  })
})
