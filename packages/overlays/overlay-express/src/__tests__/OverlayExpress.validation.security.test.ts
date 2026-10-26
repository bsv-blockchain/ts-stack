import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, jest } from '@jest/globals'
import OverlayExpress from '../OverlayExpress.js'
import { OverlayMonitor } from '../OverlayMonitor.js'

const create = (): OverlayExpress =>
  new OverlayExpress('Boundary Test', 'private-key', 'overlay.example')

describe('OverlayExpress public configuration boundaries', () => {
  it('rejects malformed hosting names and browser origins before startup', () => {
    expect(() => new OverlayExpress('test', 'key', 'https://')).toThrow('valid HTTPS host')

    const overlay = create()
    expect(() => overlay.configureEdgePolicy({ allowedOrigins: ['not a URL'] })).toThrow(
      'valid HTTP(S) origins'
    )
    expect(() => overlay.configureEdgePolicy({ allowedOrigins: ['ftp://wallet.example'] })).toThrow(
      'must not contain credentials'
    )
  })

  it('applies janitor SSRF and removal policy only after validating both booleans', () => {
    const overlay = create()
    expect(() => overlay.configureJanitor({ autoBanOnRemoval: 'yes' as any })).toThrow(
      'autoBanOnRemoval'
    )

    overlay.configureJanitor({ autoBanOnRemoval: false, allowPrivateHosts: true })
    expect(overlay.janitorConfig).toMatchObject({
      autoBanOnRemoval: false,
      allowPrivateHosts: true
    })
  })

  it('validates health context callbacks without partially applying bad configuration', () => {
    const overlay = create()
    expect(() => overlay.configureHealth(null as any)).toThrow('must be an object')
    expect(() => overlay.configureHealth({ contextProvider: 'bad' as any })).toThrow(
      'contextProvider must be a function'
    )

    const contextProvider = async (): Promise<Record<string, unknown>> => ({ cell: 'blue' })
    overlay.configureHealth({ includeDetails: true, contextProvider })
    expect(overlay.healthConfig).toMatchObject({ includeDetails: true, contextProvider })
    overlay.configureHealth({ contextProvider: undefined })
    expect(overlay.healthConfig.contextProvider).toBeUndefined()
  })

  it('requires exact admin public-key and logger contracts', () => {
    const overlay = create()
    for (const identityKey of ['', '04' + '11'.repeat(64), '02' + 'zz'.repeat(32)]) {
      expect(() => overlay.configureAdminIdentityKey(identityKey)).toThrow('compressed secp256k1')
    }
    expect(() => overlay.configureLogger(null as any)).toThrow('must provide a log function')
    expect(() => overlay.configureLogger({} as any)).toThrow('must provide a log function')

    const identityKey = `02${'11'.repeat(32)}`
    overlay.configureAdminIdentityKey(identityKey)
    expect(overlay.adminIdentityKey).toBe(identityKey)
  })

  it('rejects partial ChainTracker objects at the runtime boundary', () => {
    const overlay = create()
    for (const tracker of [
      null,
      {},
      { currentHeight: async () => 1 },
      { isValidRootForHeight: async () => true }
    ]) {
      expect(() => overlay.configureChainTracker(tracker as any)).toThrow(
        'must implement root validation and currentHeight'
      )
    }
  })

  it('validates and retains Arcade request metadata as bounded single-line values', () => {
    const overlay = create()
    expect(() => overlay.configureArcade('https://arcade.example', null as any)).toThrow(
      'Arcade configuration must be an object'
    )
    expect(() => overlay.configureArcade('https://arcade.example', { apiKey: 'bad\nkey' })).toThrow(
      'control characters'
    )
    expect(() =>
      overlay.configureArcade('https://arcade.example', { deploymentId: 'bad\ndeployment' })
    ).toThrow('control characters')
    expect(() =>
      overlay.configureArcade('https://arcade.example', { chaintracksApiPrefix: 'bad\nprefix' })
    ).toThrow('control characters')

    const configureArcade = readFileSync(join(process.cwd(), 'src/OverlayExpress.ts'), 'utf8')
    const arcadeMethod = configureArcade.slice(configureArcade.indexOf('configureArcade('))
    expect(arcadeMethod).toContain('const chaintracksStreamUrl = new ChaintracksProvider')
    expect(arcadeMethod).toContain('.reorgStreamUrl()')
    expect(() =>
      overlay.configureArcade('https://arcade.example', { chaintracksApiPrefix: '//evil.example' })
    ).toThrow('protocol-relative')
    expect(() =>
      overlay.configureArcade('https://arcade.example', { chaintracksApiPrefix: 'foo?x=1' })
    ).toThrow('URL path')

    overlay.configureArcade('https://arcade.example', {
      apiKey: 'api-key',
      deploymentId: 'deployment',
      chaintracksApiPrefix: '/chaintracks/v2'
    })
    expect(overlay).toMatchObject({
      arcadeUrl: 'https://arcade.example',
      arcadeApiKey: 'api-key',
      arcadeDeploymentId: 'deployment',
      arcadeChaintracksApiPrefix: '/chaintracks/v2',
      arcadeAllowPrivateHosts: false
    })
  })

  it('validates Chaintracks state-machine toggles and BASM controls', () => {
    const overlay = create()
    expect(() => overlay.configureChaintracks('https://chaintracks.example', null as any)).toThrow(
      'Chaintracks configuration must be an object'
    )
    expect(() =>
      overlay.configureChaintracks('https://chaintracks.example', {
        allowPrivateHosts: 'yes' as any
      })
    ).toThrow('allowPrivateHosts')
    expect(() =>
      overlay.configureChaintracks('https://chaintracks.example', { scanDepth: 0 })
    ).toThrow('scanDepth')
    expect(() => overlay.configureEnableGASPSync('yes' as any)).toThrow('must be a boolean')
    expect(() => overlay.configureEnableBASMSync('yes' as any)).toThrow('must be a boolean')
    expect(() => overlay.configureTopicAnchorHeaderResolver('bad' as any)).toThrow(
      'resolver must be a function'
    )
    expect(() => overlay.configureReorgStream('https://chaintracks.example/reorg', 0)).toThrow(
      'scanDepth'
    )

    const resolver = async (): Promise<undefined> => undefined
    overlay.configureEnableBASMSync(true)
    overlay.configureTopicAnchorHeaderResolver(resolver)
    expect(overlay.enableBASMSync).toBe(true)
    expect(overlay.topicAnchorHeaderResolver).toBe(resolver)
  })

  it('does not start a second interval for an already-running monitor', () => {
    jest.useFakeTimers()
    try {
      const monitor = new OverlayMonitor({
        targets: [],
        intervalMs: 100
      })
      monitor.start()
      const timer = (monitor as any).timer
      monitor.start()
      expect((monitor as any).timer).toBe(timer)
      monitor.stop()
      monitor.stop()
      expect((monitor as any).timer).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })
})
