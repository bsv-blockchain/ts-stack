import { Telemetry, TelemetryEvent } from '@bsv/sdk'
import { completeSignedTransaction } from '../completeSignedTransaction'
import { signAction } from '../signAction'

describe('signing telemetry', () => {
  it('reports an invalid signAction reference on the correlated root span', async () => {
    const events: TelemetryEvent[] = []
    const wallet = {
      pendingSignActions: {},
      telemetry: new Telemetry({
        sink: { capture: event => events.push(event) },
        traceIdFactory: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanIdFactory: () => 'bbbbbbbbbbbbbbbb'
      })
    } as any

    await expect(
      signAction(wallet, { identityKey: 'wallet' }, { reference: 'missing' })
    ).rejects.toThrow('recovery of out-of-session signAction')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'wallet.sign_action',
      spanStatus: 'error'
    })

    wallet.telemetry = new Telemetry()
    await expect(
      signAction(wallet, { identityKey: 'wallet' }, { reference: 'missing' })
    ).rejects.toThrow('recovery of out-of-session signAction')
  })

  it('times transaction signing while retaining the disabled fast path', async () => {
    const events: TelemetryEvent[] = []
    const sign = jest.fn(async () => undefined)
    const prior = {
      args: { inputs: [] },
      pdi: [],
      tx: { inputs: [], sign }
    } as any
    const wallet = {
      telemetry: new Telemetry({
        sink: { capture: event => events.push(event) }
      })
    } as any

    await expect(completeSignedTransaction(prior, {}, wallet)).resolves.toBe(prior.tx)
    expect(events[0]).toMatchObject({
      name: 'wallet.crypto.transaction_sign',
      spanStatus: 'ok',
      attributes: { 'crypto.input_count': 0 }
    })

    wallet.telemetry = new Telemetry()
    await expect(completeSignedTransaction(prior, {}, wallet)).resolves.toBe(prior.tx)
    expect(sign).toHaveBeenCalledTimes(2)
  })
})
