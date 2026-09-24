import { AuthFetch } from '../AuthFetch.js'
import PrivateKey from '../../../primitives/PrivateKey.js'
import Transaction from '../../../transaction/Transaction.js'
import Script from '../../../script/Script.js'
import { ProtoWallet } from '../../../wallet/ProtoWallet.js'
import { toBase64 } from '../../../primitives/utils.js'
import type { WalletInterface, CreateActionArgs } from '../../../wallet/Wallet.interfaces.js'

const key = new PrivateKey(17)
const identity = key.toPublicKey().toString()
const prefix = toBase64(Array.from({ length: 48 }, () => 1))
function setup(ancestorBytes = 0) {
  const wallet = new ProtoWallet(key) as unknown as WalletInterface
  const prepared: string[] = []
  wallet.abortAction = jest.fn(async () => ({ aborted: true }))
  wallet.createAction = jest.fn(async (args: CreateActionArgs) => {
    if (args.options?.sendWith != null)
      return {
        sendWithResults: args.options.sendWith.map(txid => ({ txid, status: 'unproven' as const }))
      }
    const source = new Transaction()
    source.addOutput({ satoshis: 1000, lockingScript: Script.fromASM('OP_TRUE') })
    if (ancestorBytes > 0)
      source.addOutput({
        satoshis: 0,
        lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${'01'.repeat(ancestorBytes)}`)
      })
    const payment = new Transaction()
    payment.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    payment.addOutput({
      satoshis: args.outputs![0].satoshis,
      lockingScript: Script.fromHex(args.outputs![0].lockingScript)
    })
    prepared.push(payment.id('hex'))
    return { txid: payment.id('hex'), tx: payment.toAtomicBEEF() }
  })
  const client = new AuthFetch(wallet)
  const internal = client as any
  jest.spyOn(internal, 'logPaymentAttempt').mockImplementation(() => {})
  jest.spyOn(internal, 'wait').mockResolvedValue(undefined)
  const send = jest.spyOn(client, 'fetch').mockResolvedValue(new Response('ok'))
  const response = (transports?: string) =>
    new Response('', {
      status: 402,
      headers: {
        'x-bsv-payment-version': '1.0',
        'x-bsv-payment-satoshis-required': '10',
        'x-bsv-payment-derivation-prefix': prefix,
        'x-bsv-auth-identity-key': identity,
        ...(transports === undefined ? {} : { 'x-bsv-payment-transports': transports })
      }
    })
  const pay = (config = {}, advertisement?: string) =>
    internal.handlePaymentAndRetry(
      'https://payment.example/paid?q=unchanged',
      config,
      response(advertisement)
    )
  return { client, internal, wallet, prepared, send, response, pay }
}

afterEach(() => jest.restoreAllMocks())

describe('AuthFetch prepared BRC-118 payments', () => {
  it('prepares without broadcast, keeps small payments in headers, then submits exactly once', async () => {
    const { pay, wallet, send, prepared } = setup()
    await pay()
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    expect(wallet.createAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        options: expect.objectContaining({ noSend: true, randomizeOutputs: false })
      }),
      undefined
    )
    expect(wallet.createAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        options: { sendWith: [prepared[0]], acceptDelayedBroadcast: false }
      }),
      undefined
    )
    expect(send.mock.calls[0][1]!.headers!['x-bsv-payment']).toContain('transaction')
  })
  it('wraps growing BEEF with the original bytes and media type', async () => {
    const { pay, send, wallet } = setup(12_000)
    await pay(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: '{ "utf8": "雪" }\n'
      },
      'header,multipart'
    )
    const config = send.mock.calls[0][1]!
    expect(config.method).toBe('POST')
    expect(config.headers!['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(config.headers!['x-bsv-payment']).toBeUndefined()
    expect(Buffer.from(config.body).toString()).toContain(
      'Content-Type: application/json; charset=utf-8\r\n\r\n{ "utf8": "雪" }\n'
    )
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })
  it.each([
    [{ method: 'POST' }, undefined],
    [{ method: 'GET' }, 'header,multipart'],
    [{ method: 'HEAD' }, 'header,multipart'],
    [{ method: 'POST', paymentTransport: { maxBodyBytes: 1000 } }, 'header,multipart'],
    [{ method: 'POST', paymentTransport: { maxPaymentBytes: 1000 } }, 'header,multipart']
  ])(
    'refuses an infeasible prepared payment before broadcasting %#',
    async (config, advertisement) => {
      const { pay, wallet, send, prepared } = setup(12_000)
      await expect(pay(config, advertisement)).rejects.toMatchObject({
        retryable: false,
        payment: { txid: expect.any(String), state: 'prepared', aborted: true }
      })
      expect(wallet.createAction).toHaveBeenCalledTimes(1)
      expect(wallet.abortAction).toHaveBeenCalledWith({ reference: prepared[0] }, undefined)
      expect(send).not.toHaveBeenCalled()
    }
  )
  it('refuses unknown transport advertisements before touching the wallet', async () => {
    const { pay, wallet } = setup()
    await expect(pay({}, 'unknown')).rejects.toMatchObject({ code: 'ERR_PAYMENT_TRANSPORT' })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
  it('reuses one payment and one frozen multipart body after a lost response', async () => {
    const { pay, send, wallet } = setup(12_000)
    send
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(new Response('ok'))
    await pay({ method: 'POST' }, 'header,multipart')
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][1]!.body).toBe(send.mock.calls[1][1]!.body)
    expect(send.mock.calls[0][1]!.headers).toBe(send.mock.calls[1][1]!.headers)
  })
  it('never creates another spend when a paid retry receives a different challenge', async () => {
    const { pay, send, internal, response, wallet } = setup()
    send.mockImplementationOnce(async (url, config) => {
      const changed = response('header,multipart')
      changed.headers.set('x-bsv-payment-satoshis-required', '11')
      return internal.handlePaymentAndRetry(url, config, changed)
    })
    await expect(pay()).rejects.toMatchObject({
      code: 'ERR_PAYMENT_REQUIREMENTS_CHANGED',
      payment: { state: 'submitted' }
    })
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })
  it.each([true, false])(
    'treats size refusal as terminal, authenticated=%s',
    async authenticated => {
      const { pay, send, wallet } = setup()
      if (authenticated) send.mockResolvedValueOnce(new Response('', { status: 413 }))
      else
        send.mockRejectedValueOnce(
          Object.assign(new Error('proxy refused'), { details: { status: 431 } })
        )
      await expect(pay()).rejects.toMatchObject({
        code: 'ERR_PAYMENT_SIZE',
        authenticated,
        payment: { state: 'submitted' }
      })
      expect(send).toHaveBeenCalledTimes(1)
      expect(wallet.createAction).toHaveBeenCalledTimes(2)
      expect(wallet.abortAction).not.toHaveBeenCalled()
    }
  )
  it('preserves an uncertain broadcast outcome without sending or automatically aborting', async () => {
    const { pay, wallet, send } = setup()
    const original = wallet.createAction
    wallet.createAction = jest.fn(async args => {
      if (args.options?.sendWith !== undefined) throw new Error('ack lost')
      return original(args)
    })
    await expect(pay()).rejects.toMatchObject({
      code: 'ERR_PAYMENT_OUTCOME_UNKNOWN',
      payment: { state: 'uncertain' }
    })
    expect(send).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })
  it.each(['prepare', 'submit', 'retry'])(
    'cancels during %s without creating an extra spend',
    async phase => {
      const { pay, wallet, send } = setup()
      const controller = new AbortController()
      const original = wallet.createAction
      wallet.createAction = jest.fn(async args => {
        const result = await original(args)
        if (
          (phase === 'prepare' && args.options?.noSend) ||
          (phase === 'submit' && args.options?.sendWith)
        )
          controller.abort()
        return result
      })
      if (phase === 'retry')
        send.mockImplementationOnce(async () => {
          controller.abort()
          throw new Error('lost response')
        })
      await expect(pay({ signal: controller.signal })).rejects.toMatchObject({
        code: 'ERR_PAYMENT_CANCELLED',
        payment: { state: phase === 'prepare' ? 'prepared' : 'submitted' }
      })
      expect(wallet.createAction).toHaveBeenCalledTimes(phase === 'prepare' ? 1 : 2)
      expect(wallet.abortAction).toHaveBeenCalledTimes(phase === 'prepare' ? 1 : 0)
      expect(send).toHaveBeenCalledTimes(phase === 'retry' ? 1 : 0)
    }
  )
  it('changes an advertised transport without creating or submitting another payment', async () => {
    const { pay, send, internal, response, wallet } = setup()
    send.mockImplementationOnce(async (url, config) =>
      internal.handlePaymentAndRetry(url, config, response('multipart'))
    )
    await pay({ method: 'POST', body: new Uint8Array([0, 1, 2]) }, 'header,multipart')
    expect(send.mock.calls[0][1]!.headers!['x-bsv-payment']).toBeDefined()
    expect(send.mock.calls[1][1]!.headers!['content-type']).toMatch(/^multipart/)
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
  })
  it('retains payment context when multipart capability disappears after submission', async () => {
    const { pay, send, internal, response, wallet } = setup(12_000)
    send.mockImplementationOnce(async (url, config) =>
      internal.handlePaymentAndRetry(url, config, response('header'))
    )
    await expect(pay({ method: 'POST' }, 'header,multipart')).rejects.toMatchObject({
      code: 'ERR_PAYMENT_TRANSPORT',
      payment: { state: 'submitted' }
    })
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })
  it('releases an identifiable reservation after a malformed wallet result', async () => {
    const { pay, wallet, send } = setup()
    const original = wallet.createAction
    wallet.createAction = jest.fn(async args => ({ ...(await original(args)), tx: [-1] }))
    await expect(pay()).rejects.toMatchObject({
      code: 'ERR_PAYMENT_TRANSPORT',
      payment: { state: 'prepared', aborted: true }
    })
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })
})
