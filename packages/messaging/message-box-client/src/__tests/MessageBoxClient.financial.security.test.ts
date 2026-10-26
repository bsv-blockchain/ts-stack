import { LockingScript, PrivateKey, Transaction, type WalletInterface } from '@bsv/sdk'
import { jest } from '@jest/globals'
import { MessageBoxClient } from '../MessageBoxClient.js'

const sender = PrivateKey.fromRandom().toPublicKey().toString()
const recipientA = PrivateKey.fromRandom().toPublicKey().toString()
const recipientB = PrivateKey.fromRandom().toPublicKey().toString()
const server = PrivateKey.fromRandom().toPublicKey().toString()

function actionResult(args: Parameters<WalletInterface['createAction']>[0], reverse = false) {
  const outputs = (args.outputs ?? []).map(output => ({
    satoshis: output.satoshis,
    lockingScript: LockingScript.fromHex(output.lockingScript)
  }))
  if (reverse) outputs.reverse()
  const transaction = new Transaction(1, [], outputs, 0)
  return { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF() }
}

function createWallet(): jest.Mocked<WalletInterface> {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: sender }),
    createHmac: jest.fn().mockResolvedValue({ hmac: Array<number>(32).fill(0xab) }),
    encrypt: jest.fn().mockResolvedValue({ ciphertext: [1, 2, 3] }),
    createAction: jest.fn(async args => actionResult(args)),
    internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
  } as unknown as jest.Mocked<WalletInterface>
}

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    bodyUsed: false,
    headers: new Headers({ 'x-bsv-auth-identity-key': server }),
    json: async () => body,
    ...init
  } as Response
}

function clientWithWallet(wallet = createWallet()) {
  const client = new MessageBoxClient({
    host: 'https://message-box.example/api',
    walletClient: wallet
  })
  return { client, wallet, fetch: jest.spyOn(client.authFetch, 'fetch') }
}

