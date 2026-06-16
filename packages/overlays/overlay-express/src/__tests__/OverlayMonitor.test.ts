import { describe, it, expect, jest } from '@jest/globals'
import { Transaction } from '@bsv/sdk'
import { OverlayMonitor, analyzeOverlayAnchorTip, analyzeOverlayLookupResponse } from '../OverlayMonitor.js'

describe('OverlayMonitor', () => {
  it('summarizes an empty lookup response', () => {
    const result = analyzeOverlayLookupResponse({
      target: 'local-overlay',
      url: 'https://overlay.example/lookup',
      probe: 'empty',
      service: 'ls_empty',
      status: 200,
      ok: true,
      responseBody: { outputs: [] },
      responseBytes: 14,
      durationMs: 5
    })

    expect(result.outputCount).toBe(0)
    expect(result.analyzedOutputCount).toBe(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('reports missing subject proofs in returned BEEF', () => {
    const tx = new Transaction(1, [], [], 0)
    const result = analyzeOverlayLookupResponse({
      target: 'local-overlay',
      url: 'https://overlay.example/lookup',
      probe: 'proof-shape',
      service: 'ls_ship',
      status: 200,
      ok: true,
      responseBody: {
        outputs: [
          {
            outputIndex: 0,
            beef: tx.toBEEF()
          }
        ]
      },
      responseBytes: 512,
      durationMs: 5
    })

    expect(result.outputs[0].txid).toBe(tx.id('hex'))
    expect(result.outputs[0].subjectHasProof).toBe(false)
    expect(result.outputs[0].txCount).toBe(1)
    expect(result.warnings.map(warning => warning.code)).toContain('subject-proof-missing')
  })

  it('runs configured probes through Overlay Express lookup endpoints', async () => {
    const tx = new Transaction(1, [], [], 0)
    const responseBody = JSON.stringify({
      outputs: [
        {
          outputIndex: 0,
          beef: tx.toBEEF()
        }
      ]
    })
    const fetchImpl = jest.fn<typeof fetch>(async () => new Response(responseBody, { status: 200 }))
    const monitor = new OverlayMonitor({
      targets: [
        {
          name: 'local-overlay',
          baseUrl: 'https://overlay.example',
          probes: [
            {
              name: 'ship',
              service: 'ls_ship',
              query: { topics: ['tm_example'] }
            }
          ]
        }
      ],
      fetchImpl
    })

    const report = await monitor.runOnce()

    expect(fetchImpl).toHaveBeenCalledWith('https://overlay.example/lookup', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ service: 'ls_ship', query: { topics: ['tm_example'] } })
    }))
    expect(report.summary.targetCount).toBe(1)
    expect(report.summary.probeCount).toBe(1)
    expect(report.summary.outputsMissingSubjectProof).toBe(1)
  })

  it('reports stale and mismatched BASM anchor tips', () => {
    const result = analyzeOverlayAnchorTip({
      target: 'local-overlay',
      url: 'https://overlay.example/requestTopicAnchorTip',
      probe: 'anchors',
      topic: 'tm_example',
      status: 200,
      ok: true,
      responseBody: {
        blockHeight: 850000,
        tac: '11'.repeat(32),
        expiredUnprovenCount: 2
      },
      responseBytes: 128,
      durationMs: 5,
      expectedTac: '22'.repeat(32),
      currentHeight: 850020,
      thresholds: {
        anchorTipLagBlocks: 6,
        expiredUnprovenCount: 0
      }
    })

    expect(result.warnings.map(warning => warning.code)).toEqual([
      'anchor-tip-mismatch',
      'anchor-stale-height',
      'expired-unproven-state'
    ])
  })

  it('runs configured anchor probes through Overlay Express BASM endpoints', async () => {
    const responseBody = JSON.stringify({
      topic: 'tm_example',
      blockHeight: 850000,
      tac: '11'.repeat(32)
    })
    const fetchImpl = jest.fn<typeof fetch>(async () => new Response(responseBody, { status: 200 }))
    const monitor = new OverlayMonitor({
      targets: [
        {
          name: 'local-overlay',
          baseUrl: 'https://overlay.example',
          probes: [],
          anchorProbes: [
            {
              name: 'topic-tip',
              topic: 'tm_example',
              expectedTac: '11'.repeat(32)
            }
          ]
        }
      ],
      fetchImpl
    })

    const report = await monitor.runOnce()

    expect(fetchImpl).toHaveBeenCalledWith('https://overlay.example/requestTopicAnchorTip', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-bsv-topic': 'tm_example' })
    }))
    expect(report.summary.anchorProbeCount).toBe(1)
    expect(report.anchorResults[0].warnings).toHaveLength(0)
  })

  it('aborts a probe that exceeds the configured timeout', async () => {
    // Never resolves on its own; only settles when the abort signal fires.
    const fetchImpl = jest.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const monitor = new OverlayMonitor({
      targets: [
        {
          name: 'slow-overlay',
          baseUrl: 'https://overlay.example',
          probes: [{ name: 'slow', service: 'ls_slow', query: {} }]
        }
      ],
      fetchImpl,
      timeoutMs: 10
    })

    const report = await monitor.runOnce()

    expect(fetchImpl).toHaveBeenCalledWith('https://overlay.example/lookup', expect.objectContaining({
      signal: expect.anything()
    }))
    expect(report.results[0].ok).toBe(false)
    expect(report.results[0].error).toContain('timed out')
    expect(report.summary.failedProbeCount).toBe(1)
  })
})
