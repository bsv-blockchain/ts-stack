import { PrivateKey, type WalletInterface } from '@bsv/sdk'
import { jest } from '@jest/globals'
import { MessageBoxClient } from '../MessageBoxClient.js'
import type { PeerMessage } from '../types.js'

// Issue #503, finding 2: the list APIs must keep a payment the wallet did not
// store, and say what happened to it, so a caller does not acknowledge (and
// so delete) the only copy of the payment's derivation data.

const sender = PrivateKey.fromRandom().toPublicKey().toString()

const walletPayment = {
  tx: [1, 2, 3, 4],
  outputs: [
    {
      outputIndex: 0,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix: 'cHJlZml4',
        derivationSuffix: 'c3VmZml4',
        senderIdentityKey: sender
      }
    }
  ],
  description: 'Message Box recipient payment'
}

const basketOnlyPayment = {
  tx: [1, 2, 3, 4],
  outputs: [
    { outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'tokens' } }
  ],
  description: 'Message Box recipient payment'
}

function stored(messageId: string, payment?: unknown): PeerMessage {
  const body = payment === undefined ? { message: 'hello' } : { message: 'hello', payment }
  return {
    messageId,
    body: JSON.stringify(body),
    sender,
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z'
  }
}

function createWallet(): jest.Mocked<WalletInterface> {
  return {
    internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
  } as unknown as jest.Mocked<WalletInterface>
}

function clientReturning(wallet: WalletInterface, messages: PeerMessage[]): MessageBoxClient {
  const client = new MessageBoxClient({ walletClient: wallet, host: 'https://messagebox.example' })
  ;(client as any).resolveMessageHosts = jest.fn(async () => ['https://messagebox.example'])
  ;(client as any).fetchMessagePages = jest.fn(async () => messages)
  return client
}

describe('listMessages payment outcome (#503)', () => {
  it('reports an internalized payment and does not return it again', async () => {
    const wallet = createWallet()
    const [message] = await clientReturning(wallet, [stored('m1', walletPayment)]).listMessages({
      messageBox: 'inbox'
    })

    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(message.body).toBe('hello')
    expect(message.paymentOutcome).toBe('internalized')
    expect(message.payment).toBeUndefined()
  })

  it('keeps the payment when internalization throws', async () => {
    const wallet = createWallet()
    wallet.internalizeAction.mockRejectedValueOnce(new Error('wallet unavailable'))

    const [message] = await clientReturning(wallet, [stored('m1', walletPayment)]).listMessages({
      messageBox: 'inbox'
    })

    expect(message.body).toBe('hello')
    expect(message.paymentOutcome).toBe('failed')
    expect(message.payment).toEqual(walletPayment)
  })

  it('keeps the payment when the wallet does not accept it', async () => {
    const wallet = createWallet()
    wallet.internalizeAction.mockResolvedValueOnce({ accepted: false } as any)

    const [message] = await clientReturning(wallet, [stored('m1', walletPayment)]).listMessages({
      messageBox: 'inbox'
    })

    expect(message.paymentOutcome).toBe('failed')
    expect(message.payment).toEqual(walletPayment)
  })

  it('keeps the payment when acceptPayments is false', async () => {
    const wallet = createWallet()

    const [message] = await clientReturning(wallet, [stored('m1', walletPayment)]).listMessages({
      messageBox: 'inbox',
      acceptPayments: false
    })

    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(message.paymentOutcome).toBe('skipped')
    expect(message.payment).toEqual(walletPayment)
  })

  it('keeps a payment that has no wallet-payment outputs to internalize', async () => {
    const wallet = createWallet()

    const [message] = await clientReturning(wallet, [stored('m1', basketOnlyPayment)]).listMessages(
      {
        messageBox: 'inbox'
      }
    )

    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(message.paymentOutcome).toBe('no-wallet-outputs')
    expect(message.payment).toEqual(basketOnlyPayment)
  })

  it('reports a payment missing its transaction or outputs as failed and keeps listing', async () => {
    const wallet = createWallet()
    const { tx: _tx, ...noTx } = walletPayment
    const { outputs: _outputs, ...noOutputs } = walletPayment

    const messages = await clientReturning(wallet, [
      stored('m1', noTx),
      stored('m2', noOutputs),
      stored('m3', walletPayment)
    ]).listMessages({ messageBox: 'inbox' })

    expect(messages.map(m => [m.messageId, m.body, m.paymentOutcome])).toEqual([
      ['m1', 'hello', 'failed'],
      ['m2', 'hello', 'failed'],
      ['m3', 'hello', 'internalized']
    ])
    expect(messages[0].payment).toEqual(noTx)
    expect(messages[1].payment).toEqual(noOutputs)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('leaves messages without a payment unchanged', async () => {
    const wallet = createWallet()

    const [message] = await clientReturning(wallet, [stored('m1')]).listMessages({
      messageBox: 'inbox'
    })

    expect(message.body).toBe('hello')
    expect(message).not.toHaveProperty('paymentOutcome')
    expect(message).not.toHaveProperty('payment')
  })
})

describe('listMessagesLite payment outcome (#503)', () => {
  it('never internalizes, so it keeps the payment and reports it as skipped', async () => {
    const wallet = createWallet()

    const [withPayment, withoutPayment] = await clientReturning(wallet, [
      stored('m1', walletPayment),
      stored('m2')
    ]).listMessagesLite({ messageBox: 'inbox' })

    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(withPayment.body).toBe('hello')
    expect(withPayment.paymentOutcome).toBe('skipped')
    expect(withPayment.payment).toEqual(walletPayment)
    expect(withoutPayment).not.toHaveProperty('paymentOutcome')
    expect(withoutPayment).not.toHaveProperty('payment')
  })

  it('still decodes the body when the payment is not a record', async () => {
    const wallet = createWallet()

    const [message] = await clientReturning(wallet, [
      stored('m1', 'not a payment')
    ]).listMessagesLite({
      messageBox: 'inbox'
    })

    expect(message.body).toBe('hello')
    expect(message).not.toHaveProperty('paymentOutcome')
    expect(message).not.toHaveProperty('payment')
  })
})
