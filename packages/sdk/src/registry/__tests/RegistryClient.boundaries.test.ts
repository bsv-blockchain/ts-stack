import PrivateKey from '../../primitives/PrivateKey'
import type { WalletInterface } from '../../wallet/Wallet.interfaces'
import { RegistryClient } from '../RegistryClient'

const IDENTITY_KEY = new PrivateKey(31).toPublicKey().toString()

function wallet(): WalletInterface {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: IDENTITY_KEY }),
    getNetwork: jest.fn().mockResolvedValue({ network: 'testnet' })
  } as unknown as WalletInterface
}

function client(testWallet = wallet()): RegistryClient {
  return new RegistryClient(testWallet, {
    resolver: { query: jest.fn().mockResolvedValue({ type: 'output-list', outputs: [] }) } as any
  })
}

function basket(overrides: Record<string, unknown> = {}): any {
  return {
    definitionType: 'basket',
    basketID: 'payments',
    name: 'Payments',
    iconURL: 'https://example.com/icon.png',
    description: 'Payment outputs',
    documentationURL: 'https://example.com/docs',
    ...overrides
  }
}

function certificate(overrides: Record<string, unknown> = {}): any {
  return {
    definitionType: 'certificate',
    type: 'identity',
    name: 'Identity',
    iconURL: '',
    description: 'Identity fields',
    documentationURL: '',
    fields: {
      name: {
        friendlyName: 'Name',
        description: 'Display name',
        type: 'text',
        fieldIcon: ''
      }
    },
    ...overrides
  }
}

