import {
  sanitizeTelemetryText,
  Telemetry,
  TelemetryEvent,
  TelemetrySpanContext
} from '../Telemetry'

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
    expect(
      new Telemetry({
        enabled: (() => 'yes') as any,
        sink: { capture: jest.fn() }
      }).enabled
    ).toBe(false)
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

  it('redacts generic credentials, authorization headers, and URL userinfo', () => {
    const secret = 'short-sensitive-value'
    const text = [
      `apiKey=${secret}`,
      'Authorization: Basic dXNlcjpwYXNz',
      'Bearer header.payload.signature',
      'https://alice:password@example.test/path',
      'https://access-token@example.test/path',
      `cookie=${secret}`
    ].join(' ')

    const sanitized = sanitizeTelemetryText(text)

    expect(sanitized).not.toContain(secret)
    expect(sanitized).not.toContain('dXNlcjpwYXNz')
    expect(sanitized).not.toContain('header.payload.signature')
    expect(sanitized).not.toContain('alice:password')
    expect(sanitized).not.toContain('access-token@')
    expect(sanitizeTelemetryText('visible', Number.POSITIVE_INFINITY)).toBe('visible')
    expect(sanitizeTelemetryText('visible', 0)).toBe('')
  })

  it('does not invoke event, attribute, or error accessors', () => {
    const captured: TelemetryEvent[] = []
    const telemetry = new Telemetry({ sink: { capture: event => captured.push(event) } })
    let invoked = 0
    const attributes: Record<string, unknown> = { safe: 'yes' }
    Object.defineProperty(attributes, 'apiKey', {
      enumerable: true,
      get: () => {
        invoked++
        return 'secret'
      }
    })
    const error: Record<string, unknown> = {}
    Object.defineProperty(error, 'message', {
      enumerable: true,
      get: () => {
        invoked++
        return 'secret error'
      }
    })

    telemetry.capture({ name: 'safe', component: 'test', attributes, error })
    expect(invoked).toBe(0)
    expect(captured[0]).toMatchObject({
      attributes: { safe: 'yes' },
      error: { name: 'Error', message: 'Unknown error' }
    })

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('prototype trap executed')
        }
      }
    )
    expect(() => telemetry.capture(hostile as any)).not.toThrow()
    expect(captured).toHaveLength(1)
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

  it('contains context-manager faults without suppressing, duplicating, or replacing work', () => {
    let calls = 0
    const callback = (): number => {
      calls += 1
      return 42
    }
    const before = new Telemetry({
      sink: { capture: () => {} },
      contextManager: {
        active: () => undefined,
        run: () => {
          throw new Error('failed before callback')
        }
      }
    })
    expect(before.withSpan('before', { component: 'test' }, callback)).toBe(42)

    const after = new Telemetry({
      sink: { capture: () => {} },
      contextManager: {
        active: () => undefined,
        run: (_context, runCallback) => {
          runCallback()
          runCallback()
          throw new Error('failed after callback')
        }
      }
    })
    expect(after.withSpan('after', { component: 'test' }, callback)).toBe(42)

    const substituting = new Telemetry({
      sink: { capture: () => {} },
      contextManager: {
        active: () => undefined,
        run: ((_context: TelemetrySpanContext, runCallback: () => number) => {
          runCallback()
          return 99
        }) as any
      }
    })
    expect(substituting.withSpan('substitution', { component: 'test' }, callback)).toBe(42)
    expect(calls).toBe(3)

    const swallowing = new Telemetry({
      sink: { capture: () => {} },
      contextManager: {
        active: () => undefined,
        run: ((_context: TelemetrySpanContext, runCallback: () => never) => {
          try {
            runCallback()
          } catch {
            return undefined
          }
        }) as any
      }
    })
    expect(() =>
      swallowing.withSpan('swallowed', { component: 'test' }, () => {
        throw new Error('application failure')
      })
    ).toThrow('application failure')
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

  it('keeps every defensive tracing fallback isolated from application work', () => {
    const captured: TelemetryEvent[] = []
    const telemetry = new Telemetry({
      sink: {
        capture: event => {
          captured.push(event)
        }
      },
      minimumSeverity: 'debug',
      correlationIdFactory: () => {
        throw new Error('correlation id unavailable')
      },
      traceIdFactory: () => {
        throw new Error('trace id unavailable')
      },
      spanIdFactory: () => {
        throw new Error('span id unavailable')
      },
      contextManager: {
        active: () => {
          throw new Error('context unavailable')
        },
        run: (_context, callback) => callback()
      },
      runtimeMetrics: {
        snapshot: () => {
          throw new Error('runtime snapshot unavailable')
        },
        diff: () => {
          throw new Error('runtime diff unavailable')
        }
      }
    })

    expect(telemetry.createCorrelationId()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
    expect(telemetry.createTraceId()).toMatch(/^[0-9a-f]{32}$/)
    expect(telemetry.createSpanId()).toMatch(/^[0-9a-f]{16}$/)
    expect(telemetry.activeContext()).toBeUndefined()
    expect(telemetry.runtimeSnapshot()).toBeUndefined()
    expect(telemetry.runtimeDiff(undefined, undefined)).toBeUndefined()

    const unbound = {}
    const target = {}
    telemetry.linkContext(undefined, target)
    telemetry.linkContext(unbound, target)
    expect(telemetry.contextFor(target)).toBeUndefined()

    const span = telemetry.startSpan('defensive', { component: 'test' })
    telemetry.bindContext(unbound, span.context)
    telemetry.linkContext(unbound, target)
    expect(telemetry.contextFor(target)).toEqual(span.context)
    const hostileContext = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('invalid context')
        }
      }
    )
    expect(() => telemetry.bindContext(target, hostileContext as any)).not.toThrow()
    span.capture('defensive.event', { disposition: 'observed' }, 'debug')
    span.end({ status: 'cancelled' })
    span.end({ status: 'error' })

    expect(captured.map(event => event.name)).toEqual(['defensive.event', 'defensive'])
    expect(captured[1]).toMatchObject({ spanStatus: 'cancelled' })
    expect(captured[1]).not.toHaveProperty('attributes')

    expect(() =>
      telemetry.withSpan('sync.failure', { component: 'test' }, () => {
        throw new Error('synchronous failure')
      })
    ).toThrow('synchronous failure')
    expect(captured.at(-1)).toMatchObject({
      name: 'sync.failure',
      spanStatus: 'error',
      error: { message: 'synchronous failure' }
    })

    const edgeEvents: TelemetryEvent[] = []
    const edgeTelemetry = new Telemetry({
      sink: { capture: event => edgeEvents.push(event) }
    })
    edgeTelemetry.capture({
      name: 'invalid.span',
      component: 'test',
      spanId: '0'.repeat(16),
      error: { name: '', message: '' }
    })
    edgeTelemetry.capture({
      name: 'object.error',
      component: 'test',
      error: { message: 'object error' }
    })
    edgeTelemetry.capture({
      name: 'primitive.error',
      component: 'test',
      error: 'primitive error'
    })
    edgeTelemetry.startSpan('explicit.error', { component: 'test' }).end({
      status: 'error'
    })
    edgeTelemetry.startSpan('inferred.error', { component: 'test' }).end({
      error: new Error('inferred error')
    })
    expect(edgeEvents[0]).toMatchObject({
      error: { name: 'Error', message: 'Unknown error' }
    })
    expect(edgeEvents[0].spanId).toBeUndefined()
    expect(edgeEvents[1]).toMatchObject({
      error: { name: 'Error', message: 'object error' }
    })
    expect(edgeEvents[2]).toMatchObject({
      error: { name: 'Error', message: 'primitive error' }
    })

    const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
    try {
      Object.defineProperty(globalThis, 'performance', {
        configurable: true,
        value: undefined
      })
      expect(edgeTelemetry.monotonicClock()()).toBeGreaterThan(0)
    } finally {
      if (performanceDescriptor != null) {
        Object.defineProperty(globalThis, 'performance', performanceDescriptor)
      }
    }
  })

  it('contains hostile clocks and keeps published span context immutable', () => {
    const events: TelemetryEvent[] = []
    const telemetry = new Telemetry({
      sink: { capture: event => events.push(event) },
      now: () => {
        throw new Error('wall clock failed')
      },
      highResolutionNow: () => Number.NaN
    })

    const result = telemetry.withSpan('clock.failure', { component: 'test' }, span => {
      expect(Object.isFrozen(span.context)).toBe(true)
      expect(() => Reflect.set(span.context, 'traceId', '0'.repeat(32))).not.toThrow()
      return 42
    })

    expect(result).toBe(42)
    expect(events).toHaveLength(1)
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(events[0].traceId).toMatch(/^[0-9a-f]{32}$/)
  })
})
