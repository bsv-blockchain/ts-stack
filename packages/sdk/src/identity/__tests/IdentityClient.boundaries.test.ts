import type { WalletInterface } from '../../wallet/Wallet.interfaces'
import { IdentityClient } from '../IdentityClient'

function displayCertificate(overrides: Record<string, unknown> = {}): any {
  return {
    type: 'custom-certificate',
    subject: 'subject-key',
    decryptedFields: { name: 'Alice' },
    certifierInfo: {},
    ...overrides
  }
}

function testWallet(): WalletInterface {
  return {
    discoverByIdentityKey: jest.fn().mockResolvedValue({ certificates: [] }),
    discoverByAttributes: jest.fn().mockResolvedValue({ certificates: [] }),
    listOutputs: jest.fn().mockResolvedValue({ outputs: [], BEEF: [] })
  } as unknown as WalletInterface
}

describe('IdentityClient untrusted-input boundaries', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() }
    })
  })

  it.each([null, [], Object.create({ inherited: true }), new Date()])(
    'rejects non-plain identity records without invoking their behavior',
    value => {
      expect(() => IdentityClient.parseIdentity(value as any)).toThrow('must be a plain object')
    }
  )

  it('rejects symbol, prototype-pollution, and accessor fields', () => {
    const symbolRecord = displayCertificate()
    Object.defineProperty(symbolRecord.decryptedFields, Symbol('hidden'), {
      enumerable: true,
      value: 'hidden'
    })
    expect(() => IdentityClient.parseIdentity(symbolRecord)).toThrow('unsafe field')

    const unsafeRecord = displayCertificate()
    Object.defineProperty(unsafeRecord.decryptedFields, '__proto__', {
      enumerable: true,
      value: 'pollute'
    })
    expect(() => IdentityClient.parseIdentity(unsafeRecord)).toThrow('unsafe field')

    let getterCalls = 0
    const accessorRecord = displayCertificate()
    Object.defineProperty(accessorRecord.certifierInfo, 'name', {
      enumerable: true,
      get: () => {
        getterCalls++
        return 'attacker'
      }
    })
    expect(() => IdentityClient.parseIdentity(accessorRecord)).toThrow('data property')
    expect(getterCalls).toBe(0)
  })

  it.each(['Alice\u0000Admin', 'Alice\u000bAdmin', 'Alice\u007fAdmin', 'Alice\u202eAdmin'])(
    'rejects unsafe display controls in user-controlled text',
    name => {
      expect(() =>
        IdentityClient.parseIdentity(displayCertificate({ decryptedFields: { name } }))
      ).toThrow('unsafe controls')
    }
  )

  it('applies UTF-8 byte bounds and rejects dangerous resource URLs', () => {
    expect(() =>
      IdentityClient.parseIdentity(
        displayCertificate({ decryptedFields: { name: 'é'.repeat(2049) } })
      )
    ).toThrow('oversized')
    expect(() =>
      IdentityClient.parseIdentity(
        displayCertificate({ decryptedFields: { name: 'Alice', profilePhoto: 'https://[' } })
      )
    ).toThrow('valid resource URL')
    expect(() =>
      IdentityClient.parseIdentity(
        displayCertificate({
          decryptedFields: { name: 'Alice', profilePhoto: 'https://user:secret@example.com/a' }
        })
      )
    ).toThrow('must not contain credentials')
  })

  it('caps identity result and display-field cardinality before parsing', async () => {
    await expect(IdentityClient.parseIdentities({} as any)).rejects.toThrow(
      'expected at most 10000 certificates'
    )
    await expect(
      IdentityClient.parseIdentities(Array.from({ length: 10001 }, () => displayCertificate()))
    ).rejects.toThrow('expected at most 10000 certificates')
    await expect(IdentityClient.parseIdentitiesWithOverrides({} as any, new Map())).rejects.toThrow(
      'expected at most 10000 certificates'
    )

    const decryptedFields = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`field${index}`, 'value'])
    )
    expect(() => IdentityClient.parseIdentity(displayCertificate({ decryptedFields }))).toThrow(
      'decryptedFields has too many fields'
    )
  })

  it.each([
    [{ unexpected: true }, 'unexpected field'],
    [{ useContacts: 'yes' }, 'useContacts must be a boolean'],
    [{ overrideWithContacts: 1 }, 'overrideWithContacts must be a boolean'],
    [{ parallel: 'yes' }, 'parallel must be a boolean'],
    [Object.create({ useContacts: true }), 'must be a plain object']
  ])('rejects malformed contact-resolution options %#', async (options, message) => {
    const wallet = testWallet()
    const client = new IdentityClient(wallet)

    await expect(
      client.resolveByIdentityKey({ identityKey: 'key' }, options as any)
    ).rejects.toThrow(message as string)
    expect(wallet.discoverByIdentityKey).not.toHaveBeenCalled()
  })

  it('rejects unsafe option properties without invoking accessors', async () => {
    const wallet = testWallet()
    const client = new IdentityClient(wallet)
    let getterCalls = 0
    const options: Record<string, unknown> = {}
    Object.defineProperty(options, 'parallel', {
      enumerable: true,
      get: () => {
        getterCalls++
        return true
      }
    })

    await expect(
      client.resolveByIdentityKey({ identityKey: 'key' }, options as any)
    ).rejects.toThrow('data property')
    expect(getterCalls).toBe(0)
  })

  it('bounds and validates public revelation field selections before wallet work', async () => {
    const wallet = testWallet()
    const client = new IdentityClient(wallet)
    const certificate = { fields: { name: 'encrypted' } } as any
    const sparse: string[] = []
    sparse.length = 2
    sparse[1] = 'name'

    await expect(
      client.publiclyRevealAttributes(certificate, Array.from({ length: 101 }, () => 'name') as any)
    ).rejects.toThrow('at most 100 fields')
    await expect(client.publiclyRevealAttributes(certificate, sparse as any)).rejects.toThrow(
      'dense array'
    )
    await expect(client.publiclyRevealAttributes(certificate, [''] as any)).rejects.toThrow(
      'invalid certificate field name'
    )
    await expect(
      client.publiclyRevealAttributes(certificate, ['__proto__'] as any)
    ).rejects.toThrow('invalid certificate field name')
  })

  it('does not match hostile attribute bags and falls through to authenticated discovery', async () => {
    const wallet = testWallet()
    const client = new IdentityClient(wallet)
    const attributes: Record<string, unknown> = { name: 'Alice' }
    Object.defineProperty(attributes, 'hidden', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute')
      }
    })

    await expect(
      client.resolveByAttributes({ attributes } as any, { useContacts: true })
    ).resolves.toEqual([])
    expect(wallet.discoverByAttributes).toHaveBeenCalledTimes(1)
  })
})
