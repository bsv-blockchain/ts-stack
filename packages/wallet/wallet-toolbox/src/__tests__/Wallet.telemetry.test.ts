import { Telemetry, TelemetryEvent } from '@bsv/sdk'
import { Wallet } from '../Wallet'

describe('Wallet validation telemetry', () => {
  function walletWithTelemetry(telemetry: Telemetry): Wallet {
    const wallet = Object.create(Wallet.prototype) as Wallet
    Reflect.set(wallet, 'identityKey', 'wallet-identity')
    Reflect.set(wallet, 'telemetry', telemetry)
    return wallet
  }

  it('binds normalized arguments to a validation span and reports rejection', () => {
    const events: TelemetryEvent[] = []
    const telemetry = new Telemetry({
      sink: { capture: event => events.push(event) },
      traceIdFactory: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      spanIdFactory: () => 'bbbbbbbbbbbbbbbb'
    })
    const wallet = walletWithTelemetry(telemetry)
    const args = { limit: 10 }
    const normalized = { limit: 10, offset: 0 }
    const validate = jest.fn(() => normalized)

    const result = Reflect.get(wallet, 'validateAuthAndArgs').call(
      wallet,
      args,
      validate
    )

    expect(result).toEqual({
      vargs: normalized,
      auth: { identityKey: 'wallet-identity' }
    })
    expect(telemetry.contextFor(normalized)).toEqual({
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      spanId: 'bbbbbbbbbbbbbbbb'
    })
    expect(events[0]).toMatchObject({
      name: 'wallet.validate_args',
      spanStatus: 'ok',
      attributes: { 'validation.result': 'ok' }
    })

    expect(() =>
      Reflect.get(wallet, 'validateAuthAndArgs').call(
        wallet,
        { invalid: true },
        () => {
          throw new Error('invalid arguments')
        }
      )
    ).toThrow('invalid arguments')
    expect(events[1]).toMatchObject({
      name: 'wallet.validate_args',
      spanStatus: 'error',
      attributes: { 'validation.result': 'rejected' },
      error: { message: 'invalid arguments' }
    })
  })

  it('keeps the disabled and non-object validation path allocation-free', () => {
    const validate = jest.fn(() => 'validated')
    const disabled = walletWithTelemetry(new Telemetry())

    expect(
      Reflect.get(disabled, 'validateAuthAndArgs').call(disabled, null, validate)
    ).toEqual({
      vargs: 'validated',
      auth: { identityKey: 'wallet-identity' }
    })
    expect(validate).toHaveBeenCalledWith(null, undefined)
  })
})
