/* eslint-env jest */
import { PeerTokenClient, STANDARD_TOKEN_MESSAGEBOX } from '../PeerTokenClient.js'
import { TokenSettlementAdapter } from '../TokenSettlementAdapter.js'
import { PrivateKey, type WalletInterface } from '@bsv/sdk'
import { jest } from '@jest/globals'

const createMockWalletClient = (): jest.Mocked<WalletInterface> => ({
  getPublicKey: jest.fn(),
  createAction: jest.fn(),
  internalizeAction: jest.fn(),
  createHmac: jest.fn<() => Promise<{ hmac: number[] }>>().mockResolvedValue({ hmac: [1, 2, 3] }),
  verifyHmac: jest.fn<() => Promise<{ valid: true }>>().mockResolvedValue({ valid: true as const })
} as unknown as jest.Mocked<WalletInterface>)

const ARTIFACT = {
  customInstructions: { derivationPrefix: 'cHJl', derivationSuffix: 'c3Vm' },
  transaction: [1, 2, 3],
  protocol: 'stas',
  assetId: 'TEST',
  amount: '1000',
  outputIndex: 0
}

const makeStubAdapter = (): TokenSettlementAdapter => ({
  protocol: 'stas',
  buildTokenSettlement: jest.fn<TokenSettlementAdapter['buildTokenSettlement']>()
    .mockResolvedValue({ action: 'settle', artifact: ARTIFACT }),
  acceptTokenSettlement: jest.fn<TokenSettlementAdapter['acceptTokenSettlement']>()
    .mockResolvedValue({ action: 'accept', receiptData: { internalizeResult: 'ok' } })
})

const SOURCE = {
  txid: 'aa'.repeat(32),
  outputIndex: 0,
  lockingScriptHex: '76a914' + 'ab'.repeat(20) + '88ac69ac',
  satoshis: 1000,
  protocol: 'stas',
  assetId: 'TEST',
  brc42KeyId: 'recv 1'
}

describe('PeerTokenClient Unit Tests', () => {
  let client: PeerTokenClient
  let adapter: TokenSettlementAdapter
  let recipient: string

  beforeEach(() => {
    jest.clearAllMocks()
    adapter = makeStubAdapter()
    recipient = PrivateKey.fromRandom().toPublicKey().toString()
    client = new PeerTokenClient({ walletClient: createMockWalletClient(), adapters: [adapter] })
  })

  describe('createTokenToken', () => {
    it('delegates to the adapter and returns the artifact fields', async () => {
      const token = await client.createTokenToken({ recipient, protocol: 'stas', source: SOURCE, amount: '1000' })
      expect(token).toMatchObject({ protocol: 'stas', assetId: 'TEST', amount: '1000', outputIndex: 0 })
      expect(token.transaction).toEqual([1, 2, 3])
      expect(adapter.buildTokenSettlement).toHaveBeenCalledTimes(1)
    })

    it('throws when no adapter is registered for the protocol', async () => {
      await expect(
        client.createTokenToken({ recipient, protocol: 'dstas', source: SOURCE, amount: '1' })
      ).rejects.toThrow(/No token settlement adapter/)
    })

    it('throws when the adapter terminates', async () => {
      ;(adapter.buildTokenSettlement as jest.Mock).mockResolvedValue({
        action: 'terminate', termination: { code: 'stas.frozen', message: 'frozen UTXO' }
      } as never)
      await expect(
        client.createTokenToken({ recipient, protocol: 'stas', source: SOURCE, amount: '1000' })
      ).rejects.toThrow(/frozen UTXO/)
    })
  })

  describe('sendToken', () => {
    it('sends the serialized token to the token message box', async () => {
      const sendSpy = jest.spyOn(client, 'sendMessage' as any).mockResolvedValue(undefined as never)
      await client.sendToken({ recipient, protocol: 'stas', source: SOURCE, amount: '1000' })
      expect(sendSpy).toHaveBeenCalledTimes(1)
      const arg = (sendSpy.mock.calls[0] as any)[0]
      expect(arg.messageBox).toBe(STANDARD_TOKEN_MESSAGEBOX)
      expect(arg.recipient).toBe(recipient)
      expect(JSON.parse(arg.body)).toMatchObject({ protocol: 'stas', assetId: 'TEST', amount: '1000' })
    })

    it('throws on a missing recipient', async () => {
      await expect(
        client.sendToken({ recipient: '  ', protocol: 'stas', source: SOURCE, amount: '1000' })
      ).rejects.toThrow(/recipient is required/)
    })
  })

  describe('acceptToken', () => {
    it('delegates to the adapter and acknowledges the message', async () => {
      const ackSpy = jest.spyOn(client, 'acknowledgeMessage' as any).mockResolvedValue(undefined as never)
      const incoming = {
        messageId: 'msg-1',
        sender: PrivateKey.fromRandom().toPublicKey().toString(),
        token: { ...ARTIFACT }
      }
      const result = await client.acceptToken(incoming)
      expect(adapter.acceptTokenSettlement).toHaveBeenCalledTimes(1)
      expect(ackSpy).toHaveBeenCalledWith({ messageIds: ['msg-1'] })
      expect(result).toMatchObject({ receiptData: { internalizeResult: 'ok' } })
    })
  })
})
