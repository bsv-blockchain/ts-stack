import { WalletCore } from '../../core/WalletCore'
import { createInscriptionMethods } from '../inscriptions'

const HASH = 'ab'.repeat(32)

function createCore(): { core: WalletCore; send: jest.Mock } {
  const send = jest.fn().mockResolvedValue({
    txid: 'transaction-id',
    tx: [1, 2, 3],
    outputDetails: [{ index: 0, satoshis: 0 }]
  })
  const core = {
    defaults: { description: 'Default transaction description' },
    send
  } as unknown as WalletCore

  return { core, send }
}

describe('createInscriptionMethods', () => {
  it.each([
    ['inscribeFileHash', 'file-hash', 'hash-document', 'File hash inscription'],
    ['inscribeImageHash', 'image-hash', 'hash-image', 'Image hash inscription']
  ] as const)(
    '%s validates and inscribes a SHA-256 hash',
    async (method, type, basket, description) => {
      const { core, send } = createCore()
      const inscriptions = createInscriptionMethods(core)

      await expect(inscriptions[method](HASH)).resolves.toEqual({
        txid: 'transaction-id',
        tx: [1, 2, 3],
        type,
        dataSize: 64,
        basket,
        outputs: [{ index: 0, satoshis: 0, lockingScript: '' }]
      })
      expect(send).toHaveBeenCalledWith({
        outputs: [{ data: [HASH], basket, description }],
        description: 'Default transaction description'
      })
    }
  )

  it.each(['inscribeFileHash', 'inscribeImageHash'] as const)(
    '%s rejects malformed hashes before sending',
    async method => {
      const { core, send } = createCore()
      const inscriptions = createInscriptionMethods(core)

      await expect(inscriptions[method]('not-a-sha256-hash')).rejects.toThrow(
        'Invalid SHA-256 hash format'
      )
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('preserves custom hash options in both output and transaction descriptions', async () => {
    const { core, send } = createCore()
    const inscriptions = createInscriptionMethods(core)

    await expect(
      inscriptions.inscribeFileHash(HASH.toUpperCase(), {
        basket: 'documents',
        description: 'Document digest'
      })
    ).resolves.toMatchObject({
      type: 'file-hash',
      basket: 'documents'
    })
    expect(send).toHaveBeenCalledWith({
      outputs: [
        {
          data: [HASH.toUpperCase()],
          basket: 'documents',
          description: 'Document digest'
        }
      ],
      description: 'Document digest'
    })
  })
})