describe('RegistryClient untrusted-input boundaries', () => {
  it.each([null, [], Object.create({ inherited: true }), new Date()])(
    'rejects non-plain definitions before wallet access',
    async definition => {
      const testWallet = wallet()
      await expect(client(testWallet).registerDefinition(definition as any)).rejects.toThrow(
        'plain object'
      )
      expect(testWallet.getPublicKey).not.toHaveBeenCalled()
    }
  )

  it('rejects unsafe and accessor definition properties without executing them', async () => {
    const symbolDefinition = basket()
    Object.defineProperty(symbolDefinition, Symbol('hidden'), { enumerable: true, value: true })
    await expect(client().registerDefinition(symbolDefinition)).rejects.toThrow('unsafe property')

    const polluted = basket()
    Object.defineProperty(polluted, '__proto__', { enumerable: true, value: 'pollute' })
    await expect(client().registerDefinition(polluted)).rejects.toThrow('unsafe property')

    let getterCalls = 0
    const accessor = basket()
    Object.defineProperty(accessor, 'name', {
      enumerable: true,
      get: () => {
        getterCalls++
        return 'attacker'
      }
    })
    await expect(client().registerDefinition(accessor)).rejects.toThrow('unsafe property')
    expect(getterCalls).toBe(0)
  })

  it.each([
    [basket({ name: 3 }), 'must be a string'],
    [basket({ name: 'Payments\u0000Admin' }), 'control characters'],
    [basket({ name: 'é'.repeat(151) }), 'invalid length'],
    [basket({ iconURL: 'https://[' }), 'absolute HTTP(S) URL'],
    [basket({ iconURL: 'javascript:alert(1)' }), 'credential-free HTTP(S)'],
    [basket({ iconURL: 'https://user:secret@example.com/icon' }), 'credential-free HTTP(S)'],
    [basket({ documentationURL: 'https://example.com/docs#private' }), 'credential-free HTTP(S)']
  ])('rejects malformed definition text or URLs %#', async (definition, message) => {
    await expect(client().registerDefinition(definition as any)).rejects.toThrow(message as string)
  })

  it.each([
    [{ ...basket(), definitionType: 'unknown' }, 'Unsupported definition type'],
    [
      { ...basket(), definitionType: 'protocol', protocolID: 'not-an-array' },
      'must contain a security level'
    ],
    [
      { ...basket(), definitionType: 'protocol', protocolID: [3, 'valid protocol'] },
      'security level is invalid'
    ],
    [{ ...basket(), definitionType: 'protocol', protocolID: [1, 'tiny'] }, 'invalid length']
  ])(
    'rejects invalid definition discriminants and protocol IDs %#',
    async (definition, message) => {
      await expect(client().registerDefinition(definition as any)).rejects.toThrow(
        message as string
      )
    }
  )

  it('bounds and validates certificate field descriptors', async () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `field${index}`,
        { friendlyName: 'Field', description: '', type: 'text', fieldIcon: '' }
      ])
    )
    await expect(client().registerDefinition(certificate({ fields: tooMany }))).rejects.toThrow(
      'too many entries'
    )
    await expect(
      client().registerDefinition(
        certificate({
          fields: {
            name: {
              friendlyName: 'Name',
              description: '',
              type: 'text',
              fieldIcon: '',
              executable: true
            }
          }
        })
      )
    ).rejects.toThrow('unknown property')
    await expect(
      client().registerDefinition(
        certificate({
          fields: {
            name: { friendlyName: 'Name', description: '', type: 'html', fieldIcon: '' }
          }
        })
      )
    ).rejects.toThrow('unsupported type')
    await expect(
      client().registerDefinition(
        certificate({
          fields: {
            name: { friendlyName: 2, description: '', type: 'text', fieldIcon: '' }
          }
        })
      )
    ).rejects.toThrow('must be a string')
  })

  it.each([
    ['basket', { unknown: true }, 'unknown property'],
    ['basket', { name: '' }, 'invalid length'],
    ['protocol', { protocolID: 'not-an-array' }, 'protocol ID is invalid'],
    ['protocol', { protocolID: [9, 'valid protocol'] }, 'Invalid security level'],
    ['certificate', { type: '' }, 'invalid length'],
    [
      'basket',
      { registryOperators: Array.from({ length: 101 }, () => IDENTITY_KEY) },
      'bounded array'
    ],
    ['basket', { registryOperators: ['not-a-public-key'] }, 'invalid length']
  ])('rejects hostile registry queries %#', async (definitionType, query, message) => {
    await expect(client().resolve(definitionType as any, query as any)).rejects.toThrow(
      message as string
    )
  })

  it('rejects query accessors without invoking them', async () => {
    let getterCalls = 0
    const query: Record<string, unknown> = {}
    Object.defineProperty(query, 'name', {
      enumerable: true,
      get: () => {
        getterCalls++
        return 'attacker'
      }
    })

    await expect(client().resolve('basket', query as any)).rejects.toThrow('unsafe property')
    expect(getterCalls).toBe(0)
  })

  it.each([
    [null, 'plain object'],
    [{ definitionType: 'unknown' }, 'invalid definition type'],
    [{ definitionType: 'basket', txid: 'bad' }, 'invalid transaction ID'],
    [{ definitionType: 'basket', txid: '00'.repeat(32), outputIndex: -1 }, 'invalid output index'],
    [
      { definitionType: 'basket', txid: '00'.repeat(32), outputIndex: 0, beef: [] },
      'empty or oversized'
    ],
    [
      { definitionType: 'basket', txid: '00'.repeat(32), outputIndex: 0, beef: [256] },
      'only bytes'
    ],
    [
      {
        definitionType: 'basket',
        txid: '00'.repeat(32),
        outputIndex: 0,
        beef: new Uint8Array()
      },
      'empty or oversized'
    ]
  ])('rejects unauthenticated source-record metadata %#', async (record, message) => {
    await expect(client().removeDefinition(record as any)).rejects.toThrow(message as string)
  })

  it('rejects sparse BEEF arrays before transaction parsing', async () => {
    const beef: number[] = []
    beef.length = 2
    beef[1] = 1
    await expect(
      client().removeDefinition({
        definitionType: 'basket',
        txid: '00'.repeat(32),
        outputIndex: 0,
        beef
      } as any)
    ).rejects.toThrow('only bytes')
  })
})
