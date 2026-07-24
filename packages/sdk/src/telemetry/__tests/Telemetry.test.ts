import { Telemetry, TelemetryEvent } from '../Telemetry'

describe('Telemetry', () => {
  it('is disabled by default and isolates sink failures', async () => {
    const disabledSink = jest.fn()
    new Telemetry({ sink: { capture: disabledSink }, enabled: false }).capture({
      name: 'wallet.test',
      component: 'wallet-toolbox'
    })
    expect(disabledSink).not.toHaveBeenCalled()

    const throwing = new Telemetry({
      sink: {
        capture: () => {
          throw new Error('sink failed')
        }
      }
    })
    expect(() => throwing.capture({ name: 'wallet.test', component: 'wallet-toolbox' })).not.toThrow()

    const rejecting = new Telemetry({
      sink: { capture: async () => await Promise.reject(new Error('sink failed')) }
    })
    expect(() => rejecting.capture({ name: 'wallet.test', component: 'wallet-toolbox' })).not.toThrow()
    await Promise.resolve()
  })

  it('redacts secret-bearing attributes and diagnostic text', () => {
    let captured: TelemetryEvent | undefined
    const telemetry = new Telemetry({
      sink: { capture: event => { captured = event } },
      includeErrorStack: true,
      now: () => 123
    })
    const privateKey = '1'.repeat(64)
    const snapshot = 'A'.repeat(256)
    const serializedPrivateKey = `[${Array.from({ length: 32 }, (_, i) => i).join(',')}]`

    telemetry.capture({
      name: 'wallet.auth.failed',
      component: 'wallet-toolbox',
      correlationId: 'support-case-1',
      attributes: {
        password: 'do-not-report',
        snapshot,
        presentationKey: privateKey,
        durationMs: 42,
        diagnostic: serializedPrivateKey,
        nestedPayload: { privateKey }
      },
      error: new Error(
        `password=do-not-report private=${privateKey} bytes=${serializedPrivateKey} blob=${snapshot}`
      )
    })

    expect(captured).toMatchObject({
      name: 'wallet.auth.failed',
      component: 'wallet-toolbox',
      timestamp: 123,
      correlationId: 'support-case-1',
      attributes: {
        password: '[REDACTED]',
        snapshot: '[REDACTED]',
        presentationKey: '[REDACTED]',
        durationMs: 42,
        diagnostic: '[REDACTED]',
        nestedPayload: '[REDACTED]'
      }
    })
    expect(JSON.stringify(captured)).not.toContain('do-not-report')
    expect(JSON.stringify(captured)).not.toContain(privateKey)
    expect(JSON.stringify(captured)).not.toContain(snapshot)
    expect(JSON.stringify(captured)).not.toContain(serializedPrivateKey)
  })

  it('filters by severity and re-sanitizes beforeSend enrichment', () => {
    const captured: TelemetryEvent[] = []
    const telemetry = new Telemetry({
      sink: { capture: event => { captured.push(event) } },
      minimumSeverity: 'warn',
      beforeSend: event => ({
        ...event,
        attributes: {
          ...event.attributes,
          recoveryKey: '2'.repeat(64),
          supportTier: 'production'
        }
      })
    })

    telemetry.capture({ name: 'debug', component: 'test', severity: 'debug' })
    telemetry.capture({ name: 'warning', component: 'test', severity: 'warn' })

    expect(captured).toHaveLength(1)
    expect(captured[0].attributes).toEqual({
      recoveryKey: '[REDACTED]',
      supportTier: 'production'
    })

    let mutatedCapture: TelemetryEvent | undefined
    const mutatingHook = new Telemetry({
      sink: { capture: event => { mutatedCapture = event } },
      beforeSend: event => {
        const attributes = event.attributes as Record<string, string | number | boolean>
        attributes.snapshot = 'A'.repeat(256)
        return undefined
      }
    })
    mutatingHook.capture({
      name: 'mutated',
      component: 'test',
      attributes: { supportTier: 'production' }
    })
    expect(mutatedCapture?.attributes).toEqual({
      supportTier: 'production',
      snapshot: '[REDACTED]'
    })
  })
})
