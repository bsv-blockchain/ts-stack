import { Telemetry, TelemetryEvent, TelemetrySpanContext } from '../Telemetry'

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
    expect(() =>
      throwing.capture({ name: 'wallet.test', component: 'wallet-toolbox' })
    ).not.toThrow()

    const rejecting = new Telemetry({
      sink: { capture: async () => await Promise.reject(new Error('sink failed')) }
    })
    expect(() =>
      rejecting.capture({ name: 'wallet.test', component: 'wallet-toolbox' })
    ).not.toThrow()
    await Promise.resolve()
  })

  it('supports a fail-closed runtime enablement predicate', () => {
    const events: TelemetryEvent[] = []
    let enabled = false
    const telemetry = new Telemetry({
      enabled: () => enabled,
      sink: {
        capture: event => {
          events.push(event)
        }
      }
    })

    expect(telemetry.enabled).toBe(false)
    telemetry.capture({ name: 'disabled', component: 'test' })
    enabled = true
    expect(telemetry.enabled).toBe(true)
    telemetry.capture({ name: 'enabled', component: 'test' })
    expect(events.map(event => event.name)).toEqual(['enabled'])

    const failClosed = new Telemetry({
      enabled: () => {
        throw new Error('preference unavailable')
      },
      sink: { capture: jest.fn() }
    })
    expect(failClosed.enabled).toBe(false)
  })

  it('redacts secret-bearing attributes and diagnostic text', () => {
    let captured: TelemetryEvent | undefined
    const telemetry = new Telemetry({
      sink: {
        capture: event => {
          captured = event
        }
      },
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
      sink: {
        capture: event => {
          captured.push(event)
        }
      },
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
      sink: {
        capture: event => {
          mutatedCapture = event
        }
      },
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

  it('records monotonic spans, runtime deltas, and parentage', async () => {
    const captured: TelemetryEvent[] = []
    const highResolutionTimes = [10, 12, 13, 18]
    const ids = ['11111111111111111111111111111111', '2222222222222222', '3333333333333333']
    let runtimeCounter = 0
    const telemetry = new Telemetry({
      sink: {
        capture: event => {
          captured.push(event)
        }
      },
      now: () => 1_000,
      highResolutionNow: () => highResolutionTimes.shift() ?? 18,
      traceIdFactory: () => ids.shift()!,
      spanIdFactory: () => ids.shift()!,
      runtimeMetrics: {
        snapshot: () => runtimeCounter++,
        diff: (start, end) => ({
          'runtime.cpu_ms': (end as number) - (start as number)
        })
      }
    })
    const carrier = {}

    await telemetry.withSpan(
      'wallet.call.createAction',
      { component: 'wallet', kind: 'server', carrier },
      async root => {
        expect(telemetry.contextFor(carrier)).toEqual(root.context)
        await root.child('wallet.validate', { component: 'wallet' }).end({
          attributes: { 'validation.result': 'ok' }
        })
      }
    )

    expect(captured).toHaveLength(2)
    const child = captured[0]
    const root = captured[1]
    expect(root).toMatchObject({
      name: 'wallet.call.createAction',
      type: 'span',
      traceId: '11111111111111111111111111111111',
      spanId: '2222222222222222',
      spanKind: 'server',
      spanStatus: 'ok',
      startTimestamp: 1_000,
      durationMs: 8,
      attributes: { 'runtime.cpu_ms': 3 }
    })
    expect(child).toMatchObject({
      name: 'wallet.validate',
      traceId: root.traceId,
      spanId: '3333333333333333',
      parentSpanId: root.spanId,
      durationMs: 1,
      attributes: {
        'runtime.cpu_ms': 1,
        'validation.result': 'ok'
      }
    })
  })

  it('keeps explicit carriers isolated across parallel calls', async () => {
    const events: TelemetryEvent[] = []
    const telemetry = new Telemetry({
      sink: {
        capture: event => {
          events.push(event)
        }
      }
    })
    const firstCarrier = {}
    const secondCarrier = {}
    const first = telemetry.startSpan('first', { component: 'test', carrier: firstCarrier })
    const second = telemetry.startSpan('second', { component: 'test', carrier: secondCarrier })

    const firstChild = telemetry.startSpan('first.child', {
      component: 'test',
      carrier: firstCarrier
    })
    const secondChild = telemetry.startSpan('second.child', {
      component: 'test',
      carrier: secondCarrier
    })
    firstChild.end()
    secondChild.end()
    first.end()
    second.end()

    expect(first.context.traceId).not.toBe(second.context.traceId)
    expect(events.find(event => event.name === 'first.child')).toMatchObject({
      traceId: first.context.traceId,
      parentSpanId: first.context.spanId
    })
    expect(events.find(event => event.name === 'second.child')).toMatchObject({
      traceId: second.context.traceId,
      parentSpanId: second.context.spanId
    })
  })

  it('uses a host context manager for asynchronous child work', async () => {
    let active: TelemetrySpanContext | undefined
    const events: TelemetryEvent[] = []
    const telemetry = new Telemetry({
      sink: {
        capture: event => {
          events.push(event)
        }
      },
      contextManager: {
        active: () => active,
        run: (context, callback) => {
          const previous = active
          active = context
          try {
            return callback()
          } finally {
            active = previous
          }
        }
      }
    })

    telemetry.withSpan('root', { component: 'test' }, root => {
      const child = telemetry.startSpan('child', { component: 'test' })
      expect(child.parentSpanId).toBe(root.context.spanId)
      child.end()
    })

    expect(events.map(event => event.name)).toEqual(['child', 'root'])
  })

  it('records rejected promises once and never lets an error hook replace the error', async () => {
    const captured: TelemetryEvent[] = []
    const telemetry = new Telemetry({
      sink: {
        capture: event => {
          captured.push(event)
        }
      },
      beforeSend: event => ({
        ...event,
        traceId: 'not-a-trace',
        durationMs: Number.NaN
      })
    })

    await expect(
      telemetry.withSpan(
        'failed',
        { component: 'test' },
        async () => await Promise.reject(new Error('expected failure'))
      )
    ).rejects.toThrow('expected failure')

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      name: 'failed',
      type: 'span',
      spanStatus: 'error',
      severity: 'error',
      error: {
        name: 'Error',
        message: 'expected failure'
      }
    })
    expect(captured[0].traceId).toBeUndefined()
    expect(captured[0].durationMs).toBeUndefined()
  })
})
