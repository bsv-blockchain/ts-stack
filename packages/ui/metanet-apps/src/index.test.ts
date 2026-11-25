import { describe, expect, it } from '@jest/globals'
import type { LookupAnswer, LookupQuestion, OverlayLookupFacilitator } from '@bsv/sdk'
import { AppCatalog } from './index.js'
import { requireAppCatalogBroadcastSuccess } from './broadcast.js'
import { METANET_APPS_KEY_ID, METANET_APPS_PROTOCOL } from './constants.js'
import { AppMetadataValidationError, normalizeAppMetadata } from './metadata.js'

class MockLookupFacilitator implements OverlayLookupFacilitator {
  readonly calls: Array<{ host: string, question: LookupQuestion, timeout?: number }> = []

  constructor (
    private readonly responses: Record<string, LookupAnswer | Error>
  ) {}

  async lookup (
    host: string,
    question: LookupQuestion,
    timeout?: number
  ): Promise<LookupAnswer> {
    this.calls.push({ host, question, timeout })
    const response = this.responses[host]
    if (response instanceof Error) throw response
    return response ?? { type: 'output-list', outputs: [] }
  }
}

describe('AppCatalog direct host lookup', () => {
  it('queries every configured host and reports failures without failing the lookup', async () => {
    const facilitator = new MockLookupFacilitator({
      'https://overlay-ap-1.example': {
        type: 'output-list',
        outputs: [{ beef: [], outputIndex: 0 }]
      },
      'https://overlay-eu-1.example': new Error('region unavailable')
    })
    const catalog = new AppCatalog({ networkPreset: 'mainnet' })

    const result = await catalog.findAppsAcrossHosts({}, {
      facilitator,
      hosts: ['https://overlay-ap-1.example', 'https://overlay-eu-1.example'],
      timeout: 1234
    })

    expect(result.apps).toEqual([])
    expect(facilitator.calls).toHaveLength(2)
    expect(facilitator.calls[0].timeout).toBe(1234)
    expect(result.diagnostics.hosts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        host: 'https://overlay-ap-1.example',
        ok: true,
        rawOutputCount: 1,
        parsedAppCount: 0,
        parseFailureCount: 1
      }),
      expect.objectContaining({
        host: 'https://overlay-eu-1.example',
        ok: false,
        error: 'region unavailable'
      })
    ]))
  })

  it('lets findApps use direct hosts when hosts are supplied', async () => {
    const facilitator = new MockLookupFacilitator({
      'https://overlay-us-1.example': { type: 'output-list', outputs: [] }
    })
    const catalog = new AppCatalog({ networkPreset: 'mainnet' })

    const apps = await catalog.findApps({ category: 'Utility' }, {
      facilitator,
      hosts: ['https://overlay-us-1.example/'],
      includeBeef: false
    })

    expect(apps).toEqual([])
    expect(facilitator.calls).toHaveLength(1)
    expect(facilitator.calls[0].host).toBe('https://overlay-us-1.example')
    expect(facilitator.calls[0].question).toEqual({
      service: 'ls_apps',
      query: {
        category: 'Utility',
        includeBeef: false
      }
    })
  })

  it('sends direct outpoint queries to the lookup service', async () => {
    const facilitator = new MockLookupFacilitator({
      'https://overlay.example': { type: 'output-list', outputs: [] }
    })
    const catalog = new AppCatalog({ networkPreset: 'mainnet' })

    await catalog.findApps({ outpoint: `${'a'.repeat(64)}.0` }, {
      facilitator,
      hosts: ['https://overlay.example']
    })

    expect(facilitator.calls[0].question.query).toEqual({ outpoint: `${'a'.repeat(64)}.0` })
  })
})

describe('Metanet Apps contract', () => {
  it('exports the protocol and derivation key used by overlays', () => {
    expect(METANET_APPS_PROTOCOL).toEqual([1, 'metanet apps'])
    expect(METANET_APPS_KEY_ID).toBe('1')
  })

  it('throws a stable error for a resolved SDK broadcast failure', () => {
    expect(() => requireAppCatalogBroadcastSuccess({
      status: 'error',
      code: 'ERR_ALL_HOSTS_REJECTED',
      description: 'Rejected'
    })).toThrow(expect.objectContaining({ code: 'ERR_ALL_HOSTS_REJECTED' }))
  })

  it('accepts canonical v0.1 metadata without rewriting publisher data', () => {
    const normalized = normalizeAppMetadata({
      version: '0.1.0',
      name: 'PaperTrade',
      description: 'Practice trading.',
      icon: 'https://papertrade.metanet.app/icon.png',
      httpURL: 'https://papertrade.metanet.app',
      domain: 'papertrade.metanet.app',
      release_date: '2026-07-20T00:00:00Z'
    })

    expect(normalized.version).toBe('0.1.0')
    expect(normalized.domain).toBe('papertrade.metanet.app')
    expect(normalized.httpURL).toBe('https://papertrade.metanet.app')
  })

  it('rejects noncanonical metadata v2', () => {
    expect(() => normalizeAppMetadata({
      schema_version: '2.0',
      app_version: '1.0.0',
      name: 'Unsafe app',
      description: 'Unsafe URL example.',
      icon_url: 'https://example.com/icon.png',
      launch_url: 'http://user:secret@example.com',
      domain: 'example.com',
      released_at: '2026-07-20T00:00:00Z'
    } as never)).toThrow(expect.objectContaining({ code: 'ERR_METADATA_UNSUPPORTED_SCHEMA' }))
  })

  it('mirrors the canonical topic required fields', () => {
    const metadata = {
      version: '0.1.0',
      name: 'Example',
      description: 'Example app',
      icon: 'https://example.com/icon.png',
      domain: 'example.com',
      release_date: '2026-07-20T00:00:00.000Z'
    } as const

    expect(() => normalizeAppMetadata(metadata as never)).toThrow(AppMetadataValidationError)
    expect(normalizeAppMetadata({ ...metadata, httpURL: '' })).toEqual({ ...metadata, httpURL: '' })
  })
})
