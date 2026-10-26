import { describe, expect, it, jest } from '@jest/globals'
import { OverlayMonitor, type OverlayMonitorConfig } from '../OverlayMonitor.js'

const target = {
  name: 'overlay',
  baseUrl: 'https://overlay.example',
  probes: []
}

const construct = (override: Partial<OverlayMonitorConfig>): OverlayMonitor =>
  new OverlayMonitor({ targets: [target], fetchImpl: jest.fn<typeof fetch>(), ...override })

describe('OverlayMonitor configuration and response boundaries', () => {
  it.each([
    [{ targets: null }, 'targets must be an array'],
    [{ targets: Array.from({ length: 1001 }, () => target) }, 'at most 1000'],
    [{ timeoutMs: 0 }, 'timeoutMs must be a positive safe integer'],
    [{ timeoutMs: 300_001 }, 'timeoutMs must be a positive safe integer'],
    [{ intervalMs: -1 }, 'intervalMs must be a positive safe integer'],
    [{ maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 }, 'maxResponseBytes'],
    [{ maxAnalyzedOutputs: -1 }, 'maxAnalyzedOutputs'],
    [{ thresholds: { responseBytes: -1 } }, 'thresholds.responseBytes'],
    [{ thresholds: { beefBytes: 1.5 } }, 'thresholds.beefBytes'],
    [
      { thresholds: { txsWithoutProof: Number.MAX_SAFE_INTEGER + 1 } },
      'thresholds.txsWithoutProof'
    ],
    [{ thresholds: { requireSubjectProof: 'yes' } }, 'requireSubjectProof must be a boolean']
  ])('rejects invalid global monitor configuration %#', (override, message) => {
    expect(() => construct(override as any)).toThrow(message)
  })

  it.each([
    [{ allowPrivateHosts: 'yes' }, 'allowPrivateHosts must be a boolean'],
    [{ probes: null }, 'target.probes'],
    [
      { probes: Array.from({ length: 10_001 }, () => ({ service: 'ls', query: {} })) },
      'target.probes'
    ],
    [{ probes: [{ service: '', query: {} }] }, 'probe.service'],
    [{ probes: [{ service: 'ls', name: 'bad\nname', query: {} }] }, 'probe.name'],
    [{ probes: [{ service: 'ls', maxOutputs: -1, query: {} }] }, 'probe.maxOutputs'],
    [{ anchorProbes: 'bad' }, 'target.anchorProbes'],
    [
      { anchorProbes: Array.from({ length: 10_001 }, () => ({ topic: 'tm' })) },
      'target.anchorProbes'
    ],
    [{ anchorProbes: [{ topic: 'tm', name: '\u007f' }] }, 'anchorProbe.name'],
    [{ maintenance: { maintainUnproven: { topics: 'bad' } } }, 'maintenance topics'],
    [
      { maintenance: { maintainUnproven: { topics: Array.from({ length: 10_001 }, () => 'tm') } } },
      'maintenance topics'
    ],
    [{ maintenance: { maintainUnproven: { topics: ['bad\ntopic'] } } }, 'maintenance topic'],
    [{ maintenance: { maintainUnproven: { thresholdBlocks: -1 } } }, 'thresholdBlocks']
  ])('rejects an invalid target boundary %#', (targetOverride, message) => {
    expect(
      () =>
        new OverlayMonitor({
          targets: [{ ...target, ...targetOverride } as any],
          fetchImpl: jest.fn<typeof fetch>()
        })
    ).toThrow(message)
  })

  it.each([
    [{ headers: [] }, 'target.headers must be a record'],
    [
      {
        headers: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`x-${index}`, 'ok']))
      },
      'at most 128 entries'
    ],
    [{ headers: { 'bad header': 'value' } }, 'invalid header name'],
    [{ headers: { 'x-test': 'bad\r\nvalue' } }, 'bounded string'],
    [{ maintenance: { headers: { 'bad header': 'value' } } }, 'invalid header name'],
    [{ maintenance: { adminToken: 'x'.repeat(16 * 1024 + 1) } }, 'maintenance.adminToken']
  ])('rejects attacker-controlled request headers %#', (targetOverride, message) => {
    expect(
      () =>
        new OverlayMonitor({
          targets: [{ ...target, ...targetOverride } as any],
          fetchImpl: jest.fn<typeof fetch>()
        })
    ).toThrow(message)
  })

  it('uses explicit output caps and rejects an unregistered transport target', async () => {
    const fetchImpl = jest.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ outputs: [{ outputIndex: 0 }, { outputIndex: 1 }] }))
    )
    const monitor = new OverlayMonitor({
      targets: [
        {
          ...target,
          probes: [{ service: 'ls_test', query: {}, maxOutputs: 0 }]
        }
      ],
      fetchImpl,
      maxAnalyzedOutputs: 1
    })

    const report = await monitor.runOnce()
    expect(report.results[0]).toMatchObject({ outputCount: 2, analyzedOutputCount: 0 })
    expect(() => (monitor as any).fetchFor(target)).toThrow('transport is unavailable')
  })

  it.each([
    ['', true, undefined],
    ['[]', false, 'Invalid Overlay anchor JSON response']
  ])('handles an empty or non-object anchor response: %j', async (body, ok, error) => {
    const monitor = new OverlayMonitor({
      targets: [{ ...target, anchorProbes: [{ topic: 'tm_test' }] }],
      fetchImpl: jest.fn<typeof fetch>(async () => new Response(body))
    })

    const report = await monitor.runOnce()
    expect(report.anchorResults[0].ok).toBe(ok)
    expect(report.anchorResults[0].error).toBe(error)
  })

  it('bounds thrown transport details and hides non-Error values', async () => {
    const longFailure = new OverlayMonitor({
      targets: [{ ...target, probes: [{ service: 'ls_test', query: {} }] }],
      fetchImpl: jest.fn<typeof fetch>(async () => {
        throw new Error('x'.repeat(2048))
      })
    })
    const hiddenFailure = new OverlayMonitor({
      targets: [{ ...target, probes: [{ service: 'ls_test', query: {} }] }],
      fetchImpl: jest.fn<typeof fetch>(async () => {
        throw 'secret transport value'
      })
    })

    const longReport = await longFailure.runOnce()
    const hiddenReport = await hiddenFailure.runOnce()
    expect(new TextEncoder().encode(longReport.results[0].error).byteLength).toBeLessThanOrEqual(
      1027
    )
    expect(longReport.results[0].error?.endsWith('…')).toBe(true)
    expect(hiddenReport.results[0].error).toBe('Lookup probe failed')
  })
})
