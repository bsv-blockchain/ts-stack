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

    expect(getVersion).toHaveBeenCalledTimes(1)
    expect(events.map(event => event.name)).toEqual(['wallet.inner', 'wallet.call.getVersion'])
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
})
