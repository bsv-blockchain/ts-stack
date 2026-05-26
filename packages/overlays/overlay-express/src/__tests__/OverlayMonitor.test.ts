import { describe, it, expect, jest } from '@jest/globals'
import { Transaction } from '@bsv/sdk'
import { OverlayMonitor, analyzeOverlayLookupResponse } from '../OverlayMonitor.js'

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
})
