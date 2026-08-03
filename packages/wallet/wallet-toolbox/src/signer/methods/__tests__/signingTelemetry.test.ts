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

    await expect(signAction(wallet, { identityKey: 'wallet' }, { reference: 'missing' })).rejects.toThrow(
      'recovery of out-of-session signAction'
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'wallet.sign_action',
      spanStatus: 'error'
    })

    wallet.telemetry = new Telemetry()
    await expect(signAction(wallet, { identityKey: 'wallet' }, { reference: 'missing' })).rejects.toThrow(
      'recovery of out-of-session signAction'
    )
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

  it('computes the invariant client change key pair once for every managed input', async () => {
    const getClientChangeKeyPair = jest.fn(() => ({
      privateKey: '01'.padStart(64, '0'),
      publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    }))
    const derivePrivateKey = jest.fn(() => ({
      toHex: () => '02'.padStart(64, '0')
    }))
    const inputs = [{}, {}, {}]
    const prior = {
      args: { inputs: [] },
      pdi: inputs.map((_, vin) => ({
        vin,
        derivationPrefix: 'prefix',
        derivationSuffix: `suffix-${vin}`,
        sourceSatoshis: 1000,
        lockingScript: '76a914000000000000000000000000000000000000000088ac'
      })),
      tx: { inputs, sign: jest.fn(async () => undefined) }
    } as any
    const events: TelemetryEvent[] = []
    const wallet = {
      getClientChangeKeyPair,
      keyDeriver: {
        rootKey: { toHex: () => '01'.padStart(64, '0') },
        derivePrivateKey
      },
      telemetry: new Telemetry({ sink: { capture: event => events.push(event) } })
    } as any

    await expect(completeSignedTransaction(prior, {}, wallet)).resolves.toBe(prior.tx)

    expect(getClientChangeKeyPair).toHaveBeenCalledTimes(1)
    expect(derivePrivateKey).toHaveBeenCalledTimes(3)
    expect(inputs.every(input => input.unlockingScriptTemplate != null)).toBe(true)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'wallet.crypto.prepare_unlocking_templates',
        spanStatus: 'ok',
        attributes: { 'crypto.managed_input_count': 3 }
      })
    ]))
  })
})
