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
  it('inscribes text and maps output details', async () => {
    const { core, send } = createCore()
    const inscriptions = createInscriptionMethods(core)

    await expect(inscriptions.inscribeText('hello')).resolves.toMatchObject({
      type: 'text',
      dataSize: 5,
      basket: 'text',
      outputs: [{ index: 0, satoshis: 0, lockingScript: '' }]
    })
    expect(send).toHaveBeenCalledWith({
      outputs: [{ data: ['hello'], basket: 'text', description: 'Text inscription' }],
      description: 'Default transaction description'
    })
  })

  it('reports UTF-8 byte length rather than JavaScript code-unit length', async () => {
    const { core } = createCore()
    const inscriptions = createInscriptionMethods(core)

    await expect(inscriptions.inscribeText('☕')).resolves.toMatchObject({ dataSize: 3 })
    await expect(inscriptions.inscribeJSON({ value: '☕' })).resolves.toMatchObject({
      dataSize: 15
    })
  })

  it('serializes JSON before sending and measuring it', async () => {
    const { core, send } = createCore()
    const inscriptions = createInscriptionMethods(core)

    await expect(inscriptions.inscribeJSON({ answer: 42 })).resolves.toMatchObject({
      type: 'json',
      dataSize: 13,
      basket: 'json',
      outputs: [{ index: 0, satoshis: 0, lockingScript: '' }]
    })
    expect(send).toHaveBeenCalledWith({
      outputs: [{ data: ['{"answer":42}'], basket: 'json', description: 'JSON inscription' }],
      description: 'Default transaction description'
    })
  })

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

  it('ignores inherited basket and description options', async () => {
    const { core, send } = createCore()
    const inscriptions = createInscriptionMethods(core)
    const previousBasket = Object.getOwnPropertyDescriptor(Object.prototype, 'basket')
    const previousDescription = Object.getOwnPropertyDescriptor(Object.prototype, 'description')
    try {
      Object.defineProperty(Object.prototype, 'basket', {
        value: 'ambient-basket',
        configurable: true,
        enumerable: false,
        writable: true
      })
      Object.defineProperty(Object.prototype, 'description', {
        value: 'Ambient description',
        configurable: true,
        enumerable: false,
        writable: true
      })

      await expect(inscriptions.inscribeText('hello', {})).resolves.toMatchObject({
        basket: 'text'
      })
    } finally {
      if (previousBasket == null) Reflect.deleteProperty(Object.prototype, 'basket')
      else Object.defineProperty(Object.prototype, 'basket', previousBasket)
      if (previousDescription == null) Reflect.deleteProperty(Object.prototype, 'description')
      else Object.defineProperty(Object.prototype, 'description', previousDescription)
    }

    expect(send).toHaveBeenCalledWith({
      outputs: [{ data: ['hello'], basket: 'text', description: 'Text inscription' }],
      description: 'Default transaction description'
    })
  })

  it('rejects inscription option accessors without invoking them', async () => {
    const { core, send } = createCore()
    const inscriptions = createInscriptionMethods(core)
    const getter = jest.fn(() => 'ambient-basket')
    const options: Record<string, unknown> = {}
    Object.defineProperty(options, 'basket', { enumerable: true, get: getter })

    await expect(inscriptions.inscribeText('hello', options)).rejects.toThrow(
      'own data properties only'
    )
    expect(getter).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects unserializable or excessive data before sending', async () => {
    const { core, send } = createCore()
    const inscriptions = createInscriptionMethods(core)
    const cyclic: any = {}
    cyclic.self = cyclic

    await expect(
      inscriptions.inscribeJSON({ toJSON: () => undefined } as unknown as object)
    ).rejects.toThrow('JSON serializable')
    await expect(inscriptions.inscribeJSON(cyclic)).rejects.toThrow('JSON serializable')
    await expect(inscriptions.inscribeText('x'.repeat(1024 * 1024 + 1))).rejects.toThrow(
      '1 MiB safety limit'
    )
    expect(send).not.toHaveBeenCalled()
  })
})