describe('MessageBoxClient financial and send authority', () => {
  afterEach(() => jest.restoreAllMocks())

  it('snapshots the exact outgoing request before the first asynchronous boundary', async () => {
    const { client, wallet, fetch } = clientWithWallet()
    let releaseHmac!: (value: { hmac: number[] }) => void
    wallet.createHmac.mockReturnValueOnce(
      new Promise(resolve => {
        releaseHmac = resolve
      })
    )
    fetch.mockResolvedValue(
      jsonResponse({
        status: 'success',
        results: [{ recipient: recipientA, messageId: '11'.repeat(32) }]
      })
    )
    const body = { amount: 7 }
    const params = {
      recipient: recipientA,
      messageBox: 'payments',
      body,
      skipEncryption: true
    }

    const pending = client.sendMessage(params, 'https://message-box.example/api')
    params.recipient = recipientB
    params.messageBox = 'changed'
    body.amount = 999
    releaseHmac({ hmac: Array<number>(32).fill(0x11) })

    await expect(pending).resolves.toEqual({ status: 'success', messageId: '11'.repeat(32) })
    const request = JSON.parse(String(fetch.mock.calls[0][1]?.body))
    expect(request.message).toEqual({
      recipient: recipientA,
      messageBox: 'payments',
      messageId: '11'.repeat(32),
      body: '{"amount":7}'
    })
    expect(wallet.createHmac).toHaveBeenCalledWith(
      expect.objectContaining({ counterparty: recipientA }),
      undefined
    )
  })

  it('rejects accessor-bearing request data before wallet or network work', async () => {
    const { client, wallet, fetch } = clientWithWallet()
    const params = {
      recipient: recipientA,
      messageBox: 'inbox',
      get body() {
        return 'secret'
      }
    }

    await expect(client.sendMessage(params, 'https://message-box.example/api')).rejects.toThrow(
      'own data properties'
    )
    expect(wallet.createHmac).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    const nested = Object.defineProperty({}, 'secret', { get: () => true })
    await expect(
      client.sendMessage(
        { recipient: recipientA, messageBox: 'inbox', body: nested },
        'https://message-box.example/api'
      )
    ).rejects.toThrow('own data properties')
  })

  it('requires exact HMAC bytes and exact server result correlation', async () => {
    const { client, wallet, fetch } = clientWithWallet()
    wallet.createHmac.mockResolvedValueOnce({ hmac: [1, 2, 3] })
    await expect(
      client.sendMessage(
        { recipient: recipientA, messageBox: 'inbox', body: 'hello', skipEncryption: true },
        'https://message-box.example/api'
      )
    ).rejects.toThrow('Failed to generate message identifier.')
    expect(fetch).not.toHaveBeenCalled()

    wallet.createHmac.mockResolvedValueOnce({ hmac: Array<number>(32).fill(0xab) })
    fetch.mockResolvedValueOnce(
      jsonResponse({
        status: 'success',
        results: [{ recipient: recipientB, messageId: 'ab'.repeat(32) }]
      })
    )
    await expect(
      client.sendMessage(
        { recipient: recipientA, messageBox: 'inbox', body: 'hello', skipEncryption: true },
        'https://message-box.example/api'
      )
    ).rejects.toThrow('does not match the submitted message')
  })

  it('uses a bounded caller messageId without an unnecessary HMAC operation', async () => {
    const { client, wallet, fetch } = clientWithWallet()
    fetch.mockResolvedValue(
      jsonResponse({
        status: 'success',
        results: [{ recipient: recipientA, messageId: 'caller-id' }]
      })
    )

    await expect(
      client.sendMessage(
        {
          recipient: recipientA,
          messageBox: 'inbox',
          body: 'hello',
          messageId: 'caller-id',
          skipEncryption: true
        },
        'https://message-box.example/api'
      )
    ).resolves.toEqual({ status: 'success', messageId: 'caller-id' })
    expect(wallet.createHmac).not.toHaveBeenCalled()
  })

  it.each([
    [{ deliveryFee: -1, recipientFee: 0 }, 'deliveryFee'],
    [{ deliveryFee: Number.NaN, recipientFee: 0 }, 'deliveryFee'],
    [{ deliveryFee: 0, recipientFee: -2 }, 'recipientFee'],
    [{ deliveryFee: 0, recipientFee: 2_147_483_648 }, 'recipientFee']
  ])('rejects unsafe single quote amounts %#', async (quote, field) => {
    const { client, fetch } = clientWithWallet()
    fetch.mockResolvedValue(jsonResponse({ status: 'success', quote }))

    await expect(
      client.getMessageBoxQuote(
        { recipient: recipientA, messageBox: 'inbox' },
        'https://message-box.example/api'
      )
    ).rejects.toThrow(field)
  })

  it('rejects mismatched, duplicate, and inconsistently blocked multi-quote rows', async () => {
    const cases = [
      [
        {
          recipient: recipientB,
          messageBox: 'other',
          deliveryFee: 1,
          recipientFee: 0,
          status: 'always_allow'
        },
        'messageBox'
      ],
      [
        {
          recipient: recipientB,
          messageBox: 'inbox',
          deliveryFee: 1,
          recipientFee: 2,
          status: 'always_allow'
        },
        'status'
      ]
    ] as const

    for (const [secondRow, error] of cases) {
      const { client, fetch } = clientWithWallet()
      fetch.mockResolvedValue(
        jsonResponse({
          status: 'success',
          quotesByRecipient: [
            {
              recipient: recipientA,
              messageBox: 'inbox',
              deliveryFee: 1,
              recipientFee: 0,
              status: 'always_allow'
            },
            secondRow
          ],
          blockedRecipients: []
        })
      )
      await expect(
        client.getMessageBoxQuote(
          { recipient: [recipientA, recipientB], messageBox: 'inbox' },
          'https://message-box.example/api'
        )
      ).rejects.toThrow(error)
      jest.restoreAllMocks()
    }

    const { client, fetch } = clientWithWallet()
    fetch.mockResolvedValue(
      jsonResponse({
        status: 'success',
        quotesByRecipient: [recipientA, recipientB].map(recipient => ({
          recipient,
          messageBox: 'inbox',
          deliveryFee: 1,
          recipientFee: 0,
          status: 'always_allow'
        })),
        blockedRecipients: [recipientA]
      })
    )
    await expect(
      client.getMessageBoxQuote(
        { recipient: [recipientA, recipientB], messageBox: 'inbox' },
        'https://message-box.example/api'
      )
    ).rejects.toThrow('blockedRecipients')
  })

  it('enforces maximumPayment before asking the wallet to create an action', async () => {
    const { client, wallet } = clientWithWallet()
    jest.spyOn(client, 'getMessageBoxQuote').mockResolvedValue({
      deliveryFee: 3,
      recipientFee: 5,
      deliveryAgentIdentityKey: server
    })

    await expect(
      client.sendMessage(
        {
          recipient: recipientA,
          messageBox: 'inbox',
          body: 'hello',
          skipEncryption: true,
          checkPermissions: true,
          maximumPayment: 7
        },
        'https://message-box.example/api'
      )
    ).rejects.toThrow('exceeds maximumPayment')
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('counts the server delivery fee once per payable batch recipient', async () => {
    const { client, wallet } = clientWithWallet()
    jest.spyOn(client, 'getMessageBoxQuote').mockResolvedValue({
      quotesByRecipient: [recipientA, recipientB].map(recipient => ({
        recipient,
        messageBox: 'inbox',
        deliveryFee: 3,
        recipientFee: 0,
        status: 'always_allow' as const
      })),
      blockedRecipients: [],
      deliveryAgentIdentityKeyByHost: {
        'https://message-box.example/api': server
      },
      totals: { deliveryFees: 6, recipientFees: 0, totalForPayableRecipients: 6 }
    })

    await expect(
      client.sendMessageToRecipients(
        {
          recipients: [recipientA, recipientB],
          messageBox: 'inbox',
          body: 'hello',
          skipEncryption: true,
          maximumPayment: 5
        },
        'https://message-box.example/api'
      )
    ).rejects.toThrow('exceeds maximumPayment')
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('rejects a wallet transaction that reorders otherwise correct payment outputs', async () => {
    const { client, wallet } = clientWithWallet()
    wallet.createAction.mockImplementationOnce(async args => actionResult(args, true))

    await expect(
      (client as any).createMessagePayment(recipientA, {
        deliveryFee: 3,
        recipientFee: 5,
        deliveryAgentIdentityKey: server
      })
    ).rejects.toThrow('requested output at the requested position')
  })

  it('rejects a mocked multi-quote that substitutes a recipient before any payment', async () => {
    const { client, wallet } = clientWithWallet()
    jest.spyOn(client, 'getMessageBoxQuote').mockResolvedValue({
      quotesByRecipient: [
        {
          recipient: recipientB,
          messageBox: 'inbox',
          deliveryFee: 1,
          recipientFee: 1,
          status: 'payment_required'
        }
      ],
      blockedRecipients: [],
      deliveryAgentIdentityKeyByHost: {
        'https://message-box.example/api': server
      }
    })

    await expect(
      client.sendMessageToRecipients(
        {
          recipients: [recipientA],
          messageBox: 'inbox',
          body: 'hello',
          skipEncryption: true
        },
        'https://message-box.example/api'
      )
    ).rejects.toThrow('requested recipients')
    expect(wallet.createAction).not.toHaveBeenCalled()
  })
})
