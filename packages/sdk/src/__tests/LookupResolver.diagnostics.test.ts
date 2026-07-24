import LookupResolver, { OverlayLookupFacilitator } from '../overlay-tools/LookupResolver'
import { TelemetryEvent } from '../telemetry/Telemetry'

function createReputationStorage (): { get: () => undefined, set: () => void } {
  return {
    get: () => undefined,
    set: () => {}
  }
}

describe('LookupResolver diagnostics', () => {
  it('distinguishes authoritative empty results from host failures', async () => {
    const emptyFacilitator: OverlayLookupFacilitator = {
      lookup: async () => ({ type: 'output-list', outputs: [] })
    }
    const emptyResolver = new LookupResolver({
      facilitator: emptyFacilitator,
      hostOverrides: {
        ls_diagnostics: ['https://one.example', 'https://two.example']
      },
      reputationStorage: createReputationStorage()
    })

    const empty = await emptyResolver.queryDetailed({
      service: 'ls_diagnostics',
      query: { presentationHash: '1'.repeat(64) }
    })

    expect(empty.answer.outputs).toEqual([])
    expect(empty.progress).toMatchObject({
      isFinal: true,
      hostCount: 2,
      completedHosts: 2,
      successfulHosts: 2,
      emptyHosts: 2,
      failedHosts: 0,
      rejectedHosts: 0,
      freeformHosts: 0
    })

    const partialFacilitator: OverlayLookupFacilitator = {
      lookup: async (host) => {
        if (host.includes('failed')) throw new Error('network unavailable')
        return { type: 'output-list', outputs: [] }
      }
    }
    const partialResolver = new LookupResolver({
      facilitator: partialFacilitator,
      hostOverrides: {
        ls_diagnostics: ['https://healthy.example', 'https://failed.example']
      },
      reputationStorage: createReputationStorage()
    })

    const partial = await partialResolver.queryDetailed({
      service: 'ls_diagnostics',
      query: { presentationHash: '2'.repeat(64) }
    })

    expect(partial.answer.outputs).toEqual([])
    expect(partial.progress).toMatchObject({
      isFinal: true,
      hostCount: 2,
      completedHosts: 2,
      successfulHosts: 1,
      emptyHosts: 1,
      failedHosts: 1
    })
  })

  it('emits only bounded metadata and never the lookup payload', async () => {
    const events: TelemetryEvent[] = []
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async () => ({ type: 'output-list', outputs: [] })
      },
      hostOverrides: {
        ls_private: ['https://overlay.example/private/path?secret=yes']
      },
      reputationStorage: createReputationStorage(),
      telemetry: {
        sink: {
          capture: event => {
            events.push(event)
          }
        },
        minimumSeverity: 'debug',
        correlationIdFactory: () => 'lookup-correlation'
      }
    })
    const privateHash = 'a'.repeat(64)

    await resolver.queryDetailed({
      service: 'ls_private',
      query: {
        presentationHash: privateHash,
        snapshot: 'must-never-appear'
      }
    })

    const serialized = JSON.stringify(events)
    expect(events.length).toBeGreaterThan(0)
    expect(serialized).not.toContain(privateHash)
    expect(serialized).not.toContain('must-never-appear')
    expect(serialized).not.toContain('/private/path')
    expect(serialized).not.toContain('secret=yes')
    expect(serialized).toContain('https://overlay.example')
    expect(serialized).toContain('lookup-correlation')
  })
})
