import type { WalletInterface } from '../../wallet/Wallet.interfaces'
import { Telemetry, type TelemetryEvent } from '../Telemetry'
import { instrumentWallet } from '../WalletInstrumentation'

describe('instrumentWallet', () => {
  it('wraps BRC-100 calls and carries context into their argument object', async () => {
    const events: TelemetryEvent[] = []
    let telemetry: Telemetry
    const getVersion = jest.fn(async (args: object) => {
      const child = telemetry.startSpan('wallet.inner', {
        component: 'wallet',
        carrier: args
      })
      child.end()
      return { version: '1.0.0' }
    })
    const wallet = { getVersion } as unknown as WalletInterface
    telemetry = new Telemetry({
      sink: {
        capture: event => {
          events.push(event)
        }
      }
    })

    const instrumented = instrumentWallet(wallet, telemetry, {
      component: 'bridge',
      kind: 'server',
      attributes: method => ({ 'bridge.method': String(method) })
    })
    await instrumented.getVersion({})
    await instrumented.getVersion({})

    expect(getVersion).toHaveBeenCalledTimes(2)
    expect(events.map(event => event.name)).toEqual([
      'wallet.inner',
      'wallet.call.getVersion',
      'wallet.inner',
      'wallet.call.getVersion'
    ])
    expect(events[0]).toMatchObject({
      traceId: events[1].traceId,
      parentSpanId: events[1].spanId
    })
    expect(events[1]).toMatchObject({
      component: 'bridge',
      spanKind: 'server',
      attributes: {
        'wallet.method': 'getVersion',
        'bridge.method': 'getVersion'
      }
    })
  })

  it('returns the original wallet when telemetry is disabled', () => {
    const wallet = {} as WalletInterface
    expect(instrumentWallet(wallet, {})).toBe(wallet)
  })

  it('preserves non-wallet members and method binding', () => {
    const wallet = {
      value: 7,
      customMethod() {
        return this.value
      }
    } as unknown as WalletInterface
    const instrumented = instrumentWallet(wallet, {
      sink: { capture: () => {} }
    }) as WalletInterface & { value: number; customMethod: () => number }

    expect(instrumented.value).toBe(7)
    expect(instrumented.customMethod()).toBe(7)
  })

  it('preserves non-function values assigned to wallet method names', () => {
    const wallet = { getVersion: 'temporarily unavailable' } as unknown as WalletInterface
    const instrumented = instrumentWallet(wallet, {
      sink: { capture: () => {} }
    })

    expect(Reflect.get(instrumented, 'getVersion')).toBe('temporarily unavailable')
  })

  it('contains enrichment failures without preventing the wallet call', async () => {
    const getVersion = jest.fn(async () => ({ version: '1.0.0' }))
    const wallet = { getVersion } as unknown as WalletInterface
    const instrumented = instrumentWallet(
      wallet,
      { sink: { capture: () => {} } },
      {
        attributes: () => {
          throw new Error('enrichment failed')
        }
      }
    )

    await expect(instrumented.getVersion({})).resolves.toEqual({ version: '1.0.0' })
    expect(getVersion).toHaveBeenCalledTimes(1)
  })

  it('does not invoke enrichment accessors or let enrichment replace core attributes', async () => {
    const events: TelemetryEvent[] = []
    let invoked = false
    const supplied: Record<string, string> = {
      'wallet.method': 'createAction',
      safe: 'included'
    }
    Object.defineProperty(supplied, 'secret', {
      enumerable: true,
      get: () => {
        invoked = true
        return 'not-included'
      }
    })
    const getVersion = jest.fn(async () => ({ version: '1.0.0' }))
    const instrumented = instrumentWallet(
      { getVersion } as unknown as WalletInterface,
      { sink: { capture: event => events.push(event) } },
      { attributes: () => supplied }
    )

    await expect(instrumented.getVersion({})).resolves.toEqual({ version: '1.0.0' })
    expect(invoked).toBe(false)
    expect(events[0].attributes).toMatchObject({
      'wallet.method': 'getVersion',
      safe: 'included'
    })
    expect(events[0].attributes).not.toHaveProperty('secret')
  })

  it('honors a dynamic enablement predicate after instrumentation', async () => {
    const events: TelemetryEvent[] = []
    let enabled = false
    const getVersion = jest.fn(async () => ({ version: '1.0.0' }))
    const instrumented = instrumentWallet({ getVersion } as unknown as WalletInterface, {
      enabled: () => enabled,
      sink: { capture: event => events.push(event) }
    })

    await instrumented.getVersion({})
    enabled = true
    await instrumented.getVersion({})

    expect(getVersion).toHaveBeenCalledTimes(2)
    expect(events.map(event => event.name)).toEqual(['wallet.call.getVersion'])
  })
})
